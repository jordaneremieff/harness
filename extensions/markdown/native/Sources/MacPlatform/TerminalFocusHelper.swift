import Foundation
import MarkdownCore
import ReaderFeature

/// Runs the Rex-owned terminal-origin helper (`<node> <helper> focus`) with an origin record on
/// standard input. Both paths come from the app's own bundle and build manifest, never from a
/// document or an open request. The helper validates the origin; this type only bounds the run.
public struct TerminalFocusHelper: Sendable {
    public let node: URL
    public let helper: URL
    public let timeout: Duration

    public static let outputLimit = 4096
    /// Largest origin record the helper reads from standard input, in bytes.
    public static let inputLimit = 16384

    /// A helper that exits or closes its input early must not terminate the app: with SIGPIPE
    /// ignored, a write to the closed pipe fails with an error instead.
    private static let brokenPipeIgnored: Void = {
        signal(SIGPIPE, SIG_IGN)
    }()

    public init(node: URL, helper: URL, timeout: Duration = .seconds(8)) {
        self.node = node
        self.helper = helper
        self.timeout = timeout
    }

    /// The helper recorded in the bundle's `build.json` (`terminalOrigin.node`, `terminalOrigin.helper`
    /// relative to the bundle's resources), when both files exist.
    public static func fromBundle(_ bundle: Bundle = .main) -> TerminalFocusHelper? {
        guard let resources = bundle.resourceURL,
              let data = try? Data(contentsOf: resources.appendingPathComponent("build.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let origin = manifest["terminalOrigin"] as? [String: Any],
              let node = origin["node"] as? String, node.hasPrefix("/"),
              let helper = origin["helper"] as? String, !helper.contains("/"), !helper.isEmpty
        else { return nil }
        let helperURL = resources.appendingPathComponent(helper)
        guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: helperURL.path) else { return nil }
        return TerminalFocusHelper(node: URL(fileURLWithPath: node), helper: helperURL)
    }

    /// Runs `focus` once. It never retries; a timeout leaves pane focus uncertain. The input
    /// transfer, the run and the output all fall within the timeout.
    public func focus(_ origin: LaunchOrigin) async -> PaneSelection {
        let input: Data
        do {
            input = try JSONEncoder().encode(origin)
        } catch {
            return .unavailable("the origin could not be encoded")
        }
        guard input.count <= Self.inputLimit else {
            return .unavailable("the origin record has \(input.count) bytes; the pane helper reads at most \(Self.inputLimit)")
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [helper.path, "focus"]
        process.environment = ["PATH": "/usr/bin:/bin"]
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        let finished = AsyncStream<Void> { continuation in
            process.terminationHandler = { _ in continuation.yield(); continuation.finish() }
        }
        do {
            try process.run()
        } catch {
            return .unavailable("the pane helper could not start: \(error.localizedDescription)")
        }
        let writer = stdin.fileHandleForWriting
        Task.detached { Self.send(input, to: writer) }
        let output = Task.detached { (try? stdout.fileHandleForReading.read(upToCount: Self.outputLimit + 1)) ?? Data() }
        let errors = Task.detached { (try? stderr.fileHandleForReading.read(upToCount: 1024)) ?? Data() }
        let timedOut = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await _ in finished { return false }
                return false
            }
            group.addTask { [timeout] in
                try? await Task.sleep(for: timeout)
                return true
            }
            let first = await group.next() ?? true
            group.cancelAll()
            return first
        }
        if timedOut {
            process.terminate()
            return .unavailable("the pane helper did not answer in time; pane focus is uncertain")
        }
        let out = await output.value
        let err = await errors.value
        if process.terminationStatus != 0 {
            let line = String(decoding: err.prefix(300), as: UTF8.self).split(separator: "\n").first.map(String.init) ?? "exit \(process.terminationStatus)"
            return .unavailable("the pane helper refused the origin: \(line)")
        }
        return Self.parse(out)
    }

    /// Writes the input and closes the pipe. A helper that closed its input early makes the write
    /// fail; the helper's exit and output still decide the outcome.
    static func send(_ input: Data, to handle: FileHandle) {
        _ = brokenPipeIgnored
        try? handle.write(contentsOf: input)
        try? handle.close()
    }

    /// Reads the helper's one JSON result line.
    public static func parse(_ data: Data) -> PaneSelection {
        guard data.count <= outputLimit,
              let text = String(data: data, encoding: .utf8),
              let line = text.split(separator: "\n", omittingEmptySubsequences: true).first,
              text.split(separator: "\n", omittingEmptySubsequences: true).count == 1,
              let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let outcome = object["outcome"] as? String,
              let detail = object["detail"] as? String,
              detail.count <= 256, !detail.contains("\n")
        else { return .unavailable("the pane helper returned malformed output") }
        switch outcome {
        case "focused": return .focused
        case "stale": return .stale(detail)
        case "unavailable": return .unavailable(detail)
        default: return .unavailable("the pane helper returned an unknown outcome")
        }
    }
}
