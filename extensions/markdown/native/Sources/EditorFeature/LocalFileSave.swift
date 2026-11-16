import Darwin
import MarkdownCore

public struct FileEditBase: Codable, Equatable, Sendable {
    public var path: String
    public var requestedPath: String
    public var digest: String
    public var device: UInt64
    public var inode: UInt64
    public var modifiedSeconds: Int64
    public var modifiedNanoseconds: Int64
    public var changedSeconds: Int64
    public var changedNanoseconds: Int64
    public var permissions: UInt16
    public var hasBOM: Bool
}

public struct OpenEditFile: Sendable {
    public var source: String
    public var base: FileEditBase
}

public enum FileSaveError: Error, Sendable, CustomStringConvertible {
    case changed
    case invalid(String)
    public var description: String {
        switch self {
        case .changed: "The file changed outside this editor. Your draft remains intact. Save a copy or reopen the file deliberately."
        case .invalid(let reason): reason
        }
    }
}

public enum LocalFileSave {
    public static func open(_ url: URL) throws -> OpenEditFile {
        let requested = url.standardizedFileURL.path
        let path = FileAccess.canonicalPath(requested)
        let before = try info(path)
        let data = try FileAccess.readRegularFile(URL(fileURLWithPath: path), limit: Limits.sourceBytes, missing: .notFound(path))
        let after = try info(path)
        guard same(before, after), FileAccess.canonicalPath(requested) == path else { throw FileSaveError.changed }
        let bom = data.starts(with: [0xef, 0xbb, 0xbf])
        guard let source = String(data: bom ? data.dropFirst(3) : data, encoding: .utf8) else { throw StoreError.notUTF8 }
        let base = FileEditBase(path: path, requestedPath: requested, digest: Digest.sha256(data), device: UInt64(after.st_dev), inode: UInt64(after.st_ino), modifiedSeconds: Int64(after.st_mtimespec.tv_sec), modifiedNanoseconds: Int64(after.st_mtimespec.tv_nsec), changedSeconds: Int64(after.st_ctimespec.tv_sec), changedNanoseconds: Int64(after.st_ctimespec.tv_nsec), permissions: UInt16(after.st_mode & 0o777), hasBOM: bom)
        return OpenEditFile(source: source, base: base)
    }

    public static func save(source: String, base: FileEditBase) throws -> FileEditBase {
        try checkSize(source)
        var result: Result<FileEditBase, any Error>?
        var coordinationError: NSError?
        let coordinator = NSFileCoordinator()
        coordinator.coordinate(writingItemAt: URL(fileURLWithPath: base.path), options: .forReplacing, error: &coordinationError) { _ in
            result = Result {
                let current = try open(URL(fileURLWithPath: base.requestedPath))
                guard current.base == base else { throw FileSaveError.changed }
                // Do not even replace the inode on a no-op; original BOM and mixed endings stay exact.
                if source.utf8.elementsEqual(current.source.utf8) { return base }
                var data = Data()
                if base.hasBOM { data.append(contentsOf: [0xef, 0xbb, 0xbf]) }
                data.append(contentsOf: source.utf8)
                try data.write(to: URL(fileURLWithPath: base.path), options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: base.permissions)], ofItemAtPath: base.path)
                let saved = try open(URL(fileURLWithPath: base.requestedPath)).base
                guard saved.digest == Digest.sha256(data), saved.path == base.path else { throw FileSaveError.changed }
                return saved
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw FileSaveError.invalid("File coordination returned no result.") }
        return try result.get()
    }

    /// A new destination must not exist. Existing destinations use an explicitly captured base.
    public static func saveAs(source: String, url: URL) throws -> FileEditBase {
        try checkSize(source)
        let data = Data(source.utf8)
        try data.write(to: url, options: .withoutOverwriting)
        let saved = try open(url).base
        guard saved.digest == Digest.sha256(data) else { throw FileSaveError.changed }
        return saved
    }

    private static func checkSize(_ source: String) throws {
        guard source.utf8.count <= Limits.sourceBytes else {
            throw StoreError.tooLarge(name: "Markdown source", bytes: source.utf8.count, limit: Limits.sourceBytes)
        }
    }

    private static func info(_ path: String) throws -> stat {
        var value = stat()
        guard lstat(path, &value) == 0, value.st_mode & S_IFMT == S_IFREG else { throw FileSaveError.invalid("The file is not a readable regular file.") }
        return value
    }

    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
}
