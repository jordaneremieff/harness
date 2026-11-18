import Darwin
import Foundation
import MarkdownCore

struct ComposerDraftStore: Sendable {
    struct Draft: Codable, Equatable {
        let composer: String
        let pid: Int32
        let updated: Date
        let text: String
    }

    let directory: URL
    let composer: String

    private var file: URL { directory.appendingPathComponent("\(composer).json") }

    func save(_ text: String) throws {
        if text.isEmpty {
            if unlink(file.path) != 0, errno != ENOENT { throw POSIXError(.EIO) }
            return
        }
        try Self.prepare(directory)
        let data = try JSONEncoder().encode(Draft(composer: composer, pid: getpid(), updated: Date(), text: text))
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
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else { throw CocoaError(.fileWriteNoPermission) }
    }

    func retained() -> String {
        read(file)?.text ?? ""
    }

    func orphans() -> [Draft] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return [] }
        return files.lazy.filter { $0.pathExtension == "json" && $0 != file }.compactMap(read)
            .filter { !Self.alive($0.pid) }.sorted { $0.updated > $1.updated }
    }

    static func alive(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }

    private func read(_ url: URL) -> Draft? {
        guard let data = try? FileAccess.readRegularFile(url, limit: 16 * 1024 * 1024, missing: .notFound("draft")),
              let record = try? JSONDecoder().decode(Draft.self, from: data),
              url.deletingPathExtension().lastPathComponent == record.composer,
              UUID(uuidString: record.composer) != nil, record.pid > 0, !record.text.isEmpty else { return nil }
        return record
    }
}
