import CryptoKit
import Darwin
import Foundation

let editFileLimit = 2 * mib
let editLineLimit = 20_000

func validEditText(_ bytes: Data) -> Bool {
    guard bytes.count <= editFileLimit else { return false }
    var lines = 1, hadCR = false
    for byte in bytes {
        if byte == 0 { return false }
        if byte == 13 || (byte == 10 && !hadCR) {
            lines += 1
            if lines > editLineLimit { return false }
        }
        hadCR = byte == 13
    }
    return true
}

func contentDigest(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}

func validEditBase(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

private func editTextPath(_ path: String) -> Bool {
    validPath(path) && imageMedia[URL(fileURLWithPath: path).pathExtension.lowercased()] == nil
}

private let editLocationError = ExplorerError("invalid-path", "Use a regular file inside the opened folder, without links or Git metadata in the path.")
private let editConflict = ExplorerError("conflict", "The file changed on disk.")

private func descriptorPath(_ fd: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    return buffer.withUnsafeMutableBufferPointer { pointer in
        guard let raw = pointer.baseAddress, fcntl(fd, F_GETPATH, UnsafeMutableRawPointer(raw)) == 0 else { return nil }
        return String(validatingUTF8: raw)
    }
}

extension Workspace {
    func editBase(path: String, resolved: URL, bytes: Data) -> String? {
        guard editTextPath(path), resolved.path == root.appendingPathComponent(path).path, validEditText(bytes) else { return nil }
        return contentDigest(bytes)
    }

    private func checkEditDirectory(_ fd: Int32) throws {
        let prefix = root.path == "/" ? "/" : root.path + "/"
        guard let actual = descriptorPath(fd), actual == root.path ||
            (actual.hasPrefix(prefix) && validPath(String(actual.dropFirst(prefix.count)))) else { throw editLocationError }
    }

    private func withEditParent<T>(_ path: String, create: Bool, _ action: (Int32, String) throws -> T) throws -> T {
        guard editTextPath(path) else { throw editLocationError }
        let parts = path.split(separator: "/").map(String.init)
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        var fd = Darwin.open(root.path, flags)
        guard fd >= 0 else { throw editLocationError }
        defer { Darwin.close(fd) }
        try checkEditDirectory(fd)
        for part in parts.dropLast() {
            var next = openat(fd, part, flags)
            if next < 0, create, errno == ENOENT {
                try checkEditDirectory(fd)
                guard mkdirat(fd, part, 0o777) == 0 || errno == EEXIST else {
                    throw ExplorerError("io", "A parent folder could not be created.")
                }
                next = openat(fd, part, flags)
            }
            guard next >= 0 else {
                if !create, errno == ENOENT { throw editConflict }
                throw editLocationError
            }
            Darwin.close(fd); fd = next
            try checkEditDirectory(fd)
        }
        return try action(fd, parts[parts.count - 1])
    }

    func createFile(_ path: String) throws {
        guard editTextPath(path), !path.utf8.contains(where: { $0 < 32 }) else {
            throw ExplorerError("invalid-path", "Use a relative text file path without Git metadata or control characters.")
        }
        try withEditParent(path, create: true) { parent, name in
            try checkEditDirectory(parent)
            let fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o666)
            guard fd >= 0 else {
                if errno == EEXIST { throw ExplorerError("exists", "That path already exists.") }
                throw ExplorerError("io", "The file could not be created.")
            }
            Darwin.close(fd)
        }
    }

    private func matchingFile(_ parent: Int32, _ name: String, base: String) throws -> stat {
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else {
            if errno == ENOENT || errno == ELOOP { throw editConflict }
            throw ExplorerError("io", "The file could not be checked before save.")
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var details = stat()
        guard fstat(fd, &details) == 0, details.st_mode & S_IFMT == S_IFREG,
              details.st_size <= editFileLimit,
              let actual = descriptorPath(fd), let parentPath = descriptorPath(parent),
              actual.hasPrefix(parentPath == "/" ? "/" : parentPath + "/"),
              validPath(URL(fileURLWithPath: actual).lastPathComponent) else { throw editConflict }
        let bytes = try handle.read(upToCount: editFileLimit + 1) ?? Data()
        guard validEditText(bytes), String(data: bytes, encoding: .utf8) != nil,
              contentDigest(bytes) == base else { throw editConflict }
        return details
    }

    func writeFile(_ path: String, text: String, base: String) throws {
        let bytes = Data(text.utf8)
        guard validEditBase(base), validEditText(bytes) else {
            throw ExplorerError("invalid", "The edit must contain at most 2 MiB and 20,000 lines of UTF-8 text without NUL bytes and a valid base.")
        }
        try withEditParent(path, create: false) { parent, name in
            _ = try matchingFile(parent, name, base: base)
            let staged = ".explorer-\(UUID().uuidString).tmp"
            let fd = openat(parent, staged, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw ExplorerError("io", "Explorer could not stage the edit.") }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            defer { _ = unlinkat(parent, staged, 0) }
            try handle.write(contentsOf: bytes)
            guard flock(parent, LOCK_EX | LOCK_NB) == 0 else {
                throw ExplorerError("busy", "Another Explorer pane is saving in this folder. Try again.")
            }
            let current = try matchingFile(parent, name, base: base)
            guard fchmod(fd, current.st_mode & 0o777) == 0 else {
                throw ExplorerError("io", "Explorer could not preserve the file permissions.")
            }
            var live = stat()
            guard fstatat(parent, name, &live, AT_SYMLINK_NOFOLLOW) == 0, live.st_dev == current.st_dev,
                  live.st_ino == current.st_ino, live.st_mode == current.st_mode, live.st_size == current.st_size,
                  live.st_mtimespec.tv_sec == current.st_mtimespec.tv_sec,
                  live.st_mtimespec.tv_nsec == current.st_mtimespec.tv_nsec else { throw editConflict }
            try checkEditDirectory(parent)
            guard renameat(parent, staged, parent, name) == 0 else { throw ExplorerError("io", "Explorer could not replace the file.") }
        }
    }
}
