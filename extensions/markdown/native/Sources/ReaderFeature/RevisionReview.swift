import Foundation
import MarkdownCore
import Observation

/// Native comparison data for the page-owned revision review.
@MainActor @Observable
public final class RevisionReview {
    public enum Entry: Equatable, Sendable { case show, compare(target: Int) }
    public private(set) var shown: ReviewSummary?
    public private(set) var preparing: (base: Int?, target: Int)?
    public private(set) var failure: String?
    public weak var page: ReaderWebPage?
    public var entry: Entry?
    public private(set) var html = ""
    var assets: [String: ResolvedAsset] = [:]
    @ObservationIgnored private var generation = 0
    @ObservationIgnored var openExternal: ((URL) -> Void)?
    @ObservationIgnored package var preparationGate: (@MainActor () async -> Void)?
    public init() {}
    public var visiblePage: ReaderWebPage? { shown == nil ? nil : page }
    func start(_ reference: DocumentReference, base: Int?, target: Int, settings: PageSettings) async {
        generation += 1
        let token = generation
        preparing = (base, target); failure = nil
        let result = await Task.detached(priority: .userInitiated) { () -> Result<PreparedReview, any Error> in
            Result { try ReviewPage.prepare(reference, base: base, target: target, settings: settings) }
        }.value
        await preparationGate?()
        guard token == generation else { return }
        guard !Task.isCancelled else { preparing = nil; return }
        preparing = nil
        switch result {
        case .failure(let error): failure = "The comparison was not prepared. \(error)"
        case .success(let prepared): html = prepared.html; assets = prepared.assets; shown = prepared.summary
        }
    }
    func install(_ prepared: PreparedReview) {
        generation += 1
        preparing = nil
        failure = nil
        html = prepared.html
        assets = prepared.assets
        shown = prepared.summary
    }

    public func close() {
        generation += 1
        shown = nil; preparing = nil; failure = nil; entry = nil; page = nil; html = ""; assets = [:]
    }
    public func dismissFailure() { failure = nil }
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
        review.page = page
        await review.start(reference, base: from, target: to, settings: settings)
        if review.shown != nil {
            updateAssets()
            await sendCommand("showReview", args: ["against": from as Any? ?? "previous"])
        }
        if review.preparing == nil, review.shown == nil {
            // A cancelled comparison must not pass cancellation to the resumed page load.
            await Task { await self.checkForUpdate() }.value
        }
    }

    /// Ends the comparison. A revision that arrived while the comparison held the reader's
    /// attention is then followed or announced as usual.
    public func closeReview() async {
        review.close()
        updateAssets()
        await sendCommand("escape")
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
