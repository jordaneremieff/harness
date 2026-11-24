import CoreGraphics
import Foundation
import Testing
@testable import AppPaneCore

struct PaneRequestTests {
    @Test func parsesTheApplicationAndOneChoice() throws {
        #expect(try PaneRequest.parse(["--app", " Slack "]) == PaneRequest(app: "Slack"))
        let browser = try PaneRequest.parse(["--app", "com.brave.Browser", "--url", "https://example.com/a?b=c"])
        #expect(browser.url?.absoluteString == "https://example.com/a?b=c")
        #expect(try PaneRequest.parse(["--window", "Inbox", "--app", "Mail"]).window == "Inbox")
    }

    @Test func refusesInvalidArguments() {
        #expect(throws: PaneRequest.Invalid.self) { try PaneRequest.parse([]) }
        #expect(throws: PaneRequest.Invalid.self) { try PaneRequest.parse(["--app"]) }
        #expect(throws: PaneRequest.Invalid.self) { try PaneRequest.parse(["--app", "A", "--app", "B"]) }
        #expect(throws: PaneRequest.Invalid.self) { try PaneRequest.parse(["--app", "A", "--other", "B"]) }
        #expect(throws: PaneRequest.Invalid.self) { try PaneRequest.parse(["--app", "  "]) }
        #expect(throws: PaneRequest.Invalid.self) { try PaneRequest.parse(["--app", "A\u{7}"]) }
        #expect(throws: PaneRequest.Invalid.self) { try PaneRequest.parse(["--app", "A", "--url", "https://a.example", "--window", "x"]) }
    }

    @Test func acceptsOnlyWebAddresses() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "https://", "https://a b.example", "example.com", "https://a.example/\n"] {
            #expect(throws: PaneRequest.Invalid.self, "\(bad)") { try PaneRequest.address(bad) }
        }
        #expect((try? PaneRequest.address("http://127.0.0.1:8080/x")) != nil)
    }
}

struct ApplicationsTests {
    let entries = [
        AppEntry(name: "Brave Browser", path: "/Applications/Brave Browser.app", bundleIdentifier: "com.brave.Browser", running: true),
        AppEntry(name: "Google Chrome", path: "/Applications/Google Chrome.app", bundleIdentifier: "com.google.Chrome", running: false),
        AppEntry(name: "Sublime Text", path: "/Applications/Sublime Text.app", bundleIdentifier: "com.sublimetext.4", running: true),
        AppEntry(name: "Slack", path: "/Applications/Slack.app", bundleIdentifier: "com.tinyspeck.slackmacgap", running: false),
        AppEntry(name: "Notes", path: "/System/Applications/Notes.app", bundleIdentifier: "com.apple.Notes", running: false),
        AppEntry(name: "Notion", path: "/Applications/Notion.app", bundleIdentifier: "notion.id", running: false),
    ]

    @Test func matchesNamesWordsAndIdentifiers() {
        #expect(Applications.match("brave", in: entries) == .found(entries[0]))
        #expect(Applications.match("Sublime", in: entries) == .found(entries[2]))
        #expect(Applications.match("chrome", in: entries) == .found(entries[1]))
        #expect(Applications.match("google chrome.app", in: entries) == .found(entries[1]))
        #expect(Applications.match("com.tinyspeck.slackmacgap", in: entries) == .found(entries[3]))
        #expect(Applications.match("slack", in: entries) == .found(entries[3]))
        #expect(Applications.match("text", in: entries) == .found(entries[2]))
        #expect(Applications.match("zoom", in: entries) == .missing)
        #expect(Applications.match("  ", in: entries) == .missing)
    }

    @Test func reportsSeveralApplicationsForAnAmbiguousName() {
        guard case .ambiguous(let found) = Applications.match("no", in: entries) else {
            Issue.record("expected an ambiguous match")
            return
        }
        #expect(Set(found.map(\.name)) == ["Notes", "Notion"])
    }

    @Test func prefersTheOnlyRunningApplicationOfSeveral() {
        let both = [
            AppEntry(name: "Code", path: "/Applications/Code.app", bundleIdentifier: "a.code", running: false),
            AppEntry(name: "Codex", path: "/Applications/Codex.app", bundleIdentifier: "a.codex", running: true),
        ]
        #expect(Applications.match("cod", in: both) == .found(both[1]))
    }

    @Test func mergesOneEntryPerPathWithRunningFirst() {
        let merged = Applications.merged([
            AppEntry(name: "B", path: "/b", bundleIdentifier: nil, running: false),
            AppEntry(name: "A", path: "/a", bundleIdentifier: nil, running: false),
            AppEntry(name: "B", path: "/b", bundleIdentifier: nil, running: true),
        ])
        #expect(merged.map(\.path) == ["/b", "/a"])
        #expect(merged[0].running)
    }

    @Test func knowsWhichApplicationsAreScriptableBrowsers() {
        #expect(entries[0].browser)
        #expect(entries[1].browser)
        #expect(!entries[3].browser)
        #expect(BrowserScripting(bundleIdentifier: "com.apple.Safari") == .safari)
        #expect(BrowserScripting(bundleIdentifier: nil) == nil)
    }

    @Test func writesNewWindowScriptsWithQuotedValues() throws {
        let url = try PaneRequest.address("https://example.com/?q=%22x%22")
        let chromium = try #require(BrowserScripting.chromium.newWindowScript(bundleIdentifier: "com.brave.Browser", url: url))
        #expect(chromium == """
        tell application id "com.brave.Browser"
        set newWindow to make new window
        set URL of active tab of newWindow to "https://example.com/?q=%22x%22"
        return id of newWindow
        end tell
        """)
        let safari = try #require(BrowserScripting.safari.newWindowScript(bundleIdentifier: "com.apple.Safari", url: nil))
        #expect(safari.contains("make new document\nreturn id of front window"))
        #expect(BrowserScripting.chromium.newWindowScript(bundleIdentifier: "bad\" id", url: nil) == nil)
        #expect(BrowserScripting.quoted("a\"b\\c") == "\"a\\\"b\\\\c\"")
    }
}

struct GeometryTests {
    @Test func convertsAppKitFramesToAccessibilityFrames() {
        let pane = CGRect(x: 900, y: 82, width: 900, height: 500)
        #expect(Geometry.accessibilityRect(pane, primaryHeight: 1125) == CGRect(x: 900, y: 543, width: 900, height: 500))
    }

    @Test func snapsEachEdgeToTheNearestPoint() {
        #expect(Geometry.snapped(CGRect(x: 10.4, y: 20.6, width: 99.2, height: 50.3)) == CGRect(x: 10, y: 21, width: 100, height: 50))
    }

    @Test func parksInTheBottomRightCornerOfTheScreen() {
        let screen = CGRect(x: 0, y: 0, width: 1800, height: 1125)
        #expect(Geometry.parkingOrigin(screen: screen, primaryHeight: 1125) == CGPoint(x: 1799, y: 1124))
        let second = CGRect(x: 1800, y: 100, width: 1000, height: 800)
        #expect(Geometry.parkingOrigin(screen: second, primaryHeight: 1125) == CGPoint(x: 2799, y: 1024))
    }

    @Test func choosesTheMainWindowOrATitledOne() {
        let windows = [
            WindowCandidate(title: "Palette", standard: false, main: true),
            WindowCandidate(title: "Old", standard: true, minimized: true),
            WindowCandidate(title: "General", standard: true, focused: true),
            WindowCandidate(title: "Inbox", standard: true, main: true, taken: true),
            WindowCandidate(title: "Drafts", standard: true),
        ]
        #expect(WindowCandidate.choose(windows, title: nil) == 2)
        #expect(WindowCandidate.choose(windows, title: "draft") == 4)
        #expect(WindowCandidate.choose(windows, title: "inbox") == nil)
        #expect(WindowCandidate.choose(windows, title: "palette") == nil)
        #expect(WindowCandidate.choose([WindowCandidate(title: "A", standard: true, minimized: true)], title: nil) == 0)
        #expect(WindowCandidate.choose([], title: nil) == nil)
    }
}
