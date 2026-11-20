import Foundation
import Testing
@testable import MarkdownCore

private func offsets(of text: String, in source: String, occurrence: Int = 1) -> (Int, Int) {
    var search = NSRange(location: 0, length: (source as NSString).length)
    var found = NSRange(location: NSNotFound, length: 0)
    for _ in 0..<occurrence {
        found = (source as NSString).range(of: text, options: [], range: search)
        search = NSRange(location: NSMaxRange(found), length: (source as NSString).length - NSMaxRange(found))
    }
    return (found.location, NSMaxRange(found))
}

@Suite struct PassageExcerptTests {
    @Test func aShortSelectionNamesItsLineSectionAndNeighbours() throws {
        let source = "# Guide\n\n## Setup\n\nRun it once, then run it again.\n"
        let (start, end) = offsets(of: "it", in: source, occurrence: 2)
        let excerpt = try #require(PassageExcerpt(source: source, start: start, end: end, structure: SourceStructure.scan(source)))
        #expect(excerpt.lines == 5...5)
        #expect(excerpt.lineLabel == "line 5")
        #expect(excerpt.section == "Guide › Setup")
        #expect(excerpt.start == start && excerpt.end == end)
        #expect(excerpt.marked(open: "⟦", close: "⟧") == "Run it once, then run ⟦it⟧ again.")
    }

    @Test func everyLineBreakFormCountsOnceAndBreaksAtTheEndsAreDropped() throws {
        for breakText in ["\n", "\r\n", "\r"] {
            let source = ["One", "Two words", "Three"].joined(separator: breakText)
            let (start, end) = offsets(of: breakText + "Two words" + breakText, in: source)
            let excerpt = try #require(PassageExcerpt(source: source, start: start, end: end))
            #expect(excerpt.lines == 2...2)
            #expect(excerpt.selection == "Two words")
            #expect(excerpt.before.isEmpty && excerpt.after.isEmpty)
            #expect(excerpt.start == start + (breakText as NSString).length)
        }
    }

    @Test func aSelectionOverSeveralLinesKeepsItsFirstAndLastLine() throws {
        let source = "Intro line\nAlpha beta\ngamma delta\nOutro"
        let (start, _) = offsets(of: "beta", in: source)
        let (_, end) = offsets(of: "gamma", in: source)
        let excerpt = try #require(PassageExcerpt(source: source, start: start, end: end))
        #expect(excerpt.lineLabel == "lines 2–3")
        #expect(excerpt.marked(open: "[", close: "]") == "Alpha [beta\ngamma] delta")
        #expect(excerpt.section == nil)
    }

    @Test func longLinesAreClippedAtWordsBesideTheSelection() throws {
        let words = (1...80).map { "word\($0)" }
        let source = words.joined(separator: " ")
        let (start, end) = offsets(of: "word40", in: source)
        let excerpt = try #require(PassageExcerpt(source: source, start: start, end: end))
        #expect(excerpt.before.hasPrefix("…word"))
        #expect(excerpt.after.hasSuffix("…"))
        #expect(excerpt.before.count <= PassageExcerpt.contextCharacters + 1)
        #expect(excerpt.after.count <= PassageExcerpt.contextCharacters + 1)
        #expect(excerpt.before.hasSuffix("word39 ") && excerpt.after.hasPrefix(" word41"))
        #expect(!excerpt.after.dropLast().hasSuffix(" "))
    }

    @Test func invalidSelectionsHaveNoExcerpt() {
        let source = "A 😀 face\n\nNext"
        let emoji = (source as NSString).range(of: "😀")
        #expect(PassageExcerpt(source: source, start: emoji.location + 1, end: emoji.location + 2) == nil)
        #expect(PassageExcerpt(source: source, start: 3, end: 3) == nil)
        #expect(PassageExcerpt(source: source, start: 0, end: (source as NSString).length + 1) == nil)
        let (start, end) = offsets(of: "\n\n", in: source)
        #expect(PassageExcerpt(source: source, start: start, end: end) == nil)
        let long = String(repeating: "x", count: PassageExcerpt.selectionBytes + 1)
        #expect(PassageExcerpt(source: long, start: 0, end: (long as NSString).length) == nil)
        #expect(PassageExcerpt(source: source, start: emoji.location, end: NSMaxRange(emoji))?.selection == "😀")
    }

    @Test func deepOrLongSectionsStayOnOneShortLine() throws {
        let title = String(repeating: "Long ", count: 30)
        let source = "# One\n## Two\n### Three\n#### Four\n##### \(title)\n\nText here.\n"
        let (start, end) = offsets(of: "Text", in: source)
        let excerpt = try #require(PassageExcerpt(source: source, start: start, end: end, structure: SourceStructure.scan(source)))
        let section = try #require(excerpt.section)
        #expect(section.hasPrefix("… › Three › Four › Long "))
        #expect(section.hasSuffix("…"))
        #expect(!section.contains("One"))
    }

    @Test func marksAvoidCharactersThatTheTextAlreadyUses() {
        let plain = PassageExcerpt.marks(avoiding: ["plain"])
        #expect(plain?.open == "⟦" && plain?.close == "⟧")
        let used = PassageExcerpt.marks(avoiding: ["uses ⟦ here", "plain"])
        #expect(used?.open == "⟪" && used?.close == "⟫")
        let closing = PassageExcerpt.marks(avoiding: ["only ⟧ and ⟫"])
        #expect(closing?.open == "⦃" && closing?.close == "⦄")
        #expect(PassageExcerpt.marks(avoiding: ["⟦ ⟪", "⦃ 【"]) == nil)
    }
}
