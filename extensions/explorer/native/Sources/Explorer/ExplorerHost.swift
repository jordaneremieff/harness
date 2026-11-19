import AppKit
import ExplorerPane
import OSLog

@MainActor
final class ExplorerHost {
    let page: ExplorerPage
    let store: URL
    let resources: URL
    private var workspace: Workspace
    private var launch: Launch
    private let version: [String: Any]
    private let terminal: PaneTerminal?
    private let overlay: PaneOverlay?
    private var commandLine: String?
    private var status = ""
    private var shownPath: String?
    private var wantsFocus = false
    private var opening = false
    private var closing = false
    private var live: LiveClient?
    private var watcher: ExplorerWatch?
    private var watchJob: Task<Void, Never>?
    private let state: ExplorerState

    init(_ launch: Launch, workspace: Workspace, store: URL, resources: URL, terminal: PaneTerminal? = nil) {
        self.launch = launch; self.workspace = workspace; self.store = store; self.resources = resources; self.terminal = terminal
        shownPath = launch.path
        let manifest = buildRecord(resources)
        let source = manifest["source"] as? [String: Any]
        version = ["version": "1.0", "commit": source?["commit"] ?? jsonNull]
        page = ExplorerPage(resources: resources, workspace: workspace)
        overlay = terminal.map { _ in
            PaneOverlay(background: { NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                    ? NSColor(srgbRed: 48 / 255, green: 52 / 255, blue: 70 / 255, alpha: 1)
                    : NSColor(srgbRed: 239 / 255, green: 241 / 255, blue: 245 / 255, alpha: 1)
            } }, logger: Logger(subsystem: "local.harness.explorer", category: "pane"), tracksWindowContent: true, eventDriven: true)
        }
        state = ExplorerState(store: store)
        page.receive = { [weak self] kind, fields in
            guard let self else { throw ExplorerError("unavailable", "Explorer is closed.") }
            return try await self.handle(kind, fields)
        }
        page.onReady = { [weak self] in
            guard let self else { return }
            self.overlay?.ready = true
            self.draw()
            self.focusIfReady()
        }
        page.onFailure = { [weak self] error in self?.status = error.localizedDescription; self?.draw() }
    }

    func start(live configuration: LiveConfiguration? = nil) {
        if let overlay, let terminal {
            overlay.ready = false
            overlay.window.onClose = { [weak self] in self?.close() }
            overlay.window.onCancel = { [weak self] in self?.overlay?.releaseFocus() }
            overlay.onChange = { [weak self] in self?.draw(); self?.focusIfReady() }
            mount(in: overlay.content)
            terminal.onInput = { [weak self] events in self?.input(events) }
            terminal.onResize = { [weak self] in self?.overlay?.anchor.refresh(); self?.draw() }
            terminal.onHangUp = { [weak self] in self?.close(terminalGone: true) }
            terminal.onTerminate = { [weak self] in self?.close() }
            terminal.enter(); terminal.start(); overlay.start(); draw()
        }
        if let configuration {
            let client = LiveClient(configuration)
            live = client
            client.emit = { [weak self] kind, fields in _ = await self?.page.send(kind, fields) }
            client.navigate = { [weak self] target in
                guard let self else { throw ExplorerError("unavailable", "Explorer is closed.") }
                try await self.open(Launch(target: target))
            }
            client.start()
        }
        watch()
        remember()
        page.load()
    }

    func mount(in parent: NSView) {
        page.view.translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(page.view)
        NSLayoutConstraint.activate([page.view.topAnchor.constraint(equalTo: parent.topAnchor),
                                     page.view.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
                                     page.view.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
                                     page.view.trailingAnchor.constraint(equalTo: parent.trailingAnchor)])
    }

    private func remember() {
        let helper = NotesHelper(workspace: workspace, store: store, resources: resources)
        Task.detached(priority: .utility) { _ = try? helper.call("remember") }
    }

    private func watch() {
        watchJob?.cancel(); watcher = nil
        let workspace = self.workspace, store = self.store
        watchJob = Task { [weak self] in
            let next = await Task.detached(priority: .utility) { [weak self] in
                ExplorerWatch(workspace: workspace, store: store) { [weak self] kind, fields in
                    Task { @MainActor [weak self] in
                        guard let self, self.workspace === workspace else { return }
                        _ = await self.page.send(kind, fields)
                    }
                }
            }.value
            guard !Task.isCancelled else { return }
            self?.watcher = next
        }
    }

    private func open(_ target: Launch) async throws {
        guard !opening, !closing else { throw ExplorerError("busy", "Explorer is busy.") }
        opening = true; defer { opening = false }
        let (next, info) = try await Task.detached(priority: .userInitiated) {
            let next = try prepareWorkspace(target)
            return (next, next.info())
        }.value
        guard !closing else { throw ExplorerError("unavailable", "Explorer is closing.") }
        await page.flushDraft()
        guard !closing else { throw ExplorerError("unavailable", "Explorer is closing.") }
        let previous = workspace, previousLaunch = launch, previousPath = shownPath
        workspace = next; launch = target; shownPath = target.path
        page.replaceWorkspace(next)
        if page.ready {
            let fields = state.restore(root: next.root, launch: target.fields).merging(["root": info]) { value, _ in value }
            guard await page.send("open", fields) else {
                workspace = previous; launch = previousLaunch; shownPath = previousPath
                page.replaceWorkspace(previous)
                throw ExplorerError("page", "The page did not accept the location.")
            }
        }
        watch(); remember(); status = ""; draw()
    }

    private func input(_ events: [PaneInput.Event]) {
        for event in events {
            switch event {
            case .quit: close()
            case .focus: wantsFocus = true; focusIfReady()
            case .line(let value): commandLine = value; draw()
            case .command(let text):
                Task {
                    do { try await open(Launch(arguments: paneArguments(text))) }
                    catch { status = error.localizedDescription; draw() }
                }
            }
        }
    }

    private func focusIfReady() {
        guard wantsFocus, let overlay, overlay.ready, overlay.window.isVisible else { return }
        wantsFocus = false
        overlay.window.makeKeyAndOrderFront(nil)
        overlay.window.makeFirstResponder(page.view)
    }

    private func draw() {
        guard let terminal, let overlay else { return }
        let commit = (version["commit"] as? String).map { String($0.prefix(8)) } ?? (version["version"] as? String ?? "")
        terminal.draw(title: "Explorer", identity: workspace.root.path + (shownPath.map { "/\($0)" } ?? ""),
                      status: status.isEmpty ? "Build \(commit)" : status, keys: "q close  ·  :open …  ·  any other key focuses Explorer",
                      command: commandLine, marker: overlay.anchor.marker)
    }

    private func close(terminalGone: Bool = false) {
        guard !closing else { return }
        closing = true
        watchJob?.cancel(); watcher = nil; live?.stop()
        Task {
            await page.flushDraft()
            page.close(); overlay?.stop()
            if !terminalGone { terminal?.leave(before: .now() + .milliseconds(350)) }
            if terminal != nil { DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(250)) { Darwin.exit(0) } }
        }
    }

    private func handle(_ type: String, _ fields: [String: Any]) async throws -> [String: Any] {
        let workspace = self.workspace
        switch type {
        case "hello":
            let launch = self.launch, version = version, live = live?.info ?? ["connected": false, "reason": "No live Pi conversation is attached."]
            let info = await Task.detached(priority: .userInitiated) { workspace.info() }.value
            return ["root": info, "launch": state.restore(root: workspace.root, launch: launch.fields), "settings": state.settings,
                    "live": live, "build": version]
        case "clipboard.write":
            guard let text = fields["text"] as? String else { throw ExplorerError("invalid", "Clipboard text is required.") }
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(text, forType: .string) else { throw ExplorerError("io", "The clipboard could not be written.") }
        case "clipboard.read": return ["text": NSPasteboard.general.string(forType: .string) ?? ""]
        case "finder.reveal":
            guard let path = fields["path"] as? String, let (fd, url) = try openContained(workspace.root, path) else {
                throw ExplorerError("not-found", "The file is not available to reveal.")
            }
            Darwin.close(fd)
            NSWorkspace.shared.activateFileViewerSelecting([url])
        case "focus.return": overlay?.releaseFocus()
        case "settings.save": try state.saveSettings(fields["settings"])
        case "state.save":
            if try state.save(root: workspace.root, fields: fields) {
                shownPath = fields["path"] as? String; draw()
            }
        case "prompt":
            guard let live else { throw ExplorerError("unavailable", "No live Pi conversation is attached.") }
            return try await live.submit(fields)
        default:
            let service = ExplorerServices(workspace: workspace, store: store, resources: resources)
            return try await Task.detached(priority: .userInitiated) { try service.handle(type, fields) }.value
        }
        return [:]
    }
}

func prepareWorkspace(_ launch: Launch) throws -> Workspace {
    let workspace = try Workspace(launch.root)
    if let path = launch.path, let (fd, _) = try openContained(workspace.root, path) { Darwin.close(fd) }
    return workspace
}
