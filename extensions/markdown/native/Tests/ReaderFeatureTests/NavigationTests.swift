import Testing
@testable import MarkdownCore
@testable import ReaderFeature

/// Pure interpretation of renderer-owned action addresses and application-shell loads.
@Suite struct NavigationDecisions {
    @Test func applicationShellRequiresAnExpectedLoad() {
        let shell = URL(string: "reader-app://app/index.html")!
        guard case .documentLoad = NavigationRequest.classify(shell, expectingLoad: true) else {
            Issue.record("The application shell was not recognised")
            return
        }
        guard case .blocked = NavigationRequest.classify(shell, expectingLoad: false) else {
            Issue.record("An unsolicited application navigation was not refused")
            return
        }
        guard case .blocked = NavigationRequest.classify(URL(string: "reader-app://other/index.html"), expectingLoad: true) else {
            Issue.record("A foreign application host was not refused")
            return
        }
    }

    @Test func rendererActionsKeepTheirDecodedAnchorAndIdentity() {
        guard case .sameDocument(let anchor) = NavigationRequest.classify(URL(string: "reader-action:jump/caf%C3%A9"), expectingLoad: false) else {
            Issue.record("The section address was not recognised")
            return
        }
        #expect(anchor == "café")
        guard case .inspectImage(let nonce, let index) = NavigationRequest.classify(URL(string: "reader-action:inspect-image/nonce/2"), expectingLoad: false) else {
            Issue.record("The image address was not recognised")
            return
        }
        #expect(nonce == "nonce")
        #expect(index == 2)
    }

    @Test func webAddressesRequireNativeConfirmation() {
        guard case .external = NavigationRequest.classify(URL(string: "https://example.com/a#b"), expectingLoad: false) else {
            Issue.record("The web address did not require confirmation")
            return
        }
        guard case .blocked = NavigationRequest.classify(URL(string: "file:///document.md"), expectingLoad: false) else {
            Issue.record("A file address was not refused")
            return
        }
    }
}
