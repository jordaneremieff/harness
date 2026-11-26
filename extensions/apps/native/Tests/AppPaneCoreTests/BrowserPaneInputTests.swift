import Foundation
import Testing
@testable import AppPaneCore

struct BrowserPaneInputTests {
    @Test func aCommandTargetsOneTabWithoutGivingTheBrowserFocus() throws {
        var input = BrowserPaneInput()
        let url = "http://127.0.0.1/" + String(repeating: "q", count: 140) + "?name=café"
        let bytes = Array(":tab \(url)\r".utf8)
        let actions = bytes.flatMap { input.feed([$0][...]) }
        #expect(actions == [.newTab(try PaneRequest.address(url))])
        #expect(input.line == nil)
        #expect(input.feed(Array(":tab\r\n".utf8)[...]) == [.newTab(nil)])
        #expect(input.feed([0x71]) == [.quit])
    }

    @Test func refusesDamagedCommandsRatherThanUsingAnAddressPrefix() {
        var input = BrowserPaneInput()
        for bytes in [
            Array(":tab https://example.com/".utf8) + [0xff, 0x0d],
            Array(":tab https://example.com/".utf8) + [0x00, 0x0d],
            Array((":tab https://example.com/" + String(repeating: "x", count: 9000) + "\n").utf8),
            Array(":tab file:///local\r".utf8),
        ] {
            #expect(input.feed(bytes[...]) == [.invalid])
        }
        #expect(input.feed(Array(":tab\r".utf8)[...]) == [.newTab(nil)])
    }
}
