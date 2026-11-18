import AppKit
import WebKit

@MainActor
enum ComposerViewportCheck {
    private final class Loaded { var value = false }

    /// Sample from the bottom of the visible rectangle, not the top of the window.
    static func run() async throws {
        let rect = CGRect(x: -20000, y: -20000, width: 360, height: 140)
        let window = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        let content = NSView(frame: CGRect(origin: .zero, size: rect.size))
        window.contentView = content
        let page = try ComposerPage(frame: content.bounds)
        page.mount(in: content)
        page.setViewportLimit(CGSize(width: 360, height: 360))
        let loaded = Loaded()
        page.receive = { type, _ in
            if type == "ready" { loaded.value = true }
            return ["above": 0]
        }
        defer { page.receive = nil; window.close() }
        window.orderFrontRegardless()
        page.load()
        let deadline = ContinuousClock.now + .seconds(3)
        while !loaded.value {
            guard ContinuousClock.now < deadline else { throw composerRefusal("The viewport pixel fixture did not load.") }
            try await Task.sleep(for: .milliseconds(20))
        }
        _ = try await page.view.callAsyncJavaScript("""
            for (const [bottom, color] of [[32, '#ff0000'], [152, '#0000ff'], [212, '#00ff00']]) {
                const stripe = document.createElement('div');
                stripe.style.cssText = `position:fixed;z-index:999999;left:0;width:24px;height:8px;bottom:${bottom}px;background:${color}`;
                document.body.append(stripe);
            }
            await Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise(r => setTimeout(r, 100))]);
            """, arguments: [:], in: nil, contentWorld: .page)
        try await check(page, in: content, height: 140)
        // Growth, menu open, and menu close. Read the first snapshot without waiting for paint.
        for height in [180, 240, 180] {
            var frame = rect
            frame.size.height = CGFloat(height)
            window.setFrame(frame, display: true, animate: false)
            try await check(page, in: content, height: height)
        }
    }

    private static func check(_ page: ComposerPage, in content: NSView, height: Int) async throws {
        let visible = page.view.convert(content.bounds, from: content)
        guard page.view.frame == CGRect(x: 0, y: 0, width: 360, height: 360),
              visible == CGRect(x: 0, y: 360 - height, width: 360, height: height) else {
            throw composerRefusal("The web view moved or resized with the viewport.")
        }
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: 0, y: visible.minY, width: 24, height: visible.height)
        config.snapshotWidth = 24
        config.afterScreenUpdates = false
        let snapshot = try await page.view.takeSnapshot(configuration: config)
        guard let data = snapshot.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data) else {
            throw composerRefusal("The viewport snapshot has no pixels.")
        }
        for (bottom, component) in [(36, 0), (156, 2), (216, 1)] where bottom < height {
            let y = bitmap.pixelsHigh * (height - bottom) / height
            guard let pixel = bitmap.colorAt(x: bitmap.pixelsWide / 2, y: y)?.usingColorSpace(.sRGB) else {
                throw composerRefusal("The viewport snapshot has no stripe at \(bottom) pt.")
            }
            let channels = [pixel.redComponent, pixel.greenComponent, pixel.blueComponent]
            guard channels[component] > 0.8,
                  channels.enumerated().allSatisfy({ $0.offset == component || channels[component] - $0.element > 0.35 }) else {
                throw composerRefusal("The stripe at \(bottom) pt moved or did not paint at viewport height \(height): \(channels).")
            }
        }
    }
}
