import AppKit
import EditorFeature
import MacPlatform
import MarkdownCore
import Observation
import ReaderFeature
import SwiftUI
import UniformTypeIdentifiers

enum EditorMode: String, CaseIterable { case styled = "Styled", raw = "Raw", rendered = "Rendered", split = "Split" }

@MainActor @Observable
final class WorkingDocument: Identifiable {
    let id = UUID()
    let session: EditSession
    let text: MarkdownEditorTextController
    let preview: ReaderModel
    let updates = UpdateObserver()
    @ObservationIgnored private var checkTask: Task<Void, Never>?
    @ObservationIgnored private var checkRequested = false
    @ObservationIgnored private(set) var closed = false
    var mode: EditorMode = .styled
    var presentation = MarkdownEditorPresentation()
    var visible = false
    var pendingMode: EditorMode?
    var replacing = false
    var stagingImages = false
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
    @ObservationIgnored private var composing = false
    private(set) var splitAvailable = true
    var showsPreview: Bool { mode == .rendered || (mode == .split && splitAvailable) }
    var line: Int?
    var column: Int?
    var words: Int?
    var characters: Int?
    init(record: DraftRecord, drafts: DraftStore) {
        session = EditSession(record: record, drafts: drafts)
        text = MarkdownEditorTextController(source: record.source, initialGeneration: record.generation)
        preview = ReaderModel(reference: .file(path: "draft:" + record.id.uuidString), platform: MacPlatform.operations(), state: ReadingStateStore(directory: nil))
        preview.outlineVisible = false
        if case .file(let base) = record.destination { baseResolver = DirectoryAssetResolver(directory: URL(fileURLWithPath: base.path).deletingLastPathComponent()) }
        text.select(NSRange(location: record.selection.location, length: record.selection.length))
        text.onChange = { [weak self] snapshot in
            guard let self else { return }
            let changed = snapshot.generation != self.session.record.generation
            let compositionEnded = self.composing && !snapshot.hasMarkedText
            self.composing = snapshot.hasMarkedText
            self.session.receive(source: snapshot.source, generation: snapshot.generation,
                                 selection: .init(location: snapshot.selectedRange.location, length: snapshot.selectedRange.length), markedText: snapshot.hasMarkedText)
            self.updateAnalysis()
            if changed {
                self.preview.invalidateDraftPreview(); self.schedulePreview()
                if self.findVisible { self.refreshFind() }
            }
            if !snapshot.hasMarkedText, let pending = self.pendingMode { self.setMode(pending) }
            if compositionEnded, self.showsPreview { self.schedulePreview() }
        }
        text.onAnalysis = { [weak self] in self?.updateAnalysis() }
        text.onError = { [weak session] message in session?.setError(message) }
        text.onCommand = { [weak self] selector in
            guard let self else { return false }
            switch NSStringFromSelector(selector) {
            case "insertNewline:": return self.text.continueList()
            case "insertBacktab:": return self.perform(.outdent, reportRefusal: false)
            default: return false
            }
        }
        observeBase()
    }

    func setMode(_ next: EditorMode) {
        guard !text.hasMarkedText else { pendingMode = next; return }
        pendingMode = nil; mode = next
        presentation.mode = next == .raw ? .raw : .styled
        text.setPresentation(presentation)
        schedulePreview()
        if next != .rendered { text.focus() }
    }

    func setSplitAvailable(_ value: Bool) {
        guard splitAvailable != value else { return }
        splitAvailable = value
        if mode == .split { schedulePreview() }
    }

    func setVisible(_ value: Bool) {
        visible = value
        if !value { preview.invalidateDraftPreview() }
        schedulePreview()
    }

    func updatePresentation() {
        text.setPresentation(presentation)
        if let index = PageSettings.textSizes.firstIndex(of: Int(presentation.fontSize)) {
            preview.settings = PageSettings(textSize: index, wrapCode: presentation.wrapsLines)
        }
    }

    func setResolver(_ value: any AssetResolving) { baseResolver = value; schedulePreview(force: true) }

    func schedulePreview(force: Bool = false) {
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
        closed = true; checkTask?.cancel(); findTask?.cancel(); updates.stop()
        previewTask?.cancel()
        await preview.close()
    }

    private func updateAnalysis() {
        line = text.sourcePosition?.line; column = text.sourcePosition?.column
        words = text.counts?.words; characters = text.counts?.characters
    }
}

@MainActor @Observable
final class EditorWorkspace {
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
    var revisionReview: EditorRevisionReview?
    var publishedLibrary: LibraryModel?
    private let readingState = ReadingStateStore(directory: nil)
    private var navigationGeneration: UInt64 = 0
    @ObservationIgnored var onClose: (() -> Void)?
    @ObservationIgnored var onRelease: (() -> Void)?
    var active: WorkingDocument? { documents.first { $0.id == selected } }
    var selectedStore: String?

    init(directory: URL, store: String?) {
        drafts = DraftStore(directory: directory); selectedStore = store
        assetDirectory = directory.deletingLastPathComponent().appendingPathComponent("EditorAssets")
    }

    @discardableResult func allowAction(_ action: String, document: WorkingDocument? = nil) -> Bool {
        guard (document ?? active)?.text.hasMarkedText != true else {
            notice = "Finish composing text before \(action)."
            return false
        }
        guard (document ?? active)?.stagingImages != true else { notice = "Wait for the image to reach private storage."; return false }
        guard (document ?? active)?.replacing != true else { notice = "The document replacement is in progress."; return false }
        return !closing
    }

    func add(_ record: DraftRecord) {
        guard allowAction("opening another document") else { return }
        let document = WorkingDocument(record: record, drafts: drafts)
        document.text.onImageFiles = { [weak self, weak document] files in
            guard let self, let document else { return }
            self.stageImages(document, files: files)
        }
        document.text.onImageData = { [weak self, weak document] data, mediaType in
            guard let self, let document else { return }
            let suffix: String
            switch mediaType {
            case "image/png": suffix = "png"
            case "image/tiff": suffix = "tiff"
            default: document.session.setError("This pasted image type is unsupported."); return
            }
            self.stageImages(document, data: data, extension: suffix)
        }
        leaveReading()
        active?.setVisible(false)
        documents.append(document); selected = document.id; libraryVisible = false
        document.setVisible(true)
        if case .published(let base) = record.destination { loadResolver(base, document: document) }
        if case .copy(let base) = record.destination { loadResolver(base, document: document) }
        focusWhenActive(document)
    }

    private func loadResolver(_ base: StoredEditBase, document: WorkingDocument) {
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
            guard let self, let document, self.active === document, !self.libraryVisible, self.reading == nil, self.publishedLibrary == nil else { return }
            document.text.focus()
        }
    }

    func closeViews() async {
        for document in documents { document.setVisible(false); await document.close() }
        await reading?.close()
    }

    func newScratchpad() { add(DraftRecord()) }

    func select(_ document: WorkingDocument) {
        guard allowAction("switching documents") else { return }
        leaveReading()
        active?.setVisible(false)
        selected = document.id; libraryVisible = false
        document.setVisible(true)
        focusWhenActive(document)
    }

    func library(more: Bool = false) async {
        guard allowAction("opening drafts") else { return }
        let navigation = navigationGeneration
        do {
            let page = try await drafts.list(offset: more ? (nextDraftOffset ?? 0) : 0)
            guard navigation == navigationGeneration, allowAction("opening drafts") else { return }
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
        if let previous { Task { await previous.close() } }
    }

    func showPublishedLibrary() async {
        guard allowAction("opening the library") else { return }
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

    func readStored(_ document: String) async {
        guard let root = selectedStore else { notice = "Choose a library store first."; return }
        do {
            let identity = try await Task.detached { try DirectoryStore(root: URL(fileURLWithPath: root)).storeId }.value
            await openReading(.stored(root: root, storeId: identity, document: document))
        } catch { notice = "Document not opened: \(error)" }
    }

    func openReading(_ reference: DocumentReference) async {
        guard allowAction("opening another document") else { return }
        navigationGeneration &+= 1
        let previous = reading
        let next = ReaderModel(reference: reference, platform: MacPlatform.operations(), state: readingState)
        publishedLibrary = nil; libraryVisible = false; active?.setVisible(false); reading = next
        await next.open(origin: launchOrigin)
        guard reading === next else { await next.close(); return }
        if case .failed(let error) = next.phase {
            reading = previous; notice = "Document not opened: \(error)"
            if previous == nil { active?.setVisible(true) }
            await next.close()
        } else { await previous?.close() }
    }

    func editReading(copy: Bool) {
        guard allowAction("opening an edit") else { return }
        guard let model = reading, let snapshot = model.snapshot else { return }
        if case .stored(let root, let storeId, let id) = model.reference, let revision = snapshot.revision {
            guard copy || snapshot.document?.kind == .published else { notice = "This capture is read-only. Choose Edit Copy."; return }
            let base = StoredEditBase(root: root, storeId: storeId, document: id, revision: revision, digest: snapshot.digest)
            add(DraftRecord(title: snapshot.title, source: snapshot.source, destination: copy ? .copy(base) : .published(base), savedSource: copy ? nil : snapshot.source))
        } else if case .file(let path) = model.reference {
            Task {
                do {
                    let file = try await Task.detached { try LocalFileSave.open(URL(fileURLWithPath: path)) }.value
                    add(DraftRecord(title: snapshot.title, source: file.source, destination: copy ? .scratchpad : .file(file.base), savedSource: copy ? nil : file.source))
                } catch { notice = "File not opened for editing: \(error)" }
            }
        }
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
        active?.setVisible(true)
        await document.close()
        if documents.isEmpty { await library() }
    }

    func prepareToClose() async -> Bool {
        guard !documents.contains(where: \.stagingImages) else {
            notice = "Wait for the image to reach private storage before closing."
            return false
        }
        guard !documents.contains(where: \.replacing) else {
            notice = "Wait for the document replacement before closing the workspace."
            return false
        }
        guard documents.allSatisfy({ !$0.text.hasMarkedText }) else {
            notice = "Finish composing text before closing the workspace."
            return false
        }
        closing = true
        for document in documents { document.text.textView.isEditable = false }
        let retained = await retainAll()
        if !retained { resumeEdits() }
        return retained
    }

    func resumeEdits() {
        closing = false
        for document in documents { document.text.textView.isEditable = true }
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

    func saveFile(_ document: WorkingDocument, to url: URL? = nil, replacing existing: FileEditBase? = nil) async {
        guard allowAction("saving", document: document) else { return }
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
    }

    func save() {
        guard allowAction("saving"), let document = active else { return }
        if case .file = document.session.record.destination { Task { await saveFile(document) }; return }
        Task { await savePublished(document) }
    }

    func savePublished(_ document: WorkingDocument) async {
        guard allowAction("saving", document: document) else { return }
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
    }

    private func acknowledge(_ outcome: PublicationOutcome, request: PublicationRequest, document: WorkingDocument) {
        guard let id = outcome.document, let revision = outcome.revision, let digest = outcome.digest else { return }
        let base = StoredEditBase(root: request.storeRoot, storeId: request.storeId, document: id, revision: revision, digest: digest)
        document.session.finishSave(source: request.source, destination: .published(base))
        document.observeBase()
        loadResolver(base, document: document)
    }
}

struct EditorWorkspaceView: View {
    @Bindable var workspace: EditorWorkspace
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("New", systemImage: "square.and.pencil") { workspace.newScratchpad() }.help("New Scratchpad")
                Button("Open", systemImage: "folder") { workspace.openFile() }.help("Open Markdown File for Editing")
                Button("Drafts", systemImage: "tray.full") { Task { await workspace.library() } }
                Button("Library") { Task { await workspace.showPublishedLibrary() } }
                Spacer()
                if workspace.launchOrigin != nil {
                    Button("Return to Rex") { Task { await workspace.returnToTerminal() } }
                }
                if let close = workspace.onClose { Button("Close Workspace", systemImage: "xmark", action: close).labelStyle(.iconOnly) }
                if let reading = workspace.reading {
                    if reading.snapshot?.document?.kind == .published { Button("Edit") { workspace.editReading(copy: false) } }
                    Button("Edit Copy") { workspace.editReading(copy: true) }.disabled(reading.snapshot == nil)
                } else if workspace.active != nil, workspace.publishedLibrary == nil {
                    Button("Save") { workspace.save() }.keyboardShortcut("s")
                    Menu {
                        Button("Save As…") { workspace.saveAs() }
                        Button("Duplicate") { if let document = workspace.active { Task { await workspace.duplicate(document) } } }
                        Button("Insert Image…") { workspace.chooseImage() }
                        Button("Review / Revert to Saved Version…") {
                            if let document = workspace.active { Task { await workspace.reviewSavedVersion(document) } }
                        }
                        Button("Close Document") { Task { await workspace.closeActive() } }
                    } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).fixedSize()
                }
            }.padding(10)
            if !workspace.documents.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 5) {
                        ForEach(workspace.documents) { document in
                            Button {
                                workspace.select(document)
                            } label: {
                                Text((document.session.isDirty ? "● " : "") + document.session.record.displayTitle).lineLimit(1)
                            }.buttonStyle(.bordered).tint(workspace.selected == document.id ? .accentColor : .secondary)
                        }
                    }.padding(.horizontal, 10)
                }.padding(.bottom, 8)
            }
            Divider()
            if let notice = workspace.notice { Text(notice).font(.callout).foregroundStyle(.orange).padding(8) }
            if let library = workspace.publishedLibrary {
                LibraryView(model: library, open: { reference in Task { await workspace.openReading(reference) } }, openFile: { workspace.openFile() }, openStore: { workspace.chooseStore() })
            } else if let reading = workspace.reading {
                ReaderView(model: reading, chrome: .embedded(close: { Task { await workspace.showPublishedLibrary() } }, release: { workspace.onRelease?() }))
            } else if workspace.libraryVisible { draftLibrary }
            else if let document = workspace.active {
                if let pending = document.session.record.pendingImageReferences, !pending.isEmpty {
                    Button("Insert \(pending.count) Retained Images") { Task { await workspace.insertImages(document) } }.padding(6)
                }
                DocumentEditorView(document: document)
                Divider()
                status(document)
            } else {
                ContentUnavailableView("Write Markdown", systemImage: "square.and.pencil", description: Text("Start a scratchpad or open a Markdown file."))
            }
        }.frame(minWidth: 360, minHeight: 300).disabled(workspace.closing)
            .sheet(item: $workspace.revisionReview) { review in EditorRevisionReviewView(review: review, workspace: workspace) }
    }

    private var draftLibrary: some View {
        List {
            Section("Private recoverable drafts") {
                Text("Draft recovery is private. Save commits to the library; Save As writes a chosen file.").font(.callout).foregroundStyle(.secondary)
                ForEach(workspace.recovered, id: \.branch) { record in
                    Button { workspace.add(record.resumed()) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(record.displayTitle).font(.headline)
                            Text(record.source.isEmpty ? "Empty scratchpad" : String(record.source.prefix(120))).lineLimit(2).foregroundStyle(.secondary)
                            Text(record.updatedAt, style: .relative).font(.caption)
                            if let parent = record.parentBranch {
                                Text("Recovered version \(record.branch.uuidString.prefix(8)) from \(parent.uuidString.prefix(8))").font(.caption)
                            }
                        }
                    }.buttonStyle(.plain)
                }
                ForEach(workspace.recoveryIssues, id: \.self) { Text($0).foregroundStyle(.orange) }
                if workspace.nextDraftOffset != nil { Button("Read More Drafts") { Task { await workspace.library(more: true) } } }
            }
        }
    }

    private func status(_ document: WorkingDocument) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let conflict = document.session.record.conflict {
                HStack {
                    Label(conflict.message, systemImage: "exclamationmark.triangle")
                    Button("Review Saved Version") { Task { await workspace.reviewSavedVersion(document) } }
                    Button("Create a Separate Copy") { Task { await workspace.duplicate(document) } }
                }.foregroundStyle(.orange)
            }
            if let error = document.session.error, error != document.session.record.conflict?.message {
                Text(error).foregroundStyle(.red)
            }
            if case .failed(let reason) = document.updates.state {
                HStack {
                    Text("External updates are not observed: \(reason)").foregroundStyle(.orange)
                    Button("Check Again") { document.observeBase() }
                }
            }
            HStack {
                Text(document.session.saving ? "Save in progress" : document.session.isDirty ? "Uncommitted draft" : "Saved")
                Text("·")
                switch document.session.recovery {
                case .current: Text("Recovery current")
                case .pending: Text("Recovery pending")
                case .failed(let reason): Button("Recovery failed: \(reason). Retry") { Task { await document.session.persist() } }
                }
                Spacer()
                if let line = document.line, let column = document.column { Text("Line \(line), column \(column)") }
                if let words = document.words, let characters = document.characters { Text("\(words) words · \(characters) characters") }
            }.font(.caption).foregroundStyle(.secondary)
        }.padding(8)
    }
}
