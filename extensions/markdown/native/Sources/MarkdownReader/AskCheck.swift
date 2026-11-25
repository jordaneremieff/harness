import AppKit
import Foundation
import MarkdownCore
import ReaderFeature

extension CheckRunner {
    /// Opens a stored document as a live pane does, with the launch's own connection to its Pi
    /// conversation, in an offscreen panel. It asks about the document with the Ask about Document
    /// shortcut, types the question with real key events and sends it with Command-Return, then
    /// reports what the card shows until the conversation answers or `seconds` pass.
    ///
    /// The panel is never the system's key window, so the menu bar does not validate the shortcut
    /// against it. When the shortcut does not open the card, the check sends the command that the
    /// menu item sends and reports that it did.
    func askCheck(store: String, document: String, text: String, seconds: Double, output: String?) async -> Int32 {
        var report: [String: Any] = ["document": document]
        func finish(_ pass: Bool, _ detail: String) -> Int32 {
            report["pass"] = pass
            report["detail"] = detail
            CheckRunner.emit(report, to: output)
            return pass ? 0 : 1
        }
        guard let live else { return finish(false, "The launch's live connection was not available; nothing was sent.") }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-reader-ask-check-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = FileAccess.canonicalPath(store)
        let storeId: String
        do { storeId = try DirectoryStore(root: URL(fileURLWithPath: root)).storeId } catch {
            return finish(false, "The store did not open: \(error)")
        }
        let model = ReaderModel(reference: .stored(root: root, storeId: storeId, document: document), platform: windows.platform, state: windows.state)
        model.followsLatest = true
        let workspace = EditorWorkspace(directory: scratch.appendingPathComponent("Drafts"), store: root, automaticallySaves: true)
        workspace.reading = model
        workspace.startCollaboration(live)
        let surface = ReaderSurface(model: model, state: windows.state, chrome: "pane", workspace: workspace)
        let window = FocusedPanel(contentRect: NSRect(x: -20000, y: -20000, width: 800, height: 700), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.contentView = surface
        window.orderFrontRegardless()
        defer {
            workspace.collaboration?.stop()
            window.close()
            withExtendedLifetime(surface) {}
        }
        func js(_ body: String) async -> Any? { try? await model.page.callJavaScript(body, contentWorld: .page) }
        func wait(_ limit: Double, _ condition: () async -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(limit)
            while Date() < deadline {
                if await condition() { return true }
                try? await Task.sleep(for: .milliseconds(100))
            }
            return await condition()
        }
        // As NSApplication delivers a key press to its key window: the window's key equivalents,
        // then the menu's, then the window's first responder.
        func key(_ code: UInt16, _ characters: String, flags: NSEvent.ModifierFlags = [], ignoring: String? = nil) async -> String {
            var route = "page"
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: ignoring ?? characters, isARepeat: false, keyCode: code) else { continue }
                if type == .keyDown, window.performKeyEquivalent(with: event) { route = "window"; continue }
                if type == .keyDown, NSApp.mainMenu?.performKeyEquivalent(with: event) == true { route = "menu"; continue }
                window.sendEvent(event)
            }
            _ = await js("await new Promise(r => setTimeout(r, 40)); return true;")
            return route
        }
        let card = "const c = document.querySelector('[data-role=\"ask-card\"]'); return c?.hasAttribute('data-open') ? (c.dataset.state ?? '') + ' | ' + c.textContent : '';"

        await model.open(revision: nil, digest: nil, origin: nil)
        guard await wait(10, { model.page.documentReady && model.phase == .ready }) else {
            return finish(false, "The stored document did not open in the page.")
        }
        // The pane's connection binds to its document before an Ask can reach the conversation.
        _ = await wait(10) { workspace.collaboration?.connectionStatus.lowercased().contains("connect") == false }
        report["connection"] = workspace.collaboration?.connectionStatus ?? "none"
        window.makeFirstResponder(model.page.webView)

        let shortcut = await key(46, "µ", flags: [.command, .option], ignoring: "m")
        var opened = await wait(1) { (await js(card) as? String ?? "") != "" }
        report["shortcut"] = opened ? "Command-Option-M opened the card through the \(shortcut)" : "Command-Option-M did not open the card (\(shortcut))"
        if !opened {
            surface.sendCommand("askDocument")
            opened = await wait(2) { (await js(card) as? String ?? "") != "" }
            report["opened"] = opened ? "the Ask about Document menu command" : "nothing"
        }
        guard opened else { return finish(false, "No Ask card opened.") }
        for character in text { _ = await key(0, String(character)) }
        let typed = await js("return document.querySelector('[data-role=\"ask-card\"] textarea')?.value ?? '';") as? String ?? ""
        report["typed"] = typed
        report["send"] = await key(36, "\r", flags: [.command])
        report["afterSend"] = await js(card) as? String ?? ""
        let settled = await wait(seconds) {
            let shown = await js(card) as? String ?? ""
            let state = shown.split(separator: " | ").first.map(String.init) ?? ""
            return ["answered", "unanswered", "failed"].contains(state) || shown.contains("Not sent")
        }
        let final = await js(card) as? String ?? ""
        report["final"] = final
        await model.close()
        let state = final.split(separator: " | ").first.map(String.init) ?? ""
        let pass = typed == text && settled && state == "answered"
        return finish(pass, pass ? "The question reached the conversation and its answer shows in the card." : "The card ended as: \(final.prefix(400))")
    }
}
