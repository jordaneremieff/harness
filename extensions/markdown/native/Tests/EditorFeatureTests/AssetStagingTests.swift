import Testing
@testable import MarkdownCore
@testable import EditorFeature
import CoreGraphics
import ImageIO

private func assetRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("editor-assets-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return root
}

private func smallTIFF() throws -> Data {
    let data = Data(repeating: 0xFF, count: 5 * 3 * 4)
    let provider = try #require(CGDataProvider(data: data as CFData))
    let image = try #require(CGImage(width: 5, height: 3, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 20,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    let output = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(output, "public.tiff" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return output as Data
}

@Suite struct AssetStagingTests {
    @Test func exactPrivateBytesAndIdenticalReuse() throws {
        let root = try assetRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = EditorAssetStore(root: root)
        let bytes = Data("image bytes".utf8)
        let source = root.appendingPathComponent("source.png")
        try bytes.write(to: source)
        let image = try store.stage(file: source)
        #expect(try store.stage(data: bytes, extension: "PNG") == image)
        #expect(image.digest == Digest.sha256(bytes))
        #expect(try Data(contentsOf: root.appendingPathComponent(image.relativePath)) == bytes)
        let attributes = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(image.relativePath).path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        for directory in [root, root.appendingPathComponent("assets")] {
            let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        }
    }

    @Test func oversizedInputLeavesSourceUnchanged() throws {
        let root = try assetRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data(repeating: 1, count: Limits.assetBytes + 1)
        let source = root.appendingPathComponent("large.png")
        try bytes.write(to: source)
        let store = EditorAssetStore(root: root)
        #expect(throws: (any Error).self) { try store.stage(data: bytes, extension: "png") }
        #expect(throws: (any Error).self) { try store.stage(file: source) }
        #expect(try Data(contentsOf: source) == bytes)
    }

    @Test func TIFFConversionAndPredecodeDimensionBound() throws {
        let root = try assetRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let image = try EditorAssetStore(root: root).stage(data: smallTIFF(), extension: "tiff")
        let bytes = try Data(contentsOf: root.appendingPathComponent(image.relativePath))
        #expect(image.relativePath.hasSuffix(".png"))
        #expect(Array(bytes.prefix(8)) == [137, 80, 78, 71, 13, 10, 26, 10])
        #expect(image.digest == Digest.sha256(bytes))
        #expect(throws: (any Error).self) { try EditorAssetStore.checkTIFFDimensions(width: 10_000, height: 10_000) }
        #expect(throws: (any Error).self) { try EditorAssetStore.checkTIFFDimensions(width: .max, height: 2) }
        #expect(throws: (any Error).self) { try EditorAssetStore.checkTIFFDimensions(width: 0, height: 2) }
        try EditorAssetStore.checkTIFFDimensions(width: 8_000, height: 8_000)
    }

    @Test func retainedIdentityRejectsChangedBytes() throws {
        let root = try assetRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = EditorAssetStore(root: root), bytes = Data("original".utf8)
        let image = try store.stage(data: bytes, extension: "webp")
        guard case .local(let asset) = store.resolver().resolve(image.reference) else { Issue.record("Missing staged image"); return }
        #expect(try asset.readData() == bytes)
        try Data("modified".utf8).write(to: root.appendingPathComponent(image.relativePath))
        #expect(throws: (any Error).self) { try asset.readData() }
        #expect(throws: (any Error).self) { try store.stage(data: bytes, extension: "webp") }
    }

    @Test func fullStoreRefusesWithoutEviction() throws {
        let root = try assetRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = EditorAssetStore(root: root)
        for index in 0..<64 { _ = try store.stage(data: Data([UInt8(index)]), extension: "png") }
        #expect(throws: (any Error).self) { try store.stage(data: Data([64]), extension: "png") }
        _ = try store.stage(data: Data([0]), extension: "png")
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("assets").path).count == 64)
    }

    @Test func refusesLinkedRootFileAndAssetDirectory() throws {
        let root = try assetRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let real = root.appendingPathComponent("real")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false)
        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
        #expect(throws: (any Error).self) { try EditorAssetStore(root: alias).stage(data: Data([1]), extension: "png") }
        let file = root.appendingPathComponent("real.png"), linked = root.appendingPathComponent("linked.png")
        try Data([1]).write(to: file)
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: file)
        #expect(throws: (any Error).self) { try EditorAssetStore(root: real).stage(file: linked) }
        try FileManager.default.createSymbolicLink(at: real.appendingPathComponent("assets"), withDestinationURL: root)
        #expect(throws: (any Error).self) { try EditorAssetStore(root: real).stage(data: Data([1]), extension: "png") }
    }
}
