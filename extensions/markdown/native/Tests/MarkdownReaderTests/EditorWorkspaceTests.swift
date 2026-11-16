import Testing
import AppKit
import EditorFeature
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct EditorWorkspaceLifecycle {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editor-workspace-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    @Test func nativeInputUndoAndRecoveryKeepOneBuffer() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 700, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = document.text.scrollView
        window.makeFirstResponder(document.text.textView)
        defer { window.close() }
        let view = document.text.textView
        #expect(view.textLayoutManager != nil)
        view.insertText("# Scratchpad\n\nNative 日本語 👨‍👩‍👧‍👦", replacementRange: NSRange(location: 0, length: 0))
        view.breakUndoCoalescing()
        let typed = document.text.source
        #expect(document.session.record.source == typed)
        view.undoManager?.undo()
        #expect(document.text.source.isEmpty)
        #expect(document.session.record.source.isEmpty)
        view.undoManager?.redo()
        #expect(document.text.source == typed)
        #expect(await workspace.retainAll())
        let saved = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(saved.source == typed)
        await workspace.closeActive()
        #expect(workspace.documents.isEmpty)
        workspace.add(saved.resumed())
        #expect(workspace.active?.text.source == typed)
        #expect(workspace.active?.session.record.branch != saved.branch)
        #expect(await workspace.prepareToClose())
        #expect(workspace.active?.text.textView.isEditable == false)
        workspace.resumeEdits()
        #expect(workspace.active?.text.textView.isEditable == true)
    }

    @Test func failedRecoveryKeepsTheEditableDocumentOpen() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let blocked = root.appendingPathComponent("not-a-directory")
        try Data("occupied".utf8).write(to: blocked)
        let workspace = EditorWorkspace(directory: blocked, store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        document.text.textView.insertText("Retain this draft", replacementRange: NSRange(location: 0, length: 0))
        #expect(!(await workspace.prepareToClose()))
        #expect(document.text.textView.isEditable)
        #expect(!workspace.closing)
        await workspace.closeActive()
        #expect(workspace.active === document)
        #expect(document.session.record.source == "Retain this draft")
        #expect(workspace.notice != nil)
    }
}
