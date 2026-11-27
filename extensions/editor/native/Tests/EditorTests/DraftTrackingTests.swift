import Foundation
import Testing
@testable import Editor

@MainActor
struct DraftTrackingTests {
    @Test func distinctChangesRetainAnUnchangedSelectionAndExactUnicode() {
        let old = "a😀 b c d e\nkeep me\nold word e\u{301}\n"
        let next = "a😁 b c d e\nkeep me\nnew word é\n"
        let changes = DraftTextChange.between(old, next)
        let actual = NSMutableString(string: old)
        for hunk in changes.reversed() {
            #expect(actual.substring(with: hunk.range).utf8.elementsEqual(hunk.oldText.utf8))
            actual.replaceCharacters(in: hunk.range, with: hunk.newText)
        }
        #expect(String(actual).utf8.elementsEqual(next.utf8))
        let selected = (old as NSString).range(of: "keep me")
        let mapped = DraftTextChange.map(selected, through: changes)
        #expect((next as NSString).substring(with: mapped) == "keep me")
    }

    @Test func largeChangesKeepAnUntouchedInteriorLine() {
        let old = String(repeating: "a", count: 3000) + "\nlet retained = true\n" + String(repeating: "x", count: 3000)
        let next = String(repeating: "b", count: 3012) + "\nlet retained = true\n" + String(repeating: "y", count: 3000)
        let changes = DraftTextChange.between(old, next)
        #expect(changes.count == 2)
        let mapped = DraftTextChange.map((old as NSString).range(of: "retained"), through: changes)
        #expect(mapped == (next as NSString).range(of: "retained"))
    }

    @Test func deltasReconstructRepeatedAndUnicodeText() {
        let alphabet = ["a", "b", "😀", "😁", "\u{1FA00}", "e\u{301}", "é", "\n"]
        var seed: UInt32 = 733
        func sample() -> String {
            seed = 1664525 &* seed &+ 1013904223
            let length = Int(seed % 27)
            return (0..<length).map { _ in
                seed = 1664525 &* seed &+ 1013904223
                return alphabet[Int((seed >> 12) % UInt32(alphabet.count))]
            }.joined()
        }
        for _ in 0..<150 {
            let old = sample(), next = sample()
            let actual = NSMutableString(string: old)
            for hunk in DraftTextChange.between(old, next).reversed() {
                actual.replaceCharacters(in: hunk.range, with: hunk.newText)
            }
            #expect(String(actual).utf8.elementsEqual(next.utf8))
        }
    }

    @Test func threadMappingTracksCommittedAndUncommittedEdits() throws {
        let fields: Fields = ["doc": "a.swift", "rev": 4, "start": 8, "end": 13, "id": "thread", "quote": "alpha"]
        let anchor = try #require(CodeThreadAnchor(fields))
        let map = DraftRevisionMap()
        let insertion = DraftCoordinateEdit(range: NSRange(location: 0, length: 0), length: 2)
        map.edit(insertion)
        map.commit(from: 4, to: 6)
        let live = map.track(NSRange(location: 10, length: 5))
        // The insert at the leading boundary belongs before the anchored word.
        map.edit(DraftCoordinateEdit(range: NSRange(location: 10, length: 0), length: 1))
        #expect(live.range == NSRange(location: 11, length: 5))
        #expect(anchor.locate(in: "0123456789 alpha", revision: 6, map: map) == live.range)
        #expect(anchor.locate(in: "alpha then alpha", revision: 8, map: DraftRevisionMap()) == nil)
        #expect(anchor.locate(in: "let alpha = 1", revision: 8, map: DraftRevisionMap()) == NSRange(location: 4, length: 5))
    }

    @Test func comparisonMarksWholeChangedWords() throws {
        let before = "let value = warm"
        let after = "let value = warmer"
        let insertion = NSRange(location: before.utf16.count, length: 0)
        let added = NSRange(location: before.utf16.count, length: 2)
        let excerpt = try #require(ReviewExcerpt.make(before: before as NSString, after: after as NSString,
                                                      locations: [(insertion, added)]).first)
        #expect(excerpt.before.marked.map { (excerpt.before.text as NSString).substring(with: $0) } == ["warm"])
        #expect(excerpt.after.marked.map { (excerpt.after.text as NSString).substring(with: $0) } == ["warmer"])
    }
}
