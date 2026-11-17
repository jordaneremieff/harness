import Foundation
import MarkdownCore

/// What a prepared comparison holds, for the review bar and for callers that report it.
public struct ReviewSummary: Sendable, Equatable {
    public var base: Int
    /// Nil identifies the uncommitted source, which has no stored revision number.
    public var target: Int?
    public var changedRegions: Int
    public var addedLines: Int
    public var removedLines: Int
    public var assetChanges: Int
    public var finalLineBreakDiffers: Bool
    /// True when a bound kept the comparison from being complete, or images were not compared.
    public var partial: Bool

    /// One line: what differs, in the comparison's own counts.
    public var line: String {
        var parts: [String] = []
        if changedRegions > 0 {
            parts.append("\(changedRegions) changed part\(changedRegions == 1 ? "" : "s")")
            parts.append("\(addedLines) line\(addedLines == 1 ? "" : "s") added, \(removedLines) removed")
        } else if finalLineBreakDiffers {
            parts.append("only the final line break differs")
        } else {
            parts.append("same Markdown source")
        }
        if assetChanges > 0 { parts.append("\(assetChanges) image change\(assetChanges == 1 ? "" : "s")") }
        if partial { parts.append("partial") }
        return parts.joined(separator: " · ")
    }
}

/// A comparison page ready to display: its HTML, the images it may load and its summary.
struct PreparedReview: Sendable {
    var summary: ReviewSummary
    var html: String
    var assets: [String: ResolvedAsset]
}

enum ReviewError: Error, CustomStringConvertible {
    case notStored
    case noEarlierRevision(Int)
    case sameRevision(Int)

    var description: String {
        switch self {
        case .notStored: "Only a stored document has revisions to compare."
        case .noEarlierRevision(let revision): "No earlier revision was found near revision \(revision). Choose the revision to compare with."
        case .sameRevision(let revision): "Revision \(revision) cannot be compared with itself."
        }
    }
}

/// Builds read-only comparisons from stored revisions or a stored base and uncommitted source.
/// The body reports source and rendering differences, not an author's explanation.
enum ReviewPage {
    /// A region shows its rendered blocks only up to these sizes per side; the exact source
    /// difference is always present.
    static let renderedBlocks = 12
    static let renderedLines = 80
    /// An unchanged neighbour block serves as context only up to this length.
    static let contextLines = 12
    /// Rendered HTML that the page carries altogether.
    static let renderedBytes = 2 * 1024 * 1024
    static let assetChangesShown = 40
    static let referenceCharacters = 120
    /// A source difference of at most this many rows is open when the page loads.
    static let openRows = 60

    /// Reads both revisions and compares them. `base` nil means the nearest earlier revision.
    /// The earlier revision is always the comparison's base.
    static func prepare(_ reference: DocumentReference, base: Int?, target: Int, settings: PageSettings) throws -> PreparedReview {
        guard case .stored(let root, let storeId, let id) = reference else { throw ReviewError.notStored }
        let store = try DirectoryStore(root: URL(fileURLWithPath: root))
        guard store.storeId == storeId else { throw StoreError.notFound("store \(storeId) at \(root)") }
        let pointer = try store.document(id).revision
        var later = target
        guard var earlier = base ?? store.adjacentRevision(id, to: target, newer: false, pointer: pointer) else {
            throw ReviewError.noEarlierRevision(target)
        }
        guard earlier != later else { throw ReviewError.sameRevision(later) }
        if earlier > later { swap(&earlier, &later) }
        let old = try store.loadRevision(id, revision: earlier)
        let new = try store.loadRevision(id, revision: later)
        let comparison = RevisionDiff.compare(base: (old.record, old.source), target: (new.record, new.source))
        return build(comparison, base: old, target: new, settings: settings)
    }

    static func prepareDraft(base: DocumentSnapshot, currentSource: String, resolver: any AssetResolving) throws -> PreparedReview {
        guard case .stored(_, _, let id) = base.reference, let record = base.record, let document = base.document,
              record.document == id, document.id == id, record.digest == base.digest,
              Digest.sha256(Data(base.source.utf8)) == base.digest else { throw ReviewError.notStored }
        guard currentSource.utf8.count <= Limits.sourceBytes else { throw ReaderBridgeError.oversized }
        var current = record
        current.digest = Digest.sha256(Data(currentSource.utf8))
        current.bytes = currentSource.utf8.count
        current.createdAt = ""
        current.references = nil
        current.contentOrigin = nil
        let comparison = RevisionDiff.compare(base: (record, base.source), target: (current, currentSource))
        return build(comparison, baseSource: base.source, targetSource: currentSource, title: base.title,
                     response: document.kind == .response, baseResolver: base.resolver, targetResolver: resolver,
                     latest: document.revision, uncommitted: true)
    }

    static func build(_ comparison: RevisionComparison, base: LoadedRevision, target: LoadedRevision, settings: PageSettings) -> PreparedReview {
        build(comparison, baseSource: base.source, targetSource: target.source, title: target.record.title,
              response: target.document.kind == .response,
              baseResolver: StoredAssetResolver(revisionDirectory: base.directory, references: base.record.references, kind: base.document.kind),
              targetResolver: StoredAssetResolver(revisionDirectory: target.directory, references: target.record.references, kind: target.document.kind),
              latest: target.document.revision, uncommitted: false)
    }

    private static func build(_ comparison: RevisionComparison, baseSource: String, targetSource: String, title storedTitle: String,
                              response: Bool, baseResolver: any AssetResolving, targetResolver: any AssetResolving,
                              latest: Int, uncommitted: Bool) -> PreparedReview {
        var assets: [String: ResolvedAsset] = [:]
        let nonce = MarkdownRenderer.newNonce()
        let targetRendered = MarkdownRenderer.render(targetSource, resolver: targetResolver, nonce: nonce)
        var baseFragments: Fragments?
        var targetFragments: Fragments?
        if !comparison.regions.isEmpty {
            let baseRendered = MarkdownRenderer.render(baseSource, resolver: baseResolver, nonce: nonce)
            baseFragments = fragments(baseRendered, comparison.baseStructure, prefix: "b-", into: &assets)
            targetFragments = fragments(targetRendered, comparison.targetStructure, prefix: "t-", into: &assets)
        }
        let title = response ? targetRendered.contentTitle ?? storedTitle : storedTitle
        let shownChanges = comparison.assets.changes.prefix(assetChangesShown)
        var imagesCompared = true
        if case .notComparable = comparison.assets.coverage { imagesCompared = false }
        if case .incomplete = comparison.assets.coverage { imagesCompared = false }
        let summary = ReviewSummary(
            base: comparison.base.revision,
            target: uncommitted ? nil : comparison.target.revision,
            changedRegions: comparison.regions.count,
            addedLines: comparison.addedLines,
            removedLines: comparison.removedLines,
            assetChanges: comparison.assets.changes.count,
            finalLineBreakDiffers: comparison.finalLineBreakDiffers,
            partial: comparison.isPartial || !imagesCompared
        )

        var html = "<div class=\"review\">\n<header class=\"rv-head\">\n<p class=\"rv-kicker\">Review changes</p>\n"
        html += "<h1>\(escape(title))</h1>\n<dl class=\"rv-id\">\n"
        html += "<dt>\(uncommitted ? "Stored base document" : "Document")</dt><dd><code>\(escape(comparison.document))</code></dd>\n"
        if comparison.base.title != comparison.target.title {
            html += "<dt>Stored title</dt><dd>\(escape(comparison.base.title)) → \(escape(comparison.target.title))</dd>\n"
        }
        html += "<dt>\(uncommitted ? "Stored base" : "Earlier")</dt><dd>\(side(comparison.base, latest: latest))</dd>\n"
        let currentSide = uncommitted ? draftSide(comparison.target) : side(comparison.target, latest: latest)
        html += "<dt>\(uncommitted ? "Current source" : "Later")</dt><dd>\(currentSide)</dd>\n</dl>\n"
        html += "<p class=\"rv-summary\">\(escape(summary.line.prefix(1).uppercased() + summary.line.dropFirst()))</p>\n"
        let inputs = uncommitted ? "the stored base and the current uncommitted Markdown source" : "the two stored revisions"
        html += "<p class=\"rv-note\">The reader computed this comparison from \(inputs), without a model. It shows what differs. It does not explain the change or accept it.</p>\n"
        for limit in comparison.limits {
            let description: String
            if uncommitted, case .blocksNotAligned(let base, let current) = limit {
                description = "The changed part spans \(base) base blocks and \(current) uncommitted blocks, more than the comparison aligns. It appears as one replaced region."
            } else { description = limit.description }
            html += "<p class=\"rv-partial\">Partial comparison: \(escape(description))</p>\n"
        }
        if comparison.finalLineBreakChanged {
            let sameLines = comparison.finalLineBreakDiffers ? "Every line is the same. " : ""
            html += "<p class=\"rv-note\">\(sameLines)The earlier source \(comparison.base.endsWithLineBreak ? "ends" : "does not end") with a line break; the later source \(comparison.target.endsWithLineBreak ? "ends" : "does not end") with one.</p>\n"
        }
        html += "</header>\n"

        if uncommitted {
            if case .noImages = comparison.assets.coverage {} else {
                html += "<p class=\"rv-partial\">Stored image inventories do not cover the uncommitted draft. The rendered previews use each source's own images.</p>\n"
            }
        } else {
            html += assetSection(comparison, shown: shownChanges, baseResolver: baseResolver, targetResolver: targetResolver, assets: &assets)
        }

        var budget = renderedBytes
        let baseOrdinals = comparison.baseStructure.renderedOrdinals()
        let targetOrdinals = comparison.targetStructure.renderedOrdinals()
        for region in comparison.regions {
            html += "<section class=\"rv-region\">\n<h2 class=\"rv-path\">\(escape(region.headingPath.isEmpty ? "Before the first heading" : region.headingPath.joined(separator: " › ")))</h2>\n"
            html += "<p class=\"rv-where\">\(escape(lineLabel(region, comparison, uncommitted: uncommitted)))</p>\n"
            html += renderedPart(region, comparison, baseOrdinals: baseOrdinals, targetOrdinals: targetOrdinals, baseFragments: baseFragments, targetFragments: targetFragments, uncommitted: uncommitted, budget: &budget)
            html += sourceDifference(region)
            html += "</section>\n"
        }
        html += "</div>\n"
        return PreparedReview(
            summary: summary,
            html: html,
            assets: assets
        )
    }

    // MARK: - Header

    private static func side(_ side: RevisionComparison.Side, latest: Int) -> String {
        var parts = ["Revision \(side.revision)" + (side.revision == latest ? " (latest)" : "")]
        if let date = Provenance.shortDate(side.createdAt) { parts.append(date) }
        parts.append("\(side.bytes) bytes")
        parts.append("\(side.lineCount) line\(side.lineCount == 1 ? "" : "s")")
        return escape(parts.joined(separator: " · ")) + "<code class=\"rv-digest\">\(escape(side.digest))</code>"
    }

    private static func draftSide(_ side: RevisionComparison.Side) -> String {
        "Uncommitted draft · \(side.bytes) bytes · \(side.lineCount) lines<code class=\"rv-digest\">\(escape(side.digest))</code>"
    }

    private static func lineLabel(_ region: ChangedRegion, _ comparison: RevisionComparison, uncommitted: Bool) -> String {
        func lines(_ range: ClosedRange<Int>?, _ label: String) -> String? {
            guard let range else { return nil }
            return (range.count == 1 ? "line \(range.lowerBound)" : "lines \(range.lowerBound)–\(range.upperBound)") + " of \(label)"
        }
        let old = lines(region.baseLines, "revision \(comparison.base.revision)")
        let new = lines(region.targetLines, uncommitted ? "the uncommitted draft" : "revision \(comparison.target.revision)")
        switch (old, new) {
        case (let old?, let new?): return "Source \(old) → \(new)"
        case (let old?, nil): return "Removed: source \(old)"
        case (nil, let new?): return "Added: source \(new)"
        case (nil, nil): return ""
        }
    }

    // MARK: - Rendered blocks

    private struct Fragments {
        var display: [String]
        var canonical: [String]
    }

    /// The display keeps each side's serving addresses. Equality uses recorded image identity,
    /// not serving tokens or document position keys. These transforms accept renderer-owned
    /// markup only; raw HTML from a document is already escaped by the renderer.
    private static func fragments(_ rendered: RenderedDocument, _ structure: SourceStructure, prefix: String, into assets: inout [String: ResolvedAsset]) -> Fragments? {
        let fragments = rendered.blockFragments()
        guard structure.matchesRendering, fragments.count == structure.blocks.count(where: \.keyed) else { return nil }
        for (token, asset) in rendered.assets { assets[prefix + token] = asset }
        let address = "src=\"\(MarkdownRenderer.assetScheme)://doc/"
        var canonicalAssets: [String: String] = [:]
        for (token, asset) in rendered.assets {
            canonicalAssets[address + token + "\""] = address + escape(asset.expectedDigest ?? asset.path) + "\""
        }
        let passive = fragments.map { fragment in
            fragment
                .replacingOccurrences(of: #"<a class="(?:copy|img-inspect)"[^>]*>[\s\S]*?</a>"#, with: "", options: [.regularExpression])
                .replacingOccurrences(of: #"<a\b[^>]*href="(?:reader-action:|#)[^"]*"[^>]*>([\s\S]*?)</a>"#, with: "$1", options: [.regularExpression])
        }
        return Fragments(
            display: passive.map { $0.replacingOccurrences(of: address, with: address + prefix) },
            canonical: passive.map { fragment in
                var html = fragment.replacingOccurrences(of: #"\s(?:data-(?:key|code|image|image-rendering|asset)|id)="[^"]*""#, with: "", options: [.regularExpression])
                for (token, identity) in canonicalAssets { html = html.replacingOccurrences(of: token, with: identity) }
                return html
            }
        )
    }

    private static func joined(_ blocks: Range<Int>, _ ordinals: [Int?], _ fragments: [String]) -> String {
        blocks.compactMap { ordinals[$0] }.map { fragments[$0] }.joined()
    }

    private static func renderedPart(_ region: ChangedRegion, _ comparison: RevisionComparison, baseOrdinals: [Int?], targetOrdinals: [Int?], baseFragments: Fragments?, targetFragments: Fragments?, uncommitted: Bool, budget: inout Int) -> String {
        guard let baseFragments, let targetFragments else {
            return "<p class=\"rv-note\">The rendered form is not available for this comparison. The source difference is exact.</p>\n"
        }
        let tooLong = region.baseBlocks.count > renderedBlocks || region.targetBlocks.count > renderedBlocks
            || (region.baseLines?.count ?? 0) > renderedLines || (region.targetLines?.count ?? 0) > renderedLines
        let before = tooLong ? "" : joined(region.baseBlocks, baseOrdinals, baseFragments.display)
        let after = tooLong ? "" : joined(region.targetBlocks, targetOrdinals, targetFragments.display)
        guard !tooLong, before.utf8.count + after.utf8.count <= budget else {
            return "<p class=\"rv-note\">This part is too long to show in rendered form. The source difference is exact.</p>\n"
        }
        budget -= before.utf8.count + after.utf8.count
        var html = ""
        let blocks = comparison.targetStructure.blocks
        func context(_ index: Int) -> String {
            guard blocks.indices.contains(index), blocks[index].span.count <= contextLines, let ordinal = targetOrdinals[index] else { return "" }
            return "<div class=\"rv-side rv-context\"><div class=\"rv-tag\">Unchanged</div>\(targetFragments.display[ordinal])</div>\n"
        }
        html += context(region.targetBlocks.lowerBound - 1)
        let sameRendering = joined(region.baseBlocks, baseOrdinals, baseFragments.canonical)
            == joined(region.targetBlocks, targetOrdinals, targetFragments.canonical)
        if !before.isEmpty, sameRendering {
            html += "<div class=\"rv-side\"><div class=\"rv-tag\">Both \(uncommitted ? "sources" : "revisions") render this part alike; the Markdown source differs</div>\(after)</div>\n"
        } else {
            if !before.isEmpty {
                html += "<div class=\"rv-side rv-before\"><div class=\"rv-tag\">Revision \(comparison.base.revision)\(region.targetBlocks.isEmpty ? " · removed" : "")</div>\(before)</div>\n"
            }
            if !after.isEmpty {
                let label = uncommitted ? "Uncommitted draft" : "Revision \(comparison.target.revision)"
                html += "<div class=\"rv-side rv-after\"><div class=\"rv-tag\">\(label)\(region.baseBlocks.isEmpty ? " · added" : "")</div>\(after)</div>\n"
            }
            if before.isEmpty, after.isEmpty {
                html += "<p class=\"rv-note\">This part has no rendered form of its own, such as a footnote definition. The source difference is exact.</p>\n"
            }
        }
        html += context(region.targetBlocks.upperBound)
        return html
    }

    // MARK: - Source difference

    private static func sourceDifference(_ region: ChangedRegion) -> String {
        var html = "<details class=\"rv-source\"\(region.rows.count <= openRows ? " open" : "")><summary>Source difference\(region.aligned ? "" : " (not aligned line by line)")</summary>\n<div class=\"rv-diff\">\n"
        for row in region.rows {
            switch row.kind {
            case .gap:
                html += "<div class=\"rv-gap\">\(row.count) unchanged line\(row.count == 1 ? "" : "s")</div>\n"
            case .context:
                html += "<div class=\"rv-row\"><span class=\"rv-no\">\(row.targetLine.map(String.init) ?? "")</span><span class=\"rv-sign\"> </span><span class=\"rv-text\">\(text(row, marks: false))</span></div>\n"
            case .removed:
                html += "<div class=\"rv-row rv-rem\"><span class=\"rv-no\">\(row.baseLine.map(String.init) ?? "")</span><span class=\"rv-sign\">−</span><span class=\"rv-text\">\(text(row, marks: true))</span></div>\n"
            case .added:
                html += "<div class=\"rv-row rv-add\"><span class=\"rv-no\">\(row.targetLine.map(String.init) ?? "")</span><span class=\"rv-sign\">+</span><span class=\"rv-text\">\(text(row, marks: true))</span></div>\n"
            }
        }
        html += "</div>\n"
        if region.omittedRows > 0 {
            html += "<p class=\"rv-partial\">\(region.omittedRows) more difference line\(region.omittedRows == 1 ? " is" : "s are") not shown for this part.</p>\n"
        }
        return html + "</details>\n"
    }

    /// A row's text. A changed line shows a carriage return at its end, which would otherwise
    /// make a line-ending change look like no change.
    private static func text(_ row: DiffRow, marks: Bool) -> String {
        var segments = row.segments
        var carriageReturn = false
        if let last = segments.last, last.text.hasSuffix("\r") {
            segments[segments.count - 1].text.removeLast()
            carriageReturn = true
        }
        var html = segments.map { $0.changed && marks ? "<mark>\(escape($0.text))</mark>" : escape($0.text) }.joined()
        if carriageReturn, marks { html += "<span class=\"rv-eol\" title=\"Carriage return\">␍</span>" }
        return html
    }

    // MARK: - Retained images

    private static func assetSection(_ comparison: RevisionComparison, shown: ArraySlice<AssetChange>, baseResolver: any AssetResolving, targetResolver: any AssetResolving, assets: inout [String: ResolvedAsset]) -> String {
        var notes: [String] = []
        switch comparison.assets.coverage {
        case .noImages:
            return ""
        case .compared:
            if comparison.assets.changes.isEmpty {
                notes.append("<p class=\"rv-note\">The recorded images are the same in both revisions (\(comparison.assets.unchanged) compared by state, size and digest).</p>\n")
            }
        case .incomplete(let reason), .notComparable(let reason):
            notes.append("<p class=\"rv-partial\">\(escape(reason))</p>\n")
        }
        var html = "<section class=\"rv-assets\">\n<h2 class=\"rv-path\">Retained images</h2>\n"
        html += "<p class=\"rv-where\">Compared through each revision's recorded reference inventory: state, byte count and digest per reference.</p>\n"
        html += notes.joined()
        for (index, change) in shown.enumerated() {
            let label = switch change.kind {
            case .added: "Added"
            case .removed: "Removed"
            case .modified: "Changed"
            }
            html += "<div class=\"rv-asset\">\n<div class=\"rv-asset-name\">\(label): <code>\(escape(shorten(change.reference)))</code></div>\n"
            if !change.sections.isEmpty {
                let places = change.sections.map { $0.isEmpty ? "before the first heading" : $0.joined(separator: " › ") }
                html += "<p class=\"rv-where\">Used in: \(escape(places.joined(separator: "; ")))</p>\n"
            }
            if let item = change.base {
                html += assetSide(item, revision: comparison.base.revision, resolver: baseResolver, token: "rb-\(index)", style: "rv-before", assets: &assets)
            }
            if let item = change.target {
                html += assetSide(item, revision: comparison.target.revision, resolver: targetResolver, token: "rt-\(index)", style: "rv-after", assets: &assets)
            }
            html += "</div>\n"
        }
        if comparison.assets.changes.count > shown.count {
            html += "<p class=\"rv-partial\">\(comparison.assets.changes.count - shown.count) more image changes are not shown.</p>\n"
        }
        return html + "</section>\n"
    }

    private static func assetSide(_ item: ReferenceItem, revision: Int, resolver: any AssetResolving, token: String, style: String, assets: inout [String: ResolvedAsset]) -> String {
        var facts: [String] = []
        if item.state == "retained" {
            facts.append("retained")
            if let mediaType = item.mediaType { facts.append(mediaType) }
            if let bytes = item.bytes { facts.append("\(bytes) bytes") }
        } else {
            facts.append("not retained: \(item.state)" + (item.reason.map { " (\(MarkdownRenderer.reasonLabel($0)))" } ?? ""))
        }
        var html = "<div class=\"rv-side \(style)\"><div class=\"rv-tag\">Revision \(revision)</div>\n<div class=\"rv-ident\">\(escape(facts.joined(separator: " · ")))"
        if let digest = item.digest { html += "<code class=\"rv-digest\">\(escape(digest))</code>" }
        html += "</div>\n"
        if item.state == "retained" {
            switch resolver.resolve(item.reference) {
            case .local(let asset):
                assets[token] = asset
                html += "<img src=\"\(MarkdownRenderer.assetScheme)://doc/\(token)\" alt=\"\(escape(shorten(item.reference))) in revision \(revision)\" decoding=\"async\">\n"
            case .unavailable(let reason):
                html += "<span class=\"img-ph unavailable\"><span class=\"ph-kind\">Image not shown (\(escape(MarkdownRenderer.reasonLabel(reason))))</span></span>\n"
            case .external, .embedded:
                break
            }
        }
        return html + "</div>\n"
    }

    private static func shorten(_ reference: String) -> String {
        reference.count > referenceCharacters ? String(reference.prefix(referenceCharacters - 1)) + "…" : reference
    }

    private static func escape(_ text: some StringProtocol) -> String {
        MarkdownRenderer.escape(String(text))
    }
}
