import MarkdownCore

public struct DraftListing: Sendable {
    public var records: [DraftRecord]
    public var issues: [String]
    public var nextOffset: Int?
}

/// Every live edit session writes its own branch. Resuming a record creates a new branch rather
/// than taking ownership of another process's recovery file. No draft expires or is cache-evicted.
public actor DraftStore {
    public let directory: URL
    // Source and saved source can each expand sixfold in JSON; pending request data is base64.
    private static let recordBytes = Limits.sourceBytes * 24 + Limits.recordBytes * 4
    private var written: [UUID: UInt64] = [:]
    public init(directory: URL) { self.directory = directory }

    public func save(_ record: DraftRecord) throws {
        if let mutation = written[record.branch], mutation >= record.mutation { return }
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let root = directory.appendingPathComponent(record.id.uuidString, isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        let target = root.appendingPathComponent(record.branch.uuidString + ".json")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let data = try encoder.encode(record)
        guard data.count <= Self.recordBytes else { throw StoreError.tooLarge(name: "Private draft", bytes: data.count, limit: Self.recordBytes) }
        // Atomic replacement preserves the last completed snapshot if the process ends mid-write.
        try data.write(to: target, options: [.atomic, .completeFileProtectionUnlessOpen])
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        written[record.branch] = record.mutation
    }

    public func load(id: UUID, branch: UUID) throws -> DraftRecord {
        let file = directory.appendingPathComponent(id.uuidString).appendingPathComponent(branch.uuidString + ".json")
        // Recovery is user work: unlike source import, it is not rejected at the renderer's limit.
        let data = try FileAccess.readRegularFile(file, limit: Self.recordBytes, missing: .notFound("draft"))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let record = try decoder.decode(DraftRecord.self, from: data)
        guard record.version == 1, record.id == id, record.branch == branch else { throw StoreError.unreadable("Draft identity or version differs.") }
        return record
    }

    /// Pages a bounded directory scan; incomplete and unreadable coverage stays visible.
    public func list(offset: Int = 0, limit: Int = 20) throws -> DraftListing {
        guard FileManager.default.fileExists(atPath: directory.path) else { return DraftListing(records: [], issues: [], nextOffset: nil) }
        guard let iterator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
            throw StoreError.unreadable("The private draft directory cannot be listed.")
        }
        var records: [DraftRecord] = [], issues: [String] = []
        var scanned = 0, selected = 0
        while let url = iterator.nextObject() as? URL {
            scanned += 1
            if scanned > 4000 { issues.append("The draft scan stopped after 4000 entries; no draft was removed."); break }
            guard url.pathExtension == "json", let branch = UUID(uuidString: url.deletingPathExtension().lastPathComponent),
                  let id = UUID(uuidString: url.deletingLastPathComponent().lastPathComponent) else { continue }
            selected += 1
            if selected <= offset { continue }
            if selected > offset + min(max(limit, 1), 20) { return DraftListing(records: records, issues: issues, nextOffset: selected - 1) }
            do { records.append(try load(id: id, branch: branch)) }
            catch { issues.append("\(branch.uuidString): \(error)") }
        }
        records.sort { $0.updatedAt > $1.updatedAt }
        return DraftListing(records: records, issues: issues, nextOffset: nil)
    }
}
