import Darwin
import Foundation
import MarkdownCore
import Observation
import OSLog

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

struct ReadingStateFile: Codable, Sendable {
    var version = 1
    var positions: [String: ReadingPosition] = [:]
    var recents: [RecentDocument] = []
    var knownRoots: [String] = []
    var settings = PageSettings()
}

public enum ReadingStateFlushResult: Sendable, Equatable {
    case saved
    case notSaved(reason: String)
    case unconfirmed(reason: String)
    case nothingToSave

    package func logFailure() {
        let log = Logger(subsystem: "local.harness.markdown-reader", category: "reading-state")
        switch self {
        case .notSaved(let reason): log.error("State was not saved: \(reason, privacy: .public)")
        case .unconfirmed(let reason): log.error("State save was not confirmed: \(reason, privacy: .public)")
        case .saved, .nothingToSave: break
        }
    }
}

/// The deadline and writer decide atomically whether an attempt still has permission to write.
private final class SaveProgress: @unchecked Sendable {
    private enum Phase { case preparing, abandoned, writing, published, failed(String) }
    private let lock = NSLock()
    private var phase = Phase.preparing
    private var recovery: URL?

    var keptFile: URL? { lock.withLock { recovery } }
    func recovered(to url: URL) { lock.withLock { recovery = url } }

    func checkAbandoned() throws {
        try lock.withLock {
            if case .abandoned = phase { throw Failure("The save deadline expired before the write.") }
        }
    }

    func beginWriting() throws {
        try lock.withLock {
            if case .abandoned = phase { throw Failure("The save deadline expired before the write.") }
            phase = .writing
        }
    }

    func published() { lock.withLock { phase = .published } }
    func failed(_ reason: String) {
        lock.withLock {
            if case .published = phase { return }
            phase = .failed(reason)
        }
    }

    func deadlineResult() -> ReadingStateFlushResult {
        lock.withLock {
            switch phase {
            case .preparing:
                phase = .abandoned
                return .notSaved(reason: "The save deadline expired before the write.")
            case .abandoned: return .notSaved(reason: "The save deadline expired before the write.")
            case .writing: return .unconfirmed(reason: "The save deadline expired during the write.")
            case .published: return .saved
            case .failed(let reason): return .notSaved(reason: reason)
            }
        }
    }

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ reason: String) { errorDescription = reason }
    }
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
    nonisolated public static let positionLimit = 500
    nonisolated public static let recentLimit = 30
    nonisolated public static let rootLimit = 20
    /// Largest state file the reader decodes; a larger file is kept during recovery.
    nonisolated public static let fileLimit = 1024 * 1024

    @ObservationIgnored private let file: URL?
    @ObservationIgnored private let writer = DispatchQueue(label: "markdown.reading-state.writer", qos: .utility)
    @ObservationIgnored private let beforeWrite: @Sendable () throws -> Void
    @ObservationIgnored private let writing: @Sendable () throws -> Void
    @ObservationIgnored private let afterPublish: @Sendable () -> Void
    @ObservationIgnored private var activeSave: (covered: UInt64, progress: SaveProgress)?
    @ObservationIgnored private var retryDelay: TimeInterval = 1
    @ObservationIgnored private var scheduledSave: Task<Void, Never>?
    @ObservationIgnored private var generation: UInt64 = 0
    @ObservationIgnored private var versions: [ChangeKey: UInt64] = [:]
    @ObservationIgnored private var waiters: [UUID: FlushWaiter] = [:]
    private var state: ReadingStateFile
    public private(set) var hasPendingChanges = false
    public private(set) var isSaving = false
    /// The original corrupt state file kept by this process's most recent recovery.
    public private(set) var lastRecovery: URL?

    private enum ChangeKey: Hashable {
        case position(String), recent(String), forgotten(String), root(String), settings
    }

    private struct FlushWaiter {
        var generation: UInt64
        var continuation: CheckedContinuation<ReadingStateFlushResult, Never>
        var timer: Task<Void, Never>
    }

    private var changes: Changes {
        var result = Changes()
        for key in versions.keys {
            switch key {
            case .position(let key): result.positions.insert(key)
            case .recent(let key): result.recents.insert(key)
            case .forgotten(let key): result.forgotten.insert(key)
            case .root(let root): result.roots.insert(root)
            case .settings: result.settings = true
            }
        }
        return result
    }

    private func mark(_ key: ChangeKey) {
        guard file != nil else { return }
        generation += 1
        versions[key] = generation
        hasPendingChanges = true
    }

    /// What this process changed since its last save: document keys of positions and recents,
    /// forgotten recents, added store roots and the settings.
    struct Changes: Sendable {
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
            mark(.settings)
            scheduleSave()
        }
    }

    /// With a nil directory the state stays in memory. An unreadable state starts empty in memory;
    /// saves preserve unsupported files and read failures, and keep corrupt files before recovery.
    public convenience init(directory: URL?) {
        self.init(directory: directory, beforeWrite: {})
    }

    /// Hooks run on the writer queue under the file lock, at the named save phases.
    init(directory: URL?, beforeWrite: @escaping @Sendable () throws -> Void,
         writing: @escaping @Sendable () throws -> Void = {}, afterPublish: @escaping @Sendable () -> Void = {}) {
        file = directory?.appendingPathComponent("reading-state.json")
        self.beforeWrite = beforeWrite
        self.writing = writing
        self.afterPublish = afterPublish
        if let file, case .valid(let decoded) = Self.read(file) { state = decoded }
        else { state = ReadingStateFile() }
    }

    enum ReadOutcome {
        case missing, valid(ReadingStateFile), failed(String), unsupported, corrupt
    }

    nonisolated static func read(_ file: URL) -> ReadOutcome {
        var info = stat()
        guard lstat(file.path, &info) == 0 else {
            return errno == ENOENT ? .missing : .failed(String(cString: strerror(errno)))
        }
        let data: Data
        do {
            data = try FileAccess.readRegularFile(file, limit: fileLimit, missing: .notFound(file.lastPathComponent))
        } catch StoreError.tooLarge { return .corrupt }
        catch { return .failed(String(describing: error)) }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["version"] != nil else { return .corrupt }
        struct Header: Decodable { let version: Int }
        guard let header = try? JSONDecoder().decode(Header.self, from: data), header.version == 1 else { return .unsupported }
        guard let decoded = try? JSONDecoder.reading.decode(ReadingStateFile.self, from: data) else { return .corrupt }
        return .valid(bounded(decoded))
    }

    /// Takes in what other reader processes saved since this process last read the file, and
    /// keeps this process's unsaved changes.
    public func reload() {
        guard let file, case .valid(let disk) = Self.read(file) else { return }
        state = Self.merged(ours: state, theirs: disk, changes: changes)
    }

    /// The file's state with this process's changes applied: its changed positions and recents,
    /// its forgotten recents removed, its added roots first and its settings when it changed them.
    /// Everything else comes from the file. The later captured position wins, independently of
    /// the order in which reader processes save their changes.
    nonisolated static func merged(ours: ReadingStateFile, theirs: ReadingStateFile, changes: Changes) -> ReadingStateFile {
        var result = theirs
        for key in changes.positions {
            guard let mine = ours.positions[key] else {
                result.positions[key] = nil
                continue
            }
            if let other = theirs.positions[key], other.savedAt > mine.savedAt { continue }
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
    nonisolated static func bounded(_ decoded: ReadingStateFile) -> ReadingStateFile {
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
        mark(.position(reference.key))
        if state.positions.count > Self.positionLimit {
            let excess = state.positions.sorted { $0.value.savedAt < $1.value.savedAt }.prefix(state.positions.count - Self.positionLimit)
            for (key, _) in excess { state.positions.removeValue(forKey: key) }
        }
        scheduleSave()
    }

    public func noteOpened(_ reference: DocumentReference, title: String) {
        state.recents.removeAll { $0.reference == reference }
        state.recents.insert(RecentDocument(reference: reference, title: title, openedAt: Date()), at: 0)
        mark(.recent(reference.key))
        versions.removeValue(forKey: .forgotten(reference.key))
        if state.recents.count > Self.recentLimit { state.recents.removeLast(state.recents.count - Self.recentLimit) }
        if case .stored(let root, _, _) = reference, !state.knownRoots.contains(root) {
            state.knownRoots.insert(root, at: 0)
            mark(.root(root))
            if state.knownRoots.count > Self.rootLimit { state.knownRoots.removeLast(state.knownRoots.count - Self.rootLimit) }
        }
        scheduleSave()
    }

    public func forgetRecent(_ reference: DocumentReference) {
        state.recents.removeAll { $0.reference == reference }
        mark(.forgotten(reference.key))
        versions.removeValue(forKey: .recent(reference.key))
        scheduleSave()
    }

    private func scheduleSave(after delay: Duration = .milliseconds(400)) {
        guard hasPendingChanges, !isSaving, scheduledSave == nil else { return }
        scheduledSave = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            self?.scheduledSave = nil
            self?.saveNow()
        }
    }

    /// Requests a save without waiting for the lock or writing on the main actor.
    public func saveNow() {
        scheduledSave?.cancel()
        scheduledSave = nil
        guard let file, hasPendingChanges, !isSaving else { return }
        let snapshot = state
        let covered = generation
        let changes = changes
        let beforeWrite = beforeWrite
        let writing = writing
        let afterPublish = afterPublish
        let progress = SaveProgress()
        activeSave = (covered, progress)
        isSaving = true
        writer.async { [weak self] in
            let result = Result {
                try Self.persist(snapshot, changes: changes, file: file, progress: progress,
                                 beforeWrite: beforeWrite, writing: writing, afterPublish: afterPublish)
            }
            if case .failure(let error) = result { progress.failed(error.localizedDescription) }
            Task { @MainActor [weak self] in
                self?.finished(result, covered: covered, progress: progress)
            }
        }
    }

    /// Flushes changes present at entry. Later mutations remain pending until their own save.
    /// The deadline is independent of the writer, including a stalled filesystem operation.
    public func flush(timeout: TimeInterval) async -> ReadingStateFlushResult {
        guard hasPendingChanges else { return .nothingToSave }
        guard timeout.isFinite, timeout > 0 else { return deadlineResult(for: generation) }
        let target = generation
        let id = UUID()
        return await withCheckedContinuation { continuation in
            let timer = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
                guard let self else { return }
                self.resolve(id, with: self.deadlineResult(for: target))
            }
            waiters[id] = FlushWaiter(generation: target, continuation: continuation, timer: timer)
            saveNow()
        }
    }

    private func deadlineResult(for target: UInt64) -> ReadingStateFlushResult {
        guard let activeSave, activeSave.covered >= target else {
            return .notSaved(reason: "The save deadline expired before a covered write started.")
        }
        return activeSave.progress.deadlineResult()
    }

    private func resolve(_ id: UUID, with result: ReadingStateFlushResult) {
        guard let waiter = waiters.removeValue(forKey: id) else { return }
        waiter.timer.cancel()
        waiter.continuation.resume(returning: result)
    }

    private func finished(_ result: Result<ReadingStateFile, any Error>, covered: UInt64, progress: SaveProgress) {
        isSaving = false
        activeSave = nil
        if let keptFile = progress.keptFile { lastRecovery = keptFile }
        switch result {
        case .success(let saved):
            retryDelay = 1
            versions = versions.filter { $0.value > covered }
            state = Self.merged(ours: state, theirs: saved, changes: changes)
            hasPendingChanges = !versions.isEmpty
            let completed = waiters.filter { $0.value.generation <= covered }.map(\.key)
            for id in completed { resolve(id, with: .saved) }
            if !waiters.isEmpty { saveNow() } else { scheduleSave() }
        case .failure(let error):
            let reason = error.localizedDescription
            Logger(subsystem: "markdown.reader", category: "reading-state").error("State save failed: \(reason, privacy: .public)")
            for (id, waiter) in Array(waiters) {
                resolve(id, with: waiter.generation <= covered ? progress.deadlineResult() : .notSaved(reason: reason))
            }
            scheduleSave(after: .seconds(retryDelay))
            retryDelay = min(retryDelay * 2, 30)
        }
    }

    private struct SaveFailure: LocalizedError {
        let errorDescription: String?
        init(_ reason: String) { errorDescription = reason }
    }

    nonisolated private static func persist(
        _ snapshot: ReadingStateFile, changes: Changes, file: URL, progress: SaveProgress,
        beforeWrite: @Sendable () throws -> Void, writing: @Sendable () throws -> Void,
        afterPublish: @Sendable () -> Void
    ) throws -> ReadingStateFile {
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = open(directory.appendingPathComponent("reading-state.lock").path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw SaveFailure("Could not open the state lock: \(String(cString: strerror(errno)))") }
        defer { close(lock) }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(250))
        while flock(lock, LOCK_EX | LOCK_NB) != 0 {
            let code = errno
            try progress.checkAbandoned()
            guard code == EWOULDBLOCK || code == EINTR else {
                throw SaveFailure("Could not acquire the state lock: \(String(cString: strerror(code)))")
            }
            guard clock.now < deadline else { throw SaveFailure("The state lock remained busy.") }
            Thread.sleep(forTimeInterval: 0.01)
        }
        defer { flock(lock, LOCK_UN) }
        try progress.checkAbandoned()
        let disk: ReadingStateFile
        let corrupt: Bool
        switch Self.read(file) {
        case .missing: disk = ReadingStateFile(); corrupt = false
        case .valid(let decoded): disk = decoded; corrupt = false
        case .failed(let reason): throw SaveFailure("The state file could not be read: \(reason)")
        case .unsupported: throw SaveFailure("The state version is not supported; the file stays unchanged.")
        case .corrupt: disk = snapshot; corrupt = true
        }
        let merged = Self.merged(ours: snapshot, theirs: disk, changes: changes)
        let data = try JSONEncoder.reading.encode(merged)
        try beforeWrite()
        try progress.beginWriting()
        try writing()
        if corrupt {
            let formatter = ISO8601DateFormatter()
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            let stamp = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "-")
            let kept = directory.appendingPathComponent(file.lastPathComponent + ".unreadable-" + stamp + "-" + UUID().uuidString)
            guard renamex_np(file.path, kept.path, UInt32(RENAME_EXCL)) == 0 else {
                throw SaveFailure("Could not keep the corrupt state file: \(String(cString: strerror(errno)))")
            }
            progress.recovered(to: kept)
            Logger(subsystem: "local.harness.markdown-reader", category: "reading-state")
                .error("Kept corrupt state as \(kept.lastPathComponent, privacy: .public)")
        }
        try data.write(to: file, options: [.atomic])
        progress.published()
        afterPublish()
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return merged
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
        encoder.dateEncodingStrategy = .custom { date, encoder in
            // Preserve the precision of Date without the encoder's whole-second truncation.
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
            let seconds = date.timeIntervalSinceReferenceDate
            let whole = floor(seconds)
            let fraction = String(format: "%.9f", locale: Locale(identifier: "en_US_POSIX"), seconds - whole).dropFirst()
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: Date(timeIntervalSinceReferenceDate: whole)) + fraction + "Z")
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
