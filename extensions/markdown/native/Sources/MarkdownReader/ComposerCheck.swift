import AppKit
import WebKit

@MainActor
enum ComposerCheck {
    static func run(directory: URL) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for theme in ["light", "dark"] {
                for (width, height) in [(1800, 280), (900, 300), (520, 240), (1800, 150), (900, 130)] {
                    do { try await render(directory, theme: theme, width: width, height: height) }
                    catch { throw composerRefusal("\(theme) \(width)x\(height): \(error.localizedDescription)") }
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
                ["provider": "provider-a", "id": "studio", "name": "Claude Sonnet 4.6", "current": true],
                ["provider": "provider-a", "id": "swift", "name": "Claude Haiku 4.5"],
                ["provider": "provider-a", "id": "large", "name": "Claude Opus 4.6"],
                ["provider": "provider-b", "id": "cascade", "name": "GPT 5.5"],
                ["provider": "provider-b", "id": "compact", "name": "GPT 5.4 Mini"],
                ["provider": "provider-b", "id": "code", "name": "GPT 5.3 Codex"],
                ["provider": "provider-b", "id": "small", "name": "GPT 5.4 Nano"],
            ]]
            case "setThinking": return ["level": fields["level"] as? String ?? ""]
            case "thumbnail": return ["url": try thumbnail(second: (fields["path"] as? String)?.hasSuffix("second.png") == true)]
            default: break
            }
            return [:]
        }
        page.load()
        try await wait { loaded.value }
        try await evaluate(page, "document.documentElement.dataset.theme = '\(theme)'; return true;")
        try await checkHandoff(page)
        let base: [String: Any] = ["version": 1, "phase": "idle", "queued": [], "thinking": "low", "thinkingLevels": ["off", "low", "high"], "model": ["name": "Claude Sonnet 4.6"],
                                   "context": ["percent": 6.1, "tokens": 59_120, "window": 1_000_000],
                                   "cost": 0.52, "cwd": "/projects/workbench"]
        guard await page.send("init", ["text": "", "sendKey": "return", "baseSize": 16, "cellWidth": 9]),
              await page.send("status", ["connection": "connected", "state": base]) else { throw composerRefusal("The composer page did not initialise.") }
        try await evaluate(page, """
            return document.querySelector('#context-percent').textContent === '6%'
                && document.querySelector('#context-meter').value === 6.1
                && document.querySelector('#session-cost').textContent === '~$0.52'
                && document.querySelector('#session-folder').textContent === 'workbench'
                && document.querySelector('#action').dataset.tip === 'Send ⏎'
                && document.querySelector('#status-state').hidden;
            """)
        try await snapshot(page, directory, "idle-empty", theme, width, height)
        let long = "Compare the two layouts at the same width and keep the narrower version readable.\n\nUse @notes and keep the labels, spacing and icon weight consistent.\n/reference/first.png\n/reference/second.png\n\nPoint out anything that changes how the keyboard works."
        guard await page.send("replace", ["text": long]) else { throw composerRefusal("The draft did not reach the page.") }
        try await wait { currentDraft == long }
        try await wait { (try? await javascript(page, "return [...document.images].length === 2 && [...document.images].every(image => image.complete);")) == true }
        try await evaluate(page, """
            return [...document.querySelectorAll('.thumbnail button')].every(button => {
                const bounds = button.getBoundingClientRect();
                return bounds.width === 18 && bounds.height === 18 && getComputedStyle(button).opacity === '0';
            });
            """)
        try await snapshot(page, directory, "idle-images", theme, width, height)
        var working = base
        working["phase"] = "working"
        working["since"] = Date().timeIntervalSince1970 * 1000 - 7200
        working["queued"] = [["behavior": "followUp", "text": "Check the terminal placement after the first pass."]]
        await page.send("replace", ["text": "Include the shorter terminal in the comparison."])
        await page.send("status", ["connection": "connected", "state": working])
        try await evaluate(page, """
            const tray = document.querySelector('#queued'), count = document.querySelector('#queued-count');
            const editor = document.querySelector('.edit-area').getBoundingClientRect();
            if (innerHeight >= 160) return tray.getBoundingClientRect().bottom <= editor.top && !count.getClientRects().length;
            const edit = document.querySelector('#edit-queued');
            return !tray.getClientRects().length && count.textContent === '(1)' && count.getClientRects().length > 0
                && edit.getBoundingClientRect().bottom <= editor.top;
            """)
        try await snapshot(page, directory, "working-queued", theme, width, height)
        try await evaluate(page, "document.querySelector('#mode').click(); document.querySelector('#action').click(); return true;")
        try await wait { submissions.last?.1 == "followUp" && currentDraft.isEmpty }
        await page.send("status", ["connection": "connected", "state": base])
        await page.send("replace", ["text": "/re"])
        try await openCompletion(page, below: true)
        try await snapshot(page, directory, "completion", theme, width, height)
        if width == 900 && height == 300 {
            await page.send("escape")
            let wrapped = String(repeating: "A draft line that wraps at the pane width. ", count: 40) + "\n/re"
            await page.send("replace", ["text": wrapped])
            try await openCompletion(page, below: false)
            try await snapshot(page, directory, "completion-above", theme, width, height)
            await page.send("replace", ["text": "/re"])
        }
        try await checkMenus(page, directory, theme, width, height)
        await page.send("status", ["connection": "reconnecting", "state": base])
        await page.send("replace", ["text": "Keep this draft while Pi reloads."])
        try await snapshot(page, directory, "reconnecting", theme, width, height)
    }

    private static func openCompletion(_ page: ComposerPage, below: Bool) async throws {
        try await evaluate(page, """
            const field = document.querySelector('textarea');
            field.focus();
            field.setSelectionRange(field.value.length, field.value.length);
            field.scrollTop = field.scrollHeight;
            return true;
            """)
        try await evaluate(page, CheckRunner.settleFrame)
        try await evaluate(page, "document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })); return true;")
        do { try await wait { (try? await javascript(page, "return document.querySelectorAll('#menu .menu-row').length === 3;")) == true } }
        catch {
            let geometry = try? await page.view.callAsyncJavaScript("""
                const field = document.querySelector('textarea'), mirror = document.querySelector('#highlight');
                const range = document.createRange();
                range.setStart(mirror.lastChild, 0);
                range.collapse(true);
                return JSON.stringify({length:field.value.length, cursor:field.selectionEnd, inputScroll:field.scrollTop,
                    mirrorScroll:mirror.scrollTop, box:field.getBoundingClientRect(), caret:range.getBoundingClientRect()});
                """, arguments: [:], in: nil, contentWorld: .page) as? String
            throw composerRefusal("Completion did not open: \(geometry ?? error.localizedDescription)")
        }
        try await evaluate(page, """
            const mirror = document.querySelector('#highlight'), field = document.querySelector('textarea');
            const text = mirror.lastChild.previousSibling;
            const range = document.createRange();
            range.selectNodeContents(text);
            const line = Array.from(range.getClientRects()).at(-1);
            const box = document.querySelector('#menu').getBoundingClientRect();
            const editor = field.getBoundingClientRect();
            return line && line.bottom > editor.top && line.top < editor.bottom
                && (\(below) ? box.top > line.bottom : field.scrollTop > 0 && box.bottom < line.top);
            """)
    }

    private static func checkMenus(_ page: ComposerPage, _ directory: URL, _ theme: String, _ width: Int, _ height: Int) async throws {
        try await evaluate(page, "document.querySelector('#model').click(); return true;")
        try await wait { (try? await javascript(page, "return document.querySelectorAll('.menu-group').length === 2;")) == true }
        try await evaluate(page, """
            const list = document.querySelector('.model-list'), filter = document.querySelector('#menu input');
            const visible = list.getBoundingClientRect();
            const rows = Array.from(list.querySelectorAll('.menu-row'));
            const count = rows.filter(row => {
                const b = row.getBoundingClientRect();
                return b.top >= visible.top && b.bottom <= visible.bottom;
            }).length;
            return document.activeElement === filter && filter.getBoundingClientRect().bottom <= visible.top
                && rows.some(row => row.textContent.includes('✓ Current')) && (innerHeight < 240 || count >= 4);
            """)
        try await snapshot(page, directory, "models", theme, width, height)
        try await evaluate(page, """
            const filter = document.querySelector('#menu input');
            filter.value = 'nano'; filter.dispatchEvent(new Event('input'));
            const rows = document.querySelectorAll('#menu .menu-row');
            return rows.length === 1 && rows[0].textContent.includes('Nano');
            """)
        try await evaluate(page, """
            document.querySelector('#thinking').click();
            const menu = document.querySelector('#menu');
            return menu.dataset.kind === 'thinking' && !menu.querySelector('input') && menu.querySelectorAll('.menu-row').length === 3
                && menu.querySelector('[aria-pressed=true]').textContent.startsWith('low');
            """)
        try await snapshot(page, directory, "thinking", theme, width, height)
        try await evaluate(page, "document.querySelector('#menu .menu-row:last-child').click(); return true;")
        try await wait { (try? await javascript(page, "return document.querySelector('#menu').hidden && document.querySelector('#model-level').textContent === 'high';")) == true }
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
        do {
            try await evaluate(page, """
                const rect = selector => document.querySelector(selector).getBoundingClientRect();
                const inside = b => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
                const menu = document.querySelector('#menu');
                return ['.writer', '.edit-area', '#add', '#model', '#thinking', '#action', '.status', '#close'].every(selector => inside(rect(selector)))
                    && rect('.writer').width >= innerWidth - 16 && rect('.edit-area').height >= 28
                    && rect('#close').height >= 28 && rect('#action').width >= 28
                    && (innerHeight < 160 ? rect('.status').bottom <= rect('.writer').top : rect('.writer').bottom <= rect('.status').top)
                    && (menu.hidden || inside(rect('#menu')));
                """)
        } catch {
            let geometry = try? await page.view.callAsyncJavaScript("""
                return JSON.stringify(Object.fromEntries(['.writer', '.edit-area', '#add', '#model', '#action', '.status', '#close', '#menu'].map(s => [s, document.querySelector(s).getBoundingClientRect().toJSON()])));
                """, arguments: [:], in: nil, contentWorld: .page) as? String
            throw composerRefusal("\(name) did not fit: \(geometry ?? error.localizedDescription)")
        }
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
