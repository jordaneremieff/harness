import Testing
@testable import MarkdownCore

struct MarkdownVisualMapTests {
    @Test func projectsSupportedTextWithoutChangingSource() {
        let source = "# Heading\r\n\r\nA **bold** and *soft* [label](https://example.com \"Title\").\r\n"
        let map = MarkdownVisualMap(source: source)
        #expect(map.source.utf8.elementsEqual(source.utf8))
        #expect(map.text == "Heading\r\n\r\nA bold and soft label.\r\n")
        let bold = (map.text as NSString).range(of: "bold")
        #expect(map.editRange(forVisual: bold) == (source as NSString).range(of: "bold"))
        #expect(map.sourceOffset(forVisual: bold.location) == (source as NSString).range(of: "bold").location)
        #expect(map.sourceOffset(forVisual: NSMaxRange(bold)) == NSMaxRange((source as NSString).range(of: "bold")))
        #expect(map.editRange(forVisual: NSRange(location: bold.location - 1, length: 3)) == nil)
    }

    @Test func unsupportedParagraphDropsOnlyItsOwnOverlays() {
        let map = MarkdownVisualMap(source: "# **Title**\n\n**bold** &amp;\n")
        #expect(map.text == "Title\n\n**bold** &amp;\n")
        #expect(map.spans.count == 2)
        #expect(map.spans.contains { $0.role == .heading1 })
        #expect(map.spans.allSatisfy { NSMaxRange($0.range) <= 11 })
    }

    @Test func mixedProseAndInlineCodeKeepTheirOwnPresentation() {
        let source = "Comfortable text has a clear hierarchy. **Strong words**, *emphasis*, and `code` have distinct purposes."
        let map = MarkdownVisualMap(source: source)
        #expect(map.text == "Comfortable text has a clear hierarchy. Strong words, emphasis, and code have distinct purposes.")
        #expect(map.fallbackRanges.isEmpty)
        #expect(map.spans.map(\.role) == [.strong, .emphasis, .inlineCode])
        let code = (map.text as NSString).range(of: "code")
        #expect(map.editRange(forVisual: code) == (source as NSString).range(of: "code"))
        #expect(map.replacing(visual: code, with: "value")?.source == source.replacingOccurrences(of: "`code`", with: "`value`"))
        #expect(map.editRange(forVisual: NSRange(location: code.location - 1, length: 3)) == nil)
        #expect(map.source.utf8.elementsEqual(source.utf8))
    }

    @Test func codeFencesUseParserWidthsAndKeepNormalisedContentAsSource() {
        let source = "# **Use ``a`b``**\r\n"
        let map = MarkdownVisualMap(source: source)
        #expect(map.text == "Use a`b\r\n")
        #expect(map.fallbackRanges.isEmpty)
        let code = (map.text as NSString).range(of: "a`b")
        #expect(map.replacing(visual: code, with: "文")?.source == "# **Use ``文``**\r\n")
        for source in ["**bold** ` padded `", "**bold** `a\nb`", "**bold** `a\r\nb`"] {
            let map = MarkdownVisualMap(source: source)
            #expect(map.text.utf8.elementsEqual(source.utf8))
            #expect(map.hidden.isEmpty)
            #expect(map.spans.isEmpty)
            #expect(!map.fallbackRanges.isEmpty)
        }
    }

    @Test func unsupportedBlocksStayExactAndUnicodeMaps() {
        let source = "# 👩🏽‍💻 e\u{301}\n\n`code` &amp; [ref][id]\n\n[id]: target\n\n![image](asset:x)\n"
        let map = MarkdownVisualMap(source: source)
        #expect(map.text == String(source.dropFirst(2)))
        #expect(map.fallbackRanges.count == 2)
        let visual = (map.text as NSString).range(of: "👩🏽‍💻")
        #expect(map.editRange(forVisual: visual) == (source as NSString).range(of: "👩🏽‍💻"))
        #expect(map.replacing(visual: visual, with: "文")?.source == source.replacingOccurrences(of: "👩🏽‍💻", with: "文"))
    }
}
