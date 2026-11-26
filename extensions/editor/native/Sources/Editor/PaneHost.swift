import AppKit
import Darwin
import NativePane
import OSLog

@MainActor
final class PaneHost {
    private let terminal: PaneTerminal
    private let api: any EditorAPI
    private let screen: WorkspaceScreen
    private let overlay = PaneOverlay(
        background: { MainActor.assumeIsolated { WorkspaceStyle.content } },
        logger: Logger(subsystem: "local.harness.editor", category: "pane"),
        eventDriven: true
    )
    private enum Startup {
        case loading, reportingLoad, waitingForPane, reportingVisibility, ready

        var deadlineProblem: String? {
            switch self {
            case .loading: "Editor did not receive its workspace in time. Run /editor again."
            case .reportingLoad: "Pi did not confirm Editor. Run /editor again."
            case .waitingForPane, .reportingVisibility, .ready: nil
            }
        }

        var placeholder: String {
            switch self {
            case .loading, .reportingLoad: "Editor is opening."
            case .waitingForPane, .reportingVisibility: "Editor is open and follows this pane when it is visible."
            case .ready: "Editor follows this pane."
            }
        }
    }

    private var startup = Startup.loading
    private var drawnMarker: String?
    private var focusRequested = false
    private var finished = false
    private var loading: Task<Void, Never>?
    private var acknowledgement: Task<Void, Never>?
    private var startupDeadline: Task<Void, Never>?
    private var closeRequest: Task<Void, Never>?
    private var occlusionObserver: NSObjectProtocol?

    init(terminal: PaneTerminal, api: any EditorAPI, screen: WorkspaceScreen) {
        self.terminal = terminal
        self.api = api
        self.screen = screen
    }

    func start(file: String?) {
        overlay.ready = false
        overlay.window.title = "Editor"
        overlay.window.onClose = { [weak self] in self?.requestClose() }
        screen.onDisconnect = { [weak self] hasUnsentText in self?.piClosed(hasUnsentText: hasUnsentText) }
        overlay.onChange = { [weak self] in self?.placementChanged() }
        occlusionObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification, object: overlay.window, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.presentIfVisible() } }

        let view = screen.view
        view.translatesAutoresizingMaskIntoConstraints = false
        overlay.content.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: overlay.content.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: overlay.content.trailingAnchor),
            view.topAnchor.constraint(equalTo: overlay.content.topAnchor),
            view.bottomAnchor.constraint(equalTo: overlay.content.bottomAnchor),
        ])

        terminal.onResize = { [weak self] in
            self?.drawPlaceholder()
            self?.overlay.anchor.refresh()
        }
        terminal.onBytes = { [weak self] bytes in
            if bytes.contains(3) || bytes.contains(4) {
                self?.requestClose()
            } else if bytes.contains(13) || bytes.contains(10) {
                self?.focusRequested = true
                self?.presentIfVisible()
            }
        }
        terminal.onHangUp = { [weak self] in self?.finish() }
        terminal.onTerminate = { [weak self] in self?.finish() }
        terminal.enter()
        terminal.start()
        drawPlaceholder()
        overlay.start()

        loading = Task { [weak self, screen] in
            do { try await screen.start(file: file) }
            catch {
                self?.finish(problem: "The workspace or requested file did not open. Check the path and run /editor again.")
                return
            }
            await self?.workspaceLoaded()
        }
        startupDeadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(15)) }
            catch { return }
            guard let self, let problem = startup.deadlineProblem else { return }
            finish(problem: problem)
        }
    }

    private func workspaceLoaded() async {
        guard !finished else { return }
        startup = .reportingLoad
        do { _ = try await api.call("loaded", [:]) }
        catch {
            finish(problem: "Pi did not confirm Editor. Run /editor again.")
            return
        }
        guard !finished else { return }
        startupDeadline?.cancel()
        startup = .waitingForPane
        drawPlaceholder()
        overlay.ready = true
        presentIfVisible()
    }

    private func drawPlaceholder() {
        guard !finished else { return }
        let marker = overlay.anchor.marker
        drawnMarker = marker
        let status = screen.isDisconnected ? "Pi closed. Editor still shows your unsent text." : startup.placeholder
        terminal.draw(title: "Editor", identity: "Native pane", status: status,
                      keys: "Return: Focus Editor   Ctrl-C: Close", command: nil, marker: marker)
    }

    private func placementChanged() {
        guard !finished else { return }
        if case .untrusted = overlay.anchor.status {
            finish(problem: "Allow Editor or its terminal app in System Settings > Privacy & Security > Accessibility. Then run /editor again.")
            return
        }
        if drawnMarker != overlay.anchor.marker { drawPlaceholder() }
        presentIfVisible()
    }

    private func presentIfVisible() {
        guard !finished, case .placed = overlay.anchor.status,
              overlay.window.isVisible, overlay.window.occlusionState.contains(.visible) else { return }
        if focusRequested {
            focusRequested = false
            overlay.window.makeKey()
        }
        guard startup == .waitingForPane else { return }
        startup = .reportingVisibility
        acknowledgement = Task { [weak self, api] in
            do {
                _ = try await api.call("ready", [:])
                guard let self, !finished else { return }
                startup = .ready
                drawPlaceholder()
            } catch {
                self?.finish(problem: "Pi did not confirm Editor. Run /editor again.")
            }
        }
    }

    func requestClose() {
        guard !finished, closeRequest == nil else { return }
        closeRequest = Task { [weak self, screen] in
            let safe = await screen.prepareToClose()
            guard let self else { return }
            closeRequest = nil
            if safe {
                if screen.isDisconnected { finish(terminalNotice: "Pi closed.", notifyPi: false) }
                else { finish() }
            }
        }
    }

    private func piClosed(hasUnsentText: Bool) {
        guard !finished else { return }
        if hasUnsentText {
            screen.showDisconnected { [weak self] in self?.requestClose() }
            drawPlaceholder()
        } else { finish(terminalNotice: "Pi closed.", notifyPi: false) }
    }

    private func finish(problem: String? = nil, terminalNotice: String? = nil, notifyPi: Bool = true) {
        guard !finished else { return }
        finished = true
        loading?.cancel()
        startupDeadline?.cancel()
        acknowledgement?.cancel()
        closeRequest?.cancel()
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
        overlay.stop()
        screen.stop()
        terminal.leave(before: .now() + .milliseconds(150))
        if let report = problem ?? terminalNotice { terminal.report("Editor: \(report)", before: .now() + .milliseconds(150)) }
        let status: Int32 = problem == nil ? 0 : 1
        if !notifyPi { _exit(status) }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(500)) { _exit(status) }
        Task { [api] in
            let fields: Fields = problem.map { ["error": $0] } ?? [:]
            _ = try? await api.call("closed", fields)
            _exit(status)
        }
    }
}
