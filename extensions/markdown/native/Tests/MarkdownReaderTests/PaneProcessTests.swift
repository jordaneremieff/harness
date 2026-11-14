import Testing
import CryptoKit
@testable import MarkdownCore

/// The built reader binary in pane mode on a pseudo-terminal: how it ends, what it leaves on the
/// terminal, and its exit status. Each run uses its own document store and its own home folder for
/// the reading state.
struct PaneRun {
    let root: URL
    let home: URL
    let document = "md-0123456789abcdef0123"
    private let storeId = "0123456789abcdef0123456789abcdef"

    static var binary: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/debug/MarkdownReader")
    }

    init(storeId: String? = nil) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("pane-run-\(UUID().uuidString)")
        home = root.appendingPathComponent("home")
        let store = root.appendingPathComponent("store")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)
        try Self.write(["version": 1, "storeId": storeId ?? self.storeId], to: store.appendingPathComponent("store.json"))
        let revision = store.appendingPathComponent("documents/\(document)/revisions/1")
        try FileManager.default.createDirectory(at: revision, withIntermediateDirectories: true)
        let source = Data("# Pane run\n\nA document for the pane process tests.\n".utf8)
        let digest = "sha256:" + SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        try source.write(to: revision.appendingPathComponent("source.md"))
        let date = "2026-11-14T00:00:00Z"
        try Self.write(["version": 1, "document": document, "revision": 1, "title": "Pane run", "createdAt": date,
                        "digest": digest, "bytes": source.count, "completeness": ["state": "complete"]],
                       to: revision.appendingPathComponent("revision.json"))
        try Self.write(["version": 1, "id": document, "kind": "published", "title": "Pane run", "createdAt": date,
                        "updatedAt": date, "revision": 1, "digest": digest, "bytes": source.count],
                       to: store.appendingPathComponent("documents/\(document)/document.json"))
    }

    var store: String { root.appendingPathComponent("store").path }
    var stateLock: String { home.appendingPathComponent("Library/Application Support/Markdown Reader/reading-state.lock").path }

    private static func write(_ value: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }

    /// A started reader: the terminal's primary side, an optional separate standard error, and
    /// the process.
    final class Process {
        let pid: pid_t
        let primary: Int32
        var output = [UInt8]()

        init(pid: pid_t, primary: Int32) {
            self.pid = pid
            self.primary = primary
        }

        /// Reads the terminal until `text` appears or `seconds` pass.
        func read(until text: String, seconds: Double) -> Bool {
            let deadline = DispatchTime.now() + seconds
            var buffer = [UInt8](repeating: 0, count: 4096)
            while DispatchTime.now() < deadline {
                if String(decoding: output, as: UTF8.self).contains(text) { return true }
                var ready = pollfd(fd: primary, events: Int16(POLLIN), revents: 0)
                guard poll(&ready, 1, 50) > 0 else { continue }
                let count = Darwin.read(primary, &buffer, buffer.count)
                guard count > 0 else { break }
                output += buffer.prefix(count)
            }
            return String(decoding: output, as: UTF8.self).contains(text)
        }

        /// Waits for the exit and reads what the terminal shows meanwhile. Returns the exit
        /// status, or nil for a signal or no exit within `seconds`.
        func exit(within seconds: Double, reading: Bool = true) -> (status: Int32?, seconds: Double) {
            let start = DispatchTime.now()
            let deadline = start + seconds
            var status: Int32 = 0
            var buffer = [UInt8](repeating: 0, count: 4096)
            while DispatchTime.now() < deadline {
                if waitpid(pid, &status, WNOHANG) == pid {
                    if reading { _ = read(until: "\u{0}never", seconds: 0.2) }
                    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
                    return ((status & 0x7f) == 0 ? (status >> 8) & 0xff : nil, elapsed)
                }
                if reading {
                    var ready = pollfd(fd: primary, events: Int16(POLLIN), revents: 0)
                    if poll(&ready, 1, 20) > 0 {
                        let count = Darwin.read(primary, &buffer, buffer.count)
                        if count > 0 { output += buffer.prefix(count) }
                    }
                } else {
                    usleep(20_000)
                }
            }
            kill(pid, SIGKILL)
            waitpid(pid, &status, 0)
            return (nil, seconds)
        }

        var text: String { String(decoding: output, as: UTF8.self) }
    }

    /// Starts the reader on a new pseudo-terminal. `errors` replaces standard error.
    func start(arguments: [String]? = nil, errors: Int32? = nil, prepare: (Int32) -> Void = { _ in }) throws -> Process {
        var primary: Int32 = 0
        var secondary: Int32 = 0
        var size = winsize(ws_row: 30, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&primary, &secondary, nil, nil, &size) == 0 else { throw POSIXError(.EIO) }
        prepare(secondary)
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, secondary, 0)
        posix_spawn_file_actions_adddup2(&actions, secondary, 1)
        posix_spawn_file_actions_adddup2(&actions, errors ?? secondary, 2)
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // The reader keeps only its standard descriptors, as in a terminal pane: a copy of the
        // terminal's primary side would keep the terminal open after the test closes it.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
        let words = [Self.binary.path] + (arguments ?? ["--pane", "--store", store, document])
        var environment = ProcessInfo.processInfo.environment
        environment["PI_PANE_STACKING"] = nil
        environment["CFFIXED_USER_HOME"] = home.path
        let argv = words.map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        let result = posix_spawn(&pid, Self.binary.path, &actions, &attributes, argv, envp)
        close(secondary)
        guard result == 0 else {
            close(primary)
            throw POSIXError(POSIXErrorCode(rawValue: result) ?? .EIO)
        }
        return Process(pid: pid, primary: primary)
    }
}

/// Holds the reading-state lock in another process, as a stalled reader would.
final class LockHolder {
    private let process = Foundation.Process()

    init(_ path: String) throws {
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        process.executableURL = URL(fileURLWithPath: "/usr/bin/lockf")
        process.arguments = ["-k", "-t", "0", path, "/bin/sleep", "30"]
        try process.run()
        // lockf takes the lock before it starts sleep.
        let deadline = DispatchTime.now() + 2
        while DispatchTime.now() < deadline, !Self.held(path) { usleep(10_000) }
    }

    static func held(_ path: String) -> Bool {
        let descriptor = open(path, O_RDWR)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        if flock(descriptor, LOCK_EX | LOCK_NB) == 0 {
            flock(descriptor, LOCK_UN)
            return false
        }
        return true
    }

    func release() {
        process.terminate()
        process.waitUntilExit()
    }
}

let restore = "\u{1B}[?1049l"
let notSaved = "Markdown Reader: the reading position was not saved."

@Suite(.serialized) struct PaneProcessEnd {
    func started(_ run: PaneRun, errors: Int32? = nil) throws -> PaneRun.Process {
        #expect(FileManager.default.isExecutableFile(atPath: PaneRun.binary.path), "build the package before its tests")
        let process = try run.start(errors: errors)
        #expect(process.read(until: "Pane run", seconds: 15), "the placeholder appears")
        return process
    }

    @Test(arguments: ["q", "terminate", "interrupt"])
    func endsAndRestoresTheTerminal(_ action: String) throws {
        let run = try PaneRun()
        defer { run.remove() }
        let process = try started(run)
        defer { close(process.primary) }
        switch action {
        case "q": _ = "q".withCString { Darwin.write(process.primary, $0, 1) }
        case "terminate": kill(process.pid, SIGTERM)
        default: kill(process.pid, SIGINT)
        }
        let ended = process.exit(within: 5)
        #expect(ended.status == 0)
        #expect(ended.seconds < 3)
        #expect(process.text.contains(restore))
        #expect(!process.text.contains("Markdown Reader:"))
    }

    @Test func aHangUpEndsWithoutWritingToTheTerminal() throws {
        let run = try PaneRun()
        defer { run.remove() }
        let process = try started(run)
        defer { close(process.primary) }
        let before = process.output.count
        kill(process.pid, SIGHUP)
        let ended = process.exit(within: 5)
        #expect(ended.status == 0)
        #expect(process.output.count == before)
    }

    @Test func aClosedTerminalEndsTheReader() throws {
        let run = try PaneRun()
        defer { run.remove() }
        let process = try started(run)
        close(process.primary)
        let ended = process.exit(within: 5, reading: false)
        #expect(ended.status == 0)
    }

    @Test func aHeldStateLockEndsWithStatusOneAndALine() throws {
        let run = try PaneRun()
        defer { run.remove() }
        let process = try started(run)
        defer { close(process.primary) }
        let holder = try LockHolder(run.stateLock)
        defer { holder.release() }
        _ = "q".withCString { Darwin.write(process.primary, $0, 1) }
        let ended = process.exit(within: 5)
        #expect(ended.status == 1)
        #expect(ended.seconds < 3)
        let text = process.text
        #expect(text.contains(restore))
        // The line follows the restored screen, so it stays visible in the pane.
        #expect(text.range(of: notSaved).map { $0.lowerBound > text.range(of: restore)!.lowerBound } == true)
    }

    @Test func aStandardErrorThatStopsReadingDoesNotHoldTheExit() throws {
        let run = try PaneRun()
        defer { run.remove() }
        var ends: [Int32] = [0, 0]
        #expect(pipe(&ends) == 0)
        defer { close(ends[0]) }
        let flags = fcntl(ends[1], F_GETFL)
        _ = fcntl(ends[1], F_SETFL, flags | O_NONBLOCK)
        let chunk = [UInt8](repeating: 0x2E, count: 1024)
        while chunk.withUnsafeBytes({ Darwin.write(ends[1], $0.baseAddress!, $0.count) }) > 0 {}
        _ = fcntl(ends[1], F_SETFL, flags)
        let process = try started(run, errors: ends[1])
        close(ends[1])
        defer { close(process.primary) }
        let holder = try LockHolder(run.stateLock)
        defer { holder.release() }
        _ = "q".withCString { Darwin.write(process.primary, $0, 1) }
        let ended = process.exit(within: 5)
        #expect(ended.status == 1)
        #expect(ended.seconds < 3)
        #expect(process.text.contains(restore))
    }

    @Test func aTerminalThatStopsReadingDoesNotHoldTheExit() throws {
        #expect(FileManager.default.isExecutableFile(atPath: PaneRun.binary.path), "build the package before its tests")
        let run = try PaneRun()
        defer { run.remove() }
        // The terminal's buffer is full before the reader starts, and nothing reads it.
        let process = try run.start { secondary in
            let flags = fcntl(secondary, F_GETFL)
            _ = fcntl(secondary, F_SETFL, flags | O_NONBLOCK)
            let chunk = [UInt8](repeating: 0x2E, count: 1024)
            while chunk.withUnsafeBytes({ Darwin.write(secondary, $0.baseAddress!, $0.count) }) > 0 {}
            _ = fcntl(secondary, F_SETFL, flags)
        }
        defer { close(process.primary) }
        // No placeholder can arrive; give the reader time to open its document.
        usleep(2_000_000)
        kill(process.pid, SIGTERM)
        let ended = process.exit(within: 5, reading: false)
        #expect(ended.status == 0)
        #expect(ended.seconds < 3)
    }

    @Test func storeTextCannotControlTheTerminal() throws {
        let run = try PaneRun(storeId: "\u{1B}]52;c;aGVsbG8=\u{07}\u{1B}[2J\u{9B}31mRED")
        defer { run.remove() }
        let process = try run.start(arguments: ["--pane", "--store", run.store, "md-\u{1B}[2Jdoc"])
        defer { close(process.primary) }
        let ended = process.exit(within: 10)
        #expect(ended.status == 1)
        let bytes = process.output
        #expect(!bytes.contains(0x1B))
        #expect(!bytes.contains(0x07))
        #expect(!process.text.unicodeScalars.contains { $0.value == 0x9B })
        #expect(process.text.contains("cannot be shown"))
    }
}
