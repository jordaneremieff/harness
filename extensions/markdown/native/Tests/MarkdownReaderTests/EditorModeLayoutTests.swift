import AppKit
import SwiftUI
import EditorFeature
import Testing
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct MountedEditorModes {
    @Test func mountedModeCycleKeepsOneVisibleNativeSourceAndUndo() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mounted-editor-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1000, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: EditorWorkspaceView(workspace: workspace))
        window.orderFrontRegardless()
        defer { window.close() }
        try await settled(document, window: window)
        let owner = try #require(document.text.scrollView.superview)
        let text = document.text.textView
        window.makeFirstResponder(text)
        text.insertText("# Exact\n日本語 café 👨‍👩‍👧‍👦\n", replacementRange: NSRange(location: 0, length: 0))
        text.breakUndoCoalescing()
        let source = document.text.source, selection = document.text.selectedRange
        for mode in [EditorMode.raw, .rendered, .split, .styled, .split, .raw, .rendered, .styled] {
            document.setMode(mode)
            try await settled(document, window: window)
            #expect(document.text.scrollView.superview === owner)
            #expect(text.window === window)
            #expect(document.text.source == source)
            #expect(document.text.selectedRange == selection)
            if mode != .rendered {
                #expect(!text.isHiddenOrHasHiddenAncestor)
                #expect(document.text.scrollView.frame.width > 180)
                #expect(document.text.scrollView.frame.height > 100)
                #expect(text.visibleRect.width > 100)
                #expect(text.visibleRect.height > 0)
            } else {
                #expect(text.isHiddenOrHasHiddenAncestor)
                #expect(window.firstResponder !== text)
            }
        }
        text.undoManager?.undo()
        #expect(document.text.source.isEmpty)
        text.undoManager?.redo()
        #expect(document.text.source == source)
        workspace.newScratchpad()
        let second = try #require(workspace.active)
        try await settled(second, window: window)
        #expect(second.text.source.isEmpty)
        #expect(second.text.textView.window === window)
        workspace.select(document)
        try await settled(document, window: window)
        #expect(document.text.source == source)
        #expect(text.window === window)
        #expect(!text.isHiddenOrHasHiddenAncestor)
        #expect(await workspace.retainAll())
        await workspace.closeViews()
    }

    private func settled(_ document: WorkingDocument, window: NSWindow) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
            if let layout = document.text.scrollView.superview as? EditorModeSplitView,
               layout.mode == document.mode, layout.bounds.width > 300, layout.bounds.height > 100 {
                #expect(document.text.scrollView.isHidden == (document.mode == .rendered))
                return
            }
        } while ContinuousClock.now < deadline
        Issue.record("The mounted native mode layout did not settle.")
    }
}
