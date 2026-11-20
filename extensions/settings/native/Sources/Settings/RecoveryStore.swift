import CryptoKit
import Darwin
import Foundation

actor RecoveryStore {
    struct Item: Sendable {
        let id: String
        let data: Data
    }

    private struct Claim {
        let lock: DraftLock
        let identity: stat
    }

    private static let limit = 4 * 1_048_576
    private let support: URL
    private let target: String
    private let pane = UUID().uuidString.lowercased()
    private var ownLock: DraftLock?
    private var claims: [String: Claim] = [:]

    init(agentDir: String, cwd: String) {
        self.init(agentDir: agentDir, cwd: cwd, applicationSupport: URL.applicationSupportDirectory)
    }

    init(agentDir: String, cwd: String, applicationSupport: URL) {
        support = applicationSupport
        var key = SHA256()
        for component in [agentDir, cwd] {
            var length = UInt64(component.utf8.count).bigEndian
            withUnsafeBytes(of: &length) { key.update(bufferPointer: $0) }
            key.update(data: Data(component.utf8))
        }
        target = key.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func load() throws -> [Item] {
        let root = try directory()
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
        var items: [Item] = []
        for name in names where name.hasSuffix(".json") {
            let id = String(name.dropLast(5))
            guard id != pane, UUID(uuidString: id)?.uuidString.lowercased() == id,
                  let lock = claims[id]?.lock ?? DraftLock(path(root, id, "lock"), create: false),
                  let (bytes, identity) = snapshot(path(root, id, "json")) else { continue }
            // Offer the expired draft exclusively without moving or deleting it.
            // The page persists the restored draft before it asks to discard this copy.
            claims[id] = Claim(lock: lock, identity: identity)
            items.append(Item(id: id, data: bytes))
        }
        return items
    }

    func save(_ data: Data?) throws {
        let failure = SettingsFailure("Could not save the Settings recovery draft.")
        guard let data else {
            guard let ownLock else { return }
            let draft = path(try directory(), pane, "json")
            guard unlink(draft) == 0 || errno == ENOENT else { throw failure }
            ownLock.removeOnClose = true
            return
        }
        guard data.count <= Self.limit else { throw SettingsFailure("The Settings recovery draft is too large.") }
        let root = try directory()
        if ownLock == nil {
            guard let lock = DraftLock(path(root, pane, "lock"), create: true) else { throw failure }
            ownLock = lock
        }
        let temporary = path(root, UUID().uuidString, "writing")
        let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw failure }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer {
            try? file.close()
            unlink(temporary)
        }
        do {
            guard fchmod(fd, 0o600) == 0 else { throw failure }
            try file.write(contentsOf: data)
            try file.synchronize()
            guard rename(temporary, path(root, pane, "json")) == 0 else { throw failure }
        } catch {
            throw failure
        }
        ownLock?.removeOnClose = false
    }

    func discard(id: String) throws {
        guard let claim = claims[id] else { throw SettingsFailure("This Settings recovery draft is not available to this pane.") }
        let draft = path(try directory(), id, "json")
        guard PrivateSettingsFile.matches(draft, claim.identity), unlink(draft) == 0 else {
            throw SettingsFailure("The Settings recovery draft changed or could not be discarded.")
        }
        claim.lock.removeOnClose = true
        claims[id] = nil
    }

    private func snapshot(_ path: String) -> (Data, stat)? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        guard let info = PrivateSettingsFile.status(fd),
              let bytes = PrivateSettingsFile.read(fd, size: info.st_size, limit: Self.limit),
              PrivateSettingsFile.matches(path, info) else { return nil }
        return (bytes, info)
    }

    private func directory() throws -> URL {
        let base = support.appendingPathComponent("Harness Settings Recovery", isDirectory: true)
        let root = base.appendingPathComponent(target, isDirectory: true)
        let failure = SettingsFailure("Could not access the private Settings recovery directory.")
        do {
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            for location in [base, root] {
                let name = location.path
                guard mkdir(name, 0o700) == 0 || errno == EEXIST else { throw failure }
                var info = stat()
                guard lstat(name, &info) == 0, info.st_mode == S_IFDIR | 0o700,
                      info.st_uid == geteuid() else { throw failure }
            }
        } catch {
            throw failure
        }
        return root
    }

    private func path(_ root: URL, _ id: String, _ suffix: String) -> String {
        root.appendingPathComponent("\(id).\(suffix)").path
    }
}

// A separate inode keeps the lease intact when rename replaces the draft file.
private final class DraftLock {
    private let path: String
    private let fd: Int32
    var removeOnClose: Bool

    init?(_ path: String, create: Bool) {
        let flags = O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
        let fd = open(path, create ? flags | O_CREAT | O_EXCL : flags, mode_t(0o600))
        guard fd >= 0 else { return nil }
        guard (!create || fchmod(fd, 0o600) == 0), flock(fd, LOCK_EX | LOCK_NB) == 0,
              let info = PrivateSettingsFile.status(fd), PrivateSettingsFile.matches(path, info) else {
            if create { unlink(path) }
            close(fd)
            return nil
        }
        self.path = path
        self.fd = fd
        removeOnClose = create
    }

    deinit {
        if removeOnClose, let info = PrivateSettingsFile.status(fd), PrivateSettingsFile.matches(path, info) {
            unlink(path)
        }
        close(fd)
    }
}
