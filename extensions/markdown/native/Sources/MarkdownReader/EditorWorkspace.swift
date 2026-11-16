import AppKit
import EditorFeature
import MacPlatform
import MarkdownCore
import Observation
import ReaderFeature
import SwiftUI
import UniformTypeIdentifiers

@MainActor @Observable
final class WorkingDocument: Identifiable {
    let id = UUID()
    let session: EditSession
    let text: MarkdownEditorTextController
    var line: Int?
    var column: Int?
    var words: Int?
    var characters: Int?
    init(record: DraftRecord, drafts: DraftStore) {
        session = EditSession(record: record, drafts: drafts)
        text = MarkdownEditorTextController(source: record.source, initialGeneration: record.generation)
        text.select(NSRange(location: record.selection.location, length: record.selection.length))
        text.onChange = { [weak self] snapshot in
            self?.session.receive(source: snapshot.source, generation: snapshot.generation,
                                  selection: .init(location: snapshot.selectedRange.location, length: snapshot.selectedRange.length), markedText: snapshot.hasMarkedText)
            self?.updateAnalysis()
        }
        text.onAnalysis = { [weak self] in self?.updateAnalysis() }
        text.onError = { [weak session] message in session?.setError(message) }
    }

    private func updateAnalysis() {
        line = text.sourcePosition?.line; column = text.sourcePosition?.column
        words = text.counts?.words; characters = text.counts?.characters
    }
}

@MainActor @Observable
final class EditorWorkspace {
    let drafts: DraftStore
    var documents: [WorkingDocument] = []
    var selected: UUID?
    var libraryVisible = false
    var recovered: [DraftRecord] = []
    var recoveryIssues: [String] = []
    var nextDraftOffset: Int?
    var notice: String?
    var closing = false
    var active: WorkingDocument? { documents.first { $0.id == selected } }
    var selectedStore: String?
    @ObservationIgnored var onReadLibrary: (() -> Void)?

    init(directory: URL, store: String?) { drafts = DraftStore(directory: directory); selectedStore = store }

    func add(_ record: DraftRecord) {
        guard !closing else { return }
        let document = WorkingDocument(record: record, drafts: drafts)
        documents.append(document); selected = document.id; libraryVisible = false
        Task { @MainActor in document.text.focus() }
    }

    func newScratchpad() { add(DraftRecord()) }

    func select(_ document: WorkingDocument) {
        selected = document.id; libraryVisible = false
        Task { @MainActor in document.text.focus() }
    }

    func library(more: Bool = false) async {
        do {
            let page = try await drafts.list(offset: more ? (nextDraftOffset ?? 0) : 0)
            recovered = more ? recovered + page.records : page.records
            recoveryIssues = page.issues; nextDraftOffset = page.nextOffset; libraryVisible = true
        } catch { notice = "Drafts unavailable: \(error)" }
    }

    func closeActive() async {
        guard let document = active else { return }
        guard await document.session.persist() else { notice = "The draft was not retained. Keep this document open and retry recovery."; return }
        documents.removeAll { $0.id == document.id }; selected = documents.last?.id
        if documents.isEmpty { await library() }
    }

    func prepareToClose() async -> Bool {
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
        guard !closing else { return }
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
        guard !closing, let document = active else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md")].compactMap { $0 }
        panel.nameFieldStringValue = document.session.record.displayTitle + ".md"
        panel.begin { [weak self, weak document] response in
            guard response == .OK, let url = panel.url, let document, let self else { return }
            Task { await self.saveFile(document, to: url) }
        }
    }

    func saveFile(_ document: WorkingDocument, to url: URL? = nil) async {
        guard let snapshot = document.session.beginSave() else { return }
        do {
            let base = try await Task.detached {
                if let url {
                    if FileManager.default.fileExists(atPath: url.path) {
                        let explicit = try LocalFileSave.open(url)
                        return try LocalFileSave.save(source: snapshot.source, base: explicit.base)
                    }
                    return try LocalFileSave.saveAs(source: snapshot.source, url: url)
                }
                guard case .file(let base) = snapshot.destination else { throw FileSaveError.invalid("Choose a file destination.") }
                return try LocalFileSave.save(source: snapshot.source, base: base)
            }.value
            document.session.finishSave(source: snapshot.source, destination: .file(base))
        } catch {
            if case FileSaveError.changed = error { document.session.setConflict(.init(message: String(describing: error))) }
            document.session.failSave(String(describing: error))
        }
    }

    func save() {
        guard !closing, let document = active else { return }
        if case .file = document.session.record.destination { Task { await saveFile(document) }; return }
        Task { await savePublished(document) }
    }

    func savePublished(_ document: WorkingDocument) async {
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
                document.session.setPendingPublication(try JSONEncoder().encode(request))
                guard await document.session.persist() else { throw FileSaveError.invalid("Recovery failed. The library save did not start.") }
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
                if let read = workspace.onReadLibrary { Button("Library", action: read) }
                Spacer()
                if workspace.active != nil {
                    Button("Save") { workspace.save() }.keyboardShortcut("s")
                    Menu {
                        Button("Save As…") { workspace.saveAs() }
                        Button("Duplicate") { if let record = workspace.active?.session.duplicate() { workspace.add(record) } }
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
            if workspace.libraryVisible { draftLibrary }
            else if let document = workspace.active {
                MarkdownEditorTextSurface(controller: document.text)
                Divider()
                status(document)
            } else {
                ContentUnavailableView("Write Markdown", systemImage: "square.and.pencil", description: Text("Start a scratchpad or open a Markdown file."))
            }
        }.frame(minWidth: 360, minHeight: 300).disabled(workspace.closing)
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
                            if record.parentBranch != nil { Text("Recovered version").font(.caption) }
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
                    Button("Save a Separate Copy") { workspace.add(document.session.duplicate()) }
                }.foregroundStyle(.orange)
            }
            if let error = document.session.error { Text(error).foregroundStyle(.red) }
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
