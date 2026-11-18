import AppKit
import WebKit

@MainActor
enum ComposerCheck {
    static func run(directory: URL) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for theme in ["light", "dark"] {
                for (width, height) in [(900, 320), (600, 260)] {
                    try await render(directory, theme: theme, width: width, height: height)
                }
            }
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("Composer check: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    private static func render(_ directory: URL, theme: String, width: Int, height: Int) async throws {
        let bounds = NSRect(x: 0, y: 0, width: width, height: height)
        let page = try ComposerPage(frame: bounds)
        let window = CheckRunner.KeyPanel(contentRect: bounds.offsetBy(dx: -20000, dy: -20000), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
        window.contentView = page.view
        window.orderFrontRegardless()
        defer { window.close() }
        let loaded = Flag()
        var currentDraft = ""
        var submissions: [(String, String)] = []
        page.receive = { type, fields in
            switch type {
            case "ready": loaded.value = true
            case "draft": currentDraft = fields["text"] as? String ?? ""
            case "submit":
                submissions.append((fields["text"] as? String ?? "", fields["behavior"] as? String ?? ""))
                return ["outcome": "accepted"]
            case "complete": return ["prefix": "/re", "items": [
                ["value": "/resume", "label": "/resume", "description": "Resume another session"],
                ["value": "/reload", "label": "/reload", "description": "Reload extensions"],
                ["value": "/review", "label": "/review", "description": "Review local changes"],
            ]]
            case "models": return ["models": [
                ["provider": "provider-a", "id": "studio", "name": "Studio", "current": true],
                ["provider": "provider-a", "id": "swift", "name": "Swift"],
                ["provider": "provider-b", "id": "cascade", "name": "Cascade"],
            ]]
            case "thumbnail": return ["url": try thumbnail(second: (fields["path"] as? String)?.hasSuffix("second.png") == true)]
            default: break
            }
            return [:]
        }
        page.load()
        try await wait { loaded.value }
        try await evaluate(page, "document.documentElement.dataset.theme = '\(theme)'; return true;")
        try await checkHandoff(page)
        let base: [String: Any] = ["version": 1, "phase": "idle", "queued": [], "thinking": "High", "thinkingLevels": ["Off", "Low", "High"], "model": ["name": "Studio"],
                                   "context": ["percent": 6.1, "tokens": 59_120, "window": 1_000_000],
                                   "cost": 0.52, "cwd": "/projects/workbench"]
        guard await page.send("init", ["text": "", "sendKey": "return"]),
              await page.send("status", ["connection": "connected", "state": base]) else { throw composerRefusal("The composer page did not initialise.") }
        try await evaluate(page, """
            return document.querySelector('#context-percent').textContent === '6%'
                && document.querySelector('#context-meter').value === 6.1
                && document.querySelector('#session-cost').textContent === '~$0.52'
                && document.querySelector('#session-folder').textContent === 'workbench'
                && document.querySelector('#sendkey-label').textContent === '⏎ send';
            """)
        try await snapshot(page, directory, "idle-empty", theme, width, height)
        let long = "Compare the two layouts at the same width and keep the narrower version readable.\n\nUse @notes and keep the labels, spacing and icon weight consistent.\n/reference/first.png\n/reference/second.png\n\nPoint out anything that changes how the keyboard works."
        guard await page.send("replace", ["text": long]) else { throw composerRefusal("The draft did not reach the page.") }
        try await wait { currentDraft == long }
        try await wait { (try? await javascript(page, "return [...document.images].length === 2 && [...document.images].every(image => image.complete);")) == true }
        try await snapshot(page, directory, "idle-images", theme, width, height)
        var working = base
        working["phase"] = "working"
        working["since"] = Date().timeIntervalSince1970 * 1000 - 7200
        working["queued"] = [["behavior": "followUp", "text": "Check the terminal placement after the first pass."]]
        await page.send("replace", ["text": "Include the shorter terminal in the comparison."])
        await page.send("status", ["connection": "connected", "state": working])
        try await snapshot(page, directory, "working-queued", theme, width, height)
        try await evaluate(page, "document.querySelector('#queue').click(); return true;")
        try await wait { submissions.last?.1 == "followUp" && currentDraft.isEmpty }
        await page.send("status", ["connection": "connected", "state": base])
        await page.send("replace", ["text": "/re"])
        try await evaluate(page, "document.querySelector('textarea').setSelectionRange(3, 3); document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })); return true;")
        try await wait { (try? await javascript(page, "return document.querySelectorAll('.menu-row').length === 3;")) == true }
        try await snapshot(page, directory, "completion", theme, width, height)
        try await evaluate(page, "document.querySelector('#model').click(); return true;")
        try await wait { (try? await javascript(page, "return document.querySelectorAll('.menu-group').length === 2;")) == true }
        try await snapshot(page, directory, "models", theme, width, height)
        await page.send("status", ["connection": "reconnecting", "state": base])
        await page.send("replace", ["text": "Keep this draft while Pi reloads."])
        try await snapshot(page, directory, "reconnecting", theme, width, height)
    }

    private static func checkHandoff(_ page: ComposerPage) async throws {
        let draft = "Draft returned from Pi"
        guard await page.send("init", ["text": draft, "sendKey": "return"]),
              await page.send("replace", ["text": ""]) else { throw composerRefusal("The draft clear did not reach the page.") }
        try await evaluate(page, "return document.querySelector('textarea').value === '';")
        guard let undo = page.view.undoManager, undo.canUndo else { throw composerRefusal("The clear did not register an undo entry.") }
        undo.undo()
        try await wait { (try? await javascript(page, "return document.querySelector('textarea').value === 'Draft returned from Pi';")) == true }
    }

    private static func wait(_ test: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !(await test()) {
            guard ContinuousClock.now < deadline else { throw composerRefusal("The composer fixture did not reach its expected state.") }
            try await Task.sleep(for: .milliseconds(30))
        }
    }

    private static func javascript(_ page: ComposerPage, _ body: String) async throws -> Bool {
        try await page.view.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page) as? Bool == true
    }

    private static func evaluate(_ page: ComposerPage, _ body: String) async throws {
        guard try await javascript(page, body) else { throw composerRefusal("The composer check script did not finish.") }
    }

    private static func snapshot(_ page: ComposerPage, _ directory: URL, _ name: String, _ theme: String, _ width: Int, _ height: Int) async throws {
        try await evaluate(page, CheckRunner.settleFrame)
        try await evaluate(page, """
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const inside = b => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
            const menu = document.querySelector('#menu');
            return ['.writer', '.edit-area', '.shelf', '.status', '#close'].every(selector => inside(rect(selector)))
                && rect('.writer').top <= 12 && rect('.edit-area').height >= 36
                && rect('.writer').bottom <= rect('.status').top && (menu.hidden || inside(rect('#menu')));
            """)
        let options = WKSnapshotConfiguration()
        options.rect = CGRect(x: 0, y: 0, width: width, height: height)
        options.snapshotWidth = NSNumber(value: width)
        let image = try await page.view.takeSnapshot(configuration: options)
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { throw composerRefusal("The composer snapshot was not a PNG.") }
        try png.write(to: directory.appendingPathComponent("\(name)-\(theme)-\(width)x\(height).png"))
    }

    private static func thumbnail(second: Bool) throws -> String {
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 36, pixelsHigh: 28, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { throw composerRefusal("No fixture image.") }
        for x in 0..<36 {
            for y in 0..<28 {
                let ridge = y > 8 + Int(abs(sin(Double(x) / 8)) * 8)
                let colour: NSColor = second ? (ridge ? NSColor(deviceRed: 0.3, green: 0.2, blue: 0.65, alpha: 1) : NSColor(deviceRed: 0.92, green: 0.52, blue: 0.7, alpha: 1)) : (ridge ? NSColor(deviceRed: 0.08, green: 0.7, blue: 0.6, alpha: 1) : NSColor(deviceRed: 0.18, green: 0.34, blue: 0.82, alpha: 1))
                bitmap.setColor(colour, atX: x, y: y)
            }
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw composerRefusal("No fixture PNG.") }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}
