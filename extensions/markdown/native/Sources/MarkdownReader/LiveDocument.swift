import AppKit
import EditorFeature
import MarkdownCore
import MacPlatform
import ReaderFeature

private struct ExternalDocumentVersion: Sendable {
    let source: String
    let destination: EditDestination
    let resolver: any AssetResolving
    let baseSource: String
    let titles: (base: String, remote: String)?

    func conflict(_ message: String) -> EditConflict {
        switch destination {
        case .published(let base): return EditConflict(message: message, revision: base.revision, digest: base.digest)
        case .file(let base): return EditConflict(message: message, digest: base.digest)
        default: return EditConflict(message: message)
        }
    }

    static func load(_ record: DraftRecord) throws -> Self {
        switch record.destination {
        case .file(let base):
            let file = try LocalFileSave.open(URL(fileURLWithPath: base.requestedPath))
            guard let source = record.savedSource else { throw FileSaveError.invalid("The edit base is unavailable.") }
            return Self(source: file.source, destination: .file(file.base),
                resolver: DirectoryAssetResolver(directory: URL(fileURLWithPath: file.base.path).deletingLastPathComponent()),
                baseSource: source, titles: nil)
        case .published(let base):
            let reference = DocumentReference.stored(root: base.root, storeId: base.storeId, document: base.document)
            let snapshot = try DocumentLoader.load(reference)
            guard let revision = snapshot.revision else { throw FileSaveError.invalid("The stored revision is unavailable.") }
            let selected = StoredEditBase(root: base.root, storeId: base.storeId, document: base.document, revision: revision, digest: snapshot.digest)
            let original = try DocumentLoader.load(reference, revision: base.revision, pinnedDigest: base.digest)
            return Self(source: snapshot.source, destination: .published(selected), resolver: snapshot.resolver, baseSource: original.source, titles: (original.title, snapshot.title))
        case .copy, .scratchpad:
            throw FileSaveError.invalid("This document has no external save destination.")
        }
    }
}

private enum LiveMergeFailure: Error { case assetConflict, editLimit }

extension EditorWorkspace {
    func receiveExternalChange(_ document: WorkingDocument) async {
        if let update = document.externalUpdateTask { await update.value; return }
        let update = Task { @MainActor in
            defer { document.externalUpdateTask = nil }
            await reconcileExternalChange(document)
        }
        document.externalUpdateTask = update
        await update.value
    }

    private func reconcileExternalChange(_ document: WorkingDocument) async {
        guard !Task.isCancelled, isDisplayed(document), !closing, !document.closed, !document.text.hasMarkedText, !document.stagingImages,
              !pickingImages, !pageBusy, !pageChangeInProgress, !liveApplyInProgress,
              document.session.beginExternalUpdate() else { return }
        defer { document.session.endExternalUpdate() }
        let record = document.session.record, generation = document.text.generation
        let clean = !document.session.isDirty && record.pendingImageReferences?.isEmpty != false
        func stillCurrent() -> Bool {
            isDisplayed(document) && !closing && !document.closed && !document.text.hasMarkedText && !document.stagingImages && !pickingImages
                && !document.session.saving && document.session.record.pendingPublication == nil
                && generation == document.text.generation && record.destination == document.session.record.destination
                && record.title.utf8.elementsEqual(document.session.record.title.utf8)
                && record.assetRoot == document.session.record.assetRoot
                && record.stagedAssets == document.session.record.stagedAssets
                && record.pendingImageReferences == document.session.record.pendingImageReferences
        }
        var external: ExternalDocumentVersion?
        func pause(_ reason: String) {
            let message = reason + " Autosave paused. Use Save to retry the merge, or Save As to keep your text in a separate file."
            document.session.setConflict(external?.conflict(message) ?? EditConflict(message: message,
                revision: record.conflict?.revision, digest: record.conflict?.digest))
        }
        do {
            let candidate = try await Task.detached { try ExternalDocumentVersion.load(record) }.value
            external = candidate
            guard stillCurrent() else { document.checkForUpdates(); return }
            var title = record.title
            if let titles = candidate.titles, !titles.base.utf8.elementsEqual(titles.remote.utf8) {
                guard title.utf8.elementsEqual(titles.base.utf8) || title.utf8.elementsEqual(titles.remote.utf8) else {
                    pause("Both authors changed the document title."); return
                }
                title = titles.remote
            }
            if case .published = candidate.destination, clean, let webExternalSnapshot {
                guard generation < UInt64(ReaderBridgeCodec.maxInteger) else {
                    pause("The page has reached its source generation limit."); return
                }
                guard await document.session.persist() else {
                    if stillCurrent(), case .failed = document.session.recovery { pause("Draft recovery failed before the update.") }
                    return
                }
                guard stillCurrent(), pageHeld == nil, !pageBusy else { return }
                var next = record
                next.source = candidate.source; next.generation = generation + 1
                next.destination = candidate.destination; next.title = title
                try await webExternalSnapshot(document, next, candidate.resolver, stillCurrent) {
                    document.text.acceptSnapshot(source: next.source, generation: next.generation)
                    document.session.rebaseImages(root: record.assetRoot ?? "", references: Set((record.stagedAssets ?? []).map(\.reference)), overrides: [])
                    document.session.advanceBase(source: next.source, destination: next.destination, title: next.title)
                    document.setResolver(candidate.resolver, refreshHost: false)
                    document.observeBase()
                }
                return
            }
            let merge = await Task.detached {
                LiveTextMerge.merge(base: candidate.baseSource, local: record.source, remote: candidate.source)
            }.value
            guard stillCurrent() else { document.checkForUpdates(); return }
            let edits: [MarkdownSourceEdit]
            switch merge {
            case .merged(let values): edits = values.map { .init(range: $0.range, expected: $0.expected, replacement: $0.replacement) }
            case .conflict:
                pause("Both authors changed the same passage. Your text remains intact."); return
            case .limited: throw LiveMergeFailure.editLimit
            }
            let root = try imageRoot(for: record)
            let (references, overrides) = try await Task.detached {
                let merged = try Self.prepareMergeSource(edits, record: record)
                let references = Set(MarkdownRenderer.render(merged, resolver: NoAssetResolver()).images.map(\.reference))
                guard !references.isEmpty else { return (references, [StagedImage]()) }
                var base = record; base.source = candidate.baseSource; base.stagedAssets = nil; base.assetRoot = nil
                var incoming = record; incoming.source = candidate.source; incoming.destination = candidate.destination
                incoming.stagedAssets = nil; incoming.assetRoot = nil
                let old = try DraftAssets.stageReferenced(in: base, root: root)
                let local = try DraftAssets.inventory(in: record, root: root)
                let remote = try DraftAssets.inventory(in: incoming, root: root)
                let oldMap = Dictionary(uniqueKeysWithValues: old.map { ($0.reference, $0.digest) })
                let localMap = Dictionary(uniqueKeysWithValues: local.images.map { ($0.reference, $0) })
                let remoteMap = Dictionary(uniqueKeysWithValues: remote.images.map { ($0.reference, $0) })
                var overrides: [StagedImage] = []
                for reference in references {
                    let localImage = localMap[reference], remoteImage = remoteMap[reference]
                    if record.pendingImageReferences?.contains(reference) == true,
                       record.stagedAssets?.first(where: { $0.reference == reference })?.digest != remoteImage?.digest {
                        throw LiveMergeFailure.assetConflict
                    }
                    guard local.references.contains(reference), localImage?.digest != remoteImage?.digest else { continue }
                    if remote.references.contains(reference) {
                        if localImage?.digest == oldMap[reference] { continue }
                        guard remoteImage?.digest == oldMap[reference] else { throw LiveMergeFailure.assetConflict }
                    }
                    if let localImage { overrides.append(localImage) }
                }
                return (references, overrides)
            }.value
            guard stillCurrent() else { document.checkForUpdates(); return }
            guard await document.session.persist() else {
                if case .pending = document.session.recovery { document.checkForUpdates() }
                else if stillCurrent() { pause("Draft recovery failed before the merge.") }
                return
            }
            guard stillCurrent() else { document.checkForUpdates(); return }
            func commit() {
                document.session.rebaseImages(root: root.path, references: references, overrides: overrides)
                document.session.advanceBase(source: candidate.source, destination: candidate.destination, title: title)
                document.setResolver(candidate.resolver, refreshHost: edits.isEmpty)
                document.observeBase()
                schedulePersistence(document)
            }
            if edits.isEmpty { commit() }
            else {
                guard !pageBusy, !pageChangeInProgress, !liveApplyInProgress else { return }
                guard await applyThroughPage(edits, generation: generation, document: document, external: (stillCurrent, commit)) else {
                    if !stillCurrent() { document.checkForUpdates() }
                    else if pageHeld == nil && !pageBusy { pause("The page did not confirm the merge. Your text remains intact.") }
                    return
                }
            }
        } catch is CancellationError {
            // The page kept its exact buffer. The next idle page report rechecks the pointer.
        } catch LiveMergeFailure.editLimit {
            guard stillCurrent() else { return }
            pause("The changes exceed the safe merge limit. Your text remains intact.")
        } catch LiveMergeFailure.assetConflict {
            guard stillCurrent() else { return }
            pause("Both authors changed the same image reference. Your text and images remain intact.")
        } catch {
            guard stillCurrent() else { return }
            pause("External update failed: \(error). Your text remains local.")
        }
    }

    nonisolated static func prepareMergeSource(_ edits: [MarkdownSourceEdit], record: DraftRecord) throws -> String {
        guard !edits.isEmpty else { return record.source }
        guard edits.count <= ReaderBridgeCodec.editLimit, record.generation < UInt64(ReaderBridgeCodec.maxInteger),
              let result = MirrorText.applying(edits, to: record.source) else { throw LiveMergeFailure.editLimit }
        let fields: [[String: Any]] = edits.map { ["start": $0.range.location, "end": NSMaxRange($0.range),
            "text": $0.replacement, "expected": $0.expected] }
        do {
            _ = try ReaderBridgeCodec.decode(body: ["v": 1, "type": "edits", "origin": "agent",
                "operationId": UUID().uuidString, "presentation": UUID().uuidString,
                "baseGeneration": record.generation, "generation": record.generation + 1, "edits": fields])
        } catch { throw LiveMergeFailure.editLimit }
        return result
    }

    func needsAutomaticSave(_ document: WorkingDocument) -> Bool {
        guard automaticallySaves else { return false }
        // A private draft has no destination until someone explicitly saves it.
        if document.session.record.pendingPublication != nil { return true }
        switch document.session.record.destination {
        case .file, .published: return document.session.isDirty
        case .scratchpad, .copy: return false
        }
    }

    /// Coalesces source changes while retaining the exact in-flight publication separately.
    func schedulePersistence(_ document: WorkingDocument) {
        guard !closing, !document.closed, document.session.record.conflict == nil, needsAutomaticSave(document) else { return }
        document.persistenceRequested = true
        guard document.persistenceTask == nil else { return }
        document.persistenceTask = Task { @MainActor [weak self, weak document] in
            guard let self, let document else { return }
            defer { document.persistenceTask = nil }
            while document.persistenceRequested, !document.closed, !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(650)) } catch { return }
                document.persistenceRequested = false
                guard !self.closing, !document.text.hasMarkedText, !document.stagingImages else { return }
                guard document.session.record.conflict == nil else { return }
                guard self.needsAutomaticSave(document) else { return }
                guard !document.session.saving, !document.session.updatingExternal else { document.persistenceRequested = true; continue }
                await self.saveDestination(document)
                if document.session.destinationSaveError != nil || document.session.record.conflict != nil { return }
                if self.needsAutomaticSave(document) { document.persistenceRequested = true }
            }
        }
    }
}
