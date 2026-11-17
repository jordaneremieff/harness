import Foundation
import Testing
@testable import MarkdownCore

@Suite struct WebBlockTests {
    private func render(_ source: String, nonce: String = "web-test") -> RenderedDocument {
        MarkdownRenderer.render(source, resolver: NoAssetResolver(), nonce: nonce)
    }

    private func text(_ block: WebBlock, in source: String) -> String {
        (source as NSString).substring(with: NSRange(location: block.start, length: block.end - block.start))
    }

    @Test func unicodeAndMixedLineEndingsKeepExactUTF16Ranges() {
        let source = "\r\n \t\r\n# 👩🏽‍💻 e\u{301}\r\n\r\n  日本語 😀  \r\nnext\r\n\t\r\n> quote\rcontinued\r\r"
        let blocks = render(source).blocks
        #expect(blocks.map(\.type) == ["heading1", "paragraph", "quote"])
        #expect(blocks.map { text($0, in: source) } == ["# 👩🏽‍💻 e\u{301}", "  日本語 😀  \r\nnext", "> quote\rcontinued"])
        #expect(blocks[0].start == ("\r\n \t\r\n" as NSString).length)
        #expect(blocks[0].end == ("\r\n \t\r\n# 👩🏽‍💻 e\u{301}" as NSString).length)
        #expect(blocks[1].html.contains("日本語 😀"))
        for block in blocks {
            #expect(block.start >= 0)
            #expect(block.end <= source.utf16.count)
            #expect(block.start < block.end)
        }
    }

    @Test func frontMatterDoesNotNormaliseTheRemainingSource() {
        let source = "---\r\ntitle: 😀\r\n---\r\n\r\n# Heading\r\n\r\n```swift\r\na\r\nb\r\n```\r\n\r\n"
        let blocks = render(source).blocks
        #expect(blocks.map(\.type) == ["code", "heading1", "code"])
        #expect(blocks.map { text($0, in: source) } == ["---\r\ntitle: 😀\r\n---", "# Heading", "```swift\r\na\r\nb\r\n```"])
        #expect(blocks[0].html.contains("Front matter"))
        #expect(blocks[2].html.contains("a\r\nb"))
    }

    @Test func keysKeepUnchangedBlocksAndDisambiguateDuplicates() {
        let original = render("same\n\nsame\n\n# Heading\n").blocks
        let repeated = render("same\n\nsame\n\n# Heading\n", nonce: "another-secret").blocks
        let shifted = render("new\n\nsame\n\nsame\n\n# Heading\n").blocks
        #expect(original.map(\.key) == repeated.map(\.key))
        #expect(Set(original.map(\.key)).count == original.count)
        #expect(original.map(\.key) == Array(shifted.dropFirst()).map(\.key))
        #expect(original[0].start != shifted[1].start)
        let code = "```swift\nreader-action:copy-code/first/0\n```\n\n![remote](https://example.org/a.png)\n"
        #expect(render(code, nonce: "first").blocks.map(\.key) == render(code, nonce: "second").blocks.map(\.key))
    }

    @Test func referenceDestinationsResolveFromTheWholeDocument() {
        let source = "[Link][target]\n\n[target]: https://example.org/first \"Title\"\n"
        let first = render(source).blocks
        let changed = render(source.replacingOccurrences(of: "/first", with: "/second")).blocks
        #expect(first[0].html.contains("href=\"https://example.org/first\""))
        #expect(first[0].html.contains("title=\"Title\""))
        #expect(changed[0].html.contains("href=\"https://example.org/second\""))
        #expect(first[0].key != changed[0].key)
        #expect(first.map { text($0, in: source) } == ["[Link][target]", "[target]: https://example.org/first \"Title\""])
        #expect(first[1].type == "other")
        #expect(first[1].html.isEmpty)
    }

    @Test func footnotesKeepWholeDocumentNumbersAndSourceOrder() {
        let source = "B[^b], A[^a], B again[^b].\n\n[^a]: A [link][target]\n\nMiddle.\n\n[^b]: B note\n\n    - nested\n    - list\n\n[target]: https://example.org/\n"
        let blocks = render(source).blocks
        #expect(blocks.map(\.type) == ["paragraph", "footnotes", "paragraph", "footnotes", "other"])
        #expect(blocks.map(\.start) == blocks.map(\.start).sorted())
        #expect(blocks[0].html.contains("href=\"#fn-b\""))
        #expect(blocks[0].html.contains("id=\"fnref-b-2\""))
        #expect(blocks[1].html.contains("<ol start=\"2\">"))
        #expect(blocks[1].html.contains("<li id=\"fn-a\">"))
        #expect(blocks[1].html.contains("href=\"https://example.org/\""))
        #expect(!blocks[1].html.contains("id=\"fn-b\""))
        #expect(blocks[3].html.contains("<ol start=\"1\">"))
        #expect(blocks[3].html.contains("<li id=\"fn-b\">"))
        #expect(blocks[3].html.contains("href=\"#fnref-b-2\""))
        #expect(blocks[3].html.contains("<li>nested</li>"))
        #expect(text(blocks[1], in: source) == "[^a]: A [link][target]")
        #expect(text(blocks[3], in: source) == "[^b]: B note\n\n    - nested\n    - list")
    }

    @Test func rawHTMLAndUnsafeDestinationsStayInert() {
        let source = "<script>alert(1)</script>\n\nText <img src=x onerror=alert(2)> [bad](javascript:alert(3))\n\n![remote](https://example.org/image.png)\n\n![local](../private.png)\n"
        let document = render(source)
        let html = document.blocks.map(\.html).joined()
        #expect(document.blocks[0].type == "html")
        #expect(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"))
        #expect(html.contains("&lt;img src=x onerror=alert(2)&gt;"))
        #expect(!html.contains("<script>"))
        #expect(!html.contains("<img"))
        #expect(!html.contains("href=\"javascript:"))
        #expect(html.contains("inert-link"))
        #expect(html.contains("Remote image not loaded"))
        #expect(html.contains("Image unavailable"))
        #expect(document.externalImages.count == 1)
        #expect(document.unavailableImages.count == 1)
        #expect(document.assets.isEmpty)
        #expect(document.rawHTMLFragments == 2)
    }

    @Test func sourceOnlyDefinitionsAndEmptyDocumentsRemainEditable() {
        #expect(render("").blocks.isEmpty)
        #expect(render("\r\n \t\r\n").blocks.isEmpty)
        let source = "\n[target]: https://example.org/\n\n[^unused]: retained source\n\n"
        let blocks = render(source).blocks
        #expect(blocks.map(\.type) == ["other", "footnotes"])
        #expect(blocks.map { text($0, in: source) } == ["[target]: https://example.org/", "[^unused]: retained source"])
        #expect(blocks.allSatisfy { $0.html.isEmpty })
    }

    @Test func blockTypesAndInnerBlankLinesStayIntact() {
        let source = "## Two\n\n- one\n\n- two\n\n> quote\n\n---\n\n| a | b |\n|---|---|\n| x | y |\n\n    code\n\n    more\n"
        let blocks = render(source).blocks
        #expect(blocks.map(\.type) == ["heading2", "list", "quote", "rule", "table", "code"])
        #expect(text(blocks[1], in: source) == "- one\n\n- two")
        #expect(text(blocks[5], in: source) == "    code\n\n    more")
        #expect(blocks[4].html.contains("<table>"))
        #expect(blocks[1].html.contains("<ul>"))
    }

    @Test func publicPayloadEncodesBridgeFields() throws {
        let source = "# Heading\n\nText.\n"
        let blocks = MarkdownRenderer.renderBlocks(source, resolver: NoAssetResolver(), nonce: "web-test")
        #expect(blocks == render(source).blocks)
        let data = try JSONEncoder().encode(blocks)
        let decoded = try JSONDecoder().decode([WebBlock].self, from: data)
        #expect(decoded == blocks)
        let objects = try #require(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        #expect(Set(try #require(objects.first).keys) == ["key", "start", "end", "type", "html", "map"])
    }

    private func mappedPairs(_ block: WebBlock, source: String, rendered: String) -> [[String]] {
        block.map.map {
            [(rendered as NSString).substring(with: NSRange(location: $0[0], length: $0[1])),
             (source as NSString).substring(with: NSRange(location: $0[2], length: $0[3]))]
        }
    }

    @Test func plainAndNestedTextMapsExcludeMarkdownMarks() throws {
        let source = "\n\nplain 😀 e\u{301}\n"
        let block = try #require(render(source).blocks.first)
        let count = "plain 😀 e\u{301}".utf16.count
        #expect(block.map == [[1, count, 2, count]])
        let nested = "plain **bold *inner*** tail"
        let nestedBlock = try #require(render(nested).blocks.first)
        #expect(mappedPairs(nestedBlock, source: nested, rendered: "\nplain bold inner tail\n") == [
            ["plain ", "plain "], ["bold ", "bold "], ["inner", "inner"], [" tail", " tail"]
        ])
        #expect(!nestedBlock.html.contains("reader-map"))
        #expect(!render(nested).body.contains("reader-map"))
    }

    @Test func inlineCodeMapExcludesBacktickRunsAndTrimmedSpaces() throws {
        let source = "a `` x ` y `` z ` a\r\nb `"
        let block = try #require(render(source).blocks.first)
        #expect(mappedPairs(block, source: source, rendered: "\na x ` y z a b\n") == [
            ["a ", "a "], ["x ` y", "x ` y"], [" z ", " z "], ["a", "a"], [" ", "\r\n"], ["b", "b"]
        ])
    }

    @Test func linksMapLabelsWithoutDestinationsOrReferenceNames() throws {
        let source = "[inline](https://example.org/) [ref][target]\n\n[target]: https://example.net/\n"
        let block = try #require(render(source).blocks.first)
        #expect(mappedPairs(block, source: source, rendered: "\ninline ref\n") == [
            ["inline", "inline"], [" ", " "], ["ref", "ref"]
        ])
    }

    @Test func escapesAndEntitiesUseAtomicSourceSegments() throws {
        let source = "a &amp; &NotEqualTilde; \\*z\\* e😀"
        let block = try #require(render(source).blocks.first)
        let pairs = mappedPairs(block, source: source, rendered: "\na & ≂̸ *z* e😀\n")
        #expect(pairs == [["a ", "a "], ["&", "&amp;"], [" ", " "], ["≂̸", "&NotEqualTilde;"],
                          [" ", " "], ["*", "\\*"], ["z", "z"], ["*", "\\*"], [" e😀", " e😀"]])
    }

    @Test func softAndHardBreaksMapExactCRLFWithoutBreakMarks() throws {
        let source = "a\r\nb\\\r\nc  \r\nd"
        let block = try #require(render(source).blocks.first)
        #expect(mappedPairs(block, source: source, rendered: "\na\nb\nc\nd\n") == [
            ["a", "a"], ["\n", "\r\n"], ["b", "b"], ["\n", "\r\n"], ["c", "c"], ["\n", "\r\n"], ["d", "d"]
        ])
    }

    @Test func placeholderMapsOnlyAltTextAndNotGeneratedControls() throws {
        let source = "![alt *em* &amp; 😀](https://example.org/i.png)"
        let block = try #require(render(source).blocks.first)
        let pairs = mappedPairs(block, source: source, rendered: "\nRemote image not loadedexample.orgalt em & 😀Details\n")
        #expect(pairs == [["alt ", "alt "], ["em", "em"], [" ", " "], ["&", "&amp;"], [" 😀", " 😀"]])
    }

    @Test func tablesAndListsMapTextInDOMOrderWithoutStructuralWhitespace() throws {
        let table = "| a | b |\n|---|---|\n| x | y |"
        let block = try #require(render(table).blocks.first)
        let dom = "\n\n\n\na\nb\n\n\n\n\nx\ny\n\n\n\n"
        #expect(mappedPairs(block, source: table, rendered: dom) == [["a", "a"], ["b", "b"], ["x", "x"], ["y", "y"]])
        let list = "- one\n- **two**"
        let listBlock = try #require(render(list).blocks.first)
        #expect(mappedPairs(listBlock, source: list, rendered: "\n\none\ntwo\n\n") == [["one", "one"], ["two", "two"]])
    }

    @Test func codeBlocksMapLiteralButNotFenceLanguageOrCopyControl() throws {
        let source = "```swift\r\na😀\r\nb\r\n```\r\n"
        let block = try #require(render(source).blocks.first)
        #expect(mappedPairs(block, source: source, rendered: "\nswiftCopya😀\nb\n") == [
            ["a😀", "a😀"], ["\n", "\r\n"], ["b", "b"]
        ])
    }
}
