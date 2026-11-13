import Testing
@testable import MarkdownCore
@testable import MacPlatform

/// The helper runner against fake helper scripts run by /bin/sh in place of Node.
@Suite(.serialized) struct TerminalFocusHelperRuns {
    static let origin = LaunchOrigin(terminal: "Rex", bundleId: "com.superlogical.rex", exact: .object([
        "server": .string("unix:/tmp/rex.sock"), "hostId": .string("h"), "instanceId": .string("i"),
        "sessionId": .string("s"), "blockId": .string("b"),
    ]))

    func run(_ script: String, origin: LaunchOrigin = TerminalFocusHelperRuns.origin, timeout: Duration = .seconds(8)) async throws -> PaneSelection {
        try await runReporting(script, origin: origin, timeout: timeout).result
    }

    /// Runs a fake helper and also says whether it started (it creates `started` beside itself).
    func runReporting(_ script: String, origin: LaunchOrigin, timeout: Duration = .seconds(8)) async throws -> (result: PaneSelection, started: Bool) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("focus-helper-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = directory.appendingPathComponent("terminal-origin.ts")
        try Data(script.utf8).write(to: helper)
        let result = await TerminalFocusHelper(node: URL(fileURLWithPath: "/bin/sh"), helper: helper, timeout: timeout).focus(origin)
        return (result, FileManager.default.fileExists(atPath: directory.appendingPathComponent("started").path))
    }

    @Test func oversizedOriginIsRefusedBeforeTheHelperStarts() async throws {
        let script = "touch \"$(dirname \"$0\")/started\"; cat >/dev/null; echo '{\"outcome\":\"focused\",\"detail\":\"x\"}'"
        let large = LaunchOrigin(terminal: "Rex", bundleId: "com.superlogical.rex", exact: .object(["pad": .string(String(repeating: "x", count: TerminalFocusHelper.inputLimit))]))
        let refused = try await runReporting(script, origin: large)
        guard case .unavailable(let reason) = refused.result else {
            Issue.record("expected unavailable, got \(refused.result)")
            return
        }
        #expect(reason.contains("at most \(TerminalFocusHelper.inputLimit)"))
        #expect(!refused.started)
        // The same script runs when the origin fits.
        let accepted = try await runReporting(script, origin: Self.origin)
        #expect(accepted.result == .focused)
        #expect(accepted.started)
    }

    @Test func helperThatClosesItsInputDoesNotEndTheProcess() async throws {
        // The write meets a closed pipe: it fails instead of raising SIGPIPE.
        let pipe = Pipe()
        try pipe.fileHandleForReading.close()
        TerminalFocusHelper.send(Data(repeating: 0x20, count: TerminalFocusHelper.inputLimit), to: pipe.fileHandleForWriting)
        // Helpers that exit or close their input without reading it.
        let padded = LaunchOrigin(terminal: "Rex", bundleId: "com.superlogical.rex", exact: .object(["pad": .string(String(repeating: "x", count: TerminalFocusHelper.inputLimit - 200))]))
        for _ in 0..<10 {
            #expect(try await run("exit 0", origin: padded) == .unavailable("the pane helper returned malformed output"))
            #expect(try await run("exec 0<&-; echo '{\"outcome\":\"stale\",\"detail\":\"closed\"}'", origin: padded) == .stale("closed"))
        }
    }

    @Test func focusedWhenTheHelperSelectedThePane() async throws {
        // The script also proves that it received `focus` and the origin record on stdin.
        let result = try await run("""
        [ "$1" = focus ] || exit 3
        input=$(cat)
        case "$input" in *'"blockId":"b"'*) echo '{"outcome":"focused","detail":"Selected."}' ;; *) echo '{"outcome":"unavailable","detail":"no input"}' ;; esac
        """)
        #expect(result == .focused)
    }

    @Test func staleAndUnavailableCarryTheDetail() async throws {
        #expect(try await run("cat >/dev/null; echo '{\"outcome\":\"stale\",\"detail\":\"Rex terminal block is gone or detached.\"}'") == .stale("Rex terminal block is gone or detached."))
        #expect(try await run("cat >/dev/null; echo '{\"outcome\":\"unavailable\",\"detail\":\"Rex is not installed.\"}'") == .unavailable("Rex is not installed."))
    }

    @Test func timeoutLeavesFocusUncertain() async throws {
        let started = ContinuousClock.now
        let result = try await run("cat >/dev/null; sleep 5; echo '{\"outcome\":\"focused\",\"detail\":\"late\"}'", timeout: .milliseconds(400))
        #expect(result == .unavailable("the pane helper did not answer in time; pane focus is uncertain"))
        #expect(ContinuousClock.now - started < .seconds(3))
    }

    @Test func malformedOutputAndRefusalsAreUnavailable() async throws {
        #expect(try await run("cat >/dev/null; echo 'not json'") == .unavailable("the pane helper returned malformed output"))
        #expect(try await run("cat >/dev/null; echo '{\"outcome\":\"focused\",\"detail\":\"a\"}'; echo '{\"outcome\":\"focused\",\"detail\":\"b\"}'") == .unavailable("the pane helper returned malformed output"))
        #expect(try await run("cat >/dev/null; echo '{\"outcome\":\"elsewhere\",\"detail\":\"x\"}'") == .unavailable("the pane helper returned an unknown outcome"))
        #expect(try await run("cat >/dev/null; echo 'origin: unknown field' >&2; exit 1") == .unavailable("the pane helper refused the origin: origin: unknown field"))
    }

    @Test func missingProgramIsUnavailable() async {
        let helper = TerminalFocusHelper(node: URL(fileURLWithPath: "/nonexistent/node"), helper: URL(fileURLWithPath: "/nonexistent/helper.ts"))
        guard case .unavailable = await helper.focus(Self.origin) else {
            Issue.record("expected unavailable")
            return
        }
    }
}
