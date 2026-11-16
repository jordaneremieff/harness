import MarkdownCore
import Observation

public struct EditSelection: Codable, Equatable, Sendable {
    public var location: Int
    public var length: Int
    public init(location: Int = 0, length: Int = 0) { self.location = location; self.length = length }
}

public struct StoredEditBase: Codable, Equatable, Sendable {
    public var root: String
    public var storeId: String
    public var document: String
    public var revision: Int
    public var digest: String
    public init(root: String, storeId: String, document: String, revision: Int, digest: String) {
        self.root = root; self.storeId = storeId; self.document = document
        self.revision = revision; self.digest = digest
    }
}

public enum EditDestination: Codable, Equatable, Sendable {
    case scratchpad
    case file(FileEditBase)
    case published(StoredEditBase)
    case copy(StoredEditBase)
}

public struct EditConflict: Codable, Equatable, Sendable {
    public var message: String
    public var revision: Int?
    public var digest: String?
    public init(message: String, revision: Int? = nil, digest: String? = nil) {
        self.message = message; self.revision = revision; self.digest = digest
    }
}

/// A private recovery snapshot, not a document-store revision or reading-position cache entry.
public struct DraftRecord: Codable, Sendable, Identifiable {
    public var version = 1
    public var id: UUID
    public var branch: UUID
    public var parentBranch: UUID?
    public var title: String
    public var source: String
    public var generation: UInt64
    public var mutation: UInt64 = 0
    public var selection: EditSelection
    public var destination: EditDestination
    public var savedSource: String?
    public var conflict: EditConflict?
    public var pendingPublication: Data?
    public var updatedAt: Date

    public init(title: String = "Untitled", source: String = "", destination: EditDestination = .scratchpad, savedSource: String? = nil) {
        id = UUID(); branch = UUID(); parentBranch = nil
        self.title = title; self.source = source; generation = 0; selection = EditSelection()
        self.destination = destination; self.savedSource = savedSource; updatedAt = Date()
    }

    public func resumed() -> DraftRecord {
        var copy = self
        copy.parentBranch = branch
        copy.branch = UUID()
        return copy
    }

    public var displayTitle: String {
        if title != "Untitled" { return title }
        let first = source.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return first.isEmpty ? "Untitled Scratchpad" : String(first.prefix(80))
    }
}

public enum RecoveryState: Equatable, Sendable {
    case pending
    case current
    case failed(String)
}

/// Owns immutable snapshots and persistence state. The native text controller alone mutates text
/// and owns undo; a save acknowledgement never installs source into that controller.
@MainActor @Observable
public final class EditSession {
    public private(set) var record: DraftRecord
    public private(set) var recovery: RecoveryState = .pending
    public private(set) var saving = false
    public private(set) var error: String?
    public var isDirty: Bool { record.savedSource != record.source }
    @ObservationIgnored private let drafts: DraftStore
    @ObservationIgnored private var revision: UInt64 = 0
    @ObservationIgnored private var recoveredRevision: UInt64?
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?

    public init(record: DraftRecord = DraftRecord(), drafts: DraftStore) {
        self.record = record; self.drafts = drafts; revision = record.mutation
        scheduleRecovery()
    }

    public func receive(source: String, generation: UInt64, selection: EditSelection, markedText: Bool) {
        guard generation >= record.generation else { return }
        guard source != record.source || selection != record.selection || generation != record.generation else { return }
        record.source = source; record.generation = generation; record.selection = selection
        changed()
    }

    public func rename(_ title: String) {
        record.title = String(title.split(whereSeparator: \.isNewline).joined(separator: " ").prefix(200))
        changed()
    }

    public func setConflict(_ conflict: EditConflict) { record.conflict = conflict; changed() }
    public func setError(_ message: String?) { error = message }

    public func beginSave() -> DraftRecord? {
        guard !saving, record.pendingPublication == nil else { return nil }
        saving = true; error = nil
        return record
    }

    public func beginReconciliation() -> Data? {
        guard !saving, let pending = record.pendingPublication else { return nil }
        saving = true; error = nil
        return pending
    }

    public func finishSave(source: String, destination: EditDestination) {
        record.savedSource = source
        record.destination = destination
        record.conflict = nil
        record.pendingPublication = nil
        saving = false
        changed()
    }

    public func failSave(_ message: String) { saving = false; error = message; changed() }

    public func setPendingPublication(_ data: Data?) {
        record.pendingPublication = data
        changed()
    }

    /// A deliberate new-copy action preserves the existing record and its unresolved conflict.
    public func duplicate() -> DraftRecord {
        var copy = DraftRecord(title: record.displayTitle + " Copy", source: record.source)
        copy.selection = record.selection
        if case .published(let base) = record.destination { copy.destination = .copy(base) }
        if case .copy(let base) = record.destination { copy.destination = .copy(base) }
        return copy
    }

    private func changed() {
        revision &+= 1; record.mutation = revision; record.updatedAt = Date(); recovery = .pending
        scheduleRecovery()
    }

    private func scheduleRecovery() {
        guard recoveryTask == nil else { return }
        recoveryTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self else { return }
            _ = await self.persist()
            self.recoveryTask = nil
            if self.recoveredRevision != self.revision, case .failed = self.recovery { return }
            if self.recoveredRevision != self.revision { self.scheduleRecovery() }
        }
    }

    /// Publication needs its immutable invocation retained, not a pause in subsequent typing.
    public func persistPendingPublication(_ exact: Data) async -> Bool {
        guard record.pendingPublication == exact else { return false }
        let snapshot = record
        do {
            let receipt = try await drafts.save(snapshot)
            recoveredRevision = max(recoveredRevision ?? 0, receipt.mutation)
            recovery = recoveredRevision == revision ? .current : .pending
            return receipt.pendingPublication == exact
        } catch {
            recovery = .failed(String(describing: error))
            return false
        }
    }

    @discardableResult public func persist() async -> Bool {
        let snapshot = record
        do {
            let receipt = try await drafts.save(snapshot)
            // A concurrent flush can finish after a newer snapshot. Never move the receipt back.
            recoveredRevision = max(recoveredRevision ?? 0, receipt.mutation)
            recovery = recoveredRevision == revision ? .current : .pending
            return recoveredRevision == revision
        } catch {
            recovery = .failed(String(describing: error))
            return false
        }
    }
}
