import Testing
import Foundation
import AppKit
import EditorFeature
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct NativeEditorCommands {
    private func workspace(_ source: String) throws -> (EditorWorkspace, URL) {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("editor-command-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: source))
        return (workspace, root)
    }

    private func connectPage(_ workspace: EditorWorkspace) {
        workspace.webReady = true
        workspace.webAgentApply = { [weak workspace] operation, generation, edits in
            guard let workspace else { return .refused(reason: "closed") }
            let change = WebPageChange(baseGeneration: generation, generation: generation + 1, origin: "agent", operationId: operation, edits: edits)
            do { _ = try await workspace.receivePageChange(change); return .accepted(change) }
            catch { return .refused(reason: "stale") }
        }
    }

    @Test func formattingUsesThePageAndRefusalPreservesTheMirror() async throws {
        let (workspace, root) = try workspace("hello café\r\n")
        defer { try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        document.text.select(NSRange(location: 6, length: 4))
        #expect(!(await document.perform(.bold)))
        #expect(document.text.source == "hello café\r\n")
        connectPage(workspace)
        #expect(await document.perform(.bold))
        #expect(document.text.source == "hello **café**\r\n")
        workspace.webAgentApply = { _, _, _ in .refused(reason: "held") }
        #expect(!(await document.perform(.italic)))
        #expect(document.text.source == "hello **café**\r\n")
        await workspace.closeViews()
    }

    @Test func pureFormattingKeepsOriginalLineEndings() throws {
        let source = "first\r\nsecond\rthird\n"
        let edit = try #require(MarkdownCommands.apply(command: .heading(2), to: source, selection: NSRange(location: 0, length: 5)))
        let result = try #require(MirrorText.applying([.init(range: edit.range, expected: (source as NSString).substring(with: edit.range), replacement: edit.replacement)], to: source))
        #expect(result.utf8.elementsEqual("## first\r\nsecond\rthird\n".utf8))
    }

    @Test func findWrapsAndReplacementUsesThePage() async throws {
        let (workspace, root) = try workspace("Cat cat scatter\ncat")
        defer { try? FileManager.default.removeItem(at: root) }
        connectPage(workspace)
        let document = try #require(workspace.active)
        document.findText = "cat"; document.findWholeWord = true
        for expected in [0, 4, 16, 0] {
            #expect(await document.find())
            #expect(document.text.selectedRange == NSRange(location: expected, length: 3))
        }
        #expect(await document.find(backwards: true))
        #expect(document.text.selectedRange.location == 16)
        document.text.select(NSRange(location: 0, length: 7))
        document.findInSelection = true; document.captureFindSelection()
        document.replacementText = "dog"
        await document.replace(all: true)
        #expect(document.text.source == "dog dog scatter\ncat")
        #expect(document.text.apply(range: NSRange(location: 0, length: 0), replacement: "typed", selection: nil, actionName: ""))
        #expect(document.literalQuery == nil)
        await document.replace(all: true)
        #expect(document.text.source == "typeddog dog scatter\ncat")
        await workspace.closeViews()
    }

    @Test func suspendedSearchRejectsChangedSourceAndSelection() async throws {
        let original = String(repeating: "a", count: 1_000_000) + " a"
        let (workspace, root) = try workspace(original)
        defer { try? FileManager.default.removeItem(at: root) }
        let document = try #require(workspace.active)
        document.findText = "a"; document.findWholeWord = true
        let search = Task { await document.find() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !document.searchBusy, ContinuousClock.now < deadline { await Task.yield() }
        try #require(document.searchBusy)
        #expect(document.text.apply(range: NSRange(location: 0, length: original.utf16.count), replacement: "new", selection: NSRange(location: 0, length: 0), actionName: ""))
        #expect(!(await search.value))
        #expect(document.text.source == "new")
        await workspace.closeViews()
    }
}
