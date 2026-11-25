import AppKit
import EditorFeature
import MacPlatform
import MarkdownCore
import UniformTypeIdentifiers

struct PickedImageReply: Sendable {
    let generation: UInt64
    let edits: [MarkdownSourceEdit]
    let cancelled: Bool
}

struct PreparedPickedImage: Sendable {
    let document: UUID
    let root: URL
    let image: StagedImage
}

struct PickedImageAdoption: Sendable {
    let root: URL
    let images: [StagedImage]
    let keys: [String]
    let preparedRoots: [URL]
}

extension EditorWorkspace {
    func preparePickedImages(generation: UInt64, range: NSRange, source: String,
                             resolver: (any AssetResolving)? = nil) async throws -> PickedImageReply {
        guard !pickingImages, !closing, active?.session.updatingExternal != true, matchesImageBase(generation: generation, source: source),
              MirrorText.validRange(range, source: source) else { throw WebMirrorError.stale }
        pickingImages = true
        defer { pickingImages = false; active?.checkForUpdates() }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = ["png", "jpg", "jpeg", "gif", "webp", "svg"].compactMap { UTType(filenameExtension: $0) }
        panel.allowsMultipleSelection = true
        let response = await withCheckedContinuation { continuation in
            panel.begin { continuation.resume(returning: $0) }
        }
        guard response == .OK else { return PickedImageReply(generation: generation, edits: [], cancelled: true) }
        return try await preparePickedImages(files: panel.urls, generation: generation, range: range, source: source)
    }

    /// Stages immutable bytes without changing source, recovery records or captured documents.
    func preparePickedImages(files: [URL], generation: UInt64, range: NSRange, source: String) async throws -> PickedImageReply {
        guard !closing, matchesImageBase(generation: generation, source: source),
              MirrorText.validRange(range, source: source) else { throw WebMirrorError.stale }
        guard !files.isEmpty else { return PickedImageReply(generation: generation, edits: [], cancelled: true) }
        guard files.count <= 64 else {
            throw FileSaveError.invalid("Insert no more than 64 prepared images at once.")
        }
        let identity = liveDocumentID, root = assetDirectory.appendingPathComponent(UUID().uuidString)
        do {
            let images = try await Task.detached {
                let store = EditorAssetStore(root: root)
                return try files.map { try store.stage(file: $0) }
            }.value
            guard identity == liveDocumentID, !closing, matchesImageBase(generation: generation, source: source) else {
                throw WebMirrorError.stale
            }
            var inventory = preparedPickedImages.mapValues(\.image)
            for image in images { inventory[identity.uuidString + ":" + image.reference] = image }
            guard inventory.count <= 64, inventory.values.reduce(0, { $0 + $1.bytes }) <= 32 * 1024 * 1024 else {
                throw FileSaveError.invalid("The prepared image store is full; no image was removed.")
            }
            let insertion = images.map { "![Image](\($0.reference))" }.joined(separator: "\n")
            let edit = MarkdownSourceEdit(range: range, expected: (source as NSString).substring(with: range), replacement: insertion)
            guard MirrorText.applying([edit], to: source) != nil else { throw WebMirrorError.invalidChange }
            var replacedRoots: [URL] = []
            for image in images {
                let key = identity.uuidString + ":" + image.reference
                if let previous = preparedPickedImages[key] { replacedRoots.append(previous.root) }
                preparedPickedImages[key] = PreparedPickedImage(document: identity, root: root, image: image)
            }
            discardPreparedImageRoots(replacedRoots, except: root)
            return PickedImageReply(generation: generation, edits: [edit], cancelled: false)
        } catch {
            try? FileManager.default.removeItem(at: root)
            throw error
        }
    }

    private func matchesImageBase(generation: UInt64, source: String) -> Bool {
        if let reading, let snapshot = reading.snapshot {
            return generation == 0 && source.utf8.elementsEqual(snapshot.source.utf8)
        }
        guard let document = active else { return false }
        return generation == document.text.generation && source.utf8.elementsEqual(document.text.source.utf8)
    }

    func prepareImageAdoption(source: String, identity: UUID) async throws -> PickedImageAdoption? {
        let selected = preparedPickedImages.filter { $0.value.document == identity && source.contains($0.value.image.reference) }
        guard let first = selected.values.first else { return nil }
        let root: URL
        if reading == nil, let document = active { root = try imageRoot(for: document.session.record) }
        else { root = first.root }
        let retained = Array(selected.values)
        let images = try await Task.detached {
            let store = EditorAssetStore(root: root)
            return try retained.map { value in
                let image = try store.stage(file: value.root.appendingPathComponent(value.image.relativePath))
                guard image.digest == value.image.digest, image.reference == value.image.reference else {
                    throw FileSaveError.invalid("The prepared image changed before its source edit.")
                }
                return image
            }
        }.value
        return PickedImageAdoption(root: root, images: images, keys: Array(selected.keys), preparedRoots: Array(Set(retained.map(\.root))))
    }

    func finishImageAdoption(_ adoption: PickedImageAdoption) {
        for key in adoption.keys { preparedPickedImages[key] = nil }
        discardPreparedImageRoots(adoption.preparedRoots, except: adoption.root)
    }

    func discardUncommittedImages() {
        let roots = preparedPickedImages.values.map(\.root)
        preparedPickedImages.removeAll()
        discardPreparedImageRoots(roots, except: assetDirectory)
    }

    private func discardPreparedImageRoots(_ roots: [URL], except retainedRoot: URL) {
        for root in Set(roots) where root != retainedRoot {
            guard !preparedPickedImages.values.contains(where: { $0.root == root }),
                  !documents.contains(where: { $0.session.record.assetRoot == root.path }) else { continue }
            try? FileManager.default.removeItem(at: root)
        }
    }

    func imageRoot(for record: DraftRecord) throws -> URL {
        guard let path = record.assetRoot else { return assetDirectory.appendingPathComponent(record.id.uuidString) }
        let root = URL(fileURLWithPath: path)
        guard path.hasPrefix("/"), UUID(uuidString: root.lastPathComponent) != nil,
              root.deletingLastPathComponent().standardizedFileURL == assetDirectory.standardizedFileURL else {
            throw FileSaveError.invalid("The draft image directory is outside private storage.")
        }
        return root
    }

    func chooseImage() {
        guard allowAction("inserting an image"), let document = active else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = ["png", "jpg", "jpeg", "gif", "webp", "svg"].compactMap { UTType(filenameExtension: $0) }
        panel.allowsMultipleSelection = true
        panel.begin { [weak self, weak document] response in
            guard response == .OK, let self, let document else { return }
            self.stageImages(document, files: panel.urls)
        }
    }

    func stageImages(_ document: WorkingDocument, files: [URL] = [], data: Data? = nil, extension ext: String? = nil) {
        guard allowAction("inserting an image", document: document) else { return }
        guard !document.session.updatingExternal else { notice = "Wait for the external update before inserting an image."; return }
        guard files.count <= 64 else { document.session.setError("Insert no more than 64 images at once."); return }
        guard let root = try? imageRoot(for: document.session.record) else { document.session.setError("The draft image directory is outside private storage."); return }
        let snapshot = document.text.snapshot
        document.stagingImages = true
        Task { [weak self, weak document] in
            guard let self, let document else { return }
            defer { document.stagingImages = false; document.checkForUpdates() }
            do {
                let images = try await Task.detached {
                    let store = EditorAssetStore(root: root)
                    if let data, let ext { return [try store.stage(data: data, extension: ext)] }
                    return try files.map { try store.stage(file: $0) }
                }.value
                document.session.retainImages(root: root.path, images: images)
                await self.insertImages(document, expected: snapshot)
            } catch { document.session.setError("Image not inserted: \(error)") }
        }
    }

    func insertImages(_ document: WorkingDocument, expected: MirrorSnapshot? = nil) async {
        let snapshot = expected ?? document.text.snapshot
        guard let references = document.session.record.pendingImageReferences, !references.isEmpty else { return }
        guard await document.session.persist() else { document.session.setError("Image recovery failed. The source remains unchanged."); return }
        guard !closing, !document.text.hasMarkedText,
              document.text.generation == snapshot.generation, document.text.source == snapshot.source,
              document.text.selectedRange == snapshot.selectedRange else {
            document.session.setError("The images reached private storage. Use Insert Retained Images at your chosen selection.")
            return
        }
        let insertion = references.map { "![Image](\($0))" }.joined(separator: "\n")
        let edit = MarkdownSourceEdit(range: snapshot.selectedRange, expected: (snapshot.source as NSString).substring(with: snapshot.selectedRange), replacement: insertion)
        guard await document.applyEdits([edit], generation: snapshot.generation) else { return }
        document.session.consumeImages(references)
        document.session.setError(nil)
        document.schedulePreview(force: true)
        _ = await document.session.persist()
    }

    func duplicate(_ document: WorkingDocument) async {
        guard allowAction("creating a separate copy", document: document) else { return }
        let snapshot = document.session.record
        var copy = document.session.duplicate()
        let root = assetDirectory.appendingPathComponent(copy.id.uuidString)
        do {
            let images = try await Task.detached { try DraftAssets.stageReferenced(in: snapshot, root: root) }.value
            copy.assetRoot = images.isEmpty ? nil : root.path
            copy.stagedAssets = images
            copy.pendingImageReferences = nil
            try await drafts.save(copy)
            add(copy)
        } catch { document.session.setError("Copy not created: \(error). The original draft remains unchanged.") }
    }
}
