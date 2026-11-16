import Foundation

/// One line of an exact source difference.
public struct DiffRow: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case context
        case removed
        case added
        /// Unchanged lines that the difference leaves out; `count` says how many.
        case gap
    }

    /// A run of a line's text. `changed` marks words that the other side of a replaced run does
    /// not have; the marks are an aid, the line text is the exact record.
    public struct Segment: Sendable, Equatable {
        public var text: String
        public var changed: Bool
    }

    public var kind: Kind
    public var baseLine: Int?
    public var targetLine: Int?
    public var segments: [Segment]
    public var count: Int

    public var text: String { segments.map(\.text).joined() }

    static func line(_ kind: Kind, base: Int?, target: Int?, text: String) -> DiffRow {
        DiffRow(kind: kind, baseLine: base, targetLine: target, segments: [Segment(text: text, changed: false)], count: 1)
    }
}

/// A run of top-level blocks that differs between two revisions.
public struct ChangedRegion: Sendable, Equatable {
    /// The headings above the region in the target revision, or in the base revision for a
    /// region that the target no longer has.
    public var headingPath: [String]
    /// Indices into the base and target structures' blocks. One of them can be empty.
    public var baseBlocks: Range<Int>
    public var targetBlocks: Range<Int>
    public var baseLines: ClosedRange<Int>?
    public var targetLines: ClosedRange<Int>?
    public var rows: [DiffRow]
    /// False when the region was too large to align line by line: between the lines that start
    /// and end both sides alike, its rows list the base lines as removed and the target lines
    /// as added.
    public var aligned: Bool
    /// Rows that the bounds left out of `rows`.
    public var omittedRows: Int
}

/// One retained-image difference between the reference inventories of two revisions.
public struct AssetChange: Sendable, Equatable {
    public enum Kind: String, Sendable {
        case added
        case removed
        case modified
    }

    public var kind: Kind
    public var reference: String
    public var base: ReferenceItem?
    public var target: ReferenceItem?
    /// Heading paths of the blocks that use the reference, in the target revision when it has
    /// the reference, else in the base revision.
    public var sections: [[String]]
}

public struct AssetComparison: Sendable, Equatable {
    public enum Coverage: Sendable, Equatable {
        /// Both inventories were inspected and complete.
        case compared
        /// Neither source holds an image, so there is nothing to compare.
        case noImages
        /// Both inventories were inspected, but at least one is incomplete.
        case incomplete(String)
        case notComparable(String)
    }

    public var coverage: Coverage
    public var changes: [AssetChange]
    /// Image references that both inventories record with the same state and identity.
    public var unchanged: Int
}

/// A mechanical comparison of two revisions of one document: source blocks, source lines and
/// recorded image identities. It reads nothing but its inputs and calls no model.
public struct RevisionComparison: Sendable {
    public struct Side: Sendable, Equatable {
        public var revision: Int
        public var digest: String
        public var bytes: Int
        public var createdAt: String
        public var title: String
        public var lineCount: Int
        public var endsWithLineBreak: Bool
    }

    public enum Limit: Sendable, Equatable {
        /// The changed part has too many blocks to align; it is one region.
        case blocksNotAligned(base: Int, target: Int)
        /// Regions too large to align line by line.
        case linesNotAligned(regions: Int)
        /// Changed regions beyond the region bound, left out entirely.
        case regionsOmitted(Int)
        /// Difference lines beyond the row bounds.
        case rowsOmitted(Int)

        public var description: String {
            switch self {
            case .blocksNotAligned(let base, let target):
                "The changed part spans \(base) blocks of the earlier revision and \(target) blocks of the later one, more than the comparison aligns. It appears as one replaced region."
            case .linesNotAligned(let regions):
                "\(regions) changed region\(regions == 1 ? " is" : "s are") too large to align line by line. \(regions == 1 ? "It lists" : "They list") the differing earlier lines as removed and the later lines as added."
            case .regionsOmitted(let count):
                "\(count) further changed region\(count == 1 ? " is" : "s are") not shown."
            case .rowsOmitted(let count):
                "\(count) difference line\(count == 1 ? " is" : "s are") not shown."
            }
        }
    }

    public var document: String
    public var base: Side
    public var target: Side
    public var baseStructure: SourceStructure
    public var targetStructure: SourceStructure
    public var regions: [ChangedRegion]
    public var assets: AssetComparison
    /// Stated bounds that kept the comparison from being complete. Empty for a complete result.
    public var limits: [Limit]
    public var addedLines: Int
    public var removedLines: Int
    /// True when the sources differ and every line is the same: only the line break at the end
    /// of the source differs.
    public var finalLineBreakDiffers: Bool

    public var finalLineBreakChanged: Bool { base.endsWithLineBreak != target.endsWithLineBreak }
    public var sourceIdentical: Bool { base.digest == target.digest }
    public var isPartial: Bool { !limits.isEmpty }
}

public enum RevisionDiff {
    /// Bounds of one comparison. A sequence comparison keeps state that grows with the square of
    /// the number of differences, so each level compares only sequences up to its element bound
    /// and reports a coarser result above it.
    public struct Bounds: Sendable {
        /// Blocks of both revisions together, after the common start and end are set aside.
        public var blockElements = 2500
        /// Lines of both sides of one region together.
        public var lineElements = 2500
        /// Words of both sides of one replaced run together.
        public var wordElements = 1200
        public var regions = 200
        public var rowsPerRegion = 400
        public var rows = 6000
        /// Unchanged lines kept around a change inside a region.
        public var contextLines = 3

        public init() {}
        public static let standard = Bounds()
    }

    public static func compare(
        base: (record: RevisionRecord, source: String),
        target: (record: RevisionRecord, source: String),
        bounds: Bounds = .standard
    ) -> RevisionComparison {
        let baseStructure = SourceStructure.scan(base.source)
        let targetStructure = SourceStructure.scan(target.source)
        var limits: [RevisionComparison.Limit] = []
        var regions: [ChangedRegion] = []
        var added = 0
        var removed = 0
        if base.record.digest != target.record.digest || !base.source.utf8.elementsEqual(target.source.utf8) {
            var interned: [Data: Int] = [:]
            func identifier(_ text: String) -> Int {
                let key = Data(text.utf8)
                if let known = interned[key] { return known }
                interned[key] = interned.count
                return interned.count - 1
            }
            let baseIds = baseStructure.blocks.map { identifier(baseStructure.text($0.span)) }
            let targetIds = targetStructure.blocks.map { identifier(targetStructure.text($0.span)) }
            let blocks = SequenceChanges.compute(baseIds, targetIds, limit: bounds.blockElements)
            if !blocks.aligned {
                limits.append(.blocksNotAligned(base: blocks.removed.count(where: { $0 }), target: blocks.inserted.count(where: { $0 })))
            }
            var unaligned = 0
            var omittedRegions = 0
            var omittedRows = 0
            var shownRows = 0
            for (baseRange, targetRange) in SequenceChanges.runs(blocks) {
                let baseLines = baseRange.isEmpty ? nil : baseStructure.blocks[baseRange.lowerBound].span.lowerBound...baseStructure.blocks[baseRange.upperBound - 1].span.upperBound
                let targetLines = targetRange.isEmpty ? nil : targetStructure.blocks[targetRange.lowerBound].span.lowerBound...targetStructure.blocks[targetRange.upperBound - 1].span.upperBound
                added += targetLines?.count ?? 0
                removed += baseLines?.count ?? 0
                guard regions.count < bounds.regions else {
                    omittedRegions += 1
                    continue
                }
                let difference = lineRows(base: baseStructure, baseLines, target: targetStructure, targetLines, bounds: bounds)
                if !difference.aligned { unaligned += 1 }
                // Lines that both sides of an aligned region share are not changes.
                added -= difference.unchanged
                removed -= difference.unchanged
                var rows = collapse(difference.rows, context: bounds.contextLines)
                let room = max(0, min(bounds.rowsPerRegion, bounds.rows - shownRows))
                var omitted = 0
                if rows.count > room {
                    omitted = rows[room...].reduce(0) { $0 + ($1.kind == .gap ? 0 : 1) }
                    rows = Array(rows[..<room])
                }
                shownRows += rows.count
                omittedRows += omitted
                let path = targetRange.isEmpty
                    ? (baseRange.isEmpty ? [] : baseStructure.headingPath(at: baseRange.lowerBound))
                    : targetStructure.headingPath(at: targetRange.lowerBound)
                regions.append(ChangedRegion(headingPath: path, baseBlocks: baseRange, targetBlocks: targetRange, baseLines: baseLines, targetLines: targetLines, rows: rows, aligned: difference.aligned, omittedRows: omitted))
            }
            if unaligned > 0 { limits.append(.linesNotAligned(regions: unaligned)) }
            if omittedRegions > 0 { limits.append(.regionsOmitted(omittedRegions)) }
            if omittedRows > 0 { limits.append(.rowsOmitted(omittedRows)) }
        }
        return RevisionComparison(
            document: target.record.document,
            base: side(base.record, baseStructure),
            target: side(target.record, targetStructure),
            baseStructure: baseStructure,
            targetStructure: targetStructure,
            regions: regions,
            assets: compareAssets(base: base.record.references, baseStructure, target: target.record.references, targetStructure),
            limits: limits,
            addedLines: added,
            removedLines: removed,
            finalLineBreakDiffers: baseStructure.endsWithLineBreak != targetStructure.endsWithLineBreak
                && SourceLineBreaks.withoutFinalBreak(base.source).utf8.elementsEqual(
                    SourceLineBreaks.withoutFinalBreak(target.source).utf8
                )
        )
    }

    private static func side(_ record: RevisionRecord, _ structure: SourceStructure) -> RevisionComparison.Side {
        RevisionComparison.Side(revision: record.revision, digest: record.digest, bytes: record.bytes, createdAt: record.createdAt, title: record.title, lineCount: structure.lines.count, endsWithLineBreak: structure.endsWithLineBreak)
    }

    // MARK: - Lines

    /// The rows of one region: every base and target line of the region, aligned when the bound
    /// permits. `unchanged` counts the lines that both sides share.
    static func lineRows(base: SourceStructure, _ baseLines: ClosedRange<Int>?, target: SourceStructure, _ targetLines: ClosedRange<Int>?, bounds: Bounds) -> (rows: [DiffRow], aligned: Bool, unchanged: Int) {
        let old = baseLines.map { Array(base.lines[($0.lowerBound - 1)...($0.upperBound - 1)]) } ?? []
        let new = targetLines.map { Array(target.lines[($0.lowerBound - 1)...($0.upperBound - 1)]) } ?? []
        let oldStart = baseLines?.lowerBound ?? 0
        let newStart = targetLines?.lowerBound ?? 0
        var interned: [Data: Int] = [:]
        func identifier(_ text: String) -> Int {
            let key = Data(text.utf8)
            if let known = interned[key] { return known }
            interned[key] = interned.count
            return interned.count - 1
        }
        let changes = SequenceChanges.compute(old.map(identifier), new.map(identifier), limit: bounds.lineElements)
        var rows: [DiffRow] = []
        var unchanged = 0
        var i = 0
        var j = 0
        while i < old.count || j < new.count {
            if i < old.count, j < new.count, !changes.removed[i], !changes.inserted[j] {
                rows.append(.line(.context, base: oldStart + i, target: newStart + j, text: new[j]))
                unchanged += 1
                i += 1
                j += 1
                continue
            }
            let removedFrom = i
            while i < old.count, changes.removed[i] { i += 1 }
            let addedFrom = j
            while j < new.count, changes.inserted[j] { j += 1 }
            guard i > removedFrom || j > addedFrom else { break }
            var removedRows = (removedFrom..<i).map { DiffRow.line(.removed, base: oldStart + $0, target: nil, text: old[$0]) }
            var addedRows = (addedFrom..<j).map { DiffRow.line(.added, base: nil, target: newStart + $0, text: new[$0]) }
            if changes.aligned, !removedRows.isEmpty, !addedRows.isEmpty {
                markWords(&removedRows, &addedRows, limit: bounds.wordElements)
            }
            rows += removedRows
            rows += addedRows
        }
        return (rows, changes.aligned, unchanged)
    }

    /// Replaces each long run of unchanged lines with a gap row and `context` lines on the sides
    /// that touch a change.
    static func collapse(_ rows: [DiffRow], context: Int) -> [DiffRow] {
        var result: [DiffRow] = []
        var index = 0
        while index < rows.count {
            guard rows[index].kind == .context else {
                result.append(rows[index])
                index += 1
                continue
            }
            var end = index
            while end < rows.count, rows[end].kind == .context { end += 1 }
            let run = rows[index..<end]
            let head = index == 0 ? 0 : context
            let tail = end == rows.count ? 0 : context
            if run.count > head + tail + 1 {
                result += run.prefix(head)
                result.append(DiffRow(kind: .gap, baseLine: nil, targetLine: nil, segments: [], count: run.count - head - tail))
                result += run.suffix(tail)
            } else {
                result += run
            }
            index = end
        }
        return result
    }

    // MARK: - Words

    /// Marks the words of a replaced run that the other side does not have. Nothing is marked
    /// when the run exceeds the bound or the two sides share no word.
    static func markWords(_ removed: inout [DiffRow], _ added: inout [DiffRow], limit: Int) {
        guard limit >= 0, let old = tokens(removed.map(\.text), limit: limit),
              let new = tokens(added.map(\.text), limit: limit - old.count) else { return }
        var interned: [Data: Int] = [:]
        func identifier(_ text: String) -> Int {
            let key = Data(text.utf8)
            if let known = interned[key] { return known }
            interned[key] = interned.count
            return interned.count - 1
        }
        let changes = SequenceChanges.compute(old.map { identifier($0.text) }, new.map { identifier($0.text) }, limit: limit)
        guard changes.aligned else { return }
        let shared = zip(old, changes.removed).contains { !$0.1 && $0.0.line >= 0 && !$0.0.text.allSatisfy(\.isWhitespace) }
        guard shared else { return }
        apply(old, changes.removed, to: &removed)
        apply(new, changes.inserted, to: &added)
    }

    struct Token {
        /// Index of the token's line in its run; -1 for the separator between two lines.
        var line: Int
        var text: String
    }

    /// Words (letters, digits and underscores), runs of white space, and every other character
    /// by itself, with a separator between lines.
    static func tokens(_ lines: [String], limit: Int) -> [Token]? {
        var result: [Token] = []
        func append(_ token: Token) -> Bool {
            guard result.count < limit else { return false }
            result.append(token)
            return true
        }
        for (index, line) in lines.enumerated() {
            if index > 0, !append(Token(line: -1, text: "\n")) { return nil }
            var current = ""
            var currentKind = 0
            for character in line {
                let kind = character.isLetter || character.isNumber || character == "_" ? 1 : character.isWhitespace ? 2 : 3
                if kind != currentKind || kind == 3, !current.isEmpty {
                    guard append(Token(line: index, text: current)) else { return nil }
                    current = ""
                }
                if current.isEmpty, result.count >= limit { return nil }
                current.append(character)
                currentKind = kind
            }
            if !current.isEmpty, !append(Token(line: index, text: current)) { return nil }
        }
        return result
    }

    private static func apply(_ tokens: [Token], _ changed: [Bool], to rows: inout [DiffRow]) {
        var segments = rows.map { _ in [DiffRow.Segment]() }
        for (token, isChanged) in zip(tokens, changed) where token.line >= 0 {
            if let last = segments[token.line].last, last.changed == isChanged {
                segments[token.line][segments[token.line].count - 1].text += token.text
            } else {
                segments[token.line].append(DiffRow.Segment(text: token.text, changed: isChanged))
            }
        }
        for index in rows.indices where !segments[index].isEmpty {
            rows[index].segments = segments[index]
        }
    }

    // MARK: - Retained images

    /// Compares the image items that the two reference inventories record. A reference that both
    /// record is modified when its state, file, media type, byte count or digest differs. A
    /// reference on one side only is reported when that side retains it; every other one-sided
    /// reference is a source change that the source difference shows.
    static func compareAssets(base: ReferenceInventory?, _ baseStructure: SourceStructure, target: ReferenceInventory?, _ targetStructure: SourceStructure) -> AssetComparison {
        let sourcesHaveImages = baseStructure.blocks.contains { !$0.images.isEmpty } || targetStructure.blocks.contains { !$0.images.isEmpty }
        let baseImages = (base?.items ?? []).filter { $0.kind == .image }
        let targetImages = (target?.items ?? []).filter { $0.kind == .image }
        if !sourcesHaveImages, baseImages.isEmpty, targetImages.isEmpty {
            return AssetComparison(coverage: .noImages, changes: [], unchanged: 0)
        }
        func uninspected(_ inventory: ReferenceInventory?) -> Bool { inventory?.state != .inspected }
        if uninspected(base) || uninspected(target) {
            let subject = uninspected(base) && uninspected(target) ? "Neither revision has an" : uninspected(base) ? "The earlier revision has no" : "The later revision has no"
            return AssetComparison(coverage: .notComparable("\(subject) inspected reference inventory, so retained images were not compared."), changes: [], unchanged: 0)
        }
        func first(_ items: [ReferenceItem]) -> (order: [String], byReference: [String: ReferenceItem]) {
            var order: [String] = []
            var byReference: [String: ReferenceItem] = [:]
            for item in items where byReference[item.reference] == nil {
                byReference[item.reference] = item
                order.append(item.reference)
            }
            return (order, byReference)
        }
        let old = first(baseImages)
        let new = first(targetImages)
        var changes: [AssetChange] = []
        var unchanged = 0
        for reference in new.order {
            guard let item = new.byReference[reference] else { continue }
            if let before = old.byReference[reference] {
                if before == item {
                    unchanged += 1
                } else {
                    changes.append(AssetChange(kind: .modified, reference: reference, base: before, target: item, sections: sections(reference, in: targetStructure)))
                }
            } else if item.state == "retained" {
                changes.append(AssetChange(kind: .added, reference: reference, base: nil, target: item, sections: sections(reference, in: targetStructure)))
            }
        }
        for reference in old.order where new.byReference[reference] == nil {
            guard let item = old.byReference[reference], item.state == "retained" else { continue }
            changes.append(AssetChange(kind: .removed, reference: reference, base: item, target: nil, sections: sections(reference, in: baseStructure)))
        }
        func incomplete(_ inventory: ReferenceInventory?) -> Bool { inventory?.truncated == true || (inventory?.omitted ?? 0) > 0 }
        let coverage: AssetComparison.Coverage = incomplete(base) || incomplete(target)
            ? .incomplete("A reference inventory is incomplete, so images beyond its recorded items were not compared.")
            : .compared
        return AssetComparison(coverage: coverage, changes: changes, unchanged: unchanged)
    }

    private static func sections(_ reference: String, in structure: SourceStructure) -> [[String]] {
        var paths: [[String]] = []
        for (index, block) in structure.blocks.enumerated() where block.images.contains(reference) {
            let path = structure.headingPath(at: index)
            if !paths.contains(path) { paths.append(path) }
            if paths.count == 3 { break }
        }
        return paths
    }
}

/// Which elements of two sequences a comparison removes and inserts. The common start and end
/// are set aside first; the rest goes to the platform's collection difference when both rests
/// together stay within `limit`. Above the limit every remaining element counts as replaced
/// and `aligned` is false.
struct SequenceChanges {
    var removed: [Bool]
    var inserted: [Bool]
    var aligned: Bool

    static func compute(_ old: [Int], _ new: [Int], limit: Int) -> SequenceChanges {
        var start = 0
        while start < old.count, start < new.count, old[start] == new[start] { start += 1 }
        var oldEnd = old.count
        var newEnd = new.count
        while oldEnd > start, newEnd > start, old[oldEnd - 1] == new[newEnd - 1] {
            oldEnd -= 1
            newEnd -= 1
        }
        var removed = [Bool](repeating: false, count: old.count)
        var inserted = [Bool](repeating: false, count: new.count)
        let oldRest = old[start..<oldEnd]
        let newRest = new[start..<newEnd]
        if oldRest.isEmpty || newRest.isEmpty || oldRest.count + newRest.count > limit {
            for index in start..<oldEnd { removed[index] = true }
            for index in start..<newEnd { inserted[index] = true }
            return SequenceChanges(removed: removed, inserted: inserted, aligned: oldRest.isEmpty || newRest.isEmpty)
        }
        for change in Array(newRest).difference(from: Array(oldRest)) {
            switch change {
            case .remove(let offset, _, _): removed[start + offset] = true
            case .insert(let offset, _, _): inserted[start + offset] = true
            }
        }
        return SequenceChanges(removed: removed, inserted: inserted, aligned: true)
    }

    /// The runs of removed and inserted elements between kept pairs, in order.
    static func runs(_ changes: SequenceChanges) -> [(Range<Int>, Range<Int>)] {
        var result: [(Range<Int>, Range<Int>)] = []
        var i = 0
        var j = 0
        while i < changes.removed.count || j < changes.inserted.count {
            if i < changes.removed.count, j < changes.inserted.count, !changes.removed[i], !changes.inserted[j] {
                i += 1
                j += 1
                continue
            }
            let removedFrom = i
            while i < changes.removed.count, changes.removed[i] { i += 1 }
            let insertedFrom = j
            while j < changes.inserted.count, changes.inserted[j] { j += 1 }
            guard i > removedFrom || j > insertedFrom else { break }
            result.append((removedFrom..<i, insertedFrom..<j))
        }
        return result
    }
}

extension DirectoryStore {
    /// The nearest existing revision of a document below or above `revision`, among at most
    /// `Limits.revisionChoices` numbers and never above the pointer. Revisions older than the
    /// listed choices stay reachable through it, one bounded step at a time.
    public func adjacentRevision(_ id: String, to revision: Int, newer: Bool, pointer: Int) -> Int? {
        guard let directory = pointerLocation(id) else { return nil }
        let revisions = directory.path + "/revisions/"
        var candidate = revision
        for _ in 0..<Limits.revisionChoices {
            candidate += newer ? 1 : -1
            guard candidate >= 1, candidate <= pointer else { return nil }
            var info = stat()
            if lstat(revisions + String(candidate), &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR { return candidate }
        }
        return nil
    }
}
