import Testing
@testable import MarkdownReader

struct PaneCommandTests {
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
