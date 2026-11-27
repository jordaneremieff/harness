import Darwin
import Foundation
import Testing
@testable import Editor

@MainActor
struct EditorServiceTests {
    @Test(.timeLimit(.minutes(1))) func restartsOnceWithTheSameConfigAndClosesStdin() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let service = try fixture.service(script: """
            IFS= read -r config || exit 1
            printf '%s\\n' "$config" >> '\(fixture.root.path)/configs'
            printf '%s\\n' "$$" >> '\(fixture.root.path)/pids'
            \(Self.handshake)
            IFS= read -r extra && exit 2
            printf '%s\\n' "$$" >> '\(fixture.root.path)/eof'
            """)
        var states = start(service)
        defer { service.stop {} }
        try #require(await states.next(isolation: MainActor.shared) == .ready)
        let first = try #require(fixture.pids().first)
        try #require(kill(first, SIGKILL) == 0)
        try #require(await states.next(isolation: MainActor.shared) == .reconnecting)
        try #require(await states.next(isolation: MainActor.shared) == .ready)
        let pids = try fixture.pids()
        #expect(pids.count == 2)
        let second = try #require(pids.last)
        #expect(second != first)
        #expect(kill(second, 0) == 0)

        let configs = try fixture.lines("configs")
        #expect(configs.count == 2)
        let initial = try decode(try #require(configs.first))
        let replacement = try decode(try #require(configs.last))
        #expect(NSDictionary(dictionary: initial) == NSDictionary(dictionary: replacement))
        #expect(Set(initial.keys) == ["root", "agentDir", "paneId", "participant", "appPid"])
        #expect(initial["root"] as? String == fixture.root.path)
        #expect(initial["agentDir"] as? String == fixture.root.appendingPathComponent("agent").path)
        #expect(initial["paneId"] as? String == fixture.paneId)
        #expect(initial["appPid"] as? Int32 == getpid())
        #expect(initial["participant"] as? [String: String] == ["id": "test", "label": "Test", "kind": "durable"])

        await withCheckedContinuation { continuation in service.stop { continuation.resume() } }
        #expect(try fixture.lines("eof") == [String(second)])
    }

    @Test(.timeLimit(.minutes(1))) func aSecondExitDoesNotStartAnotherChild() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let service = try fixture.service(script: """
            IFS= read -r config || exit 1
            printf '%s\\n' "$$" >> '\(fixture.root.path)/pids'
            \(Self.handshake)
            IFS= read -r extra
            """)
        var states = start(service)
        defer { service.stop {} }
        for _ in 0..<2 {
            try #require(await states.next(isolation: MainActor.shared) == .ready)
            let pid = try #require(fixture.pids().last)
            try #require(kill(pid, SIGKILL) == 0)
            try #require(await states.next(isolation: MainActor.shared) == .reconnecting)
        }
        let failure = await states.next(isolation: MainActor.shared)
        #expect(failure == .failed("The workspace service stopped after its startup handshake (signal \(SIGKILL)). \(fixture.logLocation)"))
        #expect(try fixture.pids().count == 2)
        await #expect(throws: EditorIssue.self) { _ = try await service.call("state") }
    }

    @Test(.timeLimit(.minutes(1))) func neverConnectsToAnOverlongOrUnfinishedHandshake() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let service = try fixture.service(script: """
            IFS= read -r config || exit 1
            if [ ! -f '\(fixture.root.path)/pids' ]; then
                printf '%s\\n' "$$" >> '\(fixture.root.path)/pids'
                printf '%01025d' 0
            else
                printf '%s\\n' "$$" >> '\(fixture.root.path)/pids'
                printf '%s' '{"port":13451'
            fi
            IFS= read -r extra
            """, timeout: .seconds(1))
        var states = start(service)
        defer { service.stop {} }
        try #require(await states.next(isolation: MainActor.shared) == .reconnecting)
        try #require(await states.next(isolation: MainActor.shared) == .reconnecting)
        let failure = await states.next(isolation: MainActor.shared)
        #expect(failure == .failed("First attempt: The workspace service exceeded the startup handshake size limit. The workspace service did not return its startup handshake in time. \(fixture.logLocation)"))
        #expect(try fixture.pids().count == 2)
    }

    @Test(.timeLimit(.minutes(1))) func failureNamesTheBoundedPrivateLogWithoutEchoingStderr() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let service = try fixture.service(script: """
            printf '%s' 'private detail' >&2
            printf '%0131072d' 0 >&2
            exit 23
            """)
        var states = start(service)
        defer { service.stop {} }
        try #require(await states.next(isolation: MainActor.shared) == .reconnecting)
        try #require(await states.next(isolation: MainActor.shared) == .reconnecting)
        #expect(await states.next(isolation: MainActor.shared) == .failed("The workspace service stopped before its startup handshake (exit status 23). \(fixture.logLocation)"))
        let bytes = try Data(contentsOf: fixture.logURL)
        #expect(bytes.count == 128 * 1024)
        #expect(bytes.prefix(14) == Data("private detail".utf8))
        #expect(bytes.dropFirst(64 * 1024).prefix(14) == Data("private detail".utf8))
        let info = try FileManager.default.attributesOfItem(atPath: fixture.logURL.path)
        #expect(info[.posixPermissions] as? Int == 0o600)
    }

    @Test(.timeLimit(.minutes(1))) func reportsMissingNodeExecutableWithoutItsPath() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let service = try fixture.service(script: "", node: fixture.root.appendingPathComponent("missing-node").path)
        var states = start(service)
        defer { service.stop {} }
        #expect(await states.next(isolation: MainActor.shared) == .failed("Editor could not run the Node executable: the executable was not found. \(fixture.logLocation)"))
    }

    @Test func serviceLogDoesNotFollowAnExistingLink() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let manager = FileManager.default
        try manager.createDirectory(at: fixture.logURL.deletingLastPathComponent(), withIntermediateDirectories: false,
                                    attributes: [.posixPermissions: 0o700])
        let decoy = fixture.root.appendingPathComponent("decoy")
        try "untouched".write(to: decoy, atomically: false, encoding: .utf8)
        try manager.createSymbolicLink(at: fixture.logURL, withDestinationURL: decoy)
        let log = EditorServiceLog(workspace: fixture.root, paneId: fixture.paneId)
        log.append(Array("diagnostic".utf8)[...])
        #expect(log.location().contains("could not write"))
        #expect(try String(contentsOf: decoy, encoding: .utf8) == "untouched")
    }

    @Test func publishesOnePrivateBoundedLineWithoutFollowingLinks() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let ticket = fixture.root.appendingPathComponent("request").path
        let report = EditorStartupReport(ticketPath: ticket)
        let destination = URL(fileURLWithPath: ticket + ".failure")
        let decoy = fixture.root.appendingPathComponent("decoy")
        let manager = FileManager.default
        try "untouched".write(to: decoy, atomically: false, encoding: .utf8)
        try manager.createSymbolicLink(at: destination, withDestinationURL: decoy)
        report.write("Blocked")
        #expect(try String(contentsOf: decoy, encoding: .utf8) == "untouched")
        try manager.removeItem(at: destination)

        report.write("Load failed.\n\(String(repeating: "🚫", count: 300))")
        let bytes = try Data(contentsOf: destination)
        let line = try #require(String(data: bytes, encoding: .utf8))
        #expect(bytes.count <= 1024)
        #expect(line.hasPrefix("Load failed. 🚫"))
        #expect(line.last == "\n")
        #expect(bytes.filter { $0 == 10 }.count == 1)
        let info = try manager.attributesOfItem(atPath: destination.path)
        #expect(info[.posixPermissions] as? Int == 0o600)
        report.write("Replacement")
        #expect(try Data(contentsOf: destination) == bytes)
    }

    private static let handshake = "printf '%s\\n' '{\"port\":13451,\"token\":\"\(String(repeating: "a", count: 64))\"}'"

    private func start(_ service: EditorService) -> AsyncStream<EditorService.Status>.AsyncIterator {
        let (stream, continuation) = AsyncStream<EditorService.Status>.makeStream()
        service.onStatus = { _ = continuation.yield($0) }
        service.start()
        return stream.makeAsyncIterator()
    }

    private func decode(_ config: String) throws -> Fields {
        try #require(JSONSerialization.jsonObject(with: Data(config.utf8)) as? Fields)
    }

    private struct Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let paneId = UUID().uuidString
        var logURL: URL { root.appendingPathComponent("panes").appendingPathComponent("\(paneId).stderr.log") }
        var logLocation: String { "Service log: \(logURL.path)" }

        init() throws {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
        }

        func remove() { try? FileManager.default.removeItem(at: root) }

        func lines(_ name: String) throws -> [String] {
            try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
                .split(separator: "\n").map(String.init)
        }

        func pids() throws -> [pid_t] { try lines("pids").compactMap { pid_t($0) } }

        @MainActor
        func service(script: String, timeout: Duration = .seconds(10), node: String = "/bin/sh") throws -> EditorService {
            let program = root.appendingPathComponent("service.sh")
            try script.write(to: program, atomically: false, encoding: .utf8)
            let ticket = EditorTicket(version: 2, node: node, program: program.path, paneId: paneId,
                                      root: root.path, agentDir: root.appendingPathComponent("agent").path,
                                      participant: .init(id: "test", label: "Test", kind: .durable),
                                      file: nil, settings: nil, layout: nil)
            return EditorService(ticket: ticket, workspace: root, startupTimeout: timeout)
        }
    }
}
