import Foundation
import Testing
@testable import Composer

@Suite struct ComposerTransportTests {
    private let composer = "ABCDEF01-2345-6789-ABCD-EF0123456789"

    @Test func noticeFieldsCarryBridgeSeverityToThePage() {
        #expect(composerNoticeFields(["level": "error", "text": "Pi rejected the submission."])
                == ["tone": "failure", "text": "Pi rejected the submission."])
        #expect(composerNoticeFields(["level": "warning", "text": "Retry later."])?["tone"] == "warn")
        #expect(composerNoticeFields(["level": "info", "text": "Saved."])?["tone"] == "info")
        #expect(composerNoticeFields(["level": "error", "text": ""]) == nil)
    }

    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("composer-transport-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func valid(version: Int = 1, composer: String? = nil, endpoint: String = "http://127.0.0.1:43210",
                       token: String = String(repeating: "a", count: 64), pid: Int32 = 1234) -> [String: Any] {
        ["version": version, "composer": composer ?? self.composer, "endpoint": endpoint,
         "token": token, "pid": Int(pid), "share": 0.2]
    }

    @discardableResult
    private func write(_ value: [String: Any], to url: URL) throws -> URL {
        try JSONSerialization.data(withJSONObject: value).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return url
    }

    @Test func consumeAcceptsAPrivateAbsoluteConfigurationOnce() throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("composer.json")
        try write(valid(), to: file)

        let value = try ComposerConfiguration.consume(file)
        #expect(value.version == 1)
        #expect(value.composer == composer)
        #expect(value.endpoint == "http://127.0.0.1:43210")
        #expect(value.token == String(repeating: "a", count: 64))
        #expect(value.pid == 1234)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(throws: ComposerTransportError.self) { try ComposerConfiguration.consume(file) }
    }

    @Test func consumeRejectsInvalidValuesWithoutUnlinking() throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("composer.json")

        func reject(_ value: [String: Any]) throws {
            try write(value, to: file)
            #expect(throws: ComposerTransportError.self) { try ComposerConfiguration.consume(file) }
            #expect(FileManager.default.fileExists(atPath: file.path))
        }

        for endpoint in ["http://example.com:43210", "https://127.0.0.1:43210", "http://127.0.0.2:43210",
                         "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:043210",
                         "http://127.0.0.1:43210/path", "http://127.0.0.1:43210?query", "localhost:43210"] {
            try reject(valid(endpoint: endpoint))
        }
        try reject(valid(version: 2))
        try reject(valid(composer: "not-a-uuid"))
        try reject(valid(pid: 0))
        try reject(valid(pid: -1))
        try reject(valid(token: String(repeating: "A", count: 64)))
        try reject(valid(token: String(repeating: "a", count: 63)))
        try reject(valid(token: String(repeating: "g", count: 64)))

        try write(valid(), to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        #expect(throws: ComposerTransportError.self) { try ComposerConfiguration.consume(file) }
        #expect(FileManager.default.fileExists(atPath: file.path))
    }

    @Test func consumeRejectsNonFilesSymlinksAndOversizedBytes() throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("composer.json")

        #expect(throws: ComposerTransportError.self) {
            try ComposerConfiguration.consume(URL(string: "https://example.com/composer.json")!)
        }

        let target = root.appendingPathComponent("target.json")
        try write(valid(), to: target)
        let link = root.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        #expect(throws: ComposerTransportError.self) { try ComposerConfiguration.consume(link) }
        #expect(FileManager.default.fileExists(atPath: target.path))
        #expect(FileManager.default.fileExists(atPath: link.path))

        var data = try JSONSerialization.data(withJSONObject: valid())
        data.append(0x78)
        try data.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        #expect(throws: ComposerTransportError.self) { try ComposerConfiguration.consume(file) }
        #expect(FileManager.default.fileExists(atPath: file.path))

        let oversized = try JSONSerialization.data(withJSONObject: valid()) + Data(repeating: 0x20, count: 16385)
        try oversized.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        #expect(throws: ComposerTransportError.self) { try ComposerConfiguration.consume(file) }
        #expect(FileManager.default.fileExists(atPath: file.path))
    }

    @Test func expectedComposerUsesExactCaseAndPreservesTheWireString() throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("composer.json")
        try write(valid(composer: composer), to: file)

        #expect(throws: ComposerTransportError.self) {
            try ComposerConfiguration.consume(file, expectedComposer: composer.lowercased())
        }
        #expect(FileManager.default.fileExists(atPath: file.path))

        let value = try ComposerConfiguration.consume(file, expectedComposer: composer)
        #expect(value.composer == composer)
    }

    @Test func requestBodyCarriesComposerIdentityWithoutOrigin() throws {
        let configuration = ComposerConfiguration(version: 1, composer: composer,
            endpoint: "http://127.0.0.1:43210", token: String(repeating: "a", count: 64), pid: 4321, share: 0.2)
        let data = try ComposerTransport.encodedBody(["requestId": "request", "origin": "elsewhere"],
            configuration: configuration)
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["composer"] as? String == composer)
        #expect(body["pid"] == nil)
        #expect(body["requestId"] as? String == "request")
        #expect(body["origin"] == nil)
    }

    @Test func requestBodyIsCappedAtFourMiB() throws {
        let configuration = ComposerConfiguration(version: 1, composer: composer,
            endpoint: "http://127.0.0.1:43210", token: String(repeating: "a", count: 64), pid: 4321, share: 0.2)
        #expect(throws: ComposerTransportError.self) {
            try ComposerTransport.encodedBody(["value": String(repeating: "a", count: 4 * 1024 * 1024)],
                configuration: configuration)
        }
    }

    @Test func responseDecodingAcceptsOnlyExplicitSuccessAndMapsRefusal() throws {
        let accepted = try ComposerTransport.decodeResponse(status: 200,
            data: Data(#"{"ok":true,"value":7}"#.utf8))
        #expect((accepted["value"] as? NSNumber)?.intValue == 7)

        for (status, raw) in [(200, #"{"ok":false}"#), (200, #"{"ok":1}"#),
                              (409, #"{"ok":true}"#), (409, #"{"ok":0,"error":"closed"}"#),
                              (500, #"{"ok":true}"#), (200, "not json"), (200, "[]")] {
            #expect(throws: ComposerTransportError.self) {
                try ComposerTransport.decodeResponse(status: status, data: Data(raw.utf8))
            }
        }

        do {
            _ = try ComposerTransport.decodeResponse(status: 409,
                data: Data(#"{"ok":false,"error":"thread closed"}"#.utf8))
            Issue.record("A refusal response was accepted.")
        } catch let error as ComposerTransportError {
            #expect(error == .refused("thread closed"))
            #expect(!String(describing: error).contains(String(repeating: "a", count: 64)))
        } catch {
            Issue.record("The refusal became an unexpected error: \(error)")
        }
    }
}
