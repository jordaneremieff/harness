import Darwin
import Foundation
import Testing
@testable import Config

let fixtureToken = String(repeating: "ab", count: 32)

func withConfigFixture<T>(_ run: (URL) async throws -> T) async throws -> T {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    return try await run(root)
}

func launchFile(_ root: URL, endpoint: String = "http://127.0.0.1:57123", token: String = fixtureToken,
                mode: Int = 0o600, extra: String = "") throws -> URL {
    let url = root.appendingPathComponent(UUID().uuidString)
    var data = try JSONSerialization.data(withJSONObject: ["version": 1, "endpoint": endpoint, "token": token] as [String: Any])
    data.append(contentsOf: extra.utf8)
    try #require(FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: mode]))
    return url
}

@Test func launchFileIsConsumedOnceWithoutPrintingToken() async throws {
    try await withConfigFixture { root in
        let file = try launchFile(root)
        let results = await withTaskGroup(of: Capability?.self, returning: [Capability].self) { group in
            for _ in 0..<8 { group.addTask { try? Capability.consume(path: file.path) } }
            var values: [Capability] = []
            for await value in group { if let value { values.append(value) } }
            return values
        }
        #expect(results.count == 1)
        #expect(!String(reflecting: results).contains(fixtureToken))
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }
}

@Test(arguments: ["https://127.0.0.1:80", "http://localhost:80", "http://127.0.0.2:80", "http://127.0.0.1",
                  "http://127.0.0.1:65536", "http://127.0.0.1:80/path", "http://127.0.0.1:80?", "http://127.0.0.1:80#",
                  "http://user@127.0.0.1:80", "http://127.0.0.1:80@localhost", "http://%31%32%37.0.0.1:80"])
func launchFileRefusesNonCanonicalLoopback(endpoint: String) async throws {
    try await withConfigFixture { root in
        let file = try launchFile(root, endpoint: endpoint)
        #expect(throws: ConfigFailure.self) { try Capability.consume(path: file.path) }
        #expect(FileManager.default.fileExists(atPath: file.path))
    }
}

@Test func launchFileRefusesNonPrivateOrUnboundedInputs() async throws {
    try await withConfigFixture { root in
        let file = try launchFile(root)
        let symlink = root.appendingPathComponent("symlink")
        let fifo = root.appendingPathComponent("fifo")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: file)
        try #require(mkfifo(fifo.path, 0o600) == 0)
        let weakMode = try launchFile(root, mode: 0o640)
        let extraMode = try launchFile(root)
        try #require(chmod(extraMode.path, 0o4600) == 0)
        let oversized = try launchFile(root, extra: String(repeating: " ", count: 8192))
        let invalidToken = try launchFile(root, token: String(repeating: "x", count: 64))
        for url in [root, symlink, fifo, weakMode, extraMode, oversized, invalidToken] {
            #expect(throws: ConfigFailure.self) { try Capability.consume(path: url.path) }
            #expect(FileManager.default.fileExists(atPath: url.path))
        }
        _ = try Capability.consume(path: file.path)
    }
}
