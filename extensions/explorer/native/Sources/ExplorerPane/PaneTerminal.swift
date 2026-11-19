import Darwin
import Foundation

/// The pane's terminal: raw input, the alternate screen and a short placeholder. Text that the
/// placeholder shows passes through `TerminalText.printable`, so a title cannot control the
/// terminal.
@MainActor
public final class PaneTerminal {
    public var onInput: (([PaneInput.Event]) -> Void)?
    public var onResize: (() -> Void)?
    /// The terminal is gone: a hang-up signal or the end of input.
    public var onHangUp: (() -> Void)?
    /// Termination or interruption signals while the terminal stays.
    public var onTerminate: (() -> Void)?
    public var onBytes: ((ArraySlice<UInt8>) -> Void)?
    private var keys = PaneInput()
    private var saved = termios()
    private var raw = false
    private var left = false
    private var sources: [DispatchSourceProtocol] = []
    private let output = TerminalOutput(descriptor: STDOUT_FILENO, label: "local.harness.native-pane.terminal-output")
    private let errors = TerminalOutput(descriptor: STDERR_FILENO, label: "local.harness.native-pane.error-output")

    /// Nil unless standard input and output are a terminal.
    public init?() {
        guard isatty(STDIN_FILENO) == 1, isatty(STDOUT_FILENO) == 1 else { return nil }
    }

    public func enter() {
        if tcgetattr(STDIN_FILENO, &saved) == 0 {
            var settings = saved
            cfmakeraw(&settings)
            raw = tcsetattr(STDIN_FILENO, TCSANOW, &settings) == 0
        }
        output.enqueue(Array("\u{1B}[?1049h\u{1B}[?25l\u{1B}[2J".utf8))
    }

    /// Restores the terminal and draws nothing more. The screen sequences wait at most until
    /// `deadline`; the terminal modes return at once.
    public func leave(before deadline: DispatchTime) {
        guard !left else { return }
        left = true
        output.send(Array("\u{1B}[0m\u{1B}[2J\u{1B}[?25h\u{1B}[?1049l".utf8), before: deadline)
        if raw { tcsetattr(STDIN_FILENO, TCSANOW, &saved) }
    }

    /// Writes one line to standard error, cleaned by `TerminalText.line`, waiting at most until
    /// `deadline`.
    public func report(_ text: String, before deadline: DispatchTime) {
        errors.send(Array(TerminalText.line(text).utf8), before: deadline)
    }

    public func start() {
        // A closed pipe on standard error returns an error to the write instead of ending the
        // process with a signal, so the exit status stays the application's own.
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
            // The input stays readable at its end; stop reading it before the application ends.
            sources.first?.cancel()
            onHangUp?()
            return
        }
        if let onBytes { onBytes(buffer.prefix(count)); return }
        let events = keys.feed(buffer.prefix(count))
        if !events.isEmpty { onInput?(events) }
    }

    /// Columns and rows of the terminal.
    public func size() -> (columns: Int, rows: Int) {
        var size = winsize()
        let result = withUnsafeMutablePointer(to: &size) { ioctl(STDOUT_FILENO, TIOCGWINSZ, $0) }
        guard result == 0, size.ws_col > 0, size.ws_row > 0 else { return (80, 24) }
        return (Int(size.ws_col), Int(size.ws_row))
    }

    public func drawMarker(_ marker: String) {
        guard !left else { return }
        output.post(frame: Array("\u{1B}[1;1H\u{1B}[8m\(marker)\u{1B}[28m\u{1B}[K".utf8))
    }

    /// Draws the placeholder. The marker sits in concealed text on the first line, where a
    /// narrow pane still shows it whole. Each line is placed by row and the placeholder stops at
    /// the last row, so a short pane never scrolls the marker away.
    public func draw(title: String, identity: String, status: String, keys: String, command: String?, marker: String) {
        guard !left else { return }
        let (columns, rows) = size()
        let width = max(10, columns - 4)
        var lines = ["\u{1B}[8m\(marker)\u{1B}[28m", ""]
        lines.append("  \u{1B}[1m\(TerminalText.fit(TerminalText.printable(title), width))\u{1B}[22m")
        lines.append("  \(TerminalText.fit(TerminalText.printable(identity), width))")
        lines += TerminalText.wrap(TerminalText.printable(status), width).map { "  \($0)" }
        lines.append("")
        lines += TerminalText.wrap(keys, width).map { "  \u{1B}[2m\($0)\u{1B}[22m" }
        if let command { lines += ["", "  :\(TerminalText.fit(TerminalText.printable(command), width - 1))"] }
        // Each row is replaced in place, without clearing the screen first, so the first row
        // shows a marker at every moment.
        var text = "\u{1B}[0m"
        for (row, line) in lines.prefix(rows).enumerated() { text += "\u{1B}[\(row + 1);1H\(line)\u{1B}[K" }
        text += "\u{1B}[J"
        output.post(frame: Array(text.utf8))
    }
}
