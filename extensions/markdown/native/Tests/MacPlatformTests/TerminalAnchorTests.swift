import CoreGraphics
import Testing
@testable import MacPlatform

/// Pure parts of the pane reader's placement: coordinates, window matching and terminal text.
@Suite struct TerminalPlacement {
    @Test func convertsAccessibilityFramesToAppKitScreenCoordinates() {
        let pane = CGRect(x: 250, y: 75, width: 1260, height: 470)
        #expect(TerminalAnchor.appKitRect(pane, primaryHeight: 1117) == CGRect(x: 250, y: 572, width: 1260, height: 470))
        // A display above the primary display has negative accessibility y and AppKit y above its height.
        let above = CGRect(x: 0, y: -900, width: 800, height: 600)
        #expect(TerminalAnchor.appKitRect(above, primaryHeight: 1117) == CGRect(x: 0, y: 1417, width: 800, height: 600))
    }

    @Test func matchesOnlyTheHostsNormalWindowAtTheFrame() {
        let frame = CGRect(x: 0, y: 31, width: 1518, height: 522)
        func info(pid: Int32 = 42, layer: Int = 0, x: Double = 0, y: Double = 31, width: Double = 1518) -> [String: Any] {
            [kCGWindowOwnerPID as String: pid, kCGWindowLayer as String: layer, kCGWindowNumber as String: 7,
             kCGWindowBounds as String: ["X": x, "Y": y, "Width": width, "Height": 522.0]]
        }
        #expect(TerminalAnchor.matches(info(), host: 42, frame: frame))
        #expect(TerminalAnchor.matches(info(x: 1.5), host: 42, frame: frame))
        #expect(!TerminalAnchor.matches(info(pid: 43), host: 42, frame: frame))
        #expect(!TerminalAnchor.matches(info(layer: 3), host: 42, frame: frame))
        #expect(!TerminalAnchor.matches(info(width: 1500), host: 42, frame: frame))
    }

    @Test func namesTheHostWindowOnlyWhenOneRecordFits() {
        let frame = CGRect(x: 0, y: 31, width: 1518, height: 522)
        func info(_ number: CGWindowID, title: String) -> [String: Any] {
            [kCGWindowOwnerPID as String: Int32(42), kCGWindowLayer as String: 0, kCGWindowNumber as String: number, kCGWindowName as String: title,
             kCGWindowBounds as String: ["X": 0.0, "Y": 31.0, "Width": 1518.0, "Height": 522.0]]
        }
        #expect(TerminalAnchor.uniqueWindow([info(7, title: "a")], host: 42, frame: frame, title: nil) == 7)
        #expect(TerminalAnchor.uniqueWindow([info(7, title: "a"), info(8, title: "b")], host: 42, frame: frame, title: "b") == 8)
        #expect(TerminalAnchor.uniqueWindow([info(7, title: "a"), info(8, title: "a")], host: 42, frame: frame, title: "a") == nil)
        #expect(TerminalAnchor.uniqueWindow([], host: 42, frame: frame, title: "a") == nil)
    }

    @Test func printableTextCannotControlTheTerminal() {
        let hostile = "Title\u{1B}]52;c;ZXZpbA==\u{07}\u{1B}[2J\u{9B}31m\u{202E}txet\u{2028}end\u{0}"
        let shown = TerminalText.printable(hostile)
        #expect(!shown.unicodeScalars.contains { $0.value < 0x20 || (0x7F...0x9F).contains($0.value) })
        #expect(!shown.contains("\u{202E}"))
        #expect(!shown.contains("\u{2028}"))
        #expect(shown.hasPrefix("Title]52;c;ZXZpbA==[2J31mtxetend"))
        #expect(TerminalText.printable("Reading notes ✓ — día 2") == "Reading notes ✓ — día 2")
    }

    @Test func fitsAndWrapsPlaceholderLines() {
        #expect(TerminalText.fit("abcdef", 4) == "abc…")
        #expect(TerminalText.fit("abc", 4) == "abc")
        #expect(TerminalText.wrap("one two three four", 9) == ["one two", "three", "four"])
        #expect(TerminalText.wrap("averyveryverylongword", 6) == ["avery…"])
    }
}
