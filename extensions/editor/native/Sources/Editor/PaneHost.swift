import AppKit
import Darwin
import NativePane
import OSLog

@MainActor
final class PaneHost {
    private let terminal: PaneTerminal
    private let service: EditorService
    private let screen: WorkspaceScreen
    private let startupReport: EditorStartupReport
    private let overlay = PaneOverlay(
        background: { MainActor.assumeIsolated { WorkspaceStyle.content } },
        logger: Logger(subsystem: "local.harness.editor", category: "pane"),
        eventDriven: true
    )
    private enum Startup {
        case loading, reconnecting, ready, disconnected

        var placeholder: String {
            switch self {
            case .loading: "Editor is opening."
            case .reconnecting: "Editor is reconnecting to its workspace service."
            case .ready: "Editor follows this pane when it is visible."
            case .disconnected: "The workspace service stopped. Editor still shows your text."
            }
        }
    }

    private var startup = Startup.loading
    private var workspaceOpened = false
    private var workspaceLoaded = false
    private var reportedVisibility: Bool?
    private var drawnMarker: String?
    private var focusRequested = false
    private var finished = false
    private var loading: Task<Void, Never>?
    private var visibilityReport: Task<Void, Never>?
    private var startupDeadline: Task<Void, Never>?
    private var closeRequest: Task<Void, Never>?
    private var occlusionObserver: NSObjectProtocol?

    init(terminal: PaneTerminal, service: EditorService, screen: WorkspaceScreen, startupReport: EditorStartupReport) {
        self.terminal = terminal
        self.service = service
        self.screen = screen
        self.startupReport = startupReport
    }

    func start(file: String?) {
        overlay.ready = false
        overlay.window.title = "Editor"
        overlay.window.onClose = { [weak self] in self?.requestClose() }
        overlay.onChange = { [weak self] in self?.placementChanged() }
        occlusionObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification, object: overlay.window, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.presentationChanged() } }
        service.onStatus = { [weak self] status in self?.serviceChanged(status, file: file) }

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
                self?.presentationChanged()
            }
        }
        terminal.onHangUp = { [weak self] in self?.finish() }
        terminal.onTerminate = { [weak self] in self?.finish() }
        terminal.enter()
        terminal.start()
        drawPlaceholder()
        overlay.start()
        service.start()
    }

    private func serviceChanged(_ status: EditorService.Status, file: String?) {
        guard !finished else { return }
        switch status {
        case .ready:
            loadWorkspace(file: file)
        case .reconnecting:
            loading?.cancel(); loading = nil
            startupDeadline?.cancel(); startupDeadline = nil
            visibilityReport?.cancel(); visibilityReport = nil
            reportedVisibility = nil
            startup = .reconnecting
            drawPlaceholder()
        case .failed(let problem):
            if workspaceOpened {
                if !workspaceLoaded { startupReport.write(problem) }
                startup = .disconnected
                screen.showDisconnected { [weak self] in self?.requestClose() }
                overlay.ready = true
                drawPlaceholder()
            } else {
                finish(problem: problem)
            }
        }
    }

    private func loadWorkspace(file: String?) {
        startupDeadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            guard let self else { return }
            let operation = workspaceOpened ? "confirm workspace readiness" : "open the workspace or requested file"
            service.retry(problem: "Editor did not \(operation) in time.")
        }
        loading = Task { [weak self] in
            guard let self, !finished, !Task.isCancelled else { return }
            let wasOpen = workspaceOpened
            if !wasOpen {
                do { try await screen.start(file: file) }
                catch {
                    if !Task.isCancelled {
                        finish(problem: Self.problem("open the workspace or requested file", error: error))
                    }
                    return
                }
                guard !Task.isCancelled else { return }
                workspaceOpened = true
            }
            do { _ = try await service.call("loaded") }
            catch {
                if !Task.isCancelled { service.retry(problem: Self.problem("confirm workspace readiness", error: error)) }
                return
            }
            guard !Task.isCancelled else { return }
            workspaceLoaded = true
            startupDeadline?.cancel(); startupDeadline = nil
            loading = nil
            if wasOpen { screen.restartWorkspaceEvents() }
            startup = .ready
            drawPlaceholder()
            overlay.ready = true
            presentationChanged()
        }
    }

    private func drawPlaceholder() {
        guard !finished else { return }
        let marker = overlay.anchor.marker
        drawnMarker = marker
        terminal.draw(title: "Editor", identity: "Native pane", status: startup.placeholder,
                      keys: "Return: Focus Editor   Ctrl-C: Close", command: nil, marker: marker)
    }

    private func placementChanged() {
        guard !finished else { return }
        if case .untrusted = overlay.anchor.status {
            finish(problem: "Allow Editor or its terminal app in System Settings > Privacy & Security > Accessibility. Then run /editor again.")
            return
        }
        if drawnMarker != overlay.anchor.marker { drawPlaceholder() }
        presentationChanged()
    }

    private var isVisible: Bool {
        guard case .placed(let placement) = overlay.anchor.status, !placement.coveredEntirely else { return false }
        return overlay.window.isVisible && overlay.window.occlusionState.contains(.visible)
    }

    private func presentationChanged() {
        guard !finished else { return }
        let visible = isVisible
        if visible, focusRequested {
            focusRequested = false
            overlay.window.makeKey()
        }
        guard startup == .ready, visibilityReport == nil, visible != reportedVisibility else { return }
        visibilityReport = Task { [weak self] in
            guard let self, !Task.isCancelled else { return }
            do { _ = try await service.call("visibility", ["visible": visible]) }
            catch {
                if !Task.isCancelled { service.retry(problem: Self.problem("report pane visibility", error: error)) }
                return
            }
            guard !Task.isCancelled else { return }
            visibilityReport = nil
            reportedVisibility = visible
            presentationChanged()
        }
    }

    func requestClose() {
        guard !finished, closeRequest == nil else { return }
        closeRequest = Task { [weak self, screen] in
            let safe = await screen.prepareToClose()
            guard let self else { return }
            closeRequest = nil
            if safe { finish() }
        }
    }

    private static func problem(_ operation: String, error: Error) -> String {
        let cause: String
        if let issue = error as? EditorIssue {
            switch issue.code {
            case "not_found": cause = "the requested file or folder was not found"
            case "invalid": cause = "the workspace service rejected the request as invalid"
            case "limit": cause = "the request exceeded a workspace service limit"
            case "response": cause = "the workspace service returned an invalid response"
            case "service_timeout": cause = "the workspace service did not respond in time"
            case "service_unavailable": cause = "the workspace service was unavailable"
            default: cause = "the workspace service refused the request"
            }
        } else if let network = error as? URLError {
            cause = "network error \(network.code.rawValue)"
        } else {
            cause = "error \((error as NSError).code)"
        }
        return "Editor could not \(operation): \(cause)."
    }

    private func finish(problem: String? = nil) {
        guard !finished else { return }
        finished = true
        if let problem, !workspaceLoaded { startupReport.write(problem) }
        loading?.cancel()
        startupDeadline?.cancel()
        visibilityReport?.cancel()
        closeRequest?.cancel()
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
        overlay.stop()
        screen.stop()
        terminal.leave(before: .now() + .milliseconds(150))
        if let problem { terminal.report("Editor: \(problem)", before: .now() + .milliseconds(150)) }
        service.stop { _exit(problem == nil ? 0 : 1) }
    }
}
