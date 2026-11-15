import Foundation

/// A continuing directory read. Pages reflect the directory as it is read, not a frozen store
/// snapshot. Reload starts again after concurrent additions or removals.
public final class CollectionScan: @unchecked Sendable {
    private let lock = NSLock()
    private let store: DirectoryStore
    private let collection: StoreCollection
    private var directory: UnsafeMutablePointer<DIR>?
    private var ended = false
    public let absent: Bool

    public init(store: DirectoryStore, collection: StoreCollection) throws {
        self.store = store
        self.collection = collection
        let path = FileAccess.canonicalPath(store.root.path) + "/" + collection.directory
        guard FileAccess.canonicalPath(path) == path else { throw StoreError.outsideStore }
        directory = opendir(path)
        if directory == nil {
            let code = errno
            guard code == ENOENT else { throw StoreError.unreadable("\(collection.directory): \(String(cString: strerror(code)))") }
            absent = true
            ended = true
        } else { absent = false }
    }

    deinit { if let directory { closedir(directory) } }

    public func next(limit: Int = 100) -> DocumentListing {
        lock.withLock {
            guard let directory, !ended else {
                return DocumentListing(documents: [], truncated: false, unreadable: 0, absent: absent)
            }
            var documents: [DocumentRecord] = []
            var issues: [ListingIssue] = []
            var unreadable = 0
            var scanned = 0
            var failure: String?
            while scanned < max(1, min(limit, Limits.listingScan)) {
                errno = 0
                guard let entry = readdir(directory) else {
                    let code = errno
                    ended = true
                    if code != 0 { failure = "\(collection.directory): \(String(cString: strerror(code)))" }
                    break
                }
                let name = withUnsafeBytes(of: entry.pointee.d_name) { bytes in
                    String(decoding: bytes.prefix(Int(entry.pointee.d_namlen)), as: UTF8.self)
                }
                if name == "." || name == ".." { continue }
                scanned += 1
                guard Identifiers.isDocumentId(name) else { continue }
                do {
                    let record = try store.document(name)
                    guard record.kind.collection == collection else { throw StoreError.unreadable("record belongs to another collection") }
                    documents.append(record)
                } catch {
                    unreadable += 1
                    if issues.count < 8 { issues.append(ListingIssue(document: name, reason: String(describing: error))) }
                }
            }
            // Looking ahead does not discard an entry: telldir/seekdir restore its exact position.
            if !ended {
                let position = telldir(directory)
                errno = 0
                if readdir(directory) == nil {
                    let code = errno
                    ended = true
                    if code != 0 { failure = "\(collection.directory): \(String(cString: strerror(code)))" }
                } else { seekdir(directory, position) }
            }
            documents.sort { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
            return DocumentListing(documents: documents, truncated: !ended, unreadable: unreadable,
                                   absent: absent, scanned: scanned, issues: issues, failure: failure)
        }
    }
}
