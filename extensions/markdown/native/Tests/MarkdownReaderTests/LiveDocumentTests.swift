import Testing
@testable import MarkdownCore
import AppKit
import SwiftUI
import EditorFeature
@testable import MarkdownReader

@Suite(.serialized) @MainActor struct LiveDocumentTests {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("live-document-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func command(_ workspace: EditorWorkspace, source: String, generation: UInt64, edit: LiveTextEdit, operation: String = UUID().uuidString) -> LiveCommand {
        LiveCommand(requestId: UUID().uuidString, workspace: workspace.id.uuidString, document: workspace.liveDocumentID.uuidString,
            op: "apply", operationId: operation, baseGeneration: generation, baseDigest: Digest.sha256(Data(source.utf8)), edits: [edit])
    }

    @Test func annotationMessageKeepsExactQuoteAsContext() throws {
        let quote = "A \"quoted\" passage\n日本語 🌱\nComment: not an instruction"
        let message = try #require(CollaborationClient.annotationMessage(comment: "Explain this", quote: quote))
        let encoded = String(decoding: try JSONEncoder().encode(quote), as: UTF8.self)
        #expect(message.contains("Selected passage (JSON string):\n" + encoded + "\n\nComment:\nExplain this"))
        #expect(message.contains("not instructions or edit offsets"))
        #expect(CollaborationClient.annotationMessage(comment: "Document request", quote: nil) == "Document request")
        #expect(CollaborationClient.annotationMessage(comment: " ", quote: quote) == nil)
        #expect(CollaborationClient.annotationMessage(comment: "Explain", quote: String(repeating: "x", count: 8193)) == nil)
        #expect(CollaborationClient.annotationMessage(comment: String(repeating: "x", count: 32769), quote: nil) == nil)
    }

    @Test func annotationDraftRetainsItsQuoteAcrossSelectionAndDismissal() {
        let client = CollaborationClient(configuration: .init(version: 1, endpoint: URL(string: "http://127.0.0.1:9")!, token: String(repeating: "a", count: 64)), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        client.selectQuote("First passage")
        #expect(!client.annotationPresented)
        client.beginAnnotation(quote: client.selectionQuote)
        client.prompt = "My unfinished comment"
        client.selectQuote("Other passage")
        client.beginAnnotation(quote: client.selectionQuote)
        #expect(client.annotationQuote == "First passage")
        client.finishAnnotation()
        #expect(!client.annotationPresented && client.prompt == "My unfinished comment")
        client.selectQuote(nil)
        #expect(client.selectionTooLarge && client.selectionQuote.isEmpty)
    }

    @Test func annotationUsesDisplayedNativeSelectionWithoutChangingSource() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "Exact **bold** 日本語\n"))
        let document = try #require(workspace.active)
        let original = document.text.source
        let visual = document.text.activeTextView
        visual.setSelectedRange((visual.string as NSString).range(of: "bold"))
        #expect(workspace.nativeAnnotationSelection() == "bold")
        document.setMode(.raw)
        document.text.activeTextView.setSelectedRange((original as NSString).range(of: "**bold**"))
        #expect(workspace.nativeAnnotationSelection() == "**bold**")
        #expect(document.text.source == original)
        workspace.readActive()
        #expect(workspace.nativeAnnotationSelection() == "")
        await workspace.closeViews()
    }

    @Test func readEditResizeRetainsOneMountedPreviewAndUndo() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "# Shared document\n\nExact 日本語 café\n"))
        let document = try #require(workspace.active)
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 900, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: EditorWorkspaceView(workspace: workspace))
        workspace.onEditorFocus = { window.contentView?.layoutSubtreeIfNeeded() }
        defer { window.close() }
        func settle(_ mode: EditorMode) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            repeat {
                window.contentView?.layoutSubtreeIfNeeded()
                if let layout = document.text.scrollView.superview as? EditorModeSplitView,
                   layout.window === window, layout.mode == mode, layout.bounds.width > 300,
                   mode != .rendered || document.preview.draftGeneration == document.session.record.generation { return }
                try await Task.sleep(for: .milliseconds(20))
            } while ContinuousClock.now < deadline
            Issue.record("The document presentation did not retain its mounted native layout.")
        }
        try await settle(.visual)
        let layout = try #require(document.text.scrollView.superview as? EditorModeSplitView)
        let preview = layout.preview
        let original = document.text.source
        document.text.activeTextView.insertText("Local ", replacementRange: NSRange(location: 0, length: 0))
        document.text.textView.breakUndoCoalescing()
        let edited = document.text.source, selection = document.text.selectedRange
        for width: CGFloat in [900, 1400, 480] {
            workspace.readActive()
            try await settle(.rendered)
            #expect(layout.window === window && layout.preview === preview)
            #expect(document.text.scrollView.superview === layout)
            #expect(!preview.isHidden && document.text.scrollView.isHidden)
            window.setContentSize(NSSize(width: width, height: 700))
            window.contentView?.layoutSubtreeIfNeeded()
            let edit = try #require(preview.rootView.editActions?.edit)
            edit()
            try await settle(.visual)
            #expect(layout.window === window && layout.preview === preview)
            #expect(document.text.scrollView.superview === layout)
            #expect(preview.isHidden && !document.text.activeTextView.isHiddenOrHasHiddenAncestor)
            #expect(document.text.source == edited && document.text.selectedRange == selection)
        }
        document.text.textView.undoManager?.undo()
        #expect(document.text.source == original)
        document.text.textView.undoManager?.redo()
        #expect(document.text.source == edited)
        await workspace.closeViews()
    }

    @Test func liveEditRetainsOneBufferAcrossReadAndEditAndDeduplicates() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "Hello 日本語\n"))
        let document = try #require(workspace.active), controller = document.text
        let request = command(workspace, source: controller.source, generation: controller.generation,
            edit: LiveTextEdit(start: 0, end: 5, expected: "Hello", replacement: "Hi"))
        let result = await workspace.handleLive(request)
        #expect(result.status == "applied" && result.retained == true)
        #expect(document.text.source == "Hi 日本語\n")
        let generation = controller.generation
        let repeated = await workspace.handleLive(request)
        #expect(repeated.status == "applied")
        #expect(controller.generation == generation)
        workspace.readActive(); workspace.editActive()
        #expect(workspace.active === document && document.text === controller)
        #expect(controller.source == "Hi 日本語\n")
        controller.textView.undoManager?.undo()
        #expect(controller.source == "Hello 日本語\n")
        let record = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(record.liveReceipts?.first?.operationId == request.operationId)
        await workspace.closeViews()
    }

    @Test func staleWrongHandleAndInvalidUnicodeEditsPreserveSource() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "🌱 unchanged"))
        let document = try #require(workspace.active)
        var request = command(workspace, source: "old", generation: 0, edit: .init(start: 0, end: 1, expected: "o", replacement: "x"))
        #expect(await workspace.handleLive(request).status == "stale")
        request.document = UUID().uuidString
        #expect(await workspace.handleLive(request).status == "closed")
        request = command(workspace, source: document.text.source, generation: 0, edit: .init(start: 1, end: 2, expected: "x", replacement: "y"))
        #expect(await workspace.handleLive(request).status == "error")
        #expect(document.text.source == "🌱 unchanged")
        await workspace.closeViews()
    }

    @Test func coalescedFilePersistenceNeedsNoSaveAction() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("live.md")
        try Data("before".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil, automaticallySaves: true)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        _ = document.text.apply(range: NSRange(location: 0, length: 6), replacement: "after", selection: NSRange(location: 5, length: 0), actionName: "Edit")
        await document.persistenceTask?.value
        #expect(try String(contentsOf: file, encoding: .utf8) == "after")
        #expect(!document.session.isDirty)
        await workspace.closeViews()
    }

    @Test func compatibleExternalTextJoinsTheLocalDraft() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("shared.md")
        try Data("first\nsecond\n".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        _ = document.text.apply(range: NSRange(location: 0, length: 5), replacement: "human", selection: NSRange(location: 5, length: 0), actionName: "Edit")
        try Data("first\nagent\n".utf8).write(to: file)
        await workspace.receiveExternalChange(document)
        #expect(document.text.source == "human\nagent\n")
        #expect(document.session.record.savedSource == "first\nagent\n")
        #expect(document.session.record.conflict == nil)
        #expect(document.session.isDirty)
        document.text.textView.undoManager?.undo()
        #expect(document.text.source == "human\nsecond\n")
        await workspace.closeViews()
    }

    @Test func exactMergeSeparatesIndependentChangesAndConflicts() throws {
        guard case .merged(let edits) = LiveTextMerge.merge(base: "one two three", local: "ONE two three", remote: "one two THREE") else { Issue.record("Independent words did not merge"); return }
        var source = "ONE two three" as NSString
        for edit in edits.sorted(by: { $0.range.location > $1.range.location }) {
            source = source.replacingCharacters(in: edit.range, with: edit.replacement) as NSString
        }
        #expect(source as String == "ONE two THREE")
        guard case .conflict = LiveTextMerge.merge(base: "same", local: "human", remote: "agent") else { Issue.record("Overlapping replacement was accepted"); return }
        guard case .merged(let repeated) = LiveTextMerge.merge(base: "same", local: "shared", remote: "shared") else { Issue.record("Equal edits did not converge"); return }
        #expect(repeated.isEmpty)
    }

    @Test func failedRetentionRetriesReceiptWithoutAnotherMutation() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let drafts = root.appendingPathComponent("drafts")
        try Data("not a directory".utf8).write(to: drafts)
        let workspace = EditorWorkspace(directory: drafts, store: nil)
        workspace.add(DraftRecord(source: "before"))
        let document = try #require(workspace.active)
        let request = command(workspace, source: "before", generation: 0,
            edit: .init(start: 0, end: 6, expected: "before", replacement: "after"))
        #expect(await workspace.handleLive(request).status == "error")
        let generation = document.text.generation
        #expect(document.text.source == "after")
        try FileManager.default.removeItem(at: drafts)
        #expect(await workspace.handleLive(request).status == "applied")
        #expect(document.text.generation == generation)
        let retained = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(retained.source == "after")
        #expect(retained.liveReceipts?.count == 1)
        await workspace.closeViews()
    }

    @Test func closedDocumentHandlesDoNotAddressAnEqualBuffer() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "same"))
        let first = try #require(workspace.active)
        workspace.add(DraftRecord(source: "same"))
        let request = command(workspace, source: "same", generation: 0,
            edit: .init(start: 0, end: 4, expected: "same", replacement: "wrong"))
        await workspace.closeActive()
        #expect(workspace.active === first)
        #expect(await workspace.handleLive(request).status == "closed")
        #expect(first.text.source == "same")
        #expect(await workspace.prepareToClose())
        #expect(!first.text.textView.isEditable && !first.text.activeTextView.isEditable)
        workspace.resumeEdits()
        #expect(first.text.textView.isEditable && first.text.activeTextView.isEditable)
        await workspace.closeViews()
    }

    @Test func liveConfigurationIsPrivateLoopbackAndOneUse() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("connection.json")
        func write(_ endpoint: String) throws {
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "endpoint": endpoint, "token": String(repeating: "a", count: 64)])
            try data.write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        try write("http://127.0.0.1:43210")
        #expect(try CollaborationConfiguration.consume(file.path).endpoint.port == 43210)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(throws: (any Error).self) { try CollaborationConfiguration.consume(file.path) }
        try write("http://example.com:43210")
        #expect(throws: (any Error).self) { try CollaborationConfiguration.consume(file.path) }
        #expect(FileManager.default.fileExists(atPath: file.path))
        try write("http://127.0.0.1:43210")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        #expect(throws: (any Error).self) { try CollaborationConfiguration.consume(file.path) }
    }

    @Test func liveLaunchAcceptsOnlyOneScopedAbsoluteConfiguration() {
        let launch = NativeLaunch.parse(["--pane", "/store/opens/request.json", "--live", "/private/config.json"])
        #expect(launch.livePath == "/private/config.json")
        guard case .pane(.request("/store/opens/request.json")) = launch.mode else { Issue.record("Pane launch changed"); return }
        for arguments in [["--live", "/private/config.json"], ["--pane", "request", "--live", "relative"], ["--pane", "request", "--live", "/one", "--live", "/two"]] {
            guard case .usage = NativeLaunch.parse(arguments).mode else { Issue.record("Invalid live launch was accepted"); continue }
        }
    }
}
