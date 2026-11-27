import Darwin
import Foundation

typealias Fields = [String: Any]

struct EditorIssue: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

@MainActor
protocol EditorAPI: AnyObject {
    func call(_ op: String, _ fields: Fields) async throws -> Fields
}

extension EditorAPI {
    func call(_ op: String) async throws -> Fields { try await call(op, [:]) }
}

struct EditorTicket: Decodable {
    struct Participant: Codable {
        enum Kind: String, Codable { case ordinary, durable }
        let id: String
        let label: String
        let kind: Kind

        var isValid: Bool {
            [id, label].allSatisfy { value in
                (1...256).contains(value.utf16.count) &&
                    !value.utf16.contains { $0 < 32 || $0 == 127 }
            }
        }
    }

    let version: Int
    let node: String
    let program: String
    let paneId: String
    let root: String
    let agentDir: String
    let participant: Participant
    let file: String?
    /// The machine's Editor settings file, which this app owns.
    let settings: String?
    /// The arrangement file of this folder's workspace, which this app owns.
    let layout: String?

    static func consume(_ path: String) throws -> Self {
        let invalid = EditorIssue(code: "launch", message: "This pane needs a new private launch request from /editor.")
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw invalid }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_nlink == 1,
              (1...32768).contains(info.st_size) else { throw invalid }
        guard let data = try handle.read(upToCount: 32769), data.count == info.st_size,
              let ticket = try? JSONDecoder().decode(Self.self, from: data), ticket.version == 2,
              UUID(uuidString: ticket.paneId) != nil, ticket.participant.isValid,
              [ticket.node, ticket.program, ticket.root, ticket.agentDir]
                  .allSatisfy({ isAbsolutePath($0) && $0.utf16.count <= 4096 }),
              [ticket.settings, ticket.layout].compactMap({ $0 }).allSatisfy(isAbsolutePath)
        else { throw invalid }
        var current = stat()
        guard lstat(path, &current) == 0, current.st_ino == info.st_ino, current.st_dev == info.st_dev,
              unlink(path) == 0 else { throw invalid }
        return ticket
    }

    private static func isAbsolutePath(_ value: String) -> Bool {
        value.hasPrefix("/") && !value.contains("\0")
    }
}

private final class LocalRequests: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class NativeEditorClient: EditorAPI {
    private let endpoint: URL
    private let token: String
    private let session: URLSession

    init(port: Int, token: String) {
        endpoint = URL(string: "http://127.0.0.1:\(port)/api")!
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.httpCookieStorage = nil
        config.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0]
        config.timeoutIntervalForRequest = 25
        session = URLSession(configuration: config, delegate: LocalRequests(), delegateQueue: nil)
    }

    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        var request = URLRequest(url: endpoint, timeoutInterval: op == "events" ? 25 : 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var body = fields
        body["op"] = op
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, data.count <= 16 * 1024 * 1024,
              let result = try? JSONSerialization.jsonObject(with: data) as? Fields else {
            throw EditorIssue(code: "response", message: "The workspace service did not return an Editor response.")
        }
        guard http.statusCode == 200 else {
            throw EditorIssue(code: result["code"] as? String ?? "refused",
                              message: result["error"] as? String ?? "The workspace service declined the request.")
        }
        return result
    }

    func stop() { session.invalidateAndCancel() }
}
