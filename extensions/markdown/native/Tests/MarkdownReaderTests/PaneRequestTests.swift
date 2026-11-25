import Testing
import CryptoKit
@testable import MarkdownCore
@testable import MarkdownReader

struct PaneLaunchInput {
    @Test func acceptsTheExistingDocumentAndPinnedRequestInputs() {
        guard case .pane(.document(let store, let document, nil)) = LaunchMode.parse(["--pane", "--store", "/store", "md-0123456789abcdef0123"]) else {
            Issue.record("The store/document input was not parsed")
            return
        }
        #expect(store == "/store" && document == "md-0123456789abcdef0123")
        let request = "/store/opens/selected.json"
        let mode = LaunchMode.parse(["--pane", request])
        guard case .pane(.request(let path)) = mode else {
            Issue.record("The pinned request input was not parsed")
            return
        }
        #expect(path == request && mode.isAccessory && !mode.isCheck)
        for words in [["--pane"], ["--pane", "--store"], ["--pane", "a.json", "b.json"], ["--pane", "--unknown", "a.json"]] {
            guard case .usage = LaunchMode.parse(words) else {
                Issue.record("Ambiguous pane input was accepted: \(words)")
                continue
            }
        }
    }

    @Test func acceptsDirectRevisionAndLiveConfigurationTogether() {
        let digest = "sha256:" + String(repeating: "a", count: 64)
        let words = ["--pane", "--store", "/store", "md-0123456789abcdef0123"]
        let launch = NativeLaunch.parse(words + ["--revision", "2", "--digest", digest, "--live", "/private/live.json"])
        guard case .pane(.document(let store, let document, let pin?)) = launch.mode else {
            Issue.record("The direct revision input was not parsed")
            return
        }
        #expect(store == "/store" && document == "md-0123456789abcdef0123")
        #expect(pin.revision == 2 && pin.digest == digest)
        #expect(launch.livePath == "/private/live.json")
        for extra in [["--revision", "2"], ["--digest", digest], ["--revision", "0", "--digest", digest],
                      ["--revision", "2", "--digest", "wrong"], ["--revision", "2", "--revision", "1", "--digest", digest]] {
            guard case .usage = LaunchMode.parse(words + extra) else {
                Issue.record("Incomplete or invalid revision selection was accepted: \(extra)")
                continue
            }
        }
    }
}

@Suite(.serialized) @MainActor struct PanePinnedRequest {
    private func write(_ value: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    }

    private func newerPointer(_ run: PaneRun, number: Int = 2, document: String? = nil) throws {
        let document = document ?? run.document
        let store = URL(fileURLWithPath: run.store)
        let revision = store.appendingPathComponent("documents/\(document)/revisions/\(number)")
        try FileManager.default.createDirectory(at: revision, withIntermediateDirectories: true)
        let source = Data("# New pointer\n\nThe current revision is newer than the selected revision.\n".utf8)
        let digest = "sha256:" + SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        try source.write(to: revision.appendingPathComponent("source.md"))
        let date = "2026-11-15T00:00:00Z"
        try write(["version": 1, "document": document, "revision": number, "title": "New pointer", "createdAt": date,
                   "digest": digest, "bytes": source.count, "completeness": ["state": "complete"]],
                  to: revision.appendingPathComponent("revision.json"))
        try write(["version": 1, "id": document, "kind": "published", "title": "New pointer", "createdAt": date,
                   "updatedAt": date, "revision": number, "digest": digest, "bytes": source.count],
                  to: store.appendingPathComponent("documents/\(document)/document.json"))
    }

    private func request(_ run: PaneRun, invalid: String? = nil) throws -> URL {
        let store = try DirectoryStore(root: URL(fileURLWithPath: run.store))
        let old = try store.loadRevision(run.document, revision: 1)
        let request = OpenRequest(storeId: invalid == "store" ? String(repeating: "f", count: 32) : store.storeId,
                                  document: run.document, revision: invalid == "revision" ? 9 : 1,
                                  digest: invalid == "digest" ? "sha256:" + String(repeating: "0", count: 64) : old.record.digest)
        let opens = store.root.appendingPathComponent("opens")
        try FileManager.default.createDirectory(at: opens, withIntermediateDirectories: true)
        let file = opens.appendingPathComponent("selected.json")
        try JSONEncoder().encode(request).write(to: file)
        return file
    }

    private func type(_ text: String, into process: PaneRun.Process) {
        _ = text.withCString { Darwin.write(process.primary, $0, strlen($0)) }
    }

    @Test(arguments: [false, true])
    func aPinnedLaunchShowsTheOlderRevisionUntilAnExplicitOpenSelectsLatest(_ direct: Bool) throws {
        let run = try PaneRun()
        defer { run.remove() }
        try newerPointer(run)
        let file = direct ? nil : try request(run)
        let arguments: [String]
        if let file {
            #expect(FileManager.default.fileExists(atPath: file.path))
            arguments = ["--pane", file.path]
        } else {
            let store = try DirectoryStore(root: URL(fileURLWithPath: run.store))
            let digest = try store.loadRevision(run.document, revision: 1).record.digest
            arguments = ["--pane", "--store", run.store, run.document, "--revision", "1", "--digest", digest]
        }
        let process = try run.start(arguments: arguments)
        defer { close(process.primary) }
        #expect(process.read(until: "\(run.document) · revision 1; revision 2 is available", seconds: 15), "placeholder: \(process.text)")
        if let file { #expect(!FileManager.default.fileExists(atPath: file.path), "only a validated request is consumed") }
        #expect(!process.read(until: "revision 2 of 2", seconds: 0.5), "a pinned open does not follow the newer pointer")
        type(":open \(run.document)\r", into: process)
        #expect(process.read(until: "\(run.document) · revision 2 of 2", seconds: 10))
        #expect(process.read(until: "New pointer", seconds: 5))
        type("q", into: process)
        #expect(process.exit(within: 5).status == 0)
    }

    private func awaitBridge(_ server: LiveTestBridge, until matches: ([String: Any]) -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(8)
        repeat {
            if matches(try await server.request(["op": "state"])) { return }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        throw LiveTestBridge.Failure.deadline
    }

    private func confirmedView(_ server: LiveTestBridge, document: String, revision: Int, follows: Bool) async throws {
        try await awaitBridge(server) { state in
            guard let view = state["view"] as? [String: Any] else { return false }
            return view["kind"] as? String == "published" && view["documentId"] as? String == document &&
                view["revision"] as? Int == revision && view["follows"] as? Bool == follows && view["mode"] as? String == "reading"
        }
    }

    @Test(arguments: [false, true])
    func liveConfiguredPaneOpenTracksTheShownDocumentAndLaterRevision(_ anotherDocument: Bool) async throws {
        let run = try PaneRun()
        defer { run.remove() }
        try newerPointer(run)
        let target = anotherDocument ? "md-abcdef0123456789abcd" : run.document
        if anotherDocument { try newerPointer(run, number: 1, document: target) }
        let selected = anotherDocument ? 1 : 2
        let file = try request(run)
        let server = try LiveTestBridge(); defer { server.stop() }
        let configuration = try await server.configurationFile()
        let process = try run.start(arguments: ["--pane", file.path, "--live", configuration.path])
        defer { close(process.primary) }
        try await confirmedView(server, document: run.document, revision: 1, follows: false)
        #expect(process.read(until: "\(run.document) · revision 1; revision 2 is available", seconds: 15), "placeholder: \(process.text)")
        #expect(!FileManager.default.fileExists(atPath: configuration.path))
        type(":open \(target)\r", into: process)
        #expect(process.read(until: "\(target) · revision \(selected) of \(selected)", seconds: 15), "placeholder: \(process.text)")
        try await confirmedView(server, document: target, revision: selected, follows: true)
        try newerPointer(run, number: selected + 1, document: target)
        #expect(process.read(until: "\(target) · revision \(selected + 1) of \(selected + 1)", seconds: 15), "placeholder: \(process.text)")
        try await confirmedView(server, document: target, revision: selected + 1, follows: true)
        type("q", into: process)
        #expect(process.exit(within: 5).status == 0)
        try await awaitBridge(server) { state in
            let departure = (state["departed"] as? [[String: Any]])?.first
            let last = (departure?["lastPane"] as? [String: Any])?["view"] as? [String: Any]
            return state["view"] == nil && departure?["reason"] as? String == "reader-closed" &&
                last?["documentId"] as? String == target && last?["revision"] as? Int == selected + 1
        }
    }

    @Test(arguments: ["expired", "invalid"])
    func anExpiredOrInvalidLiveLaunchRefusesBeforeItChangesTheTerminal(_ failure: String) async throws {
        let run = try PaneRun(); defer { run.remove() }
        let server = try LiveTestBridge(); defer { server.stop() }
        let config = try await server.configurationFile()
        if failure == "expired" {
            let expiry = try await server.request(["op": "expireOffer"])
            #expect((expiry["pending"] as? [Any])?.isEmpty == true)
            #expect(!FileManager.default.fileExists(atPath: config.path))
        } else {
            try Data("{}".utf8).write(to: config)
        }
        let open = try request(run)
        let process = try run.start(arguments: ["--pane", open.path, "--live", config.path])
        defer { close(process.primary) }
        #expect(process.exit(within: 10).status == 1)
        #expect(process.text.contains("Request a new reader launch from the original Pi conversation"))
        #expect(!process.text.contains("\u{1B}[?1049h"))
        #expect(FileManager.default.fileExists(atPath: open.path))
        let state = try await server.request(["op": "state"])
        #expect(state["view"] == nil)
        if failure == "expired" {
            let failures = try #require(state["failed"] as? [[String: Any]])
            #expect(failures.first?["reason"] as? String == "offer-expired")
        }
    }

    @Test func aLiveBootFailureReportsFailureWithoutAClosedView() async throws {
        let run = try PaneRun(); defer { run.remove() }
        let server = try LiveTestBridge(); defer { server.stop() }
        let config = try await server.configurationFile()
        let open = try request(run, invalid: "revision")
        let process = try run.start(arguments: ["--pane", open.path, "--live", config.path])
        defer { close(process.primary) }
        #expect(process.exit(within: 10).status == 1)
        #expect(process.text.contains("cannot be shown"))
        #expect(!process.text.contains("\u{1B}[?1049h"))
        let state = try await server.request(["op": "state"])
        let failures = try #require(state["failed"] as? [[String: Any]])
        #expect(failures.first?["reason"] as? String == "boot-failed")
        #expect(failures.first?["pid"] as? Int32 == process.pid)
        #expect(state["view"] == nil && (state["departed"] as? [Any])?.isEmpty == true)
    }

    @Test func aDirectLaunchWithTheWrongDigestFailsBeforeItChangesTheTerminal() throws {
        let run = try PaneRun()
        defer { run.remove() }
        let digest = "sha256:" + String(repeating: "0", count: 64)
        let process = try run.start(arguments: ["--pane", "--store", run.store, run.document, "--revision", "1", "--digest", digest])
        defer { close(process.primary) }
        #expect(process.exit(within: 10).status == 1)
        #expect(process.text.contains("does not match the supplied digest"))
        #expect(!process.text.contains("\u{1B}[?1049h"))
    }

    @Test(arguments: ["digest", "store", "revision"])
    func anInvalidPinnedRequestIsNotConsumed(_ invalid: String) throws {
        let run = try PaneRun()
        defer { run.remove() }
        try newerPointer(run)
        let file = try request(run, invalid: invalid)
        let process = try run.start(arguments: ["--pane", file.path])
        defer { close(process.primary) }
        #expect(process.exit(within: 10).status == 1)
        #expect(process.text.contains("cannot be shown"))
        #expect(FileManager.default.fileExists(atPath: file.path))
        #expect(!process.text.contains("\u{1B}[?1049h"), "refusal occurs before the terminal changes")
    }
}
