import Darwin
import Foundation

struct ComposerDraftStore: Sendable {
    struct Draft: Codable, Equatable {
        let composer: String
        let pid: Int32
        let updated: Date
        let sessionID: String?
        let text: String
    }

    let directory: URL
    let composer: String

    private var file: URL { directory.appendingPathComponent("\(composer).json") }

    func save(_ text: String, sessionID: String?) throws {
        try Self.prepare(directory)
        if text.isEmpty {
            if unlink(file.path) != 0, errno != ENOENT { throw POSIXError(.EIO) }
            return
        }
        let data = try JSONEncoder().encode(Draft(composer: composer, pid: getpid(), updated: Date(), sessionID: sessionID, text: text))
        let next = directory.appendingPathComponent(".\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: next.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        defer { _ = unlink(next.path) }
        try data.write(to: next)
        guard rename(next.path, file.path) == 0 else { throw POSIXError(.EIO) }
    }

    static func prepare(_ directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(directory.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid() else { throw composerRefusal("Choose a directory you own instead of \(directory.path).") }
        guard (info.st_mode & 0o777) == 0o700 else {
            throw composerRefusal("Set permissions to 0700 on \(directory.path).")
        }
        guard access(directory.path, W_OK | X_OK) == 0 else { throw CocoaError(.fileWriteNoPermission) }
    }

    func retained() -> String {
        read(file)?.text ?? ""
    }

    func newestOrphan(in sessionID: String) -> Draft? {
        guard !sessionID.isEmpty, let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return nil }
        return files.lazy.filter { $0.pathExtension == "json" && $0 != file }.compactMap(read)
            .filter { $0.sessionID == sessionID && !Self.alive($0.pid) }
            .max { $0.updated < $1.updated }
    }

    static func alive(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }

    private func read(_ url: URL) -> Draft? {
        guard let data = try? ComposerFileRead.read(url, limit: 16 * 1024 * 1024),
              let record = try? JSONDecoder().decode(Draft.self, from: data),
              url.deletingPathExtension().lastPathComponent == record.composer,
              UUID(uuidString: record.composer) != nil, record.pid > 0, !record.text.isEmpty else { return nil }
        return record
    }
}
