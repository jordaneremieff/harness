import Foundation
import MarkdownCore

/// What a prepared comparison holds, for the review bar and for callers that report it.
public struct ReviewSummary: Sendable, Equatable {
    public var base: Int
    public var target: Int
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

/// Builds the comparison page of two stored revisions. Everything on the page comes from the
/// two revisions' records, sources and renderings; no text on it is an explanation by an author.
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

    static func build(_ comparison: RevisionComparison, base: LoadedRevision, target: LoadedRevision, settings: PageSettings) -> PreparedReview {
        var assets: [String: ResolvedAsset] = [:]
        let baseResolver = StoredAssetResolver(revisionDirectory: base.directory, references: base.record.references, kind: base.document.kind)
        let targetResolver = StoredAssetResolver(revisionDirectory: target.directory, references: target.record.references, kind: target.document.kind)
        // One nonce for both renderings, so that equal blocks render to equal HTML.
        let nonce = MarkdownRenderer.newNonce()
        let targetRendered = MarkdownRenderer.render(target.source, resolver: targetResolver, nonce: nonce)
        var baseFragments: [String]?
        var targetFragments: [String]?
        if !comparison.regions.isEmpty {
            let baseRendered = MarkdownRenderer.render(base.source, resolver: baseResolver, nonce: nonce)
            baseFragments = fragments(baseRendered, comparison.baseStructure, prefix: "b-", into: &assets)
            targetFragments = fragments(targetRendered, comparison.targetStructure, prefix: "t-", into: &assets)
        }
        let title = target.document.kind == .response ? targetRendered.contentTitle ?? target.record.title : target.record.title
        let shownChanges = comparison.assets.changes.prefix(assetChangesShown)
        var imagesCompared = true
        if case .notComparable = comparison.assets.coverage { imagesCompared = false }
        if case .incomplete = comparison.assets.coverage { imagesCompared = false }
        let summary = ReviewSummary(
            base: comparison.base.revision,
            target: comparison.target.revision,
            changedRegions: comparison.regions.count,
            addedLines: comparison.addedLines,
            removedLines: comparison.removedLines,
            assetChanges: comparison.assets.changes.count,
            finalLineBreakDiffers: comparison.finalLineBreakDiffers,
            partial: comparison.isPartial || !imagesCompared
        )

        var html = "<div class=\"review\">\n<header class=\"rv-head\">\n<p class=\"rv-kicker\">Review changes</p>\n"
        html += "<h1>\(escape(title))</h1>\n<dl class=\"rv-id\">\n"
        html += "<dt>Document</dt><dd><code>\(escape(comparison.document))</code></dd>\n"
        if comparison.base.title != comparison.target.title {
            html += "<dt>Stored title</dt><dd>\(escape(comparison.base.title)) → \(escape(comparison.target.title))</dd>\n"
        }
        html += "<dt>Earlier</dt><dd>\(side(comparison.base, latest: target.document.revision))</dd>\n"
        html += "<dt>Later</dt><dd>\(side(comparison.target, latest: target.document.revision))</dd>\n</dl>\n"
        html += "<p class=\"rv-summary\">\(escape(summary.line.prefix(1).uppercased() + summary.line.dropFirst()))</p>\n"
        html += "<p class=\"rv-note\">The reader computed this comparison from the two stored revisions, without a model. It shows what differs. It does not explain the change or accept it.</p>\n"
        for limit in comparison.limits {
            html += "<p class=\"rv-partial\">Partial comparison: \(escape(limit.description))</p>\n"
        }
        if comparison.finalLineBreakDiffers {
            html += "<p class=\"rv-partial\">Every line is the same. The earlier source \(comparison.baseStructure.endsWithLineBreak ? "ends" : "does not end") with a line break; the later source \(comparison.targetStructure.endsWithLineBreak ? "ends" : "does not end") with one.</p>\n"
        }
        html += "</header>\n"

        html += assetSection(comparison, shown: shownChanges, baseResolver: baseResolver, targetResolver: targetResolver, assets: &assets)

        var budget = renderedBytes
        let baseOrdinals = comparison.baseStructure.renderedOrdinals()
        let targetOrdinals = comparison.targetStructure.renderedOrdinals()
        for region in comparison.regions {
            html += "<section class=\"rv-region\">\n<h2 class=\"rv-path\">\(escape(region.headingPath.isEmpty ? "Before the first heading" : region.headingPath.joined(separator: " › ")))</h2>\n"
            html += "<p class=\"rv-where\">\(escape(lineLabel(region, comparison)))</p>\n"
            html += renderedPart(region, comparison, baseOrdinals: baseOrdinals, targetOrdinals: targetOrdinals, baseFragments: baseFragments, targetFragments: targetFragments, budget: &budget)
            html += sourceDifference(region)
            html += "</section>\n"
        }
        html += "</div>\n"
        return PreparedReview(
            summary: summary,
            html: PageTemplate.page(body: html, title: "Changes: \(title)", settings: settings),
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

    private static func lineLabel(_ region: ChangedRegion, _ comparison: RevisionComparison) -> String {
        func lines(_ range: ClosedRange<Int>?, _ revision: Int) -> String? {
            guard let range else { return nil }
            return (range.count == 1 ? "line \(range.lowerBound)" : "lines \(range.lowerBound)–\(range.upperBound)") + " of revision \(revision)"
        }
        let old = lines(region.baseLines, comparison.base.revision)
        let new = lines(region.targetLines, comparison.target.revision)
        switch (old, new) {
        case (let old?, let new?): return "Source \(old) → \(new)"
        case (let old?, nil): return "Removed: source \(old)"
        case (nil, let new?): return "Added: source \(new)"
        case (nil, nil): return ""
        }
    }

    // MARK: - Rendered blocks

    /// The rendered blocks of one revision with their image tokens renamed, so that both
    /// revisions' images are served on one page. Nil when the blocks do not correspond to the
    /// rendering one to one.
    private static func fragments(_ rendered: RenderedDocument, _ structure: SourceStructure, prefix: String, into assets: inout [String: ResolvedAsset]) -> [String]? {
        let fragments = rendered.blockFragments()
        guard structure.matchesRendering, fragments.count == structure.blocks.count(where: \.keyed) else { return nil }
        for (token, asset) in rendered.assets { assets[prefix + token] = asset }
        let address = "src=\"\(MarkdownRenderer.assetScheme)://doc/"
        return fragments.map { $0.replacingOccurrences(of: address, with: address + prefix) }
    }

    private static func joined(_ blocks: Range<Int>, _ ordinals: [Int?], _ fragments: [String]) -> String {
        blocks.compactMap { ordinals[$0] }.map { fragments[$0] }.joined()
    }

    private static func renderedPart(_ region: ChangedRegion, _ comparison: RevisionComparison, baseOrdinals: [Int?], targetOrdinals: [Int?], baseFragments: [String]?, targetFragments: [String]?, budget: inout Int) -> String {
        guard let baseFragments, let targetFragments else {
            return "<p class=\"rv-note\">The rendered form is not available for this comparison. The source difference is exact.</p>\n"
        }
        let tooLong = region.baseBlocks.count > renderedBlocks || region.targetBlocks.count > renderedBlocks
            || (region.baseLines?.count ?? 0) > renderedLines || (region.targetLines?.count ?? 0) > renderedLines
        let before = tooLong ? "" : joined(region.baseBlocks, baseOrdinals, baseFragments)
        let after = tooLong ? "" : joined(region.targetBlocks, targetOrdinals, targetFragments)
        guard !tooLong, before.utf8.count + after.utf8.count <= budget else {
            return "<p class=\"rv-note\">This part is too long to show in rendered form. The source difference is exact.</p>\n"
        }
        budget -= before.utf8.count + after.utf8.count
        var html = ""
        let blocks = comparison.targetStructure.blocks
        func context(_ index: Int) -> String {
            guard blocks.indices.contains(index), blocks[index].span.count <= contextLines, let ordinal = targetOrdinals[index] else { return "" }
            return "<div class=\"rv-side rv-context\"><div class=\"rv-tag\">Unchanged</div>\(targetFragments[ordinal])</div>\n"
        }
        html += context(region.targetBlocks.lowerBound - 1)
        if !before.isEmpty, before == after {
            html += "<div class=\"rv-side\"><div class=\"rv-tag\">Both revisions render this part alike; the Markdown source differs</div>\(after)</div>\n"
        } else {
            if !before.isEmpty {
                html += "<div class=\"rv-side rv-before\"><div class=\"rv-tag\">Revision \(comparison.base.revision)\(region.targetBlocks.isEmpty ? " · removed" : "")</div>\(before)</div>\n"
            }
            if !after.isEmpty {
                html += "<div class=\"rv-side rv-after\"><div class=\"rv-tag\">Revision \(comparison.target.revision)\(region.baseBlocks.isEmpty ? " · added" : "")</div>\(after)</div>\n"
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

    private static func assetSection(_ comparison: RevisionComparison, shown: ArraySlice<AssetChange>, baseResolver: StoredAssetResolver, targetResolver: StoredAssetResolver, assets: inout [String: ResolvedAsset]) -> String {
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

    private static func assetSide(_ item: ReferenceItem, revision: Int, resolver: StoredAssetResolver, token: String, style: String, assets: inout [String: ResolvedAsset]) -> String {
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
