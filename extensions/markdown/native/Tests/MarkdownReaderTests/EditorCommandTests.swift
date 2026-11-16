import Testing
import AppKit
import EditorFeature
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct NativeEditorCommands {
    private func workspace(_ source: String) throws -> (EditorWorkspace, NSWindow, URL) {
        _ = NSApplication.shared
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? FileManager.default.temporaryDirectory.path).appendingPathComponent("editor-command-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: source))
        let document = workspace.active!
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 800, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = document.text.scrollView
        window.makeFirstResponder(document.text.textView)
        return (workspace, window, root)
    }

    @Test(arguments: [EditorMode.visual, .raw])
    func formatMenuUsesOnlyTheVisibleNativeEditor(_ mode: EditorMode) async throws {
        let (workspace, window, root) = try workspace("hello")
        defer { window.close(); try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        document.setMode(mode)
        let menu = EditorMenuTarget(workspace: workspace, reader: document.preview)
        try #require(window.makeFirstResponder(document.text.activeTextView))
        document.text.select(NSRange(location: 0, length: 5))
        try await analysed(document)
        #expect(menu.canFormat)
        menu.format(.bold)
        #expect(document.text.source == "**hello**")
        let comment = NSTextField(string: "comment")
        window.contentView?.addSubview(comment)
        try #require(window.makeFirstResponder(comment))
        #expect(window.firstResponder !== document.text.activeTextView)
        #expect(!menu.canFormat)
        menu.format(.bold)
        #expect(document.text.source == "**hello**")
        #expect(comment.stringValue == "comment")
        let find = NSTextField(string: "Find")
        window.contentView?.addSubview(find)
        try #require(window.makeFirstResponder(find))
        #expect(window.firstResponder !== document.text.activeTextView)
        #expect(!menu.canFormat)
        menu.format(.bold)
        #expect(document.text.source == "**hello**")
        await workspace.closeViews()
    }

    @Test func findMenuFollowsReadAndEditTransitions() async throws {
        let (workspace, window, root) = try workspace("hello")
        defer { window.close(); try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        let menu = EditorMenuTarget(workspace: workspace, reader: document.preview)
        menu.showFind()
        #expect(document.findVisible)
        #expect(!document.preview.findVisible)
        document.findVisible = false
        workspace.readActive()
        #expect(document.readingDraft)
        menu.showFind()
        #expect(document.preview.findVisible)
        #expect(!document.findVisible)
        document.preview.findVisible = false
        menu.find()
        #expect(document.preview.findVisible)
        #expect(!document.findVisible)
        workspace.editActive()
        document.preview.findVisible = false
        menu.showFind()
        #expect(document.findVisible)
        #expect(!document.preview.findVisible)
        document.findVisible = false
        menu.find()
        #expect(document.findVisible)
        #expect(!document.preview.findVisible)
        await workspace.closeViews()
    }

    @Test func suspendedSearchAndReplacementRejectChangedInputs() async throws {
        let original = String(repeating: "a", count: 1_000_000) + " a"
        let (workspace, window, root) = try workspace(original)
        defer { window.close(); try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        document.setMode(.raw)
        document.findText = "a"; document.findWholeWord = true
        document.text.select(NSRange(location: 0, length: 0))
        let search = Task { await document.find() }
        try await searching(document)
        #expect(document.text.apply(range: NSRange(location: 0, length: original.utf16.count), replacement: "new", selection: NSRange(location: 0, length: 0), actionName: "Edit"))
        #expect(!(await search.value))
        #expect(document.text.source == "new")
        #expect(document.text.selectedRange == NSRange(location: 0, length: 0))

        let dense = String(repeating: "a " + String(repeating: "b", count: 100) + "\n", count: 5_000)
        #expect(document.text.apply(range: NSRange(location: 0, length: 3), replacement: dense, selection: NSRange(location: 0, length: 0), actionName: "Edit"))
        document.replacementText = "replacement"
        let replacement = Task { await document.replace(all: true) }
        try await searching(document)
        document.findText = "different query"
        await replacement.value
        #expect(document.text.source == dense)
        #expect(document.text.selectedRange == NSRange(location: 0, length: 0))
        await workspace.closeViews()
    }

    @Test(arguments: ["source", "query", "selection"])
    func singleReplacementValidationRejectsChangedInputs(_ change: String) async throws {
        let original = String(repeating: "a", count: 1_000_000) + " a"
        let (workspace, window, root) = try workspace(original)
        defer { window.close(); try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        document.setMode(.raw)
        document.findText = "a"; document.findWholeWord = true; document.replacementText = "replacement"
        let entireSource = NSRange(location: 0, length: original.utf16.count)
        document.text.select(entireSource)
        let operation = Task { await document.replace(all: false) }
        try await searching(document)
        await document.replace(all: false)
        #expect(document.searchBusy)
        var expectedSource = original, expectedSelection = entireSource
        switch change {
        case "source":
            expectedSource = "typed"; expectedSelection = NSRange(location: 0, length: 0)
            #expect(document.text.apply(range: entireSource, replacement: expectedSource, selection: expectedSelection, actionName: "Edit"))
        case "query": document.findText = "different query"
        default:
            expectedSelection = NSRange(location: 2, length: 0)
            document.text.select(expectedSelection)
        }
        await operation.value
        #expect(document.text.source == expectedSource)
        #expect(document.text.selectedRange == expectedSelection)
        #expect(!document.searchBusy)
        await workspace.closeViews()
    }

    @Test func repeatedCountRequestsRetainOneWorkerAndPublishOnlyCurrentSource() async throws {
        let (workspace, window, root) = try workspace(String(repeating: "a", count: 1_000_000))
        defer { window.close(); try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        document.setMode(.raw)
        document.findVisible = true; document.findText = "a"; document.findWholeWord = true
        document.refreshFind()
        let worker = try #require(document.findTask)
        for query in ["aa", "aaa", "aaaa"] {
            document.findText = query; document.refreshFind()
            #expect(!worker.isCancelled)
        }
        #expect(document.text.apply(range: NSRange(location: 0, length: document.text.source.utf16.count), replacement: "current", selection: NSRange(location: 0, length: 0), actionName: "Edit"))
        document.findText = "current"; document.refreshFind()
        await worker.value
        #expect(!worker.isCancelled)
        #expect(document.findTask == nil)
        #expect(document.findSummary == "1 matches")
        await workspace.closeViews()
    }

    private func searching(_ document: WorkingDocument) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !document.searchBusy, ContinuousClock.now < deadline { await Task.yield() }
        #expect(document.searchBusy)
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
        await document.find()
        #expect(document.text.selectedRange == NSRange(location: 0, length: 3))
        await document.find()
        #expect(document.text.selectedRange == NSRange(location: 4, length: 3))
        await document.find()
        #expect(document.text.selectedRange == NSRange(location: 16, length: 3))
        await document.find()
        #expect(document.text.selectedRange == NSRange(location: 0, length: 3))
        await document.find(backwards: true)
        #expect(document.text.selectedRange == NSRange(location: 16, length: 3))
        await document.find()
        #expect(document.text.selectedRange == NSRange(location: 0, length: 3))
        document.text.select(NSRange(location: 0, length: 7))
        document.findInSelection = true; document.captureFindSelection()
        document.replacementText = "dog"
        await document.replace(all: true)
        #expect(document.text.source == "dog dog scatter\ncat")
        document.text.textView.undoManager?.undo()
        #expect(document.text.source == "Cat cat scatter\ncat")
        #expect(document.literalQuery == nil)
        await document.replace(all: true)
        #expect(document.text.source == "Cat cat scatter\ncat")
        document.findInSelection = false
        document.goToLineText = "2"; document.goToLine()
        #expect(document.text.selectedRange.location == 16)
        await document.replace(all: false)
        #expect(document.text.source == "Cat cat scatter\ndog")
        document.text.textView.undoManager?.undo()
        #expect(document.text.source == "Cat cat scatter\ncat")
        await workspace.closeViews()
    }
}
