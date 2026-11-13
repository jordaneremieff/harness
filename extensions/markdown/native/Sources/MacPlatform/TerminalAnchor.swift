import AppKit
import ApplicationServices

/// Finds the on-screen element that shows this process's terminal and follows its place.
///
/// The process prints a marker on its own terminal screen. The anchor searches the accessibility
/// text areas of running applications for that marker, then reads the element's frame and the
/// state of its window. It names no terminal application: any application that exposes its
/// terminal screen text through accessibility qualifies. Accessibility access is required; a
/// process that a trusted application starts usually inherits that application's access.
///
/// Every accessibility and window-server request runs on one background queue, so an
/// application that answers slowly never stalls the reader's own window. The main actor only
/// receives the results, converts coordinates and publishes the status.
@MainActor
public final class TerminalAnchor {
    public struct Placement: Equatable, Sendable {
        /// The element's frame in AppKit screen coordinates: origin at the bottom left of the
        /// primary screen, y upwards.
        public var frame: CGRect
        /// The process that owns the element.
        public var host: pid_t
        /// The window-server number of the window that contains the element, when known.
        public var window: CGWindowID?
        /// The lowest other window of the host that lies over the element, such as a command
        /// palette or a dialog that the host shows above the window that contains the element.
        public var coveredBy: CGWindowID?
    }

    public enum Status: Equatable, Sendable {
        /// This process has no accessibility access, so it cannot find or follow its terminal.
        case untrusted
        /// No element shows the marker now: the terminal is not on screen, for example in a tab
        /// that its application does not show, or its application is not running.
        case searching
        /// The element is on screen at this place.
        case placed(Placement)
        /// The element exists, but its window is not on screen: minimised, hidden, on another
        /// Space or behind a locked screen.
        case concealed(Placement)
    }

    public let marker: String
    public private(set) var status: Status = .searching
    public var onChange: ((Status) -> Void)?

    private let worker: AnchorWorker
    private let queue = DispatchQueue(label: "local.harness.markdown-reader.terminal-anchor", qos: .userInitiated)
    private var timer: Timer?
    private var interval: TimeInterval = 0
    private var stepRunning = false
    private var fastUntil = Date.distantPast

    public init(marker: String) {
        self.marker = marker
        worker = AnchorWorker(marker: marker)
    }

    /// Starts following. The first status arrives after the first step.
    public func start() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
        schedule(interval: 0.1)
        step()
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Reads the element again soon and follows it closely for a short time, for a change that
    /// the caller saw first, such as a new terminal size.
    public func refresh() {
        fastUntil = Date().addingTimeInterval(1.5)
        step()
    }

    private func schedule(interval: TimeInterval) {
        guard interval != self.interval || timer == nil else { return }
        self.interval = interval
        timer?.invalidate()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.step() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Runs one step on the background queue. A step that is still running, for example
    /// because an application answers slowly, is never queued twice.
    private func step() {
        guard timer != nil, !stepRunning else { return }
        stepRunning = true
        let worker = worker
        queue.async { [weak self] in
            let result = worker.step()
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.finish(result) }
            }
        }
    }

    private func finish(_ result: AnchorWorker.Result) {
        stepRunning = false
        guard timer != nil else { return }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let next: Status
        switch result.state {
        case .untrusted: next = .untrusted
        case .searching: next = .searching
        case .placed(let raw): next = .placed(raw.placement(primaryHeight: primaryHeight))
        case .concealed(let raw): next = .concealed(raw.placement(primaryHeight: primaryHeight))
        case .unchanged: next = status
        }
        if case .placed(let shown) = next, case .placed(let before) = status, shown != before {
            fastUntil = Date().addingTimeInterval(1)
        }
        if next != status {
            status = next
            onChange?(next)
        }
        schedule(interval: result.slow ? 1 : Date() < fastUntil ? 1.0 / 60 : 0.1)
    }

    // MARK: - Pure helpers

    /// Converts an accessibility rectangle (origin at the top left of the primary screen, y
    /// downwards) to AppKit screen coordinates.
    nonisolated static func appKitRect(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    /// Whether a window-server record is a normal-level window of `host` at `frame`, given in
    /// accessibility (top-left) coordinates.
    nonisolated static func matches(_ info: [String: Any], host: pid_t, frame: CGRect) -> Bool {
        guard (info[kCGWindowOwnerPID as String] as? pid_t) == host, (info[kCGWindowLayer as String] as? Int) == 0,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
        else { return false }
        return abs(rect.minX - frame.minX) < 2 && abs(rect.minY - frame.minY) < 2
            && abs(rect.width - frame.width) < 2 && abs(rect.height - frame.height) < 2
    }

    /// The one record that names the window, or nil when none or several do. Several windows of
    /// one application at the same frame are told apart by title.
    nonisolated static func uniqueWindow(_ records: [[String: Any]], host: pid_t, frame: CGRect, title: String?) -> CGWindowID? {
        let candidates = records.filter { matches($0, host: host, frame: frame) }
        let chosen = candidates.count > 1 ? candidates.filter { ($0[kCGWindowName as String] as? String) == title } : candidates
        guard chosen.count == 1 else { return nil }
        return chosen[0][kCGWindowNumber as String] as? CGWindowID
    }
}

/// The accessibility and window-server work of a `TerminalAnchor`. It runs only on the anchor's
/// queue, one step at a time, and keeps its state there.
final class AnchorWorker: @unchecked Sendable {
    struct RawPlacement: Sendable {
        var frame: CGRect
        var host: pid_t
        var window: CGWindowID?
        var coveredBy: CGWindowID?

        func placement(primaryHeight: CGFloat) -> TerminalAnchor.Placement {
            TerminalAnchor.Placement(frame: TerminalAnchor.appKitRect(frame, primaryHeight: primaryHeight), host: host, window: window, coveredBy: coveredBy)
        }
    }

    enum State: Sendable {
        case untrusted, searching, unchanged
        case placed(RawPlacement)
        case concealed(RawPlacement)
    }

    struct Result: Sendable {
        var state: State
        /// Ask for the next step in a second, for a locked screen or missing access.
        var slow = false
    }

    /// Nodes visited in one application's accessibility tree during one search.
    static let nodeBudget = 2500
    /// Deepest level of an application's tree that a search visits.
    static let depthLimit = 24
    /// Time one search may take before it stops; the next search starts again.
    static let searchDeadline: TimeInterval = 0.4
    /// Text areas with more characters are searched through their visible range only.
    static let wholeTextLimit = 200_000
    /// Roles whose subtrees hold documents, lists or menus rather than terminals.
    static let skippedRoles: Set<String> = ["AXWebArea", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXMenuBar", "AXMenu"]

    let marker: String
    private var element: AXUIElement?
    private var windowElement: AXUIElement?
    private var lastHost: pid_t?
    /// The window that last showed the element and its title then. A changed title, such as a
    /// switch to another tab of that window, starts the next search at once.
    private var lostWindow: (element: AXUIElement, title: String?)?
    private var lastFront: String?
    private var searches = 0
    private var nextSearch = Date.distantPast
    private var cachedWindow: CGWindowID?

    init(marker: String) {
        self.marker = marker
    }

    func step() -> Result {
        guard AXIsProcessTrusted() else { return Result(state: .untrusted, slow: true) }
        // Nothing is visible behind a locked screen, and applications answer few accessibility
        // requests there; keep the last place and wait.
        if Self.screenLocked() {
            guard let element, let host = Self.pid(element), let frame = Self.rect(element, "AXFrame") else { return Result(state: .unchanged, slow: true) }
            return Result(state: .concealed(RawPlacement(frame: frame, host: host, window: cachedWindow)), slow: true)
        }
        if let element {
            if let state = read(element) { return Result(state: state) }
            if let windowElement { lostWindow = (windowElement, Self.string(windowElement, kAXTitleAttribute)) }
            self.element = nil
            windowElement = nil
            cachedWindow = nil
            nextSearch = .distantPast
        }
        return Result(state: searchIfDue())
    }

    // MARK: - Following

    /// The element's place and its window's state, or nil when the element is gone.
    private func read(_ element: AXUIElement) -> State? {
        guard let frame = Self.rect(element, "AXFrame"), frame.width >= 1, frame.height >= 1, let host = Self.pid(element) else { return nil }
        let window = windowElement ?? Self.element(element, kAXWindowAttribute)
        windowElement = window
        let windowFrame = window.flatMap { Self.rect($0, "AXFrame") }
        let minimised = window.flatMap { Self.bool($0, kAXMinimizedAttribute) } ?? false
        let number = windowFrame.flatMap { verifiedWindow(host: host, frame: $0, title: window.flatMap { Self.string($0, kAXTitleAttribute) }) }
        let coveredBy = number.flatMap { Self.hostWindowAbove(host: host, window: $0, over: frame) }
        let placement = RawPlacement(frame: frame, host: host, window: number, coveredBy: coveredBy)
        let hidden = NSRunningApplication(processIdentifier: host)?.isHidden ?? false
        if minimised || hidden || number == nil { return .concealed(placement) }
        return .placed(placement)
    }

    /// The cached window number while that window is on screen at `frame`; otherwise a new
    /// lookup that must find exactly one window.
    private func verifiedWindow(host: pid_t, frame: CGRect, title: String?) -> CGWindowID? {
        if let cachedWindow,
           let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], cachedWindow) as? [[String: Any]])?.first,
           (info[kCGWindowIsOnscreen as String] as? Bool) == true,
           TerminalAnchor.matches(info, host: host, frame: frame) {
            return cachedWindow
        }
        let records = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        cachedWindow = TerminalAnchor.uniqueWindow(records, host: host, frame: frame, title: title)
        return cachedWindow
    }

    /// The lowest window of `host` below the floating level that lies above `window` and over
    /// `frame`, given in accessibility (top-left) coordinates.
    static func hostWindowAbove(host: pid_t, window: CGWindowID, over frame: CGRect) -> CGWindowID? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], window) as? [[String: Any]] else { return nil }
        var lowest: CGWindowID?
        for info in list where (info[kCGWindowOwnerPID as String] as? pid_t) == host {
            guard let layer = info[kCGWindowLayer as String] as? Int, layer < Int(CGWindowLevelForKey(.floatingWindow)),
                  let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.intersects(frame),
                  let number = info[kCGWindowNumber as String] as? CGWindowID
            else { continue }
            lowest = number
        }
        return lowest
    }

    // MARK: - Search

    /// Searches when a search is due. A changed title of the window that last showed the pane,
    /// or of the frontmost window, makes it due at once.
    private func searchIfDue() -> State {
        let now = Date()
        if let lostWindow, Self.string(lostWindow.element, kAXTitleAttribute) != lostWindow.title {
            self.lostWindow = nil
            nextSearch = now
        }
        let front = Self.frontWindowTitle()
        if front != lastFront {
            lastFront = front
            nextSearch = now
        }
        guard now >= nextSearch else { return .searching }
        if let found = search(deadline: now.addingTimeInterval(Self.searchDeadline)) {
            element = found.element
            windowElement = found.window
            lastHost = found.host
            lostWindow = nil
            searches = 0
            return read(found.element) ?? .searching
        }
        searches += 1
        nextSearch = now.addingTimeInterval(searches < 8 ? 0.25 : hostRunning ? 1 : 3)
        return .searching
    }

    private var hostRunning: Bool {
        guard let lastHost, let application = NSRunningApplication(processIdentifier: lastHost) else { return false }
        return !application.isTerminated
    }

    private struct Found {
        let element: AXUIElement
        let window: AXUIElement?
        let host: pid_t
    }

    /// Looks in the application that showed the marker last while it runs. Otherwise in the
    /// frontmost application, then in every application with a window on screen.
    private func search(deadline: Date) -> Found? {
        if hostRunning, let lastHost { return search(application: lastHost, deadline: deadline) }
        let own = ProcessInfo.processInfo.processIdentifier
        var candidates: [pid_t] = []
        if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, front != own { candidates.append(front) }
        for pid in Self.processesWithWindows() where pid != own && !candidates.contains(pid) { candidates.append(pid) }
        for pid in candidates where Date() < deadline {
            if let found = search(application: pid, deadline: deadline) { return found }
        }
        return nil
    }

    private func search(application pid: pid_t, deadline: Date) -> Found? {
        let application = AXUIElementCreateApplication(pid)
        guard let windows = Self.elements(application, kAXWindowsAttribute) else { return nil }
        var visited = 0
        for window in windows {
            var queue: [(AXUIElement, Int)] = [(window, 0)]
            var index = 0
            while index < queue.count, visited < Self.nodeBudget, Date() < deadline {
                let (node, depth) = queue[index]
                index += 1
                visited += 1
                let role = Self.string(node, kAXRoleAttribute) ?? ""
                if role == kAXTextAreaRole {
                    if let text = Self.visibleText(node), text.contains(marker) { return Found(element: node, window: window, host: pid) }
                    continue
                }
                if Self.skippedRoles.contains(role) || depth >= Self.depthLimit { continue }
                for child in Self.elements(node, kAXChildrenAttribute) ?? [] where queue.count < Self.nodeBudget { queue.append((child, depth + 1)) }
            }
        }
        return nil
    }

    // MARK: - Window server facts

    static func screenLocked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (session["CGSSessionScreenIsLocked"] as? Bool) == true || (session[kCGSessionOnConsoleKey as String] as? Bool) == false
    }

    /// The frontmost application and the title of its focused window.
    static func frontWindowTitle() -> String? {
        guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        let window = element(AXUIElementCreateApplication(front), kAXFocusedWindowAttribute)
        return "\(front):" + (window.flatMap { string($0, kAXTitleAttribute) } ?? "")
    }

    /// Processes that own a normal-level window on screen, front to back.
    static func processesWithWindows() -> [pid_t] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var result: [pid_t] = []
        for info in list where (info[kCGWindowLayer as String] as? Int) == 0 {
            if let pid = info[kCGWindowOwnerPID as String] as? pid_t, !result.contains(pid) { result.append(pid) }
        }
        return result
    }

    // MARK: - Accessibility values

    static func visibleText(_ element: AXUIElement) -> String? {
        if let count = number(element, kAXNumberOfCharactersAttribute), count <= wholeTextLimit {
            return string(element, kAXValueAttribute)
        }
        guard let rangeValue = value(element, kAXVisibleCharacterRangeAttribute) else { return nil }
        var parameter: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, rangeValue, &parameter) == .success else { return nil }
        return parameter as? String
    }

    static func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
        return result
    }

    static func string(_ element: AXUIElement, _ name: String) -> String? {
        value(element, name) as? String
    }

    static func number(_ element: AXUIElement, _ name: String) -> Int? {
        (value(element, name) as? NSNumber)?.intValue
    }

    static func bool(_ element: AXUIElement, _ name: String) -> Bool? {
        (value(element, name) as? NSNumber)?.boolValue
    }

    static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let result = value(element, name), CFGetTypeID(result) == AXUIElementGetTypeID() else { return nil }
        return (result as! AXUIElement)
    }

    static func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement]? {
        value(element, name) as? [AXUIElement]
    }

    static func rect(_ element: AXUIElement, _ name: String) -> CGRect? {
        guard let result = value(element, name), CFGetTypeID(result) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(result as! AXValue, .cgRect, &rect) else { return nil }
        return rect
    }

    static func pid(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }
}
