import Testing
import AppKit
import SwiftUI
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

    @Test func presentationModesKeepNativeSourceSelectionAndComposition() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        let source = "# Exact\r\n\r\n日本語 **strong** and `code`.\n"
        workspace.add(DraftRecord(source: source))
        let document = try #require(workspace.active)
        let view = document.text.textView
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1000, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: EditorWorkspaceView(workspace: workspace))
        window.orderFrontRegardless()
        defer { window.close() }
        document.text.select(NSRange(location: 2, length: 3))
        let selection = document.text.selectedRange
        for mode in [EditorMode.raw, .styled, .split, .rendered, .styled] {
            document.setMode(mode)
            #expect(document.text.source == source)
            #expect(document.text.generation == 0)
            #expect(document.text.selectedRange == selection)
            #expect(document.text.textView === view)
            #expect(view.textLayoutManager != nil)
        }
        document.text.select(NSRange(location: (source as NSString).length, length: 0))
        view.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(view.hasMarkedText())
        document.setMode(.rendered)
        #expect(document.mode == .styled)
        #expect(document.pendingMode == .rendered)
        view.unmarkText()
        #expect(document.mode == .rendered)
        #expect(document.pendingMode == nil)
        #expect(document.text.source == source + "にほん")
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while document.preview.draftGeneration != document.text.generation, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(document.preview.snapshot?.source == document.text.source)
        #expect(document.preview.snapshot?.revision == nil)
        #expect(document.preview.draftGeneration == document.text.generation)
        await document.close()
    }

    @Test func compositionRefusesWorkspaceTransitionsAndSaves() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let previous = try #require(workspace.active)
        workspace.newScratchpad()
        let active = try #require(workspace.active)
        active.text.textView.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        workspace.select(previous)
        #expect(workspace.active === active)
        workspace.newScratchpad()
        #expect(workspace.documents.count == 2)
        await workspace.library()
        #expect(!workspace.libraryVisible)
        await workspace.showPublishedLibrary()
        #expect(workspace.publishedLibrary == nil)
        await workspace.openReading(.file(path: root.appendingPathComponent("missing.md").path))
        #expect(workspace.reading == nil)
        let target = root.appendingPathComponent("not-saved.md")
        await workspace.saveFile(active, to: target)
        #expect(!FileManager.default.fileExists(atPath: target.path))
        await workspace.savePublished(active)
        #expect(active.session.record.pendingPublication == nil)
        #expect(!(await workspace.prepareToClose()))
        #expect(active.text.textView.hasMarkedText())
        #expect(active.text.textView.isEditable)
        #expect(workspace.notice?.contains("composing") == true)
        active.text.textView.unmarkText()
        #expect(await workspace.prepareToClose())
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
