import Testing
@testable import MarkdownReader

struct PaneInputTests {
    @Test func keysOutsideACommandLine() {
        var input = PaneInput()
        #expect(input.feed(Array("x".utf8)) == [.focus])
        #expect(input.feed(Array("ab".utf8)) == [.focus], "one focus per read")
        #expect(input.feed(Array("aq".utf8)) == [.focus, .quit])
        #expect(input.feed([3]) == [.quit])
        #expect(input.feed([4]) == [.quit])
        #expect(input.feed(Array("Q".utf8)) == [.quit])
    }

    @Test func aCommandLineCollectsPrintableTextUntilEnter() {
        var input = PaneInput()
        let events = input.feed(Array(":open md-1\r".utf8))
        #expect(events.first == .line(""))
        #expect(events.suffix(2) == [.line(nil), .command("open md-1")])
        #expect(input.line == nil)
        #expect(input.feed(Array(":q\n".utf8)).last == .command("q"), "q inside a line is text, and a line feed also ends it")
    }

    @Test func editingCancellingAndBounds() {
        var input = PaneInput()
        _ = input.feed(Array(":ab".utf8))
        #expect(input.feed([0x7F]) == [.line("a")])
        #expect(input.feed([0x08, 0x7F]) == [.line(""), .line(nil)], "deleting past the start closes the line")
        _ = input.feed(Array(":open".utf8))
        #expect(input.feed([0x1B, UInt8(ascii: "["), UInt8(ascii: "A")]) == [.line(nil)], "escape cancels and its sequence is not text")
        #expect(input.line == nil)
        _ = input.feed(Array(":x".utf8))
        #expect(input.feed([0x1B, 3]) == [.line(nil), .quit], "Ctrl-C after Escape in the same read still ends the reader")
        _ = input.feed(Array(":".utf8))
        _ = input.feed(Array(String(repeating: "x", count: 100).utf8))
        #expect(input.line?.count == PaneInput.limit)
        _ = input.feed([0xC3, 0xA9, 0x07, 0x09])
        #expect(input.line?.count == PaneInput.limit, "non-ASCII and control bytes are not text")
        #expect(input.feed([3]) == [.quit], "Ctrl-C ends the reader even inside a line")
    }

    @Test func commandsNameOnlyFullDocumentIdentities() {
        #expect(PaneCommand("open md-0123456789abcdef0123") == .open("md-0123456789abcdef0123"))
        #expect(PaneCommand("  open   md-0123456789abcdef0123 ") == .open("md-0123456789abcdef0123"))
        #expect(PaneCommand("open") == .unknown("open"))
        #expect(PaneCommand("close md-0123456789abcdef0123") == .unknown("close md-0123456789abcdef0123"))
        #expect(PaneCommand.isDocumentIdentity("md-0123456789abcdef0123"))
        #expect(!PaneCommand.isDocumentIdentity("md-0123456789ABCDEF0123"))
        #expect(!PaneCommand.isDocumentIdentity("md-0123"))
        #expect(!PaneCommand.isDocumentIdentity("../md-0123456789abcdef"))
    }
}
