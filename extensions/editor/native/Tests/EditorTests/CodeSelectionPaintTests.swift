import AppKit
import Testing
@testable import Editor

@MainActor
@Suite(.serialized)
struct CodeSelectionPaintTests {
    @Test func characterIndexCountsGraphemesAndRejectsAnInteriorOffset() throws {
        let text = "a👨‍👩‍👧‍👦e\u{301}\r\n🇦🇺z"
        let index = try #require(SelectionCharacterIndex(text))
        var boundaries = [0]
        for character in text { boundaries.append(boundaries.last! + character.utf16.count) }
        for start in 0..<boundaries.count {
            for stop in start..<boundaries.count {
                let range = NSRange(location: boundaries[start], length: boundaries[stop] - boundaries[start])
                #expect(index.count(in: range) == stop - start)
            }
        }
        #expect(index.count(in: NSRange(location: 2, length: 2)) == nil)
    }

    @Test func selectionOnlyInvalidatesTheGutterWhenTheActiveLineChanges() throws {
        _ = NSApplication.shared
        let editor = CodeEditor(api: LocalAPI(), record: ["doc": "sample.swift", "rev": 1, "text": "let a = 1\nlet b = 2\n"])
        let window = KeyWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 550), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = editor.view
        window.makeFirstResponder(editor.textView)
        editor.view.layoutSubtreeIfNeeded()
        defer { editor.stop(); window.contentView = nil }
        let text = editor.textView
        var activeLineChanges: [Int] = []
        text.activeLineChanged = { previous, next in activeLineChanges.append(contentsOf: [previous, next]) }
        text.setSelectedRange(NSRange(location: 1, length: 2))
        #expect(activeLineChanges.isEmpty)
        text.setSelectedRange(NSRange(location: 12, length: 0))
        #expect(activeLineChanges == [0, 1])

        let caret = try #require(editor.scroll.caretOverlay.subviews.first)
        #expect(!caret.isHidden)
        #expect(!text.shouldDrawInsertionPoint)
        let frame = caret.frame
        editor.scroll.caretOverlay.updateOpacity(now: ProcessInfo.processInfo.systemUptime + 1)
        #expect(editor.scroll.caretOverlay.alphaValue < 1)
        #expect(caret.frame == frame)
    }
}

private final class LocalAPI: EditorAPI {
    func call(_ op: String, _ fields: Fields) async throws -> Fields { [:] }
}

private final class KeyWindow: NSWindow {
    override var isKeyWindow: Bool { true }
}
