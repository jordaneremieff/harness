import AppKit
import EditorFeature
import MacPlatform
import MarkdownCore
import UniformTypeIdentifiers

extension EditorWorkspace {
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
        guard files.count <= 64 else { document.session.setError("Insert no more than 64 images at once."); return }
        guard let root = try? imageRoot(for: document.session.record) else { document.session.setError("The draft image directory is outside private storage."); return }
        let snapshot = document.text.snapshot
        document.stagingImages = true
        Task { [weak self, weak document] in
            guard let self, let document else { return }
            defer { document.stagingImages = false }
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

    func insertImages(_ document: WorkingDocument, expected: MarkdownEditorSnapshot? = nil) async {
        let snapshot = expected ?? document.text.snapshot
        guard let references = document.session.record.pendingImageReferences, !references.isEmpty else { return }
        guard await document.session.persist() else { document.session.setError("Image recovery failed. The source remains unchanged."); return }
        guard !closing, !document.replacing, !document.text.hasMarkedText,
              document.text.generation == snapshot.generation, document.text.source == snapshot.source,
              document.text.selectedRange == snapshot.selectedRange else {
            document.session.setError("The images reached private storage. Use Insert Retained Images at your chosen selection.")
            return
        }
        let insertion = references.map { "![Image](\($0))" }.joined(separator: "\n")
        let selection = NSRange(location: snapshot.selectedRange.location + insertion.utf16.count, length: 0)
        guard document.text.apply(range: snapshot.selectedRange, replacement: insertion, selection: selection, actionName: "Insert Images") else { return }
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
