import Testing
import AppKit
import CryptoKit
import WebKit
@testable import MarkdownCore
@testable import ReaderFeature

/// A store in the version-1 layout with revisions that carry inspected reference inventories.
@MainActor
struct ReviewStore {
    let root: URL
    private let storeId = "0123456789abcdef0123456789abcdef"
    let id = "md-0123456789abcdef0123"

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-review-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try write(["version": 1, "storeId": storeId], to: root.appendingPathComponent("store.json"))
    }

    var reference: DocumentReference { .stored(root: FileAccess.canonicalPath(root.path), storeId: storeId, document: id) }

    private func write(_ value: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    }

    static func digest(_ data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Publishes a revision. Each image is retained under its reference with the given bytes.
    @discardableResult
    func publish(_ revision: Int, _ source: String, images: [String: Data] = [:]) throws -> String {
        let document = root.appendingPathComponent("documents/\(id)")
        let location = document.appendingPathComponent("revisions/\(revision)")
        try FileManager.default.createDirectory(at: location.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let data = Data(source.utf8)
        try data.write(to: location.appendingPathComponent("source.md"))
        var items: [[String: Any]] = []
        for (reference, bytes) in images.sorted(by: { $0.key < $1.key }) {
            let digest = Self.digest(bytes)
            let svg = reference.hasSuffix(".svg")
            let file = "assets/\(digest.dropFirst(7)).\(svg ? "svg" : "png")"
            try bytes.write(to: location.appendingPathComponent(file))
            items.append(["kind": "image", "reference": reference, "state": "retained", "file": file, "mediaType": svg ? "image/svg+xml" : "image/png", "bytes": bytes.count, "digest": digest])
        }
        let date = "2026-11-14T00:0\(revision % 10):00Z"
        try write(["version": 1, "document": id, "revision": revision, "title": "Design report", "createdAt": date,
                   "digest": Self.digest(data), "bytes": data.count, "completeness": ["state": "complete"],
                   "references": ["state": "inspected", "truncated": false, "omitted": 0, "items": items]],
                  to: location.appendingPathComponent("revision.json"))
        try write(["version": 1, "id": id, "kind": "published", "title": "Design report", "createdAt": date,
                   "updatedAt": date, "revision": revision, "digest": Self.digest(data), "bytes": data.count],
                  to: document.appendingPathComponent("document.json"))
        return Self.digest(data)
    }

    func corrupt(_ revision: Int) throws {
        try Data("# Changed after publication\n".utf8).write(to: root.appendingPathComponent("documents/\(id)/revisions/\(revision)/source.md"))
    }
}

@MainActor
private final class ReviewGate {
    private(set) var reached = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        reached = true
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private let reportSource = """
# Design report

Intro text.

## Latency

The cache answers in about 40 ms.

![Diagram](diagram.png)

"""

/// Two different files with the PNG signature; the reader compares their recorded identities.
private let imageOne = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1])
private let imageTwo = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 2, 2])

@MainActor @Suite(.serialized) struct RevisionReviews {
    @Test func finalBreakChangeAppearsBesideOtherSourceChanges() throws {
        for (old, new, ending) in [
            ("old\n", "new", "ends with a line break; the later source does not end with one."),
            ("old", "new\n", "does not end with a line break; the later source ends with one.")
        ] {
            let store = try ReviewStore()
            defer { try? FileManager.default.removeItem(at: store.root) }
            try store.publish(1, old)
            try store.publish(2, new)
            let review = try ReviewPage.prepare(store.reference, base: 1, target: 2, settings: PageSettings())
            #expect(review.summary.changedRegions == 1)
            #expect(!review.summary.finalLineBreakDiffers)
            #expect(review.html.contains("The earlier source " + ending))
            #expect(!review.html.contains("Every line is the same."))
        }
    }

    private func model(_ reference: DocumentReference) -> ReaderModel {
        ReaderModel(reference: reference, platform: ReaderPlatform(
            copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("test"), application: .failed("test")) }
        ), state: ReadingStateStore(directory: nil), webRoot: ReaderHostFixture.root)
    }

    private func window(_ model: ReaderModel) -> NSWindow {
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
        return window
    }

    private func wait(until condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    private func waitForFind(_ model: ReaderModel) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if model.findStatus == .found { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return model.findStatus == .found
    }

    @Test func thePageNamesTheDocumentBothRevisionsAndTheirDigests() throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let first = try store.publish(1, reportSource, images: ["diagram.png": imageOne])
        let second = try store.publish(2, reportSource.replacingOccurrences(of: "40 ms", with: "25 ms"), images: ["diagram.png": imageOne])
        let prepared = try ReviewPage.prepare(store.reference, base: nil, target: 2, settings: PageSettings())
        #expect(prepared.summary.base == 1)
        #expect(prepared.summary.target == 2)
        #expect(prepared.summary.changedRegions == 1)
        #expect(prepared.summary.assetChanges == 0)
        #expect(!prepared.summary.partial)
        #expect(prepared.html.contains("<code>\(store.id)</code>"))
        #expect(prepared.html.contains("Revision 1 ·"))
        #expect(prepared.html.contains("Revision 2 (latest)"))
        #expect(prepared.html.contains(first))
        #expect(prepared.html.contains(second))
        #expect(prepared.html.contains("Design report › Latency"))
        #expect(prepared.html.contains("<mark>40</mark>"))
        #expect(prepared.html.contains("<mark>25</mark>"))
        #expect(prepared.html.contains("rv-side rv-before"))
        #expect(prepared.html.contains("rv-side rv-after"))
        #expect(prepared.html.contains("without a model"))
        #expect(prepared.html.contains("The recorded images are the same in both revisions (1 compared"))
    }

    @Test func anImageOnlyRevisionShowsBothImagesAndNoSourceChange() throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, reportSource, images: ["diagram.png": imageOne])
        try store.publish(2, reportSource, images: ["diagram.png": imageTwo])
        let prepared = try ReviewPage.prepare(store.reference, base: 1, target: 2, settings: PageSettings())
        #expect(prepared.summary.changedRegions == 0)
        #expect(prepared.summary.assetChanges == 1)
        #expect(prepared.summary.line == "same Markdown source · 1 image change")
        #expect(prepared.html.contains("Changed: <code>diagram.png</code>"))
        #expect(prepared.html.contains("Used in: Design report › Latency"))
        #expect(prepared.html.contains("9 bytes"))
        #expect(prepared.html.contains("10 bytes"))
        #expect(prepared.html.contains(ReviewStore.digest(imageOne)))
        #expect(prepared.html.contains(ReviewStore.digest(imageTwo)))
        #expect(prepared.assets["rb-0"]?.bytes == 9)
        #expect(prepared.assets["rt-0"]?.bytes == 10)
        #expect(prepared.html.contains("src=\"reader-asset://doc/rb-0\""))
        #expect(prepared.html.contains("src=\"reader-asset://doc/rt-0\""))
    }

    @Test func aChangedBlockWithAnImageServesBothRevisionsImages() throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, reportSource, images: ["diagram.png": imageOne])
        try store.publish(2, reportSource.replacingOccurrences(of: "![Diagram]", with: "![Flow]"), images: ["diagram.png": imageTwo])
        let prepared = try ReviewPage.prepare(store.reference, base: 1, target: 2, settings: PageSettings())
        #expect(prepared.html.contains("src=\"reader-asset://doc/b-a0\""))
        #expect(prepared.html.contains("src=\"reader-asset://doc/t-a0\""))
        #expect(prepared.assets["b-a0"]?.bytes == 9)
        #expect(prepared.assets["t-a0"]?.bytes == 10)
    }

    @Test(arguments: [false, true]) func equivalentEmphasisUsesOneRendering(withImage: Bool) throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let image = withImage ? " ![Diagram](diagram.png)" : ""
        let images = withImage ? ["diagram.png": imageOne] : [:]
        try store.publish(1, "# Report\n\nA *word*\(image) here.\n", images: images)
        try store.publish(2, "# Report\n\nA _word_\(image) here.\n", images: images)
        let prepared = try ReviewPage.prepare(store.reference, base: 1, target: 2, settings: PageSettings())
        #expect(prepared.html.contains("Both revisions render this part alike"))
        #expect(!prepared.html.contains("rv-side rv-before"))
        #expect(prepared.html.contains("<em>word</em>"))
        if withImage {
            #expect(prepared.html.contains("src=\"reader-asset://doc/t-a0\""))
            #expect(prepared.assets["t-a0"]?.expectedDigest == ReviewStore.digest(imageOne))
        }
    }

    @Test func differentImageIdentitiesKeepBothRenderings() throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, "A *word* ![Diagram](diagram.png).\n", images: ["diagram.png": imageOne])
        try store.publish(2, "A _word_ ![Diagram](diagram.png).\n", images: ["diagram.png": imageTwo])
        let prepared = try ReviewPage.prepare(store.reference, base: 1, target: 2, settings: PageSettings())
        #expect(!prepared.html.contains("Both revisions render this part alike"))
        #expect(prepared.html.contains("src=\"reader-asset://doc/b-a0\""))
        #expect(prepared.html.contains("src=\"reader-asset://doc/t-a0\""))
    }

    @Test func comparisonFragmentsKeepContentAndSafeLinksWithoutAppControls() throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let source = """
        # Report

        [Section](#report) and [Web](https://example.com/report) with a note[^n].

        ![Diagram](diagram.png) ![Missing](missing.png)

        ```swift
        print("old")
        ```

        [^n]: The note.
        """
        try store.publish(1, source, images: ["diagram.png": imageOne])
        try store.publish(2, source.replacingOccurrences(of: "Report", with: "Updated").replacingOccurrences(of: "old", with: "new").replacingOccurrences(of: "Diagram", with: "Flow").replacingOccurrences(of: "with a note", with: "with the note"), images: ["diagram.png": imageOne])
        let prepared = try ReviewPage.prepare(store.reference, base: 1, target: 2, settings: PageSettings())
        #expect(!prepared.html.contains("reader-action:"))
        #expect(!prepared.html.contains("href=\"#"))
        #expect(!prepared.html.contains("class=\"copy\""))
        #expect(!prepared.html.contains("class=\"img-inspect\""))
        #expect(!prepared.html.contains("class=\"img-open\""))
        #expect(prepared.html.contains("href=\"https://example.com/report\""))
        #expect(prepared.html.contains("<pre><code>print(&quot;old&quot;)"))
        #expect(prepared.html.contains("src=\"reader-asset://doc/b-a0\""))
        #expect(prepared.html.contains("<sup"))
    }

    @Test(arguments: ["failure", "cancel", "close"]) func comparisonPreparationDefersFollowingUntilItEnds(ending: String) async throws {
        _ = NSApplication.shared
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, "# First\n")
        try store.publish(2, "# Second\n")
        let model = model(store.reference)
        model.displayNavigationForCheck = {}
        await model.open(origin: nil)
        model.followsLatest = true
        if ending == "failure" { try store.corrupt(1) }
        let gate = ReviewGate()
        model.review.preparationGate = { await gate.wait() }
        let comparing = Task { await model.reviewChanges() }
        #expect(await wait { gate.reached })
        #expect(await model.interacting())
        try store.publish(3, "# Third\n")
        await model.checkForUpdate()
        #expect(model.update == .revision(3))
        #expect(model.snapshot?.revision == 2)
        if ending == "cancel" { comparing.cancel() }
        if ending == "close" { await model.closeReview() }
        gate.release()
        await comparing.value
        #expect(model.review.preparing == nil)
        #expect(model.review.shown == nil)
        #expect(await wait { model.snapshot?.revision == 3 })
        if ending == "failure" { #expect(model.review.failure?.contains("digest") == true) }
        await model.close()
    }

    @Test func theEarlierRevisionIsAlwaysTheBase() throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        for revision in 1...3 { try store.publish(revision, "# Revision \(revision)\n") }
        let prepared = try ReviewPage.prepare(store.reference, base: 3, target: 1, settings: PageSettings())
        #expect(prepared.summary.base == 1)
        #expect(prepared.summary.target == 3)
        #expect(throws: ReviewError.self) { try ReviewPage.prepare(store.reference, base: 2, target: 2, settings: PageSettings()) }
        #expect(throws: ReviewError.self) { try ReviewPage.prepare(store.reference, base: nil, target: 1, settings: PageSettings()) }
    }

    @Test func theDocumentStaysWhileAComparisonPreparesAndWhenItFails() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, reportSource)
        try store.publish(2, reportSource.replacingOccurrences(of: "40 ms", with: "25 ms"))
        let model = model(store.reference)
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(model.canReviewChanges)
        let gate = ReviewGate()
        model.review.preparationGate = { await gate.wait() }
        let comparing = Task { await model.reviewChanges() }
        #expect(await wait { gate.reached })
        #expect(model.review.preparing?.target == 2)
        #expect(model.review.shown == nil)
        #expect(model.phase == .ready)
        #expect(model.snapshot?.revision == 2)
        gate.release()
        await comparing.value
        model.review.preparationGate = nil
        #expect(model.review.shown?.base == 1)
        #expect(model.review.shown?.target == 2)
        #expect(model.review.preparing == nil)
        #expect(model.review.visiblePage != nil)
        // The comparison fragment belongs to native data; the test host does not draw product UI.
        #expect(model.review.html.contains("<h1>Design report</h1>"))
        let documentHeading = try await model.page.callJavaScript("return document.querySelector('h1').textContent.trim();", contentWorld: PageScript.world) as? String
        #expect(documentHeading == "Design report")
        model.findQuery = "without a model"
        await model.find()
        #expect(await waitForFind(model))

        try store.corrupt(1)
        await model.reviewChanges(base: 1, target: 2)
        #expect(model.review.failure?.contains("digest") == true)
        #expect(model.review.shown?.base == 1)
        await model.closeReview()
        #expect(model.review.page == nil)
        await model.reviewChanges()
        #expect(model.review.shown == nil)
        #expect(model.review.failure != nil)
        #expect(model.phase == .ready)
        #expect(model.snapshot?.revision == 2)
        #expect(model.failure == nil)
        await model.close()
    }

    @Test func aNewerAvailableRevisionIsComparedWithTheShownOne() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        for revision in 1...2 { try store.publish(revision, "# Report\n\nRevision \(revision) text.\n") }
        let model = model(store.reference)
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        try store.publish(3, "# Report\n\nRevision 3 text.\n")
        await model.checkForUpdate()
        #expect(model.update == .revision(3))
        await model.reviewChanges()
        #expect(model.review.shown?.base == 2)
        #expect(model.review.shown?.target == 3)
        #expect(model.snapshot?.revision == 2)
        await model.reviewChanges()
        #expect(model.review.shown == nil)
        await model.close()
    }

    @Test func revisionsOlderThanTheListedChoicesStayReachable() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        for revision in [1, 2, 4] + Array(60...62) { try store.publish(revision, "# Revision \(revision)\n") }
        let model = model(store.reference)
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(model.snapshot?.revisions == [60, 61, 62])
        #expect(model.snapshot?.olderRevisionsUnlisted == true)
        await model.goToRevision(4)
        #expect(model.snapshot?.revision == 4)
        await model.showAdjacentRevision(newer: false)
        #expect(model.snapshot?.revision == 2)
        await model.showAdjacentRevision(newer: true)
        #expect(model.snapshot?.revision == 4)
        await model.goToRevision(63)
        #expect(model.snapshot?.revision == 4)
        #expect(model.notice?.kind == .warning)
        await model.goToRevision(61)
        await model.showAdjacentRevision(newer: false)
        #expect(model.snapshot?.revision == 60)
        await model.close()
    }
}

@MainActor
private final class Pasteboard {
    var copies: [String] = []
}

private let notesSource = """
# Notes

Text with *emphasis* here.

Second paragraph, plain.

"""

@MainActor @Suite(.serialized) struct PassageCitations {
    private func reader(_ store: ReviewStore, _ pasteboard: Pasteboard) async -> (ReaderModel, NSWindow) {
        let model = ReaderModel(reference: store.reference, platform: ReaderPlatform(
            copyText: { pasteboard.copies.append($0) }, openExternal: { _ in false }, reveal: { _ in },
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

    /// Selects the contents of the keyed blocks `first` through `last` of the rendering.
    private func select(_ model: ReaderModel, _ first: Int, _ last: Int) async throws {
        _ = try await model.page.callJavaScript("""
        const blocks = document.querySelectorAll('[data-block]');
        const range = document.createRange();
        range.setStart(blocks[first], 0);
        range.setEnd(blocks[last], blocks[last].childNodes.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
        """, arguments: ["first": first, "last": last], contentWorld: PageScript.world)
    }

    @Test func aRenderedPassageCarriesItsDocumentRevisionDigestAndLocator() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, notesSource)
        let digest = try store.publish(2, notesSource + "\nThird paragraph.\n")
        let pasteboard = Pasteboard()
        let (model, window) = await reader(store, pasteboard)
        defer { window.close() }

        await model.copyPassageWithSource()
        #expect(pasteboard.copies.isEmpty)
        #expect(model.notice?.text == "Select a passage first.")

        try await select(model, 2, 2)
        await model.copyPassageWithSource()
        #expect(pasteboard.copies.last == """
        Passage from "Design report" (exact Markdown source text):

        Second paragraph, plain.

        Reference:
        Document: \(store.id)
        Revision: 2 (the newest known revision)
        Source digest: \(digest)
        Section: Notes
        Block: 3 of 4
        Source lines: 5 (exact: the passage occurs once in the Markdown of its block, on these lines)

        """)

        try await select(model, 1, 1)
        await model.copyPassageWithSource()
        let rendered = try #require(pasteboard.copies.last)
        #expect(rendered.hasPrefix("Passage from \"Design report\" (rendered text):\n\nText with emphasis here.\n\nReference:\n"))
        #expect(rendered.contains("Block: 2 of 4\n"))
        #expect(rendered.hasSuffix("Source lines: 3 (the enclosing block; the passage is rendered text and its Markdown can differ)\n"))
        #expect(model.notice?.text == "Copied the passage with its reference: rendered text within source line 3.")

        // A selection that ends at the start of the next block, as a triple click makes it.
        _ = try await model.page.callJavaScript("""
        const blocks = document.querySelectorAll('[data-block]');
        const range = document.createRange();
        range.setStart(blocks[1], 0);
        range.setEnd(blocks[2], 0);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
        """, contentWorld: PageScript.world)
        await model.copyPassageWithSource()
        #expect(pasteboard.copies.last?.contains("Block: 2 of 4\n") == true)

        try await select(model, 1, 2)
        await model.copyPassageWithSource()
        let across = try #require(pasteboard.copies.last)
        #expect(across.contains("Block: 2–3 of 4\n"))
        #expect(across.hasSuffix("Source lines: 3–5 (the enclosing blocks; the passage is rendered text and its Markdown can differ)\n"))
        await model.close()
    }

    @Test func aSourceViewPassageAndAnOlderRevisionAreLabelled() async throws {
        let store = try ReviewStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let digest = try store.publish(1, notesSource)
        try store.publish(2, notesSource + "\nThird paragraph.\n")
        let pasteboard = Pasteboard()
        let (model, window) = await reader(store, pasteboard)
        defer { window.close() }
        await model.goToRevision(1)
        await model.toggleSource()
        #expect(model.showingSource)
        _ = try await model.page.callJavaScript("""
        const code = document.querySelector('pre.source > code');
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        const from = node.data.indexOf('Text with');
        const to = node.data.indexOf('Second paragraph') + 'Second paragraph'.length;
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
        """, contentWorld: PageScript.world)
        await model.copyPassageWithSource()
        #expect(pasteboard.copies.last == """
        Passage from "Design report" (exact Markdown source text):

        Text with *emphasis* here.

        Second paragraph

        Reference:
        Document: \(store.id)
        Revision: 1 (the newest known revision is 2)
        Source digest: \(digest)
        Section: Notes
        Block: 2–3 of 3
        Source lines: 3–5 (exact: the passage is the source text on these lines)

        """)
        await model.close()
    }
}
