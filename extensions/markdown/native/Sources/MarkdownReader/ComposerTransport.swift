import CoreFoundation
import Darwin
import Foundation

struct ComposerConfiguration: Codable, Sendable {
    let version: Int
    let composer: String
    let endpoint: String
    let token: String
    let pid: Int32

    static func consume(_ url: URL, expectedComposer: String? = nil) throws -> Self {
        guard url.isFileURL, url.path.hasPrefix("/") else {
            throw ComposerTransportError.invalidConfiguration("The composer configuration must be an absolute file.")
        }
        let path = url.path
        let fd = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else {
            throw ComposerTransportError.invalidConfiguration("The composer configuration file is unavailable.")
        }
        defer { Darwin.close(fd) }

        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o777 == 0o600,
              info.st_size >= 0, info.st_size <= 16384 else {
            throw ComposerTransportError.invalidConfiguration("The composer configuration file is not private and regular.")
        }

        let data = try readExactly(fd, size: Int(info.st_size))
        let value: Self
        do {
            value = try JSONDecoder().decode(Self.self, from: data)
        } catch {
            throw ComposerTransportError.invalidConfiguration("The composer configuration is not valid JSON.")
        }

        guard ComposerValidation.isValid(value) else {
            throw ComposerTransportError.invalidConfiguration("The composer configuration is invalid.")
        }
        if let expectedComposer, value.composer != expectedComposer {
            throw ComposerTransportError.invalidConfiguration("The composer identity changed.")
        }

        var current = stat()
        guard lstat(path, &current) == 0,
              current.st_dev == info.st_dev, current.st_ino == info.st_ino,
              current.st_mode == info.st_mode, current.st_uid == info.st_uid,
              current.st_size == info.st_size,
              current.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec,
              current.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec,
              Darwin.unlink(path) == 0 else {
            throw ComposerTransportError.invalidConfiguration("The composer configuration changed before acceptance.")
        }
        return value
    }

    private static func readExactly(_ fd: Int32, size: Int) throws -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: max(size, 1))
        while data.count < size {
            let count = Darwin.read(fd, &buffer, size - data.count)
            if count < 0 {
                if errno == EINTR { continue }
                throw ComposerTransportError.invalidConfiguration("The composer configuration file could not be read.")
            }
            if count == 0 {
                throw ComposerTransportError.invalidConfiguration("The composer configuration file changed while reading.")
            }
            data.append(contentsOf: buffer.prefix(count))
        }
        var extra: UInt8 = 0
        while true {
            let count = Darwin.read(fd, &extra, 1)
            if count < 0 {
                if errno == EINTR { continue }
                throw ComposerTransportError.invalidConfiguration("The composer configuration file could not be read.")
            }
            guard count == 0 else {
                throw ComposerTransportError.invalidConfiguration("The composer configuration has extra bytes.")
            }
            break
        }
        return data
    }
}

enum ComposerTransportError: Error, Equatable, Sendable {
    case refused(String)
    case invalidResponse
    case invalidRequest
    case invalidConfiguration(String)
    case requestTooLarge
    case responseTooLarge
}

private enum ComposerValidation {
    static func isValid(_ value: ComposerConfiguration) -> Bool {
        value.version == 1
            && UUID(uuidString: value.composer) != nil
            && port(in: value.endpoint) != nil
            && isToken(value.token)
            && value.pid > 0
    }

    static func port(in endpoint: String) -> Int? {
        let prefix = "http://127.0.0.1:"
        guard endpoint.hasPrefix(prefix) else { return nil }
        let suffix = endpoint.dropFirst(prefix.count)
        guard !suffix.isEmpty, suffix.first != "0", suffix.utf8.allSatisfy({ (48...57).contains($0) }),
              let port = Int(suffix), (1...65535).contains(port), String(port) == String(suffix) else { return nil }
        return port
    }

    static func isToken(_ token: String) -> Bool {
        let bytes = Array(token.utf8)
        return bytes.count == 64 && bytes.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() else {
            return nil
        }
        return number.boolValue
    }
}

private final class ComposerRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private let maximumComposerBodyBytes = 4 * 1024 * 1024
private let maximumComposerResponseBytes = 4 * 1024 * 1024

@MainActor
final class ComposerTransport {
    private let configuration: ComposerConfiguration
    private let session: URLSession

    init(_ configuration: ComposerConfiguration) {
        self.configuration = configuration
        let settings = URLSessionConfiguration.ephemeral
        settings.httpCookieStorage = nil
        settings.httpShouldSetCookies = false
        settings.httpCookieAcceptPolicy = .never
        settings.urlCache = nil
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = 35
        settings.timeoutIntervalForResource = 35
        session = URLSession(configuration: settings, delegate: ComposerRedirectDelegate(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func request(_ path: String, _ fields: [String: Any] = [:]) async throws -> [String: Any] {
        let (url, relative) = try endpoint(for: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = relative == "events" ? 35 : 4
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization")
        request.httpBody = try Self.encodedBody(fields, configuration: configuration)

        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw ComposerTransportError.invalidResponse
        }
        var data = Data()
        for try await byte in bytes {
            guard data.count < maximumComposerResponseBytes else {
                throw ComposerTransportError.responseTooLarge
            }
            data.append(byte)
        }
        return try Self.decodeResponse(status: response.statusCode, data: data)
    }

    nonisolated static func encodedBody(_ fields: [String: Any],
                                        configuration: ComposerConfiguration) throws -> Data {
        guard ComposerValidation.isValid(configuration) else {
            throw ComposerTransportError.invalidConfiguration("The composer configuration is invalid.")
        }
        var body = fields
        body["origin"] = nil
        body["composer"] = configuration.composer
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: body)
        } catch {
            throw ComposerTransportError.invalidRequest
        }
        guard data.count <= maximumComposerBodyBytes else {
            throw ComposerTransportError.requestTooLarge
        }
        return data
    }

    nonisolated static func decodeResponse(status: Int, data: Data) throws -> [String: Any] {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw ComposerTransportError.invalidResponse
        }
        guard let value = object as? [String: Any] else {
            throw ComposerTransportError.invalidResponse
        }
        if status == 409 {
            guard ComposerValidation.boolean(value["ok"]) == false,
                  let error = value["error"] as? String else {
                throw ComposerTransportError.invalidResponse
            }
            throw ComposerTransportError.refused(error)
        }
        guard status == 200, ComposerValidation.boolean(value["ok"]) == true else {
            throw ComposerTransportError.invalidResponse
        }
        return value
    }

    private func endpoint(for path: String) throws -> (URL, String) {
        guard ComposerValidation.isValid(configuration) else {
            throw ComposerTransportError.invalidConfiguration("The composer configuration is invalid.")
        }
        let relative = String(path.drop(while: { $0 == "/" }))
        let components = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !relative.isEmpty, !components.isEmpty,
              components.allSatisfy({ component in
                  !component.isEmpty && component != "." && component != ".."
                      && component.utf8.allSatisfy(ComposerValidation.isPathByte)
              }),
              let url = URL(string: configuration.endpoint + "/" + relative) else {
            throw ComposerTransportError.invalidRequest
        }
        return (url, relative)
    }
}

private extension ComposerValidation {
    static func isPathByte(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
            || byte == 45 || byte == 46 || byte == 95 || byte == 126
    }
}
