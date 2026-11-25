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
    var follows = false
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
    var currentRevision: Int?
    var operationId: String?
    var baseGeneration: UInt64?
    var baseDigest: String?
    var edits: [LiveTextEdit]?
    var ranges: [LiveClaimRange]?
    var label: String?
    var claimId: String?
    var commentId: String?
    var commentState: String?
    var expectedVersion: Int?
    var offset: Int?
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
    var expiresAt: Int64?
    var reason: String?
    var commentId: String?
    var commentState: String?
    var version: Int?
    var comments: [LiveReviewComment]?
    var total: Int?
    var offset: Int?
    var nextOffset: Int?
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
struct WebExternalPageEdit {
    let operation: String
    let generation: UInt64
    let edits: [MarkdownSourceEdit]
    let canCommit: @MainActor () -> Bool
    let commit: @MainActor () -> Void
}
struct WebLiveClaim {
    let document: UUID
    let expiresAt: Date
}

extension EditorWorkspace {
    func startCollaboration(_ configuration: CollaborationConfiguration, requiresRenderedStart: Bool = false) {
        guard collaboration == nil else { return }
        let client = CollaborationClient(configuration: configuration, workspace: id, document: liveDocumentID,
            documentKey: { [weak self] in self?.logicalDocumentKey }, view: { [weak self] in self?.livePaneView ?? .loading },
            requiresRenderedStart: requiresRenderedStart) { [weak self] command in
            guard let self else { return LiveResult(status: "closed", message: "The workspace closed.") }
            guard self.webHostModel != nil else { return LiveResult(status: "busy", message: "The reader page has not opened yet.") }
            return await self.handleLive(command)
        }
        collaboration = client
        client.start()
    }

    /// The only page-to-native mutation path. An acknowledgement follows recovery retention.
    func receivePageChange(_ change: WebPageChange, presentation: String? = nil) async throws -> WebPageAck {
        func matchesPresentation() -> Bool {
            guard let presentation else { return true }
            return webHostModel?.page.presentation == presentation && webHostModel?.displayedPresentation == presentation
        }
        guard !closing, !pageChangeInProgress, matchesPresentation() else { throw WebMirrorError.closed }
        guard ["person", "agent", "history"].contains(change.origin), change.baseGeneration < UInt64.max,
              change.generation == change.baseGeneration + 1,
              change.operationId == nil || (change.operationId!.utf8.count <= 128 && !change.operationId!.isEmpty),
              change.origin != "agent" || change.operationId != nil else { throw WebMirrorError.invalidChange }
        let identity = liveDocumentID
        if change.origin == "agent", let operation = change.operationId {
            guard issuedPageOperations[operation] == identity else { throw WebMirrorError.closed }
        }
        guard let (source, generation, _) = visibleText else { throw WebMirrorError.closed }
        guard generation == change.baseGeneration else { throw WebMirrorError.stale }
        guard let nextSource = MirrorText.applying(change.edits, to: source) else { throw WebMirrorError.invalidChange }
        if change.origin == "agent", let operation = change.operationId, observedPageChanges[operation] != nil { throw WebMirrorError.invalidChange }
        if change.origin == "agent", let operation = change.operationId, let pending = pendingLiveEdits[operation] {
            guard pending.document == identity, pending.generation == generation, Self.equalEdits(pending.edits, change.edits) else { throw WebMirrorError.invalidChange }
        }
        let external = change.origin == "agent" && change.operationId == externalPageEdit?.operation ? externalPageEdit : nil
        if let external {
            guard external.generation == generation, Self.equalEdits(external.edits, change.edits), external.canCommit() else {
                throw WebMirrorError.stale
            }
        }
        pageChangeInProgress = true
        defer { pageChangeInProgress = false }
        let imageAdoption = external == nil ? try await prepareImageAdoption(source: nextSource, identity: identity) : nil
        guard identity == liveDocumentID, !closing, matchesPresentation() else { throw WebMirrorError.closed }
        var copied = false
        if let reading {
            copied = reading.snapshot?.document?.kind != .published
            guard await editReading(copy: copied, pagePromotion: true, presentation: presentation) else { throw WebMirrorError.copyFailed }
        }
        guard identity == liveDocumentID, !closing, matchesPresentation(), let document = active else { throw WebMirrorError.closed }
        guard document.text.generation == change.baseGeneration, document.text.source.utf8.elementsEqual(source.utf8) else { throw WebMirrorError.stale }
        if let imageAdoption {
            document.session.retainImages(root: imageAdoption.root.path, images: imageAdoption.images)
        }
        guard document.text.apply(edits: change.edits, expectedGeneration: change.baseGeneration) else { throw WebMirrorError.stale }
        // Commit the base and resolver before recovery, rendering, or the next page edit.
        external?.commit()
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

    func applyThroughPage(_ edits: [MarkdownSourceEdit], generation: UInt64, document: WorkingDocument,
                          external: (canCommit: @MainActor () -> Bool, commit: @MainActor () -> Void)? = nil) async -> Bool {
        guard isDisplayed(document), !closing, webReady, !pageBusy, !pageChangeInProgress, !liveApplyInProgress, let webAgentApply,
              !overlapsHold(edits.map(\.range)), document.text.generation == generation else { return false }
        liveApplyInProgress = true
        let operation = UUID().uuidString, identity = liveDocumentID
        defer {
            liveApplyInProgress = false
            if externalPageEdit?.operation == operation {
                externalPageEdit = nil
                issuedPageOperations[operation] = nil
            }
        }
        if let external {
            externalPageEdit = WebExternalPageEdit(operation: operation, generation: generation, edits: edits,
                canCommit: external.canCommit, commit: external.commit)
        }
        registerPageOperation(operation)
        let result = await webAgentApply(operation, generation, edits)
        let change: WebPageChange?
        switch result {
        case .accepted(let accepted): change = accepted
        case .refused: change = observedPageChanges[operation]?.change
        }
        guard let change, identity == liveDocumentID else { return false }
        return matchesObserved(change, operation: operation, generation: generation, edits: edits) != nil
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

    /// Never describe a selected model as a visible page before WebKit accepts it.
    var livePaneView: LivePaneView {
        guard webReady, let key = logicalDocumentKey, let model = webHostModel,
              model.page.documentReady, let presentation = model.page.presentation,
              presentation == model.displayedPresentation, model.page.documentKey == key.uuidString else { return .loading }
        let mode = model.lock.rawValue
        if let snapshot = reading?.snapshot {
            if case .stored(_, let storeId, let documentId) = snapshot.reference, let stored = snapshot.document {
                return LivePaneView(kind: stored.kind.rawValue, title: viewTitle(snapshot.title), mode: mode, dirty: false, conflict: false,
                    follows: model.followsStoredRevisions, storeId: storeId, documentId: documentId, revision: snapshot.revision, digest: snapshot.digest)
            }
            return LivePaneView(kind: "local-file", title: viewTitle(snapshot.title), mode: mode, dirty: false, conflict: false)
        }
        guard let session = active?.session else { return .loading }
        let record = session.record, title = viewTitle(record.displayTitle), conflict = record.conflict != nil
        let kind: String
        switch record.destination {
        case .published(let base):
            return LivePaneView(kind: "published", title: title, mode: mode, dirty: session.isDirty, conflict: conflict,
                follows: automaticallySaves && !conflict, storeId: base.storeId, documentId: base.document, revision: base.revision, digest: base.digest)
        case .scratchpad: kind = "scratchpad"
        case .copy: kind = "copy"
        case .file: kind = "local-file"
        }
        return LivePaneView(kind: kind, title: title, mode: mode, dirty: session.isDirty, conflict: conflict)
    }

    private func viewTitle(_ title: String) -> String {
        let line = title.components(separatedBy: CharacterSet.controlCharacters.union(.newlines)).joined(separator: " ")
        let limited = String(decoding: line.utf8.prefix(1024), as: UTF8.self).trimmingCharacters(in: .whitespaces)
        return limited.isEmpty ? "Untitled" : limited
    }

    private func navigateLive(_ command: LiveCommand) async -> LiveResult {
        guard let target = command.documentId, PaneCommand.isDocumentIdentity(target), let storeId = command.storeId,
              (command.revision == nil) == (command.digest == nil), command.revision.map({ $0 > 0 }) ?? true,
              command.currentRevision.map({ $0 > 0 && command.revision == nil }) ?? true else {
            return LiveResult(status: "error", message: "Specify a stored document and a complete revision pin.")
        }
        guard let root = selectedStore else { return LiveResult(status: "error", message: "This reader has no selected store.") }
        await drainPageChanges?()
        do {
            let actual = try await Task.detached { try DirectoryStore(root: URL(fileURLWithPath: root)).storeId }.value
            guard command.document == liveDocumentID.uuidString, !closing, selectedStore == root else {
                return LiveResult(status: "closed", message: "The selected document or store changed.")
            }
            guard actual == storeId else { return LiveResult(status: "error", message: "This reader belongs to another store.") }
        } catch { return LiveResult(status: "error", message: "The reader could not verify its store: \(error)") }
        let reference = DocumentReference.stored(root: root, storeId: storeId, document: target)
        if command.revision == nil, automaticallySaves, let document = active,
           case .published(let base) = document.session.record.destination,
           (base.root, base.storeId, base.document) == (root, storeId, target) {
            return await followDisplayedDraft(document, base: base, reference: reference, requestedRevision: command.currentRevision)
        }
        switch await openReading(reference, revision: command.revision, digest: command.digest, followsLatest: command.revision == nil, remotely: true) {
        case .failed(let detail): return LiveResult(status: "error", message: detail)
        case .busy(let detail): return LiveResult(status: "busy", message: detail)
        case .shown: break
        }
        let view = livePaneView
        guard view.storeId == storeId, view.documentId == target, view.mode == "reading", !view.dirty, !view.conflict,
              view.revision != nil, view.digest != nil,
              command.revision == nil || (command.revision == view.revision && command.digest == view.digest) else {
            return LiveResult(status: "uncertain", message: "The reader did not confirm the requested revision. List the pane before another navigation.")
        }
        let workspace = id.uuidString, document = liveDocumentID.uuidString
        return LiveResult(status: "navigated", workspace: workspace, document: document, handle: workspace + ":" + document, view: view)
    }

    /// Current/follow of the same published document joins the displayed draft's own update.
    /// An explicit pin still goes through reading navigation.
    private func followDisplayedDraft(_ document: WorkingDocument, base: StoredEditBase, reference: DocumentReference,
                                      requestedRevision: Int?) async -> LiveResult {
        let handle = liveDocumentID, workspace = id.uuidString
        let editing = LiveResult(status: "busy", message: "The reader kept this draft open. Finish the current edit or resolve its conflict before trying again.")
        func safe() -> Bool {
            !closing && !document.closed && isDisplayed(document) && handle == liveDocumentID
                && !document.session.isDirty && document.session.record.conflict == nil
                && document.session.record.pendingPublication == nil && !document.session.saving
                && !document.text.hasMarkedText && !document.stagingImages && !pickingImages
                && !pageBusy && pageHeld == nil && !pageChangeInProgress && !liveApplyInProgress
        }
        guard safe() else { return editing }
        guard let marker = await document.updates.readMarker(reference), let currentRevision = Int(marker) else {
            return LiveResult(status: "error", message: "The reader could not verify the current stored revision.")
        }
        let revision = max(currentRevision, requestedRevision ?? 0)
        guard safe() else { return editing }
        if let update = document.externalUpdateTask { await update.value }
        guard safe() else { return editing }
        if case .published(let current) = document.session.record.destination, current.revision < revision {
            await receiveExternalChange(document)
        }
        guard safe() else { return editing }
        let view = livePaneView
        guard view.kind == "published", view.follows, view.storeId == base.storeId, view.documentId == base.document,
              view.mode == "reading" || requestedRevision != nil,
              let installedRevision = view.revision, installedRevision >= revision, view.digest == document.text.digest,
              webHostModel?.sourceGeneration == document.text.generation, webHostModel?.snapshot?.digest == view.digest else {
            return LiveResult(status: "busy", message: "The pane has not accepted the current revision. It kept its existing draft.")
        }
        let identity = handle.uuidString
        return LiveResult(status: "navigated", workspace: workspace, document: identity, handle: workspace + ":" + identity, view: view)
    }

    func handleLive(_ command: LiveCommand) async -> LiveResult {
        guard command.workspace == id.uuidString, command.document == liveDocumentID.uuidString, !closing else {
            return LiveResult(status: "closed", message: "This document handle is no longer active.")
        }
        expireClaims()
        if command.op == "navigate" { return await navigateLive(command) }
        guard !libraryVisible, publishedLibrary == nil else { return LiveResult(status: "busy", message: "Select a document first.") }
        if command.op == "release" {
            guard let claim = command.claimId, let value = liveClaims[claim], value.document == liveDocumentID else {
                return LiveResult(status: "error", message: "The claim is not active for this document.")
            }
            liveClaims[claim] = nil; webRelease?(claim)
            return LiveResult(status: "released", claimId: claim)
        }
        let confirmed = webHostModel == nil || livePaneView.kind != "loading"
        let notReady = LiveResult(status: "busy", message: "The document page has not confirmed this buffer.")
        if command.op == "read" { return confirmed ? await readLive(command) : notReady }
        if command.op == "comments" || command.op == "setComment" { return confirmed ? await handleReview(command) : notReady }
        guard let (source, generation, digest) = visibleText else { return LiveResult(status: "busy", message: "The document has not opened yet.") }
        if command.op == "claim" {
            guard confirmed else { return notReady }
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
            let expiresAtMilliseconds = Int64(expires.timeIntervalSince1970 * 1000)
            liveClaims[claim] = WebLiveClaim(document: liveDocumentID, expiresAt: expires)
            webClaim?(claim, values, command.label, expiresAtMilliseconds)
            Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(90)) } catch { return }
                self?.expireClaims()
            }
            return LiveResult(status: "claimed", claimId: claim, expiresAt: expiresAtMilliseconds)
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
        guard confirmed else { return notReady }
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
            if reason == "rejected" {
                pendingLiveEdits[operation] = nil
                return LiveResult(status: "error", message: "The page rejected the edit before it changed the document.")
            }
            if reason == "stale" {
                pendingLiveEdits[operation] = nil
                return LiveResult(status: "stale", message: "The page changed before this edit. Read the current buffer.")
            }
            return LiveResult(status: "uncertain", message: "The page did not confirm whether it applied the edit. Read the buffer before retrying this operation.")
        case .accepted:
            return LiveResult(status: "uncertain", message: "The page edit is not confirmed in the native mirror. Read before retrying this operation.")
        }
    }

    private func recoveryFailure() -> LiveResult {
        LiveResult(status: "error", message: "The edit exists locally, but recovery is not confirmed. Retry this same operation.")
    }

    private func readLive(_ command: LiveCommand) async -> LiveResult {
        if let reading, let snapshot = reading.snapshot {
            return LiveResult(status: "ok", view: livePaneView, source: snapshot.source, generation: reading.sourceGeneration, digest: snapshot.digest,
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
        guard active === document, document.text.generation == generation, document.session.record.destination == record.destination else {
            return LiveResult(status: "stale", message: "The live buffer changed during the read.")
        }
        return LiveResult(status: "ok", view: livePaneView, source: source, generation: generation, digest: Digest.sha256(Data(source.utf8)), assets: assets)
    }
}
