import AppKit
import WebKit

@MainActor
enum ComposerCheck {
    static func run(directory: URL) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for theme in ["light", "dark"] {
                for (width, height) in [(812, 170), (804, 150), (804, 260), (900, 300), (520, 200), (1800, 150), (360, 200)] {
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

    private static let settleFrame = "await Promise.race([new Promise(r => requestAnimationFrame(r)), new Promise(r => setTimeout(r, 60))]); return true;"

    private final class KeyPanel: NSPanel {
        override var canBecomeKey: Bool { true }
        var overlayRevision = 0
        var checkedRevision = 0
        var acknowledgedAbove: Int?
    }

    private final class LoadFlag { var value = false }

    private static func render(_ directory: URL, theme: String, width: Int, height: Int) async throws {
        let bounds = NSRect(x: 0, y: 0, width: width, height: height)
        let page = try ComposerPage(frame: bounds)
        let window = Self.KeyPanel(contentRect: bounds.offsetBy(dx: -20000, dy: -20000), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
        window.contentView = page.view
        window.orderFrontRegardless()
        defer { page.receive = nil; window.close() }
        let baseFrame = window.frame
        let loaded = LoadFlag()
        var currentDraft = ""
        var heights: [Int] = []
        var submissions: [(String, String)] = []
        var submitFailure: String?
        var aborts = 0
        var pasteRequests = 0
        let clipboard = "pasted from fixture"
        page.receive = { [weak page] type, fields in
            switch type {
            case "ready": loaded.value = true
            case "layout":
                if let height = fields["height"] as? Int { heights.append(height) }
                return ["above": 0]
            case "overlay":
                guard let above = fields["above"] as? Int, above >= 0 else {
                    throw composerRefusal("Invalid fixture overlay height.")
                }
                window.overlayRevision += 1
                window.acknowledgedAbove = nil
                var frame = baseFrame
                frame.size.height += CGFloat(above)
                if window.frame != frame { window.setFrame(frame, display: true, animate: false) }
                guard window.frame == frame else {
                    throw composerRefusal("The fixture could not apply \(above) px above the composer.")
                }
                window.acknowledgedAbove = above
                return ["above": above]
            case "pasteText":
                pasteRequests += 1
                return ["text": clipboard]
            case "draft": currentDraft = fields["text"] as? String ?? ""
            case "abort": aborts += 1
            case "submit":
                submissions.append((fields["text"] as? String ?? "", fields["behavior"] as? String ?? ""))
                if let submitFailure { throw composerRefusal(submitFailure) }
                return ["outcome": "accepted"]
            case "complete": return ["prefix": "/re", "items": [
                ["value": "/resume", "label": "/resume", "description": "Resume another session"],
                ["value": "reload", "label": "reload", "description": "Reload keybindings, extensions, skills, prompts, themes, and context files"],
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
            ] + (1...7).map { ["provider": "provider-b", "id": "extra-\($0)", "name": "Extra model \($0)"] }]
            case "setThinking": return ["level": fields["level"] as? String ?? ""]
            case "thumbnail": return ["url": try thumbnail(second: (fields["path"] as? String)?.hasSuffix("second.png") == true)]
            default: break
            }
            return [:]
        }
        page.load()
        try await wait { loaded.value }
        try await evaluate(page, "document.documentElement.dataset.theme = '\(theme)'; return true;")
        if theme == "light" && width == 812 && height == 170 {
            let support = try await page.view.callAsyncJavaScript("""
                return JSON.stringify({agent: navigator.userAgent, fieldSizing: CSS.supports('field-sizing: content'), popover: typeof HTMLElement.prototype.showPopover === 'function', anchor: CSS.supports('left: anchor(left)'), clampAnchor: CSS.supports('left: clamp(6px, anchor(left), 90vw)'), startingStyle: 'CSSStartingStyleRule' in window, lightDark: CSS.supports('color: light-dark(black, white)'), pretty: CSS.supports('text-wrap: pretty'), contain: CSS.supports('overscroll-behavior: contain'), containers: CSS.supports('container-type: size'), focusVisible: CSS.supports('selector(:focus-visible)')}, null, 2);
                """, arguments: [:], in: nil, contentWorld: .page) as? String
            try support?.write(to: directory.appendingPathComponent("webkit.json"), atomically: true, encoding: .utf8)
        }
        try await checkHandoff(page)
        let base: [String: Any] = ["version": 1, "phase": "idle", "queued": [], "thinking": "low", "thinkingLevels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "model": ["name": "Claude Sonnet 4.6"],
                                   "context": ["percent": 6.1, "tokens": 59_120, "window": 1_000_000],
                                   "cost": 0.52, "cwd": "/projects/workbench"]
        guard await page.send("init", ["text": "", "sendKey": "return", "baseSize": 16, "cellWidth": 9]),
              await page.send("status", ["connection": "connected", "state": base]) else { throw composerRefusal("The composer page did not initialise.") }
        try await evaluate(page, """
            return document.querySelector('#context-percent').textContent === '6%'
                && Number(document.querySelector('#context-meter[role=meter]').getAttribute('aria-valuenow')) === 6.1
                && document.querySelector('#context-tokens').textContent === '59.1k/1.0M'
                && document.querySelector('#session-cost').textContent === '~$0.52'
                && document.querySelector('#session-folder').textContent.endsWith('workbench')
                && document.querySelector('#action').dataset.tip === 'Send ⏎'
                && document.querySelector('#status-state').hidden;
            """)
        try await snapshot(page, directory, "idle-empty", theme, width, height)
        try await wait { heights.last != nil }
        try await evaluate(page, Self.settleFrame)
        guard let emptyHeight = heights.last,
              let lineHeight = try await page.view.callAsyncJavaScript("return parseFloat(getComputedStyle(document.querySelector('#input')).lineHeight);", arguments: [:], in: nil, contentWorld: .page) as? Int else {
            throw composerRefusal("The fixture could not measure an empty editor.")
        }
        func expectHeight(_ expected: Int, after step: String, unchangedSince: Int? = nil) async throws {
            if let start = unchangedSince {
                // Give ResizeObserver and the script bridge a chance to deliver layout messages.
                try await evaluate(page, Self.settleFrame)
                try await evaluate(page, Self.settleFrame)
                guard heights.last == expected, heights.dropFirst(start).allSatisfy({ $0 == expected }) else {
                    throw composerRefusal("\(step) changed the requested height from \(expected): \(Array(heights.dropFirst(start))).")
                }
            } else {
                do { try await wait { heights.last == expected } }
                catch { throw composerRefusal("\(step) did not request \(expected) px: \(heights).") }
            }
        }
        var working = base
        working["phase"] = "working"
        working["since"] = Date().timeIntervalSince1970 * 1000 - 7200
        if height == 300 {
            try await evaluate(page, "return document.querySelector('#input').clientHeight > document.querySelector('#measure').clientHeight * 4;")
        }
        let lines = (1...13).map { "Line \($0): compare spacing and type." }
        let threeLines = lines.prefix(3).joined(separator: "\n")
        let capped = emptyHeight + 11 * lineHeight
        await page.send("replace", ["text": threeLines])
        try await expectHeight(emptyHeight + 2 * lineHeight, after: "Three draft lines")
        try await snapshot(page, directory, "draft-3", theme, width, height)
        let beforeRun = heights.count
        await page.send("status", ["connection": "connected", "state": working])
        try await evaluate(page, "return document.querySelector('#run-strip').getBoundingClientRect().height > 0;")
        try await expectHeight(emptyHeight + 2 * lineHeight, after: "Run strip alone", unchangedSince: beforeRun)
        await page.send("status", ["connection": "connected", "state": base])
        await page.send("replace", ["text": lines.prefix(12).joined(separator: "\n")])
        try await expectHeight(capped, after: "Twelve draft lines")
        for (name, bottom) in [("draft-12", false), ("draft-12-bottom", true)] {
            try await evaluate(page, "const field = document.querySelector('#input'); field.scrollTop = \(bottom ? "field.scrollHeight" : "0"); return true;")
            try await wait { (try? await javascript(page, """
                const area = document.querySelector('.edit-area');
                const fade = pseudo => getComputedStyle(area, pseudo).backgroundImage.includes('linear-gradient');
                return fade('::before') === \(bottom) && fade('::after') !== \(bottom);
                """)) == true }
            try await snapshot(page, directory, name, theme, width, height)
        }
        if width == 804 && height == 260 {
            try await evaluate(page, """
                const field = document.querySelector('#input');
                field.focus(); field.scrollTop = 0;
                const index = field.value.indexOf('Line 6:') + 1;
                field.setSelectionRange(index, index);
                return true;
                """)
            try await wait { (try? await javascript(page, "return document.querySelector('#input').scrollTop >= 24;")) == true }
        }
        let beforeCap = heights.count
        await page.send("replace", ["text": lines.joined(separator: "\n")])
        try await expectHeight(capped, after: "Thirteen draft lines", unchangedSince: beforeCap)
        let beforeDelete = heights.count
        try await evaluate(page, """
            const input = document.querySelector('#input');
            input.focus();
            input.setRangeText('', input.value.indexOf('\\n'), input.value.length, 'end');
            input.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
            return input.value === 'Line 1: compare spacing and type.';
            """)
        try await wait { currentDraft == lines[0] }
        try await expectHeight(capped, after: "Deletion with a nonempty draft", unchangedSince: beforeDelete)
        try await evaluate(page, "document.querySelector('#action').click(); return true;")
        try await wait { submissions.last?.0 == lines[0] && currentDraft.isEmpty }
        try await expectHeight(emptyHeight, after: "Send")
        await page.send("replace", ["text": threeLines])
        try await expectHeight(emptyHeight + 2 * lineHeight, after: "New draft after send")
        await page.send("replace", ["text": ""])
        try await expectHeight(emptyHeight, after: "Clear")
        if theme == "light" && width == 812 && height == 170 {
            let beforeSubmit = submissions.count
            submitFailure = "Not sent. Cannot save drafts. Set permissions to 0700 on the draft directory."
            await page.send("replace", ["text": "Keep my draft."])
            try await evaluate(page, "document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); return true;")
            try await wait { (try? await javascript(page, "return document.querySelector('#notice').textContent.includes('0700') && document.querySelector('#notice').getBoundingClientRect().height > 0 && !document.querySelector('#dismiss-notice').hidden;")) == true }
            try await evaluate(page, "return document.querySelector('#input').value === 'Keep my draft.' && !document.querySelector('#action').disabled;")
            submitFailure = nil
            try await evaluate(page, "document.querySelector('#action').click(); return true;")
            try await wait { currentDraft.isEmpty && submissions.count == beforeSubmit + 2 }
            try await evaluate(page, "return document.querySelector('#notice').hidden;")
            try await expectHeight(emptyHeight, after: "Send after retry")
        }
        let beforeOverlay = heights.count
        await page.send("recovery", ["label": "7:29 pm"])
        try await evaluate(page, "document.querySelector('#add').click(); return true;")
        try await waitForOverlay(page, baseHeight: height, kind: "add")
        try await evaluate(page, "return document.querySelector('#menu .menu-row').textContent === 'Restore draft from 7:29 pm';")
        try await snapshot(page, directory, "restore-add", theme, width, height)
        await page.send("recovery", ["label": ""])
        try await evaluate(page, "return !document.querySelector('#menu').textContent.includes('Restore draft');")
        await page.send("escape")
        try await waitForOverlay(page, baseHeight: height, kind: nil)
        try await expectHeight(emptyHeight, after: "Menu overlay", unchangedSince: beforeOverlay)
        try await openContextMenu(page, baseHeight: height)
        try await snapshot(page, directory, "context-menu", theme, width, height)
        try await evaluate(page, "[...document.querySelectorAll('#menu .menu-row')].find(row => row.firstElementChild?.textContent === 'Paste').click(); return true;")
        try await wait { pasteRequests == 1 && currentDraft == clipboard }
        try await evaluate(page, "return document.activeElement === document.querySelector('#input') && document.activeElement.value === '\(clipboard)';")
        try await waitForOverlay(page, baseHeight: height, kind: nil)
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
        working["queued"] = [["behavior": "followUp", "text": "Check the terminal placement after the first pass."]]
        let nextDraft = "Include the shorter terminal in the comparison."
        await page.send("replace", ["text": nextDraft])
        try await wait { currentDraft == nextDraft }
        await page.send("status", ["connection": "connected", "state": working])
        try await evaluate(page, """
            const tray = document.querySelector('#queued');
            return tray.getBoundingClientRect().height >= 26 && tray.getBoundingClientRect().bottom <= document.querySelector('#input').getBoundingClientRect().top;
            """)
        try await snapshot(page, directory, "working-queued", theme, width, height)
        let beforeStop = submissions.count
        try await evaluate(page, "document.querySelector('#action').click(); return true;")
        try await wait { aborts == 1 }
        guard currentDraft == nextDraft, submissions.count == beforeStop else {
            throw composerRefusal("Stop changed or submitted the draft.")
        }
        try await evaluate(page, "return document.querySelector('#input').value === '\(nextDraft)';")
        try await evaluate(page, """
            document.querySelector('#mode').click();
            const input = document.querySelector('#input');
            if (document.activeElement !== input) return false;
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
            return true;
            """)
        try await wait { submissions.last?.0 == nextDraft && submissions.last?.1 == "followUp" && currentDraft.isEmpty }
        await page.send("status", ["connection": "connected", "state": base])
        await page.send("replace", ["text": "/re"])
        try await openCompletion(page, baseHeight: height)
        try await snapshot(page, directory, "completion", theme, width, height)
        await page.send("escape")
        try await waitForOverlay(page, baseHeight: height, kind: nil)
        if width == 900 && height == 300 {
            let wrapped = String(repeating: "A draft line that wraps at the pane width. ", count: 40) + "\n/re"
            await page.send("replace", ["text": wrapped])
            try await openCompletion(page, baseHeight: height, scrolled: true)
            try await snapshot(page, directory, "completion-above", theme, width, height)
            await page.send("escape")
            try await waitForOverlay(page, baseHeight: height, kind: nil)
            await page.send("replace", ["text": "/re"])
        }
        try await checkMenus(page, directory, theme, width, height)
        await page.send("status", ["connection": "reconnecting", "state": base])
        await page.send("replace", ["text": "Keep this draft while Pi reloads."])
        try await snapshot(page, directory, "reconnecting", theme, width, height)
    }

    private static func waitForOverlay(_ page: ComposerPage, baseHeight: Int, kind: String?, mustGrow: Bool = false) async throws {
        guard let window = page.view.window as? KeyPanel else { throw composerRefusal("No fixture panel.") }
        let menuState = kind.map { "document.querySelector('#menu[data-kind=\"\($0)\"]:popover-open') !== null" }
            ?? "document.querySelector('#menu').hidden && !document.querySelector('#menu').matches(':popover-open')"
        do {
            try await wait {
                let revision = window.overlayRevision
                guard revision > window.checkedRevision, let above = window.acknowledgedAbove,
                      kind != nil || above == 0, !mustGrow || above > 0,
                      (try? await javascript(page, "return innerHeight === \(baseHeight + above) && (\(menuState));")) == true,
                      window.overlayRevision == revision else { return false }
                window.checkedRevision = revision
                return true
            }
        } catch {
            throw composerRefusal("Expected overlay \(kind ?? "closed"), acknowledged above: \(window.acknowledgedAbove.map { String($0) } ?? "none"), view height: \(page.view.bounds.height).")
        }
    }

    private static func openContextMenu(_ page: ComposerPage, baseHeight: Int) async throws {
        try await evaluate(page, """
            const input = document.querySelector('#input');
            input.focus();
            const bounds = input.getBoundingClientRect();
            const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2,
                clientX: bounds.left + 6, clientY: bounds.top + 6 });
            return !input.dispatchEvent(event);
            """)
        try await waitForOverlay(page, baseHeight: baseHeight, kind: "context", mustGrow: baseHeight <= 170)
        try await evaluate(page, """
            const labels = [...document.querySelectorAll('#menu button.menu-row')]
                .map(row => row.firstElementChild.textContent);
            return JSON.stringify(labels) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select All', 'Add image or file…', 'Mention a file']);
            """)
    }

    private static func openCompletion(_ page: ComposerPage, baseHeight: Int, scrolled: Bool = false) async throws {
        try await evaluate(page, """
            const field = document.querySelector('textarea');
            field.focus();
            field.setSelectionRange(field.value.length, field.value.length);
            field.scrollTop = field.scrollHeight;
            return true;
            """)
        try await evaluate(page, Self.settleFrame)
        try await evaluate(page, "document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })); return true;")
        do { try await waitForOverlay(page, baseHeight: baseHeight, kind: "completion") }
        catch {
            let geometry = try? await page.view.callAsyncJavaScript("""
                const field = document.querySelector('textarea'), mirror = document.querySelector('#highlight');
                const range = document.createRange();
                range.setStart(mirror.lastChild, 0);
                range.collapse(true);
                return JSON.stringify({length:field.value.length, cursor:field.selectionEnd, inputScroll:field.scrollTop,
                    mirrorScroll:mirror.scrollTop, box:field.getBoundingClientRect(), caret:range.getBoundingClientRect()});
                """, arguments: [:], in: nil, contentWorld: .page) as? String
            throw composerRefusal("Completion did not open: \(error.localizedDescription) \(geometry ?? "")")
        }
        try await evaluate(page, Self.settleFrame)
        try await evaluate(page, """
            const mirror = document.querySelector('#highlight'), field = document.querySelector('#input');
            const text = mirror.lastChild.previousSibling;
            const range = document.createRange();
            range.selectNodeContents(text);
            const line = Array.from(range.getClientRects()).at(-1);
            const menu = document.querySelector('#menu');
            const box = menu.getBoundingClientRect();
            const editor = field.getBoundingClientRect();
            function rowsFit() {
                const reload = Array.from(menu.querySelectorAll('.menu-row')).find(row => row.firstChild.textContent === '/reload');
                return reload && reload.offsetHeight <= 30 && getComputedStyle(reload.lastChild).textOverflow === 'ellipsis'
                    && Math.abs(box.width - Math.max(320, editor.width)) < 1;
            }
            return menu.querySelectorAll('.menu-row').length === 3 && menu.querySelector('.menu-row.current')
                && document.activeElement === field && line && line.bottom > editor.top && line.top < editor.bottom
                && rowsFit() && box.bottom <= line.top && (!\(scrolled) || field.scrollTop > 0);
            """)
    }

    private static func checkMenus(_ page: ComposerPage, _ directory: URL, _ theme: String, _ width: Int, _ height: Int) async throws {
        try await evaluate(page, "document.querySelector('#model').click(); return true;")
        try await waitForOverlay(page, baseHeight: height, kind: "model")
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
            const list = document.querySelector('.model-list'), footer = document.querySelector('.thinking-choices');
            const rect = node => node.getBoundingClientRect();
            const filter = document.querySelector('#menu input'), top = rect(filter).top, bottom = rect(footer).bottom;
            list.scrollTop = list.scrollHeight;
            const levels = [...footer.querySelectorAll('button')];
            const upper = levels.filter(button => rect(button).top === rect(levels[0]).top).length;
            return list.querySelectorAll('.menu-row').length === 14 && list.scrollTop > 0
                && rect(filter).top === top && rect(footer).bottom === bottom && rect(list).bottom <= rect(footer).top
                && levels.length === 7 && upper === (innerWidth < 432 ? 4 : 7)
                && levels.every(button => button.firstChild.scrollWidth <= button.firstChild.clientWidth);
            """)
        try await evaluate(page, "document.querySelector('.thinking-choices button:last-child').click(); return true;")
        try await wait { (try? await javascript(page, "return document.querySelector('#menu').matches(':popover-open') && document.querySelector('.thinking-choices [aria-pressed=true]').textContent === 'max' && document.querySelector('#thinking-level').textContent === 'max';")) == true }
        try await snapshot(page, directory, "thinking-levels", theme, width, height)
        try await evaluate(page, """
            const filter = document.querySelector('#menu input');
            filter.value = 'nano'; filter.dispatchEvent(new Event('input'));
            const rows = document.querySelectorAll('.model-results .menu-row');
            return rows.length === 1 && rows[0].textContent.includes('Nano');
            """)
        try await snapshot(page, directory, "filtered-models", theme, width, height)
        await page.send("escape")
        try await waitForOverlay(page, baseHeight: height, kind: nil)
        try await wait { (try? await javascript(page, "return document.querySelector('#thinking-level').textContent === 'max';")) == true }
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
        guard try await javascript(page, body) else { throw composerRefusal("Composer assertion failed: \(body)") }
    }

    private static func snapshot(_ page: ComposerPage, _ directory: URL, _ name: String, _ theme: String, _ width: Int, _ height: Int) async throws {
        try await evaluate(page, Self.settleFrame)
        try await evaluate(page, "for (const animation of document.querySelector('#menu').getAnimations()) animation.finish(); return true;")
        do {
            try await evaluate(page, """
                const rect = selector => document.querySelector(selector).getBoundingClientRect();
                const inside = b => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
                const menu = document.querySelector('#menu');
                const inputStyle = getComputedStyle(document.querySelector('#input'));
                const rowCount = (rect('#input').height - parseFloat(inputStyle.paddingBlockStart) - parseFloat(inputStyle.paddingBlockEnd)) / parseFloat(inputStyle.lineHeight);
                return ['.writer', '.edit-area', '#add', '#model', '#action', '.status'].every(selector => inside(rect(selector)))
                    && rect('.writer').left === 12 && rect('.writer').right === innerWidth - 12 && rect('#input').left === 25
                    && rowCount >= 1 && Math.abs(rowCount - Math.round(rowCount)) < 0.01
                    && ['#add', '#model', '#action'].every(selector => rect('#input').bottom <= rect(selector).top && rect(selector).height === 32)
                    && rect('#add').width === 32 && rect('#action').width === 32 && rect('#action').bottom <= rect('.writer').bottom
                    && rect('.composer').top === innerHeight - \(height)
                    && Math.abs(rect('.writer').bottom - rect('.shelf').bottom - 13) < 0.1
                    && (document.documentElement.dataset.theme !== 'dark' || getComputedStyle(document.querySelector('.writer')).backgroundColor === getComputedStyle(document.querySelector('.composer')).backgroundColor)
                    && rect('.writer').bottom <= rect('.status').top && rect('.status').bottom >= innerHeight - 8
                    && (document.querySelector('#context').hidden || rect('#context-percent').height > 0)
                    && (menu.hidden || inside(rect('#menu')));
                """)
        } catch {
            let geometry = try? await page.view.callAsyncJavaScript("""
                return JSON.stringify(Object.fromEntries(['.writer', '.edit-area', '#add', '#model', '#action', '.status', '#menu'].map(s => [s, document.querySelector(s).getBoundingClientRect().toJSON()])));
                """, arguments: [:], in: nil, contentWorld: .page) as? String
            throw composerRefusal("\(name) did not fit: \(geometry ?? error.localizedDescription)")
        }
        let options = WKSnapshotConfiguration()
        options.rect = page.view.bounds
        options.snapshotWidth = NSNumber(value: Double(page.view.bounds.width))
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
