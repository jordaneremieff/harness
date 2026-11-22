import AppKit
import Network
import WebKit

@MainActor
enum ExplorerCheck {
    private final class CheckPanel: NSPanel {
        override var isKeyWindow: Bool { true }
        override var canBecomeKey: Bool { false }
        // A transparent check window must draw while it remains invisible to the operator.
        override var occlusionState: NSWindow.OcclusionState { isVisible ? [.visible] : super.occlusionState }
    }
    static func export(_ argv: [String], resources: URL) throws {
        let raw = try options(argv, allowed: ["out", "width", "height", "appearance", "root", "path", "line", "script", "ignored", "zoom"])
        let zoom = raw["zoom"].map { Int($0).map { Double($0) / 100 } ?? 0 }
        guard let out = raw["out"], let width = raw["width"].flatMap(Int.init), let height = raw["height"].flatMap(Int.init),
              (320...4096).contains(width), (240...4096).contains(height), (raw["appearance"].map { ["dark", "light"].contains($0) } ?? true),
              zoom.map(ExplorerZoom.range.contains) ?? true else {
            throw ExplorerError("arguments", "Use --export-image --out <png> --width <n> --height <n> --root <dir> [--appearance dark|light] [--path <path>] [--line <n>] [--script <file>] [--ignored show|hide] [--zoom <percent>].")
        }
        let target = try Launch(arguments: ["root", "path", "line"].flatMap { key in raw[key].map { ["--\(key)", $0] } ?? [] })
        let scratch = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: scratch) }
        try execute(target: target, resources: resources, store: scratch, width: width, height: height, appearance: raw["appearance"], zoom: zoom,
                    showIgnored: try ignoredOption(raw["ignored"])) { host, _ in
            if let file = raw["script"] {
                let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: file))
                let data = try handle.read(upToCount: mib + 1) ?? Data()
                guard data.count <= mib, let code = String(data: data, encoding: .utf8) else { throw ExplorerError("invalid", "The snapshot script is invalid or too large.") }
                // The script runs as an async function body, so the snapshot waits for the work it awaits.
                _ = try await host.page.view.callAsyncJavaScript(code, arguments: [:], in: nil, contentWorld: .page)
            }
            try await paint(host.page.view)
            let image = try await host.page.view.takeSnapshot(configuration: nil)
            guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
                throw ExplorerError("snapshot", "WebKit did not return a PNG.")
            }
            try png.write(to: URL(fileURLWithPath: out), options: .atomic)
        }
    }

    static func verify(resources: URL) throws {
        let scratch = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("fixture")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let git = { (args: [String]) throws in
            let result = try command("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Explorer", "-c", "user.email=explorer@example.invalid"] + args,
                                     cwd: root, environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"], limit: 128 * kib, seconds: 3)
            guard result.status == 0 else { throw ExplorerError("verify", "The private Git fixture could not be created.") }
        }
        try git(["init", "--quiet", "-b", "main"])
        let file = root.appendingPathComponent("example.ts")
        try Data("export const answer = 41;\n".utf8).write(to: file)
        try Data("const first = 1;\nconst second = 2;\nconst third = 3;\n".utf8).write(to: root.appendingPathComponent("lines.ts"))
        try Data("cache/\nprivate.log\n".utf8).write(to: root.appendingPathComponent(".gitignore"))
        let cache = root.appendingPathComponent("cache")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: false)
        try Data("hiddenNeedle\n".utf8).write(to: cache.appendingPathComponent("settings.txt"))
        try Data().write(to: root.appendingPathComponent("private.log"))
        try git(["add", "example.ts", "lines.ts", ".gitignore"]); try git(["commit", "--quiet", "-m", "Fixture"])
        try Data("export const answer = 42;\n".utf8).write(to: file)
        try Data("# Preview\n\nA **rendered** paragraph.\n\n[Source](example.ts)\n".utf8).write(to: root.appendingPathComponent("guide.md"))
        try Data("one\r\n  two\r\n".utf8).write(to: root.appendingPathComponent("crlf.txt"))
        let fake = try FakeLive()
        defer { fake.stop() }
        let config = LiveConfiguration(version: 1, endpoint: URL(string: "http://127.0.0.1:\(fake.port)")!, token: FakeLive.token)
        let target = try Launch(target: ["root": root.path, "path": "example.ts"])
        try execute(target: target, resources: resources, store: scratch.appendingPathComponent("store"), width: 898, height: 800, appearance: "dark", live: config) { host, _ in
            let result = try await host.page.view.callAsyncJavaScript("""
            const bridge = globalThis.webkit.messageHandlers.explorer;
            const call = (type, fields = {}) => bridge.postMessage({ v: 1, type, ...fields });
            async function accept(type, fields) {
              const result = await call(type, fields);
              if (!result.ok) throw Error(type + ': ' + result.error?.message);
              return result;
            }
            const hello = await accept('hello');
            if (hello.root.kind !== 'git' || hello.root.branch !== 'main' || hello.launch.path !== 'example.ts') throw Error('hello location');
            const draft = {mode:'ask', text:'Unsaved question', range:{side:'head',start:1,end:1}, commit:null};
            await accept('state.save', {path:'example.ts',draft});
            if ((await accept('hello')).launch.draft?.text !== draft.text) throw Error('draft not retained');
            await accept('state.save', {path:'example.ts',draft:null});
            if ((await accept('hello')).launch.draft !== undefined) throw Error('draft not cleared');
            const files = await accept('files.list');
            if (!files.paths.includes('example.ts')) throw Error('file list');
            if (files.paths.includes('private.log') || files.ignored.paths.join() !== 'cache/,private.log') throw Error('ignored file list');
            const filesTab = document.querySelector('[data-tab="files"]');
            filesTab.click();
            const row = path => Array.from(document.querySelectorAll('#sidebar-list [data-path]')).find(node => node.dataset.path === path);
            if (!row('cache')?.classList.contains('is-ignored') || row('cache').ariaExpanded !== 'false' || row('cache/settings.txt')) throw Error('ignored folder was not collapsed');
            row('cache').click();
            for (let i = 0; i < 180 && !row('cache/settings.txt'); i++) await new Promise(requestAnimationFrame);
            if (!row('cache/settings.txt')?.classList.contains('is-ignored') || row('cache').ariaExpanded !== 'true') throw Error('ignored folder children');
            const filter = document.querySelector('[aria-label="Filter files"]');
            filter.value = 'settings.txt';
            filter.dispatchEvent(new Event('input'));
            if (!row('cache/settings.txt')) throw Error('loaded ignored file did not match the filter');
            filter.value = '';
            filter.dispatchEvent(new Event('input'));
            if ((await accept('file.read', {path:'cache/settings.txt'})).text !== 'hiddenNeedle\\n') throw Error('ignored file content');
            if ((await accept('search', {query:'hiddenNeedle'})).results.length) throw Error('search included ignored content');
            if ((await call('files.folder', {path:'.git'})).ok) throw Error('listed Git metadata');
            if ((await accept('file.read', {path:'example.ts'})).text !== 'export const answer = 42;\\n') throw Error('file content');
            if ((await call('file.read', {path:'../example.ts'})).ok) throw Error('escaped path');
            if ((await bridge.postMessage({v:2,type:'hello'})).ok || (await call('unknown')).ok) throw Error('unknown request accepted');
            const scope = {kind:'uncommitted'};
            const review = await accept('review.files', {scope});
            if (review.resolved.label !== 'Uncommitted changes' || !review.files.some(item => item.path === 'example.ts' && item.additions === 1)) throw Error('review files');
            const latest = await accept('review.files', {scope:{kind:'commit',commit:'HEAD'}});
            if (latest.resolved.label !== `${hello.root.head.slice(0,7)} Fixture`) throw Error('resolved review label');
            const diff = await accept('review.diff', {scope, path:'example.ts'});
            if (diff.hunks.length !== 1 || !diff.base.includes('41') || !diff.head.includes('42')) throw Error('review diff');
            const found = await accept('search', {query:'answer'});
            if (!found.results.some(row => row.path === 'example.ts' && row.line === 1)) throw Error('search results');
            const note = await accept('notes.write',{op:'create',note:{path:'example.ts',side:'head',start:1,end:1,commit:null,quote:'export const answer = 42;',text:'Notice',state:'open',author:'operator'}});
            if (!(await accept('notes.list')).notes.some(item => item.id === note.note.id)) throw Error('note not retained');
            const until = async (test, label) => {
              for (let i = 0; i < 240; i++) { const value = test(); if (value) return value; await new Promise(requestAnimationFrame); }
              throw Error(label);
            };
            const press = key => document.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true}));
            globalThis.explorer.receive({v:1, type:'notes.changed'});
            const marked = await until(() => document.querySelector('.code-cell.has-note .source'), 'note mark');
            marked.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, button:0, detail:1}));
            const opened = await until(() => document.querySelector('.float-card'), 'marked line opens its note');
            if (!opened.textContent.includes('Notice')) throw Error('note card text');
            press('Escape');
            globalThis.explorer.receive({v:1, type:'open', path:'lines.ts', view:'file'});
            await until(() => document.getElementById('file-title')?.textContent === 'lines.ts' && document.querySelectorAll('.gutter .line-number').length >= 3, 'second file');
            const comment = async line => {
              document.querySelector(`.gutter[data-line="${line}"] .line-number`).click();
              const strip = await until(() => [...document.querySelectorAll('.selection-strip button')].find(b => b.textContent.trim() === 'Comment' && !b.closest('[hidden]')), 'selection strip');
              strip.click();
              return until(() => document.querySelector('.float-card textarea'), 'comment card');
            };
            const typed = await comment(1);
            typed.value = 'Unsent comment';
            typed.dispatchEvent(new Event('input', {bubbles:true}));
            press('Escape');
            await until(() => !document.querySelector('.float-card'), 'card closes');
            if ((await comment(3)).value !== '') throw Error('unsent text moved to other lines');
            press('Escape');
            await until(() => !document.querySelector('.float-card'), 'card closes again');
            if ((await comment(1)).value !== 'Unsent comment') throw Error('unsent text not kept with its lines');
            press('Escape');
            const viewed = await accept('review.state', {op:'set',key:review.resolved.key,viewed:['example.ts']});
            if (viewed.viewed[0] !== 'example.ts') throw Error('review state');
            let connected = false;
            for (let i = 0; i < 180 && !connected; i++) {
              connected = (await accept('hello')).live.connected;
              if (!connected) await new Promise(requestAnimationFrame);
            }
            if (!connected) throw Error('fake Pi did not connect');
            const requestId = '00000000-0000-4000-8000-000000000001';
            const threadId = '00000000-0000-4000-8000-000000000002';
            const original = globalThis.explorer.receive;
            globalThis.explorer.receive = event => {
              if (event.type === 'promptState' && event.requestId === requestId && event.threadId === threadId && event.text === 'Verified reply' && event.status === 'answer') globalThis.__verifiedAnswer = true;
              return original(event);
            };
            const receipt = await accept('prompt', {requestId,threadId,text:'Verify Explorer'});
            if (receipt.status !== 'admitted') throw Error('prompt receipt');
            for (let i=0; i<180 && !globalThis.__verifiedAnswer; i++) await new Promise(requestAnimationFrame);
            if (!globalThis.__verifiedAnswer) throw Error('prompt answer');
            const rendered = await accept('markdown.render', {path:'guide.md'});
            if (!rendered.html.includes('<strong>rendered</strong>') || !rendered.html.includes('data-sourcepos="3:')) throw Error('Markdown render and source map');
            if ((await call('link.open', {url:'file:///etc/passwd'})).ok) throw Error('outside link accepted');
            const waitFor = selector => until(() => document.querySelector(selector), 'Missing ' + selector);
            await accept('notes.write',{op:'create',note:{path:'guide.md',side:'head',start:3,end:3,commit:null,quote:'A **rendered** paragraph.',text:'Markdown note',state:'open',author:'operator'}});
            explorer.receive({ v:1, type:'notes.changed' });
            explorer.receive({ v:1, type:'open', path:'guide.md', line:3 });
            const paragraph = await waitFor('.markdown-preview p.has-note');
            if (!paragraph.classList.contains('markdown-jump')) throw Error('Markdown line jump');
            paragraph.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, button:0, detail:1}));
            const previewCard = await waitFor('.float-card');
            if (!previewCard.textContent.includes('Markdown note')) throw Error('Marked block opens its note');
            press('Escape');
            getSelection().selectAllChildren(paragraph);
            document.dispatchEvent(new Event('selectionchange'));
            await waitFor('.selection-strip:not([hidden])');
            getSelection().removeAllRanges();
            document.dispatchEvent(new KeyboardEvent('keydown', {key:'f', metaKey:true, bubbles:true}));
            const find = await waitFor('#find-slot:not([hidden]) input');
            find.value = 'rendered paragraph';
            find.dispatchEvent(new Event('input'));
            if (CSS.highlights.get('explorer-preview-current')?.size !== 1) throw Error('Find rendered text across inline formatting');
            const toggle = document.getElementById('preview-mode');
            toggle.click();
            await waitFor('#view-body .source-row');
            if (toggle.getAttribute('aria-pressed') !== 'false' || (await accept('hello')).settings.preview !== false) throw Error('Source toggle not retained');
            toggle.click();
            (await waitFor('.markdown-preview a')).click();
            await until(() => document.getElementById('file-title')?.textContent === 'example.ts', 'Relative preview link');
            return document.visibilityState;
            """, arguments: [:], in: nil, contentWorld: .page)
            guard result as? String == "visible" else { throw ExplorerError("verify", "WebKit did not render a visible page.") }
            try Data().write(to: cache.appendingPathComponent("added.txt"))
            let refreshed = try await host.page.view.callAsyncJavaScript("""
            for (let i = 0; i < 180 && !document.querySelector('[data-path="cache/added.txt"]'); i++) await new Promise(requestAnimationFrame);
            const folder = document.querySelector('[data-path="cache"]');
            const added = document.querySelector('[data-path="cache/added.txt"]');
            if (folder?.ariaExpanded !== 'true' || !added?.classList.contains('is-ignored')) throw Error('ignored folder did not refresh in place');
            return true;
            """, arguments: [:], in: nil, contentWorld: .page)
            guard refreshed as? Bool == true else { throw ExplorerError("verify", "The ignored folder did not refresh.") }
            try await verifyEditor(host.page.view)
            try await verifyTextMenu(host.page.view)
            try await verifyZoom(host)
        }
        print("Explorer verified: real page, ignored folders and file events, Markdown preview, Git review, search, note marks, card drafts, live prompt and answer, file create, save, edit drafts, conflict, and zoom.")
    }

    private static func verifyTextMenu(_ view: WKWebView) async throws {
        let result = try await view.callAsyncJavaScript("""
        const field = document.querySelector('[aria-label="Filter files"]');
        field.focus();
        field.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 40, clientY: 120}));
        const labels = [...document.querySelectorAll('.context-menu:not([hidden]) .menu-item')].map(item => item.textContent);
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        document.querySelector('.context-menu .menu-item')?.closest('.context-menu')?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        return labels.join('|');
        """, arguments: [:], in: nil, contentWorld: .page) as? String ?? ""
        guard result.contains("Paste"), result.contains("Select All"), !result.contains("Ask") else {
            throw ExplorerError("verify", "A text field's context menu showed \(result.debugDescription).")
        }
    }

    private static func verifyZoom(_ host: ExplorerHost) async throws {
        func key(_ characters: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = .command) throws -> Bool {
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
                                               characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else {
                throw ExplorerError("verify", "A zoom key event could not be created.")
            }
            return host.page.view.performKeyEquivalent(with: event)
        }
        // The check window is 898 points wide, a usual split: zooming to 125% keeps the sidebar beside the code.
        func expect(_ level: Double, _ label: String) async throws {
            guard host.zoom == level else { throw ExplorerError("verify", "Zoom \(label): \(host.zoom).") }
            let shown = try await host.page.view.callAsyncJavaScript("""
            const node = document.getElementById('zoom-level');
            const settled = () => (node.hidden ? '' : node.textContent) === expected && Math.abs(innerWidth * level - 898) < 2;
            for (let i = 0; i < 120 && !settled(); i++) await new Promise(requestAnimationFrame);
            if (!settled() || document.getElementById('app').classList.contains('narrow') || getComputedStyle(document.getElementById('sidebar')).display === 'none') return false;
            return (node.hidden ? '' : node.textContent) === expected && (await globalThis.explorer.request('hello')).settings.zoom === level;
            """, arguments: ["expected": level == 1 ? "" : "\(Int((level * 100).rounded()))%", "level": level], in: nil, contentWorld: .page)
            guard shown as? Bool == true else { throw ExplorerError("verify", "The page did not show or keep zoom \(label).") }
            guard host.page.view.pageZoom == CGFloat(level) else { throw ExplorerError("verify", "WebKit did not apply zoom \(label).") }
        }
        guard try key("=", 24) else { throw ExplorerError("verify", "Command-= was not handled.") }
        try await expect(1.1, "after Command-=")
        guard try key("+", 24, [.command, .shift]) else { throw ExplorerError("verify", "Command-+ was not handled.") }
        try await expect(1.25, "after Command-+")
        guard try key("-", 27), try key("-", 27), try key("-", 27) else { throw ExplorerError("verify", "Command-- was not handled.") }
        try await expect(0.9, "after Command--")
        _ = try key("=", 24, [.command, .option])
        guard host.zoom == 0.9 else { throw ExplorerError("verify", "Command-Option-= changed the zoom.") }
        guard try key("0", 29) else { throw ExplorerError("verify", "Command-0 was not handled.") }
        try await expect(1, "after Command-0")
        let reset = try await host.page.view.callAsyncJavaScript("""
        const level = (await globalThis.explorer.request('zoom', {step: 'in'})).zoom;
        const node = document.getElementById('zoom-level');
        for (let i = 0; i < 120 && node.hidden; i++) await new Promise(requestAnimationFrame);
        node.click();
        for (let i = 0; i < 120 && !node.hidden; i++) await new Promise(requestAnimationFrame);
        return level === 1.1 && node.hidden;
        """, arguments: [:], in: nil, contentWorld: .page)
        guard reset as? Bool == true else { throw ExplorerError("verify", "The zoom indicator did not reset the zoom.") }
        try await expect(1, "after the indicator reset")
    }

    private static func verifyEditor(_ view: WKWebView) async throws {
        _ = try await view.callAsyncJavaScript(#"""
        const app = globalThis.explorer;
        const select = s => document.querySelector(s);
        const control = label => [...select('#editor-toolbar').querySelectorAll('button')].find(b => b.textContent === label && !b.disabled);
        const row = path => select(`#sidebar-list [data-path="${path}"]`);
        const textarea = () => select('.edit-input');
        async function until(label, predicate) {
          for (let i=0; i<240; i++) {
            const value = predicate();
            if (value) return value;
            await new Promise(requestAnimationFrame);
          }
          throw Error(label);
        }
        function type(value) {
          const editor = textarea();
          editor.focus(); editor.select();
          if (!document.execCommand('insertText', false, value)) throw Error('platform insert');
        }
        const read = path => app.request('file.read', {path});
        select('[aria-label="New file"]').click();
        select('[aria-label="New file path"]').value = 'notes/todo.md';
        [...select('#overlay').querySelectorAll('button')].find(b => b.textContent === 'Create file').click();
        await until('new file did not open in edit mode', textarea);
        if (!select('#preview-mode').hidden || select('#wrap-lines').hidden) throw Error('Markdown edit mode controls');
        type('# Tasks\n');
        (await until('Save did not appear', () => control('Save'))).click();
        await until('first save did not settle', () => !textarea().readOnly && !control('Save'));
        const first = await read('notes/todo.md');
        if (first.text !== '# Tasks\n' || !first.editBase) throw Error('new file save');
        type('# My draft\n');
        row('example.ts').click();
        await until('navigation away from draft', () => !textarea() && select('#file-title').textContent === 'example.ts');
        if (!row('notes/todo.md')?.querySelector('.edited-mark')) throw Error('draft marker lost');
        row('notes/todo.md').click();
        await until('draft not restored', () => textarea()?.value === '# My draft\n');
        const { root } = await app.request('hello');
        const identity = { root: root.path, path: 'notes/todo.md' };
        await app.request('file.write', { ...identity, text: '# Disk edit\n', base: first.editBase });
        const overwrite = await until('no conflict notice after external write', () => control('Keep editing and overwrite on save'));
        if (textarea().value !== '# My draft\n' || !control('Reload disk version') || !control('Copy edited text')) throw Error('conflict draft or actions lost');
        const stale = await globalThis.webkit.messageHandlers.explorer.postMessage({v:1,type:'file.write',...identity,base:first.editBase,text:'stale'});
        if (stale.ok || stale.error.code !== 'conflict') throw Error('write with stale base accepted');
        overwrite.click();
        textarea().dispatchEvent(new KeyboardEvent('keydown', {key:'s',metaKey:true,bubbles:true,cancelable:true}));
        await until('overwrite did not settle', () => !textarea().readOnly && !control('Save'));
        if ((await read('notes/todo.md')).text !== '# My draft\n') throw Error('overwrite did not save');
        select('#edit-file').click();
        await until('Markdown preview did not return with the saved text', () => {
          return !select('#preview-mode').hidden && select('.markdown-preview h1')?.textContent === 'My draft';
        });
        select('#preview-mode').click();
        await until('Markdown source did not open', () => !select('.markdown-preview') && !select('#edit-file').hidden);
        select('#edit-file').click();
        if (!textarea() || !select('#preview-mode').hidden) throw Error('Markdown source edit mode');
        select('#edit-file').click();
        await until('Markdown source did not return', () => !textarea() && !select('#preview-mode').hidden);
        if (select('#preview-mode').getAttribute('aria-pressed') !== 'false') throw Error('Source choice lost after edit');
        row('crlf.txt').click();
        (await until('CRLF file unavailable', () => select('#file-title').textContent === 'crlf.txt' && !select('#edit-file').hidden && select('#edit-file'))).click();
        const edit = textarea();
        if (edit.value !== 'one\n  two\n') throw Error('CRLF textarea normalisation');
        edit.setSelectionRange(6,6);
        edit.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true}));
        if (edit.value !== 'one\n    two\n') throw Error('tab indent');
        document.execCommand('undo');
        if (edit.value !== 'one\n  two\n') throw Error('platform undo');
        type('one\n  changed\n');
        select('#edit-file').click();
        if (!control('Keep editing') || !control('Discard')) throw Error('no inline save confirmation');
        control('Save').click();
        await until('Save and leave did not close the editor', () => !textarea());
        if ((await read('crlf.txt')).text !== 'one\r\n  changed\r\n') throw Error('CRLF not preserved');
        (await until('ignored folder entry missing', () => row('cache/settings.txt'))).click();
        (await until('ignored file not editable', () => select('#file-title').textContent === 'settings.txt' && !select('#edit-file').hidden && select('#edit-file'))).click();
        type('unsaved ignored draft\n');
        const ignored = await read('cache/settings.txt');
        await app.request('file.write', {root:root.path, path:ignored.path, base:ignored.editBase, text:'changed on disk\n'});
        await until('no conflict for ignored path', () => control('Reload disk version'));
        if (textarea().value !== 'unsaved ignored draft\n') throw Error('ignored file draft lost');
        return true;
        """#, arguments: [:], in: nil, contentWorld: .page)
    }

    private static func scratchDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return url
    }

    private static func paint(_ view: WKWebView) async throws {
        _ = try await view.callAsyncJavaScript("await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return true;", arguments: [:], in: nil, contentWorld: .page)
    }

    private static func execute(target: Launch, resources: URL, store: URL, width: Int, height: Int, appearance: String?, zoom: Double? = nil,
                                live: LiveConfiguration? = nil, showIgnored: Bool = true,
                                body: @escaping (ExplorerHost, NSWindow) async throws -> Void) throws {
        let workspace = try prepareWorkspace(target)
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let screen = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let rect = CGRect(x: screen.minX, y: screen.minY, width: CGFloat(width), height: CGFloat(height))
        let window = CheckPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.isExcludedFromWindowsMenu = true
        if let appearance { window.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
        let host = ExplorerHost(target, workspace: workspace, store: store, resources: resources, showIgnored: showIgnored)
        if let zoom { host.setZoom(zoom) }
        window.contentView = host.page.view
        host.page.view.frame = CGRect(x: 0, y: 0, width: width, height: height)
        host.page.view.autoresizingMask = [.width, .height]
        if appearance != nil { host.page.view.appearance = window.appearance }
        if let appearance {
            host.page.view.configuration.userContentController.addUserScript(WKUserScript(source: "document.documentElement.dataset.theme = '\(appearance)';", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        defer { host.page.close(); window.orderOut(nil) }
        var result: Result<Void, Error>?
        func finish(_ outcome: Result<Void, Error>) {
            guard result == nil else { return }
            result = outcome
            app.stop(nil)
            if let event = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0,
                                              windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
                app.postEvent(event, atStart: true)
            }
        }
        host.page.onFailure = { finish(.failure($0)) }
        let job = Task {
            window.orderFrontRegardless()
            host.start(live: live)
            do {
                while !host.page.ready { try await Task.sleep(for: .milliseconds(25)) }
                let readyUntil = ProcessInfo.processInfo.systemUptime + 10
                while try await host.page.view.evaluateJavaScript("document.documentElement?.dataset.ready === 'true'") as? Bool != true {
                    guard ProcessInfo.processInfo.systemUptime < readyUntil else { throw ExplorerError("page", "The Explorer page did not finish opening its target.") }
                    try await Task.sleep(for: .milliseconds(30))
                }
                try await paint(host.page.view)
                try await body(host, window)
                finish(.success(()))
            } catch { finish(.failure(error)) }
        }
        let timeout = Task {
            do { try await Task.sleep(for: .seconds(18)) } catch { return }
            let stage = host.page.ready ? "rendering the target" : "waiting for the hello message"
            finish(.failure(ExplorerError("timeout", "The Explorer check timed out while \(stage).")))
        }
        defer { job.cancel(); timeout.cancel() }
        if result == nil { app.run() }
        guard let result else { throw ExplorerError("verify", "The Explorer check stopped unexpectedly.") }
        try result.get()
    }
}

private final class FakeLive {
    static let token = String(repeating: "a", count: 64)
    private let listener: NWListener
    private let queue = DispatchQueue(label: "explorer.verify.live")
    private var state: [String: Any] = ["sequence": 0, "status": "idle", "text": "", "truncated": false]
    private(set) var port: UInt16 = 0

    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { status in
            switch status { case .ready, .failed: ready.signal(); default: break }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.read(connection, Data())
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 3) == .success, let assigned = listener.port?.rawValue else {
            listener.cancel(); throw ExplorerError("verify", "The private live fixture did not listen.")
        }
        port = assigned
    }
    func stop() { listener.cancel() }

    private func read(_ connection: NWConnection, _ pending: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, let data, error == nil, pending.count + data.count <= mib else { connection.cancel(); return }
            let buffer = pending + data
            let delimiter = Data("\r\n\r\n".utf8)
            if let end = buffer.range(of: delimiter), let header = String(data: buffer[..<end.lowerBound], encoding: .utf8) {
                let lines = header.components(separatedBy: "\r\n")
                let length = lines.first { $0.lowercased().hasPrefix("content-length:") }?.dropFirst(15).trimmingCharacters(in: .whitespaces).flatMapInt
                if let length, length >= 0, buffer.count - end.upperBound >= length {
                    let body = buffer[end.upperBound..<(end.upperBound + length)]
                    self.respond(connection, headers: lines, body: Data(body)); return
                }
            }
            if complete { connection.cancel() } else { self.read(connection, buffer) }
        }
    }
    private func respond(_ connection: NWConnection, headers: [String], body: Data) {
        var result: [String: Any] = ["ok": true]
        guard headers.contains(where: { $0.lowercased() == "authorization: bearer \(Self.token)" }),
              let target = headers.first?.split(separator: " ").dropFirst().first,
              let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              fields["workspace"] is String, fields["document"] is String else { connection.cancel(); return }
        switch target {
        case "/connect": result["handle"] = "verify"; result["label"] = "Explorer verification"
        case "/poll": result["state"] = state; result["command"] = jsonNull
        case "/prompt":
            guard fields["text"] as? String == "Verify Explorer", let id = fields["requestId"], let thread = fields["threadId"] else { connection.cancel(); return }
            result["status"] = "admitted"
            state = ["sequence": 1, "status": "answer", "text": "Verified reply", "truncated": false, "requestId": id, "threadId": thread]
        case "/close", "/result": break
        default: connection.cancel(); return
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: result) else { connection.cancel(); return }
        let head = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n".utf8)
        connection.send(content: head + bytes, completion: .contentProcessed { _ in connection.cancel() })
    }
}

private extension String { var flatMapInt: Int? { Int(self) } }
