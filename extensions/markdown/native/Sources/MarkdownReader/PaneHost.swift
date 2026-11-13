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
    private let anchor: TerminalAnchor
    private var window: PaneWindow!
    private var placement: TerminalAnchor.Placement?
    private var ending = false
    private var observers: [NSObjectProtocol] = []

    init(model: ReaderModel, state: ReadingStateStore, terminal: PaneTerminal) {
        self.model = model
        self.state = state
        self.terminal = terminal
        self.anchor = TerminalAnchor(marker: "reader-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased())
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
        let window = PaneWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.contentViewController = host
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = false
        window.hasShadow = false
        window.isMovable = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        window.backgroundColor = .windowBackgroundColor
        window.delegate = self
        window.onCancel = { [weak self] in self?.releaseFocus() }
        return window
    }

    private func apply(_ status: TerminalAnchor.Status) {
        switch status {
        case .placed(let shown):
            placement = shown
            if window.frame != shown.frame { window.setFrame(shown.frame, display: true) }
            if !window.isVisible { window.orderFrontRegardless() }
            order()
        case .concealed, .searching, .untrusted:
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
        case .placed: status = "Shown in the reader window over this pane."
        case .concealed: status = "The reader window is hidden while this pane is covered or not on screen."
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
        let finish = { [self] in
            state.saveNow()
            if !terminalGone { terminal.leave() }
            exit(status)
        }
        Task { @MainActor in
            await model.close()
            finish()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { MainActor.assumeIsolated { finish() } }
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
        var text = "\u{1B}[0m\u{1B}[2J"
        for (row, line) in lines.prefix(rows).enumerated() { text += "\u{1B}[\(row + 1);1H\(line)" }
        write(text)
    }

    private func write(_ text: String) {
        var bytes = Array(text.utf8)
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeMutableBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress! + offset, $0.count - offset) }
            if written <= 0 { return }
            offset += written
        }
    }
}
