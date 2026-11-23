import AppKit
import EditorFeature
import MarkdownCore
import Observation
import ReaderFeature

/// The native shell owns data and system effects; one page owns all visible interaction.
@MainActor
final class ReaderSurface: NSView {
    let model: ReaderModel
    let state: ReadingStateStore
    private(set) var workspace: EditorWorkspace?
    var onWorkspace: ((EditorWorkspace) -> Void)?
    var onClose: (() -> Void)?
    var onReturnFocus: (() -> Void)?
    private var pendingAgent: (id: String, finish: (WebAgentApplyResult) -> Void)?
    private var observedDocument: UUID?
    private weak var displayedDraft: WorkingDocument?
    private var draftInstall: (document: UUID, token: UUID, task: Task<Void, Never>)?
    private var updatingDestination = false
    private struct SaveState: Equatable {
        let presentation: String
        let state: String
        let detail: String?
        let revision: Int?
    }
    private var shownSave: SaveState?
    private var shownConnection: String?
    private var shownNotice: UInt64?
    private var reviewedBinding: (presentation: String, document: UUID)?
    private var observation = 0
    private var applying = false
    private var changeTail: Task<Void, Never>?
    private var queuedChanges = 0
    private(set) var pageState: [String: Any] = [:]
    private var pageReady = false
    private let draftDirectory: URL
    private enum DraftReference { case session(UUID), recovery(UUID, UUID) }
    private var draftReferences: [String: DraftReference] = [:]
    private var draftReferenceKeys: [String: String] = [:]
    private var draftCursor: (token: String, query: String, offset: Int)?

    /// The page's paper behind the web view: Catppuccin Frappé base in dark, Latte base in light.
    static var paperColour: NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(srgbRed: 48 / 255, green: 52 / 255, blue: 70 / 255, alpha: 1)
                : NSColor(srgbRed: 239 / 255, green: 241 / 255, blue: 245 / 255, alpha: 1)
        }
    }

    init(model: ReaderModel, state: ReadingStateStore, chrome: String, workspace: EditorWorkspace? = nil, draftDirectory: URL? = nil) {
        self.model = model; self.state = state; self.workspace = workspace
        self.draftDirectory = draftDirectory ?? AppDelegate.stateDirectory().appendingPathComponent("Drafts")
        super.init(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        model.chrome = chrome; model.live = workspace?.collaboration != nil
        wantsLayer = true; layer?.backgroundColor = Self.paperColour.cgColor
        let view = model.page.webView
        view.frame = bounds; view.autoresizingMask = [.width, .height]
        addSubview(view)
        model.page.onDocumentReady = { [weak self] ready in
            guard let self, let workspace = self.workspace else { return }
            self.shownSave = nil
            self.shownConnection = nil
            if ready { Task { await self.reportStatus() } }
            // A refusal restores the old receipt before the workspace restores its buffer.
            workspace.webReady = ready && (self.draftInstall == nil || self.model.page.presentation != self.model.displayedPresentation)
            if ready, self.draftInstall == nil, let document = workspace.active, workspace.isDisplayed(document) { document.checkForUpdates() }
        }
        model.page.onMessage = { [weak self] message in
            guard let self else { return [:] }
            return try await self.receive(message)
        }
        if let workspace { connect(workspace) }
        observe()
        Task { [weak self] in try? await self?.model.page.load() }
    }
    required init?(coder: NSCoder) { nil }

    func setWorkspace(_ workspace: EditorWorkspace) {
        self.workspace = workspace
        shownNotice = nil; shownConnection = nil; shownSave = nil
        connect(workspace); observe()
        Task { await showWorkspace() }
    }

    func waitForPendingChanges() async { await changeTail?.value }

    func sendCommand(_ name: String, args: [String: Any] = [:]) {
        guard workspace?.closing != true else { return }
        Task { await model.sendCommand(name, args: args) }
    }

    func commandEnabled(_ name: String) -> Bool {
        switch name {
        case "undo": return pageState["canUndo"] as? Bool == true
        case "redo": return pageState["canRedo"] as? Bool == true
        case "back": return pageState["canBack"] as? Bool == true
        case "forward": return pageState["canForward"] as? Bool == true
        case "format": return pageState["lock"] as? String == "writing" && pageState["activeBlock"] is [String: Any]
        case "askSelection", "copyPassage": return pageState["hasSelection"] as? Bool == true
        default: return pageReady
        }
    }

    private func signalReviewChange() {
        Task { [weak self] in _ = try? await self?.model.sendEnvelope(["v": 1, "type": "reviewChanged"]) }
    }

    private func reviewPresentationReady(_ workspace: EditorWorkspace) {
        guard model.live, pageMatchesWorkspace, let presentation = model.page.presentation,
              let key = workspace.logicalDocumentKey,
              reviewedBinding?.presentation != presentation || reviewedBinding?.document != key else { return }
        reviewedBinding = (presentation, key)
        signalReviewChange()
    }

    private func retainReview(_ request: ReaderReviewComments.Request, in workspace: EditorWorkspace) async {
        do { try await workspace.reviewComments.confirmed(request) }
        catch {
            workspace.notice = "The conversation received your comment, but the reader could not save its review state. Open comments to try the local save again."
        }
    }

    private func connect(_ workspace: EditorWorkspace) {
        model.live = workspace.collaboration != nil
        if workspace.webHostModel !== model {
            let previousKey = workspace.logicalDocumentKey
            workspace.webHostModel = model
            workspace.webReady = model.page.documentReady
            if previousKey != workspace.logicalDocumentKey { workspace.collaboration?.bind(document: workspace.liveDocumentID) }
        }
        workspace.drainPageChanges = { [weak self] in await self?.waitForPendingChanges() }
        workspace.pauseWindowInput = { [weak self] in
            guard let window = self?.window else { return nil }
            // Stop new input to this window between the final page flush and teardown without changing focus.
            let events: NSEvent.EventTypeMask = [.keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .leftMouseDragged,
                .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp]
            guard let monitor = NSEvent.addLocalMonitorForEvents(matching: events, handler: { [weak window] event in
                if let window, event.window === window { return nil }
                return event
            }) else { return nil }
            return { NSEvent.removeMonitor(monitor) }
        }
        workspace.flushReviewDrafts = { [weak self] in
            guard let self, self.model.live, self.pageReady else { return true }
            return (try? await self.model.page.callJavaScript("return await reader.flushReviewDrafts();")) as? Bool == true
        }
        workspace.webAgentApply = { [weak self] operation, generation, edits in
            guard let self, self.pageReady, self.pendingAgent == nil else { return .refused(reason: "stale") }
            return await withCheckedContinuation { continuation in
                self.pendingAgent = (operation, { continuation.resume(returning: $0) })
                Task {
                    do {
                        var envelope: [String: Any] = ["v": 1, "type": "agentApply", "operationId": operation,
                            "baseGeneration": generation, "edits": edits.map(Self.editPayload)]
                        if let workspace = self.workspace, let key = workspace.logicalDocumentKey,
                           let thread = workspace.collaboration?.currentAdmittedThreadId(for: key) { envelope["threadId"] = thread }
                        _ = try await self.model.sendEnvelope(envelope)
                    } catch {
                        self.finishAgent(operation, result: .refused(reason: "unknown"))
                    }
                }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(20))
                    self?.finishAgent(operation, result: .refused(reason: "unknown"))
                }
            }
        }
        workspace.webClaim = { [weak self] id, ranges, label, expires in
            var message: [String: Any] = ["v": 1, "type": "claim", "claimId": id,
                "ranges": ranges.map { ["start": $0.location, "end": NSMaxRange($0)] },
                "expiresAt": expires.timeIntervalSince1970 * 1000]
            if let label { message["label"] = label }
            Task { _ = try? await self?.model.sendEnvelope(message) }
        }
        workspace.webHeldRefusal = { [weak self] in
            Task { _ = try? await self?.model.sendEnvelope(["v": 1, "type": "notice", "tone": "agent",
                "text": "The agent wants to change this passage.", "actions": [["id": "releaseHold", "label": "Let it"]]]) }
        }
        workspace.webRelease = { [weak self] id in
            Task { _ = try? await self?.model.sendEnvelope(["v": 1, "type": "release", "claimId": id]) }
        }
        if workspace.collaboration != nil {
            workspace.reviewComments.onChange = { [weak self, weak workspace] identity in
                guard let self, let workspace, self.workspace === workspace, let scope = workspace.reviewScope,
                      workspace.reviewComments.identity(scope) == identity else { return }
                self.signalReviewChange()
            }
            reviewPresentationReady(workspace)
        }
        workspace.collaboration?.onDocumentPromptState = { [weak self, weak workspace] key, id, thread, status, detail in
            if let self, let workspace, let uuid = UUID(uuidString: id) {
                let request = ReaderReviewComments.Request(document: key, id: uuid)
                if ["sent", "admitted", "working", "answered", "unanswered"].contains(status) {
                    Task { await self.retainReview(request, in: workspace) }
                } else if status == "failed" { workspace.reviewComments.refused(request) }
            }
            var message: [String: Any] = ["v": 1, "type": "promptState", "documentKey": key.uuidString, "requestId": id, "threadId": thread, "state": status]
            if let detail { message["detail"] = detail }
            Task { _ = try? await self?.model.sendEnvelope(message) }
        }
    }

    private func finishAgent(_ operation: String, result: WebAgentApplyResult) {
        guard let pending = pendingAgent, pending.id == operation else { return }
        pendingAgent = nil; pending.finish(result)
    }

    func ensureWorkspace() -> EditorWorkspace {
        if let workspace { return workspace }
        let root: String? = if case .stored(let root, _, _) = model.reference { root } else { state.selectedStoreRoot }
        let value = EditorWorkspace(directory: draftDirectory, store: root, automaticallySaves: true)
        value.reading = model; value.launchOrigin = model.launchOrigin
        workspace = value; connect(value); onWorkspace?(value); observe()
        return value
    }

    private func receive(_ message: [String: Any]) async throws -> [String: Any] {
        guard let type = message["type"] as? String else { throw BridgeFailure.invalid }
        switch type {
        case "ready":
            pageReady = true; workspace?.webReady = model.page.documentReady
            if workspace?.active != nil, observedDocument == nil { await showWorkspace() }
        case "state":
            pageState = message
            guard let workspace, pageMatchesWorkspace else { break }
            workspace.pageHeld = Self.range(message["held"])
            if let document = workspace.active, let selection = message["selection"] as? [String: Any],
               let range = Self.range(selection), let text = selection["text"] as? String,
               MirrorText.validRange(range, source: document.text.source),
               (document.text.source as NSString).substring(with: range).utf8.elementsEqual(text.utf8) {
                document.text.select(range)
                document.session.receive(source: document.text.source, generation: document.text.generation,
                    selection: .init(location: range.location, length: range.length), markedText: false)
            }
            // Queued source writes keep the live document busy until acknowledgement.
            updateBusy()
        case "edits":
            let change = try Self.change(message)
            guard let presentation = message["presentation"] as? String else { throw BridgeFailure.invalid }
            let install = draftInstall?.task
            queuedChanges += 1
            workspace?.pageBusy = true
            let previous = changeTail
            let task = Task { @MainActor [weak self] in
                await previous?.value
                await install?.value
                guard let self else { return }
                await self.applyPageChange(change, presentation: presentation)
                self.queuedChanges -= 1
                self.updateBusy()
            }
            changeTail = task
            await task.value
        case "agentRefused":
            guard let operation = message["operationId"] as? String else { throw BridgeFailure.invalid }
            finishAgent(operation, result: .refused(reason: message["reason"] as? String ?? "stale", range: Self.range(message["range"])))
        case "prompt":
            guard let request = message["requestId"] as? String, let thread = message["threadId"] as? String,
                  let generation = Self.generation(message["generation"]), let presentation = message["presentation"] as? String,
                  let key = message["documentKey"] as? String else { throw BridgeFailure.invalid }
            await waitForPendingChanges()
            guard let workspace, let client = workspace.collaboration else {
                return ["accepted": false, "detail": "The conversation connection is not available."]
            }
            let stale: [String: Any] = ["accepted": false, "fresh": client.isFreshPrompt(requestId: request),
                "detail": "The displayed document changed. Review your comment before another send."]
            guard workspace.logicalDocumentKey?.uuidString == key, model.page.documentKey == key,
                  pageMatchesWorkspace else { return stale }
            let known = client.knowsPrompt(requestId: request, threadId: thread)
            let visible = workspace.visibleText
            guard known || (installed(presentation) && visible?.generation == generation && model.sourceGeneration == generation
                && visible?.digest == model.snapshot?.digest) else { return stale }
            let source = known ? nil : visible?.source
            var structure: SourceStructure?
            func passage(_ range: NSRange?) -> PassageExcerpt? {
                guard let source, let range else { return nil }
                if structure == nil { structure = SourceStructure.scan(source) }
                return PassageExcerpt(source: source, start: range.location, end: NSMaxRange(range), structure: structure)
            }
            let reviewRequest = workspace.logicalDocumentKey.flatMap { key in
                UUID(uuidString: request).map { ReaderReviewComments.Request(document: key, id: $0) }
            }
            if client.isFreshPrompt(requestId: request), let scope = workspace.reviewScope, let reviewRequest {
                workspace.reviewComments.prepare(reviewRequest, scope: scope, message: message, source: source)
            }
            let result: CollaborationClient.PromptSubmission
            if let records = message["annotations"] as? [[String: Any]] {
                let annotations = try records.map { record in
                    guard let text = record["text"] as? String else { throw BridgeFailure.invalid }
                    let range = Self.range(record["quoteRange"])
                    return CollaborationClient.Annotation(text: text, quote: record["quote"] as? String, passage: passage(range), range: range, authoredRevision: record["authoredRevision"] as? Int)
                }
                result = await client.submitBatch(requestId: request, threadId: thread, annotations: annotations,
                                                  overall: message["overall"] as? String, generation: generation,
                                                  authoredRevision: message["authoredRevision"] as? Int)
            } else {
                guard let text = message["text"] as? String else { throw BridgeFailure.invalid }
                let range = Self.range(message["quoteRange"])
                result = await client.submitAnnotation(requestId: request, threadId: thread, text: text, quote: message["quote"] as? String,
                                                       range: range, passage: passage(range), generation: generation, authoredRevision: message["authoredRevision"] as? Int)
            }
            switch result {
            case .submitted:
                if let reviewRequest { await retainReview(reviewRequest, in: workspace) }
                return ["accepted": true]
            case .unknown(let retryable): return ["accepted": false, "uncertain": true, "retryable": retryable]
            case .refused(let detail):
                let fresh = client.isFreshPrompt(requestId: request)
                if fresh, let reviewRequest { workspace.reviewComments.refused(reviewRequest) }
                return ["accepted": false, "fresh": fresh, "detail": detail]
            }
        case "query":
            if message["kind"] as? String == "reviewDraft" {
                guard let workspace else { return ["available": false, "version": 0] }
                return try await workspace.reviewDraftPage(message)
            }
            if message["kind"] as? String == "reviewComments", let workspace { return try await workspace.reviewPage(message) }
            if message["kind"] as? String == "library", message["collection"] as? String == "drafts" { return try await draftLibrary(message) }
            guard message["kind"] as? String == "review", message["against"] as? String == "base",
                  let workspace, pageMatchesWorkspace, let document = workspace.active else { throw BridgeFailure.invalid }
            let source = document.text.source, generation = document.text.generation
            let base = try await workspace.draftReviewBase()
            guard workspace.active === document, document.text.generation == generation else { throw BridgeFailure.invalid }
            let review = try await model.queryDraftReview(base: base, currentSource: source, resolver: document.assetResolver)
            guard pageMatchesWorkspace, workspace.active === document, document.text.generation == generation else { throw BridgeFailure.invalid }
            return review
        case "command":
            await waitForPendingChanges()
            guard let name = message["name"] as? String else { throw BridgeFailure.invalid }
            let args = message["args"] as? [String: Any] ?? [:]
            if name == "setReviewDraft", let workspace { return await workspace.reviewDraftSet(args) }
            if name == "setReviewComment", let workspace { return await workspace.reviewPageSet(args) }
            return try await command(name, args: args)
        default: break
        }
        return [:]
    }

    private func updateBusy() {
        workspace?.pageBusy = queuedChanges > 0 || (pageMatchesWorkspace && pageState["editingPending"] as? Bool == true)
    }

    private func installed(_ presentation: String) -> Bool {
        model.page.documentReady && model.page.presentation == presentation && model.displayedPresentation == presentation
    }

    private var pageMatchesWorkspace: Bool {
        guard let workspace, workspace.webReady, let key = workspace.logicalDocumentKey, let presentation = model.page.presentation else { return false }
        return !updatingDestination && model.page.documentKey == key.uuidString && installed(presentation)
    }

    private func refuseChange(_ change: WebPageChange, presentation: String, reason: String = "stale") async {
        _ = try? await model.sendEnvelope(["v": 1, "type": "refused", "presentation": presentation,
            "generation": change.generation, "reason": reason])
        if let operation = change.operationId { finishAgent(operation, result: .refused(reason: "stale")) }
    }

    private func applyPageChange(_ change: WebPageChange, presentation: String) async {
        guard installed(presentation) else { await refuseChange(change, presentation: presentation); return }
        let workspace = ensureWorkspace()
        // A destination change updates metadata only. Source writes still belong to this exact buffer.
        guard pageMatchesWorkspace || (workspace.webReady && workspace.active != nil && workspace.active === displayedDraft
            && workspace.logicalDocumentKey != nil && model.isDraft) else { await refuseChange(change, presentation: presentation); return }
        let wasReading = workspace.reading != nil
        applying = true; workspace.pageBusy = true
        defer { applying = false; updateBusy() }
        do {
            let ack = try await workspace.receivePageChange(change, presentation: presentation)
            guard installed(presentation), let document = workspace.active else { throw BridgeFailure.invalid }
            observedDocument = document.id
            try await model.acceptSource(source: document.text.source, generation: document.text.generation,
                meta: wasReading || pageMatchesWorkspace ? metadata(document) : nil,
                resolver: document.assetResolver, draftId: document.session.record.id)
            guard installed(presentation), workspace.active === document else { throw BridgeFailure.invalid }
            var envelope: [String: Any] = ["v": 1, "type": "ack", "presentation": presentation, "generation": ack.generation,
                "digest": ack.digest, "recovery": ack.recoveryRetained ? "retained" : "pending"]
            if wasReading { envelope["meta"] = metadata(document) }
            guard try await model.sendEnvelope(envelope) as? Bool == true else { throw BridgeFailure.invalid }
            if installed(presentation), workspace.active === document {
                displayedDraft = document
                if wasReading, pageMatchesWorkspace { workspace.collaboration?.bind(document: workspace.liveDocumentID) }
            }
            if let operation = change.operationId { finishAgent(operation, result: .accepted(change)) }
            await reportStatus()
        } catch {
            await refuseChange(change, presentation: presentation, reason: String(describing: error))
            if installed(presentation), pageMatchesWorkspace {
                applying = false
                await resynchronise()
            }
        }
    }

    private func command(_ name: String, args: [String: Any]) async throws -> [String: Any] {
        switch name {
        case "returnFocus":
            if let onReturnFocus { onReturnFocus() } else { await model.returnToTerminal() }
        case "close": onClose?()
        case "openLink":
            guard let href = args["href"] as? String, let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { throw BridgeFailure.invalid }
            let alert = NSAlert()
            alert.messageText = "Open this link in your browser?"; alert.informativeText = href
            alert.addButton(withTitle: "Open"); alert.addButton(withTitle: "Cancel")
            guard let window else { throw BridgeFailure.invalid }
            let response = await withCheckedContinuation { continuation in alert.beginSheetModal(for: window) { continuation.resume(returning: $0) } }
            if response == .alertFirstButtonReturn { model.pendingExternalURL = url; model.confirmExternal() }
        case "copy":
            guard let text = args["text"] as? String, text.utf8.count <= Limits.sourceBytes else { throw BridgeFailure.invalid }
            model.platform.copyText(text)
        case "readClipboard":
            // The page's own menu pastes through the host, so WebKit shows no paste permission prompt.
            let text = model.platform.readText() ?? ""
            guard text.utf8.count <= Limits.sourceBytes else { throw BridgeFailure.invalid }
            return ["text": text]
        case "export":
            switch args["format"] as? String {
            case "archive": await model.exportRevision(.archive)
            case "sharing": await model.exportRevision(.sharing)
            case "pdf": await model.exportCurrentPagePDF()
            default: throw BridgeFailure.invalid
            }
        case "showRevision":
            guard !model.isDraft, let n = args["n"] as? Int, n > 0 else { throw BridgeFailure.invalid }
            await model.showRevision(n)
        case "showLatest": await model.refresh()
        case "reviewChanges":
            var arguments = args
            if workspace?.active != nil { arguments["against"] = "base" }
            await model.sendCommand("showReview", args: arguments)
        case "inspectImage": await model.sendCommand("inspectImage", args: args)
        case "showOriginal": await model.sendCommand("showReview", args: ["against": "base"])
        case "details": await model.sendCommand("showDetails")
        case "pickImage":
            guard let generation = Self.generation(args["generation"]), generation == model.sourceGeneration,
                  let range = Self.range(args["range"]) else { throw BridgeFailure.invalid }
            let reply = try await ensureWorkspace().preparePickedImages(generation: generation, range: range, source: model.source)
            if reply.cancelled { return ["cancelled": true] }
            return ["generation": reply.generation, "edits": reply.edits.map(Self.editPayload)]
        case "newDraft": ensureWorkspace().newScratchpad(); await showWorkspace()
        case "chooseStore":
            let result = try await Self.chooseStore(state: state, workspace: workspace)
            return result
        case "open":
            guard let token = args["ref"] as? String else { sendCommand("open"); return [:] }
            let workspace = ensureWorkspace()
            if let draft = draftReferences[token] {
                switch draft {
                case .session(let id):
                    guard let document = workspace.documents.first(where: { $0.id == id }) else { throw BridgeFailure.invalid }
                    workspace.select(document)
                case .recovery(let id, let branch):
                    if let document = workspace.documents.first(where: { $0.session.record.id == id && $0.session.record.branch == branch }) {
                        workspace.select(document)
                    } else {
                        let record = try await workspace.drafts.load(id: id, branch: branch)
                        workspace.add(record.resumed())
                    }
                }
                await showWorkspace()
            } else {
                guard let reference = model.resolveReference(token) else { throw BridgeFailure.invalid }
                await workspace.openReading(reference, followsLatest: model.chrome == "pane")
            }
        case "saveSettings": break // The ReaderModel owns durable page settings.
        default: throw BridgeFailure.invalid
        }
        return [:]
    }

    static func chooseStore(state: ReadingStateStore, workspace: EditorWorkspace?) async throws -> [String: Any] {
        let panel = NSOpenPanel()
        panel.title = "Open Document Store"; panel.prompt = "Select Store"
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        let response = await withCheckedContinuation { continuation in panel.begin { continuation.resume(returning: $0) } }
        guard response == .OK, let url = panel.url else { return ["changed": false] }
        let canonical = try await Task.detached { try DirectoryStore(root: url).root }.value
        state.selectStore(root: canonical.path)
        workspace?.selectedStore = canonical.path
        return ["changed": true, "store": ["label": canonical.lastPathComponent]]
    }

    private func draftLibrary(_ fields: [String: Any]) async throws -> [String: Any] {
        let workspace = ensureWorkspace()
        let query = fields["query"] as? String ?? ""
        let sourceMatch = fields["match"] as? String == "source"
        let cursorQuery = (sourceMatch ? "source:" : "title:") + query
        let offset: Int
        if let token = fields["cursor"] as? String {
            guard let cursor = draftCursor, cursor.token == token, cursor.query == cursorQuery else { throw BridgeFailure.invalid }
            offset = cursor.offset
        } else { offset = 0; draftCursor = nil }
        let listing = try await workspace.drafts.list(offset: offset)
        var rows: [[String: Any]] = []
        var visible = Set<String>()
        var searched = 0, sourceBytes = 0
        var searchStopped = false
        func row(_ record: DraftRecord, key: String, reference: DraftReference, subtitle: String) {
            guard visible.insert(key).inserted else { return }
            if sourceMatch, !query.isEmpty {
                let bytes = record.source.utf8.count
                guard searched < 20, bytes <= Limits.sourceBytes, sourceBytes + bytes <= 8 * 1024 * 1024 else { searchStopped = true; return }
                sourceBytes += bytes
            }
            searched += 1
            let excerpt = sourceMatch ? SourceContentSearch.excerpt(in: record.source, query: query) : nil
            guard query.isEmpty || (sourceMatch ? excerpt != nil : record.displayTitle.localizedStandardContains(query)) else { return }
            let token = draftReferenceKeys[key] ?? UUID().uuidString
            draftReferenceKeys[key] = token; draftReferences[token] = reference
            var item: [String: Any] = ["ref": token, "kind": "draft", "title": record.displayTitle,
                         "subtitle": subtitle, "age": ISO8601DateFormatter().string(from: record.updatedAt)]
            if let excerpt { item["excerpt"] = excerpt }
            rows.append(item)
        }
        if offset == 0 {
            if workspace.documents.count > 20 { searchStopped = true }
            for document in workspace.documents.prefix(20) {
                let record = document.session.record
                row(record, key: record.id.uuidString + ":" + record.branch.uuidString,
                    reference: .session(document.id), subtitle: "Open draft")
            }
        }
        for record in listing.records {
            row(record, key: record.id.uuidString + ":" + record.branch.uuidString,
                reference: .recovery(record.id, record.branch), subtitle: "Retained draft")
        }
        let stopped = listing.nextOffset != nil || !listing.issues.isEmpty || searchStopped
        var coverage: [String: Any] = ["searched": searched, "total": stopped || offset > 0 ? NSNull() : searched, "stopped": stopped]
        if searchStopped { coverage["reason"] = "The draft search reached its source or open-draft limit." }
        else if stopped { coverage["reason"] = listing.issues.isEmpty ? "More retained drafts remain." : "Some retained drafts are unavailable." }
        else if offset > 0 { coverage["reason"] = "Only this page of retained drafts was searched." }
        var reply: [String: Any] = ["rows": rows, "limited": stopped, "coverage": coverage,
            "store": ["label": "Private drafts"]]
        if let next = listing.nextOffset {
            let token = UUID().uuidString
            draftCursor = (token, cursorQuery, next); reply["cursor"] = token
        } else { draftCursor = nil }
        return reply
    }

    private func metadata(_ document: WorkingDocument) -> [String: Any] {
        let record = document.session.record
        var kind = "draft", id = record.id.uuidString
        var result: [String: Any] = ["revision": NSNull()]
        result["documentKey"] = workspace?.documentKey(for: document).uuidString
        switch record.destination {
        case .file(let base): kind = "localFile"; id = base.path
        case .published(let base): kind = "published"; id = base.document; result["revision"] = base.revision
        case .copy(let base): result["copyOf"] = base.document
        case .scratchpad: break
        }
        result.merge(["documentId": id, "kind": kind, "title": record.displayTitle,
            "shortId": String(id.prefix(12)), "digest": Digest.sha256(Data(record.source.utf8)),
            "revisions": [], "provenance": "", "capturedSource": false], uniquingKeysWith: { _, new in new })
        return result
    }

    private func showWorkspace() async {
        guard pageReady, !applying, let workspace else { return }
        if let document = workspace.active, workspace.reading == nil {
            if let install = draftInstall, install.document == document.id { await install.task.value; return }
            observedDocument = document.id
            let previous = model.page.presentation, token = UUID()
            let task = Task { @MainActor in
                defer { if draftInstall?.token == token { draftInstall = nil } }
                guard workspace.active === document, draftInstall?.token == token else { return }
                do {
                    try await model.sendDocument(source: document.text.source, generation: document.text.generation,
                        meta: metadata(document), resolver: document.assetResolver, draftId: document.session.record.id)
                    guard draftInstall?.token == token, workspace.active === document else { return }
                    displayedDraft = document
                    workspace.webReady = true
                    document.checkForUpdates()
                } catch {
                    guard draftInstall?.token == token, workspace.active === document, !workspace.closing else { return }
                    workspace.webReady = false
                    if let previous, installed(previous), workspace.resumeDisplayedBuffer(draft: displayedDraft, host: model) {
                        observedDocument = workspace.active?.id
                        workspace.webReady = true
                        workspace.pageHeld = Self.range(pageState["held"])
                        updateBusy()
                        workspace.notice = "The page kept the previous document. Finish the current edit and open the draft again."
                    } else { workspace.notice = "The draft did not open. Select it again to retry." }
                }
            }
            draftInstall = (document.id, token, task)
            await task.value
            await reportStatus()
        } else if let reading = workspace.reading, reading !== model, let snapshot = reading.snapshot {
            observedDocument = nil; displayedDraft = nil
            try? await model.showSnapshot(snapshot, latestRevision: reading.latestRevision)
        } else if workspace.reading === model { observedDocument = nil; displayedDraft = nil }
    }
    private func resynchronise() async {
        if workspace?.active != nil { await showWorkspace() }
        else if let snapshot = model.snapshot { try? await model.sendDocument(source: snapshot.source, generation: 0) }
    }
    private func updateDestination(in workspace: EditorWorkspace) async {
        guard !updatingDestination else { return }
        updatingDestination = true
        defer { updatingDestination = false }
        while workspace.webReady, let document = workspace.active, displayedDraft === document,
              let presentation = model.page.presentation, installed(presentation), let previousKey = model.page.documentKey,
              let key = workspace.logicalDocumentKey, previousKey != key.uuidString {
            do {
                try await model.updateDraftMetadata(metadata(document), draftId: document.session.record.id,
                                                    presentation: presentation, previousKey: previousKey)
            } catch { return }
            guard installed(presentation), workspace.active === document else { return }
            if workspace.logicalDocumentKey == key { workspace.collaboration?.bind(document: workspace.liveDocumentID) }
            shownSave = nil
        }
    }

    private func reportStatus() async {
        guard let workspace, model.page.documentReady else { return }
        if let status = workspace.collaboration?.connectionStatus, status != shownConnection {
            shownConnection = status
            _ = try? await model.sendEnvelope(["v": 1, "type": "connectionState", "detail": status])
        }
        if let notice = workspace.notice, workspace.noticeSerial != shownNotice {
            shownNotice = workspace.noticeSerial
            _ = try? await model.sendEnvelope(["v": 1, "type": "notice", "tone": "warn", "text": notice, "actions": []])
        }
        await updateDestination(in: workspace)
        reviewPresentationReady(workspace)
        guard pageMatchesWorkspace, let presentation = model.page.presentation, let document = workspace.active else { return }
        let session = document.session
        let state: String, detail: String?
        if let conflict = session.record.conflict { state = "conflict"; detail = conflict.message }
        else if case .failed(let error) = session.recovery { state = "retrying"; detail = "Draft recovery failed: " + error }
        else if let error = session.destinationSaveError { state = "retrying"; detail = error }
        else { state = session.saving ? "saving" : "saved"; detail = nil }
        let revision: Int? = if case .published(let base) = session.record.destination { base.revision } else { nil }
        let save = SaveState(presentation: presentation, state: state, detail: detail, revision: revision)
        guard save != shownSave else { return }
        shownSave = save
        var envelope: [String: Any] = ["v": 1, "type": "saveState", "presentation": presentation, "state": state]
        envelope["detail"] = detail; envelope["revision"] = revision
        _ = try? await model.sendEnvelope(envelope)
    }

    private func observe() {
        observation += 1; let token = observation
        withObservationTracking {
            _ = workspace?.active?.id
            _ = workspace?.reading?.snapshot?.digest
            _ = workspace?.noticeSerial
            _ = workspace?.collaboration?.connectionStatus
            _ = workspace?.active?.session.saving
            _ = workspace?.active?.session.destinationSaveError
            _ = workspace?.active?.session.recovery
            _ = workspace?.active?.session.record
            _ = model.displayedPresentation
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, token == self.observation else { return }
                self.observe()
                if let workspace = self.workspace {
                    self.connect(workspace)
                    if workspace.active?.id != self.observedDocument { await self.showWorkspace() }
                    await self.reportStatus()
                }
            }
        }
    }
    private static func editPayload(_ edit: MarkdownSourceEdit) -> [String: Any] {
        ["start": edit.range.location, "end": NSMaxRange(edit.range), "text": edit.replacement, "expected": edit.expected]
    }
    private static func generation(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue >= 0,
              number.doubleValue.rounded(.down) == number.doubleValue, number.doubleValue <= 9_007_199_254_740_991 else { return nil }
        return number.uint64Value
    }
    private static func range(_ value: Any?) -> NSRange? {
        guard let value = value as? [String: Any], let start = value["start"] as? Int, let end = value["end"] as? Int,
              start >= 0, end >= start else { return nil }
        return NSRange(location: start, length: end - start)
    }
    private static func change(_ message: [String: Any]) throws -> WebPageChange {
        guard let base = generation(message["baseGeneration"]), let generation = generation(message["generation"]),
              let origin = message["origin"] as? String, ["person", "agent", "history"].contains(origin),
              let values = message["edits"] as? [[String: Any]], !values.isEmpty, values.count <= ReaderBridgeCodec.editLimit else { throw BridgeFailure.invalid }
        let edits = try values.map { value -> MarkdownSourceEdit in
            guard let range = range(value), let text = value["text"] as? String, let expected = value["expected"] as? String else { throw BridgeFailure.invalid }
            return MarkdownSourceEdit(range: range, expected: expected, replacement: text)
        }
        return WebPageChange(baseGeneration: base, generation: generation, origin: origin, operationId: message["operationId"] as? String, edits: edits)
    }
    private enum BridgeFailure: Error { case invalid }
}
