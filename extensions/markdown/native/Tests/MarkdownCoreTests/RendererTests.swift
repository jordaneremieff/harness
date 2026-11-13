import Testing
@testable import MarkdownCore

private func render(_ source: String, resolver: AssetResolving = NoAssetResolver()) -> RenderedDocument {
    MarkdownRenderer.render(source, resolver: resolver, nonce: "n0")
}

@Suite struct GFMRendering {
    @Test func tablesTaskListsStrikethroughAndAutolinks() {
        let html = render("""
        | a | b |
        |:--|--:|
        | 1 | **2** |

        - [x] done
        - [ ] todo

        ~~gone~~ and www.example.com and https://example.org/x
        """).body
        #expect(html.contains("<table>"))
        #expect(html.contains("<th align=\"left\">a</th>"))
        #expect(html.contains("<td align=\"right\"><strong>2</strong></td>"))
        #expect(html.contains("<input type=\"checkbox\" checked=\"\" disabled=\"\" /> done"))
        #expect(html.contains("<input type=\"checkbox\" disabled=\"\" /> todo"))
        #expect(html.contains("<del>gone</del>"))
        #expect(html.contains("<a class=\"ext\" href=\"http://www.example.com\""))
        #expect(html.contains("<a class=\"ext\" href=\"https://example.org/x\""))
    }

    @Test func nestedListsKeepStructure() {
        let html = render("- a\n  - b\n    1. c\n    2. d\n- e\n").body
        #expect(html.components(separatedBy: "<ul>").count == 3)
        #expect(html.contains("<ol>"))
        #expect(html.contains("<li>c</li>"))
    }

    @Test func repeatedHeadingsGetDistinctAnchors() {
        let rendered = render("# Intro\n\n## Setup\n\n## Setup\n\n## Setup\n\n### fn 1\n")
        #expect(rendered.outline.map(\.id) == ["intro", "setup", "setup-1", "setup-2", "h-fn-1"])
        #expect(rendered.outline.map(\.level) == [1, 2, 2, 2, 3])
        #expect(rendered.body.contains("<h2 id=\"setup-1\">"))
    }

    @Test func manyEqualHeadingsKeepUniqueAnchors() {
        // "A 1" takes the anchor that the second "A" would otherwise get.
        let mixed = render("# A\n\n# A 1\n\n# A\n\n# A\n\n# A 1\n")
        #expect(mixed.outline.map(\.id) == ["a", "a-1", "a-2", "a-3", "a-1-1"])
        let count = 5000
        let many = render(String(repeating: "## Same\n\n", count: count) + "## Same 3\n\n## Same\n")
        let anchors = many.outline.map(\.id)
        #expect(anchors.count == count + 2)
        #expect(Set(anchors).count == anchors.count)
        #expect(anchors[count - 1] == "same-\(count - 1)")
        #expect(anchors[count] == "same-3-1")
        #expect(anchors[count + 1] == "same-\(count)")
    }

    @Test func unicodeEmojiAndCombiningTextSurvive() {
        let text = "Ünïcödé — 日本語 — 👩🏽‍💻 — e\u{301} — עברית"
        let rendered = render("# \(text)\n\n\(text)\n")
        #expect(rendered.body.contains("<p>\(text)</p>"))
        #expect(rendered.outline.first?.title == text)
        #expect(rendered.outline.first?.id.contains("日本語") == true)
    }

    @Test func wideTablesAndLongCodeStayIntact() {
        let header = "| " + (1...40).map { "column \($0)" }.joined(separator: " | ") + " |"
        let rule = "|" + String(repeating: "---|", count: 40)
        let line = String(repeating: "x", count: 5000)
        let rendered = render("\(header)\n\(rule)\n\n```\n\(line)\n```\n")
        #expect(rendered.body.contains("column 40"))
        #expect(rendered.codeBlocks.first?.literal == line)
    }

    @Test func codeBlocksKeepExactLiteralAndLabel() {
        let code = "\tlet a = \"<b>&amp;</b>\"  \n  trailing  \n"
        let rendered = render("```swift title=x\n\(code)```\n\n    indented\n")
        #expect(rendered.codeBlocks.count == 2)
        #expect(rendered.codeBlocks[0].literal == String(code.dropLast()))
        #expect(rendered.codeBlocks[0].info == "swift title=x")
        #expect(rendered.body.contains("<span class=\"lang\">swift</span>"))
        #expect(rendered.body.contains("&lt;b&gt;&amp;amp;&lt;/b&gt;"))
        #expect(rendered.body.contains("href=\"reader-action:copy-code/n0/0\""))
        #expect(rendered.codeBlocks[1].literal == "indented")
        #expect(rendered.body.contains("<span class=\"lang\">code</span>"))
    }

    @Test func malformedAndUnknownFencesStayVisible() {
        let rendered = render("```mermaid\ngraph TD\n```\n\n```\nnever closed\n# not a heading\n")
        #expect(rendered.codeBlocks.map(\.info) == ["mermaid", ""])
        #expect(rendered.codeBlocks[1].literal.contains("# not a heading"))
        #expect(rendered.outline.isEmpty)
    }

    @Test func frontMatterIsShownAsCode() {
        let rendered = render("---\ntitle: x\n---\n# Body\n")
        #expect(rendered.codeBlocks.first?.literal == "title: x")
        #expect(rendered.body.contains("Front matter"))
        #expect(rendered.outline.map(\.title) == ["Body"])
    }

    @Test func topLevelBlocksCarryStableKeys() {
        let first = render("# A\n\npara one\n\npara two\n\npara one\n")
        let second = render("# A\n\nnew paragraph\n\npara one\n\npara two\n\npara one\n")
        func keys(_ html: String) -> [String] {
            html.components(separatedBy: "data-key=\"").dropFirst().map { String($0.prefix { $0 != "\"" }) }
        }
        let a = keys(first.body)
        let b = keys(second.body)
        #expect(a.count == 4)
        #expect(Set(a).count == 4)
        #expect(Set(a).isSubset(of: Set(b)))
    }
}

@Suite struct ContentSafety {
    @Test func rawHTMLIsEscapedLiteral() {
        let rendered = render("<div onclick=\"x()\">block</div>\n\nInline <span style=\"color:red\">x</span> and <script>alert(1)</script>\n")
        #expect(!rendered.body.contains("<div onclick"))
        #expect(!rendered.body.contains("<script>"))
        #expect(!rendered.body.contains("<span style"))
        #expect(rendered.body.contains("&lt;div onclick=&quot;x()&quot;&gt;block&lt;/div&gt;"))
        #expect(rendered.body.contains("&lt;script&gt;"))
        #expect(rendered.body.contains("HTML shown as text"))
        #expect(rendered.rawHTMLFragments >= 4)
        #expect(!rendered.body.contains("raw HTML omitted"))
    }

    @Test func unsafeSchemesBecomeInertText() {
        let rendered = render("[a](javascript:alert(1)) [b](vbscript:x) [c](file:///etc/passwd) [d](data:text/html,x) [e](reader-action:copy-code/n0/0) [f](mailto:x@y.z) [g](docs/a.md)")
        let html = rendered.body
        #expect(!html.contains("href=\"javascript"))
        #expect(!html.contains("href=\"vbscript"))
        #expect(!html.contains("href=\"file:"))
        #expect(!html.contains("href=\"data:"))
        #expect(!html.contains("href=\"reader-action:copy-code/n0/0\"\">e"))
        #expect(html.components(separatedBy: "class=\"inert-link\"").count == 8)
        #expect(rendered.localOnlyLinks == 2)
    }

    @Test func attributeInjectionIsEscaped() {
        let html = render("[x](https://e.com/\"onmouseover=\"alert(1) \"t\\\"itle\")\n\n![a\" onerror=\"x](https://e.com/i.png)").body
        #expect(!html.contains("\"onmouseover"))
        #expect(!html.contains("onerror=\""))
    }

    @Test func remoteImagesAreNotLoaded() {
        let rendered = render("![beacon](https://tracker.example/p.gif) ![rel](//cdn.example/x.png)")
        #expect(!rendered.body.contains("<img"))
        #expect(rendered.body.contains("Remote image not loaded"))
        #expect(rendered.externalImages.map(\.absoluteString) == ["https://tracker.example/p.gif", "https://cdn.example/x.png"])
        #expect(!rendered.selfContained)
    }

    @Test func dataImagesAreBoundedAndTyped() {
        let rendered = render("![ok](data:image/png;base64,iVBORw0KGgo=) ![svg](data:image/svg+xml,<svg/>) ![html](data:text/html,x)")
        #expect(rendered.embeddedImages == 1)
        #expect(rendered.body.contains("<img src=\"data:image/png;base64,iVBORw0KGgo=\""))
        #expect(rendered.unavailableImages.count == 2)
    }

    @Test func relativeImagesWithoutBaseAreExplained() {
        let rendered = render("![diagram](img/d.png)")
        #expect(rendered.unavailableImages.first?.reason == "no-base")
        #expect(rendered.body.contains("Image unavailable"))
        #expect(rendered.body.contains("img/d.png"))
    }

    @Test func pageCarriesStrictPolicy() {
        let page = PageTemplate.page(body: "<p>x</p>", title: "<t>", settings: PageSettings())
        #expect(page.contains("default-src 'none'"))
        #expect(page.contains("&lt;t&gt;"))
        #expect(!page.contains("<script"))
    }
}

@Suite struct References {
    @Test func scanReportsParserDestinations() throws {
        let source = """
        ![a](img/a.png) ![b][ref] ![c](<path with spaces.png>) ![d](esc\\_aped.png)
        [link](https://x.y) [r][ref] [dup](https://x.y)
        `![no](code.png)` <img src="raw.png">

        ```
        ![fenced](fenced.png)
        ```

        [ref]: ref.png
        """
        let scan = try #require(ReferenceInventoryScan.scan(source))
        #expect(scan.images == ["img/a.png", "ref.png", "path with spaces.png", "esc_aped.png"])
        #expect(scan.links == ["https://x.y", "ref.png"])
        #expect(!scan.truncated)
    }

    @Test func scanBoundsEachList() throws {
        let source = (0..<(ReferenceInventoryScan.listLimit + 5)).map { "![](i\($0).png)" }.joined(separator: "\n")
        let scan = try #require(ReferenceInventoryScan.scan(source))
        #expect(scan.images.count == ReferenceInventoryScan.listLimit)
        #expect(scan.truncated)
    }
}
