import AppKit
import EditorFeature
import MacPlatform
import MarkdownCore
import Observation
import ReaderFeature
import UniformTypeIdentifiers

@MainActor @Observable
final class WorkingDocument: Identifiable {
    let id: UUID
    let session: EditSession
    let text: MirrorText
    private(set) var preview: ReaderModel
    private(set) var previewIsHost: Bool
    let updates = UpdateObserver()
    @ObservationIgnored private var checkTask: Task<Void, Never>?
    @ObservationIgnored private var checkRequested = false
    @ObservationIgnored private(set) var closed = false
    var readingDraft = false
    var annotationsEnabled = false
    @ObservationIgnored var onPersistenceNeeded: (() -> Void)?
    @ObservationIgnored var onAnnotationSelection: ((String?) -> Void)?
    @ObservationIgnored var onCommentSelection: ((String) -> Void)?
    @ObservationIgnored var onExternalChange: (() async -> Void)?
    @ObservationIgnored var persistenceTask: Task<Void, Never>?
    @ObservationIgnored var persistenceRequested = false
    var visible = false
    var stagingImages = false { didSet { if !stagingImages { onPersistenceNeeded?() } } }
    var findVisible = false
    var findText = ""
    var replacementText = ""
    var findCaseSensitive = false
    var findWholeWord = false
    var findInSelection = false
    var findScope: NSRange?
    var findScopeGeneration: UInt64?
    var findSummary = ""
    var searchBusy = false
    @ObservationIgnored var findRequested = false
    var goToLineText = ""
    @ObservationIgnored var findTask: Task<Void, Never>?
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var baseResolver: any AssetResolving = NoAssetResolver()
    var assetResolver: any AssetResolving {
        guard let root = session.record.assetRoot else { return baseResolver }
        return EditorDraftAssetResolver(base: baseResolver, root: URL(fileURLWithPath: root), images: session.record.stagedAssets ?? [])
    }
    var showsPreview: Bool { true }
    @ObservationIgnored var onApply: (([MarkdownSourceEdit], UInt64) async -> Bool)?
    init(record: DraftRecord, drafts: DraftStore, id: UUID = UUID(), hostModel: ReaderModel? = nil) {
        self.id = id
        session = EditSession(record: record, drafts: drafts)
        text = MirrorText(source: record.source, initialGeneration: record.generation)
        previewIsHost = hostModel != nil
        preview = hostModel ?? ReaderModel(reference: .file(path: "draft:" + record.id.uuidString), platform: MacPlatform.operations(), state: ReadingStateStore(directory: nil))
        if !previewIsHost { preview.outlineVisible = false }
        if case .file(let base) = record.destination { baseResolver = DirectoryAssetResolver(directory: URL(fileURLWithPath: base.path).deletingLastPathComponent()) }
        text.select(NSRange(location: record.selection.location, length: record.selection.length))
        text.onChange = { [weak self] snapshot in
            guard let self else { return }
            let changed = snapshot.generation != self.session.record.generation
            self.session.receive(source: snapshot.source, generation: snapshot.generation,
                                 selection: .init(location: snapshot.selectedRange.location, length: snapshot.selectedRange.length), markedText: snapshot.hasMarkedText)
            if changed {
                self.onPersistenceNeeded?()
                if !self.previewIsHost { self.preview.invalidateDraftPreview(); self.schedulePreview() }
                if self.findVisible { self.refreshFind() }
            }
        }
        observeBase()
    }

    func attachHost(_ model: ReaderModel) {
        guard preview !== model else { return }
        previewTask?.cancel()
        let previous = preview, closePrevious = !previewIsHost
        preview = model; previewIsHost = true
        if closePrevious { Task { await previous.close() } }
    }

    func setVisible(_ value: Bool) {
        visible = value
        if !value, !previewIsHost { preview.invalidateDraftPreview() }
        schedulePreview()
    }

    func setResolver(_ value: any AssetResolving) { baseResolver = value; schedulePreview(force: true) }

    func schedulePreview(force: Bool = false) {
        guard !previewIsHost else { return }
        previewTask?.cancel()
        guard visible, showsPreview, !text.hasMarkedText else { preview.invalidateDraftPreview(); return }
        let snapshot = text.snapshot, title = session.record.displayTitle, resolver = assetResolver
        guard force || preview.draftGeneration != snapshot.generation else { return }
        previewTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(180)) } catch { return }
            guard let self, !Task.isCancelled, self.visible, self.showsPreview,
                  self.text.generation == snapshot.generation else { return }
            await self.preview.openDraft(source: snapshot.source, generation: snapshot.generation, title: title, resolver: resolver)
        }
    }

    func observeBase() {
        updates.stop()
        let reference: DocumentReference
        switch session.record.destination {
        case .file(let base): reference = .file(path: base.requestedPath)
        case .published(let base): reference = .stored(root: base.root, storeId: base.storeId, document: base.document)
        default: return
        }
        updates.start(reference) { [weak self] in self?.checkForUpdates() }
        checkForUpdates()
    }

    func checkForUpdates() {
        checkRequested = true
        guard checkTask == nil, !closed else { return }
        checkTask = Task { [weak self] in
            guard let self else { return }
            defer { self.checkTask = nil }
            while self.checkRequested, !self.closed {
                self.checkRequested = false
                let destination = self.session.record.destination
                let reference: DocumentReference, expected: String
                switch destination {
                case .file(let base): reference = .file(path: base.requestedPath); expected = base.digest
                case .published(let base): reference = .stored(root: base.root, storeId: base.storeId, document: base.document); expected = String(base.revision)
                default: return
                }
                let marker = await self.updates.readMarker(reference)
                guard !self.closed, self.session.record.destination == destination, !self.session.saving, let marker, marker != expected else { continue }
                if let onExternalChange = self.onExternalChange { await onExternalChange(); continue }
                let conflict: EditConflict
                switch destination {
                case .published: conflict = .init(message: "A newer library revision exists. Your draft and expected revision remain unchanged.", revision: Int(marker))
                default: conflict = .init(message: "The file changed outside this editor. Your draft remains unchanged.", digest: marker)
                }
                if self.session.record.conflict != conflict { self.session.setConflict(conflict) }
            }
        }
    }

    func close() async {
        closed = true; checkTask?.cancel(); findTask?.cancel(); persistenceTask?.cancel(); updates.stop()
        previewTask?.cancel()
        if !previewIsHost { await preview.close() }
    }

    func applyEdits(_ edits: [MarkdownSourceEdit], generation: UInt64) async -> Bool {
        guard let onApply else { session.setError("The document page is not ready."); return false }
        return await onApply(edits, generation)
    }
}

@MainActor @Observable
final class EditorWorkspace {
    let id = UUID()
    var liveDocumentID = UUID() {
        didSet {
            guard oldValue != liveDocumentID else { return }
            pageHeld = nil; pageBusy = false; observedPageChanges.removeAll(); pendingLiveEdits.removeAll()
            expireClaims()
        }
    }
    @ObservationIgnored weak var webHostModel: ReaderModel? {
        didSet { if let webHostModel { for document in documents { document.attachHost(webHostModel) } } }
    }
    var webReady = false
    var pageHeld: NSRange?
    var pageBusy = false
    @ObservationIgnored var webAgentApply: ((String, UInt64, [MarkdownSourceEdit]) async -> WebAgentApplyResult)?
    @ObservationIgnored var webClaim: ((String, [NSRange], String?, Date) -> Void)?
    @ObservationIgnored var webRelease: ((String) -> Void)?
    /// Tells the page that an agent edit or claim waited because the person holds the passage.
    @ObservationIgnored var webHeldRefusal: (() -> Void)?
    @ObservationIgnored var pageChangeInProgress = false
    @ObservationIgnored var liveApplyInProgress = false
    @ObservationIgnored var observedPageChanges: [String: WebObservedChange] = [:]
    @ObservationIgnored var liveClaims: [String: WebLiveClaim] = [:]
    @ObservationIgnored var pendingLiveEdits: [String: WebPendingLiveEdit] = [:]
    @ObservationIgnored var issuedPageOperations: [String: UUID] = [:]
    @ObservationIgnored var preparedPickedImages: [String: PreparedPickedImage] = [:]
    @ObservationIgnored var pickingImages = false
    var collaboration: CollaborationClient? {
        didSet { for document in documents { document.annotationsEnabled = collaboration != nil } }
    }
    let drafts: DraftStore
    let assetDirectory: URL
    var documents: [WorkingDocument] = []
    var selected: UUID?
    var libraryVisible = false
    var recovered: [DraftRecord] = []
    var recoveryIssues: [String] = []
    var nextDraftOffset: Int?
    var notice: String?
    var closing = false
    var launchOrigin: LaunchOrigin?
    var reading: ReaderModel?
    var publishedLibrary: LibraryModel?
    private let readingState = ReadingStateStore(directory: nil)
    private var navigationGeneration: UInt64 = 0
    @ObservationIgnored var onClose: (() -> Void)?
    @ObservationIgnored var onRelease: (() -> Void)?
    @ObservationIgnored var onEditorFocus: (() -> Void)?
    let automaticallySaves: Bool
    var active: WorkingDocument? { documents.first { $0.id == selected } }
    func isDisplayed(_ document: WorkingDocument) -> Bool {
        active === document && reading == nil && !libraryVisible && publishedLibrary == nil
    }
    var selectedStore: String?

    init(directory: URL, store: String?, automaticallySaves: Bool = false) {
        self.automaticallySaves = automaticallySaves
        drafts = DraftStore(directory: directory); selectedStore = store
        assetDirectory = directory.deletingLastPathComponent().appendingPathComponent("EditorAssets")
    }

    @discardableResult func allowAction(_ action: String, document: WorkingDocument? = nil) -> Bool {
        guard (document ?? active)?.text.hasMarkedText != true else {
            notice = "Finish composing text before \(action)."
            return false
        }
        guard (document ?? active)?.stagingImages != true else { notice = "Wait for the image to reach private storage."; return false }
        return !closing
    }

    @discardableResult func allowNavigation(_ action: String) -> Bool {
        guard !pageBusy, !pageChangeInProgress, !liveApplyInProgress else {
            notice = "Wait for page changes before " + action + "."
            return false
        }
        return allowAction(action)
    }

    func add(_ record: DraftRecord, liveIdentity: UUID? = nil, pagePromotion: Bool = false) {
        guard pagePromotion ? allowAction("opening another document") : allowNavigation("opening another document") else { return }
        let document = WorkingDocument(record: record, drafts: drafts, id: liveIdentity ?? UUID(), hostModel: webHostModel)
        document.annotationsEnabled = collaboration != nil
        document.onAnnotationSelection = { [weak self, weak document] quote in
            guard let self, let document, self.annotationReader === document.preview else { return }
            self.collaboration?.selectQuote(quote)
        }
        document.onCommentSelection = { [weak self, weak document] quote in
            guard let self, let document, self.annotationReader === document.preview else { return }
            self.collaboration?.beginAnnotation(quote: quote)
        }
        document.onPersistenceNeeded = { [weak self, weak document] in
            guard let self, let document else { return }
            self.schedulePersistence(document)
        }
        if automaticallySaves {
            document.onExternalChange = { [weak self, weak document] in
                guard let self, let document else { return }
                await self.receiveExternalChange(document)
            }
        }
        document.onApply = { [weak self, weak document] edits, generation in
            guard let self, let document else { return false }
            return await self.applyThroughPage(edits, generation: generation, document: document)
        }
        let closedReading = reading != nil && liveIdentity != liveDocumentID ? liveDocumentID : nil
        leaveReading()
        active?.setVisible(false)
        if webHostModel != nil, !pagePromotion { webReady = false }
        documents.append(document); selected = document.id; liveDocumentID = document.id; libraryVisible = false
        collaboration?.bind(document: liveDocumentID, closing: closedReading)
        document.setVisible(true)
        if case .published(let base) = record.destination { loadResolver(base, document: document) }
        if case .copy(let base) = record.destination { loadResolver(base, document: document) }
        if !pagePromotion { focusWhenActive(document) }
    }

    func readActive() {
        guard allowAction("reading this document"), let document = active else { return }
        document.readingDraft = true
        collaboration?.selectQuote("")
        document.findVisible = false
        document.findTask?.cancel()
        document.schedulePreview(force: true)
    }

    func editActive() {
        guard allowAction("editing this document"), let document = active else { return }
        document.readingDraft = false
        collaboration?.selectQuote("")
        onEditorFocus?()
    }

    var annotationReader: ReaderModel? {
        guard !closing, !libraryVisible, publishedLibrary == nil else { return nil }
        if let reading { return reading }
        guard let active, active.readingDraft else { return nil }
        return active.preview
    }

    func nativeAnnotationSelection() -> String? {
        guard !closing, let document = active, !document.text.hasMarkedText else { return "" }
        let source = document.text.source as NSString, range = document.text.selectedRange
        guard range.length > 0 else { return "" }
        let quote = source.substring(with: range)
        return quote.utf8.count <= 8192 ? quote : nil
    }

    func restoreEditorFocus() { onEditorFocus?() }

    func annotateSelection() async {
        guard let client = collaboration, !closing, !libraryVisible, publishedLibrary == nil else { return }
        let identity = liveDocumentID
        let quote: String?
        if let reader = annotationReader {
            quote = await reader.annotationSelection()
            guard liveDocumentID == identity, annotationReader === reader else { return }
        } else { quote = nativeAnnotationSelection() }
        client.selectQuote(quote)
        guard let quote, !quote.isEmpty else { return }
        client.beginAnnotation(quote: quote)
    }

    func loadResolver(_ base: StoredEditBase, document: WorkingDocument) {
        Task { @MainActor in
            do {
                let resolver = try await Task.detached {
                    try DocumentLoader.load(.stored(root: base.root, storeId: base.storeId, document: base.document), revision: base.revision, pinnedDigest: base.digest).resolver
                }.value
                guard document.session.record.destination == .published(base) || document.session.record.destination == .copy(base) else { return }
                document.setResolver(resolver)
            } catch { document.session.setError("The base images are unavailable: \(error). Your draft remains intact.") }
        }
    }

    private func focusWhenActive(_ document: WorkingDocument) {
        Task { @MainActor [weak self, weak document] in
            guard let self, let document, self.active === document, !document.readingDraft, !self.libraryVisible, self.reading == nil, self.publishedLibrary == nil else { return }
            self.onEditorFocus?()
        }
    }

    func closeViews() async {
        closing = true
        discardUncommittedImages()
        collaboration?.stop()
        for document in documents { document.setVisible(false); await document.close() }
        await reading?.close()
    }

    func newScratchpad() { add(DraftRecord()) }

    func select(_ document: WorkingDocument) {
        guard allowNavigation("switching documents") else { return }
        let closedReading = reading == nil ? nil : liveDocumentID
        leaveReading()
        active?.setVisible(false)
        if webHostModel != nil, selected != document.id || closedReading != nil || !document.visible { webReady = false }
        selected = document.id; liveDocumentID = document.id; libraryVisible = false
        collaboration?.bind(document: liveDocumentID, closing: closedReading)
        document.setVisible(true)
        if webReady { document.checkForUpdates() }
        focusWhenActive(document)
    }

    func library(more: Bool = false) async {
        guard allowNavigation("opening drafts") else { return }
        let navigation = navigationGeneration
        do {
            let page = try await drafts.list(offset: more ? (nextDraftOffset ?? 0) : 0)
            guard navigation == navigationGeneration, allowNavigation("opening drafts") else { return }
            leaveReading()
            recovered = more ? recovered + page.records : page.records
            recoveryIssues = page.issues; nextDraftOffset = page.nextOffset; libraryVisible = true
            active?.setVisible(false)
        } catch { notice = "Drafts unavailable: \(error)" }
    }

    private func leaveReading() {
        navigationGeneration &+= 1
        if let root = publishedLibrary?.selectedRoot { selectedStore = root }
        let previous = reading
        reading = nil; publishedLibrary = nil
        if let previous, previous !== webHostModel { Task { await previous.close() } }
    }

    func showPublishedLibrary() async {
        guard allowNavigation("opening the library") else { return }
        leaveReading(); active?.setVisible(false); libraryVisible = false
        let model = LibraryModel(state: readingState, extraRoots: selectedStore.map { [$0] } ?? [])
        publishedLibrary = model
        if let selectedStore { await model.selectStore(selectedStore) } else { await model.reload() }
    }

    func chooseStore() {
        guard allowAction("choosing a store") else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in
                do {
                    let root = try await Task.detached { try DirectoryStore(root: url).root.path }.value
                    self?.selectedStore = root
                    await self?.publishedLibrary?.selectStore(root)
                } catch { self?.notice = "Store not selected: \(error)" }
            }
        }
    }

    func readStored(_ document: String, followsLatest: Bool = false) async {
        guard let root = selectedStore else { notice = "Choose a library store first."; return }
        do {
            let identity = try await Task.detached { try DirectoryStore(root: URL(fileURLWithPath: root)).storeId }.value
            await openReading(.stored(root: root, storeId: identity, document: document), followsLatest: followsLatest)
        } catch { notice = "Document not opened: \(error)" }
    }

    func openReading(_ reference: DocumentReference, revision: Int? = nil, digest: String? = nil, origin: LaunchOrigin? = nil, followsLatest: Bool = false) async {
        guard allowNavigation("opening another document") else { return }
        navigationGeneration &+= 1
        let navigation = navigationGeneration
        let previous = reading
        if let host = webHostModel {
            do {
                let snapshot = try await Task.detached { try DocumentLoader.load(reference, revision: revision, pinnedDigest: digest) }.value
                guard navigation == navigationGeneration, allowNavigation("opening another document") else { return }
                try await host.showSnapshot(snapshot, origin: origin ?? launchOrigin)
                guard navigation == navigationGeneration, reading === previous else { return }
                host.followsLatest = followsLatest
                publishedLibrary = nil; libraryVisible = false; active?.setVisible(false); reading = host
                let closedReading = previous == nil ? nil : liveDocumentID
                liveDocumentID = UUID(); collaboration?.bind(document: liveDocumentID, closing: closedReading)
                if let previous, previous !== host { await previous.close() }
                await host.checkForUpdate()
            } catch {
                guard navigation == navigationGeneration else { return }
                notice = "Document not opened: \(error)"
            }
            return
        }
        let next = ReaderModel(reference: reference, platform: MacPlatform.operations(), state: readingState)
        next.followsLatest = followsLatest
        publishedLibrary = nil; libraryVisible = false; active?.setVisible(false); reading = next
        await next.open(revision: revision, digest: digest, origin: origin ?? launchOrigin)
        guard reading === next else { await next.close(); return }
        if case .failed(let error) = next.phase {
            reading = previous; notice = "Document not opened: \(error)"
            if previous == nil { active?.setVisible(true) }
            await next.close()
        } else {
            let closedReading = previous == nil ? nil : liveDocumentID
            liveDocumentID = UUID(); collaboration?.bind(document: liveDocumentID, closing: closedReading)
            if previous !== webHostModel { await previous?.close() }
        }
    }

    @discardableResult func editReading(copy: Bool, pagePromotion: Bool = false) async -> Bool {
        guard pagePromotion ? allowAction("opening an edit") : allowNavigation("opening an edit"), let model = reading, model.phase == .ready, let snapshot = model.snapshot else { return false }
        let navigation = navigationGeneration
        do {
            let record: DraftRecord
            if case .stored(let root, let storeId, let id) = model.reference, let revision = snapshot.revision {
                let makeCopy = copy || snapshot.document?.kind != .published
                let base = StoredEditBase(root: root, storeId: storeId, document: id, revision: revision, digest: snapshot.digest)
                let reference = model.reference
                _ = try await Task.detached {
                    try DocumentLoader.load(reference, revision: revision, pinnedDigest: snapshot.digest)
                }.value
                record = DraftRecord(title: snapshot.title, source: snapshot.source, destination: makeCopy ? .copy(base) : .published(base), savedSource: makeCopy ? nil : snapshot.source)
            } else if case .file(let path) = model.reference {
                let file = try await Task.detached { try LocalFileSave.open(URL(fileURLWithPath: path)) }.value
                guard file.source == snapshot.source else { throw FileSaveError.changed }
                record = DraftRecord(title: snapshot.title, source: file.source, destination: .file(file.base), savedSource: file.source)
            } else { return false }
            guard navigation == navigationGeneration, reading === model, model.phase == .ready,
                  model.snapshot?.digest == snapshot.digest, model.snapshot?.revision == snapshot.revision,
                  allowAction("opening an edit") else { return false }
            if case .stored(let root, _, _) = model.reference { selectedStore = root }
            add(record, liveIdentity: liveDocumentID, pagePromotion: pagePromotion)
            active?.setResolver(snapshot.resolver)
            return true
        } catch { notice = "Edit not opened: \(error). The document remains readable."; return false }
    }

    /// Returns only the pinned stored base; the current draft and its history remain unchanged.
    func draftReviewBase() async throws -> DocumentSnapshot {
        guard !closing, reading == nil, let document = active else { throw WebMirrorError.closed }
        let record = document.session.record
        let base: StoredEditBase
        switch record.destination {
        case .published(let value), .copy(let value): base = value
        case .file, .scratchpad: throw FileSaveError.invalid("This draft has no stored base revision.")
        }
        let identity = liveDocumentID, generation = document.text.generation
        let snapshot = try await Task.detached {
            try DocumentLoader.load(.stored(root: base.root, storeId: base.storeId, document: base.document),
                revision: base.revision, pinnedDigest: base.digest)
        }.value
        guard !closing, reading == nil, active === document, liveDocumentID == identity,
              document.text.generation == generation, document.session.record.destination == record.destination else {
            throw WebMirrorError.stale
        }
        return snapshot
    }

    func returnToTerminal() async {
        guard allowAction("returning to Rex"), let launchOrigin else { return }
        let result = await MacPlatform.operations().returnToTerminal(launchOrigin)
        let application: String
        switch result.application {
        case .activated: application = "Rex is in front."
        case .notRunning: application = "Rex is not running."
        case .failed(let reason): application = "Rex did not come to the front: \(reason)."
        }
        switch result.pane {
        case .focused: notice = application + " The original pane was selected."
        case .stale(let reason): notice = application + " The original pane no longer exists: \(reason)"
        case .unavailable(let reason): notice = application + " The pane was not selected: \(reason)"
        }
    }

    func closeActive() async {
        guard allowAction("closing this document"), let document = active else { return }
        guard await document.session.persist() else { notice = "The draft was not retained. Keep this document open and retry recovery."; return }
        documents.removeAll { $0.id == document.id }; selected = documents.last?.id
        liveDocumentID = active?.id ?? UUID(); collaboration?.bind(document: liveDocumentID, closing: document.id)
        active?.setVisible(true)
        await document.close()
        if documents.isEmpty { await library() }
    }

    func prepareToClose(saveDeadline: DispatchTime = .now() + PaneHost.saveAllowance) async -> Bool {
        guard !closing else { return false }
        guard !documents.contains(where: \.stagingImages) else {
            notice = "Wait for the image to reach private storage before closing."
            return false
        }
        guard documents.allSatisfy({ !$0.text.hasMarkedText }) else {
            notice = "Finish composing text before closing the workspace."
            return false
        }
        closing = true

        guard await retainAll(), closing, !Task.isCancelled else {
            if closing { refuseClose("Draft recovery failed. This window remains open. Retry Close after recovery succeeds.") }
            return false
        }
        let dirty = documents.filter(needsAutomaticSave)
        guard !dirty.isEmpty else { return true }
        let saved = Flag(), proceed = Flag(true)
        let finished = await PaneHost.run(until: saveDeadline) {
            for document in dirty {
                guard proceed.value, self.closing, DispatchTime.now() < saveDeadline else { return }
                if document.session.saving { await document.persistenceTask?.value }
                guard proceed.value, self.closing, DispatchTime.now() < saveDeadline else { return }
                if self.needsAutomaticSave(document), !document.session.saving,
                   document.session.record.conflict == nil {
                    await self.saveDestination(document, duringClose: true)
                }
            }
            guard proceed.value, self.closing else { return }
            saved.value = await self.retainAll() && !self.documents.contains(where: self.needsAutomaticSave)
        }
        proceed.value = false
        guard finished, saved.value else {
            refuseClose("The destination save did not finish. Your edits are in Drafts. This window remains open.")
            return false
        }
        return true
    }

    private func refuseClose(_ message: String) {
        notice = message
        resumeEdits()
        if let model = webHostModel {
            Task { _ = try? await model.sendEnvelope(["v": 1, "type": "notice", "tone": "warning", "text": message, "actions": []]) }
        }
    }

    func resumeEdits() {
        closing = false

    }

    func retainAll() async -> Bool {
        var result = true
        for document in documents { if !(await document.session.persist()) { result = false } }
        return result && documents.allSatisfy { $0.session.recovery == .current }
    }

    func openFile() {
        guard allowAction("opening a file") else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md"), UTType(filenameExtension: "markdown"), .plainText].compactMap { $0 }
        panel.allowsMultipleSelection = false
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in
                do {
                    let opened = try await Task.detached { try LocalFileSave.open(url) }.value
                    self?.add(DraftRecord(title: url.lastPathComponent, source: opened.source, destination: .file(opened.base), savedSource: opened.source))
                } catch { self?.notice = "File not opened: \(error)" }
            }
        }
    }

    func saveAs() {
        guard allowAction("saving"), let document = active else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md")].compactMap { $0 }
        panel.nameFieldStringValue = document.session.record.displayTitle + ".md"
        panel.begin { [weak self, weak document] response in
            guard response == .OK, let url = panel.url, let document, let self else { return }
            do {
                let existing = FileManager.default.fileExists(atPath: url.path) ? try LocalFileSave.open(url).base : nil
                Task { await self.saveFile(document, to: url, replacing: existing) }
            } catch { document.session.setError("The chosen destination changed: \(error)") }
        }
    }

    func saveDestination(_ document: WorkingDocument, duringClose: Bool = false) async {
        if document.session.record.pendingPublication == nil, case .file = document.session.record.destination {
            await saveFile(document, duringClose: duringClose)
        } else {
            await savePublished(document, duringClose: duringClose)
        }
    }

    func saveFile(_ document: WorkingDocument, to url: URL? = nil, replacing existing: FileEditBase? = nil, duringClose: Bool = false) async {
        guard duringClose ? closing : allowAction("saving", document: document) else { return }
        guard let snapshot = document.session.beginSave() else { return }
        do {
            let (base, images) = try await Task.detached {
                let resolver = try DraftAssets.resolver(for: snapshot)
                if let url {
                    guard existing == nil || existing?.requestedPath == url.standardizedFileURL.path else { throw FileSaveError.changed }
                    let images = try FileAssetTransfer.copy(source: snapshot.source, resolver: resolver, beside: url)
                    let saved = try existing.map { try LocalFileSave.save(source: snapshot.source, base: $0) }
                        ?? LocalFileSave.saveAs(source: snapshot.source, url: url)
                    return (saved, images)
                }
                guard case .file(let base) = snapshot.destination else { throw FileSaveError.invalid("Choose a file destination.") }
                let images = try FileAssetTransfer.copy(source: snapshot.source, resolver: resolver, beside: URL(fileURLWithPath: base.path))
                return (try LocalFileSave.save(source: snapshot.source, base: base), images)
            }.value
            document.session.finishSave(source: snapshot.source, destination: .file(base))
            if images.unavailable > 0 || images.external > 0 {
                document.session.setError("The file was saved. \(images.unavailable) image references remain unavailable; \(images.external) external image references remain external.")
            }
            document.setResolver(DirectoryAssetResolver(directory: URL(fileURLWithPath: base.path).deletingLastPathComponent()))
            document.observeBase()
        } catch {
            if case FileSaveError.changed = error { document.session.setConflict(.init(message: String(describing: error))) }
            document.session.failSave(String(describing: error))
        }
        if automaticallySaves, document.session.record.conflict != nil { await receiveExternalChange(document) }
    }

    func save() {
        guard allowAction("saving"), let document = active else { return }
        if case .file = document.session.record.destination { Task { await saveFile(document) }; return }
        Task { await savePublished(document) }
    }

    func savePublished(_ document: WorkingDocument, duringClose: Bool = false) async {
        guard duringClose ? closing : allowAction("saving", document: document) else { return }
        guard let writer = PublicationClient.fromBundle() else { document.session.setError("The bundled library writer is unavailable. Rebuild the app or use Save As."); return }
        do {
            var request: PublicationRequest
            if document.session.record.pendingPublication != nil {
                guard let pending = document.session.beginReconciliation() else { return }
                request = try JSONDecoder().decode(PublicationRequest.self, from: pending)
                request.operation = "reconcile"
                let checked = try await writer.send(request)
                if checked.status == "saved" { acknowledge(checked, request: request, document: document); return }
                request.operation = "save"
            } else {
                guard let snapshot = document.session.beginSave() else { return }
                let root: String
                let identity: String
                switch snapshot.destination {
                case .published(let base), .copy(let base): root = base.root; identity = base.storeId
                default:
                    guard let selectedStore else { throw FileSaveError.invalid("Select a library store before Save, or use Save As for a file.") }
                    root = selectedStore; identity = try await writer.identity(root: root)
                }
                request = PublicationRequest(record: snapshot, root: root, storeId: identity)
                let assetRoot = try imageRoot(for: snapshot)
                request.stagedAssets = try await Task.detached { try DraftAssets.stageReferenced(in: snapshot, root: assetRoot) }.value
                if request.stagedAssets?.isEmpty == false { request.assetRoot = assetRoot.path }
                let pending = try JSONEncoder().encode(request)
                document.session.setPendingPublication(pending)
                guard await document.session.persistPendingPublication(pending) else { throw FileSaveError.invalid("Recovery failed. The library save did not start.") }
            }
            let outcome = try await writer.send(request)
            if outcome.status == "saved" { acknowledge(outcome, request: request, document: document) }
            else {
                if outcome.outcome == "not-committed" { document.session.setPendingPublication(nil) }
                if outcome.error?.code == "conflict" {
                    document.session.setConflict(.init(message: outcome.error?.message ?? "The stored document changed.", revision: outcome.error?.currentRevision, digest: outcome.error?.currentDigest))
                }
                document.session.failSave(outcome.error?.message ?? "The save is unconfirmed. Retry Save to reconcile this invocation.")
            }
        } catch { document.session.failSave(String(describing: error)) }
        if automaticallySaves, document.session.record.conflict != nil { await receiveExternalChange(document) }
    }

    private func acknowledge(_ outcome: PublicationOutcome, request: PublicationRequest, document: WorkingDocument) {
        guard let id = outcome.document, let revision = outcome.revision, let digest = outcome.digest else { return }
        let base = StoredEditBase(root: request.storeRoot, storeId: request.storeId, document: id, revision: revision, digest: digest)
        document.session.finishSave(source: request.source, destination: .published(base))
        document.observeBase()
        loadResolver(base, document: document)
    }
}
