import Testing
import EditorFeature
@testable import MarkdownCore
@testable import MarkdownReader

@Suite struct EditorLaunchInput {
    @Test func editorArgumentsAreExplicitAndBounded() throws {
        let scratch = try EditorLaunch.parse(["--surface", "pane", "--store", "/store", "--intent", "scratchpad"])
        #expect(scratch.surface == .pane)
        #expect(scratch.intent == .scratchpad)
        #expect(scratch.input == nil)
        #expect(throws: (any Error).self) { try EditorLaunch.parse(["--surface", "pane", "--store", "relative", "--intent", "scratchpad"]) }
        #expect(throws: (any Error).self) { try EditorLaunch.parse(["--surface", "pane", "--store", "/store", "--intent", "scratchpad", "/unexpected"]) }
        #expect(throws: (any Error).self) { try EditorLaunch.parse(["--surface", "pane", "--surface", "window", "--store", "/store", "--intent", "scratchpad"]) }
        #expect(throws: (any Error).self) { try EditorLaunch.parse(["--surface", "pane", "--store", "/store", "--intent", "edit"]) }
        let origin = String(decoding: try JSONEncoder().encode(LaunchOrigin(terminal: "Rex", bundleId: "com.superlogical.rex")), as: UTF8.self)
        let withOrigin = try EditorLaunch.parse(["--surface", "window", "--store", "/store", "--intent", "file", "--origin", origin, "/source.md"])
        #expect(withOrigin.origin?.isUsable == true)
        #expect(throws: (any Error).self) { try EditorLaunch.parse(["--surface", "pane", "--store", "/store", "--intent", "edit", "--origin", origin, "/request.json"]) }
    }
}

@Suite(.serialized) struct EditorPaneLifecycle {
    @Test func scratchpadPaneRetainsAnEmptyDraftBeforeExit() async throws {
        let run = try PaneRun()
        defer { run.remove() }
        let process = try run.start(arguments: ["--editor", "--surface", "pane", "--store", run.store, "--intent", "scratchpad"])
        defer { close(process.primary) }
        #expect(process.read(until: "Untitled Scratchpad", seconds: 4))
        _ = "q".withCString { Darwin.write(process.primary, $0, 1) }
        #expect(process.exit(within: 5).status == 0)
        let drafts = DraftStore(directory: run.home.appendingPathComponent("Library/Application Support/Markdown Reader/Drafts"))
        let list = try await drafts.list()
        #expect(list.records.count == 1)
        #expect(list.records.first?.source == "")
    }

    @Test func failedRecoveryKeepsPaneAliveUntilTerminalLoss() throws {
        let run = try PaneRun()
        defer { run.remove() }
        let state = run.home.appendingPathComponent("Library/Application Support/Markdown Reader")
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        try Data("blocked".utf8).write(to: state.appendingPathComponent("Drafts"))
        let process = try run.start(arguments: ["--editor", "--surface", "pane", "--store", run.store, "--intent", "scratchpad"])
        defer { close(process.primary) }
        #expect(process.read(until: "Untitled Scratchpad", seconds: 4))
        _ = "q".withCString { Darwin.write(process.primary, $0, 1) }
        #expect(process.read(until: "Draft recovery failed", seconds: 3))
        #expect(kill(process.pid, 0) == 0)
        kill(process.pid, SIGHUP)
        #expect(process.exit(within: 5).status == 1)
    }
}
