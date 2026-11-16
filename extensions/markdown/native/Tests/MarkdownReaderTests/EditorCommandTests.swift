import AppKit
import EditorFeature
import Testing
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct NativeEditorCommands {
    private func workspace(_ source: String) throws -> (EditorWorkspace, NSWindow, URL) {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editor-command-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: source))
        let document = workspace.active!
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 800, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = document.text.scrollView
        window.makeFirstResponder(document.text.textView)
        return (workspace, window, root)
    }

    private func analysed(_ document: WorkingDocument) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while document.text.protectedRanges == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(document.text.protectedRanges != nil)
    }

    @Test func formattingUsesOneNativeUndoAndProtectsCode() async throws {
        let (workspace, window, root) = try workspace("hello café\n`code`\n")
        defer { window.close(); try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        try await analysed(document)
        document.text.select(NSRange(location: 6, length: 4))
        #expect(document.perform(.bold))
        #expect(document.text.source == "hello **café**\n`code`\n")
        document.text.textView.undoManager?.undo()
        #expect(document.text.source == "hello café\n`code`\n")
        try await analysed(document)
        document.text.select(NSRange(location: 12, length: 4))
        #expect(!document.perform(.heading(2)))
        #expect(document.text.source == "hello café\n`code`\n")
        document.text.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(!document.perform(.bold))
        #expect(document.text.hasMarkedText)
        document.text.textView.unmarkText()
        await workspace.closeViews()
    }

    @Test func findWrapsAndSelectionReplaceDoesNotBroadenAfterTyping() async throws {
        let (workspace, window, root) = try workspace("Cat cat scatter\ncat")
        defer { window.close(); try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        document.findText = "cat"; document.findWholeWord = true
        document.text.select(NSRange(location: 0, length: 0))
        document.find()
        #expect(document.text.selectedRange == NSRange(location: 0, length: 3))
        document.find()
        #expect(document.text.selectedRange == NSRange(location: 4, length: 3))
        document.find()
        #expect(document.text.selectedRange == NSRange(location: 16, length: 3))
        document.find()
        #expect(document.text.selectedRange == NSRange(location: 0, length: 3))
        document.text.select(NSRange(location: 0, length: 7))
        document.findInSelection = true; document.captureFindSelection()
        document.replacementText = "dog"
        document.replace(all: true)
        #expect(document.text.source == "dog dog scatter\ncat")
        document.text.textView.undoManager?.undo()
        #expect(document.text.source == "Cat cat scatter\ncat")
        #expect(document.literalQuery == nil)
        document.replace(all: true)
        #expect(document.text.source == "Cat cat scatter\ncat")
        document.findInSelection = false
        document.goToLineText = "2"; document.goToLine()
        #expect(document.text.selectedRange.location == 16)
        await workspace.closeViews()
    }
}
