import Foundation
import MarkdownCore
import Observation
import AppKit

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

/// Native facts for the page-owned image inspection. The page owns layout, zoom and dismissal.
@MainActor @Observable
public final class ImageInspection {
    public enum Zoom: Equatable, Sendable { case fit, scale(Double) }
    enum Subject: Sendable { case asset(ResolvedAsset), address(String), none(String) }
    public static let scales: [Double] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]
    static let margin = 12.0
    public private(set) var facts: ImageFacts?
    public private(set) var naturalSize: CGSize?
    public private(set) var problem: String?
    public private(set) var address = ""
    public weak var page: ReaderWebPage?
    public init() {}
    public var isOpen: Bool { facts != nil }
    public static func fitScale(natural: CGSize, view: CGSize) -> Double {
        guard natural.width > 0, natural.height > 0 else { return 1 }
        return min(max(1, view.width - 2 * margin) / natural.width, max(1, view.height - 2 * margin) / natural.height)
    }
    public static func step(from scale: Double, larger: Bool) -> Double? {
        larger ? scales.first { $0 > scale * 1.001 } : scales.last { $0 < scale * 0.999 }
    }
    func open(_ facts: ImageFacts, subject: Subject, title: String) async {
        self.facts = facts; naturalSize = nil; problem = nil; address = ""
        switch subject {
        case .none(let reason): problem = reason
        case .address(let address):
            self.address = address
            if let url = URL(string: address), let data = try? Data(contentsOf: url) { naturalSize = NSImage(data: data)?.size }
        case .asset(let asset):
            do {
                let data = try asset.readData()
                naturalSize = NSImage(data: data)?.size
            } catch { problem = "The image was not served: \(error.localizedDescription)" }
        }
    }
    func setAddress(_ address: String) { self.address = address }
    func note(_ evidence: [ImageEvidence]) {
        guard let reference = facts?.reference, let found = evidence.first(where: { $0.reference == reference }) else { return }
        facts?.evidence = found
    }
    public func close() { facts = nil; naturalSize = nil; problem = nil; address = ""; page = nil }
}

extension PageScript {
    static let imageInView = """
    const images = document.querySelectorAll('[data-image]');
    for (const image of images) { if (image.getBoundingClientRect().bottom > 0) return Number(image.dataset.image); }
    return images.length ? Number(images[images.length - 1].dataset.image) : -1;
    """
}

extension ReaderModel {
    /// Opens the inspection of the image at `index` of the shown revision.
    public func inspectImage(_ index: Int) async {
        await prepareImage(index)
        if inspection.facts?.index == index { await sendCommand("inspectImage", args: ["index": index]) }
    }

    func prepareImage(_ index: Int) async {
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
        inspection.page = page
        await inspection.open(facts, subject: subject, title: displayTitle)
        if case .local(let token) = rendered.images[index].source, inspection.problem == nil {
            inspection.setAddress("\(MarkdownRenderer.assetScheme)://doc/\(token)")
        }
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
        await sendCommand("escape")
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
