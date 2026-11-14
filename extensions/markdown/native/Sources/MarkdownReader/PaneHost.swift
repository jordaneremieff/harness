import AppKit
import Darwin
import MacPlatform
import OSLog
import MarkdownCore
import ReaderFeature
import SwiftUI

let paneLog = Logger(subsystem: "local.harness.markdown-reader", category: "pane")

/// Pane mode: the reader runs as the program of a terminal pane and shows its window exactly over
/// that pane. The terminal keeps a short placeholder with a marker that lets the process find
/// its own pane on screen; the document itself is shown and read only in the reader window.
///
/// The process belongs to its pane. Closing the pane ends the reader; closing the reader ends the
/// program with status zero, so a pane that closes on success closes with it. The document, its
/// revisions and the reading position live outside the process and survive it.
@MainActor
final class PaneHost: NSObject, NSWindowDelegate {
    let model: ReaderModel
    let state: ReadingStateStore
    private let terminal: PaneTerminal
    private let anchor = TerminalAnchor()
    private var window: PaneWindow!
    private var content: PaneContentView!
    private var hosting: NSHostingController<ReaderView>?
    private var placement: TerminalAnchor.Placement?
    private var ending = false
    private var observers: [NSObjectProtocol] = []

    init(model: ReaderModel, state: ReadingStateStore, terminal: PaneTerminal) {
        self.model = model
        self.state = state
        self.terminal = terminal
    }

    func start() -> NSWindow {
        model.followsLatest = true
        window = makeWindow()
        terminal.enter()
        terminal.onKey = { [weak self] key in self?.key(key) }
        terminal.onResize = { [weak self] in
            self?.draw()
            self?.anchor.refresh()
        }
        terminal.onHangUp = { [weak self] in self?.end(status: 0, terminalGone: true) }
        terminal.onTerminate = { [weak self] in self?.end(status: 0) }
        terminal.start()
        draw()
        anchor.onChange = { [weak self] status in self?.apply(status) }
        anchor.onMarker = { [weak self] in self?.draw() }
        anchor.start()
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.order() }
        })
        observePhase()
        Task { await model.open(revision: nil, origin: nil) }
        return window
    }

    // MARK: - Window

    private func makeWindow() -> PaneWindow {
        let view = ReaderView(model: model, chrome: .embedded(close: { [weak self] in self?.end(status: 0) }, release: { [weak self] in self?.releaseFocus() }))
        let host = NSHostingController(rootView: view)
        host.sizingOptions = []
        hosting = host
        let bounds = NSRect(x: 0, y: 0, width: 640, height: 480)
        content = PaneContentView(frame: bounds)
        host.view.frame = bounds
        host.view.autoresizingMask = [.width, .height]
        content.addSubview(host.view)
        let window = PaneWindow(contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.contentView = content
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = false
        window.hasShadow = false
        window.isMovable = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        window.delegate = self
        window.onCancel = { [weak self] in self?.releaseFocus() }
        return window
    }

    /// Shows the window over the pane, with holes where other content of the terminal's window
    /// lies over the pane, or hides it.
    private func apply(_ status: TerminalAnchor.Status) {
        switch status {
        case .placed(let shown) where !shown.coveredEntirely:
            placement = shown
            if window.frame != shown.frame { window.setFrame(shown.frame, display: true) }
            let holes = shown.covers.map { $0.offsetBy(dx: -shown.frame.minX, dy: -shown.frame.minY) }
            if holes != content.holes {
                paneLog.notice("holes \(holes.count, privacy: .public): \(holes.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" }.joined(separator: "; "), privacy: .public)")
                content.holes = holes
            }
            if !window.isVisible { window.orderFrontRegardless() }
            order()
        case .placed, .concealed, .searching, .untrusted:
            placement = nil
            if window.isVisible { window.orderOut(nil) }
        }
        draw()
    }

    /// Keeps the window above its host's window. While the host or the reader is the active
    /// application the window floats, so that activating the host never covers it. It sits at the
    /// normal level just above the host window when another application is active, so other
    /// applications cover both, and while another window of the host lies over the pane, so that
    /// window, such as a command palette, stays on top.
    private func order() {
        guard let placement, window.isVisible else { return }
        let active = NSWorkspace.shared.frontmostApplication?.processIdentifier
        if let cover = placement.coveredBy {
            if window.level != .normal { window.level = .normal }
            window.order(.below, relativeTo: Int(cover))
        } else if active == placement.host || active == ProcessInfo.processInfo.processIdentifier {
            if window.level != .floating { window.level = .floating }
            window.orderFrontRegardless()
        } else {
            if window.level != .normal { window.level = .normal }
            if let number = placement.window { window.order(.above, relativeTo: Int(number)) }
        }
    }

    /// Gives the keyboard back to the application that shows the pane.
    private func releaseFocus() {
        guard let host = placement?.host, let application = NSRunningApplication(processIdentifier: host) else { return }
        application.activate()
    }

    func windowWillClose(_ notification: Notification) {
        end(status: 0)
    }

    // MARK: - Terminal

    private func key(_ key: PaneTerminal.Key) {
        switch key {
        case .quit:
            end(status: 0)
        case .other:
            guard window.isVisible else { return }
            window.makeKeyAndOrderFront(nil)
        }
    }

    private func observePhase() {
        withObservationTracking {
            _ = model.phase
            _ = model.snapshot?.revision
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.draw()
                self?.observePhase()
            }
        }
    }

    private func draw() {
        let title = model.snapshot.map { _ in model.displayTitle } ?? "Opening the document"
        var status: String
        switch anchor.status {
        case .placed(let shown) where !shown.coveredEntirely: status = "Shown in the reader window over this pane."
        case .placed, .concealed: status = "The reader window is hidden while this pane is covered or not on screen."
        case .searching: status = "Looking for this pane on screen."
        case .untrusted: status = "This terminal cannot place the reader over its pane: the program has no accessibility access."
        }
        if case .failed(let message) = model.phase { status = "The document could not be opened: \(message)" }
        terminal.draw(title: title, status: status, keys: "q closes the reader. Another key moves the keyboard to the reader.", marker: anchor.marker)
    }

    // MARK: - Ending

    /// Captures the reading position, saves the pending reading state, restores the terminal and
    /// ends the process. Closing the reader ends only this pane's program; the document and other
    /// readers are not affected. Every wait has a bound on the monotonic clock: the capture half a
    /// second, capture and save together one second, and each write to the terminal a fifth of a
    /// second, so a stalled lock, file system, terminal or error pipe never keeps the process
    /// alive. The exit status is the caller's when the state was saved or had nothing to save, and
    /// at least 1 otherwise, with one line on standard error that says whether the position was
    /// not saved or may not have been saved. A terminal that hung up is not written to.
    func end(status: Int32, terminalGone: Bool = false) {
        guard !ending else { return }
        ending = true
        anchor.stop()
        window.orderOut(nil)
        let gone = Flag(terminalGone)
        terminal.onHangUp = { gone.value = true }
        let finished = Flag()
        let finish: (ReadingStateFlushResult) -> Void = { [self] result in
            guard !finished.value else { return }
            finished.value = true
            result.logFailure()
            let message: String?
            switch result {
            case .saved, .nothingToSave: message = nil
            case .notSaved: message = "Markdown Reader: the reading position was not saved."
            case .unconfirmed: message = "Markdown Reader: the reading position may not have been saved."
            }
            if !gone.value {
                terminal.leave(before: .now() + Self.outputAllowance)
                if let message { terminal.report(message, before: .now() + Self.outputAllowance) }
            }
            // Output that the terminal did not take must not hold the exit, so no exit handler
            // runs that could wait for it.
            _exit(message == nil ? status : max(status, 1))
        }
        let deadline = DispatchTime.now() + Self.saveAllowance
        Task { @MainActor in
            let captured = await Self.run(until: .now() + Self.captureAllowance) { await self.model.close() }
            var result = await state.flush(timeout: Self.seconds(until: deadline))
            while result == .saved, state.hasPendingChanges, Self.seconds(until: deadline) > 0 {
                result = await state.flush(timeout: Self.seconds(until: deadline))
            }
            if !captured, result == .saved || result == .nothingToSave {
                result = .unconfirmed(reason: "The final reading position was not captured in time.")
            }
            finish(result)
        }
        DispatchQueue.main.asyncAfter(deadline: deadline + Self.outputAllowance) {
            MainActor.assumeIsolated { finish(.unconfirmed(reason: "The shutdown deadline passed before the save settled.")) }
        }
    }

    /// Time for the final position capture.
    static let captureAllowance = 0.5
    /// Time for the capture and the save together.
    static let saveAllowance = 1.0
    /// Time for each write to the terminal at the end.
    static let outputAllowance = 0.2

    static func seconds(until deadline: DispatchTime) -> TimeInterval {
        let now = DispatchTime.now().uptimeNanoseconds
        let end = deadline.uptimeNanoseconds
        return end > now ? Double(end - now) / 1_000_000_000 : 0
    }

    /// Runs `work` and reports whether it finished before `deadline`; after the deadline the
    /// caller goes on and the work continues on its own.
    static func run(until deadline: DispatchTime, _ work: @escaping @MainActor () async -> Void) async -> Bool {
        await withCheckedContinuation { continuation in
            let resumed = Flag()
            Task { @MainActor in
                await work()
                guard !resumed.value else { return }
                resumed.value = true
                continuation.resume(returning: true)
            }
            DispatchQueue.main.asyncAfter(deadline: deadline) {
                MainActor.assumeIsolated {
                    guard !resumed.value else { return }
                    resumed.value = true
                    continuation.resume(returning: false)
                }
            }
        }
    }
}

/// A value that main-actor closures share.
@MainActor
final class Flag {
    var value: Bool

    init(_ value: Bool = false) {
        self.value = value
    }
}

/// The panel's content: the reader, with holes where other content of the terminal's window lies
/// over the pane. A hole is transparent, so the content below shows through it, and the panel
/// takes no clicks there.
final class PaneContentView: NSView {
    /// Rectangles in this view's coordinates.
    var holes: [CGRect] = [] {
        didSet { if holes != oldValue { updateMask() } }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    override func layout() {
        super.layout()
        updateMask()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        if holes.contains(where: { $0.contains(local) }) { return nil }
        return super.hitTest(point)
    }

    private func updateMask() {
        guard let layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        guard let path = TerminalAnchor.maskPath(bounds: bounds, holes: holes) else {
            layer.mask = nil
            return
        }
        let mask = (layer.mask as? CAShapeLayer) ?? CAShapeLayer()
        mask.frame = bounds
        mask.fillRule = .nonZero
        mask.path = path
        layer.mask = mask
    }
}

/// A borderless panel that takes the keyboard without activating the reader: the terminal
/// application stays the active application, as when one of its own panes takes the keyboard,
/// and the first click reaches the page. Escape outside a text field gives the keyboard back to
/// the terminal application.
final class PaneWindow: NSPanel {
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, !isKeyWindow { makeKey() }
        super.sendEvent(event)
    }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    override func performClose(_ sender: Any?) {
        close()
    }

    /// A window without a close button disables Close in the menu; this one closes by its own
    /// control, Command-W and Command-Q.
    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        item.action == #selector(performClose(_:)) ? true : super.validateUserInterfaceItem(item)
    }
}

/// The pane's terminal: raw input, the alternate screen and a short placeholder. Text that the
/// placeholder shows passes through `TerminalText.printable`, so a title cannot control the
/// terminal.
@MainActor
final class PaneTerminal {
    enum Key { case quit, other }

    var onKey: ((Key) -> Void)?
    var onResize: (() -> Void)?
    /// The terminal is gone: a hang-up signal or the end of input.
    var onHangUp: (() -> Void)?
    /// Termination or interruption signals while the terminal stays.
    var onTerminate: (() -> Void)?
    private var saved = termios()
    private var raw = false
    private var left = false
    private var sources: [DispatchSourceProtocol] = []
    private let output = TerminalOutput(descriptor: STDOUT_FILENO, label: "local.harness.markdown-reader.terminal-output")
    private let errors = TerminalOutput(descriptor: STDERR_FILENO, label: "local.harness.markdown-reader.error-output")

    /// Nil unless standard input and output are a terminal.
    init?() {
        guard isatty(STDIN_FILENO) == 1, isatty(STDOUT_FILENO) == 1 else { return nil }
    }

    func enter() {
        if tcgetattr(STDIN_FILENO, &saved) == 0 {
            var settings = saved
            cfmakeraw(&settings)
            raw = tcsetattr(STDIN_FILENO, TCSANOW, &settings) == 0
        }
        output.enqueue(Array("\u{1B}[?1049h\u{1B}[?25l\u{1B}[2J".utf8))
    }

    /// Restores the terminal and draws nothing more. The screen sequences wait at most until
    /// `deadline`; the terminal modes return at once.
    func leave(before deadline: DispatchTime) {
        guard !left else { return }
        left = true
        output.send(Array("\u{1B}[0m\u{1B}[2J\u{1B}[?25h\u{1B}[?1049l".utf8), before: deadline)
        if raw { tcsetattr(STDIN_FILENO, TCSANOW, &saved) }
    }

    /// Writes one line to standard error, cleaned by `TerminalText.line`, waiting at most until
    /// `deadline`.
    func report(_ text: String, before deadline: DispatchTime) {
        errors.send(Array(TerminalText.line(text).utf8), before: deadline)
    }

    func start() {
        // A closed pipe on standard error returns an error to the write instead of ending the
        // process with a signal, so the exit status stays the reader's own.
        signal(SIGPIPE, SIG_IGN)
        let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        input.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.readInput() }
        }
        input.resume()
        sources.append(input)
        let handlers: [(Int32, () -> Void)] = [
            (SIGWINCH, { [weak self] in self?.onResize?() }),
            (SIGHUP, { [weak self] in self?.onHangUp?() }),
            (SIGTERM, { [weak self] in self?.onTerminate?() }),
            (SIGINT, { [weak self] in self?.onTerminate?() }),
        ]
        for (signalNumber, handler) in handlers {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { MainActor.assumeIsolated { handler() } }
            source.resume()
            sources.append(source)
        }
    }

    private func readInput() {
        var buffer = [UInt8](repeating: 0, count: 256)
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        if count < 0, errno == EINTR || errno == EAGAIN { return }
        guard count > 0 else {
            // The input stays readable at its end; stop reading it before the reader ends.
            sources.first?.cancel()
            onHangUp?()
            return
        }
        let bytes = buffer.prefix(count)
        onKey?(bytes.contains(where: { $0 == UInt8(ascii: "q") || $0 == UInt8(ascii: "Q") || $0 == 3 || $0 == 4 }) ? .quit : .other)
    }

    /// Columns and rows of the terminal.
    func size() -> (columns: Int, rows: Int) {
        var size = winsize()
        let result = withUnsafeMutablePointer(to: &size) { ioctl(STDOUT_FILENO, TIOCGWINSZ, $0) }
        guard result == 0, size.ws_col > 0, size.ws_row > 0 else { return (80, 24) }
        return (Int(size.ws_col), Int(size.ws_row))
    }

    /// Draws the placeholder. The marker sits in concealed text on the first line, where a
    /// narrow pane still shows it whole. Each line is placed by row and the placeholder stops at
    /// the last row, so a short pane never scrolls the marker away.
    func draw(title: String, status: String, keys: String, marker: String) {
        guard !left else { return }
        let (columns, rows) = size()
        let width = max(10, columns - 4)
        var lines = ["\u{1B}[8m\(marker)\u{1B}[28m", ""]
        lines.append("  \u{1B}[1m\(TerminalText.fit(TerminalText.printable(title), width))\u{1B}[22m")
        lines += TerminalText.wrap(TerminalText.printable(status), width).map { "  \($0)" }
        lines.append("")
        lines += TerminalText.wrap(keys, width).map { "  \u{1B}[2m\($0)\u{1B}[22m" }
        // Each row is replaced in place, without clearing the screen first, so the first row
        // shows a marker at every moment.
        var text = "\u{1B}[0m"
        for (row, line) in lines.prefix(rows).enumerated() { text += "\u{1B}[\(row + 1);1H\(line)\u{1B}[K" }
        text += "\u{1B}[J"
        output.post(frame: Array(text.utf8))
    }
}
