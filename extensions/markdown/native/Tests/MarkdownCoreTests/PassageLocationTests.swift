import Testing
@testable import MarkdownCore

private let passageSource = """
---
title: Notes
---

# Notes

Plain words in one paragraph
that runs over two lines.

## Details

Text with *emphasis* and a [link](https://example.com/page).

Repeat repeat.

| Name | Value |
| --- | --- |
| a | 1 |

"""

@Suite struct PassageLocations {
    private let structure = SourceStructure.scan(passageSource)

    @Test func textThatOccursOnceInItsBlockGetsItsExactSourceLines() {
        let location = structure.locate(renderedText: "runs over two", renderedBlocks: 2...2, renderedBlockCount: 7)
        #expect(location.basis == .sourceText)
        #expect(location.lines == 8...8)
        #expect(location.headingPath == ["Notes"])
        #expect(location.blocks == 3...3)
        #expect(location.blockCount == 7)
        let both = structure.locate(renderedText: "one paragraph\nthat runs", renderedBlocks: 2...2, renderedBlockCount: 7)
        #expect(both.basis == .sourceText)
        #expect(both.lines == 7...8)
    }

    @Test func renderedTextThatDiffersFromItsMarkdownKeepsTheBlockRangeOnly() {
        let location = structure.locate(renderedText: "Text with emphasis and a link.", renderedBlocks: 4...4, renderedBlockCount: 7)
        #expect(location.basis == .renderedText)
        #expect(location.lines == 12...12)
        #expect(location.headingPath == ["Notes", "Details"])
        let repeated = structure.locate(renderedText: "epeat", renderedBlocks: 5...5, renderedBlockCount: 7)
        #expect(repeated.basis == .renderedText)
        #expect(repeated.lines == 14...14)
        let cells = structure.locate(renderedText: "Name\tValue\na\t1", renderedBlocks: 6...6, renderedBlockCount: 7)
        #expect(cells.basis == .renderedText)
        #expect(cells.lines == 16...18)
    }

    @Test func aSelectionAcrossBlocksCoversTheirLines() {
        let location = structure.locate(renderedText: "two lines.\n\nDetails\n\nText with", renderedBlocks: 2...4, renderedBlockCount: 7)
        #expect(location.basis == .renderedText)
        #expect(location.lines == 7...12)
        #expect(location.blocks == 3...5)
        #expect(location.headingPath == ["Notes"])
    }

    @Test func noLinesAreNamedWhenTheBlocksDoNotMatchTheRendering() {
        let mismatch = structure.locate(renderedText: "Plain words", renderedBlocks: 2...2, renderedBlockCount: 9)
        #expect(mismatch.basis == .unlocated)
        #expect(mismatch.lines == nil)
        #expect(mismatch.headingPath.isEmpty)
        let outside = structure.locate(renderedText: "Plain words", renderedBlocks: nil, renderedBlockCount: 7)
        #expect(outside.basis == .unlocated)
        #expect(outside.lines == nil)
    }

    @Test func sourceViewTextIsCheckedAgainstItsLines() {
        let exact = structure.locate(sourceText: "*emphasis* and a [link]", lines: 12...12)
        #expect(exact.basis == .sourceText)
        #expect(exact.lines == 12...12)
        #expect(exact.headingPath == ["Notes", "Details"])
        #expect(exact.blocks == 5...5)
        let frontMatter = structure.locate(sourceText: "title: Notes", lines: 2...2)
        #expect(frontMatter.basis == .sourceText)
        #expect(frontMatter.headingPath.isEmpty)
        let wrong = structure.locate(sourceText: "*emphasis*", lines: 7...8)
        #expect(wrong.basis == .unlocated)
        #expect(wrong.lines == nil)
        #expect(structure.locate(sourceText: "anything", lines: 40...41).basis == .unlocated)
    }

    @Test func carriageReturnsDoNotHideAnExactMatch() {
        let crlf = SourceStructure.scan("# A\r\n\r\nfirst line\r\nsecond line\r\n")
        let location = crlf.locate(renderedText: "first line\nsecond", renderedBlocks: 1...1, renderedBlockCount: 2)
        #expect(location.basis == .sourceText)
        #expect(location.lines == 3...4)
    }
}
