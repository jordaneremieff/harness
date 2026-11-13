import CryptoKit
import Foundation

public enum Limits {
    /// Largest Markdown source the reader accepts, in UTF-8 bytes.
    public static let sourceBytes = 2 * 1024 * 1024
    /// Largest store record (document.json, revision.json, store.json, open request).
    public static let recordBytes = 256 * 1024
    public static let assetBytes = 8 * 1024 * 1024
    /// Directory entries a listing reads before it reports that the bound stopped it.
    public static let listingScan = 2000
    /// Newest revisions of a document that the reader offers as choices.
    public static let revisionChoices = 50
}

public enum StoreError: Error, Equatable, Sendable, CustomStringConvertible {
    case notAStore
    case incompatibleVersion(Int)
    case invalidIdentifier(String)
    case notFound(String)
    case outsideStore
    case tooLarge(Int)
    case notUTF8
    case digestMismatch
    /// The revision on disk no longer carries the digest that the accepted open request pinned.
    case pinnedDigestMismatch(Int)
    case unreadable(String)

    public var description: String {
        switch self {
        case .notAStore: "The directory is not a Markdown document store (no store.json)."
        case .incompatibleVersion(let version): "The store record has format version \(version); this reader reads version \(StoreFormat.version)."
        case .invalidIdentifier(let value): "Invalid document identifier: \(value)"
        case .notFound(let what): "Not found: \(what)"
        case .outsideStore: "The path resolves outside the store."
        case .tooLarge(let bytes): "The source has \(bytes) bytes; the limit is \(Limits.sourceBytes)."
        case .notUTF8: "The source is not valid UTF-8."
        case .digestMismatch: "The source bytes do not match the recorded digest."
        case .pinnedDigestMismatch(let revision): "Revision \(revision) changed after the open request was accepted; the reader does not show it."
        case .unreadable(let reason): "Unreadable: \(reason)"
        }
    }
}

/// One revision with its exact source, ready to render.
public struct LoadedRevision: Sendable {
    public var document: DocumentRecord
    public var record: RevisionRecord
    public var source: String
    /// Canonical directory of the revision; retained assets resolve only under it.
    public var directory: URL
    /// Revision choices in ascending order: the existing revisions among the newest
    /// `Limits.revisionChoices` numbers up to the pointer.
    public var revisions: [Int]
    /// True when revisions older than the listed choices exist.
    public var olderRevisionsUnlisted: Bool
}

public struct DocumentListing: Sendable {
    public var documents: [DocumentRecord]
    /// True when the scan bound stopped the listing before it saw every entry.
    public var truncated: Bool
    public var unreadable: Int
}

public protocol DocumentStore: Sendable {
    var storeId: String { get }
    func document(_ id: String) throws -> DocumentRecord
    func loadRevision(_ id: String, revision: Int?) throws -> LoadedRevision
    func list(_ collection: StoreCollection) throws -> DocumentListing
    /// A location whose change signals a new current revision of the document.
    func pointerLocation(_ id: String) -> URL?
}

/// Reads the store format of version 1 from a directory. It never writes.
public struct DirectoryStore: DocumentStore {
    public let root: URL
    public let storeId: String
    private let canonicalRoot: String

    public init(root: URL) throws {
        let manifestURL = root.appendingPathComponent(StoreFormat.manifestName)
        let data = try FileAccess.readRegularFile(manifestURL, limit: Limits.recordBytes, missing: .notAStore)
        let manifest: StoreManifest
        do {
            manifest = try JSONDecoder().decode(StoreManifest.self, from: data)
        } catch {
            throw StoreError.unreadable("store.json: \(error.localizedDescription)")
        }
        guard manifest.version == StoreFormat.version else { throw StoreError.incompatibleVersion(manifest.version) }
        guard Identifiers.isStoreId(manifest.storeId) else { throw StoreError.invalidIdentifier(manifest.storeId) }
        self.root = root.standardizedFileURL
        self.storeId = manifest.storeId
        self.canonicalRoot = FileAccess.canonicalPath(root.path)
    }

    /// The canonical directory of a document and its collection: `documents/` is probed before
    /// `snapshots/`. A document directory reached through a symbolic link is refused.
    private func locate(_ id: String) throws -> (URL, StoreCollection) {
        guard Identifiers.isDocumentId(id) else { throw StoreError.invalidIdentifier(id) }
        for collection in StoreCollection.allCases {
            let path = canonicalRoot + "/" + collection.directory + "/" + id
            var info = stat()
            guard lstat(path, &info) == 0 else { continue }
            try requireCanonical(path)
            guard (info.st_mode & S_IFMT) == S_IFDIR else { continue }
            return (URL(fileURLWithPath: path, isDirectory: true), collection)
        }
        throw StoreError.notFound(id)
    }

    private func documentDirectory(_ id: String) throws -> URL {
        try locate(id).0
    }

    public func pointerLocation(_ id: String) -> URL? {
        try? documentDirectory(id)
    }

    public func document(_ id: String) throws -> DocumentRecord {
        let (directory, collection) = try locate(id)
        let data = try FileAccess.readRegularFile(directory.appendingPathComponent("document.json"), limit: Limits.recordBytes, missing: .notFound(id))
        let record: DocumentRecord
        do {
            record = try JSONDecoder().decode(DocumentRecord.self, from: data)
        } catch {
            throw StoreError.unreadable("document.json of \(id): \(error.localizedDescription)")
        }
        guard record.version == StoreFormat.version else { throw StoreError.incompatibleVersion(record.version) }
        guard record.id == id, record.revision >= 1 else { throw StoreError.unreadable("document.json of \(id) names another document or no revision") }
        guard record.kind.collection == collection else {
            throw StoreError.unreadable("\(id) is a \(record.kind.rawValue) document in the \(collection.directory) collection")
        }
        return record
    }

    /// Revision choices from the pointer, in ascending order: of the newest
    /// `Limits.revisionChoices` numbers up to the pointer, those whose directory exists. Directories
    /// above the pointer belong to an unfinished write and are never probed.
    public func revisionNumbers(_ id: String, pointer: Int) throws -> (numbers: [Int], olderUnlisted: Bool) {
        let revisions = try documentDirectory(id).path + "/revisions/"
        let lowest = max(1, pointer - Limits.revisionChoices + 1)
        let numbers = (lowest...pointer).filter { number in
            var info = stat()
            return lstat(revisions + String(number), &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR
        }
        return (numbers, lowest > 1)
    }

    public func loadRevision(_ id: String, revision: Int? = nil) throws -> LoadedRevision {
        let document = try document(id)
        let number = revision ?? document.revision
        guard number >= 1, number <= document.revision else { throw StoreError.notFound("\(id) revision \(number)") }
        let directory = try documentDirectory(id).appendingPathComponent("revisions").appendingPathComponent(String(number))
        try requireCanonical(directory.path)
        let recordData = try FileAccess.readRegularFile(directory.appendingPathComponent("revision.json"), limit: Limits.recordBytes, missing: .notFound("\(id) revision \(number)"))
        let record: RevisionRecord
        do {
            record = try JSONDecoder().decode(RevisionRecord.self, from: recordData)
        } catch {
            throw StoreError.unreadable("revision.json of \(id)/\(number): \(error.localizedDescription)")
        }
        guard record.version == StoreFormat.version else { throw StoreError.incompatibleVersion(record.version) }
        guard record.document == id, record.revision == number else { throw StoreError.unreadable("revision.json of \(id)/\(number) names another revision") }
        let sourceData = try FileAccess.readRegularFile(directory.appendingPathComponent("source.md"), limit: Limits.sourceBytes, missing: .notFound("\(id) revision \(number) source"))
        guard Digest.sha256(sourceData) == record.digest, sourceData.count == record.bytes else { throw StoreError.digestMismatch }
        guard let source = String(data: sourceData, encoding: .utf8) else { throw StoreError.notUTF8 }
        let choices = try revisionNumbers(id, pointer: document.revision)
        return LoadedRevision(
            document: document,
            record: record,
            source: source,
            directory: directory,
            revisions: choices.numbers,
            olderRevisionsUnlisted: choices.olderUnlisted
        )
    }

    /// Lists one collection, newest first. The directory read itself stops after
    /// `Limits.listingScan` entries, and the listing says so when more entries remain.
    public func list(_ collection: StoreCollection) throws -> DocumentListing {
        try list(collection, scanLimit: Limits.listingScan)
    }

    func list(_ collection: StoreCollection, scanLimit: Int) throws -> DocumentListing {
        var documents: [DocumentRecord] = []
        var unreadable = 0
        guard let directory = opendir(canonicalRoot + "/" + collection.directory) else {
            return DocumentListing(documents: [], truncated: false, unreadable: 0)
        }
        defer { closedir(directory) }
        var scanned = 0
        var truncated = false
        while let entry = readdir(directory) {
            let name = withUnsafeBytes(of: entry.pointee.d_name) { bytes in
                String(decoding: bytes.prefix(Int(entry.pointee.d_namlen)), as: UTF8.self)
            }
            if name == "." || name == ".." { continue }
            if scanned == scanLimit {
                truncated = true
                break
            }
            scanned += 1
            guard Identifiers.isDocumentId(name) else { continue }
            if let record = try? document(name) {
                documents.append(record)
            } else {
                unreadable += 1
            }
        }
        documents.sort { $0.updatedAt > $1.updatedAt }
        return DocumentListing(documents: documents, truncated: truncated, unreadable: unreadable)
    }

    /// Refuses a path below the store root that is reached through a symbolic link.
    private func requireCanonical(_ path: String) throws {
        guard FileAccess.canonicalPath(path) == path else { throw StoreError.outsideStore }
    }
}

public enum Digest {
    public static func sha256(_ data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// Device and inode of a file.
public struct FileIdentity: Equatable, Sendable {
    public var device: Int64
    public var inode: UInt64

    init(_ info: stat) {
        device = Int64(info.st_dev)
        inode = UInt64(info.st_ino)
    }
}

/// Bounded, symlink-aware file access shared by the store reader, the open-request intake and
/// the asset resolver.
public enum FileAccess {
    public static func canonicalPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return (path as NSString).standardizingPath }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    public static func isInside(_ path: String, root: String) -> Bool {
        let base = root.hasSuffix("/") ? root : root + "/"
        return path.hasPrefix(base)
    }

    public static func isRegularFile(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
    }

    public static func fileSize(_ path: String) -> Int? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return Int(info.st_size)
    }

    /// Reads a regular file of at most `limit` bytes. The last path component must not be a
    /// symbolic link: the file is opened without following one, and the opened descriptor must be
    /// a regular file.
    public static func readRegularFile(_ url: URL, limit: Int, missing: StoreError) throws -> Data {
        try readRegularFileWithIdentity(url, limit: limit, missing: missing).data
    }

    /// Reads like `readRegularFile` and also returns the identity of the file that was read.
    public static func readRegularFileWithIdentity(_ url: URL, limit: Int, missing: StoreError) throws -> (data: Data, identity: FileIdentity) {
        let name = url.lastPathComponent
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else {
            switch errno {
            case ENOENT, ENOTDIR: throw missing
            case ELOOP: throw StoreError.unreadable("\(name) is a symbolic link")
            default: throw StoreError.unreadable("\(name): \(String(cString: strerror(errno)))")
            }
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            throw StoreError.unreadable("\(name) is not a regular file")
        }
        let data: Data
        do {
            data = try handle.read(upToCount: limit + 1) ?? Data()
        } catch {
            throw StoreError.unreadable("\(name): \(error.localizedDescription)")
        }
        guard data.count <= limit else { throw StoreError.tooLarge(max(Int(info.st_size), data.count)) }
        return (data, FileIdentity(info))
    }
}
