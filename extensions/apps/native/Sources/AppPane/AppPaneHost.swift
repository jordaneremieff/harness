import AppKit
import ApplicationServices
import AppPaneCore
import NativePane
import OSLog

let paneLog = Logger(subsystem: "local.harness.app-pane", category: "pane")

/// Shows one window of another application in the terminal pane that runs this program.
///
/// The real window sits exactly on the pane and follows it when the layout changes. While the
/// window's application is active, the window lies in front and takes input directly. While the
/// terminal is in front, a panel over the pane shows a live capture of the window, so the pane
/// keeps showing the application; a click on it, or a key typed in the pane, makes the window's
/// application active again. While the pane is not on screen, for example in another tab, the
/// window waits outside the screen.
///
/// Closing the pane ends the program: a window that the pane opened closes, and a window that it
/// took returns to its earlier place. Closing the window, or quitting its application, closes the
/// pane.
@MainActor
final class AppPaneHost {
    private let request: PaneRequest
    private let terminal: PaneTerminal
    private let overlay = PaneOverlay(background: { NSColor.windowBackgroundColor }, logger: paneLog)
    private let mirror = MirrorView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
    private var entry: AppEntry?
    private var window: DockedWindow?
    private var lock: WindowLock?
    private var browserWindow: String?
    private var shownTitle = ""
    private var message: String?
    private var timer: Timer?
    private var termination: NSObjectProtocol?
    private var ending = false
    /// The application's windows when the pane took the shown window, and, after that window
    /// closed, until when the pane waits for a window that replaces it.
    private var known: [AXUIElement] = []
    private var replacing: (since: [AXUIElement], until: Date)?

    init(request: PaneRequest, terminal: PaneTerminal) {
        self.request = request
        self.terminal = terminal
    }

    func start() {
        terminal.enter()
        terminal.onInput = { [weak self] events in self?.input(events) }
        terminal.onResize = { [weak self] in
            self?.draw()
            self?.overlay.anchor.refresh()
        }
        terminal.onHangUp = { [weak self] in self?.end(status: 0, terminalGone: true) }
        terminal.onTerminate = { [weak self] in self?.end(status: 0) }
        terminal.start()
        mirror.frame = overlay.content.bounds
        mirror.autoresizingMask = [.width, .height]
        mirror.onClick = { [weak self] in self?.giveKeyboard() }
        mirror.onState = { [weak self] in self?.draw() }
        overlay.content.addSubview(mirror)
        // The window server counts an opaque window as covering the windows behind it, and
        // Chromium-based applications stop drawing pages that are covered. A panel just short of
        // opaque leaves the docked window counted as visible, so the capture stays live.
        overlay.window.alphaValue = 0.99
        overlay.ready = false
        overlay.onChange = { [weak self] in self?.follow() }
        overlay.start()
        draw()
        Task { await open() }
    }

    // MARK: - Opening

    private func open() async {
        let entry: AppEntry
        switch Catalogue.resolve(request.app) {
        case .found(let found): entry = found
        case .missing: return fail("No application on this Mac matches \"\(request.app)\".")
        case .ambiguous(let entries):
            return fail("\"\(request.app)\" matches several applications: \(entries.map(\.name).joined(separator: ", ")). Name one of them exactly.")
        }
        self.entry = entry
        draw()
        let scripting = BrowserScripting(bundleIdentifier: entry.bundleIdentifier)
        if request.url != nil, scripting == nil { return fail("\(entry.name) is not a browser that a pane can open at an address.") }
        do {
            let application = try await Opening.running(entry)
            let pid = application.processIdentifier
            watchTermination(of: pid)
            let element: AXUIElement
            let created: Bool
            if let scripting, request.window == nil {
                let opened = try await Opening.newBrowserWindow(entry, pid: pid, scripting: scripting, url: request.url)
                element = opened.0
                browserWindow = opened.1.isEmpty ? nil : opened.1
                created = true
                // The panel's order over the terminal depends on which application is active;
                // it waits until the activation that the browser took has gone back.
                let settled = Date().addingTimeInterval(1)
                while NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, Date() < settled {
                    try? await Task.sleep(for: .milliseconds(50))
                }
            } else {
                element = try await Opening.existing(entry, pid: pid, title: request.window)
                created = false
            }
            guard !ending else { return }
            if DockedWindow.bool(element, kAXMinimizedAttribute) {
                AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            }
            let docked = DockedWindow(pid: pid, element: element, created: created)
            known = DockedWindow.windows(of: pid)
            window = docked
            shownTitle = docked.title
            overlay.ready = true
            let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            follow()
        } catch {
            fail(error.text)
        }
    }

    private func watchTermination(of pid: pid_t) {
        termination = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let ended = (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated {
                guard ended == pid else { return }
                self?.end(status: 0)
            }
        }
    }

    /// Takes the window's lock once its window-server number is known. A window that another pane
    /// holds ends this pane.
    private func claim() -> Bool {
        guard lock == nil, let window, let number = window.number else { return true }
        if let lock = WindowLock.take(pid: window.pid, number: number) {
            self.lock = lock
            return true
        }
        self.window = nil
        fail("This window of \(entry?.name ?? request.app) is already in another pane.")
        return false
    }

    // MARK: - Following

    /// Puts the window on the pane while the pane is on screen and out of the way otherwise.
    private func follow() {
        guard let window, !ending else { return draw() }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        switch overlay.anchor.status {
        case .placed(let placement) where !placement.coveredEntirely:
            window.dock(to: placement.frame, primaryHeight: primaryHeight)
            guard claim() else { return }
            if let number = window.number, let size = window.accepted?.size {
                let scale = NSScreen.screens.first { $0.frame.intersects(placement.frame) }?.backingScaleFactor ?? 2
                mirror.show(window: number, size: size, scale: scale)
            }
        default:
            window.park(primaryHeight: primaryHeight)
            mirror.stop()
        }
        draw()
    }

    private func tick() {
        guard let window, !ending else { return }
        guard window.exists else { return replace(window) }
        if window.number == nil, window.findNumber() { return follow() }
        window.keepDocked()
        let title = window.title
        if title != shownTitle {
            shownTitle = title
            draw()
        }
    }

    /// A window that the pane did not open can give way to another of its application, as an Open
    /// dialog does to the document that it opens. The pane takes a standard window that appears
    /// within two seconds after the shown one closed and that no other pane holds; otherwise it
    /// ends. A browser window that the pane opened ends the pane when it closes.
    private func replace(_ closed: DockedWindow) {
        guard !closed.created else { return end(status: 0) }
        let state = replacing ?? (known, Date().addingTimeInterval(2))
        replacing = state
        let fresh = DockedWindow.windows(of: closed.pid).first { candidate in
            !state.since.contains { CFEqual($0, candidate) }
                && DockedWindow.string(candidate, kAXSubroleAttribute) == kAXStandardWindowSubrole
                && !WindowLock.taken(pid: closed.pid, window: candidate)
        }
        if let fresh {
            replacing = nil
            lock = nil
            mirror.stop()
            known = DockedWindow.windows(of: closed.pid)
            window = DockedWindow(pid: closed.pid, element: fresh, created: false)
            shownTitle = window?.title ?? ""
            return follow()
        }
        if Date() >= state.until { end(status: 0) }
    }

    private func giveKeyboard() {
        message = nil
        window?.activate()
    }

    private func input(_ events: [PaneInput.Event]) {
        for event in events {
            switch event {
            case .quit: return end(status: 0)
            case .focus: giveKeyboard()
            case .line, .command: message = "This pane has no commands."
            }
        }
        draw()
    }

    // MARK: - Placeholder

    private func draw() {
        let name = entry?.name ?? request.app
        var identity: [String] = []
        if let window {
            if let number = window.number { identity.append("window \(number)") }
            if let browserWindow { identity.append("browser window ID \(browserWindow)") }
            if !shownTitle.isEmpty { identity.append(shownTitle) }
        }
        var status: String
        if window == nil {
            status = "Opening \(name)…"
        } else {
            switch overlay.anchor.status {
            case .placed(let placement) where !placement.coveredEntirely:
                status = "\(name) is in this pane. Click it to type there."
                if let failure = mirror.failure { status += " The pane cannot show it while the terminal is in front: \(failure)" }
                if let target = self.window?.target, let accepted = self.window?.accepted,
                   accepted.width > target.width + 1 || accepted.height > target.height + 1 {
                    status += " The window keeps a minimum size of \(Int(accepted.width))×\(Int(accepted.height)) points, larger than this pane."
                }
            case .untrusted:
                status = "This terminal cannot place windows: the program has no accessibility access."
            case .searching:
                status = "Looking for this pane on screen."
            case .placed, .concealed:
                status = "\(name) waits outside the screen while this pane is hidden."
            }
        }
        if let message { status = message + " " + status }
        terminal.draw(title: name, identity: identity.joined(separator: " · "), status: status,
                      keys: "q closes this pane and puts the window back. Another key, or a click on the window, gives \(name) the keyboard.",
                      command: nil, marker: overlay.anchor.marker)
    }

    // MARK: - Ending

    private func fail(_ text: String) {
        guard !ending else { return }
        ending = true
        overlay.stop()
        terminal.leave(before: .now() + 0.2)
        terminal.report("App Pane: \(text)", before: .now() + 0.2)
        _exit(1)
    }

    /// Releases the window and ends the process. The process ends within two seconds even when the
    /// application answers Accessibility slowly, and output to the terminal waits at most a fifth
    /// of a second, so neither keeps the process alive.
    func end(status: Int32, terminalGone: Bool = false) {
        guard !ending else { return }
        ending = true
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { _exit(status) }
        timer?.invalidate()
        mirror.stop()
        overlay.stop()
        window?.release()
        if !terminalGone { terminal.leave(before: .now() + 0.2) }
        _exit(status)
    }
}
