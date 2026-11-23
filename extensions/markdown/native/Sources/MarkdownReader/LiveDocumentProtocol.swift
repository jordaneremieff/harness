import Foundation
import EditorFeature
import MarkdownCore
import ReaderFeature

struct LiveTextEdit: Codable, Sendable {
    var start: Int
    var end: Int
    var expected: String
    var replacement: String
    var sourceEdit: MarkdownSourceEdit { .init(range: NSRange(location: start, length: end - start), expected: expected, replacement: replacement) }
}

struct LiveClaimRange: Codable, Sendable { var start: Int; var end: Int }

/// The last accepted page, or a loading surface that cannot yet confirm a document.
struct LivePaneView: Codable, Equatable, Sendable {
    var kind: String
    var title: String
    var mode: String
    var dirty: Bool
    var conflict: Bool
    var storeId: String?
    var documentId: String?
    var revision: Int?
    var digest: String?

    static let loading = Self(kind: "loading", title: "Opening document", mode: "reading", dirty: false, conflict: false)
}

struct LiveCommand: Codable, Sendable {
    var requestId: String
    var workspace: String
    var document: String
    var op: String
    var storeId: String?
    var documentId: String?
    var revision: Int?
    var digest: String?
    var operationId: String?
    var baseGeneration: UInt64?
    var baseDigest: String?
    var edits: [LiveTextEdit]?
    var ranges: [LiveClaimRange]?
    var label: String?
    var claimId: String?
}

struct LiveAssetIdentity: Codable, Sendable { var reference: String; var digest: String }

struct LiveResult: Codable, Sendable {
    var status: String
    var workspace: String?
    var document: String?
    var handle: String?
    var view: LivePaneView?
    var message: String?
    var source: String?
    var generation: UInt64?
    var digest: String?
    var assets: [LiveAssetIdentity]?
    var operationId: String?
    var retained: Bool?
    var claimId: String?
    var expiresAt: Double?
    var reason: String?
}

struct WebPageChange: Sendable {
    var baseGeneration: UInt64
    var generation: UInt64
    var origin: String
    var operationId: String?
    var edits: [MarkdownSourceEdit]
}

enum WebAgentApplyResult {
    case accepted(WebPageChange)
    case refused(reason: String, range: NSRange? = nil)
}

struct WebPageAck {
    let generation: UInt64
    let digest: String
    let copied: Bool
    let recoveryRetained: Bool
}

enum WebMirrorError: Error { case closed, invalidChange, stale, copyFailed }
struct WebObservedChange {
    let change: WebPageChange
    let digest: String
    let document: UUID
}
struct WebPendingLiveEdit {
    let document: UUID
    let inputDigest: String
    let generation: UInt64
    let edits: [MarkdownSourceEdit]
}
struct WebLiveClaim {
    let document: UUID
    let expiresAt: Date
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

    /// The only page-to-native mutation path. An acknowledgement follows recovery retention.
    func receivePageChange(_ change: WebPageChange) async throws -> WebPageAck {
        guard !closing, !pageChangeInProgress else { throw WebMirrorError.closed }
        guard ["person", "agent", "history"].contains(change.origin), change.baseGeneration < UInt64.max,
              change.generation == change.baseGeneration + 1,
              change.operationId == nil || (change.operationId!.utf8.count <= 128 && !change.operationId!.isEmpty),
              change.origin != "agent" || change.operationId != nil else { throw WebMirrorError.invalidChange }
        let identity = liveDocumentID
        if change.origin == "agent", let operation = change.operationId {
            guard issuedPageOperations[operation] == identity else { throw WebMirrorError.closed }
        }
        let source: String
        let generation: UInt64
        if let reading, let snapshot = reading.snapshot { source = snapshot.source; generation = 0 }
        else if let document = active { source = document.text.source; generation = document.text.generation }
        else { throw WebMirrorError.closed }
        guard generation == change.baseGeneration else { throw WebMirrorError.stale }
        guard let nextSource = MirrorText.applying(change.edits, to: source) else { throw WebMirrorError.invalidChange }
        if change.origin == "agent", let operation = change.operationId, observedPageChanges[operation] != nil { throw WebMirrorError.invalidChange }
        if change.origin == "agent", let operation = change.operationId, let pending = pendingLiveEdits[operation] {
            guard pending.document == identity, pending.generation == generation, Self.equalEdits(pending.edits, change.edits) else { throw WebMirrorError.invalidChange }
        }
        pageChangeInProgress = true
        defer { pageChangeInProgress = false }
        let imageAdoption = try await prepareImageAdoption(source: nextSource, identity: identity)
        guard identity == liveDocumentID, !closing else { throw WebMirrorError.closed }
        var copied = false
        if let reading {
            copied = reading.snapshot?.document?.kind != .published
            guard await editReading(copy: copied, pagePromotion: true) else { throw WebMirrorError.copyFailed }
        }
        guard identity == liveDocumentID, !closing, let document = active else { throw WebMirrorError.closed }
        guard document.text.generation == change.baseGeneration, document.text.source.utf8.elementsEqual(source.utf8) else { throw WebMirrorError.stale }
        if let imageAdoption {
            document.session.retainImages(root: imageAdoption.root.path, images: imageAdoption.images)
        }
        guard document.text.apply(edits: change.edits, expectedGeneration: change.baseGeneration) else { throw WebMirrorError.stale }
        if let imageAdoption {
            document.session.consumeImages(imageAdoption.images.map(\.reference))
            finishImageAdoption(imageAdoption)
        }
        let digest = document.text.digest
        if change.origin == "agent", let operation = change.operationId {
            observedPageChanges[operation] = WebObservedChange(change: change, digest: digest, document: identity)
            if let pending = pendingLiveEdits[operation] {
                document.session.retainLiveReceipt(.init(operationId: operation, inputDigest: pending.inputDigest, generation: change.generation, digest: digest))
                pendingLiveEdits[operation] = nil
            }
            if observedPageChanges.count > 1024, let oldest = observedPageChanges.keys.first(where: { $0 != operation }) {
                observedPageChanges[oldest] = nil
            }
        }
        let retained = await document.session.persist()
        schedulePersistence(document)
        return WebPageAck(generation: change.generation, digest: digest, copied: copied, recoveryRetained: retained)
    }

    func applyThroughPage(_ edits: [MarkdownSourceEdit], generation: UInt64, document: WorkingDocument) async -> Bool {
        guard isDisplayed(document), !closing, webReady, !pageBusy, !pageChangeInProgress, !liveApplyInProgress, let webAgentApply,
              !overlapsHold(edits.map(\.range)), document.text.generation == generation else { return false }
        liveApplyInProgress = true
        defer { liveApplyInProgress = false }
        let operation = UUID().uuidString, identity = liveDocumentID
        registerPageOperation(operation)
        let result = await webAgentApply(operation, generation, edits)
        guard case .accepted(let change) = result, identity == liveDocumentID,
              matchesObserved(change, operation: operation, generation: generation, edits: edits) != nil else { return false }
        return true
    }

    private func registerPageOperation(_ operation: String) {
        issuedPageOperations[operation] = liveDocumentID
        if issuedPageOperations.count > 4096,
           let retired = issuedPageOperations.keys.first(where: { $0 != operation && pendingLiveEdits[$0] == nil }) {
            issuedPageOperations[retired] = nil
        }
    }

    private func matchesObserved(_ change: WebPageChange, operation: String, generation: UInt64,
                                 edits: [MarkdownSourceEdit]) -> WebObservedChange? {
        guard change.operationId == operation, change.origin == "agent", change.baseGeneration == generation,
              generation < UInt64.max, change.generation == generation + 1,
              let observed = observedPageChanges[operation], observed.document == liveDocumentID,
              observed.change.generation == change.generation,
              Self.equalEdits(change.edits, edits), Self.equalEdits(observed.change.edits, edits) else { return nil }
        return observed
    }

    private static func equalEdits(_ a: [MarkdownSourceEdit], _ b: [MarkdownSourceEdit]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy {
            $0.range == $1.range && $0.expected.utf8.elementsEqual($1.expected.utf8) && $0.replacement.utf8.elementsEqual($1.replacement.utf8)
        }
    }

    private func overlapsHold(_ ranges: [NSRange]) -> Bool {
        guard let held = pageHeld else { return false }
        let passage = ReaderBridgeRange(start: held.location, end: NSMaxRange(held))
        return ranges.contains { ReaderBridgeRange(start: $0.location, end: NSMaxRange($0)).overlaps(passage) }
    }

    private func heldResult() -> LiveResult {
        webHeldRefusal?()
        let range = pageHeld ?? NSRange(location: 0, length: 0)
        return LiveResult(status: "busy", message: "The person has this passage open for writing (UTF-16 \(range.location)–\(NSMaxRange(range))). Read again after they leave it, or edit elsewhere.", reason: "held")
    }

    func expireClaims(now: Date = Date()) {
        for (claim, value) in liveClaims where value.expiresAt <= now || value.document != liveDocumentID {
            liveClaims[claim] = nil; webRelease?(claim)
        }
    }

    private func releaseClaims(document: UUID) {
        for (claim, value) in liveClaims where value.document == document {
            liveClaims[claim] = nil; webRelease?(claim)
        }
    }

    func handleLive(_ command: LiveCommand) async -> LiveResult {
        guard command.workspace == id.uuidString, command.document == liveDocumentID.uuidString, !closing else {
            return LiveResult(status: "closed", message: "This document handle is no longer active.")
        }
        expireClaims()
        guard !libraryVisible, publishedLibrary == nil else { return LiveResult(status: "busy", message: "Select a document first.") }
        if command.op == "release" {
            guard let claim = command.claimId, let value = liveClaims[claim], value.document == liveDocumentID else {
                return LiveResult(status: "error", message: "The claim is not active for this document.")
            }
            liveClaims[claim] = nil; webRelease?(claim)
            return LiveResult(status: "released", claimId: claim)
        }
        if command.op == "read" { return await readLive(command) }
        let source: String, generation: UInt64, digest: String
        if let reading, let snapshot = reading.snapshot { source = snapshot.source; generation = 0; digest = snapshot.digest }
        else if let document = active { source = document.text.source; generation = document.text.generation; digest = document.text.digest }
        else { return LiveResult(status: "busy", message: "The document has not opened yet.") }
        if command.op == "claim" {
            guard let ranges = command.ranges, !ranges.isEmpty, ranges.count <= 16,
                  command.label.map({ $0.count <= 80 }) ?? true,
                  ranges.allSatisfy({ $0.start >= 0 && $0.end >= $0.start && $0.end <= source.utf16.count }) else {
                return LiveResult(status: "error", message: "The claim ranges are invalid.")
            }
            guard command.baseGeneration == generation, command.baseDigest == digest else { return LiveResult(status: "stale", message: "Read the current document before claiming a passage.") }
            guard webReady, !pageBusy, !pageChangeInProgress else { return LiveResult(status: "busy", message: "The document page is not ready.") }
            let values = ranges.map { NSRange(location: $0.start, length: $0.end - $0.start) }
            guard values.allSatisfy({ MirrorText.validRange($0, source: source) }) else { return LiveResult(status: "error", message: "A claim splits a Unicode character.") }
            if overlapsHold(values) { return heldResult() }
            guard liveClaims.count < 128 else { return LiveResult(status: "busy", message: "Release an active claim before claiming another passage.") }
            let claim = UUID().uuidString, expires = Date().addingTimeInterval(90)
            liveClaims[claim] = WebLiveClaim(document: liveDocumentID, expiresAt: expires)
            webClaim?(claim, values, command.label, expires)
            Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(90)) } catch { return }
                self?.expireClaims()
            }
            return LiveResult(status: "claimed", claimId: claim, expiresAt: expires.timeIntervalSince1970 * 1000)
        }
        guard command.op == "apply", let operation = command.operationId, UUID(uuidString: operation) != nil,
              let baseGeneration = command.baseGeneration, let baseDigest = command.baseDigest,
              let edits = command.edits, !edits.isEmpty, edits.count <= 128 else {
            return LiveResult(status: "error", message: "The edit request is invalid.")
        }
        struct Input: Encodable { let generation: UInt64; let digest: String; let edits: [LiveTextEdit] }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let encoded = try? encoder.encode(Input(generation: baseGeneration, digest: baseDigest, edits: edits)) else { return LiveResult(status: "error", message: "The edit request is invalid.") }
        let inputDigest = Digest.sha256(encoded)
        if let pending = pendingLiveEdits[operation], pending.inputDigest != inputDigest {
            return LiveResult(status: "error", message: "This operation identity names another edit.")
        }
        if let document = active, reading == nil,
           let receipt = document.session.record.liveReceipts?.first(where: { $0.operationId == operation }) {
            guard receipt.inputDigest == inputDigest else { return LiveResult(status: "error", message: "This operation identity names another edit.") }
            guard await document.session.persistLiveReceipt(receipt) else { return recoveryFailure() }
            releaseClaims(document: liveDocumentID)
            return LiveResult(status: "applied", generation: receipt.generation, digest: receipt.digest, operationId: operation, retained: true)
        }
        guard (active?.session.record.liveReceipts?.count ?? 0) < 1024 else { return LiveResult(status: "error", message: "The retained live-operation limit was reached. The draft remains intact.") }
        guard generation == baseGeneration, digest == baseDigest else { return LiveResult(status: "stale", message: "The document changed. Read the current buffer and revise the edit.") }
        guard webReady, let webAgentApply else { return LiveResult(status: "busy", message: "The document has not opened yet.") }
        guard !pageBusy, !pageChangeInProgress, !liveApplyInProgress, active?.stagingImages != true else { return LiveResult(status: "busy", message: "Page changes or an asset operation are in progress.") }
        guard edits.allSatisfy({ $0.start >= 0 && $0.end >= $0.start && $0.end <= source.utf16.count }) else { return LiveResult(status: "error", message: "The edit ranges are invalid.") }
        let mutations = edits.map(\.sourceEdit)
        guard MirrorText.applying(mutations, to: source) != nil else { return LiveResult(status: "error", message: "The edit ranges overlap or do not match the exact source.") }
        if overlapsHold(mutations.map(\.range)) { return heldResult() }
        guard pendingLiveEdits[operation] != nil || pendingLiveEdits.count < 1024 else {
            return LiveResult(status: "error", message: "The pending live-operation limit was reached.")
        }
        pendingLiveEdits[operation] = WebPendingLiveEdit(document: liveDocumentID, inputDigest: inputDigest, generation: generation, edits: mutations)
        liveApplyInProgress = true
        defer { liveApplyInProgress = false }
        let identity = liveDocumentID
        registerPageOperation(operation)
        let result = await webAgentApply(operation, generation, mutations)
        guard identity == liveDocumentID, !closing else { return LiveResult(status: "closed", message: "The document changed before the edit completed.") }
        let acceptedChange: WebPageChange?
        switch result {
        case .accepted(let change): acceptedChange = change
        case .refused: acceptedChange = observedPageChanges[operation]?.change
        }
        if let change = acceptedChange,
           let observed = matchesObserved(change, operation: operation, generation: generation, edits: mutations), let document = active {
            let receipt = document.session.record.liveReceipts?.first(where: { $0.operationId == operation })
                ?? LiveEditReceipt(operationId: operation, inputDigest: inputDigest, generation: change.generation, digest: observed.digest)
            if document.session.record.liveReceipts?.contains(where: { $0.operationId == operation }) != true {
                document.session.retainLiveReceipt(receipt)
            }
            guard await document.session.persistLiveReceipt(receipt) else { return recoveryFailure() }
            releaseClaims(document: identity)
            schedulePersistence(document)
            return LiveResult(status: "applied", generation: receipt.generation, digest: receipt.digest, operationId: operation, retained: true)
        }
        switch result {
        case .refused(let reason, let range):
            if reason == "held" {
                pendingLiveEdits[operation] = nil
                let held = range ?? pageHeld ?? NSRange(location: 0, length: 0)
                return LiveResult(status: "busy", message: "The person has this passage open for writing (UTF-16 \(held.location)–\(NSMaxRange(held))). Read again after they leave it, or edit elsewhere.", reason: "held")
            }
            if reason == "stale" { pendingLiveEdits[operation] = nil }
            return LiveResult(status: reason == "stale" ? "stale" : "uncertain", message: "The page refused the edit: " + reason)
        case .accepted:
            return LiveResult(status: "uncertain", message: "The page edit is not confirmed in the native mirror. Read before retrying this operation.")
        }
    }

    private func recoveryFailure() -> LiveResult {
        LiveResult(status: "error", message: "The edit exists locally, but recovery is not confirmed. Retry this same operation.")
    }

    private func readLive(_ command: LiveCommand) async -> LiveResult {
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
        return LiveResult(status: "ok", source: source, generation: generation, digest: Digest.sha256(Data(source.utf8)), assets: assets)
    }
}
