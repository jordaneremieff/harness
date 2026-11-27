import AppKit
import AppPaneCore
import NativePane

/// Applies `LinkPolicy` to the browser window that one pane shows, so that a link from another
/// application opens in the browser pane of the tab where the operator works, and otherwise in a
/// browser window on screen rather than in a window that waits for a hidden tab.
///
/// The pane decides when it comes on screen or leaves it, when another application becomes
/// active, after a tab request, and every two seconds for an order that changed without such an
/// event. It reads the browser's order and moves a window up that order by Apple Events, which
/// neither activates the browser nor moves the window past other applications' windows. The
/// work runs on a background queue, one decision at a time, so a browser that answers slowly
/// never holds up the pane.
@MainActor
final class LinkTarget {
    /// Counts changes of the pane's state, so a decision that started before a change never
    /// moves a window after it.
    private final class Generation: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0

        func advance() { lock.withLock { value += 1 } }
        var current: Int { lock.withLock { value } }
    }

    private let pid: pid_t
    private let scripting: BrowserScripting
    /// The scripting ID of the window that the pane opened.
    private let ownID: String
    private let queue = DispatchQueue(label: "local.harness.app-pane.link-target", qos: .userInitiated)
    private var activation: NSObjectProtocol?
    private var timer: Timer?
    /// The pane's place while it is on screen.
    private var placement: TerminalAnchor.Placement?
    /// The terminal application that showed the pane last.
    private var terminal: pid_t?
    private let generation = Generation()
    private var reported = false
    private var deciding = false
    private var again = false

    init(pid: pid_t, scripting: BrowserScripting, ownID: String) {
        self.pid = pid
        self.scripting = scripting
        self.ownID = ownID
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let activated = (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated {
                guard let self else { return }
                // A decision that started before the operator turned to the browser moves nothing.
                guard activated != self.pid else { return self.generation.advance() }
                self.apply()
            }
        }
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.apply() }
        }
        timer.tolerance = 0.5
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        generation.advance()
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        timer?.invalidate()
        timer = nil
    }

    /// The pane is on screen at `placement`.
    func shown(_ placement: TerminalAnchor.Placement) {
        let changed = !reported || self.placement?.window != placement.window
        reported = true
        self.placement = placement
        terminal = placement.host
        guard changed else { return }
        generation.advance()
        apply()
    }

    /// The pane is not on screen.
    func hidden() {
        let changed = !reported || placement != nil
        reported = true
        placement = nil
        guard changed else { return }
        generation.advance()
        apply()
    }

    /// Decides again, for example after a new tab reordered the browser's windows.
    func apply() {
        guard timer != nil else { return }
        if deciding {
            again = true
            return
        }
        deciding = true
        let pid = pid, scripting = scripting, ownID = ownID, terminal = terminal
        let generation = generation, started = generation.current
        let terminalWindow = placement?.window
        let pointer = Self.pointer(), screens = Self.screens()
        let browserActive = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        queue.async { [weak self] in
            Self.decide(pid: pid, scripting: scripting, ownID: ownID, terminal: terminal,
                        terminalWindow: terminalWindow, pointer: pointer, screens: screens, browserActive: browserActive,
                        current: { generation.current == started })
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.deciding = false
                    if self.again {
                        self.again = false
                        self.apply()
                    }
                }
            }
        }
    }

    private nonisolated static func decide(pid: pid_t, scripting: BrowserScripting, ownID: String, terminal: pid_t?,
                                           terminalWindow: CGWindowID?, pointer: CGPoint, screens: [CGRect],
                                           browserActive: Bool, current: () -> Bool) {
        // While the browser is active the operator chooses its windows, so it needs no questions.
        guard !browserActive, let order = try? BrowserEvents.windowOrder(pid: pid), !order.isEmpty else { return }
        let records = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let server = records.compactMap(ServerWindow.init)
        let browserServer = server.filter { $0.owner == pid && $0.layer == 0 }
        let windows = order.map { entry in
            let matches = browserServer.filter { Geometry.close($0.bounds, entry.frame) }
            return BrowserWindow(id: entry.id, bounds: entry.frame, drawn: !matches.isEmpty,
                                 inPane: matches.contains { WindowLock.held(pid: pid, number: $0.number) })
        }
        let working = terminal.flatMap { terminal in LinkPolicy.workingWindow(pointer: pointer, terminal: server.filter { $0.owner == terminal }) }
        let situation = LinkPolicy.Situation(
            own: ownID, terminalWindow: terminalWindow, workingWindow: working, browserActive: browserActive, windows: windows,
            terminalBounds: server.first { $0.number == terminalWindow }?.bounds, screens: screens)
        let action = LinkPolicy.decide(situation)
        if case .raise(let id) = action, current() {
            paneLog.debug("Links: window \(id, privacy: .public) goes first; order was \(windows.map(\.id).joined(separator: ","), privacy: .public)")
            do { try BrowserEvents.raise(pid: pid, scripting: scripting, id: id) }
            catch { paneLog.error("Could not move browser window \(id, privacy: .public) up for links: \(error.localizedDescription, privacy: .public)") }
        }
    }

    /// The pointer in window-server coordinates.
    private static func pointer() -> CGPoint {
        let location = NSEvent.mouseLocation
        return CGPoint(x: location.x, y: (NSScreen.screens.first?.frame.height ?? 0) - location.y)
    }

    /// The screens in window-server coordinates.
    private static func screens() -> [CGRect] {
        let frames = NSScreen.screens.map(\.frame)
        let primaryHeight = frames.first?.height ?? 0
        return frames.map { Geometry.accessibilityRect($0, primaryHeight: primaryHeight) }
    }
}
