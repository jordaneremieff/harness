import AppKit
import Testing
@testable import Editor

struct FindPanelTests {
    @Test func literalRegexCaseAndWholeWord() {
        let text = "cat CAT catalog scat cat. c.t"
        let options = FindOptions()
        #expect(FindMatches.search("cat", in: text, options: options).matches.count == 5)
        #expect(FindMatches.search("cat", in: text, options: FindOptions(caseSensitive: true)).matches.count == 4)
        #expect(FindMatches.search("cat", in: text, options: FindOptions(wholeWord: true)).matches.count == 3)
        #expect(FindMatches.search("c.t", in: text, options: options).matches.count == 1)
        #expect(FindMatches.search("c.t", in: text, options: FindOptions(regularExpression: true)).matches.count == 6)
        #expect(FindMatches.search("[", in: text, options: FindOptions(regularExpression: true)).problem != nil)
    }

    @Test func respectsUTF16SelectionsAndWordBoundaries() {
        let text = "🧪 cat scat CAT\ncat"
        let matches = FindMatches.search("cat", in: text, options: FindOptions(wholeWord: true, inSelection: true),
                                         selection: [NSRange(location: 3, length: 3), NSRange(location: 8, length: 3), NSRange(location: 12, length: 3)])
        #expect(matches.matches.map(\.range.location) == [3, 12])
        #expect(matches.nearest(to: 1, backwards: true, wrap: true) == 1)
        #expect(matches.nearest(to: 1, backwards: true, wrap: false) == nil)
        #expect(matches.nearest(to: 20, backwards: false, wrap: true) == 0)
    }

    @Test func selectionScopeTracksEditsBeforeAndInsideIt() {
        let scopes = [NSRange(location: 8, length: 10), NSRange(location: 24, length: 4)]
        let firstEdit = FindMatches.adjust(scopes, edited: NSRange(location: 2, length: 4), delta: 2)
        #expect(firstEdit == [NSRange(location: 10, length: 10), NSRange(location: 26, length: 4)])
        let secondEdit = FindMatches.adjust(firstEdit, edited: NSRange(location: 12, length: 2), delta: -3)
        #expect(secondEdit == [NSRange(location: 10, length: 7), NSRange(location: 23, length: 4)])
    }

    @Test func regexReplacementsExpandCaptureGroupsAndReportLimits() {
        let result = FindMatches.search("(cat)([0-9]+)", in: "cat3 cat4 cat5", options: FindOptions(regularExpression: true),
                                        replacement: "$2:$1", limit: 2)
        #expect(result.matches.map(\.replacement) == ["3:cat", "4:cat"])
        #expect(result.limited)
    }

    @Test @MainActor func replaceAllIsOneUndoStep() throws {
        let api = FindFixtureAPI()
        let editor = CodeEditor(api: api, record: ["doc": "test.txt", "title": "test.txt", "text": "one plus one\n", "rev": 1, "dirty": false])
        defer { editor.stop() }
        let undo = try #require(editor.undoManager(for: editor.textView))
        let matches = FindMatches.search("one", in: String(editor.findText), options: FindOptions(), replacement: "two")
        #expect(editor.replaceFound(matches.matches.map(\.range), with: matches.matches.map(\.replacement)))
        #expect(editor.textView.string == "two plus two\n")
        #expect(undo.canUndo)
        undo.undo()
        #expect(editor.textView.string == "one plus one\n")
        #expect(!undo.canUndo)
    }
}

@MainActor
private final class FindFixtureAPI: EditorAPI {
    func call(_ op: String, _ fields: Fields) async throws -> Fields { [:] }
}
