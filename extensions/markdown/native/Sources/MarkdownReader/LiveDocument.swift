import AppKit
import EditorFeature
import MarkdownCore
import MacPlatform

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

private enum LiveMergeFailure: Error { case assetConflict }

extension EditorWorkspace {
    func receiveExternalChange(_ document: WorkingDocument) async {
        guard isDisplayed(document), !closing, !document.closed, !document.text.hasMarkedText, !document.stagingImages,
              document.session.beginExternalUpdate() else { return }
        defer { document.session.endExternalUpdate() }
        let record = document.session.record, generation = document.text.generation
        func stillCurrent() -> Bool {
            isDisplayed(document) && !closing && !document.closed && !document.text.hasMarkedText && !document.stagingImages
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
            let changes: [LiveTextMerge.Change]
            switch LiveTextMerge.merge(base: candidate.baseSource, local: record.source, remote: candidate.source) {
            case .merged(let values): changes = values
            case .conflict:
                pause("Both authors changed the same passage. Your text remains intact."); return
            case .limited:
                pause("The changes exceed the safe merge limit. Your text remains intact."); return
            }
            let root = try imageRoot(for: record)
            let (references, overrides) = try await Task.detached {
                let merged = NSMutableString(string: record.source)
                for change in changes.reversed() { merged.replaceCharacters(in: change.range, with: change.replacement) }
                let references = Set(MarkdownRenderer.render(merged as String, resolver: NoAssetResolver()).images.map(\.reference))
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
            if !changes.isEmpty {
                let edits = changes.map { MarkdownSourceEdit(range: $0.range, expected: $0.expected, replacement: $0.replacement) }
                guard await document.applyEdits(edits, generation: generation) else {
                    pause("The page did not confirm the merge. Finish the current edit before retrying."); return
                }
                guard !document.closed, document.text.generation == generation + 1,
                      document.session.record.title.utf8.elementsEqual(record.title.utf8),
                      document.session.record.stagedAssets == record.stagedAssets,
                      document.session.record.pendingImageReferences == record.pendingImageReferences else {
                    pause("The draft changed during the merge."); return
                }
            }
            document.session.rebaseImages(root: root.path, references: references, overrides: overrides)
            document.session.advanceBase(source: candidate.source, destination: candidate.destination, title: title)
            document.setResolver(candidate.resolver)
            document.observeBase()
            schedulePersistence(document)
        } catch LiveMergeFailure.assetConflict {
            guard stillCurrent() else { return }
            pause("Both authors changed the same image reference. Your text and images remain intact.")
        } catch {
            guard stillCurrent() else { return }
            pause("External update failed: \(error). Your text remains local.")
        }
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
