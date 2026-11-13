import AppKit
import Darwin
import MacPlatform
import MarkdownCore
import ReaderFeature
import SwiftUI

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
            content.holes = shown.covers.map { $0.offsetBy(dx: -shown.frame.minX, dy: -shown.frame.minY) }
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

    /// Saves the reading position, restores the terminal and ends the process. Closing the reader
    /// ends only this pane's program; the document and other readers are not affected. The final
    /// position capture gets one second; after that the last saved position stands. A terminal
    /// that hung up is not written to.
    func end(status: Int32, terminalGone: Bool = false) {
        guard !ending else { return }
        ending = true
        anchor.stop()
        window.orderOut(nil)
        var gone = terminalGone
        var finished = false
        terminal.onHangUp = { gone = true }
        let finish: (ReadingStateFlushResult) -> Void = { [self] result in
            guard !finished else { return }
            finished = true
            if !gone { terminal.leave() }
            var finalStatus = status
            if case .notSaved = result {
                result.logFailure()
                if !gone {
                    FileHandle.standardError.write(Data("Markdown Reader: the reading position was not saved.\n".utf8))
                }
                if finalStatus == 0 { finalStatus = 1 }
            }
            exit(finalStatus)
        }
        Task { @MainActor in
            await model.close()
            var result = await state.flush(timeout: 0.75)
            while result == .saved, state.hasPendingChanges {
                result = await state.flush(timeout: 0.75)
            }
            finish(result)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            MainActor.assumeIsolated {
                finish(.notSaved(reason: "The final position capture or state flush exceeded one second."))
            }
        }
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
    private var sources: [DispatchSourceProtocol] = []

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
        write("\u{1B}[?1049h\u{1B}[?25l\u{1B}[2J")
    }

    func leave() {
        write("\u{1B}[0m\u{1B}[2J\u{1B}[?25h\u{1B}[?1049l")
        if raw { tcsetattr(STDIN_FILENO, TCSANOW, &saved) }
    }

    func start() {
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
        write(text)
    }

    /// Writes to the terminal and waits at most a fifth of a second for it in all: a terminal
    /// that stops reading loses the rest of the text rather than holding the main thread.
    private func write(_ text: String) {
        let bytes = Array(text.utf8)
        let flags = fcntl(STDOUT_FILENO, F_GETFL)
        if flags >= 0 { _ = fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) }
        defer { if flags >= 0 { _ = fcntl(STDOUT_FILENO, F_SETFL, flags) } }
        let deadline = Date().addingTimeInterval(0.2)
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress! + offset, $0.count - offset) }
            if written > 0 {
                offset += written
                continue
            }
            guard written < 0, errno == EAGAIN || errno == EINTR else { return }
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { return }
            var descriptor = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
            _ = poll(&descriptor, 1, Int32(max(1, remaining * 1000)))
        }
    }
}
