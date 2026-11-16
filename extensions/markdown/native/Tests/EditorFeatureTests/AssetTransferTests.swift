import Testing
@testable import EditorFeature
@testable import MarkdownCore

@Suite struct AssetTransferTests {
    @Test func fileSavesRetainByteDistinctUnicodeChangesAndExactNoOps() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("file-unicode-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("source.md")
        let original = "e\u{301}\r\n", replacement = "\u{e9}\r\n"
        let bom = Data([0xef, 0xbb, 0xbf])
        try (bom + Data(original.utf8)).write(to: file)
        let opened = try LocalFileSave.open(file)
        let saved = try LocalFileSave.save(source: replacement, base: opened.base)
        #expect(try Data(contentsOf: file) == bom + Data(replacement.utf8))
        #expect(saved.digest == Digest.sha256(bom + Data(replacement.utf8)))
        let noOp = try LocalFileSave.save(source: replacement, base: saved)
        #expect(noOp == saved)
        #expect(noOp.inode == saved.inode)
        let reversed = try LocalFileSave.save(source: original, base: saved)
        #expect(try Data(contentsOf: file) == bom + Data(original.utf8))
        #expect(reversed.digest == Digest.sha256(bom + Data(original.utf8)))
    }

    @Test func exactReferencesSurviveCopyAndConflictingFilesRemainUntouched() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("asset-copy-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let sourceRoot = root.appendingPathComponent("source"), destination = root.appendingPathComponent("destination")
        try FileManager.default.createDirectory(at: sourceRoot.appendingPathComponent("images"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let bytes = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8)
        let image = sourceRoot.appendingPathComponent("images/pic.svg")
        try bytes.write(to: image)
        let source = "![one](images/pic.svg)\n![two](missing.png)\n![remote](https://example.com/pic.png)\n"
        let result = try FileAssetTransfer.copy(source: source, resolver: DirectoryAssetResolver(directory: sourceRoot), beside: destination.appendingPathComponent("copy.md"))
        #expect(result.copied == 1)
        #expect(result.unavailable == 1)
        #expect(result.external == 1)
        let target = destination.appendingPathComponent("images/pic.svg")
        #expect(try Data(contentsOf: target) == bytes)
        _ = try FileAssetTransfer.copy(source: source, resolver: DirectoryAssetResolver(directory: sourceRoot), beside: destination.appendingPathComponent("copy.md"))
        try Data("user file".utf8).write(to: target)
        #expect(throws: (any Error).self) { try FileAssetTransfer.copy(source: source, resolver: DirectoryAssetResolver(directory: sourceRoot), beside: destination.appendingPathComponent("copy.md")) }
        #expect(try String(contentsOf: target, encoding: .utf8) == "user file")
        #expect(try Data(contentsOf: image) == bytes)
    }

    @Test func publicationAdmissionsRetainExactSourceAndJPEGIdentity() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("asset-admission-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let image = root.appendingPathComponent("photo.jpeg")
        let bytes = Data([1, 2, 3, 4])
        try bytes.write(to: image)
        let file = root.appendingPathComponent("source.md"), source = "![photo](photo.jpeg)\r\n"
        try Data(source.utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let record = DraftRecord(source: source, destination: .file(opened.base), savedSource: source)
        let privateRoot = root.appendingPathComponent("private")
        let images = try DraftAssets.stageReferenced(in: record, root: privateRoot)
        #expect(images.count == 1)
        #expect(images.first?.reference == "photo.jpeg")
        #expect(images.first?.relativePath.hasSuffix(".jpg") == true)
        #expect(images.first?.digest == Digest.sha256(bytes))
        #expect(try String(contentsOf: file, encoding: .utf8) == source)
        #expect(try Data(contentsOf: privateRoot.appendingPathComponent(images[0].relativePath)) == bytes)
    }
}
