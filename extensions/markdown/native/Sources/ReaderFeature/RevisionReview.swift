import Foundation
import MarkdownCore
import Observation
import SwiftUI
import WebKit

/// The comparison of two revisions that one reader window shows over its document. The
/// comparison has its own page: the document's page stays loaded below it with its position and
/// selection, so a comparison that prepares or fails never replaces the document.
@MainActor @Observable
public final class RevisionReview {
    /// What the reader asked a revision number for.
    public enum Entry: Equatable, Sendable {
        /// Show that revision of the document.
        case show
        /// Compare that revision with `target`.
        case compare(target: Int)
    }

    /// The comparison on screen.
    public private(set) var shown: ReviewSummary?
    /// The revisions of a comparison in preparation. A nil base is the nearest earlier revision.
    public private(set) var preparing: (base: Int?, target: Int)?
    /// Why the last comparison did not appear.
    public private(set) var failure: String?
    public private(set) var page: WebPage?
    /// Set while the reader enters a revision number.
    public var entry: Entry?

    @ObservationIgnored private let assets = AssetTable()
    @ObservationIgnored private let router = NavigationRouter()
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var html = ""
    @ObservationIgnored private var shownAssets: [String: ResolvedAsset] = [:]
    @ObservationIgnored private var monitor: Task<Void, Never>?
    @ObservationIgnored var expectingLoad = false
    /// Receives a web link that the reader activated on the comparison page.
    @ObservationIgnored var openExternal: ((URL) -> Void)?
    /// Suspends a prepared comparison before it is displayed.
    @ObservationIgnored package var preparationGate: (@MainActor () async -> Void)?

    public init() {}

    /// The comparison page while it is on screen: find and copy act on it.
    public var visiblePage: WebPage? { shown == nil ? nil : page }

    /// Prepares the comparison off the main thread and shows it. The last request wins. A
    /// failure leaves what was on screen: the document, or an earlier comparison.
    func start(_ reference: DocumentReference, base: Int?, target: Int, settings: PageSettings) async {
        generation += 1
        let token = generation
        preparing = (base, target)
        failure = nil
        let result = await Task.detached(priority: .userInitiated) { () -> Result<PreparedReview, any Error> in
            Result { try ReviewPage.prepare(reference, base: base, target: target, settings: settings) }
        }.value
        await preparationGate?()
        guard token == generation else { return }
        switch result {
        case .failure(let error):
            preparing = nil
            failure = "The comparison was not prepared. \(error)"
            readerLog.error("review \(reference.key, privacy: .public) target=\(target, privacy: .public) failed: \(String(describing: error), privacy: .public)")
        case .success(let prepared):
            assets.replace(prepared.assets)
            do {
                try await display(prepared.html)
            } catch {
                guard token == generation else { return }
                assets.replace(shownAssets)
                preparing = nil
                failure = "The comparison could not be shown: \(error.localizedDescription)"
                if shown == nil { discardPage() } else { try? await display(html) }
                return
            }
            guard token == generation else { return }
            html = prepared.html
            shownAssets = prepared.assets
            shown = prepared.summary
            preparing = nil
            readerLog.notice("review \(reference.key, privacy: .public) revisions=\(prepared.summary.base, privacy: .public)-\(prepared.summary.target, privacy: .public) regions=\(prepared.summary.changedRegions, privacy: .public) images=\(prepared.summary.assetChanges, privacy: .public) partial=\(prepared.summary.partial, privacy: .public)")
        }
    }

    /// Ends the comparison and releases its page. The document below is as the reader left it.
    public func close() {
        generation += 1
        shown = nil
        preparing = nil
        failure = nil
        entry = nil
        discardPage()
    }

    public func dismissFailure() {
        failure = nil
    }

    func selectedText() async -> String {
        guard let page = visiblePage else { return "" }
        return (try? await page.callJavaScript(PageScript.selectionText, contentWorld: PageScript.world) as? String) ?? ""
    }

    func apply(_ settings: PageSettings) async {
        guard let page else { return }
        let arguments: [String: Any] = ["textSize": settings.textSize, "wrap": settings.wrapCode]
        _ = try? await page.callJavaScript(PageScript.applySettings, arguments: arguments, contentWorld: PageScript.world)
    }

    private func display(_ html: String) async throws {
        let page = self.page ?? makePage()
        expectingLoad = true
        defer { expectingLoad = false }
        do {
            for try await _ in page.load(html: html, baseURL: URL(string: "about:blank")!) {}
        } catch WebPage.NavigationError.webContentProcessTerminated {
            for try await _ in page.load(html: html, baseURL: URL(string: "about:blank")!) {}
        }
    }

    private func makePage() -> WebPage {
        let page = ReaderPageFactory.make(router: router, assets: assets)
        router.handler = self
        self.page = page
        monitor = Task { @MainActor [weak self] in
            while let self, self.page === page {
                do {
                    for try await _ in page.navigations {}
                    return
                } catch {
                    guard case WebPage.NavigationError.webContentProcessTerminated = error, !self.expectingLoad, self.page === page, self.shown != nil else { continue }
                    // The page's web content process ended: show the same comparison again.
                    try? await self.display(self.html)
                }
            }
        }
        return page
    }

    private func discardPage() {
        monitor?.cancel()
        monitor = nil
        page = nil
        html = ""
        shownAssets = [:]
        assets.replace([:])
    }
}

extension RevisionReview: NavigationHandling {
    func handle(_ request: NavigationRequest) {
        if case .external(let url) = request { openExternal?(url) }
    }
}

extension ReaderModel {
    /// Whether the open document has retained revisions to compare.
    public var canReviewChanges: Bool {
        guard case .stored = reference, snapshot?.revision != nil else { return false }
        return (latestRevision ?? 1) > 1
    }

    /// Compares two retained revisions of the open document and shows the result over the
    /// document. Without arguments it compares the shown revision with the newer one that is
    /// available, else with the revision before it. A second call while a comparison is on
    /// screen and no revisions are named ends it.
    public func reviewChanges(base: Int? = nil, target: Int? = nil) async {
        guard let shown = snapshot?.revision, canReviewChanges else {
            post("This document has no earlier revision to compare with.", kind: .info)
            return
        }
        if base == nil, target == nil, review.shown != nil {
            await closeReview()
            return
        }
        var from = base
        var to = target ?? shown
        if base == nil, target == nil, let latest = latestRevision, latest > shown {
            from = shown
            to = latest
        }
        review.openExternal = { [weak self] url in self?.pendingExternalURL = url }
        await review.start(reference, base: from, target: to, settings: settings)
    }

    /// Ends the comparison. A revision that arrived while the comparison held the reader's
    /// attention is then followed or announced as usual.
    public func closeReview() async {
        review.close()
        await checkForUpdate()
    }

    /// Shows an exact revision by number. Any existing revision up to the newest one is
    /// reachable, including those older than the listed choices.
    public func goToRevision(_ revision: Int) async {
        guard let snapshot, snapshot.revision != nil else { return }
        guard revision >= 1, revision <= (latestRevision ?? revision) else {
            post("Revision \(revision) does not exist. The newest revision is \(latestRevision ?? 0).", kind: .warning)
            return
        }
        await showRevision(revision)
    }

    /// Steps to the nearest existing revision outside the listed choices.
    func showUnlistedAdjacentRevision(newer: Bool) async {
        guard case .stored(let root, _, let id) = reference, let current = snapshot?.revision, let pointer = latestRevision else { return }
        let found = await Task.detached { () -> Int? in
            guard let store = try? DirectoryStore(root: URL(fileURLWithPath: root)) else { return nil }
            return store.adjacentRevision(id, to: current, newer: newer, pointer: pointer)
        }.value
        guard let found else {
            post("No \(newer ? "newer" : "older") revision was found near revision \(current). Use Go to Revision to choose one.", kind: .info)
            return
        }
        await showRevision(found)
    }
}

/// The comparison layer of a reader: a line while a comparison prepares or after it failed, and
/// the comparison itself with its bar.
struct RevisionReviewLayer: View {
    @Bindable var model: ReaderModel

    var body: some View {
        let review = model.review
        VStack(spacing: 0) {
            // The number entry attaches here, so that it has an anchor while the layer is empty.
            Color.clear
                .frame(height: 1)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .popover(item: Binding(get: { review.entry.map(EntryRequest.init) }, set: { if $0 == nil { review.entry = nil } }), arrowEdge: .bottom) { request in
                    RevisionEntryView(model: model, entry: request.entry)
                }
            if let summary = review.shown {
                ReviewBar(model: model, summary: summary)
            }
            if let preparing = review.preparing {
                Banner(systemImage: "plusminus", tint: .blue) {
                    Text(preparing.base.map { "Comparing revisions \(min($0, preparing.target)) and \(max($0, preparing.target))…" } ?? "Comparing revision \(preparing.target) with the revision before it…")
                } action: {
                    ProgressView().controlSize(.small)
                }
                .background(.bar)
            }
            if let failure = review.failure {
                Banner(systemImage: "exclamationmark.triangle", tint: .orange) {
                    Text(failure)
                } action: {
                    Button("Dismiss") { review.dismissFailure() }
                }
                .background(.bar)
            }
            if review.shown != nil, let page = review.page {
                WebView(page)
                    .webViewLinkPreviews(.disabled)
                    .webViewBackForwardNavigationGestures(.disabled)
                    .webViewElementFullscreenBehavior(.disabled)
                    .webViewTextSelection(.enabled)
                    .webViewContextMenu { _ in
                        Button("Copy") {
                            Task {
                                let text = await review.selectedText()
                                if !text.isEmpty { model.platform.copyText(text) }
                            }
                        }
                        Button("Close Comparison") { Task { await model.closeReview() } }
                    }
                    .accessibilityLabel("Changes between revisions")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: review.shown == nil ? nil : .infinity, alignment: .top)
        .background { if review.shown != nil { Rectangle().fill(.background) } }
        .onChange(of: model.settings) { _, settings in Task { await review.apply(settings) } }
    }

    private struct EntryRequest: Identifiable {
        let entry: RevisionReview.Entry
        var id: String {
            switch entry {
            case .show: "show"
            case .compare(let target): "compare-\(target)"
            }
        }
    }
}

/// The bar above a comparison: which revisions it compares, what it found, and its controls.
struct ReviewBar: View {
    @Bindable var model: ReaderModel
    let summary: ReviewSummary

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "plusminus").foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Changes: revision \(summary.base) → \(summary.target)")
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                Text(summary.line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Menu {
                ForEach(choices, id: \.self) { revision in
                    Button("Revision \(revision)") { Task { await model.reviewChanges(base: revision, target: summary.target) } }
                }
                if !choices.isEmpty { Divider() }
                Button("Other Revision…") { model.review.entry = .compare(target: summary.target) }
            } label: {
                Label("Compare With", systemImage: "arrow.left.arrow.right")
            }
            .labelStyle(.iconOnly)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Compare revision \(summary.target) with another revision")
            Button("Done") { Task { await model.closeReview() } }
                .help("Close the comparison (⌘D)")
        }
        .controlSize(.small)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// The listed revisions other than the compared pair's later one, newest first.
    private var choices: [Int] {
        (model.snapshot?.revisions ?? []).reversed().filter { $0 != summary.target }
    }
}

/// Entry of an exact revision number, to show it or to compare with it.
struct RevisionEntryView: View {
    @Bindable var model: ReaderModel
    let entry: RevisionReview.Entry
    @State private var text = ""
    @FocusState private var focused: Bool

    private var latest: Int { model.latestRevision ?? 1 }

    private var number: Int? {
        guard let value = Int(text.trimmingCharacters(in: .whitespaces)), value >= 1, value <= latest else { return nil }
        if case .compare(let target) = entry, value == target { return nil }
        return value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            Text("Revisions 1 to \(latest) exist unless one was removed from the store.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                TextField("Revision", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 90)
                    .focused($focused)
                    .onSubmit(submit)
                    .accessibilityLabel("Revision number")
                Button(action: submit) { Text(actionLabel) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(number == nil)
                Button("Cancel", role: .cancel) { model.review.entry = nil }
            }
        }
        .padding(14)
        .frame(width: 280)
        .onAppear { focused = true }
    }

    private var title: String {
        switch entry {
        case .show: "Go to Revision"
        case .compare(let target): "Compare Revision \(target) With"
        }
    }

    private var actionLabel: String {
        switch entry {
        case .show: "Show"
        case .compare: "Compare"
        }
    }

    private func submit() {
        guard let number else { return }
        model.review.entry = nil
        Task {
            switch entry {
            case .show: await model.goToRevision(number)
            case .compare(let target): await model.reviewChanges(base: number, target: target)
            }
        }
    }
}
