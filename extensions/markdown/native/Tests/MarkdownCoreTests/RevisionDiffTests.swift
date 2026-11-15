import Testing
@testable import MarkdownCore

private func record(_ revision: Int, _ source: String, references: ReferenceInventory? = nil) -> (record: RevisionRecord, source: String) {
    let data = Data(source.utf8)
    return (RevisionRecord(version: 1, document: docA, revision: revision, title: "Report", createdAt: "2026-11-13T10:00:00.000Z", digest: Digest.sha256(data), bytes: data.count, references: references), source)
}

private func retained(_ reference: String, digit: Character, bytes: Int) -> ReferenceItem {
    let digest = String(repeating: digit, count: 64)
    return ReferenceItem(kind: .image, reference: reference, state: "retained", file: "assets/\(digest).png", mediaType: "image/png", bytes: bytes, digest: "sha256:\(digest)")
}

private let report = """
---
title: Report
---

# Report

Intro paragraph
on two lines.

## Results

| Name | Value |
| --- | --- |
| a | 1 |

- one
- two

```swift
let x = 1
```

Text with a note.[^n]

![Diagram](diagram.png)

[^n]: The note.

"""

@Suite struct SourceStructures {
    @Test func blocksCoverEveryLineAndFollowTheRendering() {
        let structure = SourceStructure.scan(report)
        #expect(structure.lines.count == 27)
        #expect(structure.endsWithLineBreak)
        #expect(structure.matchesRendering)
        #expect(structure.blocks.map(\.lines) == [1...3, 5...5, 7...8, 10...10, 12...14, 16...17, 19...21, 23...23, 25...25, 27...27])
        #expect(structure.blocks.first?.span.lowerBound == 1)
        #expect(structure.blocks.last?.span.upperBound == structure.lines.count)
        for (before, after) in zip(structure.blocks, structure.blocks.dropFirst()) {
            #expect(before.span.upperBound + 1 == after.span.lowerBound)
        }
        let rendered = MarkdownRenderer.render(report, resolver: NoAssetResolver())
        #expect(rendered.blockFragments().count == structure.blocks.count(where: \.keyed))
        #expect(rendered.blockFragments().allSatisfy { $0.hasPrefix("<div class=\"blk\" data-key=\"") && !$0.contains("class=\"footnotes\"") })
    }

    @Test func blocksCarryTheirExactTextHeadingsAndImages() {
        let structure = SourceStructure.scan(report)
        #expect(structure.blocks.map(\.keyed) == [true, true, true, true, true, true, true, true, true, false])
        #expect(structure.blocks[8].images == ["diagram.png"])
        #expect(structure.text(structure.blocks[2].lines) == "Intro paragraph\non two lines.")
        #expect(structure.text(structure.blocks[4].lines) == "| Name | Value |\n| --- | --- |\n| a | 1 |")
        #expect(structure.blocks[1].headingLevel == 1)
        #expect(structure.blocks[3].headingTitle == "Results")
    }

    @Test func headingPathsNameTheSectionsAboveABlock() {
        let structure = SourceStructure.scan("Lead\n\n# A\n\n## B\n\ntext\n\n### C\n\n## D\n\nlast\n")
        #expect(structure.headingPath(at: 0) == [])
        #expect(structure.headingPath(at: 3) == ["A", "B"])
        #expect(structure.headingPath(at: 4) == ["A", "B", "C"])
        #expect(structure.headingPath(at: 6) == ["A", "D"])
    }

    @Test func crlfLinesKeepTheirCarriageReturn() {
        let structure = SourceStructure.scan("# A\r\n\r\ntext\r\n")
        #expect(structure.lines == ["# A\r", "\r", "text\r"])
        #expect(structure.blocks.map(\.lines) == [1...1, 3...3])
    }

    @Test func aRenderedOrdinalNamesItsKeyedBlock() {
        let structure = SourceStructure.scan(report)
        #expect(structure.block(renderedOrdinal: 8) == 8)
        #expect(structure.block(renderedOrdinal: 9) == nil)
        #expect(structure.renderedOrdinals() == [0, 1, 2, 3, 4, 5, 6, 7, 8, nil])
    }

    /// The parser moves footnote definitions behind the last block and keeps their start lines.
    @Test func aFootnoteDefinitionBetweenBlocksStaysWithTheBlockBeforeIt() {
        let source = "A\n\n[^n]: note\n\nB[^n]\n"
        let structure = SourceStructure.scan(source)
        #expect(structure.matchesRendering)
        #expect(structure.blocks.map(\.span) == [1...4, 5...5])
        #expect(structure.blocks.map(\.keyed) == [true, true])
        #expect(MarkdownRenderer.render(source, resolver: NoAssetResolver()).blockFragments().count == 2)
    }
}

@Suite struct RevisionDiffs {
    @Test func aParagraphChangeIsOneRegionWithItsSectionAndMarkedWords() {
        let changed = report.replacingOccurrences(of: "Intro paragraph", with: "Opening paragraph")
        let comparison = RevisionDiff.compare(base: record(1, report), target: record(2, changed))
        #expect(!comparison.sourceIdentical)
        #expect(comparison.limits.isEmpty)
        #expect(comparison.regions.count == 1)
        let region = comparison.regions[0]
        #expect(region.headingPath == ["Report"])
        #expect(region.baseLines == 7...9)
        #expect(region.targetLines == 7...9)
        #expect(region.aligned)
        #expect(region.rows.map(\.kind) == [.removed, .added, .context, .context])
        #expect(region.rows[0].segments == [DiffRow.Segment(text: "Intro", changed: true), DiffRow.Segment(text: " paragraph", changed: false)])
        #expect(region.rows[1].segments == [DiffRow.Segment(text: "Opening", changed: true), DiffRow.Segment(text: " paragraph", changed: false)])
        #expect(region.rows[0].baseLine == 7)
        #expect(region.rows[1].targetLine == 7)
        #expect(comparison.addedLines == 1)
        #expect(comparison.removedLines == 1)
        #expect(comparison.base.revision == 1)
        #expect(comparison.target.digest == Digest.sha256(Data(changed.utf8)))
    }

    @Test func insertedAndRemovedBlocksAreSeparateRegions() {
        let base = "# A\n\none\n\n# B\n\ntwo\n\nthree\n"
        let target = "# A\n\nzero\n\none\n\n# B\n\nthree\n"
        let comparison = RevisionDiff.compare(base: record(1, base), target: record(2, target))
        #expect(comparison.regions.count == 2)
        #expect(comparison.regions[0].baseBlocks.isEmpty)
        #expect(comparison.regions[0].targetBlocks == 1..<2)
        #expect(comparison.regions[0].headingPath == ["A"])
        #expect(comparison.regions[0].rows.map(\.text) == ["zero", ""])
        #expect(comparison.regions[1].targetBlocks.isEmpty)
        #expect(comparison.regions[1].baseLines == 7...8)
        #expect(comparison.regions[1].headingPath == ["B"])
        #expect(comparison.addedLines == 2)
        #expect(comparison.removedLines == 2)
    }

    @Test func longUnchangedRunsCollapseToGaps() {
        let lines = (0..<40).map { "line \($0)" }
        var changed = lines
        changed[20] = "line twenty"
        let base = "```\n" + lines.joined(separator: "\n") + "\n```\n"
        let target = "```\n" + changed.joined(separator: "\n") + "\n```\n"
        let region = RevisionDiff.compare(base: record(1, base), target: record(2, target)).regions[0]
        #expect(region.rows.map(\.kind) == [.gap, .context, .context, .context, .removed, .added, .context, .context, .context, .gap])
        #expect(region.rows.first?.count == 18)
        #expect(region.rows.last?.count == 17)
    }

    @Test func aChangeAboveTheBlockBoundIsOneStatedRegion() {
        var bounds = RevisionDiff.Bounds()
        bounds.blockElements = 40
        bounds.rowsPerRegion = 25
        let base = "# Start\n\n" + (0..<60).map { "old \($0)" }.joined(separator: "\n\n") + "\n\n# End\n"
        let target = "# Start\n\n" + (0..<60).map { "new \($0)" }.joined(separator: "\n\n") + "\n\n# End\n"
        let comparison = RevisionDiff.compare(base: record(1, base), target: record(2, target), bounds: bounds)
        #expect(comparison.isPartial)
        #expect(comparison.limits.contains(.blocksNotAligned(base: 60, target: 60)))
        #expect(comparison.regions.count == 1)
        #expect(comparison.regions[0].baseBlocks == 1..<61)
        #expect(comparison.regions[0].rows.count == 25)
        #expect(comparison.regions[0].omittedRows > 0)
        #expect(comparison.limits.contains { if case .rowsOmitted = $0 { true } else { false } })
    }

    @Test func aRegionAboveTheLineBoundListsItsLinesWithoutAlignment() {
        var bounds = RevisionDiff.Bounds()
        bounds.lineElements = 50
        let base = "```\n" + (0..<80).map { "a \($0)" }.joined(separator: "\n") + "\nshared\n```\n"
        let target = "```\n" + (0..<80).map { "b \($0)" }.joined(separator: "\n") + "\nshared\n```\n"
        let comparison = RevisionDiff.compare(base: record(1, base), target: record(2, target), bounds: bounds)
        #expect(comparison.limits == [.linesNotAligned(regions: 1)])
        #expect(!comparison.regions[0].aligned)
        let kinds = comparison.regions[0].rows.map(\.kind)
        var expected: [DiffRow.Kind] = [.context]
        expected += [DiffRow.Kind](repeating: .removed, count: 80)
        expected += [DiffRow.Kind](repeating: .added, count: 80)
        expected += [.context, .context]
        #expect(kinds == expected)
        #expect(comparison.regions[0].rows.allSatisfy { $0.segments.allSatisfy { !$0.changed } })
    }

    @Test func regionsAndRowsBeyondTheBoundsAreCounted() {
        var bounds = RevisionDiff.Bounds()
        bounds.regions = 3
        bounds.rows = 4
        let base = (0..<10).map { "same \($0)\n\nold \($0)" }.joined(separator: "\n\n") + "\n"
        let target = (0..<10).map { "same \($0)\n\nnew \($0)" }.joined(separator: "\n\n") + "\n"
        let comparison = RevisionDiff.compare(base: record(1, base), target: record(2, target), bounds: bounds)
        #expect(comparison.regions.count == 3)
        #expect(comparison.limits.contains(.regionsOmitted(7)))
        #expect(comparison.regions.reduce(0) { $0 + $1.rows.count } == 4)
        #expect(comparison.limits.contains { if case .rowsOmitted = $0 { true } else { false } })
    }

    @Test func largeSequencesStayWithinTheirBound() {
        let old = Array(0..<30_000)
        let new = Array(30_000..<60_000)
        let changes = SequenceChanges.compute(old, new, limit: 2500)
        #expect(!changes.aligned)
        #expect(changes.removed.allSatisfy { $0 })
        var shifted = old
        shifted[15_000] = -1
        let small = SequenceChanges.compute(old, shifted, limit: 2500)
        #expect(small.aligned)
        #expect(small.removed.count(where: { $0 }) == 1)
        #expect(small.inserted.firstIndex(of: true) == 15_000)
    }

    @Test func onlyTheFinalLineBreakDiffers() {
        let comparison = RevisionDiff.compare(base: record(1, "# A\n\ntext"), target: record(2, "# A\n\ntext\n"))
        #expect(comparison.regions.isEmpty)
        #expect(comparison.finalLineBreakDiffers)
        #expect(!comparison.sourceIdentical)
    }
}

@Suite struct RetainedImageComparison {
    private func inventory(_ items: [ReferenceItem], truncated: Bool = false) -> ReferenceInventory {
        ReferenceInventory(state: .inspected, truncated: truncated, omitted: 0, items: items)
    }

    @Test func anImageOnlyRevisionIsNotUnchanged() {
        let source = "# Design\n\n## Diagram\n\n![Diagram](diagram.png)\n"
        let base = record(1, source, references: inventory([retained("diagram.png", digit: "a", bytes: 100)]))
        let target = record(2, source, references: inventory([retained("diagram.png", digit: "b", bytes: 140)]))
        let comparison = RevisionDiff.compare(base: base, target: target)
        #expect(comparison.sourceIdentical)
        #expect(comparison.regions.isEmpty)
        #expect(!comparison.finalLineBreakDiffers)
        #expect(comparison.assets.coverage == .compared)
        #expect(comparison.assets.changes.count == 1)
        let change = comparison.assets.changes[0]
        #expect(change.kind == .modified)
        #expect(change.reference == "diagram.png")
        #expect(change.base?.bytes == 100)
        #expect(change.target?.digest == "sha256:" + String(repeating: "b", count: 64))
        #expect(change.sections == [["Design", "Diagram"]])
    }

    @Test func stateChangesAndRetainedAdditionsAreReported() {
        let base = record(1, "![a](a.png) ![b](b.png) ![c](c.png)\n", references: inventory([
            retained("a.png", digit: "a", bytes: 1),
            ReferenceItem(kind: .image, reference: "b.png", state: "unavailable", reason: "missing"),
            retained("c.png", digit: "c", bytes: 3),
            ReferenceItem(kind: .link, reference: "notes.md", state: "local-only"),
        ]))
        let target = record(2, "![a](a.png) ![b](b.png) ![d](d.png) ![e](https://example.com/e.png)\n", references: inventory([
            retained("a.png", digit: "a", bytes: 1),
            retained("b.png", digit: "b", bytes: 2),
            retained("d.png", digit: "d", bytes: 4),
            ReferenceItem(kind: .image, reference: "https://example.com/e.png", state: "external"),
        ]))
        let assets = RevisionDiff.compare(base: base, target: target).assets
        #expect(assets.unchanged == 1)
        #expect(assets.changes.map(\.kind) == [.modified, .added, .removed])
        #expect(assets.changes.map(\.reference) == ["b.png", "d.png", "c.png"])
    }

    @Test func missingAndIncompleteInventoriesAreStated() {
        let source = "![a](a.png)\n"
        let inspected = inventory([retained("a.png", digit: "a", bytes: 1)])
        let uninspected = RevisionDiff.compare(base: record(1, source), target: record(2, source, references: inspected)).assets
        guard case .notComparable(let reason) = uninspected.coverage else {
            Issue.record("an uninspected inventory must not compare")
            return
        }
        #expect(reason.contains("earlier revision"))
        #expect(uninspected.changes.isEmpty)
        let truncated = RevisionDiff.compare(base: record(1, source, references: inspected), target: record(2, source, references: inventory([retained("a.png", digit: "a", bytes: 1)], truncated: true))).assets
        guard case .incomplete = truncated.coverage else {
            Issue.record("a truncated inventory must be stated")
            return
        }
        #expect(RevisionDiff.compare(base: record(1, "text\n"), target: record(2, "more\n")).assets.coverage == .noImages)
    }
}

@Suite(.serialized) struct RevisionReach {
    @Test func adjacentRevisionsSkipMissingNumbersWithinTheProbeBound() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        for revision in [1, 2, 5, 60, 61] { try store.addRevision(docA, revision: revision, source: "# \(revision)\n") }
        let reader = try DirectoryStore(root: store.root)
        #expect(try reader.loadRevision(docA).revisions == [60, 61])
        #expect(reader.adjacentRevision(docA, to: 61, newer: false, pointer: 61) == 60)
        #expect(reader.adjacentRevision(docA, to: 5, newer: false, pointer: 61) == 2)
        #expect(reader.adjacentRevision(docA, to: 2, newer: true, pointer: 61) == 5)
        #expect(reader.adjacentRevision(docA, to: 1, newer: false, pointer: 61) == nil)
        #expect(reader.adjacentRevision(docA, to: 61, newer: true, pointer: 61) == nil)
        #expect(reader.adjacentRevision(docA, to: 60, newer: false, pointer: 61) == nil)
        #expect(reader.adjacentRevision(docA, to: 5, newer: true, pointer: 61) == nil)
        #expect(try reader.loadRevision(docA, revision: 2).source == "# 2\n")
    }
}
