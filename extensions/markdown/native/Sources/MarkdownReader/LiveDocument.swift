import AppKit
import EditorFeature
import MarkdownCore
import MacPlatform

private struct ExternalDocumentVersion: Sendable {
    let source: String
    let destination: EditDestination
    let resolver: any AssetResolving
    let baseSource: String

    static func load(_ record: DraftRecord) throws -> Self {
        switch record.destination {
        case .file(let base):
            let file = try LocalFileSave.open(URL(fileURLWithPath: base.requestedPath))
            guard let source = record.savedSource else { throw FileSaveError.invalid("The edit base is unavailable.") }
            return Self(source: file.source, destination: .file(file.base),
                resolver: DirectoryAssetResolver(directory: URL(fileURLWithPath: file.base.path).deletingLastPathComponent()),
                baseSource: source)
        case .published(let base):
            let reference = DocumentReference.stored(root: base.root, storeId: base.storeId, document: base.document)
            let snapshot = try DocumentLoader.load(reference)
            guard let revision = snapshot.revision else { throw FileSaveError.invalid("The stored revision is unavailable.") }
            let selected = StoredEditBase(root: base.root, storeId: base.storeId, document: base.document, revision: revision, digest: snapshot.digest)
            let original = try DocumentLoader.load(reference, revision: base.revision, pinnedDigest: base.digest)
            return Self(source: snapshot.source, destination: .published(selected), resolver: snapshot.resolver, baseSource: original.source)
        case .copy, .scratchpad:
            throw FileSaveError.invalid("This document has no external save destination.")
        }
    }
}

private enum LiveMergeFailure: Error { case assetConflict }

extension EditorWorkspace {
    func receiveExternalChange(_ document: WorkingDocument) async {
        guard !closing, !document.closed, !document.text.hasMarkedText, !document.stagingImages,
              !document.session.saving, document.session.record.pendingPublication == nil else { return }
        let record = document.session.record, generation = document.text.generation
        func stillCurrent() -> Bool {
            !closing && !document.closed && !document.text.hasMarkedText && !document.stagingImages
                && !document.session.saving && document.session.record.pendingPublication == nil
                && generation == document.text.generation && record.destination == document.session.record.destination
                && record.assetRoot == document.session.record.assetRoot
                && record.stagedAssets?.map(\.reference) == document.session.record.stagedAssets?.map(\.reference)
                && record.stagedAssets?.map(\.digest) == document.session.record.stagedAssets?.map(\.digest)
        }
        do {
            let candidate = try await Task.detached { try ExternalDocumentVersion.load(record) }.value
            guard stillCurrent() else { document.checkForUpdates(); return }
            let changes: [LiveTextMerge.Change]
            switch LiveTextMerge.merge(base: candidate.baseSource, local: record.source, remote: candidate.source) {
            case .merged(let values): changes = values
            case .conflict:
                document.session.setConflict(.init(message: "Both authors changed the same passage. Your text remains intact.")); return
            case .limited:
                document.session.setError("This large update needs a narrower change before automatic synchronisation. Your text remains local."); return
            }
            let root = assetDirectory.appendingPathComponent(record.id.uuidString)
            let images = try await Task.detached {
                var base = record; base.source = candidate.baseSource; base.stagedAssets = nil; base.assetRoot = nil
                var incoming = record; incoming.source = candidate.source; incoming.destination = candidate.destination
                incoming.stagedAssets = nil; incoming.assetRoot = nil
                let old = try DraftAssets.stageReferenced(in: base, root: root)
                let local = try DraftAssets.stageReferenced(in: record, root: root)
                let remote = try DraftAssets.stageReferenced(in: incoming, root: root)
                let oldMap = Dictionary(uniqueKeysWithValues: old.map { ($0.reference, $0.digest) })
                let localMap = Dictionary(uniqueKeysWithValues: local.map { ($0.reference, $0) })
                let remoteMap = Dictionary(uniqueKeysWithValues: remote.map { ($0.reference, $0) })
                var selected: [StagedImage] = []
                for reference in Set(localMap.keys).union(remoteMap.keys) {
                    let localImage = localMap[reference], remoteImage = remoteMap[reference]
                    if let localImage, let remoteImage, localImage.digest != remoteImage.digest,
                       localImage.digest != oldMap[reference], remoteImage.digest != oldMap[reference] {
                        throw LiveMergeFailure.assetConflict
                    }
                    if let remoteImage, remoteImage.digest != oldMap[reference] { selected.append(remoteImage) }
                    else if let localImage { selected.append(localImage) }
                    else if let remoteImage { selected.append(remoteImage) }
                }
                return selected
            }.value
            guard stillCurrent() else { document.checkForUpdates(); return }
            guard await document.session.persist() else {
                if case .pending = document.session.recovery { document.checkForUpdates() }
                return
            }
            guard stillCurrent() else { document.checkForUpdates(); return }
            if !changes.isEmpty {
                let edits = changes.map { MarkdownSourceEdit(range: $0.range, expected: $0.expected, replacement: $0.replacement) }
                guard await document.applyEdits(edits, generation: generation) else { return }
            }
            if !images.isEmpty {
                document.session.retainImages(root: root.path, images: images)
                document.session.consumeImages(images.map(\.reference))
            }
            document.session.advanceBase(source: candidate.source, destination: candidate.destination)
            document.session.setError(nil)
            document.setResolver(candidate.resolver)
            document.observeBase()
            schedulePersistence(document)
        } catch LiveMergeFailure.assetConflict {
            guard stillCurrent() else { return }
            document.session.setConflict(.init(message: "Both authors changed the same image reference. Your text and images remain intact."))
        } catch {
            guard stillCurrent() else { return }
            document.session.setError("Automatic update paused: \(error). Your text remains local.")
        }
    }

    /// Coalesces source changes while retaining the exact in-flight publication separately.
    func schedulePersistence(_ document: WorkingDocument) {
        guard automaticallySaves, !document.closed else { return }
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
                guard document.session.isDirty || document.session.record.pendingPublication != nil else { return }
                guard !document.session.saving else { document.persistenceRequested = true; continue }
                switch document.session.record.destination {
                case .file: await self.saveFile(document)
                default:
                    guard self.selectedStore != nil else { return }
                    await self.savePublished(document)
                }
                if document.session.error != nil || document.session.record.conflict != nil { return }
                if document.session.isDirty { document.persistenceRequested = true }
            }
        }
    }
}
