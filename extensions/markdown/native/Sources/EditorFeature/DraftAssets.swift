import MarkdownCore

/// Reconstructs exact saved-image authority, then supplements it with private staged admissions.
public enum DraftAssets {
    public static func resolver(for record: DraftRecord) throws -> any AssetResolving {
        let base: any AssetResolving
        switch record.destination {
        case .file(let file): base = DirectoryAssetResolver(directory: URL(fileURLWithPath: file.path).deletingLastPathComponent())
        case .published(let stored), .copy(let stored):
            base = try DocumentLoader.load(.stored(root: stored.root, storeId: stored.storeId, document: stored.document), revision: stored.revision, pinnedDigest: stored.digest).resolver
        case .scratchpad: base = NoAssetResolver()
        }
        guard let root = record.assetRoot else { return base }
        return EditorDraftAssetResolver(base: base, root: URL(fileURLWithPath: root), images: record.stagedAssets ?? [])
    }

    /// Admits every currently referenced local image without changing the Markdown. The returned
    /// identities are part of the immutable publication request, not inferred again during retry.
    public static func stageReferenced(in record: DraftRecord, root: URL) throws -> [StagedImage] {
        let rendered = MarkdownRenderer.render(record.source, resolver: try resolver(for: record))
        let store = EditorAssetStore(root: root)
        var references = Set<String>(), result: [StagedImage] = [], bytes = 0
        for image in rendered.images where references.insert(image.reference).inserted {
            guard case .local(let token) = image.source else { continue }
            guard result.count < 64, let asset = rendered.assets[token] else { throw FileSaveError.invalid("The image admissions exceed their bound.") }
            let data = try asset.readData()
            guard bytes + data.count <= 32 * 1024 * 1024 else { throw FileSaveError.invalid("The image admissions exceed 32 MiB.") }
            bytes += data.count
            let ext: String
            switch asset.mediaType {
            case "image/png": ext = "png"
            case "image/jpeg": ext = "jpg"
            case "image/gif": ext = "gif"
            case "image/webp": ext = "webp"
            case "image/svg+xml": ext = "svg"
            default: throw FileSaveError.invalid("A local image has an unsupported media type.")
            }
            var admitted = try store.stage(data: data, extension: ext)
            admitted.reference = image.reference
            result.append(admitted)
        }
        return result
    }
}
