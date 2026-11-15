import Testing
@testable import MarkdownCore

@Suite(.serialized) struct RevisionExports {
    private func destination() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("markdown-export-tests-\(UUID().uuidString)")
    }

    @Test func archiveKeepsExactSelectedSourceRecordsAndAssets() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        let image = Data("retained image bytes".utf8)
        let name = String(Digest.sha256(image).dropFirst(7)) + ".png"
        let references: [String: Any] = ["state": "inspected", "items": [
            ["kind": "image", "reference": "diagram.png", "state": "retained", "file": "assets/\(name)", "mediaType": "image/png", "bytes": image.count, "digest": Digest.sha256(image)]
        ]]
        let source = "# Original\r\n\r\n![Diagram](diagram.png)\r\n"
        let revision = try fixture.addRevision(docA, revision: 1, source: source, references: references, assets: [name: image])
        try fixture.addRevision(docA, revision: 2, source: "# Later")
        let snapshot = try DocumentLoader.load(.stored(root: fixture.root.path, storeId: fixture.storeId, document: docA), revision: 1)
        let output = destination()
        defer { try? FileManager.default.removeItem(at: output) }
        try RevisionExporter.export(snapshot, to: output, form: .archive)
        #expect(try Data(contentsOf: output.appendingPathComponent("source.md")) == Data(source.utf8))
        #expect(try Data(contentsOf: output.appendingPathComponent("revision.json")) == Data(contentsOf: revision.appendingPathComponent("revision.json")))
        let pointer = revision.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("document.json")
        #expect(try Data(contentsOf: output.appendingPathComponent("document.json")) == Data(contentsOf: pointer))
        #expect(try Data(contentsOf: output.appendingPathComponent("assets/\(name)")) == image)
        let notice = try String(contentsOf: output.appendingPathComponent("EXPORT.md"), encoding: .utf8)
        #expect(notice.contains("private provenance") && notice.contains("later revision"))
        #expect(throws: (any Error).self) { try RevisionExporter.export(snapshot, to: output, form: .archive) }
        #expect(try Data(contentsOf: output.appendingPathComponent("source.md")) == Data(source.utf8))
    }

    @Test func sharingRewritesOnlyParsedImagesAndOmitsStoredProvenance() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        let image = Data("portable image".utf8)
        let name = String(Digest.sha256(image).dropFirst(7)) + ".png"
        let references: [String: Any] = ["state": "inspected", "items": [
            ["kind": "image", "reference": "diagram.png", "state": "retained", "file": "assets/\(name)", "mediaType": "image/png", "bytes": image.count, "digest": Digest.sha256(image)]
        ]]
        let front = "---\r\nprivate-source: unchanged\r\n---\r\n"
        let source = front + "# Sharing\r\n\r\n![Diagram](diagram.png)\r\n\r\n```text\r\n![Code](diagram.png)\r\n```\r\n\r\n| Left | Right |\r\n| --- | --- |\r\n| one | two |\r\n\r\n- [x] Done\r\n\r\nA note[^n].\r\n\r\n[^n]: Exact note text.\r\n\r\n<img src=\"raw.png\">\r\n"
        let revision = try fixture.addRevision(docA, revision: 1, source: source, references: references, assets: [name: image])
        let snapshot = try DocumentLoader.load(.stored(root: fixture.root.path, storeId: fixture.storeId, document: docA), revision: 1)
        let output = destination()
        defer { try? FileManager.default.removeItem(at: output) }
        try RevisionExporter.export(snapshot, to: output, form: .sharing)
        let shared = try String(contentsOf: output.appendingPathComponent("document.md"), encoding: .utf8)
        #expect(shared.hasPrefix(front))
        #expect(shared.contains("assets/\(name)") && shared.contains("![Code](diagram.png)"))
        #expect(shared.contains("Left") && shared.contains("[x]") && shared.contains("Exact note text."))
        #expect(shared.contains("<img src=\"raw.png\">"))
        #expect(!FileManager.default.fileExists(atPath: output.appendingPathComponent("revision.json").path))
        #expect(!FileManager.default.fileExists(atPath: output.appendingPathComponent("document.json").path))
        #expect(try Data(contentsOf: revision.appendingPathComponent("source.md")) == Data(source.utf8))
        let notice = try String(contentsOf: output.appendingPathComponent("EXPORT.md"), encoding: .utf8)
        #expect(notice.contains("not sanitised") && notice.contains("private provenance were excluded"))
    }

    @Test func refusesStoreDestinationsAndChangedAssetsWithoutPartialOutput() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        let image = Data("original".utf8)
        let name = String(Digest.sha256(image).dropFirst(7)) + ".png"
        let references: [String: Any] = ["state": "inspected", "items": [
            ["kind": "image", "reference": "image.png", "state": "retained", "file": "assets/\(name)", "mediaType": "image/png", "bytes": image.count, "digest": Digest.sha256(image)]
        ]]
        let revision = try fixture.addRevision(docA, revision: 1, source: "![image](image.png)", references: references, assets: [name: image])
        let snapshot = try DocumentLoader.load(.stored(root: fixture.root.path, storeId: fixture.storeId, document: docA), revision: 1)
        #expect(throws: (any Error).self) { try RevisionExporter.export(snapshot, to: fixture.root.appendingPathComponent("export"), form: .archive) }
        try Data("modified".utf8).write(to: revision.appendingPathComponent("assets/\(name)"))
        let output = destination()
        #expect(throws: (any Error).self) { try RevisionExporter.export(snapshot, to: output, form: .sharing) }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }
}
