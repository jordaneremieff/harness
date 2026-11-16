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
        window.makeFirstResponder(document.text.activeTextView)
        document.text.activeTextView.insertText("# Exact\n日本語 café 👨‍👩‍👧‍👦\n", replacementRange: NSRange(location: 0, length: 0))
        text.breakUndoCoalescing()
        let source = document.text.source, selection = document.text.selectedRange
        for mode in [EditorMode.raw, .visual, .rendered, .split, .styled, .visual, .split, .raw, .rendered, .styled] {
            document.setMode(mode)
            try await settled(document, window: window)
            #expect(document.text.scrollView.superview === owner)
            let active = document.text.activeTextView
            #expect(active.window === window)
            #expect(document.text.source == source)
            #expect(document.text.selectedRange == selection)
            if mode != .rendered {
                #expect(!active.isHiddenOrHasHiddenAncestor)
                #expect(document.text.scrollView.frame.width > 180)
                #expect(document.text.scrollView.frame.height > 100)
                #expect(active.visibleRect.width > 100)
                #expect(active.visibleRect.height > 0)
                #expect(window.firstResponder === active)
                (window.firstResponder as? NSTextView)?.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
                text.breakUndoCoalescing()
                #expect(document.text.source == source + "x")
                text.undoManager?.undo()
                #expect(document.text.source == source)
            } else {
                #expect(active.isHiddenOrHasHiddenAncestor)
                #expect(window.firstResponder !== active)
            }
        }
        document.setMode(.split)
        window.setContentSize(NSSize(width: 480, height: 700))
        try await settled(document, window: window)
        let layout = try #require(owner as? EditorModeSplitView)
        #expect(!layout.showsSplit)
        #expect(!document.showsPreview)
        #expect(layout.preview.isHidden)
        #expect(layout.source.frame.width == layout.bounds.width)
        #expect(document.text.scrollView.superview === owner)
        #expect(document.text.selectedRange == selection)
        document.setMode(.rendered)
        try await settled(document, window: window)
        #expect(!layout.preview.isHidden)
        #expect(layout.preview.frame.width == layout.bounds.width)
        document.setMode(.split)
        window.setContentSize(NSSize(width: 1000, height: 700))
        try await settled(document, window: window)
        #expect(layout.showsSplit)
        #expect(document.showsPreview)
        #expect(!layout.preview.isHidden)
        #expect(layout.source.frame.width < layout.bounds.width)
        #expect(document.text.scrollView.superview === owner)
        #expect(document.text.source == source)
        #expect(document.text.selectedRange == selection)
        #expect(window.firstResponder === text)
        text.undoManager?.undo()
        #expect(document.text.source.isEmpty)
        text.undoManager?.redo()
        #expect(document.text.source == source)
        workspace.newScratchpad()
        let second = try #require(workspace.active)
        try await settled(second, window: window)
        #expect(second.text.source.isEmpty)
        #expect(second.text.activeTextView.window === window)
        #expect(window.firstResponder === second.text.activeTextView)
        (window.firstResponder as? NSTextView)?.insertText("Second", replacementRange: NSRange(location: 0, length: 0))
        #expect(second.text.source == "Second")
        workspace.select(document)
        try await settled(document, window: window)
        #expect(document.text.source == source)
        #expect(text.window === window)
        #expect(!text.isHiddenOrHasHiddenAncestor)
        #expect(window.firstResponder === text)
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
