import AppKit
import WebKit

@MainActor
enum SettingsCheck {
    static func run(directory: URL, live: (path: String, script: URL)? = nil) async -> Never {
        let deadline = DispatchWorkItem {
            FileHandle.standardError.write(Data("Settings check timed out.\n".utf8))
            exit(1)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (live == nil ? 35 : 85), execute: deadline)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if let live { try await runLive(directory, live) }
            else {
                for theme in ["light", "dark"] {
                    for width in [1000, 412] {
                        let page = try SettingsPage(frame: CGRect(x: 0, y: 0, width: width, height: 740), checkTheme: theme)
                        let window = mount(page, width)
                        defer { window.close() }
                        try await ready(page, fixture: true)
                        if theme == "light" && width == 1000 { try await checkKeyboard(page, window) }
                        try await capture(page, window, width, theme, directory)
                    }
                }
            }
            deadline.cancel()
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("Settings check: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    private static func runLive(_ directory: URL, _ live: (path: String, script: URL)) async throws {
        let (script, capability, digest) = try await Task.detached {
            let file = try FileHandle(forReadingFrom: live.script)
            defer { try? file.close() }
            guard let bytes = try file.read(upToCount: 262145), bytes.count <= 262144,
                  let script = String(data: bytes, encoding: .utf8) else { throw SettingsFailure("Use a UTF-8 script under 256 KiB.") }
            return (script, try Capability.consume(path: live.path), installedDigest())
        }.value
        let frame = CGRect(x: 0, y: 0, width: 1000, height: 740)
        let host = try SettingsHost(terminal: nil, capability: capability, query: nil, build: digest, checkFrame: frame,
                                    recoveryRoot: directory.appendingPathComponent("check-recovery", isDirectory: true))
        let page = host.page
        let window = mount(page, 1000)
        defer { window.close() }
        host.capture = { [weak page] name in
            guard let page, name.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", options: .regularExpression) != nil else {
                throw SettingsFailure("Use a simple snapshot name of at most 64 characters.")
            }
            try await snapshot(page, directory.appendingPathComponent("capture-\(name).png"))
        }
        do {
            try await ready(page, fixture: false)
            let result = try await page.view.callAsyncJavaScript("return JSON.stringify((await (async () => {\n\(script)\n})()) ?? null);", arguments: [:], in: nil, contentWorld: .page)
            guard let json = result as? String else { throw SettingsFailure("The check did not return JSON.") }
            try Data((json + "\n").utf8).write(to: directory.appendingPathComponent("result.json"), options: .atomic)
            for theme in ["light", "dark"] {
                for width in [1000, 412] { try await capture(page, window, width, theme, directory) }
            }
        } catch {
            await host.finishCheck()
            throw error
        }
        await host.finishCheck()
    }

    private final class CheckPanel: NSPanel {
        override var canBecomeKey: Bool { true }
    }

    private static func mount(_ page: SettingsPage, _ width: Int) -> NSWindow {
        let frame = NSRect(origin: NSScreen.main?.visibleFrame.origin ?? .zero, size: CGSize(width: width, height: 740))
        let window = CheckPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = page.view
        window.orderFrontRegardless()
        return window
    }

    private static func ready(_ page: SettingsPage, fixture: Bool) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            page.onLoad = { [weak page] in
                page?.onLoad = nil
                page?.onFailure = nil
                continuation.resume()
            }
            page.onFailure = { [weak page] reason in
                page?.onLoad = nil
                page?.onFailure = nil
                continuation.resume(throwing: SettingsFailure(reason))
            }
            page.load()
        }
        let script = """
        const root = document.documentElement;
        if (root.dataset.ready !== 'true') await new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => { if (root.dataset.ready === 'true') { observer.disconnect(); resolve(); } });
          observer.observe(root, { attributes: true });
          setTimeout(() => { observer.disconnect(); reject(new Error('Settings did not become ready: ' + document.body.innerText)); }, 15000);
        });
        if (fixture && document.querySelectorAll('article.row').length < 3) throw Error('Fixture settings did not render');
        return true;
        """
        _ = try await page.view.callAsyncJavaScript(script, arguments: ["fixture": fixture], in: nil, contentWorld: .page)
    }

    private static func checkKeyboard(_ page: SettingsPage, _ window: NSWindow) async throws {
        let script = """
        const check = (condition, text) => { if (!condition) throw Error(text); };
        const key = (key, metaKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey, bubbles: true, cancelable: true }));
        check([...document.querySelectorAll('nav button')].filter(node => node.textContent === 'Tools').length === 1, 'Expected one Tools page');
        check(!document.querySelector('.advanced-nav').open, 'Advanced should start collapsed');
        key('f', true);
        check(document.activeElement.id === 'search', 'Search shortcut did not focus search');
        key('ArrowDown');
        const first = document.activeElement;
        check(first.dataset.row, 'Arrow Down did not enter the settings list');
        key('ArrowDown');
        check(document.activeElement.dataset.row !== first.dataset.row, 'Arrow Down did not move to the next row');
        key('ArrowUp');
        check(document.activeElement === first, 'Arrow Up did not return to the first row');
        key('Enter');
        check(first.querySelector('details').open, 'Return did not open Details');
        key('Escape');
        check(!first.querySelector('details').open, 'Escape did not close Details');
        window.__settingsCheck.setDraft(first.dataset.row, 'global', 'light');
        document.querySelector('#revert').focus();
        return true;
        """
        window.makeFirstResponder(page.view)
        _ = try await page.view.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        for name in ["review", "save"] {
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, characters: "\t", charactersIgnoringModifiers: "\t", isARepeat: false, keyCode: 48) else {
                throw SettingsFailure("Could not create the Tab key event.")
            }
            page.view.keyDown(with: event)
            _ = try await page.view.callAsyncJavaScript("""
                if (document.activeElement.id !== name) await new Promise((resolve, reject) => {
                  const listener = () => { if (document.activeElement.id === name) { clearTimeout(timer); document.removeEventListener('focusin', listener); resolve(); } };
                  const timer = setTimeout(() => reject(Error('Tab expected ' + name + ', focused ' + document.activeElement.id)), 1500);
                  document.addEventListener('focusin', listener);
                });
                return true;
                """, arguments: ["name": name], in: nil, contentWorld: .page)
        }
        _ = try await page.view.callAsyncJavaScript("window.__settingsCheck.revert('pi:/theme'); document.activeElement.blur(); return true;", arguments: [:], in: nil, contentWorld: .page)
        print("Keyboard: search, row navigation, Details, and Tab from Revert through Review to Save passed.")
    }

    private static func capture(_ page: SettingsPage, _ window: NSWindow, _ width: Int, _ theme: String, _ directory: URL) async throws {
        window.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
        window.setContentSize(CGSize(width: width, height: 740))
        let narrow = width < 650
        let script = """
        document.documentElement.dataset.theme = theme;
        // A transparent check window need not be visible to WebKit. Reading layout below
        // flushes the resize without depending on animation frames in a hidden document.
        const main = document.querySelector('main');
        if (main.scrollWidth > main.clientWidth) throw Error('Horizontal catalogue overflow');
        if ((getComputedStyle(document.querySelector('#narrow-nav')).display !== 'none') !== narrow) throw Error('Wrong navigation for width');
        return true;
        """
        _ = try await page.view.callAsyncJavaScript(script, arguments: ["theme": theme, "narrow": narrow], in: nil, contentWorld: .page)
        try await snapshot(page, directory.appendingPathComponent("settings-\(theme)-\(narrow ? "narrow" : "wide").png"))
    }

    private static func snapshot(_ page: SettingsPage, _ url: URL) async throws {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = page.view.bounds
        configuration.afterScreenUpdates = true
        let png = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            page.view.takeSnapshot(with: configuration) { image, error in
                if let error { continuation.resume(throwing: error); return }
                guard let bytes = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: bytes),
                      let png = bitmap.representation(using: .png, properties: [:]) else {
                    continuation.resume(throwing: SettingsFailure("Could not encode a snapshot.")); return
                }
                continuation.resume(returning: png)
            }
        }
        try png.write(to: url, options: .atomic)
        print(url.path)
    }
}
