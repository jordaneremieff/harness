import CoreGraphics
import Foundation
import Testing
@testable import AppPaneCore

struct LinkPolicyTests {
    let screen = CGRect(x: 0, y: 0, width: 1800, height: 1169)
    let terminal: pid_t = 30
    /// A window that waits for a hidden tab: one point inside the screen's bottom right corner.
    let parked = CGRect(x: 1799, y: 1168, width: 800, height: 900)
    let paneFrame = CGRect(x: 900, y: 75, width: 890, height: 960)
    let leftPaneFrame = CGRect(x: 0, y: 75, width: 890, height: 960)
    let mainFrame = CGRect(x: 100, y: 120, width: 700, height: 580)
    let terminalFrame = CGRect(x: 0, y: 31, width: 1800, height: 1012)

    var main: BrowserWindow { BrowserWindow(id: "1", bounds: mainFrame) }
    var pane: BrowserWindow { BrowserWindow(id: "2", bounds: paneFrame, inPane: true) }
    var hiddenPane: BrowserWindow { BrowserWindow(id: "3", bounds: parked, inPane: true) }
    var leftPane: BrowserWindow { BrowserWindow(id: "4", bounds: leftPaneFrame, inPane: true) }

    func situation(own: String = "2", shownIn: CGWindowID? = 9, working: CGWindowID? = 9,
                   browserActive: Bool = false, windows: [BrowserWindow]) -> LinkPolicy.Situation {
        LinkPolicy.Situation(own: own, terminalWindow: shownIn, workingWindow: working,
                             browserActive: browserActive, windows: windows, terminalBounds: terminalFrame, screens: [screen])
    }

    @Test func aPaneWhereTheOperatorWorksComesFirst() {
        #expect(LinkPolicy.decide(situation(windows: [main, pane])) == .raise("2"))
        #expect(LinkPolicy.decide(situation(windows: [hiddenPane, main, pane])) == .raise("2"))
        #expect(LinkPolicy.decide(situation(windows: [pane, main])) == .none)
    }

    @Test func aHiddenTabsWindowHandsTheFirstPlaceToTheMainWindow() {
        // The operator's tab has no browser pane, and a window that waits for a hidden tab is first.
        let windows = [hiddenPane, pane, main]
        #expect(LinkPolicy.decide(situation(own: "3", shownIn: nil, windows: windows)) == .raise("1"))
        // A hidden pane whose window is not first leaves the order alone.
        #expect(LinkPolicy.decide(situation(own: "3", shownIn: nil, windows: [main, hiddenPane])) == .none)
    }

    @Test func theMainWindowIsPreferredOverAnotherPanesWindow() {
        #expect(LinkPolicy.decide(situation(own: "3", shownIn: nil, windows: [hiddenPane, leftPane, main])) == .raise("1"))
        // Without a window outside panes, a pane window on screen is better than a hidden one.
        #expect(LinkPolicy.decide(situation(own: "3", shownIn: nil, windows: [hiddenPane, leftPane])) == .raise("4"))
        #expect(LinkPolicy.decide(situation(own: "3", shownIn: nil, windows: [hiddenPane])) == .none)
    }

    @Test func minimisedOrHiddenWindowsDoNotTakeTheFirstPlace() {
        let minimised = BrowserWindow(id: "1", bounds: mainFrame, drawn: false)
        let other = BrowserWindow(id: "7", bounds: CGRect(x: 200, y: 200, width: 600, height: 500))
        #expect(LinkPolicy.decide(situation(own: "3", shownIn: nil, windows: [hiddenPane, minimised, other])) == .raise("7"))
    }

    @Test func twoBrowserPanesOfOneTabKeepTheOperatorsChoice() {
        #expect(LinkPolicy.decide(situation(windows: [leftPane, pane, main])) == .none)
        // A window outside panes gives way even inside the terminal window's bounds.
        let inside = BrowserWindow(id: "8", bounds: CGRect(x: 100, y: 100, width: 600, height: 500))
        #expect(LinkPolicy.decide(situation(windows: [inside, pane])) == .raise("2"))
    }

    @Test func panesWiderThanTheirPaneStillKeepTheOperatorsChoice() {
        // Windows with a minimum size larger than their panes reach past the terminal window.
        let wideLeft = BrowserWindow(id: "4", bounds: CGRect(x: 1300, y: 75, width: 600, height: 960), inPane: true)
        let wideRight = BrowserWindow(id: "2", bounds: CGRect(x: 1600, y: 75, width: 600, height: 960), inPane: true)
        #expect(LinkPolicy.decide(situation(own: "2", windows: [wideLeft, wideRight, main])) == .none)
        #expect(LinkPolicy.decide(situation(own: "4", windows: [wideRight, wideLeft, main])) == .none)
    }

    @Test func aPaneInAnotherTerminalWindowGivesWayToTheMainWindow() {
        #expect(LinkPolicy.decide(situation(shownIn: 9, working: 8, windows: [pane, main])) == .raise("1"))
    }

    @Test func nothingChangesWhileTheBrowserIsActive() {
        #expect(LinkPolicy.decide(situation(browserActive: true, windows: [main, pane])) == .none)
        #expect(LinkPolicy.decide(situation(windows: [])) == .none)
        // A pane window that the order lacks cannot be raised.
        #expect(LinkPolicy.decide(situation(own: "9", windows: [main])) == .none)
    }

    @Test func theWorkingWindowIsUnderThePointerOrInFront() {
        let back = ServerWindow(number: 11, owner: terminal, bounds: CGRect(x: 900, y: 0, width: 900, height: 1000))
        let front = ServerWindow(number: 12, owner: terminal, bounds: CGRect(x: 0, y: 0, width: 900, height: 1000))
        let palette = ServerWindow(number: 13, owner: terminal, layer: 8, bounds: CGRect(x: 1000, y: 400, width: 400, height: 300))
        #expect(LinkPolicy.workingWindow(pointer: CGPoint(x: 1200, y: 500), terminal: [palette, front, back]) == 11)
        #expect(LinkPolicy.workingWindow(pointer: CGPoint(x: 1200, y: 1100), terminal: [front, back]) == 12)
        #expect(LinkPolicy.workingWindow(pointer: .zero, terminal: []) == nil)
    }

    @Test func aParkedWindowIsNotVisible() {
        #expect(!LinkPolicy.visible(parked, screens: [screen]))
        #expect(LinkPolicy.visible(mainFrame, screens: [screen]))
        #expect(!LinkPolicy.visible(mainFrame, screens: []))
    }
}
