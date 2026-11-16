import Testing
@testable import MarkdownCore

private func edit(
    _ command: MarkdownCommand,
    _ source: String,
    _ selection: NSRange,
    protectedRanges: [NSRange] = []
) -> MarkdownEdit? {
    MarkdownCommands.apply(command: command, to: source, selection: selection, protectedRanges: protectedRanges)
}

private func range(_ location: Int, _ length: Int) -> NSRange {
    NSRange(location: location, length: length)
}

private func applying(_ edit: MarkdownEdit?, to source: String) -> String {
    guard let edit else { return source }
    return (source as NSString).replacingCharacters(in: edit.range, with: edit.replacement)
}

@Suite struct MarkdownFormattingTests {
    @Test func inlineFormattingKeepsBoundaryWhitespaceOutsideMarkers() throws {
        let source = "Before  word \t after"
        let selected = (source as NSString).range(of: " word \t")
        for (command, tag) in [(MarkdownCommand.bold, "strong"), (.italic, "em"), (.strikethrough, "del")] {
            let change = try #require(edit(command, source, selected))
            let changed = applying(change, to: source)
            let html = MarkdownRenderer.render(changed, resolver: NoAssetResolver()).body
            #expect(html.contains("<\(tag)>word</\(tag)>"))
            #expect((changed as NSString).substring(with: change.selection) == "word")
            #expect(edit(command, " \t ", range(0, 3)) == nil)
            #expect(edit(command, "", range(0, 0)) != nil)
        }
    }

    @Test func inlineCodePreservesWhitespaceOnlyAndPaddedLiterals() throws {
        for literal in [" ", "  ", "   ", " code ", "`inner`"] {
            let change = try #require(edit(.inlineCode, literal, range(0, literal.utf16.count)))
            let html = MarkdownRenderer.render(change.replacement, resolver: NoAssetResolver()).body
            #expect(html.contains("<code>\(literal)</code>"))
            #expect((change.replacement as NSString).substring(with: change.selection).utf8.elementsEqual(literal.utf8))
        }
    }

    @Test func lineCommandsUseCarriageReturnsAndPreserveMixedEndings() throws {
        for source in ["one\rtwo\rthree", "one\rtwo\r\nthree", "one\ntwo\rthree"] {
            let selected = (source as NSString).range(of: "two")
            let change = try #require(edit(.heading(1), source, NSRange(location: selected.location, length: 0)))
            #expect(applying(change, to: source).utf8.elementsEqual(source.replacingOccurrences(of: "two", with: "# two").utf8))
        }
        #expect(applying(edit(.moveLineUp, "one\rtwo\rthree", range(4, 0)), to: "one\rtwo\rthree") == "two\rone\rthree")
        #expect(applying(edit(.duplicateLine, "one\rtwo\rthree", range(4, 0)), to: "one\rtwo\rthree") == "one\rtwo\rtwo\rthree")
        #expect(edit(.continueList, "- one\r- two\r", range(11, 0))?.replacement == "\r- ")
        #expect(edit(.fencedCode(language: nil), "code\r", range(0, 4))?.replacement == "```\rcode\r```\r")
    }

    @Test func headingsSetRemoveAndPreserveSurroundingLines() {
        let set = edit(.heading(2), "# Alpha\nbeta\n", range(0, 0))
        #expect(set?.range == range(0, 8))
        #expect(set?.replacement == "## Alpha\n")
        #expect(set?.selection == range(0, 9))
        #expect(set?.actionName == "Set Heading")

        let removed = edit(.heading(0), "## Alpha\n", range(0, 0))
        #expect(removed?.range == range(0, 9))
        #expect(removed?.replacement == "Alpha\n")
        #expect(removed?.selection == range(0, 6))

        let multiline = edit(.heading(1), "# One\n## Two\n", range(0, 13))
        #expect(multiline?.replacement == "# One\n# Two\n")
        #expect(edit(.heading(7), "text\n", range(0, 0)) == nil)
    }

    @Test func inlineFormattingWrapsTheSelectionAndLeavesACaretInside() {
        let source = "hello world"
        let bold = edit(.bold, source, range(6, 5))
        #expect(bold?.range == range(6, 5))
        #expect(bold?.replacement == "**world**")
        #expect(bold?.selection == range(8, 5))

        let italic = edit(.italic, source, range(0, 5))
        #expect(italic?.replacement == "*hello*")
        #expect(italic?.selection == range(1, 5))

        let strike = edit(.strikethrough, source, range(6, 5))
        #expect(strike?.replacement == "~~world~~")
        #expect(strike?.selection == range(8, 5))

        let link = edit(.link, source, range(6, 5))
        #expect(link?.replacement == "[world]()")
        #expect(link?.selection == range(7, 5))

        let empty = edit(.bold, "abc", range(1, 0))
        #expect(empty?.range == range(1, 0))
        #expect(empty?.replacement == "****")
        #expect(empty?.selection == range(3, 0))
    }

    @Test func inlineCodeAndFencedCodeAreDeliberateSourceOperations() {
        let inline = edit(.inlineCode, "hello world", range(6, 5))
        #expect(inline?.replacement == "`world`")
        #expect(inline?.selection == range(7, 5))

        let fenced = edit(.fencedCode(language: "swift"), "let x = 1\nplain\n", range(0, 9))
        #expect(fenced?.range == range(0, 10))
        #expect(fenced?.replacement == "```swift\nlet x = 1\n```\n")
        #expect(fenced?.selection == range(9, 10))

        let protected = range(11, 4)
        #expect(edit(.bold, "before\n```\ncode\n```\nafter\n", protected, protectedRanges: [protected]) == nil)
        let wrapped = edit(.inlineCode, "before\n```\ncode\n```\nafter\n", protected, protectedRanges: [protected])
        #expect(wrapped?.replacement == "`code`")
    }

    @Test func quoteListsAndIndentPreserveLines() {
        let quoted = edit(.quote, "one\n\ntwo\n", range(0, 9))
        #expect(quoted?.replacement == "> one\n\n> two\n")
        let unquoted = edit(.quote, "> one\n\n> two\n", range(0, 11))
        #expect(unquoted?.replacement == "one\n\ntwo\n")

        let unordered = edit(.unorderedList, "one\ntwo\n", range(0, 8))
        #expect(unordered?.replacement == "- one\n- two\n")
        let ordered = edit(.orderedList, "one\ntwo\n", range(0, 8))
        #expect(ordered?.replacement == "1. one\n2. two\n")
        let tasks = edit(.taskList, "one\ntwo\n", range(0, 8))
        #expect(tasks?.replacement == "- [ ] one\n- [ ] two\n")

        let converted = edit(.unorderedList, "- one\n1. two\n", range(0, 13))
        #expect(converted?.replacement == "- one\n- two\n")

        let indented = edit(.indent, "one\n  two\n", range(0, 10))
        #expect(indented?.replacement == "  one\n    two\n")
        let outdented = edit(.outdent, "  one\n    two\n", range(0, 14))
        #expect(outdented?.replacement == "one\n  two\n")
    }

    @Test func unicodeSelectionsAndInvalidSplitRanges() {
        let japanese = "日本語 text"
        let bold = edit(.bold, japanese, range(0, 3))
        #expect(bold?.replacement == "**日本語**")
        #expect(bold?.selection == range(2, 3))

        let emoji = "👩🏽‍💻"
        let whole = (emoji as NSString).length
        #expect(edit(.bold, emoji + " code", range(0, whole))?.replacement == "**\(emoji)**")
        #expect(edit(.bold, emoji + " code", range(1, 0)) == nil)
        #expect(edit(.bold, emoji + " code", range(0, 1)) == nil)

        let combining = "e\u{301}x"
        #expect(edit(.bold, combining, range(0, 2))?.replacement == "**e\u{301}**")
        #expect(edit(.bold, combining, range(1, 0)) == nil)

        let surrogate = "😀"
        #expect(edit(.bold, surrogate, range(1, 0)) == nil)
        #expect(edit(.bold, surrogate, range(0, 2))?.replacement == "**😀**")
        #expect(edit(.bold, "plain", range(0, 99)) == nil)
        #expect(edit(.bold, "plain", range(NSNotFound, 0)) == nil)
    }

    @Test func crlfIsKeptByEveryLineCommand() {
        let heading = edit(.heading(2), "# A\r\nB\r\n", range(0, 0))
        #expect(heading?.range == range(0, 5))
        #expect(heading?.replacement == "## A\r\n")
        #expect(heading?.selection == range(0, 6))

        let list = edit(.unorderedList, "one\r\ntwo\r\n", range(0, 10))
        #expect(list?.replacement == "- one\r\n- two\r\n")

        let continuation = edit(.continueList, "- a\r\n", range(3, 0))
        #expect(continuation?.replacement == "\r\n- ")
        #expect(continuation?.selection == range(7, 0))
    }
}

@Suite struct MarkdownLineAndListTests {
    @Test func lineMovementSwapsWholeLines() {
        let up = edit(.moveLineUp, "a\r\nb\r\nc\r\n", range(3, 1))
        #expect(up?.range == range(0, 6))
        #expect(up?.replacement == "b\r\na\r\n")
        #expect(up?.selection == range(0, 3))

        let down = edit(.moveLineDown, "a\r\nb\r\nc\r\n", range(3, 1))
        #expect(down?.range == range(3, 6))
        #expect(down?.replacement == "c\r\nb\r\n")
        #expect(down?.selection == range(6, 3))

        #expect(edit(.moveLineUp, "a\nb\n", range(0, 1)) == nil)
        #expect(edit(.moveLineDown, "a\nb\n", range(2, 1)) == nil)
    }

    @Test func duplicationKeepsLineEndingsAndSelectsTheCopy() {
        let copy = edit(.duplicateLine, "a\r\nb\r\nc\r\n", range(3, 1))
        #expect(copy?.range == range(3, 3))
        #expect(copy?.replacement == "b\r\nb\r\n")
        #expect(copy?.selection == range(6, 3))

        let last = edit(.duplicateLine, "a\nb", range(2, 1))
        #expect(last?.range == range(2, 1))
        #expect(last?.replacement == "b\nb")
        #expect(last?.selection == range(4, 1))
    }

    @Test func listContinuationUsesTheCurrentItemAndFinishesEmptyItems() {
        let bullet = edit(.continueList, "- one\n", range(5, 0))
        #expect(bullet?.range == range(5, 0))
        #expect(bullet?.replacement == "\n- ")
        #expect(bullet?.selection == range(8, 0))

        let ordered = edit(.continueList, "1. a\n", range(4, 0))
        #expect(ordered?.replacement == "\n2. ")
        #expect(ordered?.selection == range(8, 0))

        let task = edit(.continueList, "- [ ] a\n", range(7, 0))
        #expect(task?.replacement == "\n- [ ] ")
        #expect(task?.selection == range(14, 0))

        let nested = edit(.continueList, "  - a\n", range(5, 0))
        #expect(nested?.replacement == "\n  - ")
        #expect(nested?.selection == range(10, 0))

        let finished = edit(.continueList, "- \n", range(2, 0))
        #expect(finished?.range == range(0, 2))
        #expect(finished?.replacement == "")
        #expect(finished?.selection == range(0, 0))

        let finishedTask = edit(.continueList, "- [ ] \n", range(6, 0))
        #expect(finishedTask?.range == range(0, 6))
        #expect(finishedTask?.replacement == "")
        #expect(finishedTask?.selection == range(0, 0))

        #expect(edit(.continueList, "plain\n", range(5, 0)) == nil)
        #expect(edit(.continueList, "- one\n", range(0, 2)) == nil)
    }

    @Test func tableInsertionIsOneBlockAtTheCaret() {
        let inserted = edit(.insertTable, "", range(0, 0))
        #expect(inserted?.range == range(0, 0))
        #expect(inserted?.replacement == "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n")
        #expect(inserted?.selection == range(2, 8))
        #expect(inserted?.actionName == "Insert Table")

        let crlf = edit(.insertTable, "\r\n", range(0, 0))
        #expect(crlf?.replacement == "| Column 1 | Column 2 |\r\n| --- | --- |\r\n|  |  |\r\n")
    }

    @Test func protectedCodeRefusesStructuralFormatting() {
        let protected = range(0, 4)
        #expect(edit(.heading(1), "code\n", range(0, 0), protectedRanges: [protected]) == nil)
        #expect(edit(.outdent, "  code\n", range(0, 0), protectedRanges: [range(2, 4)]) == nil)
        #expect(edit(.bold, "plain code\n", range(6, 4), protectedRanges: [range(6, 4)]) == nil)
        #expect(edit(.bold, "plain code\n", range(0, 5), protectedRanges: [range(6, 4)])?.replacement == "**plain**")
    }

    @Test func continueListRefusesACaretInsideTheMarkerOrIndent() {
        // "1. a": marker "1. " spans 0..<3; a caret inside it must fall back to a native Return.
        for caret in 0...2 {
            #expect(edit(.continueList, "1. a\n", range(caret, 0)) == nil, "caret \(caret)")
        }
        #expect(edit(.continueList, "1. a\n", range(3, 0))?.replacement == "\n2. ")

        // "- a": marker spans 0..<2; the indent line start is refused too.
        #expect(edit(.continueList, "- a\n", range(0, 0)) == nil)
        #expect(edit(.continueList, "- a\n", range(1, 0)) == nil)
        #expect(edit(.continueList, "- a\n", range(2, 0))?.replacement == "\n- ")

        // Nested item: the indent itself is part of the refused region.
        #expect(edit(.continueList, "  - a\n", range(0, 0)) == nil)
        #expect(edit(.continueList, "  - a\n", range(2, 0)) == nil)
        #expect(edit(.continueList, "  - a\n", range(3, 0)) == nil)
        #expect(edit(.continueList, "  - a\n", range(4, 0))?.replacement == "\n  - ")

        // An empty item keeps finishing, but only from its own caret position.
        #expect(edit(.continueList, "- \n", range(1, 0)) == nil)
        #expect(edit(.continueList, "- \n", range(2, 0))?.replacement == "")
    }

    @Test func orderedMarkersFollowASCIIDigitsAndTheNineDigitBound() {
        // More than 9 digits is overlong, never a list, and never an Int conversion.
        let overlong = "12345678901234567890123456789. x\n"
        #expect(edit(.continueList, overlong, range(31, 0)) == nil)
        #expect(edit(.orderedList, overlong + "plain\n", range(0, overlong.utf16.count + 5)) != nil)

        // Exactly 10 digits is one past the CommonMark bound.
        #expect(edit(.continueList, "1234567890. x\n", range(12, 0)) == nil)

        // Continuation never creates a marker outside the Markdown digit bound.
        let nine = edit(.continueList, "999999998. x\n", range(11, 0))
        #expect(nine?.replacement == "\n999999999. ")
        #expect(edit(.continueList, "999999999. x\n", range(11, 0)) == nil)

        // Non-ASCII digits are not Markdown ordered markers.
        let arabic = "\u{0661}\u{0662}. x\n"
        #expect(edit(.continueList, arabic, range(5, 0)) == nil)
        let decorated = "1\u{FE0F}. x\n"
        #expect(edit(.continueList, decorated, range(5, 0)) == nil)
        #expect(edit(.orderedList, decorated, range(0, 0))?.replacement == "1. \(decorated)")

        // Converting stray markers still renumbers from 1.
        let converted = edit(.orderedList, "x\ny\n", range(0, 3))
        #expect(converted?.replacement == "1. x\n2. y\n")
    }
}

@Suite struct MarkdownLiteralTests {
    private let source = "Cat cat catalog CAT\nsecond cat\n"

    @Test func literalMatchesHonourCaseAndWholeWord() {
        let sensitiveWhole = MarkdownCommands.matches(of: "cat", in: source, wholeWord: true)
        #expect(sensitiveWhole.map(\.range) == [range(4, 3), range(27, 3)])

        let foldedWhole = MarkdownCommands.matches(of: "cat", in: source, caseSensitive: false, wholeWord: true)
        #expect(foldedWhole.map(\.range) == [range(0, 3), range(4, 3), range(16, 3), range(27, 3)])

        let sensitiveAll = MarkdownCommands.matches(of: "cat", in: source)
        #expect(sensitiveAll.map(\.range) == [range(4, 3), range(8, 3), range(27, 3)])
        #expect(sensitiveAll.allSatisfy { $0.text.lowercased() == "cat" })
    }

    @Test func literalMatchesAreBoundedAndRejectSplitScopes() {
        let bounded = MarkdownCommands.matches(of: "x", in: "x x x x", limit: 2)
        #expect(bounded.map(\.range) == [range(0, 1), range(2, 1)])
        #expect(MarkdownCommands.matches(of: "x", in: "x x x x", limit: 0).isEmpty)

        let split = MarkdownLiteralQuery(text: "cat", scope: range(1, 0))
        #expect(MarkdownCommands.matches(split, in: "😀 cat").isEmpty)
    }

    @Test func replaceAndReplaceAllUseLiteralRanges() {
        let first = edit(.replace(MarkdownLiteralQuery(text: "one", wholeWord: true), with: "1"), "one two one", range(0, 0))
        #expect(first?.range == range(0, 3))
        #expect(first?.replacement == "1")
        #expect(first?.selection == range(1, 0))
        #expect(applying(first, to: "one two one") == "1 two one")

        let all = edit(.replaceAll(MarkdownLiteralQuery(text: "one", wholeWord: true), with: "1"), "one two one", range(0, 0))
        #expect(all?.range == range(0, 11))
        #expect(all?.replacement == "1 two 1")
        #expect(all?.selection == range(7, 0))
        #expect(applying(all, to: "one two one") == "1 two 1")
    }

    @Test func scopedCaseInsensitiveReplaceAllLeavesTheRestAlone() {
        let scope = range(20, 11)
        let query = MarkdownLiteralQuery(text: "cat", caseSensitive: false, wholeWord: true, scope: scope)
        let replaced = edit(.replaceAll(query, with: "dog"), source, range(0, 0))
        #expect(replaced?.range == range(27, 3))
        #expect(replaced?.replacement == "dog")
        #expect(applying(replaced, to: source) == "Cat cat catalog CAT\nsecond dog\n")
    }

    @Test func wholeDocumentReplaceAllRewritesOnlyWholeMatches() {
        let query = MarkdownLiteralQuery(text: "cat", caseSensitive: false, wholeWord: true)
        let replaced = edit(.replaceAll(query, with: "dog"), source, range(0, 0))
        #expect(replaced?.range == range(0, 30))
        #expect(replaced?.replacement == "dog dog catalog dog\nsecond dog")
        #expect(replaced?.selection == range(30, 0))
        #expect(applying(replaced, to: source) == "dog dog catalog dog\nsecond dog\n")
    }

    @Test func replaceAllRefusesAboveTheBoundInsteadOfTruncating() {
        let query = MarkdownLiteralQuery(text: "a")

        // More matches than replaceAllLimit: refuse, never replace only the first 10_000.
        let over = Array(repeating: "a", count: MarkdownCommands.replaceAllLimit + 1).joined(separator: " ")
        #expect(edit(.replaceAll(query, with: "b"), over, range(0, 0)) == nil)

        // Exactly at the bound is still one edit with every occurrence replaced.
        let at = Array(repeating: "a", count: MarkdownCommands.replaceAllLimit).joined(separator: " ")
        let bounded = edit(.replaceAll(query, with: "b"), at, range(0, 0))
        #expect(bounded != nil)
        #expect(bounded?.replacement == Array(repeating: "b", count: MarkdownCommands.replaceAllLimit).joined(separator: " "))
        #expect(applying(bounded, to: at) == bounded?.replacement)
    }

    @Test func literalReplaceIsAnExplicitSourceOperationInsideCode() {
        let protected = range(6, 4)
        let one = edit(.replace(MarkdownLiteralQuery(text: "code"), with: "text"), "plain code\n", range(0, 0), protectedRanges: [protected])
        #expect(one?.range == range(6, 4))
        #expect(one?.replacement == "text")
        #expect(applying(one, to: "plain code\n") == "plain text\n")

        let all = edit(.replaceAll(MarkdownLiteralQuery(text: "code"), with: "text"), "plain code code\n", range(0, 0), protectedRanges: [protected])
        #expect(applying(all, to: "plain code code\n") == "plain text text\n")

        // Structural commands still refuse protected code.
        #expect(edit(.heading(1), "code\n", range(0, 0), protectedRanges: [range(0, 4)]) == nil)
    }
}
