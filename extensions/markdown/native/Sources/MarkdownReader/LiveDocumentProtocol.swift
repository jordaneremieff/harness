import EditorFeature
import MacPlatform
import MarkdownCore

struct LiveTextEdit: Codable, Sendable {
    var start: Int
    var end: Int
    var expected: String
    var replacement: String
}

struct LiveCommand: Codable, Sendable {
    var requestId: String
    var workspace: String
    var document: String
    var op: String
    var operationId: String?
    var baseGeneration: UInt64?
    var baseDigest: String?
    var edits: [LiveTextEdit]?
}

struct LiveAssetIdentity: Codable, Sendable {
    var reference: String
    var digest: String
}

struct LiveResult: Codable, Sendable {
    var status: String
    var message: String?
    var source: String?
    var generation: UInt64?
    var digest: String?
    var assets: [LiveAssetIdentity]?
    var operationId: String?
    var retained: Bool?
}

extension EditorWorkspace {
    func startCollaboration(_ configuration: CollaborationConfiguration) {
        guard collaboration == nil else { return }
        let client = CollaborationClient(configuration: configuration, workspace: id, document: liveDocumentID) { [weak self] command in
            guard let self else { return LiveResult(status: "closed", message: "The workspace closed.") }
            return await self.handleLive(command)
        }
        collaboration = client
        client.start()
    }

    func handleLive(_ command: LiveCommand) async -> LiveResult {
        guard command.workspace == id.uuidString, command.document == liveDocumentID.uuidString, !closing else {
            return LiveResult(status: "closed", message: "This document handle is no longer active.")
        }
        guard !libraryVisible, publishedLibrary == nil else { return LiveResult(status: "busy", message: "Select a document first.") }
        if command.op == "read" {
            if let reading, let snapshot = reading.snapshot {
                return LiveResult(status: "ok", source: snapshot.source, generation: 0, digest: snapshot.digest,
                    assets: snapshot.record?.references?.items?.compactMap { item in item.digest.map { LiveAssetIdentity(reference: item.reference, digest: $0) } } ?? [])
            }
            guard let document = active else { return LiveResult(status: "busy", message: "The document has not opened yet.") }
            let record = document.session.record, source = document.text.source, generation = document.text.generation
            var assets: [LiveAssetIdentity] = []
            let base: StoredEditBase? = switch record.destination { case .published(let base), .copy(let base): base; default: nil }
            if let base {
                do {
                    assets = try await Task.detached {
                        try DirectoryStore(root: URL(fileURLWithPath: base.root)).loadRevision(base.document, revision: base.revision).record.references?.items?.compactMap { item in item.digest.map { LiveAssetIdentity(reference: item.reference, digest: $0) } } ?? []
                    }.value
                } catch { return LiveResult(status: "error", message: "The retained asset inventory is unavailable.") }
            }
            guard command.document == liveDocumentID.uuidString, !closing else { return LiveResult(status: "closed", message: "The document changed during the read.") }
            for image in record.stagedAssets ?? [] {
                assets.removeAll { $0.reference == image.reference }
                assets.append(LiveAssetIdentity(reference: image.reference, digest: image.digest))
            }
            return LiveResult(status: "ok", source: source, generation: generation,
                digest: Digest.sha256(Data(source.utf8)), assets: assets)
        }
        guard command.op == "apply", let operation = command.operationId, UUID(uuidString: operation) != nil,
              let generation = command.baseGeneration, let digest = command.baseDigest,
              let edits = command.edits, !edits.isEmpty, edits.count <= 128 else {
            return LiveResult(status: "error", message: "The edit request is invalid.")
        }
        // The request itself defines the replay identity, excluding delivery request IDs.
        struct Input: Encodable { let generation: UInt64; let digest: String; let edits: [LiveTextEdit] }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let encoded = try? encoder.encode(Input(generation: generation, digest: digest, edits: edits)) else {
            return LiveResult(status: "error", message: "The edit request is invalid.")
        }
        let inputDigest = Digest.sha256(encoded)
        if let reading {
            guard let snapshot = reading.snapshot, generation == 0, digest == snapshot.digest else {
                return LiveResult(status: "stale", message: "Read the current document before editing it.")
            }
            guard Self.valid(edits, source: snapshot.source) else { return LiveResult(status: "error", message: "The edit ranges do not match the exact source.") }
            guard await editReading(copy: snapshot.document?.kind != .published) else {
                return LiveResult(status: "error", message: notice ?? "The document could not enter its live workspace.")
            }
            active?.readingDraft = true
            active?.schedulePreview(force: true)
        }
        guard command.document == liveDocumentID.uuidString, !closing else { return LiveResult(status: "closed", message: "The document changed before the edit.") }
        guard let document = active else { return LiveResult(status: "closed", message: "The document is no longer open.") }
        if let receipt = document.session.record.liveReceipts?.first(where: { $0.operationId == operation }) {
            guard receipt.inputDigest == inputDigest else { return LiveResult(status: "error", message: "This operation identity names another edit.") }
            guard await document.session.persistLiveReceipt(receipt) else { return LiveResult(status: "error", message: "The edit exists locally, but recovery is not confirmed. Retry this same operation.") }
            return LiveResult(status: "applied", generation: receipt.generation, digest: receipt.digest, operationId: operation, retained: true)
        }
        guard (document.session.record.liveReceipts?.count ?? 0) < 1024 else {
            return LiveResult(status: "error", message: "The retained live-operation limit was reached. The draft remains intact.")
        }
        guard document.text.generation == generation, Digest.sha256(Data(document.text.source.utf8)) == digest else {
            return LiveResult(status: "stale", message: "The human changed this document. Read the current buffer and revise the edit.")
        }
        guard !document.text.hasMarkedText, !document.stagingImages, !document.replacing else {
            return LiveResult(status: "busy", message: "Native composition or an asset operation is active. Retry the same operation later.")
        }
        guard Self.valid(edits, source: document.text.source) else {
            return LiveResult(status: "error", message: "The edit ranges overlap or do not match the exact source.")
        }
        let mutations = edits.map { MarkdownSourceEdit(range: NSRange(location: $0.start, length: $0.end - $0.start), expected: $0.expected, replacement: $0.replacement) }
        guard document.text.apply(edits: mutations, expectedGeneration: generation, selection: nil, actionName: "Agent Edit") else {
            return LiveResult(status: "busy", message: "The native editor refused this edit. Read its current buffer before retrying.")
        }
        let receipt = LiveEditReceipt(operationId: operation, inputDigest: inputDigest, generation: document.text.generation, digest: Digest.sha256(Data(document.text.source.utf8)))
        document.session.retainLiveReceipt(receipt)
        guard await document.session.persistLiveReceipt(receipt) else {
            return LiveResult(status: "error", message: "The edit exists locally, but recovery is not confirmed. Retry this same operation.")
        }
        schedulePersistence(document)
        return LiveResult(status: "applied", generation: receipt.generation, digest: receipt.digest, operationId: operation, retained: true)
    }

    private static func valid(_ edits: [LiveTextEdit], source: String) -> Bool {
        let text = source as NSString
        var previousEnd = -1, previousStart = -1, bytes = source.utf8.count
        for edit in edits.sorted(by: { $0.start < $1.start }) {
            guard edit.start >= 0, edit.end >= edit.start, edit.end <= text.length,
                  edit.start > previousEnd, edit.start != previousStart,
                  Range(NSRange(location: edit.start, length: edit.end - edit.start), in: source) != nil,
                  text.substring(with: NSRange(location: edit.start, length: edit.end - edit.start)) == edit.expected else { return false }
            bytes += edit.replacement.utf8.count - edit.expected.utf8.count
            previousEnd = edit.end - 1; previousStart = edit.start
        }
        return bytes <= Limits.sourceBytes
    }
}
