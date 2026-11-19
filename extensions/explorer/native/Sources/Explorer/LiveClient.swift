import Darwin
import Foundation

struct LiveConfiguration: Decodable, Sendable {
    let version: Int
    let endpoint: URL
    let token: String

    static func consume(_ path: String) throws -> Self {
        let unavailable = ExplorerError("unavailable", "The live connection file is missing, reused, or not private.")
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw unavailable }
        let fd = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw unavailable }
        let stream = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? stream.close() }
        var info = stat(), current = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o777 == 0o600,
              info.st_size <= 8192, let bytes = try stream.read(upToCount: 8193), bytes.count == info.st_size,
              let value = try? JSONDecoder().decode(Self.self, from: bytes), value.version == 1,
              value.endpoint.scheme == "http", value.endpoint.host == "127.0.0.1", (1...65535).contains(value.endpoint.port ?? 0),
              value.endpoint.user == nil, value.endpoint.password == nil, value.endpoint.query == nil, value.endpoint.fragment == nil,
              value.endpoint.path.isEmpty || value.endpoint.path == "/", value.token.utf8.count == 64,
              value.token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              lstat(path, &current) == 0, current.st_dev == info.st_dev, current.st_ino == info.st_ino, current.st_mode == info.st_mode,
              current.st_uid == info.st_uid, current.st_size == info.st_size, current.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec,
              current.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec, unlink(path) == 0 else { throw unavailable }
        return value
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class LiveClient {
    var emit: ((String, [String: Any]) async -> Void)?
    var navigate: (([String: Any]) async throws -> Void)?
    private let configuration: LiveConfiguration
    private let session: URLSession
    private let workspace = UUID().uuidString.lowercased()
    private let document = UUID().uuidString.lowercased()
    private var job: Task<Void, Never>?
    private var label: String?
    private var reason = "Connecting to Pi."
    private var closing = false
    private var sequence = 0

    init(_ configuration: LiveConfiguration) {
        self.configuration = configuration
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForResource = 35
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }

    var info: [String: Any] {
        if let label { return ["connected": true, "label": label] }
        return ["connected": false, "reason": reason]
    }

    func start() {
        guard job == nil else { return }
        job = Task { [weak self] in await self?.run() }
    }

    private func run() async {
        do {
            let reply = try await post("connect", ["version": 1, "navigate": 1], timeout: 5)
            guard let name = reply["label"] as? String, let handle = reply["handle"] as? String, !handle.isEmpty else {
                throw ExplorerError("unavailable", "Pi did not accept this Explorer connection.")
            }
            label = name
            await emit?("live", info)
            while !Task.isCancelled, !closing {
                let start = ProcessInfo.processInfo.systemUptime
                let result = try await post("poll", ["after": sequence], timeout: 31)
                try Task.checkCancellation()
                if let state = result["state"] as? [String: Any], let next = state["sequence"] as? Int, next > sequence {
                    sequence = next
                    if let status = state["status"] as? String, ["queued", "working", "answer", "error"].contains(status),
                       let id = state["requestId"] as? String, UUID(uuidString: id) != nil,
                       let thread = state["threadId"] as? String, UUID(uuidString: thread) != nil,
                       let text = state["text"] as? String, let truncated = state["truncated"] as? Bool {
                        await emit?("promptState", ["requestId": id, "threadId": thread, "sequence": next,
                                                     "status": status, "text": text, "truncated": truncated])
                    }
                }
                if let command = result["command"] as? [String: Any], let id = command["requestId"] as? String {
                    var receipt = ["status": "ok"]
                    do {
                        guard command["workspace"] as? String == workspace, command["document"] as? String == document,
                              command["op"] as? String == "navigate", let target = command["target"] as? [String: Any], let navigate else {
                            throw ExplorerError("invalid", "Pi sent an invalid Explorer location.")
                        }
                        try await navigate(target)
                    } catch { receipt = ["status": "error", "message": error.localizedDescription] }
                    _ = try await post("result", ["requestId": id, "result": receipt], timeout: 5)
                } else if ProcessInfo.processInfo.systemUptime - start < 0.15 {
                    // A host with an immediate poll response must not create a busy loop.
                    try await Task.sleep(for: .milliseconds(150))
                }
            }
        } catch {
            guard !closing else { return }
            label = nil
            reason = "The Pi conversation no longer accepts requests from this pane."
            await emit?("live", info)
        }
    }

    func submit(_ fields: [String: Any]) async throws -> [String: Any] {
        guard !closing, let label else { throw ExplorerError("unavailable", reason) }
        _ = label
        guard let id = fields["requestId"] as? String, UUID(uuidString: id) != nil,
              let thread = fields["threadId"] as? String, UUID(uuidString: thread) != nil,
              let text = fields["text"] as? String, text.utf8.count <= 128 * kib,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ExplorerError("rejected", "A valid request, thread and message of at most 128 KiB are required.")
        }
        var body: [String: Any] = ["requestId": id, "threadId": thread, "text": text]
        if let notes = fields["noteIds"] {
            guard let ids = notes as? [String], ids.allSatisfy({ $0.range(of: #"^n-[a-f0-9]{20}$"#, options: .regularExpression) != nil }) else {
                throw ExplorerError("rejected", "A note identifier is invalid.")
            }
            body["noteIds"] = ids
        }
        let receipt: [String: Any]
        do { receipt = try await post("prompt", body, timeout: 12) }
        catch let problem as ExplorerError where problem.code == "unavailable" || problem.code == "rejected" { throw problem }
        catch { throw ExplorerError("uncertain", "Pi did not confirm the request. Retry with the same request ID.", retryable: true) }
        switch receipt["status"] as? String {
        case "admitted": return ["status": "admitted"]
        case "requested": return ["status": "requested"]
        case "uncertain": throw ExplorerError("uncertain", receipt["message"] as? String ?? "Pi did not confirm the request.", retryable: receipt["retryable"] as? Bool ?? false)
        case "rejected": throw ExplorerError("rejected", receipt["message"] as? String ?? "Pi refused the request.")
        default: throw ExplorerError("uncertain", "Pi returned an unknown receipt.", retryable: true)
        }
    }

    func stop() {
        guard !closing else { return }
        closing = true
        job?.cancel(); job = nil
        Task {
            _ = try? await post("close", [:], timeout: 1)
            session.invalidateAndCancel()
        }
    }

    private func post(_ route: String, _ fields: [String: Any], timeout: TimeInterval) async throws -> [String: Any] {
        var request = URLRequest(url: configuration.endpoint.appendingPathComponent(route), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        let body = try JSONSerialization.data(withJSONObject: fields.merging(["workspace": workspace, "document": document]) { _, second in second })
        guard body.count <= mib else { throw ExplorerError("rejected", "The message exceeds the Pi connection limit.") }
        request.httpBody = body
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...499).contains(http.statusCode),
              response.expectedContentLength <= mib else { throw ExplorerError("uncertain", "The Pi response was invalid.") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < mib else { throw ExplorerError("uncertain", "The Pi response exceeded its size limit.") }
            data.append(byte)
        }
        guard let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ExplorerError("uncertain", "The Pi response was invalid.") }
        guard http.statusCode == 200, reply["ok"] as? Bool == true else {
            let code = [401, 403, 404, 410].contains(http.statusCode) ? "unavailable" : "rejected"
            throw ExplorerError(code, reply["error"] as? String ?? "The Pi connection refused this request.")
        }
        return reply
    }
}
