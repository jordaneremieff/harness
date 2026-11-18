import AppKit
import OSLog
import Testing
@testable import NativePane

@MainActor
struct PaneOverlayTests {
    private func fixture() -> (PaneOverlay, TerminalAnchor.Placement) {
        let overlay = PaneOverlay(background: { .black }, logger: Logger(subsystem: "test.NativePane", category: "overlay"))
        overlay.ready = false
        let pane = CGRect(x: 40, y: 70, width: 700, height: 146)
        let placement = TerminalAnchor.Placement(frame: pane, host: 0, window: nil,
                                                  contentFrame: pane.insetBy(dx: 0, dy: -154), coveredBy: nil, covers: [])
        overlay.apply(.placed(placement))
        return (overlay, placement)
    }

    @Test func extendsBeforeReplyAndTransfersGrowthToAuthoritativeFrame() throws {
        let (overlay, placement) = fixture()
        overlay.grow(to: 171)
        let reply = overlay.extendAbove(100)
        #expect(reply == 100)
        #expect(overlay.appliedGrowth == 25)
        let before = overlay.window.frame
        #expect(before.height == 271)
        #expect(before.minY == placement.frame.minY)
        // Render the layer tree as it stands immediately after the reply, before another run-loop turn.
        let bitmap = try #require(CGContext(data: nil, width: 700, height: 271, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        overlay.content.updateLayer()
        overlay.content.layer?.render(in: bitmap)
        let bytes = try #require(bitmap.data?.assumingMemoryBound(to: UInt8.self))
        func alpha(_ y: Int) -> UInt8 { bytes[(270 - y) * bitmap.bytesPerRow + 4 * 350 + 3] }
        #expect(alpha(80) == 255)
        #expect(alpha(147) == 0)
        #expect(alpha(260) == 0)
        var settled = placement
        settled.frame.size.height = 171
        overlay.apply(.placed(settled))
        #expect(overlay.appliedGrowth == 0)
        #expect(overlay.window.frame == before)
    }

    @Test func predictsShrinkWithFixedBottomAndAcceptsAXCorrection() {
        let (overlay, placement) = fixture()
        overlay.predictShrink(to: 123, from: placement.frame)
        #expect(overlay.window.frame.height == 123)
        #expect(overlay.window.frame.minY == placement.frame.minY)
        overlay.apply(.placed(placement)) // A stale poll must not roll the prediction back.
        #expect(overlay.window.frame.height == 123)
        var settled = placement
        settled.frame.size.height = 125
        overlay.apply(.placed(settled))
        #expect(overlay.window.frame == settled.frame)
    }

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
