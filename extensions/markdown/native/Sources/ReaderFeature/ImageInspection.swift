import Foundation
import MarkdownCore
import Observation
import SwiftUI
import WebKit

/// What the reader knows about one image of the shown revision: the Markdown reference, the
/// alternatives the source gives, how the revision holds the image, and what the document page
/// observed when it showed it.
public struct ImageFacts: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        /// Kept with the revision; the facts come from the revision's reference inventory.
        case retained(mediaType: String?, bytes: Int?, digest: String?)
        /// A file in the folder of a plain Markdown file. Nothing retains it.
        case localFile(mediaType: String, bytes: Int)
        /// A `data:` address inside the source.
        case embedded(mediaType: String?)
        /// A web address, which the reader never loads.
        case external(URL)
        case unavailable(reason: String)
    }

    static let referenceCharacters = 200

    /// Position among the revision's images, from 0, and their number.
    public var index: Int
    public var count: Int
    public var reference: String
    public var alt: String
    public var title: String
    public var state: State
    /// Set for a stored document.
    public var document: String?
    public var revision: Int?
    /// What the document page reported for the image; nil when it reported nothing.
    public var evidence: ImageEvidence?

    /// The facts of the image at `index` of a rendering, or nil when there is no such image.
    public static func make(index: Int, rendered: RenderedDocument, snapshot: DocumentSnapshot, evidence: [ImageEvidence]) -> ImageFacts? {
        guard rendered.images.indices.contains(index) else { return nil }
        let image = rendered.images[index]
        let state: State
        switch image.source {
        case .local(let token):
            let item = snapshot.record?.references?.items?.first { $0.kind == .image && $0.reference == image.reference && $0.state == "retained" }
            let asset = rendered.assets[token]
            if snapshot.record != nil {
                state = .retained(mediaType: item?.mediaType ?? asset?.mediaType, bytes: item?.bytes ?? asset?.bytes, digest: item?.digest)
            } else {
                state = .localFile(mediaType: asset?.mediaType ?? "", bytes: asset?.bytes ?? 0)
            }
        case .embedded:
            let header = image.reference.prefix(64).lowercased()
            let mediaType = header.hasPrefix("data:") ? header.dropFirst(5).prefix { $0 != ";" && $0 != "," } : ""
            state = .embedded(mediaType: mediaType.isEmpty ? nil : String(mediaType))
        case .external(let url):
            state = .external(url)
        case .unavailable(let reason):
            state = .unavailable(reason: reason)
        }
        var document: String?
        if case .stored(_, _, let id) = snapshot.reference { document = id }
        return ImageFacts(
            index: index,
            count: rendered.images.count,
            reference: image.reference,
            alt: image.alt,
            title: image.title,
            state: state,
            document: document,
            revision: snapshot.revision,
            evidence: evidence.first { $0.reference == image.reference }
        )
    }

    public var isRetained: Bool {
        if case .retained = state { return true }
        return false
    }

    /// The reference as the source has it, shortened when it is a long `data:` address.
    public var shownReference: String {
        reference.count > Self.referenceCharacters ? String(reference.prefix(Self.referenceCharacters - 1)) + "…" : reference
    }

    public var stateText: String {
        func described(_ lead: String, _ mediaType: String?, _ bytes: Int?) -> String {
            ([lead] + [mediaType, bytes.map { "\($0) bytes" }].compactMap { $0 }.filter { !$0.isEmpty }).joined(separator: " · ")
        }
        switch state {
        case .retained(let mediaType, let bytes, _):
            return described("Retained with revision \(revision.map(String.init) ?? "?")", mediaType, bytes)
        case .localFile(let mediaType, let bytes):
            return described("Local file beside the document, not retained", mediaType, bytes)
        case .embedded(let mediaType):
            return described("Embedded in the Markdown source", mediaType, nil)
        case .external:
            return "External address. The reader does not load it."
        case .unavailable(let reason):
            return "Unavailable: \(MarkdownRenderer.reasonLabel(reason))"
        }
    }

    /// What the document page observed, in one sentence.
    public var evidenceText: String? {
        guard let evidence else { return nil }
        if let failure = evidence.failure { return "Not shown: \(failure)" }
        if evidence.displayed { return "Served and displayed" }
        return evidence.served ? "Served; display not confirmed" : "Resolved; not yet served"
    }

    /// Label and value pairs for the view, in reading order.
    public var rows: [(label: String, value: String)] {
        var rows: [(String, String)] = [("Alt text", alt.isEmpty ? "None. The source gives this image no alternative text." : alt)]
        if !title.isEmpty { rows.append(("Title", title)) }
        rows.append(("Reference", shownReference))
        rows.append(("State", stateText))
        if case .retained(_, _, let digest?) = state { rows.append(("Digest", digest)) }
        if let evidenceText { rows.append(("In the document", evidenceText)) }
        return rows
    }

    /// What assistive technology reads for the image itself.
    public var accessibilityLabel: String {
        if alt.isEmpty { return "Image without alternative text. Reference: \(shownReference)" + (title.isEmpty ? "" : ". Title: \(title)") }
        return "Image: \(alt)" + (title.isEmpty ? "" : ". Title: \(title)")
    }

    /// The text of Copy Reference: enough to name the exact retained asset. Nil unless retained.
    public var referenceText: String? {
        guard case .retained(let mediaType, let bytes, let digest) = state else { return nil }
        var lines = ["Image reference: \(reference)"]
        if let document { lines.append("Document: \(document)") }
        if let revision { lines.append("Revision: \(revision)") }
        let described = [mediaType, bytes.map { "\($0) bytes" }].compactMap { $0 }
        if !described.isEmpty { lines.append("Retained asset: \(described.joined(separator: ", "))") }
        if let digest { lines.append("Asset digest: \(digest)") }
        if !alt.isEmpty { lines.append("Alt text: \(alt)") }
        return lines.joined(separator: "\n") + "\n"
    }
}

/// The inspection of one image that a reader window shows over its document. The image has its
/// own page, where WebKit renders it under the reader's content policy; the document's page
/// stays loaded below with its position and selection.
@MainActor @Observable
public final class ImageInspection {
    public enum Zoom: Equatable, Sendable {
        /// The whole image inside the view.
        case fit
        /// A multiple of the image's own size; 1 is actual size.
        case scale(Double)
    }

    /// What the page shows.
    enum Subject: Sendable {
        case asset(ResolvedAsset)
        /// A `data:` address.
        case address(String)
        /// No image; the text says why.
        case none(String)
    }

    /// The scales that zooming in and out steps through.
    public static let scales: [Double] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]
    /// The page keeps this much space around the image, on each side.
    static let margin = 12.0
    static let token = "subject"

    /// The inspected image. Nil while no inspection is open.
    public private(set) var facts: ImageFacts?
    public private(set) var zoom: Zoom = .fit
    /// The image's own size in points, once the page displayed it.
    public private(set) var naturalSize: CGSize?
    /// Why the view shows no image.
    public private(set) var problem: String?
    public private(set) var page: WebPage?

    @ObservationIgnored private let assets = AssetTable()
    @ObservationIgnored private let router = NavigationRouter()
    @ObservationIgnored private var generation = 0
    @ObservationIgnored var expectingLoad = false

    public init() {}

    public var isOpen: Bool { facts != nil }

    /// "Fit", or the scale as a percentage.
    public var zoomLabel: String {
        switch zoom {
        case .fit: "Fit"
        case .scale(let scale): "\(Int((scale * 100).rounded()))%"
        }
    }

    /// The scale at which an image of `natural` size fills a view of `view` size inside the
    /// page's margin.
    public static func fitScale(natural: CGSize, view: CGSize) -> Double {
        guard natural.width > 0, natural.height > 0 else { return 1 }
        let width = max(1, view.width - 2 * margin)
        let height = max(1, view.height - 2 * margin)
        return min(width / natural.width, height / natural.height)
    }

    /// The next listed scale above or below `scale`, or nil at the end of the list.
    public static func step(from scale: Double, larger: Bool) -> Double? {
        larger ? scales.first { $0 > scale * 1.001 } : scales.last { $0 < scale * 0.999 }
    }

    /// Shows an image. The last request wins.
    func open(_ facts: ImageFacts, subject: Subject, title: String) async {
        generation += 1
        let token = generation
        self.facts = facts
        zoom = .fit
        naturalSize = nil
        problem = nil
        let address: String
        switch subject {
        case .none(let reason):
            problem = reason
            discardPage()
            return
        case .asset(let asset):
            assets.replace([Self.token: asset])
            address = "\(MarkdownRenderer.assetScheme)://doc/\(Self.token)"
        case .address(let data):
            assets.replace([:])
            address = data
        }
        do {
            try await display(InspectionPage.html(address: address, alt: facts.alt, title: facts.title, pageTitle: title))
        } catch {
            guard token == generation else { return }
            problem = "The image could not be shown: \(error.localizedDescription)"
            return
        }
        // The page loads with the image at its own size and hidden, because a scaled SVG image
        // reports its laid-out size as its natural size. Fit applies once the size is known.
        guard token == generation, let measured = await measure(), token == generation else { return }
        if measured.natural.width > 0, measured.natural.height > 0 {
            if await show(.fit, natural: measured.natural), token == generation { naturalSize = measured.natural }
        } else {
            problem = assets.evidence(Self.token).failure.map { "The image was not served: \($0)" } ?? "The image did not load or could not be decoded."
        }
    }

    /// Replaces what the document page observed for the inspected image.
    func note(_ evidence: [ImageEvidence]) {
        guard let reference = facts?.reference, let found = evidence.first(where: { $0.reference == reference }) else { return }
        facts?.evidence = found
    }

    public func close() {
        generation += 1
        facts = nil
        naturalSize = nil
        problem = nil
        zoom = .fit
        discardPage()
    }

    public func zoomToFit() async {
        await apply(.fit)
    }

    public func actualSize() async {
        await apply(.scale(1))
    }

    public func zoomIn() async {
        guard let scale = await currentScale(), let next = Self.step(from: scale, larger: true) else { return }
        await apply(.scale(next))
    }

    public func zoomOut() async {
        guard let scale = await currentScale(), let next = Self.step(from: scale, larger: false) else { return }
        await apply(.scale(next))
    }

    /// The scale on screen: the chosen one, or the one that Fit gives in the view's current size.
    func currentScale() async -> Double? {
        guard let naturalSize else { return nil }
        switch zoom {
        case .scale(let scale): return scale
        case .fit:
            guard let measured = await measure() else { return nil }
            return Self.fitScale(natural: naturalSize, view: measured.view)
        }
    }

    private func apply(_ zoom: Zoom) async {
        guard let naturalSize, problem == nil else { return }
        await show(zoom, natural: naturalSize)
    }

    /// Puts a zoom on the page for an image of `natural` size. Returns false when the page did
    /// not take it.
    @discardableResult
    private func show(_ zoom: Zoom, natural: CGSize) async -> Bool {
        guard let page else { return false }
        var arguments: [String: Any] = ["mode": "fit", "width": 0]
        if case .scale(let scale) = zoom {
            arguments = ["mode": "scale", "width": max(1, Int((natural.width * scale).rounded()))]
        }
        let token = generation
        guard (try? await page.callJavaScript(PageScript.applyImageZoom, arguments: arguments, contentWorld: PageScript.world)) != nil, token == generation else { return false }
        self.zoom = zoom
        return true
    }

    private func measure() async -> (natural: CGSize, view: CGSize)? {
        guard let page, let value = try? await page.callJavaScript(PageScript.measureImage, contentWorld: PageScript.world) as? [String: Any] else { return nil }
        func number(_ key: String) -> Double { (value[key] as? Double) ?? Double((value[key] as? Int) ?? 0) }
        return (CGSize(width: number("width"), height: number("height")), CGSize(width: number("viewWidth"), height: number("viewHeight")))
    }

    private func display(_ html: String) async throws {
        let page = self.page ?? makePage()
        expectingLoad = true
        defer { expectingLoad = false }
        do {
            for try await _ in page.load(html: html, baseURL: URL(string: "about:blank")!) {}
        } catch WebPage.NavigationError.webContentProcessTerminated {
            for try await _ in page.load(html: html, baseURL: URL(string: "about:blank")!) {}
        }
    }

    private func makePage() -> WebPage {
        let page = ReaderPageFactory.make(router: router, assets: assets)
        router.handler = self
        self.page = page
        return page
    }

    private func discardPage() {
        page = nil
        assets.replace([:])
    }
}

/// The inspection page allows its own load and nothing else.
extension ImageInspection: NavigationHandling {
    func handle(_ request: NavigationRequest) {}
}

extension PageScript {
    /// The image's own size and the view's size, in CSS pixels. The image's size is its own only
    /// while the page does not scale it.
    static let measureImage = """
    const image = document.getElementById('subject');
    if (!image) return null;
    return { width: image.complete ? image.naturalWidth : 0, height: image.complete ? image.naturalHeight : 0, viewWidth: window.innerWidth, viewHeight: window.innerHeight };
    """

    /// Sets the zoom mode and, at a chosen scale, the image's width. The point in the middle of
    /// the view stays in the middle.
    static let applyImageZoom = """
    const image = document.getElementById('subject');
    if (!image) return false;
    const root = document.scrollingElement || document.documentElement;
    const centerX = (root.scrollLeft + window.innerWidth / 2) / Math.max(1, root.scrollWidth);
    const centerY = (root.scrollTop + window.innerHeight / 2) / Math.max(1, root.scrollHeight);
    document.documentElement.dataset.zoom = mode;
    if (mode === "scale") image.setAttribute("width", String(width)); else image.removeAttribute("width");
    root.scrollLeft = centerX * root.scrollWidth - window.innerWidth / 2;
    root.scrollTop = centerY * root.scrollHeight - window.innerHeight / 2;
    return true;
    """

    /// The index of the first image that reaches into the view, else of the last image above it.
    static let imageInView = """
    const images = document.querySelectorAll('[data-image]');
    for (const image of images) {
      if (image.getBoundingClientRect().bottom > 0) return Number(image.dataset.image);
    }
    return images.length ? Number(images[images.length - 1].dataset.image) : -1;
    """
}

/// The page of one inspected image: the reader's content policy and stylesheet, no script, and
/// the image with the alternatives that the source gives it.
enum InspectionPage {
    static func html(address: String, alt: String, title: String, pageTitle: String) -> String {
        """
        <!doctype html>
        <html data-zoom="measure">
        <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(PageTemplate.contentSecurityPolicy)">
        <meta name="color-scheme" content="light dark">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(MarkdownRenderer.escape(pageTitle))</title>
        <link rel="stylesheet" href="\(PageTemplate.stylesheetAddress)">
        </head>
        <body class="inspect"><img id="subject" src="\(MarkdownRenderer.escape(address))" alt="\(MarkdownRenderer.escape(alt))"\(title.isEmpty ? "" : " title=\"\(MarkdownRenderer.escape(title))\"")></body>
        </html>
        """
    }
}

extension ReaderModel {
    /// Opens the inspection of the image at `index` of the shown revision.
    public func inspectImage(_ index: Int) async {
        guard let snapshot, let rendered, let facts = ImageFacts.make(index: index, rendered: rendered, snapshot: snapshot, evidence: imageEvidence) else { return }
        let subject: ImageInspection.Subject
        switch rendered.images[index].source {
        case .local(let token):
            subject = rendered.assets[token].map { .asset($0) } ?? .none("The image is not available in this rendering.")
        case .embedded:
            subject = .address(facts.reference)
        case .external:
            subject = .none("The reader does not load images from the web. The address is below.")
        case .unavailable(let reason):
            subject = .none("This image is unavailable: \(MarkdownRenderer.reasonLabel(reason)).")
        }
        readerLog.notice("inspect image \(self.reference.key, privacy: .public) index=\(index, privacy: .public) of \(rendered.images.count, privacy: .public)")
        await inspection.open(facts, subject: subject, title: displayTitle)
        // The document page's first observation can precede the image's decoding; ask again
        // when it did not confirm the display.
        if case .local = rendered.images[index].source, facts.evidence?.displayed != true, facts.evidence?.failure == nil, !showingSource {
            let observed = await inspectImages()
            guard self.rendered?.nonce == rendered.nonce, inspection.facts?.index == index else { return }
            imageEvidence = observed
            inspection.note(observed)
        }
    }

    /// Opens the inspection of the image in view, or ends an open inspection.
    public func toggleImageInspection() async {
        if inspection.isOpen {
            await closeImageInspection()
            return
        }
        guard let rendered, !rendered.images.isEmpty else {
            post("This document has no images.", kind: .info)
            return
        }
        let found = try? await page.callJavaScript(PageScript.imageInView, contentWorld: PageScript.world) as? Int
        await inspectImage(found.flatMap { rendered.images.indices.contains($0) ? $0 : nil } ?? 0)
    }

    /// Moves the inspection to the next or previous image of the revision.
    public func inspectAdjacentImage(next: Bool) async {
        guard let facts = inspection.facts else { return }
        await inspectImage(facts.index + (next ? 1 : -1))
    }

    /// Ends the inspection. A revision that arrived meanwhile is then followed or announced.
    public func closeImageInspection() async {
        inspection.close()
        await checkForUpdate()
    }

    /// The index that an inspection action address names, when it belongs to the shown rendering.
    public func inspectableImage(_ url: URL?) -> Int? {
        guard case .inspectImage(let nonce, let index) = NavigationRequest.classify(url, expectingLoad: false), nonce == rendered?.nonce else { return nil }
        return index
    }

    /// Ends what lies over the document: the image inspection first, else the comparison.
    /// Returns false when nothing lay over it.
    @discardableResult
    public func dismissOverlay() -> Bool {
        guard inspection.isOpen || review.shown != nil else { return false }
        Task {
            if inspection.isOpen { await closeImageInspection() } else { await closeReview() }
        }
        return true
    }

    public func copyImageReference() {
        guard let text = inspection.facts?.referenceText else { return }
        platform.copyText(text)
        post("Copied the image reference with its digest.", kind: .info)
    }
}

/// The inspection layer of a reader: a bar with the zoom controls, the image, and what the
/// revision records about it.
struct ImageInspectionLayer: View {
    @Bindable var model: ReaderModel

    var body: some View {
        if let facts = model.inspection.facts {
            VStack(spacing: 0) {
                InspectionBar(model: model, facts: facts)
                subject(facts)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                InspectionFacts(model: model, facts: facts)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background { Rectangle().fill(.background) }
        }
    }

    @ViewBuilder private func subject(_ facts: ImageFacts) -> some View {
        let inspection = model.inspection
        if let problem = inspection.problem {
            ContentUnavailableView {
                Label("No image to show", systemImage: "photo.badge.exclamationmark")
            } description: {
                Text(problem)
            }
        } else if let page = inspection.page {
            WebView(page)
                .webViewLinkPreviews(.disabled)
                .webViewBackForwardNavigationGestures(.disabled)
                .webViewElementFullscreenBehavior(.disabled)
                .webViewContextMenu { _ in
                    Button("Zoom to Fit") { Task { await inspection.zoomToFit() } }
                    Button("Actual Size") { Task { await inspection.actualSize() } }
                    Divider()
                    if facts.isRetained { Button("Copy Reference") { model.copyImageReference() } }
                    Button("Close Image") { Task { await model.closeImageInspection() } }
                }
                .accessibilityLabel(facts.accessibilityLabel)
        } else {
            ProgressView().controlSize(.small)
        }
    }
}

struct InspectionBar: View {
    @Bindable var model: ReaderModel
    let facts: ImageFacts

    var body: some View {
        let inspection = model.inspection
        let zoomable = inspection.naturalSize != nil && inspection.problem == nil
        HStack(spacing: 6) {
            Button { Task { await model.inspectAdjacentImage(next: false) } } label: { Label("Previous Image", systemImage: "chevron.left") }
                .disabled(facts.index == 0)
                .help("Previous image")
            Button { Task { await model.inspectAdjacentImage(next: true) } } label: { Label("Next Image", systemImage: "chevron.right") }
                .disabled(facts.index + 1 >= facts.count)
                .help("Next image")
            Text("Image \(facts.index + 1) of \(facts.count)" + (zoomable ? " · \(inspection.zoomLabel)" : ""))
                .font(.callout)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Image \(facts.index + 1) of \(facts.count)" + (zoomable ? ", zoom \(inspection.zoomLabel)" : ""))
            Group {
                Button("Fit") { Task { await inspection.zoomToFit() } }
                    .help("Zoom to fit (⌘9)")
                Button("1:1") { Task { await inspection.actualSize() } }
                    .help("Actual size (⌘0)")
                    .accessibilityLabel("Actual size")
                Button { Task { await inspection.zoomOut() } } label: { Label("Zoom Out", systemImage: "minus.magnifyingglass") }
                    .help("Zoom out (⌘-)")
                Button { Task { await inspection.zoomIn() } } label: { Label("Zoom In", systemImage: "plus.magnifyingglass") }
                    .help("Zoom in (⌘=)")
            }
            .disabled(!zoomable)
            Button("Done") { Task { await model.closeImageInspection() } }
                .help("Close the image (Esc)")
        }
        .labelStyle(.iconOnly)
        .controlSize(.small)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

struct InspectionFacts: View {
    @Bindable var model: ReaderModel
    let facts: ImageFacts

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 3) {
                ForEach(facts.rows, id: \.label) { row in
                    GridRow {
                        Text(row.label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                        Text(row.value)
                            .textSelection(.enabled)
                            .lineLimit(row.label == "Alt text" ? 4 : 2)
                            .truncationMode(.middle)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .font(.caption)
            if facts.isRetained {
                Button("Copy Reference") { model.copyImageReference() }
                    .controlSize(.small)
                    .help("Copy the reference with the document, revision and digest")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}
