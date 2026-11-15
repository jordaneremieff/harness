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
        #expect(rendered.images[0].source == .local(token: "a0"))
        #expect(rendered.images[1].source == .external(URL(string: "https://example.com/remote.png")!))
        #expect(rendered.images[2].source == .embedded)
        #expect(rendered.images[3].source == .unavailable(reason: "missing"))
        #expect(rendered.images[4].source == .local(token: "a1"))
    }

    @Test func imagesOpenTheirInspectionUnlessALinkHoldsThem() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-image-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: folder.appendingPathComponent("local.png"))
        let source = "![Local](local.png)\n\n![](local.png)\n\n![Gone](missing.png)\n\n[![Linked](local.png)](https://example.com/)\n\n![Far](https://example.com/far.png)\n"
        let body = MarkdownRenderer.render(source, resolver: DirectoryAssetResolver(directory: folder), nonce: "n1").body
        #expect(body.contains("<a class=\"img-open\" href=\"reader-action:inspect-image/n1/0\"><img data-asset=\"a0\" data-image-rendering=\"n1\" data-reference=\"local.png\" src=\"reader-asset://doc/a0\" alt=\"Local\" decoding=\"async\" data-image=\"0\"></a>"))
        #expect(body.contains("<a class=\"img-open\" href=\"reader-action:inspect-image/n1/1\" aria-label=\"Inspect image\"><img data-asset=\"a1\""))
        #expect(body.contains("data-image=\"2\"><span class=\"ph-kind\">Image unavailable (file missing)</span>"))
        #expect(body.contains("<code>missing.png</code><a class=\"img-inspect\" href=\"reader-action:inspect-image/n1/2\">Details</a></span>"))
        #expect(body.contains("<a class=\"ext\" href=\"https://example.com/\" title=\"https://example.com/\"><img data-asset=\"a2\" data-image-rendering=\"n1\" data-reference=\"local.png\" src=\"reader-asset://doc/a2\" alt=\"Linked\" decoding=\"async\" data-image=\"3\"></a>"))
        #expect(!body.contains("inspect-image/n1/3"))
        #expect(body.contains("<a class=\"img-inspect\" href=\"reader-action:inspect-image/n1/4\">Details</a></span>"))
    }
}
