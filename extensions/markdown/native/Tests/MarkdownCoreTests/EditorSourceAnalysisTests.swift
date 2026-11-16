import Testing
@testable import MarkdownCore
import cmark_gfm

private func utf16Range(of text: String, in source: String, occurrence: Int = 0) -> (location: Int, length: Int)? {
    var search = source.startIndex
    var remaining = occurrence
    while let found = source.range(of: text, range: search..<source.endIndex) {
        if remaining == 0 {
            return (
                source[..<found.lowerBound].utf16.count,
                source[found].utf16.count
            )
        }
        remaining -= 1
        search = found.upperBound
    }
    return nil
}

private func firstSpan(_ role: EditorSemanticRole, in analysis: EditorSourceAnalysis) -> EditorSemanticSpan? {
    analysis.spans.first { $0.role == role }
}

private func spans(_ role: EditorSemanticRole, in analysis: EditorSourceAnalysis) -> [EditorSemanticSpan] {
    analysis.spans.filter { $0.role == role }
}

@Suite struct EditorSourceCoordinateMapping {
    @Test func positionsCountVisibleGraphemesAndCRLF() {
        let source = "👩🏽‍💻a e\u{301} β\r\n"
        let coordinates = EditorSourceCoordinates(source)
        #expect(coordinates.position(atUTF16: 0).line == 1)
        #expect(coordinates.position(atUTF16: 0).column == 1)

        let emojiEnd = source[..<source.range(of: "👩🏽‍💻")!.upperBound].utf16.count
        #expect(coordinates.position(atUTF16: emojiEnd).line == 1)
        #expect(coordinates.position(atUTF16: emojiEnd).column == 2)

        let composedEnd = source[..<source.range(of: "e\u{301}")!.upperBound].utf16.count
        #expect(coordinates.position(atUTF16: composedEnd).column == 5)

        #expect(coordinates.position(atUTF16: source.utf16.count).line == 2)
        #expect(coordinates.position(atUTF16: source.utf16.count).column == 1)
    }

    @Test func byteColumnsTranslateToComposedUnicodeRanges() {
        let source = "aé日"
        let coordinates = EditorSourceCoordinates(source)
        let accented = coordinates.range(startLine: 1, startColumn: 2, endLine: 1, endColumn: 3)
        #expect(accented?.location == 1)
        #expect(accented?.length == 1)

        let snapped = coordinates.range(startLine: 1, startColumn: 2, endLine: 1, endColumn: 2)
        #expect(snapped?.location == 1)
        #expect(snapped?.length == 1)

        let ideograph = coordinates.range(startLine: 1, startColumn: 4, endLine: 1, endColumn: 6)
        #expect(ideograph?.location == 2)
        #expect(ideograph?.length == 1)
    }
}

@Suite struct EditorSourceSemantics {
    @Test func codeProtectionIncludesDelimitersAndCarriageReturnLines() throws {
        let source = "Text ``a`b``.\r\r```swift\r# code\r```\r# Real heading\r"
        let analysis = EditorSourceAnalysis.scan(source)
        let inline = try #require(utf16Range(of: "``a`b``", in: source))
        let fenced = try #require(utf16Range(of: "```swift\r# code\r```", in: source))
        #expect(analysis.protectedRanges.contains { $0.location == inline.location && $0.length == inline.length })
        #expect(analysis.protectedRanges.contains { $0.location == fenced.location && $0.length == fenced.length })
        let heading = try #require(utf16Range(of: "# Real heading", in: source))
        #expect(spans(.heading1, in: analysis).map(\.range.location) == [heading.location])
        let emptyFence = EditorSourceAnalysis.scan("```\n\n")
        #expect(emptyFence.protectedRanges.first?.location == 0)
        #expect((emptyFence.protectedRanges.first?.length ?? 0) >= 4)
    }

    @Test func parserColumnsTranslateToTheExactSourceToken() throws {
        let source = "日本語 **強調** and `code`\r\n"
        let parsed = try #require(MarkdownParser.parse(Array(source.utf8)))
        defer { parsed.free() }
        let iterator = try #require(cmark_iter_new(parsed.document))
        defer { cmark_iter_free(iterator) }
        let coordinates = EditorSourceCoordinates(source)
        var strongLocation: Int?
        var codeLocation: Int?
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iterator) else { continue }
            let type = cmark_node_get_type(node)
            guard type == CMARK_NODE_STRONG || type == CMARK_NODE_CODE else { continue }
            let range = coordinates.range(
                startLine: Int(cmark_node_get_start_line(node)),
                startColumn: Int(cmark_node_get_start_column(node)),
                endLine: Int(cmark_node_get_end_line(node)),
                endColumn: Int(cmark_node_get_end_column(node))
            )
            if type == CMARK_NODE_STRONG {
                strongLocation = range?.location
            } else {
                codeLocation = range?.location
            }
        }
        let expectedStrong = try #require(utf16Range(of: "**強調**", in: source))
        let expectedCode = try #require(utf16Range(of: "`code`", in: source))
        #expect(strongLocation == expectedStrong.location)
        // cmark's inline-code source position names the literal, not its backticks.
        #expect(codeLocation == expectedCode.location + 1)
    }

    @Test func nonASCIIBeforeNestedEmphasisKeepsExactSourceRanges() throws {
        let source = "日本語 **bold *inner*** and *e\u{301}*\r\n"
        let analysis = EditorSourceAnalysis.scan(source)

        let strong = try #require(firstSpan(.strong, in: analysis))
        let expectedStrong = try #require(utf16Range(of: "**bold *inner***", in: source))
        #expect(strong.range.location == expectedStrong.location)
        #expect(strong.range.length == expectedStrong.length)

        let expectedEmphasis = try #require(utf16Range(of: "*e\u{301}*", in: source))
        let emphasis = try #require(spans(.emphasis, in: analysis).first { $0.range.location == expectedEmphasis.location })
        #expect(emphasis.range.length == expectedEmphasis.length)

        let locations = analysis.spans.map(\.range.location)
        #expect(locations == locations.sorted())
        #expect(analysis.spans.count <= EditorSourceAnalysis.spanLimit)
    }

    @Test func CRLFFrontMatterOffsetsHeadingAndEmphasis() throws {
        let source = "---\r\ntitle: Café\r\n---\r\n\r\n# Hello\r\n\r\nText *em*\r\n"
        let analysis = EditorSourceAnalysis.scan(source)

        let frontMatter = try #require(firstSpan(.frontMatter, in: analysis))
        let expectedFrontMatter = try #require(utf16Range(of: "---\r\ntitle: Café\r\n---", in: source))
        #expect(frontMatter.range.location == expectedFrontMatter.location)
        #expect(frontMatter.range.length == expectedFrontMatter.length)

        let heading = try #require(firstSpan(.heading1, in: analysis))
        let expectedHeading = try #require(utf16Range(of: "# Hello", in: source))
        #expect(heading.range.location == expectedHeading.location)
        #expect(heading.range.length == expectedHeading.length)
        let position = EditorSourceCoordinates(source).position(atUTF16: heading.range.location)
        #expect(position.line == 5)
        #expect(position.column == 1)

        let emphasis = try #require(firstSpan(.emphasis, in: analysis))
        let expectedEmphasis = try #require(utf16Range(of: "*em*", in: source))
        #expect(emphasis.range.location == expectedEmphasis.location)
        #expect(emphasis.range.length == expectedEmphasis.length)
    }

    @Test func frontMatterWithoutTrailingNewlineCoversTheWholeBlock() throws {
        let source = "---\r\ntitle: x\r\n---"
        let analysis = EditorSourceAnalysis.scan(source)
        let frontMatter = try #require(firstSpan(.frontMatter, in: analysis))
        #expect(frontMatter.range.location == 0)
        #expect(frontMatter.range.length == source.utf16.count)
    }

    @Test func nestedListTaskAndEmphasisHaveDistinctOverlays() throws {
        let source = "- [x] **bold *inner***\n  - nested\n"
        let analysis = EditorSourceAnalysis.scan(source)

        let listMarkers = spans(.listMarker, in: analysis)
        #expect(listMarkers.count == 2)
        let firstMarker = try #require(utf16Range(of: "-", in: source))
        #expect(listMarkers[0].range.location == firstMarker.location)
        #expect(listMarkers[0].range.length == 1)
        let nestedMarker = try #require(utf16Range(of: "- nested", in: source))
        #expect(listMarkers[1].range.location == nestedMarker.location)

        let task = try #require(firstSpan(.taskMarker, in: analysis))
        let expectedTask = try #require(utf16Range(of: "[x]", in: source))
        #expect(task.range.location == expectedTask.location)
        #expect(task.range.length == expectedTask.length)

        let checked = try #require(firstSpan(.checkedTask, in: analysis))
        #expect(checked.range.location == expectedTask.location)
        #expect(checked.range.length == expectedTask.length)

        let strong = try #require(firstSpan(.strong, in: analysis))
        let expectedStrong = try #require(utf16Range(of: "**bold *inner***", in: source))
        #expect(strong.range.location == expectedStrong.location)

        let emphasis = try #require(firstSpan(.emphasis, in: analysis))
        let expectedEmphasis = try #require(utf16Range(of: "*inner*", in: source))
        #expect(emphasis.range.location == expectedEmphasis.location)
        #expect(strong.range.location < emphasis.range.location)
    }

    @Test func anIncompleteFenceKeepsFollowingLinesInCodeContext() throws {
        let source = "```swift extra\n# not heading\n- not list\n**not strong**\n"
        let analysis = EditorSourceAnalysis.scan(source)

        let language = try #require(firstSpan(.fenceLanguage, in: analysis))
        #expect(language.range.location == 3)
        #expect(language.range.length == 5)

        let code = try #require(firstSpan(.codeBlock, in: analysis))
        let expectedCode = try #require(utf16Range(of: "# not heading\n- not list\n**not strong**", in: source))
        #expect(code.range.location == expectedCode.location)
        #expect(code.range.length == expectedCode.length)

        #expect(spans(.heading1, in: analysis).isEmpty)
        #expect(spans(.listMarker, in: analysis).isEmpty)
        #expect(spans(.strong, in: analysis).isEmpty)
    }

    @Test func linksAndImagesSeparateLabelsDestinationsAndDelimiters() throws {
        let source = "![alt 日本](https://example.com/i.png) and [label](https://example.com/path \"title\")\n"
        let analysis = EditorSourceAnalysis.scan(source)

        let imageLabel = try #require(firstSpan(.imageLabel, in: analysis))
        let expectedImageLabel = try #require(utf16Range(of: "alt 日本", in: source))
        #expect(imageLabel.range.location == expectedImageLabel.location)
        #expect(imageLabel.range.length == expectedImageLabel.length)

        let linkLabel = try #require(firstSpan(.linkLabel, in: analysis))
        let expectedLinkLabel = try #require(utf16Range(of: "label", in: source))
        #expect(linkLabel.range.location == expectedLinkLabel.location)

        let destinations = spans(.destination, in: analysis)
        #expect(destinations.count == 2)
        let imageDestination = try #require(utf16Range(of: "https://example.com/i.png", in: source))
        #expect(destinations[0].range.location == imageDestination.location)
        #expect(destinations[0].range.length == imageDestination.length)
        let linkDestination = try #require(utf16Range(of: "https://example.com/path", in: source))
        #expect(destinations[1].range.location == linkDestination.location)

        let markers = spans(.marker, in: analysis)
        let bang = try #require(utf16Range(of: "!", in: source))
        #expect(markers.contains { $0.range.location == bang.location && $0.range.length == 1 })
        #expect(markers.count == 9)
    }

    @Test func tablesTasksQuotesFootnotesHTMLRulesAndEscapes() throws {
        let source = """
        | a | b |
        | --- | --- |
        | 1 | 2 |

        - [x] done

        > quote

        [^n]: note

        ref[^n]

        <kbd>raw</kbd>

        \\*escaped\\* b

        ***
        """
        let analysis = EditorSourceAnalysis.scan(source)

        let delimiter = try #require(firstSpan(.tableDelimiter, in: analysis))
        let expectedDelimiter = try #require(utf16Range(of: "| --- | --- |", in: source))
        #expect(delimiter.range.location == expectedDelimiter.location)
        #expect(delimiter.range.length == expectedDelimiter.length)

        #expect(firstSpan(.taskMarker, in: analysis) != nil)
        #expect(firstSpan(.checkedTask, in: analysis) != nil)
        #expect(firstSpan(.quote, in: analysis) != nil)

        let footnotes = spans(.footnote, in: analysis)
        #expect(footnotes.count == 2)

        let html = spans(.html, in: analysis)
        #expect(html.count == 2)

        let rules = spans(.rule, in: analysis)
        #expect(rules.count == 1)
        let expectedRule = try #require(utf16Range(of: "***", in: source))
        #expect(rules[0].range.location == expectedRule.location)

        let escapes = spans(.escape, in: analysis)
        #expect(escapes.count == 2)
        let firstEscape = try #require(utf16Range(of: "\\*", in: source))
        #expect(escapes[0].range.location == firstEscape.location)
        #expect(escapes[0].range.length == 2)

        #expect(spans(.reference, in: analysis).isEmpty)
    }

    @Test func referenceDefinitionsAndReferenceLinksStayBounded() throws {
        let source = "[ref]: https://example.com \"Title\"\n\n[text][ref]\n"
        let analysis = EditorSourceAnalysis.scan(source)

        let references = spans(.reference, in: analysis)
        #expect(references.count == 2)
        let expectedDefinition = try #require(utf16Range(of: "[ref]: https://example.com \"Title\"", in: source))
        #expect(references[0].range.location == expectedDefinition.location)
        #expect(references[0].range.length == expectedDefinition.length)

        let destination = try #require(firstSpan(.destination, in: analysis))
        let expectedDestination = try #require(utf16Range(of: "https://example.com", in: source))
        #expect(destination.range.location == expectedDestination.location)
        #expect(destination.range.length == expectedDestination.length)

        let linkLabels = spans(.linkLabel, in: analysis)
        #expect(linkLabels.count == 2)
        let text = try #require(utf16Range(of: "text", in: source))
        #expect(linkLabels[1].range.location == text.location)
        #expect(linkLabels[1].range.length == text.length)
    }
}
