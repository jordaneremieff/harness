import Foundation
import Network
import Testing
@testable import Config

@Test func transportPostsOnlyFixedRoutesWithOneClientID() async throws {
    try await withConfigFixture { root in
        let server = try await HTTPFixture { _, bytes in
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n" + String(decoding: bytes, as: UTF8.self)
        }
        defer { server.stop() }
        let bridge = try Transport(capability: Capability.consume(path: launchFile(root, endpoint: server.endpoint).path))
        var ids = Set<String>()
        for route in Route.allCases {
            let result = try await bridge.post(route, Data(#"{"client":"forged","version":1}"#.utf8))
            let reply = try #require(JSONSerialization.jsonObject(with: result) as? [String: Any])
            let id = try #require(reply["client"] as? String)
            #expect(UUID(uuidString: id) != nil)
            #expect(reply["version"] as? Int == 1)
            ids.insert(id)
        }
        #expect(ids.count == 1)
        let requests = server.requests()
        #expect(requests.count == 7)
        for (headers, path) in zip(requests, ["/connect", "/poll", "/catalogue", "/edit", "/tools", "/tools/apply", "/close"]) {
            #expect(headers.hasPrefix("post \(path) http/1.1\r\n"))
            #expect(headers.contains("\r\nauthorization: bearer \(fixtureToken)"))
            #expect(headers.contains("\r\ncontent-type: application/json"))
            #expect(headers.contains("\r\nhost: 127.0.0.1:"))
            #expect(!headers.contains("\r\norigin:"))
        }
    }
}

@Test func transportRefusesRedirectsAndBoundsRequestsAndReplies() async throws {
    try await withConfigFixture { root in
        let server = try await HTTPFixture { headers, _ in
            if headers.hasPrefix("post /connect ") {
                return "HTTP/1.1 307 Temporary Redirect\r\nLocation: /unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            }
            return "HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n"
        }
        defer { server.stop() }
        let bridge = try Transport(capability: Capability.consume(path: launchFile(root, endpoint: server.endpoint).path))
        await #expect(throws: ConfigFailure.self) { try await bridge.post(.edit, Data(repeating: 0x20, count: 1_048_577)) }
        let withinLimit = Data(("{\"test\":\"" + String(repeating: "a", count: 1_048_565) + "\"}").utf8)
        #expect(withinLimit.count == 1_048_576)
        await #expect(throws: ConfigFailure.self) { try await bridge.post(.edit, withinLimit) }
        await #expect(throws: ConfigFailure.self) { try await bridge.post(.edit, Data("[]".utf8)) }
        #expect(server.requests().isEmpty)
        for route in [Route.connect, .catalogue] {
            await #expect(throws: ConfigFailure.self) { try await bridge.post(route, Data("{}".utf8)) }
        }
        #expect(server.requests().count == 2)
        #expect(!server.requests().contains { $0.contains("/unexpected") })
    }
}

private final class HTTPFixture: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "config.test.http")
    private let response: @Sendable (String, Data) -> String
    // Access only on queue.
    private var headers: [String] = []
    private(set) var endpoint = ""

    init(response: @escaping @Sendable (String, Data) -> String) async throws {
        self.response = response
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: queue)
            receive(connection, data: Data())
        }
        let port: NWEndpoint.Port = try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    if let port = listener.port { continuation.resume(returning: port) }
                    else { continuation.resume(throwing: ConfigFailure("No fixture port.")) }
                case .failed(let error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
        endpoint = "http://127.0.0.1:\(port.rawValue)"
    }

    func stop() { listener.cancel() }
    func requests() -> [String] { queue.sync { headers } }

    private func receive(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [self] chunk, _, complete, error in
            let bytes = data + (chunk ?? Data())
            if let boundary = bytes.range(of: Data("\r\n\r\n".utf8)) {
                let header = String(decoding: bytes[..<boundary.lowerBound], as: UTF8.self).lowercased()
                let length = header.components(separatedBy: "\r\n").first { $0.hasPrefix("content-length: ") }
                    .flatMap { Int($0.dropFirst("content-length: ".count)) } ?? 0
                let body = bytes[boundary.upperBound...]
                if body.count >= length {
                    headers.append(header)
                    connection.send(content: Data(response(header, Data(body.prefix(length))).utf8),
                                    contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
                    return
                }
            }
            if complete || error != nil || bytes.count >= 8192 { connection.cancel() }
            else { receive(connection, data: bytes) }
        }
    }
}
