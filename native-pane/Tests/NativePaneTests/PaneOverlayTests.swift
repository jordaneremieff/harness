import CoreGraphics
import Testing
@testable import NativePane

@MainActor
struct PaneOverlayTests {
    @Test func extendsUpOnlyAndStopsAtContentTop() {
        let pane = CGRect(x: 40, y: 70, width: 700, height: 146)
        let content = CGRect(x: 40, y: 70, width: 700, height: 300)
        let applied = PaneOverlay.extendedFrame(pane, content: content, above: 192)
        #expect(applied == content)
        let smaller = PaneOverlay.extendedFrame(pane, content: content, above: 80)
        #expect(smaller == CGRect(x: 40, y: 70, width: 700, height: 226))
        #expect(PaneOverlay.extendedFrame(pane, content: content, above: 0) == pane)
        #expect(PaneOverlay.extendedFrame(pane, content: nil, above: 80) == pane)
    }
}
