import Foundation
import MarkdownCore
import Observation
import OSLog
import WebKit

let readerLog = Logger(subsystem: "local.harness.markdown-reader", category: "reader")

public struct ReaderTimings: Sendable, Equatable {
    public var readMilliseconds: Double
    public var renderMilliseconds: Double
    public var displayMilliseconds: Double
    public var totalMilliseconds: Double
}

public enum UpdateState: Equatable, Sendable {
    case revision(Int)
    case fileChanged
}

public enum FindStatus: Equatable, Sendable {
    case idle
    case found
    case notFound
}

public enum PositionRestore: String, Sendable {
    case block
    case none
}

public struct ReaderNotice: Equatable, Identifiable, Sendable {
    public enum Kind: Sendable { case info, warning }
    public let id = UUID()
    public var text: String
    public var kind: Kind
}

/// State and actions of one reader window. Each window owns one model and one web page; models
/// share nothing but the reading-state store.
@MainActor @Observable
public final class ReaderModel {
    public enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    public private(set) var reference: DocumentReference
    public let page: ReaderWebPage
    public private(set) var sourceGeneration: UInt64 = 0
    public var source: String { snapshot?.source ?? "" }
    public private(set) var lock: ReaderBridgeLock = .reading
    public private(set) var pageState: ReaderBridgePageState?
    public var chrome = "pane"
    public var live = false
    @ObservationIgnored private var initialLock: ReaderBridgeLock?
    @ObservationIgnored private var draftIdentity: UUID?
    @ObservationIgnored private var metadata: [String: Any] = [:]
    @ObservationIgnored private var sentBlockKeys: Set<String> = []
    @ObservationIgnored private var requestedSourceGeneration: UInt64 = 0
    @ObservationIgnored private var mirrorSequence = 0
    @ObservationIgnored private var draftReviewSequence = 0
    @ObservationIgnored private var referenceTokens: [String: DocumentReference] = [:]
    @ObservationIgnored private var referenceKeys: [DocumentReference: String] = [:]
    @ObservationIgnored private var libraryModel: LibraryModel?
    @ObservationIgnored private var libraryCursor: String?
    @ObservationIgnored private var librarySeen: Set<String> = []
    @ObservationIgnored private var libraryIdentity: LibraryQueryIdentity?
    @ObservationIgnored private var librarySequence = 0
    private struct LibraryQueryIdentity: Equatable {
        var collection: String
        var match: String
        var query: String
        var root: String?
    }
    public private(set) var snapshot: DocumentSnapshot?
    public private(set) var rendered: RenderedDocument?
    public private(set) var isDraft = false
    public private(set) var draftGeneration: UInt64?
    public private(set) var phase: Phase = .loading
    /// A failure while the last good revision stays on screen.
    public private(set) var failure: String?
    public private(set) var update: UpdateState?
    /// The newest revision this window knows: the pointer at the last load, or a newer one that
    /// the watcher saw.
    public private(set) var latestRevision: Int?
    public private(set) var notice: ReaderNotice?
    public private(set) var launchOrigin: LaunchOrigin?
    public private(set) var showingSource = false
    public private(set) var findStatus: FindStatus = .idle
    public private(set) var timings: ReaderTimings?
    public private(set) var lastRestore: PositionRestore = .none
    public private(set) var recoveries = 0
    public var outlineVisible = true

    public func toggleOutline() {
        outlineVisible.toggle()
        state.setPresentation(outlineOpen: outlineVisible)
        Task { await sendCommand("toggleOutline") }
    }

    public var readingStatus: String {
        let mode = showingSource ? "Source" : "Rendered"
        if let revision = snapshot?.revision {
            let identity = snapshot?.document.map { "\($0.id) · " } ?? ""
            if olderChosen, revision < (latestRevision ?? revision) { return "\(identity)Revision \(revision) selected · \(mode)" }
            if case .revision(let latest) = update { return "\(identity)Revision \(revision) · Update \(latest) deferred · \(mode)" }
            return "\(identity)Revision \(revision) · \(followsLatest ? "Following latest" : "Manual updates") · \(mode)"
        }
        return isDraft ? "Uncommitted draft · \(mode)" : "File · \(mode)"
    }
    public var findVisible = false
    public var findQuery = "" {
        didSet { if findQuery != oldValue { findStatus = .idle } }
    }
    public var pendingExternalURL: URL?
    public var detailsVisible = false
    public var imageEvidence: [ImageEvidence] = []
    /// The comparison of two revisions that this window shows over its document.
    public let review = RevisionReview()
    /// The inspection of one image that this window shows over its document.
    public let inspection = ImageInspection()
    /// When set, a newer revision replaces the shown one at the same reading position as soon as
    /// the reader sees it. Scrolling defers replacement until it settles. A text selection or
    /// an open find bar keeps the update notice for the reader's choice.
    public var followsLatest = false
    public var settings: PageSettings {
        didSet {
            guard settings != oldValue else { return }
            state.settings = settings
            Task { await applySettings() }
        }
    }

    @ObservationIgnored public let platform: ReaderPlatform
    @ObservationIgnored let state: ReadingStateStore
    @ObservationIgnored let assets = AssetTable()
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var loadPending = false
    /// Whether this window can tell that a newer revision exists.
    public let updates = UpdateObserver()
    @ObservationIgnored let preparations = PreparationQueue<PreparationRequest, Result<PreparedDocument, any Error>>(work: PreparationRequest.prepare)
    @ObservationIgnored private var positionTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var monitorTask: Task<Void, Never>?
    @ObservationIgnored private var closed = false
    @ObservationIgnored private var scrolling = false
    /// The reader chose an older revision than the latest; following waits until the reader
    /// returns to the latest revision.
    @ObservationIgnored private var olderChosen = false
    /// The latest revision whose automatic load failed; following skips it until the pointer
    /// names another revision.
    @ObservationIgnored private var failedRevision: Int?
    @ObservationIgnored private var interactionGeneration = 0
    @ObservationIgnored private var latestScroll: ReaderBridgeScroll?
    /// The source generation that `rendered` belongs to.
    @ObservationIgnored private var renderedGeneration: UInt64?
    @ObservationIgnored private var renderingWaiters: [(generation: UInt64, resume: CheckedContinuation<Void, Never>)] = []
    /// The start of the delivered block that contains the requested point; the page restores there.
    @ObservationIgnored private var requestedBlockStart: Int?
    @ObservationIgnored private var requestedScroll: ReaderBridgeScroll?
    @ObservationIgnored private var positionSourceLength: Int?
    /// Suspends a preparation result before installation or failure handling.
    @ObservationIgnored package var preparationGate: (@MainActor (Int?) async -> Void)?
    @ObservationIgnored private var displayWait: DisplayWait?
    @ObservationIgnored package var displayNavigationForCheck: (@MainActor () async throws -> Void)?
    var expectingLoad: Bool { displayWait != nil }

    public init(reference: DocumentReference, platform: ReaderPlatform, state: ReadingStateStore, initialLock: ReaderBridgeLock? = nil, webRoot: URL? = nil) {
        self.reference = reference
        self.platform = platform
        self.state = state
        self.settings = state.settings
        self.outlineVisible = state.outlineOpen
        self.initialLock = initialLock
        self.page = ReaderPageFactory.make(assets: assets, root: webRoot)
        page.receiveMessage = { [weak self] message in try await self?.receive(message) }
        page.contentProcessTerminated = { [weak self] in
            Task { await self?.recoverContentProcess() }
        }
    }


    // MARK: - Page bridge

    /// References sent to the page reveal no filesystem paths and remain valid for this model's lifetime.
    public func issueReference(_ reference: DocumentReference) -> String {
        if let token = referenceKeys[reference] { return token }
        let token = UUID().uuidString
        referenceTokens[token] = reference
        referenceKeys[reference] = token
        return token
    }

    public func resolveReference(_ token: String) -> DocumentReference? { referenceTokens[token] }

    public func setInitialLock(_ lock: ReaderBridgeLock) {
        initialLock = lock
        self.lock = capturedSource ? .reading : lock
    }

    public var capturedSource: Bool { metadata["capturedSource"] as? Bool ?? snapshot.map(isCaptured) ?? false }

    private var initialDraftLock: ReaderBridgeLock {
        draftIdentity.map { state.draftLock(for: $0.uuidString) } ?? .writing
    }

    private func isCaptured(_ snapshot: DocumentSnapshot) -> Bool {
        snapshot.document?.kind == .response || snapshot.document?.kind == .file
    }

    /// Reuses the same web view for a different authoritative reading snapshot.
    public func showSnapshot(_ snapshot: DocumentSnapshot, latestRevision: Int? = nil, initialLock: ReaderBridgeLock? = nil, origin: LaunchOrigin? = nil) async throws {
        guard !closed else { throw CancellationError() }
        await savePosition()
        generation += 1
        let token = generation
        loadPending = true
        defer { if token == generation { loadPending = false } }
        supersedeDisplay()
        updates.stop()
        preparations.discardWaiting()
        positionTask?.cancel()
        review.close()
        inspection.close()
        reference = snapshot.reference
        self.snapshot = snapshot
        self.latestRevision = latestRevision ?? snapshot.latestRevision
        self.launchOrigin = origin?.isUsable == true ? origin : nil
        metadata = [:]
        isDraft = false
        pageState = nil
        showingSource = false
        scrolling = false
        olderChosen = false
        failedRevision = nil
        timings = nil
        latestScroll = nil
        requestedScroll = nil
        update = nil
        failure = nil
        draftIdentity = nil
        lock = isCaptured(snapshot) ? .reading : (initialLock ?? .reading)
        try await acceptSource(source: snapshot.source, generation: 0, resolver: snapshot.resolver)
        guard token == generation, let rendered else { throw DisplayWait.Superseded() }
        _ = try await sendEnvelope(documentPayload(snapshot: snapshot, rendered: rendered, generation: 0, lock: lock, position: state.position(for: reference)))
        guard token == generation else { throw DisplayWait.Superseded() }
        sentBlockKeys = Set(rendered.blocks.map(\.key))
        phase = .ready
        startWatching()
        state.noteOpened(reference, title: Provenance.displayTitle(snapshot, rendered: rendered))
    }

    /// Updates the native mirror and rendering without replacing the page's history.
    public func acceptSource(source: String, generation: UInt64, meta: [String: Any]? = nil,
                             resolver: (any AssetResolving)? = nil, draftId: UUID? = nil) async throws {
        guard !closed else { throw CancellationError() }
        guard source.utf8.count <= Limits.sourceBytes, generation <= UInt64(ReaderBridgeCodec.maxInteger) else {
            throw ReaderBridgeError.oversized
        }
        let wasCaptured = capturedSource
        let registersDraft = draftId != nil && draftIdentity != draftId
        if let draftId { draftIdentity = draftId; isDraft = true }
        mirrorSequence += 1
        let mirror = mirrorSequence
        let assetResolver = resolver ?? snapshot?.resolver ?? NoAssetResolver()
        let nonce = rendered?.nonce ?? MarkdownRenderer.newNonce()
        sourceGeneration = generation
        var current: DocumentSnapshot
        if draftIdentity != nil {
            current = DocumentSnapshot.draft(reference: reference, title: meta?["title"] as? String ?? snapshot?.title ?? "Document", source: source, resolver: assetResolver)
        } else {
            current = snapshot ?? DocumentSnapshot.draft(reference: reference, title: meta?["title"] as? String ?? "Document", source: source, resolver: assetResolver)
        }
        current.source = source
        current.digest = Digest.sha256(Data(source.utf8))
        current.bytes = source.utf8.count
        current.resolver = assetResolver
        if let title = meta?["title"] as? String { current.title = title }
        snapshot = current
        if let meta {
            metadata = meta
            if let kind = meta["kind"] as? String { isDraft = draftIdentity != nil || kind == "draft" }
        }
        if registersDraft, let draftIdentity {
            if wasCaptured, !capturedSource {
                lock = initialLock ?? pageState?.lock ?? .writing
                initialLock = nil
            }
            state.setDraftLock(lock, for: draftIdentity.uuidString)
        }
        let result = await Task.detached(priority: .userInitiated) {
            MarkdownRenderer.render(source, resolver: assetResolver, nonce: nonce)
        }.value
        guard mirror == mirrorSequence, sourceGeneration == generation, self.source.utf8.elementsEqual(source.utf8) else { return }
        rendered = result
        renderedGeneration = generation
        resumeRenderingWaiters()
        draftGeneration = isDraft ? generation : nil
        phase = .ready
        failure = nil
        updateAssets()
    }

    /// Sends a complete document on open or resynchronisation, never after an ordinary edit.
    public func sendDocument(source: String, generation: UInt64, meta: [String: Any]? = nil,
                             resolver: (any AssetResolving)? = nil, initialLock: ReaderBridgeLock? = nil,
                             draftId: UUID? = nil) async throws {
        let changedDraft = draftId != nil && draftId != draftIdentity
        if changedDraft { latestScroll = nil; requestedScroll = nil }
        if let draftId { draftIdentity = draftId; isDraft = true }
        try await acceptSource(source: source, generation: generation, meta: meta, resolver: resolver)
        if let initialLock { self.initialLock = initialLock }
        else if changedDraft { self.initialLock = initialDraftLock }
        guard let snapshot, let rendered, sourceGeneration == generation, self.source.utf8.elementsEqual(source.utf8) else { return }
        lock = capturedSource ? .reading : (self.initialLock ?? lock)
        let position = cachedReadingPosition ?? (isDraft ? nil : state.position(for: reference))
        var envelope = documentPayload(snapshot: snapshot, rendered: rendered, generation: generation, lock: lock, position: position)
        if let meta { envelope["meta"] = mergedMetadata(envelope["meta"] as? [String: Any] ?? [:], override: meta) }
        _ = try await sendEnvelope(envelope)
        if let draftIdentity { state.setDraftLock(lock, for: draftIdentity.uuidString) }
        self.initialLock = nil
        sentBlockKeys = Set(rendered.blocks.map(\.key))
    }

    @discardableResult
    public func sendEnvelope(_ envelope: [String: Any]) async throws -> Any? {
        preparePositionDelivery(envelope)
        return try await page.send(envelope)
    }

    private func preparePositionDelivery(_ envelope: [String: Any]) {
        guard envelope["type"] as? String == "document" else { return }
        if !isDraft, let position = cachedReadingPosition { state.setPosition(position, for: reference) }
        positionSourceLength = (envelope["source"] as? String)?.utf16.count
        latestScroll = nil
        requestedScroll = nil
        requestedBlockStart = nil
        lastRestore = .none
        if let position = envelope["position"] as? [String: Any],
           let start = position["blockStart"] as? Int, let offset = position["offsetY"] as? Double {
            requestedScroll = ReaderBridgeScroll(blockStart: start, offsetY: offset)
            let starts = (envelope["blocks"] as? [[String: Any]] ?? []).compactMap { $0["start"] as? Int }
            requestedBlockStart = starts.last(where: { $0 <= start }) ?? start
        }
    }

    public func sendCommand(_ name: String, args: [String: Any] = [:]) async {
        do { _ = try await sendEnvelope(["v": 1, "type": "command", "name": name, "args": args]) }
        catch { readerLog.error("page command failed: \(error.localizedDescription, privacy: .public)") }
    }

    private func mergedMetadata(_ base: [String: Any], override: [String: Any]) -> [String: Any] {
        base.merging(override) { _, value in value }
    }

    func documentPayload(snapshot: DocumentSnapshot, rendered: RenderedDocument, generation: UInt64,
                         lock: ReaderBridgeLock, position: ReadingPosition?, includeOverride: Bool = true) -> [String: Any] {
        let captured = includeOverride ? (metadata["capturedSource"] as? Bool ?? isCaptured(snapshot)) : isCaptured(snapshot)
        var meta: [String: Any] = [
            "documentId": draftIdentity?.uuidString ?? snapshot.document?.id ?? reference.key,
            "kind": isDraft ? "draft" : (snapshot.document?.kind.rawValue ?? "localFile"),
            "title": Provenance.displayTitle(snapshot, rendered: rendered),
            "shortId": snapshot.document?.id ?? snapshot.location.lastPathComponent,
            "digest": snapshot.digest,
            "revision": snapshot.revision as Any? ?? NSNull(),
            "revisions": snapshot.revisions.map { ["n": $0, "createdAt": "", "current": $0 == snapshot.revision] as [String: Any] },
            "provenance": Provenance.summary(snapshot, rendered: rendered, latestRevision: latestRevision),
            "capturedSource": captured,
        ]
        if includeOverride { meta = mergedMetadata(meta, override: metadata) }
        let headings: [[String: Any]] = rendered.outline.map { heading in
            ["level": heading.level, "text": heading.title, "anchor": heading.id,
             "start": rendered.blocks.first(where: { $0.html.contains("id=\"" + heading.id + "\"") })?.start ?? 0]
        }
        var result: [String: Any] = [
            "v": 1, "type": "document", "meta": meta, "source": snapshot.source, "generation": generation,
            "blocks": blockPayload(rendered, incremental: false), "headings": headings,
            "settings": ["lock": (captured ? ReaderBridgeLock.reading : lock).rawValue,
                         "textSize": settings.textSizeMultiplier, "textSizeSteps": PageSettings.textSizeMultipliers,
                         "codeWrap": settings.wrapCode, "appearance": state.appearance,
                         "outlineWidth": state.outlineWidth, "outlineOpen": state.outlineOpen] as [String: Any],
            "chrome": chrome, "live": live,
        ]
        if let position, let start = position.blockStart, let offset = position.offsetY {
            result["position"] = ["blockStart": start, "offsetY": offset]
        }
        return result
    }

    private func blockPayload(_ rendered: RenderedDocument, incremental: Bool) -> [[String: Any]] {
        rendered.blocks.map { block in
            var item: [String: Any] = ["key": block.key, "start": block.start, "end": block.end, "type": block.type, "map": block.map]
            if !incremental || !sentBlockKeys.contains(block.key) { item["html"] = block.html }
            return item
        }
    }

    func updateAssets() {
        var combined = rendered?.assets ?? [:]
        combined.merge(review.assets) { _, value in value }
        assets.update(combined)
    }

    func receive(_ message: ReaderBridgeMessage) async throws -> [String: Any]? {
        guard !closed else { throw CancellationError() }
        switch message.type {
        case .ready:
            // The display operation waiting for ready owns the document delivery.
            return nil
        case .state:
            if let next = message.pageState {
                let previousScroll = pageState?.scroll
                pageState = next
                if next.scroll.blockStart <= (positionSourceLength ?? source.utf16.count) {
                    latestScroll = next.scroll
                    if let requested = requestedScroll, abs(requested.offsetY - next.scroll.offsetY) < 1,
                       requested.blockStart == next.scroll.blockStart || requestedBlockStart == next.scroll.blockStart {
                        lastRestore = .block
                        requestedScroll = nil
                    }
                }
                lock = capturedSource ? .reading : next.lock
                showingSource = next.overlay == "source"
                findVisible = next.findOpen
                if let find = message.fields["find"] as? [String: Any] {
                    findStatus = (find["count"] as? Int ?? 0) > 0 ? .found : .notFound
                }
                if previousScroll != next.scroll { scrolled() }
            }
            return nil
        case .lock:
            if let value = message.fields["lock"] as? String, let next = ReaderBridgeLock(rawValue: value) {
                if capturedSource, next == .writing, message.fields["copy"] as? Bool == true { initialLock = .writing }
                lock = capturedSource ? .reading : next
                if let draftIdentity { state.setDraftLock(lock, for: draftIdentity.uuidString) }
            }
            return nil
        case .render:
            // Page messages run concurrently: a render request can arrive while the change that
            // produced its generation still reaches the native mirror. Wait for that rendering.
            guard let requested = (message.fields["generation"] as? NSNumber)?.uint64Value else {
                throw ReaderBridgeError.staleGeneration
            }
            await waitForRendering(requested)
            guard requested == sourceGeneration, renderedGeneration == requested, let rendered else {
                throw ReaderBridgeError.staleGeneration
            }
            let blocks = blockPayload(rendered, incremental: message.fields["full"] as? Bool != true)
            sentBlockKeys.formUnion(rendered.blocks.map(\.key))
            return ["generation": sourceGeneration, "blocks": blocks]
        case .query:
            if page.onMessage != nil {
                if message.fields["kind"] as? String == "library", message.fields["collection"] as? String == "drafts" { return nil }
                if message.fields["kind"] as? String == "review", message.fields["against"] as? String == "base" { return nil }
            }
            return try await query(message.fields)
        case .command:
            // Native document data and settings do not depend on the application's edit owner.
            let nativeCommands: Set<String> = ["saveSettings"]
            if page.onMessage != nil, !nativeCommands.contains(message.fields["name"] as? String ?? "") { return nil }
            return try await handleCommand(message.fields)
        case .log:
            readerLog.notice("page: \(message.fields["message"] as? String ?? "", privacy: .public)")
            return [:]
        case .edits, .agentRefused, .prompt:
            guard page.onMessage != nil else { throw ReaderBridgeError.invalid("No edit or prompt owner") }
            return nil
        }
    }

    private func handleCommand(_ fields: [String: Any]) async throws -> [String: Any] {
        let args = fields["args"] as? [String: Any] ?? fields
        switch fields["name"] as? String {
        case "copy": if let text = args["text"] as? String { platform.copyText(text) }
        case "readClipboard": return ["text": platform.readText() ?? ""]
        case "openLink":
            if let href = args["href"] as? String, let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                pendingExternalURL = url
                _ = try? await sendEnvelope(["v": 1, "type": "notice", "tone": "info", "text": "Open \(href) in your browser?", "actions": [["id": "confirmExternal", "label": "Open in Browser"]]])
            }
        case "confirmExternal": confirmExternal()
        case "returnFocus": await returnToTerminal()
        case "showRevision": if let n = args["n"] as? Int { await showRevision(n) }
        case "reviewChanges": await reviewChanges(base: args["against"] as? Int)
        case "inspectImage": if let index = args["index"] as? Int { await inspectImage(index) }
        case "showOriginal": await toggleSource()
        case "details": await sendCommand("showDetails")
        case "saveSettings":
            let patch = args["patch"] as? [String: Any] ?? args
            var index = settings.textSize
            if let value = patch["textSize"] {
                guard let multiplier = value as? Double, multiplier.isFinite, multiplier > 0 else { throw ReaderBridgeError.invalid("textSize") }
                index = PageSettings.nearestTextSize(to: multiplier)
            }
            settings = PageSettings(textSize: index, wrapCode: patch["codeWrap"] as? Bool ?? settings.wrapCode)
            state.setPresentation(appearance: patch["appearance"] as? String, outlineWidth: patch["outlineWidth"] as? Double, outlineOpen: patch["outlineOpen"] as? Bool)
            if let open = patch["outlineOpen"] as? Bool { outlineVisible = open }
        default: throw ReaderBridgeError.invalid("Unsupported command")
        }
        return [:]
    }

    private func query(_ fields: [String: Any]) async throws -> [String: Any] {
        switch fields["kind"] as? String {
        case "review":
            guard fields["against"] as? String != "base", let target = snapshot?.revision else { throw ReviewError.notStored }
            let against = fields["against"] as? Int
            let cached = review.shown.map { ($0.target ?? 0) >= target && (against == nil || against == $0.base) } ?? false
            if !cached { await review.start(reference, base: against, target: target, settings: settings) }
            if let failure = review.failure { throw ReaderBridgeError.invalid(failure) }
            guard let summary = review.shown else { throw ReaderBridgeError.invalid("No review") }
            review.page = page
            updateAssets()
            return reviewPayload(summary, html: review.html)
        case "details":
            let rows = Provenance.details(snapshot, rendered: rendered, latestRevision: latestRevision, origin: launchOrigin)
            let images: [[String: Any]] = (rendered?.images ?? []).enumerated().map { index, image in
                var row: [String: Any] = ["index": index]
                switch image.source {
                case .local(let token):
                    let observation = assets.evidence(token)
                    row["state"] = observation.failure == nil ? (observation.served ? "read" : "admitted") : "unavailable"
                    if let failure = observation.failure { row["reason"] = failure }
                case .embedded: row["state"] = "embedded"
                case .external: row["state"] = "external"
                case .unavailable(let reason): row["state"] = "unavailable"; row["reason"] = MarkdownRenderer.reasonLabel(reason)
                }
                return row
            }
            return ["rows": rows.map { ["label": $0.0, "value": $0.1] }, "images": images]
        case "image":
            guard let index = fields["index"] as? Int else { throw ReaderBridgeError.invalid("index") }
            await prepareImage(index)
            guard let facts = inspection.facts, facts.index == index else { throw ReaderBridgeError.invalid("image") }
            var rows = facts.rows.map { ["label": $0.label, "value": $0.value] }
            if let problem = inspection.problem { rows.append(["label": "Problem", "value": problem]) }
            return ["address": inspection.address, "facts": rows, "width": inspection.naturalSize?.width ?? 0, "height": inspection.naturalSize?.height ?? 0]
        case "library":
            return try await queryLibrary(fields)
        default: throw ReaderBridgeError.invalid("query")
        }
    }

    /// Compares current uncommitted source with its exact stored base, without changing either.
    public func queryDraftReview(base: DocumentSnapshot, currentSource: String, resolver: any AssetResolving) async throws -> [String: Any] {
        guard !closed else { throw CancellationError() }
        draftReviewSequence += 1
        let query = draftReviewSequence
        let mirror = mirrorSequence
        let prepared = try await Task.detached(priority: .userInitiated) {
            try ReviewPage.prepareDraft(base: base, currentSource: currentSource, resolver: resolver)
        }.value
        guard !closed, query == draftReviewSequence, mirror == mirrorSequence, !Task.isCancelled else { throw CancellationError() }
        review.install(prepared)
        review.page = page
        updateAssets()
        return reviewPayload(prepared.summary, html: prepared.html)
    }

    private func reviewPayload(_ summary: ReviewSummary, html: String) -> [String: Any] {
        var fields: [String: Any] = ["base": summary.base, "target": summary.target.map { $0 as Any } ?? NSNull(),
                                     "changedRegions": summary.changedRegions, "addedLines": summary.addedLines,
                                     "removedLines": summary.removedLines, "assetChanges": summary.assetChanges,
                                     "partial": summary.partial, "line": summary.line]
        if summary.target == nil { fields["targetLabel"] = "Uncommitted draft" }
        return ["summary": fields, "html": html]
    }

    /// Supplies bounded library data to the page without exposing store paths as identities.
    func queryLibrary(_ fields: [String: Any]) async throws -> [String: Any] {
        let collection = fields["collection"] as? String ?? "recent"
        let match = fields["match"] as? String ?? "title"
        let query = fields["query"] as? String ?? ""
        guard ["recent", "published"].contains(collection), ["title", "source"].contains(match) else {
            throw ReaderBridgeError.invalid("library query")
        }
        if fields["cursor"] == nil {
            librarySequence += 1
            libraryCursor = nil
        }
        let sequence = librarySequence
        state.reload()
        let identity = LibraryQueryIdentity(collection: collection, match: match, query: query,
                                            root: state.selectedStoreRoot ?? state.knownRoots.first)
        let library: LibraryModel
        let sectionIDs: (LibraryModel) -> Set<String> = { model in
            Set(model.sections.filter { collection == "recent" ? $0.id == "recent" : $0.id != "recent" }.map(\.id))
        }
        if let cursor = fields["cursor"] as? String {
            guard cursor == libraryCursor, identity == libraryIdentity, let existing = libraryModel, !existing.loading else {
                throw ReaderBridgeError.invalid("cursor")
            }
            library = existing
            let selected = sectionIDs(library)
            let unseen = library.sections.filter { selected.contains($0.id) }.flatMap { library.visibleRows($0) }
                .filter { !librarySeen.contains($0.id) }
            if unseen.count < 100 {
                if !library.hasMoreSources(in: selected), let more = library.sections.first(where: { selected.contains($0.id) && $0.hasMore }) {
                    await library.loadMore(more.id)
                }
                if match == "source" { await library.searchNextSources(in: sectionIDs(library)) }
            }
        } else {
            library = LibraryModel(state: state, extraRoots: [], collections: collection == "published" ? [.published] : [])
            library.kind = collection == "published" ? "published" : "all"
            library.filter = match == "title" ? query : ""
            library.sourceQuery = match == "source" ? query : ""
            await library.reload()
            if match == "source" { await library.searchNextSources(in: sectionIDs(library)) }
            guard sequence == librarySequence else { throw CancellationError() }
            libraryModel = library
            libraryCursor = UUID().uuidString
            libraryIdentity = LibraryQueryIdentity(collection: collection, match: match, query: query, root: library.selectedRoot)
            librarySeen = []
        }
        guard sequence == librarySequence else { throw CancellationError() }
        let selected = sectionIDs(library)
        let sections = library.sections.filter { selected.contains($0.id) }
        let rows = sections.flatMap { library.visibleRows($0) }.filter { !librarySeen.contains($0.id) }
        let shown = Array(rows.prefix(100))
        librarySeen.formUnion(shown.map(\.id))
        let payload: [[String: Any]] = shown.map { row in
            let subtitle: String
            if case .file = row.reference { subtitle = "Local file" } else { subtitle = row.detail }
            var fields: [String: Any] = ["ref": issueReference(row.reference), "kind": row.record?.kind.rawValue ?? "localFile",
                                         "title": row.title, "subtitle": subtitle, "age": ""]
            if let excerpt = library.sourceExcerpt(for: row) { fields["excerpt"] = excerpt }
            return fields
        }
        let limited = rows.count > shown.count || sections.contains(where: \.hasMore) || library.hasMoreSources(in: selected)
        let label = library.selectedRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No store selected"
        var result: [String: Any] = ["rows": payload, "limited": limited, "store": ["label": label]]
        if match == "source" {
            let coverage = library.sourceCoverage(in: selected)
            var fields: [String: Any] = ["searched": coverage.searched, "total": coverage.total.map { $0 as Any } ?? NSNull(), "stopped": coverage.stopped]
            if let reason = coverage.reason { fields["reason"] = reason }
            result["coverage"] = fields
        }
        if limited { result["cursor"] = libraryCursor }
        return result
    }

    // MARK: - Opening and updates

    /// An explicit open: it replaces the window's launch origin with the request's own, which can
    /// be none, and shows the requested or latest revision. `digest` is the digest of an accepted
    /// open request; only the load that this open starts must find it.
    public func open(revision: Int? = nil, digest: String? = nil, origin: LaunchOrigin?) async {
        launchOrigin = origin?.isUsable == true ? origin : nil
        readerLog.notice("open \(self.reference.key, privacy: .public) revision=\(revision.map(String.init) ?? "latest", privacy: .public) origin=\(self.launchOrigin.map { $0.terminal + ($0.exact == nil ? "" : "+pane") } ?? "none", privacy: .public) window=\(self.snapshot == nil ? "new" : "existing", privacy: .public)")
        if snapshot == nil {
            await load(revision: revision, pinnedDigest: digest, restore: .saved)
        } else if loadPending || (revision ?? latestRevision) != snapshot?.revision || update == .fileChanged || (digest != nil && digest != snapshot?.digest) {
            await load(revision: revision, pinnedDigest: digest, restore: .current)
        }
    }

    /// Shows the latest revision. Without `followsLatest` the reader never does this by itself.
    public func refresh() async {
        guard !isDraft else { return }
        olderChosen = false
        failedRevision = nil
        await load(revision: nil, restore: .current)
    }

    public func showRevision(_ revision: Int) async {
        guard revision != snapshot?.revision else { return }
        olderChosen = revision < (latestRevision ?? revision)
        await load(revision: revision, restore: .current)
    }

    /// Whether the reader replaces the shown revision by itself now: it follows, no load runs,
    /// a newer revision is known, the reader did not choose an older one, and that revision's
    /// automatic load did not fail.
    private var followsNow: Bool {
        guard followsLatest, !olderChosen, !loadPending, case .revision(let latest) = update else { return false }
        return latest != failedRevision
    }

    public func showAdjacentRevision(newer: Bool) async {
        guard let snapshot, let current = snapshot.revision else { return }
        if let index = snapshot.revisions.firstIndex(of: current), snapshot.revisions.indices.contains(index + (newer ? 1 : -1)) {
            await showRevision(snapshot.revisions[index + (newer ? 1 : -1)])
        } else {
            await showUnlistedAdjacentRevision(newer: newer)
        }
    }

    enum RestoreMode {
        case saved
        case current
    }

    /// `automatic` marks a load that the reader started by itself to follow a new revision: it
    /// gives way when reading interaction started while it prepared the revision.
    func load(revision: Int?, pinnedDigest: String? = nil, restore: RestoreMode, automatic: Bool = false) async {
        guard !closed else { return }
        generation += 1
        supersedeDisplay()
        let token = generation
        loadPending = true
        startWatching()
        await prepareAndInstall(revision: revision, pinnedDigest: pinnedDigest, restore: restore, automatic: automatic, token: token)
        guard token == generation, !closed else { return }
        loadPending = false
        await checkForUpdate()
    }

    /// Invalidates obsolete analysis immediately, even when preview work is hidden or debounced.
    public func invalidateDraftPreview() {
        guard isDraft else { return }
        generation += 1
        supersedeDisplay()
        preparations.discardWaiting()
    }

    public func openDraft(source: String, generation sourceGeneration: UInt64, title: String, resolver: any AssetResolving) async {
        guard !closed else { return }
        isDraft = true; followsLatest = false; updates.stop()
        if draftIdentity == nil { draftIdentity = UUID() }
        generation += 1
        supersedeDisplay()
        let token = generation
        loadPending = true
        requestedSourceGeneration = sourceGeneration
        let draft = DraftPreviewSource(title: title, source: source, resolver: resolver)
        await prepareAndInstall(revision: nil, pinnedDigest: nil, restore: .current, automatic: false, token: token, draft: draft)
        guard token == generation else { return }
        loadPending = false
        if phase == .ready, failure == nil { draftGeneration = sourceGeneration }
    }

    private func prepareAndInstall(revision: Int?, pinnedDigest: String?, restore: RestoreMode, automatic: Bool, token: Int, draft: DraftPreviewSource? = nil) async {
        let started = Date()
        var position: ReadingPosition?
        switch restore {
        case .saved:
            state.reload()
            position = state.position(for: reference)
        case .current: break
        }
        // A newer load replaced this one before its preparation started.
        guard let result = await preparations.run(PreparationRequest(reference: reference, revision: revision, pinnedDigest: pinnedDigest, draft: draft)) else { return }
        switch result {
        case .success(let prepared): await preparationGate?(prepared.snapshot.revision)
        case .failure: await preparationGate?(revision)
        }
        guard token == generation, !closed else { return }
        switch result {
        case .failure(let error):
            if automatic { failedRevision = revision }
            fail(String(describing: error))
        case .success(let prepared):
            if automatic, await interacting() { return }
            let interaction = interactionGeneration
            // The cached place counts offsets in the shown text; the new revision's text can differ above it.
            if case .current = restore { position = cachedReadingPosition?.carried(from: source, to: prepared.snapshot.source) }
            if automatic, await interacting() { return }
            guard token == generation, !closed else { return }
            if automatic, interaction != interactionGeneration { return }
            guard await install(prepared, position: position, token: token, started: started) else {
                if automatic, token == generation, failure != nil { failedRevision = revision }
                return
            }
            if automatic { failedRevision = nil }
        }
    }

    /// Reports a failed load. The first load of a window fails the window; a later one keeps the
    /// shown revision and says that the update failed.
    private func fail(_ text: String) {
        if snapshot == nil {
            phase = .failed(text)
        } else {
            failure = text
            post("The update failed; the previous revision stays on screen. \(text)", kind: .warning)
        }
    }

    /// Displays a prepared revision and commits it only when the page displayed. The asset table
    /// serves the prepared tokens while the page loads. After a failed display the table returns
    /// to the shown rendering's tokens, the shown revision's state stays, and its page is displayed
    /// again at the position captured before the load. Returns true when the prepared revision was
    /// committed.
    private func install(_ prepared: PreparedDocument, position: ReadingPosition?, token: Int, started: Date) async -> Bool {
        let displayStart = Date()
        assets.replace(prepared.rendered.assets)
        do {
            let nextLock = isCaptured(prepared.snapshot) ? ReaderBridgeLock.reading : (initialLock ?? (isDraft ? initialDraftLock : .reading))
            let envelope = documentPayload(snapshot: prepared.snapshot, rendered: prepared.rendered,
                                           generation: isDraft ? requestedSourceGeneration : 0, lock: nextLock, position: position, includeOverride: false)
            try await display(envelope: envelope)
        } catch is DisplayWait.Superseded {
            return false
        } catch {
            guard token == generation, !closed else { return false }
            assets.replace(rendered?.assets ?? [:])
            fail("The page could not be shown: \(error.localizedDescription)")
            if snapshot != nil {
                try? await sendDocument(source: source, generation: sourceGeneration)
            }
            return false
        }
        guard token == generation, !closed else { return false }
        snapshot = prepared.snapshot
        rendered = prepared.rendered
        sourceGeneration = isDraft ? requestedSourceGeneration : 0
        renderedGeneration = sourceGeneration
        resumeRenderingWaiters()
        lock = isCaptured(prepared.snapshot) ? .reading : (initialLock ?? (isDraft ? initialDraftLock : .reading))
        initialLock = nil
        sentBlockKeys = Set(prepared.rendered.blocks.map(\.key))
        metadata = [:]
        failure = nil
        latestRevision = max(latestRevision ?? 0, prepared.snapshot.latestRevision ?? 0)
        if let shown = prepared.snapshot.revision, let latest = latestRevision, latest > shown {
            update = .revision(latest)
        } else {
            update = nil
        }
        imageEvidence = []
        phase = .ready
        timings = ReaderTimings(
            readMilliseconds: prepared.readMilliseconds,
            renderMilliseconds: prepared.renderMilliseconds,
            displayMilliseconds: Date().timeIntervalSince(displayStart) * 1000,
            totalMilliseconds: Date().timeIntervalSince(started) * 1000
        )
        if !isDraft { state.noteOpened(reference, title: Provenance.displayTitle(prepared.snapshot, rendered: prepared.rendered)) }
        readerLog.notice("rendered \(self.reference.key, privacy: .public) revision=\(prepared.snapshot.revision.map(String.init) ?? "-", privacy: .public) latest=\(prepared.snapshot.latestRevision.map(String.init) ?? "-", privacy: .public) update=\(self.update == nil ? "none" : "available", privacy: .public) restore=\(self.lastRestore.rawValue, privacy: .public) totalMs=\(Int(self.timings?.totalMilliseconds ?? 0), privacy: .public)")
        await savePosition()
        return true
    }

    /// Commits a document bridge delivery only after the application page accepts it.
    func display(envelope: [String: Any]) async throws {
        preparePositionDelivery(envelope)
        supersedeDisplay()
        let wait = DisplayWait()
        displayWait = wait
        defer { if displayWait === wait { displayWait = nil } }
        if let check = displayNavigationForCheck {
            try await wait.run(check)
        } else {
            try await wait.run { [page] in
                let accepted = try await page.send(envelope)
                guard accepted as? Bool == true else { throw URLError(.cannotParseResponse) }
            }
        }
    }

    private func supersedeDisplay() {
        let previous = displayWait
        displayWait = nil
        previous?.supersede()
    }

    /// Reloads the shown revision after the page's web content process ended, then returns to the
    /// saved reading position.
    func recoverContentProcess() async {
        guard !closed, snapshot != nil else { return }
        readerLog.notice("web content process ended; reloading \(self.reference.key, privacy: .public)")
        do {
            try await page.reload()
            try await sendDocument(source: source, generation: sourceGeneration)
        } catch is DisplayWait.Superseded {
            return
        } catch {
            post("The page could not be shown: \(error.localizedDescription)", kind: .warning)
            return
        }
        recoveries += 1
        post("The page stopped unexpectedly and was reloaded.", kind: .info)
    }

    // MARK: - Watching the pointer

    private func startWatching() {
        guard !closed, !isDraft else { return }
        updates.start(reference) { [weak self] in await self?.checkForUpdate() }
    }

    /// Notes a newer revision or a changed file without touching the page.
    public func checkForUpdate() async {
        guard let snapshot, !closed, !isDraft else { return }
        let token = generation
        let marker = await updates.readMarker(reference)
        guard let marker, token == generation, !closed else { return }
        switch reference {
        case .stored:
            guard let latest = Int(marker), latest > (snapshot.revision ?? 0) else { return }
            let newest = max(latestRevision ?? 0, latest)
            latestRevision = newest
            update = .revision(newest)
            readerLog.notice("update available \(self.reference.key, privacy: .public) revision=\(latest, privacy: .public)")
            if followsNow, await !interacting() {
                guard token == generation, !closed, !loadPending else { return }
                await load(revision: newest, restore: .current, automatic: true)
            }
        case .file:
            if marker != snapshot.digest { update = .fileChanged }
        }
    }

    // MARK: - Reading position

    /// Called when the page scrolls; saves the position after scrolling settles.
    public func scrolled() {
        guard !closed else { return }
        scrolling = true
        interactionGeneration += 1
        positionTask?.cancel()
        positionTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let self, !self.closed else { return }
            self.scrolling = false
            await self.savePosition()
            guard !Task.isCancelled, !self.closed else { return }
            self.positionTask = nil
            if self.followsNow, await !self.interacting() {
                guard !self.closed, !self.loadPending else { return }
                await self.load(revision: self.latestRevision, restore: .current, automatic: true)
            }
        }
    }

    func savePosition(final: Bool = false) async {
        guard !isDraft, !closed || final, phase == .ready, let position = cachedReadingPosition else { return }
        state.setPosition(position, for: reference)
    }

    /// Waits up to five seconds for the rendering of a generation the page already holds.
    private func waitForRendering(_ requested: UInt64) async {
        if closed || (renderedGeneration ?? 0) >= requested && sourceGeneration >= requested { return }
        await withCheckedContinuation { continuation in
            renderingWaiters.append((requested, continuation))
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(5))
                self?.resumeRenderingWaiters(all: true)
            }
        }
    }

    private func resumeRenderingWaiters(all: Bool = false) {
        let reached = renderedGeneration ?? 0
        var waiting: [(generation: UInt64, resume: CheckedContinuation<Void, Never>)] = []
        for waiter in renderingWaiters {
            if all || closed || waiter.generation <= reached || sourceGeneration > waiter.generation { waiter.resume.resume() }
            else { waiting.append(waiter) }
        }
        renderingWaiters = waiting
    }

    var cachedReadingPosition: ReadingPosition? {
        guard let latestScroll else { return nil }
        return ReadingPosition(blockStart: latestScroll.blockStart, offsetY: latestScroll.offsetY, revision: snapshot?.revision)
    }

    // MARK: - Reading actions

    public func find(backwards: Bool = false) async {
        let query = findQuery
        guard !query.isEmpty else {
            findStatus = .idle
            return
        }
        await sendCommand("find", args: ["query": query])
        if backwards { await sendCommand("findPrevious") }
    }

    /// Check-only access to the page's actual DOM selection.
    package func selectedText() async -> String {
        (try? await page.callJavaScript(PageScript.selectionText, contentWorld: PageScript.world) as? String) ?? ""
    }

    /// A bounded display quote, never a source range. Nil means the selection exceeds the bound.
    public func annotationSelection() async -> String? {
        guard phase == .ready, pageState?.overlay == nil else { return "" }
        let text = pageState?.selection?.text ?? ""
        return text.utf8.count <= 8192 ? text : nil
    }

    /// Whether the reader is in the middle of something that a page replacement would undo: a
    /// text selection, source view, an open find bar, a scroll that has not settled or a
    /// comparison of revisions in preparation or on screen.
    func interacting() async -> Bool {
        if lock == .writing && pageState?.activeBlock != nil { return true }
        if pageState?.hasSelection == true || pageState?.findOpen == true || pageState?.overlay != nil { return true }
        if showingSource || findVisible || scrolling || review.preparing != nil { return true }
        return false
    }

    public func showFind() {
        findVisible = true
        Task { await sendCommand("find", args: findQuery.isEmpty ? [:] : ["query": findQuery]) }
    }

    public func hideFind() {
        findVisible = false
        findStatus = .idle
        Task { await sendCommand("escape") }
    }

    public func changeTextSize(by step: Int) {
        settings = PageSettings(textSize: settings.textSize + step, wrapCode: settings.wrapCode)
    }

    public func resetTextSize() {
        settings = PageSettings(textSize: PageSettings.defaultTextSize, wrapCode: settings.wrapCode)
    }

    public func toggleWrap() {
        settings = PageSettings(textSize: settings.textSize, wrapCode: !settings.wrapCode)
    }

    private func applySettings() async {
        await sendCommand("applySettings", args: ["textSize": settings.textSizeMultiplier, "codeWrap": settings.wrapCode,
                                                  "appearance": state.appearance, "outlineWidth": state.outlineWidth, "outlineOpen": state.outlineOpen])
    }

    public func toggleSource() async {
        guard snapshot != nil else { return }
        interactionGeneration += 1
        showingSource.toggle()
        await sendCommand("showSource")
        if !showingSource { await checkForUpdate() }
    }

    public func copyMarkdown() {
        guard let snapshot else { return }
        platform.copyText(snapshot.source)
        post("Copied the Markdown source (\(ByteCountFormatter.string(fromByteCount: Int64(snapshot.bytes), countStyle: .file))).", kind: .info)
    }

    public func copyCode(_ index: Int) {
        guard let rendered, rendered.codeBlocks.indices.contains(index) else { return }
        platform.copyText(rendered.codeBlocks[index].literal)
        post("Copied the code block.", kind: .info)
    }

    public func revealInFinder() {
        guard let snapshot else { return }
        platform.reveal(snapshot.location)
    }

    public var displayTitle: String {
        snapshot.map { Provenance.displayTitle($0, rendered: rendered) } ?? "Opening…"
    }

    /// The return action exists only for a window with a launch origin.
    public var returnLabel: String? {
        launchOrigin.map { _ in "Return to \(LaunchOrigin.rexTerminal)" }
    }

    public private(set) var lastReturn: TerminalReturnResult?

    public func returnToTerminal() async {
        guard let origin = launchOrigin else { return }
        let result = await platform.returnToTerminal(origin)
        lastReturn = result
        readerLog.notice("return \(self.reference.key, privacy: .public) pane=\(String(describing: result.pane), privacy: .public) application=\(String(describing: result.application), privacy: .public)")
        let (text, kind) = Self.describe(result)
        post(text, kind: kind)
    }

    static func describe(_ result: TerminalReturnResult) -> (String, ReaderNotice.Kind) {
        let front: String
        switch result.application {
        case .activated: front = "Rex is in front."
        case .notRunning: front = "Rex is not running."
        case .failed(let reason): front = "Rex did not come to the front: \(reason)."
        }
        switch result.pane {
        case .focused:
            return (result.application == .activated ? "Rex is in front with the terminal pane selected." : "\(front) The terminal pane was selected in Rex.", result.application == .activated ? .info : .warning)
        case .stale(let detail):
            return ("\(front) The original pane no longer exists: \(detail)", .warning)
        case .unavailable(let reason):
            return ("\(front) Pane selection was not available: \(reason)", result.application == .activated ? .info : .warning)
        }
    }

    public func confirmExternal() {
        guard let url = pendingExternalURL else { return }
        pendingExternalURL = nil
        if !platform.openExternal(url) {
            post("The browser did not open \(url.absoluteString).", kind: .warning)
        }
    }

    public func dismissNotice() {
        notice = nil
    }

    func post(_ text: String, kind: ReaderNotice.Kind) {
        let notice = ReaderNotice(text: text, kind: kind)
        self.notice = notice
        if page.isReady {
            Task { _ = try? await sendEnvelope(["v": 1, "type": "notice", "tone": kind == .warning ? "warning" : "info", "text": text, "actions": []]) }
        }
        noticeTask?.cancel()
        noticeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(kind == .info ? 3 : 8))
            guard !Task.isCancelled, self?.notice?.id == notice.id else { return }
            self?.notice = nil
        }
    }

    /// Stops observation and queues the last position without waiting for persistence.
    public func close() async {
        guard !closed else { return }
        closed = true
        resumeRenderingWaiters(all: true)
        generation += 1
        supersedeDisplay()
        updates.stop()
        preparations.discardWaiting()
        positionTask?.cancel()
        monitorTask?.cancel()
        review.close()
        inspection.close()
        await savePosition(final: true)
        state.saveNow()
        page.close()
    }
}

// Native lifecycle checks suspend display delivery without substituting a product page.
extension ReaderModel {
    package func waitForDisplayForCheck() async {
        if let check = displayNavigationForCheck {
            supersedeDisplay()
            let wait = DisplayWait()
            displayWait = wait
            defer { if displayWait === wait { displayWait = nil } }
            try? await wait.run(check)
        }
    }

    package var isDisplayingForCheck: Bool { expectingLoad }
    package var isLoadingForCheck: Bool { loadPending }
    package var isScrollingForCheck: Bool { scrolling }
    package var refusedAssetRequests: Int { assets.refused }
    package var savedPositionForCheck: ReadingPosition? { state.position(for: reference) }
    package var servedAssetRequests: Int { assets.served }
    package var preparationsStartedForCheck: Int { preparations.started }

    package func capturePositionForCheck() async -> ReadingPosition? {
        cachedReadingPosition
    }
}

extension ReaderModel {
    func handle(_ request: NavigationRequest) {
        switch request {
        case .copyCode(let nonce, let index):
            if nonce == rendered?.nonce { copyCode(index) }
        case .inspectImage(let nonce, let index):
            if nonce == rendered?.nonce { Task { await inspectImage(index) } }
        case .external(let url):
            pendingExternalURL = url
        case .blocked(let url):
            let scheme = url?.scheme ?? "this"
            post("The reader does not open \(scheme) links.", kind: .info)
        case .sameDocument, .documentLoad:
            break
        }
    }
}
