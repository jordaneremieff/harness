import Foundation

/// Identity of a document as the reader opens it. Stored documents are named by store root and
/// document ID; plain files by path. Window reuse and reading positions key on `key`.
public enum DocumentReference: Hashable, Codable, Sendable {
    case stored(root: String, storeId: String, document: String)
    case file(path: String)

    public var key: String {
        switch self {
        case .stored(_, let storeId, let document): "store:\(storeId):\(document)"
        case .file(let path): "file:\(path)"
        }
    }
}

/// One loaded revision of a document with its exact source.
public struct DocumentSnapshot: Sendable {
    public var reference: DocumentReference
    public var title: String
    public var source: String
    public var digest: String
    public var bytes: Int
    /// Present for stored documents.
    public var document: DocumentRecord?
    public var record: RevisionRecord?
    /// Revision choices in ascending order (see `LoadedRevision.revisions`).
    public var revisions: [Int]
    public var olderRevisionsUnlisted: Bool
    /// Directory of a stored revision or the plain file itself.
    public var location: URL
    public var resolver: any AssetResolving

    public var revision: Int? { record?.revision }
    public var latestRevision: Int? { document?.revision }
    public var completeness: Completeness { record?.completeness ?? .complete }
}

public enum DocumentLoader {
    /// Loads a document. `pinnedDigest` is the digest of an accepted open request for a stored
    /// document: the loaded revision must still carry it. Plain files have no open request.
    public static func load(_ reference: DocumentReference, revision: Int? = nil, pinnedDigest: String? = nil) throws -> DocumentSnapshot {
        switch reference {
        case .stored(let root, let storeId, let id):
            let store = try DirectoryStore(root: URL(fileURLWithPath: root))
            guard store.storeId == storeId else { throw StoreError.notFound("store \(storeId) at \(root)") }
            let loaded = try store.loadRevision(id, revision: revision)
            if let pinnedDigest, loaded.record.digest != pinnedDigest {
                throw StoreError.pinnedDigestMismatch(loaded.record.revision)
            }
            let resolver = StoredAssetResolver(revisionDirectory: loaded.directory, references: loaded.record.references, kind: loaded.document.kind)
            return DocumentSnapshot(
                reference: reference,
                title: loaded.record.title,
                source: loaded.source,
                digest: loaded.record.digest,
                bytes: loaded.record.bytes,
                document: loaded.document,
                record: loaded.record,
                revisions: loaded.revisions,
                olderRevisionsUnlisted: loaded.olderRevisionsUnlisted,
                location: loaded.directory,
                resolver: resolver
            )
        case .file(let path):
            let url = URL(fileURLWithPath: path)
            let data = try FileAccess.readRegularFile(url, limit: Limits.sourceBytes, missing: .notFound(path))
            guard let source = String(data: data, encoding: .utf8) else { throw StoreError.notUTF8 }
            return DocumentSnapshot(
                reference: reference,
                title: url.lastPathComponent,
                source: source,
                digest: Digest.sha256(data),
                bytes: data.count,
                document: nil,
                record: nil,
                revisions: [],
                olderRevisionsUnlisted: false,
                location: url,
                resolver: DirectoryAssetResolver(directory: url.deletingLastPathComponent())
            )
        }
    }

    /// The current revision number of a stored document, or the digest of a plain file, used to
    /// tell whether an update is available without loading the document.
    public static func currentMarker(_ reference: DocumentReference) -> String? {
        switch reference {
        case .stored(let root, _, let id):
            guard let store = try? DirectoryStore(root: URL(fileURLWithPath: root)),
                  let record = try? store.document(id) else { return nil }
            return String(record.revision)
        case .file(let path):
            guard let data = try? FileAccess.readRegularFile(URL(fileURLWithPath: path), limit: Limits.sourceBytes, missing: .notFound(path)) else { return nil }
            return Digest.sha256(data)
        }
    }
}

extension OpenTarget {
    public var reference: DocumentReference {
        switch self {
        case .stored(let store, let request, _):
            .stored(root: FileAccess.canonicalPath(store.root.path), storeId: store.storeId, document: request.document)
        case .plainFile(let url):
            .file(path: FileAccess.canonicalPath(url.path))
        }
    }
}
