import AppKit
import NativePane
import OSLog

@MainActor
final class ConfigHost {
    private let overlay = PaneOverlay(background: {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? NSColor(srgbRed: 48 / 255, green: 52 / 255, blue: 70 / 255, alpha: 1)
                : NSColor(srgbRed: 239 / 255, green: 241 / 255, blue: 245 / 255, alpha: 1)
        }
    }, logger: Logger(subsystem: "local.harness.config", category: "pane"), tracksWindowContent: true, eventDriven: true)
    private let terminal: PaneTerminal?
    let page: ConfigPage
    var capture: ((String) async throws -> Void)?
    private let recoveryRoot: URL?
    private let bridge: Transport
    private let build: String?
    private var store: RecoveryStore?
    private var attached = false
    private var connecting = false
    private var closing = false
    private var wantsFocus = false
    private var poll: Task<Void, Never>?

    init(terminal: PaneTerminal?, capability: Capability, query: String?, build: String?, checkFrame: CGRect? = nil, recoveryRoot: URL? = nil) throws {
        self.terminal = terminal
        self.build = build
        self.recoveryRoot = recoveryRoot
        bridge = Transport(capability: capability)
        page = try ConfigPage(frame: checkFrame ?? overlay.content.bounds, query: query, checkTheme: checkFrame == nil ? nil : "light", liveCheck: checkFrame != nil)
        page.receive = { [weak self] op, payload in
            guard let self else { throw ConfigFailure("This Config pane closed.") }
            return try await self.handle(op, payload)
        }
    }

    func start() {
        guard let terminal else { return }
        overlay.ready = false
        overlay.content.addSubview(page.view)
        overlay.onChange = { [weak self] in self?.place() }
        overlay.window.onClose = { [weak self] in self?.requestClose() }
        overlay.window.onCancel = { [weak self] in Task { await self?.page.send("cancel") } }
        page.onFailure = { [weak self] reason in
            guard let self else { return }
            self.overlay.ready = false
            self.draw(reason)
        }
        terminal.onResize = { [weak self] in self?.overlay.anchor.refresh() }
        terminal.onHangUp = { [weak self] in self?.finish() }
        terminal.onTerminate = { [weak self] in self?.requestClose() }
        terminal.onBytes = { [weak self] bytes in
            guard let self else { return }
            if bytes.contains(3) || bytes.contains(4) { requestClose() }
            else { wantsFocus = true; place() }
        }
        terminal.enter()
        terminal.start()
        draw("Waiting for the native interface.")
        overlay.start()
        page.load()
    }

    private func draw(_ status: String) {
        terminal?.draw(title: "Config", identity: "Pi and harness", status: status,
                      keys: "Click or press a key to focus Config. Ctrl-C closes.", command: nil, marker: overlay.anchor.marker)
    }

    private func place() {
        guard let terminal else { return }
        terminal.drawMarker(overlay.anchor.marker)
        if wantsFocus, overlay.window.isVisible {
            wantsFocus = false
            overlay.window.makeKeyAndOrderFront(nil)
            overlay.window.makeFirstResponder(page.view)
        }
    }

    private func handle(_ op: String, _ fields: [String: Any]) async throws -> [String: Any] {
        guard !closing else { throw ConfigFailure("This Config pane is closing.") }
        switch op {
        case "connect":
            guard !attached, !connecting else { throw ConfigFailure("This pane already requested a session.") }
            connecting = true
            var request: [String: Any] = ["version": 1]
            if let build { request["build"] = build }
            let response = try await post(.connect, request)
            guard let context = response["context"] as? [String: Any],
                  let agentDir = context["agentDir"] as? String, let cwd = context["cwd"] as? String else {
                throw ConfigFailure("Pi did not identify the original session.")
            }
            attached = true
            if let recoveryRoot { store = RecoveryStore(agentDir: agentDir, cwd: cwd, applicationSupport: recoveryRoot) }
            else { store = RecoveryStore(agentDir: agentDir, cwd: cwd) }
            return response
        case "ready":
            if terminal != nil { overlay.ready = true }
            place()
            if attached && poll == nil { poll = Task { await runPoll() } }
            return ["ok": true]
        case "catalogue":
            guard attached, let generation = fields["generation"] as? Int, generation >= 0 else { throw ConfigFailure("Invalid catalogue request.") }
            return try await post(.catalogue, ["generation": generation])
        case "edit":
            guard attached, let request = fields["request"] as? [String: Any] else { throw ConfigFailure("Invalid edit request.") }
            return try await post(.edit, ["request": request])
        case "tools":
            guard attached else { throw ConfigFailure("This pane has no session.") }
            return try await post(.tools)
        case "toolsApply":
            guard attached, let change = fields["change"] as? [String: Any] else { throw ConfigFailure("Invalid tools request.") }
            return try await post(.toolsApply, ["change": change])
        case "draftLoad":
            guard let store else { throw ConfigFailure("This pane has no draft target.") }
            let recoveries = try await store.load()
            return ["recoveries": recoveries.compactMap { recovery -> [String: Any]? in
                guard let snapshot = try? JSONSerialization.jsonObject(with: recovery.data) else { return nil }
                return ["id": recovery.id, "snapshot": snapshot]
            }]
        case "draftSave":
            guard let store, let snapshot = fields["snapshot"] as? [String: Any], snapshot["version"] as? Int == 1,
                  let drafts = snapshot["drafts"] as? [Any] else { throw ConfigFailure("Invalid recovery snapshot.") }
            try await store.save(drafts.isEmpty ? nil : JSONSerialization.data(withJSONObject: snapshot))
            return ["ok": true]
        case "draftDiscard":
            guard let store, let id = fields["id"] as? String else { throw ConfigFailure("Invalid recovery id.") }
            try await store.discard(id: id)
            return ["ok": true]
        case "checkSnapshot":
            guard let capture, let name = fields["name"] as? String else { throw ConfigFailure("Snapshot unavailable.") }
            try await capture(name)
            return ["ok": true]
        case "close":
            guard terminal != nil else { throw ConfigFailure("The check owns this pane's lifetime.") }
            finish()
            return ["ok": true]
        default:
            throw ConfigFailure("Unknown Config message.")
        }
    }

    private func post(_ route: Route, _ fields: [String: Any] = [:]) async throws -> [String: Any] {
        let bytes = try JSONSerialization.data(withJSONObject: fields)
        let reply = try await bridge.post(route, bytes)
        guard let object = try JSONSerialization.jsonObject(with: reply) as? [String: Any] else {
            throw ConfigFailure("Invalid reply from Pi.")
        }
        return object
    }

    private func runPoll() async {
        var sequence = 0
        while !Task.isCancelled && !closing {
            do {
                let reply = try await post(.poll, ["after": sequence])
                guard let current = reply["sequence"] as? Int, current >= sequence,
                      let changed = reply["changed"] as? Bool else { throw ConfigFailure("Invalid poll reply.") }
                sequence = current
                if closing || Task.isCancelled { return }
                if let command = reply["command"] as? [String: Any], command["op"] as? String == "reveal" {
                    wantsFocus = true
                    place()
                    await page.send("command", ["command": command])
                }
                if changed { await page.send("changed") }
            } catch {
                if !closing && !Task.isCancelled { await page.send("disconnected") }
                return
            }
        }
    }

    func requestClose() {
        guard !closing else { return }
        Task { if !((await page.send("close"))) { finish() } }
    }

    func finishCheck() async {
        closing = true
        poll?.cancel()
        if attached { _ = try? await post(.close) }
    }

    private func finish() {
        guard !closing else { return }
        closing = true
        poll?.cancel()
        overlay.releaseFocus()
        overlay.stop()
        let deadline = DispatchTime.now() + .milliseconds(800)
        terminal?.leave(before: deadline)
        DispatchQueue.main.asyncAfter(deadline: deadline) { exit(0) }
        Task {
            if attached { _ = try? await post(.close) }
            exit(0)
        }
    }

    static func menu() -> NSMenu {
        let menu = NSMenu()
        let app = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = app
        menu.addItem(appItem)
        app.addItem(withTitle: "Close Config", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = NSMenu(title: "Edit")
        let editItem = NSMenuItem()
        editItem.submenu = edit
        menu.addItem(editItem)
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        return menu
    }
}
