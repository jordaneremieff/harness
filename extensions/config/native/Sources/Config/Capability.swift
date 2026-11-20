import Darwin
import Foundation

struct Capability: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    private let endpoint: String
    private let token: String

    var description: String { "Config launch capability" }
    var debugDescription: String { description }

    private struct Record: Decodable {
        let version: Int
        let endpoint: String
        let token: String
    }

    static func consume(path: String) throws -> Capability {
        let unavailable = ConfigFailure("The Config launch is unavailable. Run /config again.")
        guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw unavailable }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw unavailable }
        defer { close(fd) }
        // A second consumer that already opened the same inode must not get a token.
        guard flock(fd, LOCK_EX | LOCK_NB) == 0,
              let before = PrivateFile.status(fd),
              let bytes = PrivateFile.read(fd, size: before.st_size, limit: 8192),
              let record = try? JSONDecoder().decode(Record.self, from: bytes),
              record.version == 1, let endpoint = validatedEndpoint(record.endpoint),
              record.token.utf8.count == 64,
              record.token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              PrivateFile.matches(path, before), unlink(path) == 0 else { throw unavailable }
        return Capability(endpoint: endpoint, token: record.token)
    }

    private static func validatedEndpoint(_ endpoint: String) -> String? {
        let prefix = "http://127.0.0.1:"
        guard endpoint.hasPrefix(prefix) else { return nil }
        var port = endpoint.dropFirst(prefix.count)
        if port.last == "/" { port = port.dropLast() }
        guard (1...5).contains(port.utf8.count), port.utf8.allSatisfy({ (48...57).contains($0) }),
              let number = Int(port), (1...65535).contains(number), String(number) == port else { return nil }
        return prefix + port
    }

    func authorize(_ route: Route) -> URLRequest {
        // consume() permits only a canonical loopback origin; Route supplies a fixed path.
        var request = URLRequest(url: URL(string: endpoint + route.rawValue)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}

// Launch and recovery files both reject links, special files and non-private modes.
enum PrivateFile {
    static func status(_ fd: Int32) -> stat? {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode == S_IFREG | 0o600, info.st_uid == geteuid(),
              info.st_nlink == 1 else { return nil }
        return info
    }

    static func matches(_ path: String, _ expected: stat) -> Bool {
        var actual = stat()
        return lstat(path, &actual) == 0 && actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino
            && actual.st_mode == expected.st_mode && actual.st_uid == expected.st_uid
            && actual.st_nlink == expected.st_nlink && actual.st_size == expected.st_size
            && actual.st_ctimespec.tv_sec == expected.st_ctimespec.tv_sec
            && actual.st_ctimespec.tv_nsec == expected.st_ctimespec.tv_nsec
            && actual.st_mtimespec.tv_sec == expected.st_mtimespec.tv_sec
            && actual.st_mtimespec.tv_nsec == expected.st_mtimespec.tv_nsec
    }

    static func read(_ fd: Int32, size: off_t, limit: Int) -> Data? {
        guard size >= 0, size <= limit else { return nil }
        // Read one extra byte to detect growth without an unbounded read.
        var bytes = Data(count: Int(size) + 1)
        let count = bytes.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                if count < 0 { return -1 }
                if count == 0 { break }
                offset += count
            }
            return offset
        }
        guard count == size else { return nil }
        bytes.removeLast()
        return bytes
    }
}
