import Testing
import AppKit
@testable import MarkdownCore
@testable import ReaderFeature

private let wideDiagram = Data("""
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400" viewBox="0 0 1600 400">
<rect x="10" y="10" width="1580" height="380" fill="#e8eefc" stroke="#333"/>
<text x="800" y="210" text-anchor="middle" font-size="40">Wide diagram</text>
</svg>
""".utf8)

private let smallPicture = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7])

private let pictureSource = """
# Pictures

![Wide architecture diagram](wide.svg "Data flow")

![](plain.png)

![Remote chart](https://example.com/chart.png)

![Lost](lost.png)

![Dot](data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==)

"""

@MainActor
private final class Copies {
    var texts: [String] = []
}

@MainActor @Suite(.serialized) struct ImageInspections {
    private func reader(_ store: ReviewStore, copies: Copies = Copies()) async -> (ReaderModel, NSWindow) {
        let model = ReaderModel(reference: store.reference, platform: ReaderPlatform(
            copyText: { copies.texts.append($0) }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("test"), application: .failed("test")) }
        ), state: ReadingStateStore(directory: nil), webRoot: ReaderHostFixture.root)
        _ = NSApplication.shared
        let size = NSSize(width: 420, height: 700)
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -20000, y: -20000), size: size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let webView = model.page.webView
        webView.frame = NSRect(origin: .zero, size: size)
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.orderFrontRegardless()
        await model.open(origin: nil)
        return (model, window)
    }

    private func wait(until condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return await condition()
    }

    @Test func factsNameTheReferenceAlternativesAndRetainedIdentity() throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, pictureSource, images: ["wide.svg": wideDiagram, "plain.png": smallPicture])
        let snapshot = try DocumentLoader.load(store.reference)
        let rendered = MarkdownRenderer.render(snapshot.source, resolver: snapshot.resolver)
        let evidence = [ImageEvidence(reference: "wide.svg", resolved: true, served: true, displayed: true, failure: nil)]
        let wide = try #require(ImageFacts.make(index: 0, rendered: rendered, snapshot: snapshot, evidence: evidence))
        #expect(wide.count == 5)
        #expect(wide.alt == "Wide architecture diagram")
        #expect(wide.title == "Data flow")
        #expect(wide.state == .retained(mediaType: "image/svg+xml", bytes: wideDiagram.count, digest: ReviewStore.digest(wideDiagram)))
        #expect(wide.rows.map(\.label) == ["Alt text", "Title", "Reference", "State", "Digest", "In the document"])
        #expect(wide.rows.map(\.value) == [
            "Wide architecture diagram", "Data flow", "wide.svg",
            "Retained with revision 1 · image/svg+xml · \(wideDiagram.count) bytes",
            ReviewStore.digest(wideDiagram), "Served and displayed",
        ])
        #expect(wide.accessibilityLabel == "Image: Wide architecture diagram. Title: Data flow")
        #expect(wide.referenceText == """
        Image reference: wide.svg
        Document: \(store.id)
        Revision: 1
        Retained asset: image/svg+xml, \(wideDiagram.count) bytes
        Asset digest: \(ReviewStore.digest(wideDiagram))
        Alt text: Wide architecture diagram

        """)

        let plain = try #require(ImageFacts.make(index: 1, rendered: rendered, snapshot: snapshot, evidence: evidence))
        #expect(plain.rows.first?.value == "None. The source gives this image no alternative text.")
        #expect(plain.accessibilityLabel == "Image without alternative text. Reference: plain.png")
        #expect(plain.evidence == nil)
        #expect(plain.rows.map(\.label) == ["Alt text", "Reference", "State", "Digest"])

        let remote = try #require(ImageFacts.make(index: 2, rendered: rendered, snapshot: snapshot, evidence: []))
        #expect(remote.state == .external(URL(string: "https://example.com/chart.png")!))
        #expect(remote.stateText == "External address. The reader does not load it.")
        #expect(remote.referenceText == nil)
        let lost = try #require(ImageFacts.make(index: 3, rendered: rendered, snapshot: snapshot, evidence: []))
        #expect(lost.stateText == "Unavailable: no folder to resolve it against")
        #expect(lost.referenceText == nil)
        let dot = try #require(ImageFacts.make(index: 4, rendered: rendered, snapshot: snapshot, evidence: []))
        #expect(dot.state == .embedded(mediaType: "image/gif"))
        #expect(dot.stateText == "Embedded in the Markdown source · image/gif")
        #expect(ImageFacts.make(index: 5, rendered: rendered, snapshot: snapshot, evidence: []) == nil)
    }

    @Test func aPlainFilesImageIsALocalFileWithoutARetainedReference() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-inspection-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try smallPicture.write(to: folder.appendingPathComponent("plain.png"))
        try Data("![Plain](plain.png)\n".utf8).write(to: folder.appendingPathComponent("notes.md"))
        let snapshot = try DocumentLoader.load(.file(path: FileAccess.canonicalPath(folder.appendingPathComponent("notes.md").path)))
        let rendered = MarkdownRenderer.render(snapshot.source, resolver: snapshot.resolver)
        let facts = try #require(ImageFacts.make(index: 0, rendered: rendered, snapshot: snapshot, evidence: []))
        #expect(facts.state == .localFile(mediaType: "image/png", bytes: 9))
        #expect(facts.stateText == "Local file beside the document, not retained · image/png · 9 bytes")
        #expect(facts.document == nil)
        #expect(facts.referenceText == nil)
    }

    @Test func zoomStepsAndFitFollowTheImageAndViewSizes() {
        #expect(ImageInspection.fitScale(natural: CGSize(width: 1600, height: 400), view: CGSize(width: 424, height: 600)) == 0.25)
        #expect(ImageInspection.fitScale(natural: CGSize(width: 100, height: 400), view: CGSize(width: 424, height: 224)) == 0.5)
        #expect(ImageInspection.fitScale(natural: .zero, view: CGSize(width: 400, height: 300)) == 1)
        #expect(ImageInspection.step(from: 1, larger: true) == 1.5)
        #expect(ImageInspection.step(from: 1, larger: false) == 0.75)
        #expect(ImageInspection.step(from: 0.2475, larger: true) == 0.25)
        #expect(ImageInspection.step(from: 0.2475, larger: false) == 0.1)
        #expect(ImageInspection.step(from: 8, larger: true) == nil)
        #expect(ImageInspection.step(from: 0.1, larger: false) == nil)
    }

    @Test func aRetainedWideImageNamesItsAssetFactsAndCopiesItsReference() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, pictureSource, images: ["wide.svg": wideDiagram, "plain.png": smallPicture])
        let copies = Copies()
        let (model, window) = await reader(store, copies: copies)
        defer { window.close() }
        let nonce = try #require(model.rendered?.nonce)

        model.handle(.inspectImage(nonce: "another-rendering", index: 0))
        model.handle(.inspectImage(nonce: nonce, index: 0))
        #expect(await wait { model.inspection.naturalSize != nil && model.pageState?.overlay == "image" })
        #expect(model.inspection.facts?.index == 0)
        #expect(model.inspection.naturalSize == CGSize(width: 1600, height: 400))
        #expect(await model.interacting())
        #expect(model.inspection.facts?.reference == "wide.svg")
        #expect(model.inspection.facts?.evidence == nil)
        #expect(model.imageEvidence.isEmpty)
        #expect(model.inspectableImage(URL(string: "reader-action:inspect-image/\(nonce)/1")) == 1)
        #expect(model.inspectableImage(URL(string: "reader-action:inspect-image/other/1")) == nil)
        #expect(model.inspectableImage(URL(string: "https://example.com/")) == nil)

        model.copyImageReference()
        #expect(copies.texts.last?.hasPrefix("Image reference: wide.svg\nDocument: \(store.id)\nRevision: 1\n") == true)
        #expect(copies.texts.last?.contains("Asset digest: \(ReviewStore.digest(wideDiagram))") == true)

        #expect(model.phase == .ready)
        #expect(model.snapshot?.revision == 1)
        #expect(model.dismissOverlay())
        #expect(await wait { !model.inspection.isOpen })
        #expect(model.inspection.page == nil)
        #expect(!model.dismissOverlay())
        await model.close()
    }

    @Test func imagesWithoutAShownFormStateWhyAndNeighboursAreReachable() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, pictureSource, images: ["wide.svg": wideDiagram, "plain.png": smallPicture])
        let (model, window) = await reader(store)
        defer { window.close() }
        await model.inspectImage(2)
        #expect(model.inspection.facts?.reference == "https://example.com/chart.png")
        #expect(model.inspection.problem == "The reader does not load images from the web. The address is below.")
        await model.inspectAdjacentImage(next: true)
        #expect(model.inspection.facts?.index == 3)
        #expect(model.inspection.problem == "This image is unavailable: no folder to resolve it against.")
        await model.inspectAdjacentImage(next: true)
        #expect(model.inspection.facts?.index == 4)
        #expect(model.inspection.facts?.state == .embedded(mediaType: "image/gif"))
        #expect(model.inspection.address == model.inspection.facts?.reference)
        await model.inspectAdjacentImage(next: true)
        #expect(model.inspection.facts?.index == 4)
        await model.toggleImageInspection()
        #expect(!model.inspection.isOpen)
        await model.toggleImageInspection()
        #expect(model.inspection.facts?.index == 0)
        await model.close()
        #expect(!model.inspection.isOpen)
    }

    @Test func aRetainedImageThatChangedOnDiskIsNotShown() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, pictureSource, images: ["wide.svg": wideDiagram, "plain.png": smallPicture])
        let (model, window) = await reader(store)
        defer { window.close() }
        let asset = store.root.appendingPathComponent("documents/\(store.id)/revisions/1/assets/\(ReviewStore.digest(wideDiagram).dropFirst(7)).svg")
        try Data(String(decoding: wideDiagram, as: UTF8.self).replacingOccurrences(of: "Wide diagram", with: "Other diagram").utf8).write(to: asset)
        await model.inspectImage(0)
        #expect(model.inspection.naturalSize == nil)
        #expect(model.inspection.problem?.hasPrefix("The image was not served:") == true)
        #expect(model.inspection.facts?.isRetained == true)
        await model.close()
    }
}
