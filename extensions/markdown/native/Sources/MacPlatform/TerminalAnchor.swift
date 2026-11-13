import AppKit
import ApplicationServices

/// Finds the on-screen element that shows this process's terminal and follows its place.
///
/// The process prints a marker in the first row of its own terminal screen. The anchor searches
/// the accessibility text areas of running applications for that marker, reading at most a short
/// start of each text area's visible text. A found element must then show a new marker that the
/// process prints, so that a copy of the screen elsewhere, such as captured output in another
/// pane, never qualifies. While it follows the element, the anchor reads the element's frame, the
/// state of its window and the content of the same window that covers it, and checks that the
/// element still shows the marker. When the pane's environment offers a stacking command
/// (`docs/conventions/pane-stacking.md`), its reports decide which content lies above the pane;
/// otherwise the application's accessibility hit test decides.
///
/// The anchor names no terminal application: any application that exposes its terminal screen as
/// an accessibility text area with a visible character range qualifies. Accessibility access is
/// required; a process that a trusted application starts usually inherits that application's
/// access.
///
/// Every accessibility and window-server request runs on one background queue, one step at a
/// time, so an application that answers slowly never stalls the reader's own window. The main
/// actor only receives the results, converts coordinates and publishes the status.
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
        /// Parts of the frame that other content of the same window lies over, such as a floating
        /// pane above a tiled one, in AppKit screen coordinates.
        public var covers: [CGRect]

        /// Whether the covers leave nothing of the frame visible.
        public var coveredEntirely: Bool {
            covers.contains { $0.insetBy(dx: -1, dy: -1).contains(frame) }
        }
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

    /// The text that the terminal must show in its first row. It changes when a search finds an
    /// element; `onMarker` then asks the terminal to show the new text.
    public private(set) var marker = TerminalAnchor.newMarker()
    public private(set) var status: Status = .searching
    public var onChange: ((Status) -> Void)?
    public var onMarker: (() -> Void)?

    private let worker: AnchorWorker
    private let feed: StackingFeed?
    private let queue = DispatchQueue(label: "local.harness.markdown-reader.terminal-anchor", qos: .userInitiated)
    private var timer: Timer?
    private var interval: TimeInterval = 0
    private var stepRunning = false
    private var fastUntil = Date.distantPast

    /// Starts the stacking command that the pane's environment offers, if any.
    public init() {
        feed = StackingFeed.start()
        worker = AnchorWorker(feed: feed)
        feed?.onReport = { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.refresh() } }
        }
    }

    static func newMarker() -> String {
        "reader-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    }

    /// Starts following. The first status arrives after the first step.
    public func start() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Float(AnchorWorker.messagingTimeout))
        schedule(interval: 0.1)
        step()
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
        feed?.stop()
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
        let marker = marker
        queue.async { [weak self] in
            let result = worker.step(marker: marker)
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
        case .found:
            // A window over a place that the anchor no longer follows hides until the found
            // element is confirmed.
            switch status {
            case .placed, .concealed: next = .searching
            case .searching, .untrusted: next = status
            }
            marker = Self.newMarker()
            fastUntil = Date().addingTimeInterval(1)
            onMarker?()
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

    /// The visible part of a window with holes: its bounds minus the union of the holes, which can
    /// overlap. Nil without holes.
    public nonisolated static func maskPath(bounds: CGRect, holes: [CGRect]) -> CGPath? {
        guard let first = holes.first else { return nil }
        let covered = holes.dropFirst().reduce(CGPath(rect: first, transform: nil)) { $0.union(CGPath(rect: $1, transform: nil)) }
        return CGPath(rect: bounds, transform: nil).subtracting(covered)
    }

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
        var covers: [CGRect] = []

        func placement(primaryHeight: CGFloat) -> TerminalAnchor.Placement {
            TerminalAnchor.Placement(
                frame: TerminalAnchor.appKitRect(frame, primaryHeight: primaryHeight),
                host: host,
                window: window,
                coveredBy: coveredBy,
                covers: covers.map { TerminalAnchor.appKitRect($0, primaryHeight: primaryHeight) }
            )
        }
    }

    enum State: Sendable {
        case untrusted, searching, unchanged
        /// A text area shows the marker; the terminal must show a new marker to confirm it.
        case found
        case placed(RawPlacement)
        case concealed(RawPlacement)
    }

    struct Result: Sendable {
        var state: State
        /// Ask for the next step in a second, for a locked screen or missing access.
        var slow = false
    }

    /// Longest wait for one answer of an application.
    static let messagingTimeout: TimeInterval = 0.25
    /// Time after which a step starts no new request. One request that is already waiting can
    /// still take up to the messaging timeout.
    static let stepAllowance: TimeInterval = 0.1
    /// Time a found element has to show the new marker.
    static let confirmTime: TimeInterval = 0.6
    /// Consecutive reads without the marker after which the followed element counts as gone,
    /// for example because the application now uses it for another terminal.
    static let missLimit = 3
    /// Time between two scans for covering content while the element's frame stays the same.
    static let coverInterval: TimeInterval = 0.25
    /// Time after which a scan for covering content starts no new request; an unfinished scan
    /// keeps the last covers.
    static let scanAllowance: TimeInterval = 0.3
    /// While the application that last showed the marker runs, only every this many rounds
    /// search the other applications as well.
    static let wideRoundEvery = 8

    private let tree = LiveTree()
    private var search = AnchorSearch<LiveTree>()
    private var element: AXUIElement?
    private var windowElement: AXUIElement?
    /// The application whose element showed a confirmed marker last.
    private var host: pid_t?
    private var candidate: (found: AnchorSearch<LiveTree>.Found, marker: String, until: Date)?
    private var misses = 0
    /// The window that last showed the element and its title then. A changed title, such as a
    /// switch to another tab of that window, starts the next round at once.
    private var lostWindow: (element: AXUIElement, title: String?)?
    private var lastFront: String?
    private var rounds = 0
    private var nextRound = Date.distantPast
    private var cachedWindow: CGWindowID?
    private var covers: [CGRect] = []
    private var detached = false
    private var coversFrame: CGRect?
    private var coversGeneration: Int?
    private var coversAt = Date.distantPast
    private let feed: StackingFeed?

    init(feed: StackingFeed?) {
        self.feed = feed
    }

    func step(marker: String) -> Result {
        let deadline = Date().addingTimeInterval(Self.stepAllowance)
        guard AXIsProcessTrusted() else { return Result(state: .untrusted, slow: true) }
        // Nothing is visible behind a locked screen, and applications answer few accessibility
        // requests there; keep the last place and wait.
        if Self.screenLocked() {
            guard let element, let host = Self.pid(element), let frame = tree.frame(element).value else { return Result(state: .unchanged, slow: true) }
            return Result(state: .concealed(RawPlacement(frame: frame, host: host, window: cachedWindow, covers: covers)), slow: true)
        }
        if let candidate { return Result(state: confirm(candidate, marker: marker)) }
        if let element {
            if let state = follow(element, marker: marker) { return Result(state: state) }
            lose()
        }
        return Result(state: searchStep(marker: marker, deadline: deadline))
    }

    // MARK: - Following

    /// The element's place and its window's state, or nil when the element is gone. A request
    /// that the application did not answer in time keeps the last state.
    private func follow(_ element: AXUIElement, marker: String) -> State? {
        let frame: CGRect
        switch tree.frame(element) {
        case .value(let value): frame = value
        case .busy: return .unchanged
        case .missing: return nil
        }
        guard frame.width >= 1, frame.height >= 1, let host = Self.pid(element) else { return nil }
        switch tree.visibleText(element, limit: AnchorSearch<LiveTree>.textLimit) {
        case .value(let text) where AnchorSearch<LiveTree>.shows(marker, text): misses = 0
        case .busy: break
        default:
            misses += 1
            if misses >= Self.missLimit { return nil }
        }
        let window = windowElement ?? tree.read(element, kAXWindowAttribute).value.flatMap(LiveTree.element)
        windowElement = window
        let windowFrame = window.flatMap { tree.frame($0).value }
        let minimised = window.flatMap { (tree.read($0, kAXMinimizedAttribute).value as? NSNumber)?.boolValue } ?? false
        let number = windowFrame.flatMap { verifiedWindow(host: host, frame: $0, title: window.flatMap(title)) }
        let coveredBy = number.flatMap { Self.hostWindowAbove(host: host, window: $0, over: frame) }
        let stacking = feed?.latest
        if let window, frame != coversFrame || stacking?.generation != coversGeneration || Date() >= coversAt.addingTimeInterval(Self.coverInterval) {
            // A scan that runs out of time or requests keeps the last covers and runs again on
            // the next step.
            let scanDeadline = Date().addingTimeInterval(Self.scanAllowance)
            let result = CoverScan.scan(tree, element: element, frame: frame, window: window, application: host, stacking: stacking?.report, expired: { Date() >= scanDeadline })
            switch result {
            case .covers(let found):
                covers = found
                detached = false
            case .detached: detached = true
            case nil: break
            }
            if result != nil {
                coversFrame = frame
                coversGeneration = stacking?.generation
                coversAt = Date()
            }
        }
        let placement = RawPlacement(frame: frame, host: host, window: number, coveredBy: coveredBy, covers: covers)
        let hidden = NSRunningApplication(processIdentifier: host)?.isHidden ?? false
        if minimised || hidden || detached || number == nil { return .concealed(placement) }
        return .placed(placement)
    }

    private func lose() {
        if let windowElement { lostWindow = (windowElement, title(windowElement)) }
        element = nil
        windowElement = nil
        cachedWindow = nil
        covers = []
        detached = false
        coversFrame = nil
        coversGeneration = nil
        misses = 0
        rounds = 0
        nextRound = .distantPast
        search = AnchorSearch()
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

    /// Accepts the found element when it shows the marker that the terminal printed after the
    /// search found it. An element that keeps the older marker is a copy of the terminal's text,
    /// such as captured output in another pane; the round then continues behind it, with the new
    /// marker that no earlier copy shows.
    private func confirm(_ candidate: (found: AnchorSearch<LiveTree>.Found, marker: String, until: Date), marker: String) -> State {
        let reply = tree.visibleText(candidate.found.element, limit: AnchorSearch<LiveTree>.textLimit)
        if marker != candidate.marker, case .value(let text) = reply, AnchorSearch<LiveTree>.shows(marker, text) {
            self.candidate = nil
            element = candidate.found.element
            windowElement = candidate.found.window
            host = candidate.found.application
            lostWindow = nil
            misses = 0
            rounds = 0
            return follow(candidate.found.element, marker: marker) ?? .searching
        }
        let gone: Bool
        if case .missing = reply { gone = true } else { gone = false }
        if !gone, Date() < candidate.until { return .unchanged }
        self.candidate = nil
        return .searching
    }

    /// Continues the current round, or starts a new one when it is due. A changed title of the
    /// window that last showed the element, or a change of the frontmost window, makes a round
    /// due at once.
    private func searchStep(marker: String, deadline: Date) -> State {
        let now = Date()
        if let lostWindow {
            let reply = tree.read(lostWindow.element, kAXTitleAttribute)
            if case .busy = reply {} else if (reply.value as? String) != lostWindow.title {
                self.lostWindow = nil
                nextRound = now
                if let host { search.prefer(host) }
            }
        }
        if let front = Self.frontmostApplication(), let frontTitle = frontWindowTitle(front), frontTitle != lastFront {
            lastFront = frontTitle
            nextRound = now
            search.prefer(front)
        }
        if search.roundComplete {
            guard now >= nextRound else { return .searching }
            rounds += 1
            search.begin(roundApplications())
        }
        if let found = search.run(tree, marker: marker, expired: { Date() >= deadline }) {
            candidate = (found, marker, Date().addingTimeInterval(Self.confirmTime))
            return .found
        }
        if search.roundComplete {
            nextRound = now.addingTimeInterval(rounds < 8 ? 0.25 : hostRunning ? 1 : 3)
        }
        return .searching
    }

    /// The applications of a new round: the one that showed the marker last, while it runs, and
    /// on every few rounds, or without such an application, also the frontmost application and
    /// every application with a window on screen, front to back.
    private func roundApplications() -> [pid_t] {
        let own = ProcessInfo.processInfo.processIdentifier
        var list: [pid_t] = []
        if let host, hostRunning {
            list.append(host)
            if rounds % Self.wideRoundEvery != 0 { return list }
        }
        if let front = Self.frontmostApplication(), front != own, !list.contains(front) { list.append(front) }
        for pid in Self.processesWithWindows() where pid != own && !list.contains(pid) { list.append(pid) }
        return list
    }

    private var hostRunning: Bool {
        guard let host, let application = NSRunningApplication(processIdentifier: host) else { return false }
        return !application.isTerminated
    }

    private func title(_ window: AXUIElement) -> String? {
        tree.read(window, kAXTitleAttribute).value as? String
    }

    /// The frontmost application and the title of its focused window; nil when the application
    /// does not answer in time.
    private func frontWindowTitle(_ front: pid_t) -> String? {
        switch tree.read(AXUIElementCreateApplication(front), kAXFocusedWindowAttribute) {
        case .busy: return nil
        case .missing: return "\(front):"
        case .value(let value):
            guard let window = LiveTree.element(value) else { return "\(front):" }
            switch tree.read(window, kAXTitleAttribute) {
            case .busy: return nil
            case .missing: return "\(front):"
            case .value(let title): return "\(front):" + ((title as? String) ?? "")
            }
        }
    }

    // MARK: - Window server facts

    static func screenLocked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (session["CGSSessionScreenIsLocked"] as? Bool) == true || (session[kCGSessionOnConsoleKey as String] as? Bool) == false
    }

    static func frontmostApplication() -> pid_t? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
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

    static func pid(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }
}

