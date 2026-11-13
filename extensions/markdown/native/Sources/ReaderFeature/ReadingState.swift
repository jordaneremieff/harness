import Foundation
import MarkdownCore
import Observation

/// Where a reader was in a document: the top visible block and the offset inside it, the
/// nearest heading above it, and the scroll ratio as the last fallback.
public struct ReadingPosition: Codable, Sendable, Equatable {
    public var blockKey: String?
    public var fraction: Double
    public var anchor: String?
    public var ratio: Double
    public var revision: Int?
    public var savedAt: Date

    public init(blockKey: String?, fraction: Double, anchor: String?, ratio: Double, revision: Int?, savedAt: Date = Date()) {
        self.blockKey = blockKey
        self.fraction = fraction
        self.anchor = anchor
        self.ratio = ratio
        self.revision = revision
        self.savedAt = savedAt
    }
}

public struct RecentDocument: Codable, Sendable, Equatable, Identifiable {
    public var reference: DocumentReference
    public var title: String
    public var openedAt: Date
    public var id: String { reference.key }
}

struct ReadingStateFile: Codable {
    var version = 1
    var positions: [String: ReadingPosition] = [:]
    var recents: [RecentDocument] = []
    var knownRoots: [String] = []
    var settings = PageSettings()
}

/// The reader's own state: reading positions, recent documents, known store roots and reading
/// settings. It lives apart from every document store and is bounded; trimming it never touches
/// a stored document.
@MainActor @Observable
public final class ReadingStateStore {
    public static let positionLimit = 500
    public static let recentLimit = 30
    public static let rootLimit = 20
    /// Largest state file the reader reads; a larger file is ignored.
    public static let fileLimit = 1024 * 1024

    @ObservationIgnored private let file: URL?
    @ObservationIgnored private var saveScheduled = false
    private var state: ReadingStateFile

    public var recents: [RecentDocument] { state.recents }
    public var knownRoots: [String] { state.knownRoots }
    public var settings: PageSettings {
        get { state.settings }
        set {
            state.settings = newValue
            scheduleSave()
        }
    }

    /// With a nil directory the state stays in memory, which the check modes use. An oversized or
    /// undecodable state file is ignored and left in place; the reader starts with empty state.
    public init(directory: URL?) {
        file = directory?.appendingPathComponent("reading-state.json")
        if let file,
           let data = try? FileAccess.readRegularFile(file, limit: Self.fileLimit, missing: .notFound(file.lastPathComponent)),
           let decoded = try? JSONDecoder.reading.decode(ReadingStateFile.self, from: data), decoded.version == 1 {
            state = Self.bounded(decoded)
        } else {
            state = ReadingStateFile()
        }
    }

    /// Applies every collection limit to decoded state: the newest positions, the first recents
    /// and known roots (both are kept newest first).
    static func bounded(_ decoded: ReadingStateFile) -> ReadingStateFile {
        var state = decoded
        if state.positions.count > positionLimit {
            let newest = state.positions.sorted { $0.value.savedAt > $1.value.savedAt }.prefix(positionLimit)
            state.positions = Dictionary(uniqueKeysWithValues: newest.map { ($0.key, $0.value) })
        }
        state.recents = Array(state.recents.prefix(recentLimit))
        state.knownRoots = Array(state.knownRoots.prefix(rootLimit))
        return state
    }

    public func position(for reference: DocumentReference) -> ReadingPosition? {
        state.positions[reference.key]
    }

    public func setPosition(_ position: ReadingPosition, for reference: DocumentReference) {
        state.positions[reference.key] = position
        if state.positions.count > Self.positionLimit {
            let excess = state.positions.sorted { $0.value.savedAt < $1.value.savedAt }.prefix(state.positions.count - Self.positionLimit)
            for (key, _) in excess { state.positions.removeValue(forKey: key) }
        }
        scheduleSave()
    }

    public func noteOpened(_ reference: DocumentReference, title: String) {
        state.recents.removeAll { $0.reference == reference }
        state.recents.insert(RecentDocument(reference: reference, title: title, openedAt: Date()), at: 0)
        if state.recents.count > Self.recentLimit { state.recents.removeLast(state.recents.count - Self.recentLimit) }
        if case .stored(let root, _, _) = reference, !state.knownRoots.contains(root) {
            state.knownRoots.insert(root, at: 0)
            if state.knownRoots.count > Self.rootLimit { state.knownRoots.removeLast(state.knownRoots.count - Self.rootLimit) }
        }
        scheduleSave()
    }

    public func forgetRecent(_ reference: DocumentReference) {
        state.recents.removeAll { $0.reference == reference }
        scheduleSave()
    }

    private func scheduleSave() {
        guard file != nil, !saveScheduled else { return }
        saveScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            self?.saveNow()
        }
    }

    public func saveNow() {
        saveScheduled = false
        guard let file else { return }
        guard let data = try? JSONEncoder.reading.encode(state) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? data.write(to: file, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

extension JSONDecoder {
    static var reading: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

extension JSONEncoder {
    static var reading: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
