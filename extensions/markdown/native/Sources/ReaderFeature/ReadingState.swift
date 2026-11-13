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
///
/// Several reader processes share one state file: the application and each pane reader. Each
/// process records which entries it changed since its last save. A save takes an exclusive lock
/// on a lock file beside the state file, applies only those changes to the file's current state
/// and replaces the file, so one process never erases another's progress.
@MainActor @Observable
public final class ReadingStateStore {
    public static let positionLimit = 500
    public static let recentLimit = 30
    public static let rootLimit = 20
    /// Largest state file the reader reads; a larger file is ignored.
    public static let fileLimit = 1024 * 1024

    @ObservationIgnored private let file: URL?
    @ObservationIgnored private var saveScheduled = false
    @ObservationIgnored private var changes = Changes()
    private var state: ReadingStateFile

    /// What this process changed since its last save: document keys of positions and recents,
    /// forgotten recents, added store roots and the settings.
    struct Changes {
        var positions: Set<String> = []
        var recents: Set<String> = []
        var forgotten: Set<String> = []
        var roots: Set<String> = []
        var settings = false
    }

    public var recents: [RecentDocument] { state.recents }
    public var knownRoots: [String] { state.knownRoots }
    public var settings: PageSettings {
        get { state.settings }
        set {
            state.settings = newValue
            changes.settings = true
            scheduleSave()
        }
    }

    /// With a nil directory the state stays in memory, which the check modes use. An oversized or
    /// undecodable state file is ignored and left in place; the reader starts with empty state.
    public init(directory: URL?) {
        file = directory?.appendingPathComponent("reading-state.json")
        state = file.flatMap(Self.read) ?? ReadingStateFile()
    }

    static func read(_ file: URL) -> ReadingStateFile? {
        guard let data = try? FileAccess.readRegularFile(file, limit: fileLimit, missing: .notFound(file.lastPathComponent)),
              let decoded = try? JSONDecoder.reading.decode(ReadingStateFile.self, from: data), decoded.version == 1
        else { return nil }
        return bounded(decoded)
    }

    /// Takes in what other reader processes saved since this process last read the file, and
    /// keeps this process's unsaved changes.
    public func reload() {
        guard let file, let disk = Self.read(file) else { return }
        state = Self.merged(ours: state, theirs: disk, changes: changes)
    }

    /// The file's state with this process's changes applied: its changed positions and recents,
    /// its forgotten recents removed, its added roots first and its settings when it changed them.
    /// Everything else comes from the file. A changed position yields only to a position in the
    /// file saved at least a second later, because the file keeps whole seconds.
    static func merged(ours: ReadingStateFile, theirs: ReadingStateFile, changes: Changes) -> ReadingStateFile {
        var result = theirs
        for key in changes.positions {
            guard let mine = ours.positions[key] else {
                result.positions[key] = nil
                continue
            }
            if let other = theirs.positions[key], other.savedAt.timeIntervalSince(mine.savedAt) >= 1 { continue }
            result.positions[key] = mine
        }
        let kept = theirs.recents.filter { !changes.forgotten.contains($0.id) && !changes.recents.contains($0.id) }
        result.recents = (kept + ours.recents.filter { changes.recents.contains($0.id) }).sorted { $0.openedAt > $1.openedAt }
        let added = ours.knownRoots.filter { changes.roots.contains($0) }
        result.knownRoots = added + theirs.knownRoots.filter { !added.contains($0) }
        if changes.settings { result.settings = ours.settings }
        return bounded(result)
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
        changes.positions.insert(reference.key)
        if state.positions.count > Self.positionLimit {
            let excess = state.positions.sorted { $0.value.savedAt < $1.value.savedAt }.prefix(state.positions.count - Self.positionLimit)
            for (key, _) in excess { state.positions.removeValue(forKey: key) }
        }
        scheduleSave()
    }

    public func noteOpened(_ reference: DocumentReference, title: String) {
        state.recents.removeAll { $0.reference == reference }
        state.recents.insert(RecentDocument(reference: reference, title: title, openedAt: Date()), at: 0)
        changes.recents.insert(reference.key)
        changes.forgotten.remove(reference.key)
        if state.recents.count > Self.recentLimit { state.recents.removeLast(state.recents.count - Self.recentLimit) }
        if case .stored(let root, _, _) = reference, !state.knownRoots.contains(root) {
            state.knownRoots.insert(root, at: 0)
            changes.roots.insert(root)
            if state.knownRoots.count > Self.rootLimit { state.knownRoots.removeLast(state.knownRoots.count - Self.rootLimit) }
        }
        scheduleSave()
    }

    public func forgetRecent(_ reference: DocumentReference) {
        state.recents.removeAll { $0.reference == reference }
        changes.forgotten.insert(reference.key)
        changes.recents.remove(reference.key)
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
        let directory = file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = open(directory.appendingPathComponent("reading-state.lock").path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        if lock >= 0 { flock(lock, LOCK_EX) }
        defer { if lock >= 0 { flock(lock, LOCK_UN); close(lock) } }
        if let disk = Self.read(file) {
            state = Self.merged(ours: state, theirs: disk, changes: changes)
        }
        guard let data = try? JSONEncoder.reading.encode(state) else { return }
        try? data.write(to: file, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        changes = Changes()
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
