import Foundation

struct ReviewDraftSnapshot: Sendable, Equatable {
    let version: Int
    let draft: Data?
}

/// A private recovery slot, independent of delivered review records. Its version advances
/// even on an empty clear, so an older pending save cannot restore a consumed batch.
struct ReviewDraftStore: Sendable {
    let directory: URL
    static let byteLimit = 4 * 1024 * 1024
    // The page passes versions as JavaScript numbers.
    private static let lastVersion = 9_007_199_254_740_991

    func load(scope: ReviewScope) throws -> ReviewDraftSnapshot {
        try read(ReviewRecordFile(directory: directory, scope: scope, suffix: ".draft.json"))
    }

    func set(scope: ReviewScope, expectedVersion: Int, draft: Data?) throws -> ReviewDraftSnapshot {
        guard (0...Self.lastVersion).contains(expectedVersion) else { throw ReviewStoreError.invalid }
        if let draft { try Self.validate(draft) }
        let file = try ReviewRecordFile(directory: directory, scope: scope, suffix: ".draft.json")
        return try file.withWriter {
            let prior = try read(file)
            guard prior.version == expectedVersion else { throw ReviewStoreError.stale }
            guard prior.version < Self.lastVersion else { throw ReviewStoreError.limit }
            let version = prior.version + 1
            // Embed the original object bytes, including their Unicode spelling and whitespace.
            var bytes = Data("[\(version),".utf8)
            bytes.append(draft ?? Data("null".utf8))
            bytes.append(0x5D)
            try file.replace(bytes)
            return ReviewDraftSnapshot(version: version, draft: draft)
        }
    }

    private func read(_ file: ReviewRecordFile) throws -> ReviewDraftSnapshot {
        let versionDigits = String(Self.lastVersion).count
        guard let bytes = try file.read(limit: Self.byteLimit + versionDigits + 3) else {
            return ReviewDraftSnapshot(version: 0, draft: nil)
        }
        // The envelope is [decimal version, raw object or null], with no padding outside the payload.
        guard bytes.first == 0x5B, bytes.last == 0x5D,
              let comma = bytes.prefix(versionDigits + 2).firstIndex(of: 0x2C),
              let version = Int(String(decoding: bytes[1..<comma], as: UTF8.self)), (1...Self.lastVersion).contains(version),
              bytes[1..<comma].elementsEqual(String(version).utf8) else { throw ReviewStoreError.invalid }
        let body = bytes[(comma + 1)..<(bytes.endIndex - 1)]
        if body.elementsEqual("null".utf8) { return ReviewDraftSnapshot(version: version, draft: nil) }
        let draft = Data(body)
        try Self.validate(draft)
        return ReviewDraftSnapshot(version: version, draft: draft)
    }

    private static func validate(_ draft: Data) throws {
        guard draft.count <= byteLimit else { throw ReviewStoreError.limit }
        // JSONSerialization also accepts other Unicode encodings. Require a UTF-8 object here.
        guard String(data: draft, encoding: .utf8) != nil, !draft.contains(0),
              (try? JSONSerialization.jsonObject(with: draft)) is [String: Any] else { throw ReviewStoreError.invalid }
    }
}
