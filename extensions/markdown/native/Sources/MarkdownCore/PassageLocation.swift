import Foundation

/// Where a selected passage sits in a Markdown source, as far as the source establishes it.
public struct PassageLocation: Sendable, Equatable {
    public enum Basis: Sendable, Equatable {
        /// `lines` are exact: the passage occurs there verbatim. For a passage selected in the
        /// rendering, it occurs exactly once in the Markdown of its enclosing blocks.
        case sourceText
        /// The passage is rendered text. `lines` are those of its enclosing blocks, which the
        /// parser's block positions establish; the passage's own Markdown can differ from it.
        case renderedText
        /// No source lines are established.
        case unlocated
    }

    public var basis: Basis
    public var lines: ClosedRange<Int>?
    /// The headings above the passage's first block.
    public var headingPath: [String]
    /// The enclosing top-level blocks, counted from 1.
    public var blocks: ClosedRange<Int>?
    public var blockCount: Int
}

extension SourceStructure {
    /// Locates text selected in the rendering. `renderedBlocks` are the positions of the first and
    /// last keyed block that the selection touches, and `renderedBlockCount` the number of keyed
    /// blocks on the page; lines are named only when that count is the source's own.
    public func locate(renderedText: String, renderedBlocks: ClosedRange<Int>?, renderedBlockCount: Int) -> PassageLocation {
        guard matchesRendering, renderedBlockCount == blocks.count(where: \.keyed), let renderedBlocks,
              let first = block(renderedOrdinal: renderedBlocks.lowerBound),
              let last = block(renderedOrdinal: renderedBlocks.upperBound), first <= last
        else { return unlocated }
        let enclosing = blocks[first].lines.lowerBound...max(blocks[first].lines.lowerBound, blocks[last].lines.upperBound)
        let exact = occurrences(of: renderedText, in: enclosing, unique: true)
        return PassageLocation(basis: exact == nil ? .renderedText : .sourceText, lines: exact ?? enclosing, headingPath: headingPath(at: first), blocks: (first + 1)...(last + 1), blockCount: blocks.count)
    }

    /// Locates text selected in the source view on the given lines. The lines are named only
    /// when the source has the text there.
    public func locate(sourceText: String, lines range: ClosedRange<Int>?) -> PassageLocation {
        guard let range, range.lowerBound >= 1, range.upperBound <= lines.count,
              occurrences(of: sourceText, in: range, unique: false) != nil,
              let first = blocks.firstIndex(where: { $0.span.contains(range.lowerBound) }),
              let last = blocks.firstIndex(where: { $0.span.contains(range.upperBound) })
        else { return unlocated }
        return PassageLocation(basis: .sourceText, lines: range, headingPath: headingPath(at: first), blocks: (first + 1)...(last + 1), blockCount: blocks.count)
    }

    private var unlocated: PassageLocation {
        PassageLocation(basis: .unlocated, lines: nil, headingPath: [], blocks: nil, blockCount: blocks.count)
    }

    /// The lines inside `range` that hold `text` verbatim, compared without carriage returns and
    /// without the white space around the text. With `unique`, nil when the text occurs more
    /// than once.
    private func occurrences(of text: String, in range: ClosedRange<Int>, unique: Bool) -> ClosedRange<Int>? {
        let needle = text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return nil }
        let hay = lines[(range.lowerBound - 1)...(range.upperBound - 1)]
            .map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
            .joined(separator: "\n")
        guard let found = hay.range(of: needle, options: .literal) else { return nil }
        if unique, hay.range(of: needle, options: .literal, range: hay.index(after: found.lowerBound)..<hay.endIndex) != nil { return nil }
        let start = range.lowerBound + SourceStructure.lineFeeds(String(hay[..<found.lowerBound]))
        return start...(start + SourceStructure.lineFeeds(needle))
    }
}
