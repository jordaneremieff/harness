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
    private var ownedBrowser: (application: NSRunningApplication, scripting: BrowserScripting, id: String)?
    private var browserOriginalBounds: BrowserEvents.WindowBounds?
    private var browserWindow: String? { ownedBrowser?.id }
    private var creatingBrowser = false
    private var browserInput = BrowserPaneInput()
    private var tabPending = false
    private var shownTitle = ""
    private var message: String?
    private var timer: Timer?
    private var termination: NSObjectProtocol?
    private var exitStatus: Int32?
    private var ending: Bool { exitStatus != nil }
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
        mirror.onState = { [weak self] in self?.mirrorChanged() }
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
        if scripting != nil, request.window == nil { terminal.onBytes = { [weak self] in self?.browserKeys($0) } }
        if request.url != nil, scripting == nil { return fail("\(entry.name) is not a browser that a pane can open at an address.") }
        do {
            let application = try await Opening.running(entry)
            guard !ending else { return }
            let pid = application.processIdentifier
            watchTermination(of: pid)
            let element: AXUIElement
            let created: Bool
            if let scripting, request.window == nil {
                let previousIDs = try await BrowserEvents.run { try BrowserEvents.windowIDs(pid: pid) }
                guard !ending else { return }
                guard let before = DockedWindow.windowList(of: pid) else {
                    throw Opening.Failure(text: "Accessibility did not report the windows of \(entry.name). Check the terminal’s Accessibility access.")
                }
                let id = try await createBrowserWindow(application, scripting: scripting, before: previousIDs)
                guard !ending else { return }
                let bounds = try await BrowserEvents.run { try BrowserEvents.originalBounds(pid: pid, id: id, scripting: scripting) }
                browserOriginalBounds = bounds
                guard !ending else { return }
                element = try await Opening.newAccessibilityWindow(entry, pid: pid, before: before, frame: bounds.frame)
                let currentIDs = try await BrowserEvents.run { try BrowserEvents.windowIDs(pid: pid) }
                guard currentIDs.subtracting(previousIDs) == [id] else {
                    throw Opening.Failure(text: "The browser’s windows changed before this pane could identify its window.")
                }
                guard !ending else { return }
                let address = request.url ?? (scripting == .safari ? URL(string: "about:blank") : nil)
                if let address {
                    try await BrowserEvents.run { try BrowserEvents.navigate(pid: pid, scripting: scripting, id: id, url: address) }
                }
                guard !ending else { return }
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
            let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            follow()
        } catch {
            fail((error as? Opening.Failure)?.text ?? "\(entry.name) did not open a window by Apple Events: \(error.localizedDescription)")
        }
    }

    private func createBrowserWindow(_ application: NSRunningApplication, scripting: BrowserScripting, before: Set<String>) async throws -> String {
        let pid = application.processIdentifier
        let previous = NSWorkspace.shared.frontmostApplication
        creatingBrowser = true
        defer {
            Opening.restoreFrontmost(previous, browser: pid)
            creatingBrowser = false
            if let exitStatus { finish(status: exitStatus) }
        }
        let id = try await BrowserEvents.run {
            guard !application.isTerminated else { throw Opening.Failure(text: "The browser quit before it opened a window.") }
            return try BrowserEvents.createWindow(pid: pid, scripting: scripting, before: before)
        }
        ownedBrowser = (application, scripting, id)
        return id
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
            mirrorChanged()
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
            mirrorChanged()
            known = DockedWindow.windows(of: closed.pid)
            window = DockedWindow(pid: closed.pid, element: fresh, created: false)
            shownTitle = window?.title ?? ""
            return follow()
        }
        if Date() >= state.until { end(status: 0) }
    }

    /// The panel over the pane holds only the window's image, so it shows only while an image is live. Without one,
    /// the pane's own text stays visible and says why, instead of an empty panel.
    private func mirrorChanged() {
        let live = mirror.live && window != nil
        if overlay.ready != live { overlay.ready = live }
        if !live, overlay.window.isVisible { overlay.window.orderOut(nil) }
        draw()
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

    /// Terminal input goes to this pane even while its window is parked. A tab request does
    /// not activate the app or use the window that currently has the keyboard.
    private func browserKeys(_ bytes: ArraySlice<UInt8>) {
        for action in browserInput.feed(bytes) {
            switch action {
            case .quit: return end(status: 0)
            case .focus: giveKeyboard()
            case .invalid: message = "Use :tab or :tab followed by an http or https URL."
            case .newTab(let url): openTab(url)
            }
        }
        draw()
    }

    private func openTab(_ url: URL?) {
        guard !ending, window != nil, let (application, scripting, id) = ownedBrowser, !application.isTerminated else {
            message = "This pane has no browser window ready for a new tab."
            return
        }
        guard !tabPending else {
            message = "A tab request is still in progress. No second request was sent."
            return
        }
        tabPending = true
        message = "Opening a tab in browser window \(id)…"
        let pid = application.processIdentifier
        let previous = NSWorkspace.shared.frontmostApplication
        Task {
            do {
                let tab = try await BrowserEvents.run { try BrowserEvents.newTab(pid: pid, windowID: id, scripting: scripting, url: url) }
                message = "Opened \(tab.map { "tab \($0)" } ?? "a tab") in browser window \(id)."
            } catch {
                message = "Could not confirm a new tab in browser window \(id): \(error.localizedDescription) Check that window before retrying."
            }
            Opening.restoreFrontmost(previous, browser: pid)
            guard !ending else { return }
            tabPending = false
            draw()
        }
    }

    // MARK: - Placeholder

    private func draw() {
        let name = entry?.name ?? request.app
        var identity: [String] = []
        if let window {
            if let browserWindow { identity.append("browser window ID \(browserWindow) · PID \(window.pid)") }
            if let number = window.number { identity.append("window \(number)") }
            if !shownTitle.isEmpty { identity.append(shownTitle) }
        }
        var status: String
        if window == nil {
            status = "Opening \(name)…"
        } else {
            switch overlay.anchor.status {
            case .placed(let placement) where !placement.coveredEntirely:
                if mirror.live {
                    status = "\(name) is in this pane. Click it to type there."
                } else {
                    status = "\(name) shows here while it is the active app. Press any key here to bring it back."
                    if let failure = mirror.failure { status += " \(failure)" }
                }
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
                      keys: browserWindow != nil ? ":tab [URL] opens a tab here. q closes this pane and its browser window." : "q closes this pane and puts the window back. Another key, or a click on the window, gives \(name) the keyboard.",
                      command: browserInput.line, marker: overlay.anchor.marker)
    }

    // MARK: - Ending

    private func fail(_ text: String) {
        stop(status: 1, terminalGone: false, message: "App Pane: \(text)")
    }

    func end(status: Int32, terminalGone: Bool = false) {
        stop(status: status, terminalGone: terminalGone, message: nil)
    }

    private func stop(status: Int32, terminalGone: Bool, message: String?) {
        guard !ending else { return }
        exitStatus = status
        timer?.invalidate()
        mirror.stop()
        overlay.stop()
        if !terminalGone { terminal.leave(before: .now() + 0.2) }
        if let message { terminal.report(message, before: .now() + 0.2) }
        // Once the create event is sent, its reply must either supply the owned ID or fail
        // before we exit. Neither Accessibility nor the order of windows assigns ownership.
        if !creatingBrowser { finish(status: status) }
    }

    private func finish(status: Int32) {
        if let ownedBrowser {
            let application = ownedBrowser.application
            let pid = application.processIdentifier
            let id = ownedBrowser.id
            let scripting = ownedBrowser.scripting
            let parkedBounds = window?.parked == true ? browserOriginalBounds : nil
            Task {
                do {
                    try await BrowserEvents.run {
                        guard !application.isTerminated,
                              let window = BrowserEvents.window(id: id, scripting: scripting) else { return }
                        // An unload prompt can hold the close event. Put the exact owned window
                        // back on screen first, so a refused close never hides that prompt.
                        if let parkedBounds {
                            do { try BrowserEvents.restoreBounds(pid: pid, window: window, bounds: parkedBounds) }
                            catch let error as NSError where error.code == procNotFound { return }
                            catch { paneLog.error("Could not restore owned browser window \(id, privacy: .public): \(error.localizedDescription, privacy: .public)") }
                        }
                        _ = try BrowserEvents.send(pid: pid, event: kAEClose, parameters: [keyDirectObject: window], timeout: 2)
                    }
                } catch let error as NSError {
                    if error.code != errAENoSuchObject && error.code != procNotFound {
                        paneLog.error("Could not close owned browser window \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    }
                }
                _exit(status)
            }
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { _exit(status) }
        window?.restore()
        _exit(status)
    }
}
