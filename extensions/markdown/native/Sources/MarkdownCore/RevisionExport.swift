import Darwin
import Foundation
import cmark_gfm

public enum RevisionExportForm: String, Sendable {
    case archive, sharing
}

public struct RevisionExportError: LocalizedError, Sendable {
    public var errorDescription: String?
    init(_ reason: String) { errorDescription = reason }
}

/// Exports a selected immutable revision to a new directory, never into a store or over a file.
public enum RevisionExporter {
    public static func export(_ snapshot: DocumentSnapshot, to requested: URL, form: RevisionExportForm) throws {
        guard case .stored(let root, _, _) = snapshot.reference, let selected = snapshot.record else {
            throw RevisionExportError("Select a retained revision before exporting source and records.")
        }
        let parent = URL(fileURLWithPath: FileAccess.canonicalPath(requested.deletingLastPathComponent().path))
        let destination = parent.appendingPathComponent(requested.lastPathComponent)
        let storeRoot = FileAccess.canonicalPath(root)
        guard destination.path != storeRoot, !destination.path.hasPrefix(storeRoot + "/") else {
            throw RevisionExportError("Choose a destination outside the document store.")
        }
        let loaded = try DocumentLoader.load(snapshot.reference, revision: selected.revision, pinnedDigest: snapshot.digest)
        guard loaded.record == selected else { throw RevisionExportError("The selected revision's metadata changed. Reopen it before export.") }
        let stage = parent.appendingPathComponent(".markdown-export-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: stage) }
        let source = try FileAccess.readRegularFile(loaded.location.appendingPathComponent("source.md"), limit: Limits.sourceBytes, missing: .notFound("source.md"))
        guard source.count == selected.bytes, Digest.sha256(source) == selected.digest else { throw StoreError.digestMismatch }
        let revisionBytes = try recordBytes(loaded.location.appendingPathComponent("revision.json"))
        guard try JSONDecoder().decode(RevisionRecord.self, from: revisionBytes) == selected else {
            throw RevisionExportError("The selected revision's metadata changed during export.")
        }
        var inventory: [String: ReferenceItem] = [:]
        for item in selected.references?.items ?? [] where item.kind == .image {
            if let previous = inventory[item.reference], previous != item { throw RevisionExportError("The image inventory has conflicting records.") }
            inventory[item.reference] = item
        }
        var assets = AssetCopies(snapshot: loaded, directory: stage)
        let notice: String
        switch form {
        case .archive:
            for item in selected.references?.items ?? [] where item.kind == .image && item.state == "retained" {
                _ = try assets.copy(item.reference)
            }
            try write(source, named: "source.md", in: stage)
            try write(revisionBytes, named: "revision.json", in: stage)
            let document = loaded.location.deletingLastPathComponent().deletingLastPathComponent()
            let pointerBytes = try recordBytes(document.appendingPathComponent("document.json"))
            let pointer = try JSONDecoder().decode(DocumentRecord.self, from: pointerBytes)
            guard pointer.version == StoreFormat.version, pointer.id == selected.document, pointer.kind == loaded.document?.kind else {
                throw RevisionExportError("The document pointer changed identity during export.")
            }
            try write(pointerBytes, named: "document.json", in: stage)
            notice = """
            # Revision archive

            Selected document: \(selected.document), revision \(selected.revision).
            Source identity: \(selected.digest), \(selected.bytes) bytes.

            source.md and the original revision.json and document.json are byte-for-byte copies.
            The records include original private provenance. The source is not sanitised.
            document.json is the pointer at export time and can name a later revision.
            This directory is a selected-revision archive, not a complete document store.
            Only recorded retained assets are included; their digest and byte count were checked.
            Missing, external, unsupported and uninspected references retain their original qualifications.
            No source, record or asset in the store was changed.
            """
        case .sharing:
            let derived = try portable(source: source, assets: &assets)
            try write(derived.data, named: "document.md", in: stage)
            notice = """
            # Sharing copy

            document.md is derived Markdown, not the exact archival source.
            The existing cmark parser normalised Markdown formatting; retained Markdown image
            destinations now name relative assets. YAML front matter was copied unchanged.
            Raw HTML, links, non-retained images and source content were not sanitised.
            Store records and their private provenance were excluded. The source itself can
            contain private information. Review it before sharing.

            \(derived.rewritten) image occurrences were rewritten; \(assets.files.count) retained files were copied.
            \(derived.uncopied) Markdown image occurrences were not copied. Raw HTML and links were not rewritten.
            This copy does not claim complete reference inspection or self-contained rendering.
            No retained original was changed.
            """
        }
        try write(Data((notice + "\n").utf8), named: "EXPORT.md", in: stage)
        guard renamex_np(stage.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
            throw RevisionExportError("The export destination was not created: \(String(cString: strerror(errno))). Choose a new folder name.")
        }
    }

    private static func recordBytes(_ url: URL) throws -> Data {
        try FileAccess.readRegularFile(url, limit: Limits.recordBytes, missing: .notFound(url.lastPathComponent))
    }

    private static func write(_ data: Data, named name: String, in directory: URL) throws {
        let url = directory.appendingPathComponent(name)
        try data.write(to: url, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private struct AssetCopies {
        let snapshot: DocumentSnapshot
        let directory: URL
        var files: Set<String> = []
        var sizes: [String: Int] = [:]
        var bytes = 0

        mutating func copy(_ reference: String) throws -> String {
            guard let item = snapshot.record?.references?.items?.first(where: { $0.kind == .image && $0.reference == reference }),
                  item.state == "retained", let file = item.file,
                  case .local(let asset) = snapshot.resolver.resolve(reference) else {
                throw RevisionExportError("A recorded retained image is unavailable. The export stopped without a partial copy.")
            }
            if files.contains(file) {
                guard sizes[file] == item.bytes else { throw RevisionExportError("Retained image records disagree about the copied bytes.") }
                return file
            }
            guard files.count < 64 else { throw RevisionExportError("The retained asset count exceeds the export bound.") }
            let data = try asset.readData()
            guard bytes + data.count <= 32 * 1024 * 1024 else { throw RevisionExportError("Retained assets exceed the export byte bound.") }
            let folder = directory.appendingPathComponent("assets")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try RevisionExporter.write(data, named: String(file.dropFirst("assets/".count)), in: folder)
            bytes += data.count
            files.insert(file)
            sizes[file] = data.count
            return file
        }
    }

    private static func portable(source: Data, assets: inout AssetCopies) throws -> (data: Data, rewritten: Int, uncopied: Int) {
        let prefix = frontMatterEnd(source)
        let bytes = Array(source.dropFirst(prefix))
        guard let parsed = MarkdownParser.parse(bytes) else { throw RevisionExportError("The Markdown source could not be parsed for export.") }
        defer { parsed.free() }
        guard let iterator = cmark_iter_new(parsed.document) else { throw RevisionExportError("The Markdown source could not be inspected for export.") }
        defer { cmark_iter_free(iterator) }
        var rewritten = 0, uncopied = 0, images = 0
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iterator), cmark_node_get_type(node) == CMARK_NODE_IMAGE else { continue }
            images += 1
            guard images <= ReferenceInventoryScan.listLimit else { throw RevisionExportError("The image occurrence count exceeds the export bound.") }
            let reference = MarkdownRenderer.string(cmark_node_get_url(node))
            let retained = assets.snapshot.record?.references?.items?.first { $0.kind == .image && $0.reference == reference }?.state == "retained"
            if retained {
                let path = try assets.copy(reference)
                guard path.withCString({ cmark_node_set_url(node, $0) }) != 0 else { throw RevisionExportError("An image destination could not be rewritten.") }
                rewritten += 1
            } else { uncopied += 1 }
        }
        guard let output = cmark_render_commonmark(parsed.document, MarkdownParser.options, 0) else { throw RevisionExportError("The derived Markdown could not be written.") }
        defer { free(output) }
        var data = Data(source.prefix(prefix))
        data.append(Data(String(cString: output).utf8))
        guard data.count <= 8 * 1024 * 1024 else { throw RevisionExportError("Derived Markdown exceeds the export byte bound.") }
        return (data, rewritten, uncopied)
    }

    /// Reuses the reader's front-matter recognition, then finds the exact closing line boundary.
    private static func frontMatterEnd(_ source: Data) -> Int {
        guard let text = String(data: source, encoding: .utf8), MarkdownRenderer.splitFrontMatter(text).0 != nil else { return 0 }
        let bytes = Array(source)
        var start = 0
        for line in 0..<400 {
            guard start < bytes.count else { break }
            var end = start
            while end < bytes.count && bytes[end] != 10 { end += 1 }
            var contentEnd = end
            if contentEnd > start && bytes[contentEnd - 1] == 13 { contentEnd -= 1 }
            let text = String(decoding: bytes[start..<contentEnd], as: UTF8.self)
            let next = end < bytes.count ? end + 1 : end
            if line > 1 && (text == "---" || text == "...") { return next }
            start = next
        }
        return 0
    }
}
