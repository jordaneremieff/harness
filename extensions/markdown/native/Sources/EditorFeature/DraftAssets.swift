import MarkdownCore

/// Reconstructs exact saved-image authority, then supplements it with private staged admissions.
public enum DraftAssets {
    public static func resolver(for record: DraftRecord) throws -> any AssetResolving {
        try authority(for: record).resolver
    }

    private static func authority(for record: DraftRecord) throws -> (resolver: any AssetResolving, retained: Set<String>) {
        let base: any AssetResolving
        var retained = Set(record.stagedAssets?.map(\.reference) ?? [])
        switch record.destination {
        case .file(let file): base = DirectoryAssetResolver(directory: URL(fileURLWithPath: file.path).deletingLastPathComponent())
        case .published(let stored), .copy(let stored):
            let snapshot = try DocumentLoader.load(.stored(root: stored.root, storeId: stored.storeId, document: stored.document), revision: stored.revision, pinnedDigest: stored.digest)
            base = snapshot.resolver
            for item in snapshot.record?.references?.items ?? [] where item.kind == .image && item.state == "retained" {
                retained.insert(item.reference)
            }
        case .scratchpad: base = NoAssetResolver()
        }
        guard let root = record.assetRoot else { return (base, retained) }
        return (EditorDraftAssetResolver(base: base, root: URL(fileURLWithPath: root), images: record.stagedAssets ?? []), retained)
    }

    /// Admits every currently referenced local image without changing the Markdown. The returned
    /// identities are part of the immutable publication request, not inferred again during retry.
    public static func stageReferenced(in record: DraftRecord, root: URL) throws -> [StagedImage] {
        try inventory(in: record, root: root).images
    }

    public static func inventory(in record: DraftRecord, root: URL) throws -> (references: Set<String>, images: [StagedImage]) {
        let assets = try authority(for: record)
        let rendered = MarkdownRenderer.render(record.source, resolver: assets.resolver)
        let store = EditorAssetStore(root: root)
        var references = Set<String>(), result: [StagedImage] = [], bytes = 0
        for image in rendered.images where references.insert(image.reference).inserted {
            guard case .local(let token) = image.source else {
                if assets.retained.contains(image.reference) {
                    throw FileSaveError.invalid("A retained image is unavailable. Restore its original bytes before saving.")
                }
                continue
            }
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
        return (references, result)
    }
}
