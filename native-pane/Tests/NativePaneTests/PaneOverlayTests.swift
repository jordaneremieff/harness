import AppKit
import OSLog
import Testing
@testable import NativePane

@MainActor
struct PaneOverlayTests {
    @Test func keepsTheBottomFixedWhenTheSplitMovesByAFractionOfAPoint() {
        let overlay = PaneOverlay(background: { .black }, logger: Logger(subsystem: "test.NativePane", category: "overlay"))
        overlay.ready = false
        func placed(y: CGFloat, height: CGFloat) -> TerminalAnchor.Placement {
            TerminalAnchor.Placement(frame: CGRect(x: 987.5, y: y, width: 803.5, height: height), host: 0, window: nil,
                                     coveredBy: nil, covers: [])
        }
        overlay.apply(.placed(placed(y: 88.812, height: 185.5)))
        #expect(overlay.window.frame == CGRect(x: 988, y: 89, width: 803, height: 185))
        overlay.apply(.placed(placed(y: 89.112, height: 160.5)))
        #expect(overlay.window.frame == CGRect(x: 988, y: 89, width: 803, height: 161))
    }
}
