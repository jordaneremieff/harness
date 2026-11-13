import MarkdownCore
import SwiftUI
import WebKit

/// The reader for one document. It holds no global state and can be placed in any window.
public struct ReaderView: View {
    @Bindable var model: ReaderModel
    @FocusState private var findFocused: Bool
    @State private var width: CGFloat = 900

    public init(model: ReaderModel) {
        self.model = model
    }

    private var outlineShown: Bool {
        model.outlineVisible && width >= 680 && !(model.rendered?.outline.isEmpty ?? true)
    }

    public var body: some View {
        HStack(spacing: 0) {
            if outlineShown {
                OutlineList(model: model)
                    .frame(width: min(280, max(190, width * 0.24)))
                Divider()
            }
            VStack(spacing: 0) {
                DocumentHeader(model: model)
                banners
                if model.findVisible { findBar }
                content
            }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { width = $0 })
        .overlay(alignment: .bottom) { noticeView }
        .confirmationDialog(
            "Open this address in your browser?",
            isPresented: Binding(get: { model.pendingExternalURL != nil }, set: { if !$0 { model.pendingExternalURL = nil } }),
            presenting: model.pendingExternalURL
        ) { _ in
            Button("Open in Browser") { model.confirmExternal() }
            Button("Cancel", role: .cancel) { model.pendingExternalURL = nil }
        } message: { url in
            Text(url.absoluteString)
        }
        .toolbar { toolbarContent }
        .onChange(of: model.findVisible) { _, visible in findFocused = visible }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading where model.snapshot == nil:
            ProgressView("Opening…").frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("The document could not be opened", systemImage: "doc.questionmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.refresh() } }
            }
        default:
            WebView(model.page)
                .webViewLinkPreviews(.disabled)
                .webViewBackForwardNavigationGestures(.disabled)
                .webViewElementFullscreenBehavior(.disabled)
                .webViewTextSelection(.enabled)
                .webViewContextMenu { info in contextMenu(info) }
                .webViewOnScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.y }, action: { _, _ in model.scrolled() })
                .accessibilityLabel(model.showingSource ? "Markdown source" : "Document")
        }
    }

    @ViewBuilder private func contextMenu(_ info: WebView.ActivatedElementInfo) -> some View {
        if let url = info.linkURL, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            Button("Open Link in Browser…") { model.pendingExternalURL = url }
            Button("Copy Link") { model.platform.copyText(url.absoluteString) }
            Divider()
        }
        Button("Copy") {
            Task {
                let text = await model.selectedText()
                if !text.isEmpty { model.platform.copyText(text) }
            }
        }
        Button("Copy Markdown") { model.copyMarkdown() }
        Divider()
        Button(model.showingSource ? "Show Document" : "Show Source") { Task { await model.toggleSource() } }
    }

    @ViewBuilder private var banners: some View {
        if let update = model.update {
            Banner(systemImage: "arrow.triangle.2.circlepath", tint: .blue) {
                switch update {
                case .revision(let latest):
                    Text("Revision \(latest) is available. You are reading revision \(model.snapshot?.revision ?? 0).")
                case .fileChanged:
                    Text("The file changed on disk.")
                }
            } action: {
                Button(update == .fileChanged ? "Reload" : "Show Latest") { Task { await model.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
        if let failure = model.failure {
            Banner(systemImage: "exclamationmark.triangle", tint: .orange) {
                Text("The last update failed: \(failure)")
            } action: {
                Button("Try Again") { Task { await model.refresh() } }
            }
        }
        if let snapshot = model.snapshot, snapshot.completeness.state == .partial {
            Banner(systemImage: "exclamationmark.circle", tint: .orange) {
                Text(Provenance.completenessText(snapshot.completeness))
            } action: { EmptyView() }
        }
    }

    private var findBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField("Find in document", text: $model.findQuery)
                .textFieldStyle(.roundedBorder)
                .focused($findFocused)
                .onSubmit { Task { await model.find() } }
                .onKeyPress(.escape) {
                    model.hideFind()
                    return .handled
                }
                .accessibilityLabel("Find in document")
            if model.findStatus == .notFound {
                Text("Not found").font(.callout).foregroundStyle(.secondary)
            }
            Button { Task { await model.find(backwards: true) } } label: { Image(systemName: "chevron.up") }
                .help("Find Previous (⇧⌘G)")
                .accessibilityLabel("Find previous")
                .disabled(model.findQuery.isEmpty)
            Button { Task { await model.find() } } label: { Image(systemName: "chevron.down") }
                .help("Find Next (⌘G)")
                .accessibilityLabel("Find next")
                .disabled(model.findQuery.isEmpty)
            Button("Done") { model.hideFind() }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    @ViewBuilder private var noticeView: some View {
        if let notice = model.notice {
            HStack(spacing: 8) {
                Image(systemName: notice.kind == .warning ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(notice.kind == .warning ? .orange : .green)
                Text(notice.text).lineLimit(3)
                Button { model.dismissNotice() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .shadow(radius: 4, y: 1)
            .padding(.bottom, 16)
            .padding(.horizontal, 16)
            .transition(.opacity)
            .accessibilityElement(children: .combine)
        }
    }

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { model.outlineVisible.toggle() } label: { Label("Outline", systemImage: "sidebar.left") }
                .help("Show or hide the outline (⌃⌘S)")
                .disabled(model.rendered?.outline.isEmpty ?? true)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if let snapshot = model.snapshot, snapshot.revisions.count > 1 {
                Menu {
                    ForEach(snapshot.revisions.reversed(), id: \.self) { revision in
                        Button {
                            Task { await model.showRevision(revision) }
                        } label: {
                            if revision == snapshot.revision {
                                Label(revisionLabel(revision, latest: model.latestRevision), systemImage: "checkmark")
                            } else {
                                Text(revisionLabel(revision, latest: model.latestRevision))
                            }
                        }
                    }
                    if snapshot.olderRevisionsUnlisted {
                        Divider()
                        Text("Older revisions are not listed")
                    }
                } label: {
                    Label("Revision \(snapshot.revision ?? 0)", systemImage: "clock.arrow.circlepath")
                }
                .help("Choose a revision")
            }
            Menu {
                Button("Bigger Text") { model.changeTextSize(by: 1) }
                Button("Smaller Text") { model.changeTextSize(by: -1) }
                Button("Actual Size") { model.resetTextSize() }
                Divider()
                Toggle("Wrap Code Lines", isOn: Binding(get: { model.settings.wrapCode }, set: { _ in model.toggleWrap() }))
                Toggle("Show Source", isOn: Binding(get: { model.showingSource }, set: { _ in Task { await model.toggleSource() } }))
            } label: {
                Label("View Options", systemImage: "textformat.size")
            }
            .help("Text size, code wrapping and source")
            Button { model.showFind() } label: { Label("Find", systemImage: "magnifyingglass") }
                .help("Find (⌘F)")
            Button { model.copyMarkdown() } label: { Label("Copy Markdown", systemImage: "doc.on.doc") }
                .help("Copy the Markdown source (⇧⌘C)")
                .disabled(model.snapshot == nil)
            if let label = model.returnLabel {
                Button { Task { await model.returnToTerminal() } } label: { Label(label, systemImage: "terminal") }
                    .help("\(label) (⇧⌘R). Activates the terminal application.")
            }
        }
    }

    private func revisionLabel(_ revision: Int, latest: Int?) -> String {
        revision == latest ? "Revision \(revision) (latest)" : "Revision \(revision)"
    }
}

struct Banner<Message: View, Action: View>: View {
    let systemImage: String
    let tint: Color
    @ViewBuilder let message: Message
    @ViewBuilder let action: Action

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage).foregroundStyle(tint).accessibilityHidden(true)
            message.font(.callout).frame(maxWidth: .infinity, alignment: .leading)
            action.controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(tint.opacity(0.09))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .contain)
    }
}

struct DocumentHeader: View {
    @Bindable var model: ReaderModel

    var body: some View {
        if let snapshot = model.snapshot {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(Provenance.summary(snapshot, rendered: model.rendered, latestRevision: model.latestRevision))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                Button { model.detailsVisible.toggle() } label: { Image(systemName: "info.circle") }
                    .buttonStyle(.borderless)
                    .help("Show document details (⌘I)")
                    .accessibilityLabel("Document details")
                    .popover(isPresented: $model.detailsVisible, arrowEdge: .bottom) {
                        DetailsView(model: model)
                    }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .overlay(alignment: .bottom) { Divider() }
        }
    }
}

struct OutlineList: View {
    @Bindable var model: ReaderModel

    var body: some View {
        let entries = model.rendered?.outline ?? []
        List(entries) { entry in
            Button {
                Task { await model.scrollTo(anchor: entry.id) }
            } label: {
                Text(entry.title)
                    .font(entry.level <= 1 ? .body.weight(.semibold) : entry.level == 2 ? .body : .callout)
                    .foregroundStyle(entry.level <= 2 ? .primary : .secondary)
                    .lineLimit(2)
                    .padding(.leading, CGFloat(max(0, entry.level - minimumLevel(entries))) * 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Heading level \(entry.level): \(entry.title)")
        }
        .listStyle(.sidebar)
        .accessibilityLabel("Outline")
    }

    private func minimumLevel(_ entries: [OutlineEntry]) -> Int {
        entries.map(\.level).min() ?? 1
    }
}

struct DetailsView: View {
    @Bindable var model: ReaderModel

    var body: some View {
        let rows = Provenance.details(model.snapshot, rendered: model.rendered, latestRevision: model.latestRevision, origin: model.launchOrigin)
        VStack(alignment: .leading, spacing: 10) {
            Text("Document Details").font(.headline)
            ScrollView {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                    ForEach(rows, id: \.0) { row in
                        GridRow {
                            Text(row.0).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                            Text(row.1).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.callout)
                    }
                }
            }
            .frame(maxHeight: 420)
            HStack {
                Button("Copy Details") {
                    model.platform.copyText(rows.map { "\($0.0): \($0.1)" }.joined(separator: "\n"))
                }
                Button("Show in Finder") { model.revealInFinder() }
                Spacer()
            }
        }
        .padding(16)
        .frame(width: 520)
    }
}
