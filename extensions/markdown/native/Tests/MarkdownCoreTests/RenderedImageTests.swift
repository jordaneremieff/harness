import Testing
@testable import MarkdownCore

@Suite(.serialized) struct RenderedImages {
    @Test func everyImageIsListedWithItsReferenceAlternativesAndSource() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-image-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: folder.appendingPathComponent("local.png"))
        let source = """
        ![Local diagram](local.png "The title")

        ![](https://example.com/remote.png)

        ![Dot](data:image/png;base64,iVBORw0KGgo=)

        ![Gone](missing.png)

        [![Linked](local.png)](https://example.com/)
        """
        let rendered = MarkdownRenderer.render(source, resolver: DirectoryAssetResolver(directory: folder), nonce: "n1")
        #expect(rendered.images.map(\.reference) == ["local.png", "https://example.com/remote.png", "data:image/png;base64,iVBORw0KGgo=", "missing.png", "local.png"])
        #expect(rendered.images.map(\.alt) == ["Local diagram", "", "Dot", "Gone", "Linked"])
        #expect(rendered.images[0].title == "The title")
        let token = try #require(rendered.assets.keys.first)
        #expect(rendered.images[0].source == .local(token: token))
        #expect(rendered.images[1].source == .external(URL(string: "https://example.com/remote.png")!))
        #expect(rendered.images[2].source == .embedded)
        #expect(rendered.images[3].source == .unavailable(reason: "missing"))
        #expect(rendered.images[4].source == .local(token: token))
    }

    @Test func changesInRetainedImageIdentityChangeItsAddressAndRenderedBlock() {
        struct Resolver: AssetResolving {
            let digest: String
            func resolve(_ reference: String) -> AssetResolution {
                .local(.init(path: "/asset.png", root: "/", mediaType: "image/png", bytes: 4, expectedDigest: digest, expectedBytes: 4))
            }
        }
        let source = "![Local](asset.png)"
        let first = MarkdownRenderer.render(source, resolver: Resolver(digest: "first"), nonce: "n1")
        let second = MarkdownRenderer.render(source, resolver: Resolver(digest: "second"), nonce: "n1")
        #expect(Set(first.assets.keys).isDisjoint(with: second.assets.keys))
        #expect(first.blocks.map(\.key) != second.blocks.map(\.key))
    }

    @Test func imagesOpenTheirInspectionUnlessALinkHoldsThem() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-image-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: folder.appendingPathComponent("local.png"))
        let source = "![Local](local.png)\n\n![](local.png)\n\n![Gone](missing.png)\n\n[![Linked](local.png)](https://example.com/)\n\n![Far](https://example.com/far.png)\n"
        let rendered = MarkdownRenderer.render(source, resolver: DirectoryAssetResolver(directory: folder), nonce: "n1")
        let body = rendered.body, token = try #require(rendered.assets.keys.first)
        #expect(body.contains("<a class=\"img-open\" href=\"reader-action:inspect-image/n1/0\"><img data-asset=\"\(token)\" data-image-rendering=\"n1\" data-reference=\"local.png\" src=\"reader-asset://doc/\(token)\" alt=\"Local\" decoding=\"async\" data-image=\"0\"></a>"))
        #expect(body.contains("<a class=\"img-open\" href=\"reader-action:inspect-image/n1/1\" aria-label=\"Inspect image\"><img data-asset=\"\(token)\""))
        #expect(body.contains("data-image=\"2\"><span class=\"ph-kind\" data-label=\"Image unavailable (file missing)\"></span>"))
        #expect(body.contains("<code>missing.png</code><a class=\"img-inspect\" href=\"reader-action:inspect-image/n1/2\" data-label=\"Details\"></a></span>"))
        #expect(body.contains("<a class=\"ext\" href=\"https://example.com/\" title=\"https://example.com/\"><img data-asset=\"\(token)\" data-image-rendering=\"n1\" data-reference=\"local.png\" src=\"reader-asset://doc/\(token)\" alt=\"Linked\" decoding=\"async\" data-image=\"3\"></a>"))
        #expect(!body.contains("inspect-image/n1/3"))
        #expect(body.contains("<a class=\"img-inspect\" href=\"reader-action:inspect-image/n1/4\" data-label=\"Details\"></a></span>"))
    }
}
