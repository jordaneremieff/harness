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
    let version: Int
    let port: Int
    let token: String
    let root: String
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
              let ticket = try? JSONDecoder().decode(Self.self, from: data), ticket.version == 1,
              (1...65535).contains(ticket.port), ticket.token.utf8.count == 64,
              ticket.token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              ticket.root.hasPrefix("/"), !ticket.root.contains("\0"),
              [ticket.settings, ticket.layout].allSatisfy({ $0.map { $0.hasPrefix("/") && !$0.contains("\0") } ?? true })
        else { throw invalid }
        var current = stat()
        guard lstat(path, &current) == 0, current.st_ino == info.st_ino, current.st_dev == info.st_dev,
              unlink(path) == 0 else { throw invalid }
        return ticket
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

    init(ticket: EditorTicket) {
        endpoint = URL(string: "http://127.0.0.1:\(ticket.port)/api")!
        token = ticket.token
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.httpCookieStorage = nil
        config.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0]
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config, delegate: LocalRequests(), delegateQueue: nil)
    }

    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var body = fields
        body["op"] = op
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, data.count <= 16 * 1024 * 1024,
              let result = try? JSONSerialization.jsonObject(with: data) as? Fields else {
            throw EditorIssue(code: "response", message: "Pi did not return an Editor response.")
        }
        guard http.statusCode == 200 else {
            throw EditorIssue(code: result["code"] as? String ?? "refused",
                              message: result["error"] as? String ?? "Pi declined the Editor request.")
        }
        return result
    }
}
