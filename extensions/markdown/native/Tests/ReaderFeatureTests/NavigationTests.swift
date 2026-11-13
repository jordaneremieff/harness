import Testing
@testable import MarkdownCore
@testable import ReaderFeature

/// The reader's decision for each navigation that its page asks for.
@Suite struct NavigationDecisions {
    @Test func inPageLinksStayInTheDocumentInBothSpellings() {
        for spelling in ["about:blank#limits", "about:blank%23limits"] {
            guard case .sameDocument = NavigationRequest.classify(URL(string: spelling), expectingLoad: false) else {
                Issue.record("\(spelling) did not stay in the document")
                continue
            }
        }
    }

    @Test func otherAboutAddressesAreRefusedUnlessTheReaderLoads() {
        guard case .blocked = NavigationRequest.classify(URL(string: "about:blank"), expectingLoad: false) else {
            Issue.record("about:blank was not refused")
            return
        }
        guard case .documentLoad = NavigationRequest.classify(URL(string: "about:blank"), expectingLoad: true) else {
            Issue.record("the reader's own load was not allowed")
            return
        }
        guard case .external = NavigationRequest.classify(URL(string: "https://example.com/a#b"), expectingLoad: false) else {
            Issue.record("a web link did not go to the browser confirmation")
            return
        }
    }
}
