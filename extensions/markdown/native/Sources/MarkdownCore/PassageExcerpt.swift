import Foundation

/// Text that a person selected in a Markdown source, prepared for a request to an agent: the lines
/// that hold it, the headings above it, and its source lines clipped around it. A short selection,
/// such as one word, stays identifiable through its line, its offsets and the text beside it.
public struct PassageExcerpt: Sendable, Equatable {
    /// The first and last line of the selected text, counted from 1. CR LF, CR and LF each end a line.
    public var lines: ClosedRange<Int>
    /// The UTF-16 offsets of the selected text in the source. Line breaks at its ends are not part of it.
    public var start: Int
    public var end: Int
    /// The titles of the headings above the selected text, outermost first.
    public var headingPath: [String]
    /// The text of the first selected line before the selection, and of the last selected line after
    /// it. An ellipsis replaces text beyond `contextCharacters` on either side.
    public var before: String
    public var selection: String
    public var after: String

    public static let contextCharacters = 120
    /// The longest selected source that an excerpt carries, in UTF-8 bytes.
    public static let selectionBytes = 16 * 1024
    /// The pairs of marks that can set the selection apart from the text beside it.
    public static let markPairs: [(open: String, close: String)] = [("⟦", "⟧"), ("⟪", "⟫"), ("⦃", "⦄"), ("【", "】")]

    /// Nil when the offsets do not select text on Unicode scalar boundaries, the selection holds only
    /// line breaks, or its source exceeds `selectionBytes`.
    public init?(source: String, start: Int, end: Int, structure: SourceStructure? = nil) {
        let utf16 = source.utf16
        guard start >= 0, start < end, end <= utf16.count else { return nil }
        let scalars = source.unicodeScalars
        let first = utf16.index(utf16.startIndex, offsetBy: start)
        guard var lower = first.samePosition(in: scalars),
              var upper = utf16.index(first, offsetBy: end - start).samePosition(in: scalars) else { return nil }
        while lower < upper, Self.isBreak(scalars[lower]) { lower = scalars.index(after: lower) }
        while lower < upper, Self.isBreak(scalars[scalars.index(before: upper)]) { upper = scalars.index(before: upper) }
        guard lower < upper else { return nil }
        let selection = String(scalars[lower..<upper])
        guard selection.utf8.count <= Self.selectionBytes else { return nil }
        var lineStart = lower, lineEnd = upper
        while lineStart > scalars.startIndex, !Self.isBreak(scalars[scalars.index(before: lineStart)]) {
            lineStart = scalars.index(before: lineStart)
        }
        while lineEnd < scalars.endIndex, !Self.isBreak(scalars[lineEnd]) { lineEnd = scalars.index(after: lineEnd) }
        let firstLine = 1 + Self.breaks(in: scalars[..<lower])
        lines = firstLine...(firstLine + Self.breaks(in: scalars[lower..<upper]))
        self.start = lower.utf16Offset(in: source)
        self.end = upper.utf16Offset(in: source)
        self.selection = selection
        before = Self.clip(String(scalars[lineStart..<lower]), keepingEnd: true)
        after = Self.clip(String(scalars[upper..<lineEnd]), keepingEnd: false)
        if let structure, let block = structure.blocks.firstIndex(where: { $0.span.contains(firstLine) }) {
            headingPath = structure.headingPath(at: block)
        } else {
            headingPath = []
        }
    }

    /// The excerpt's text without marks.
    public var text: String { before + selection + after }

    /// The excerpt with `open` and `close` around the selection.
    public func marked(open: String, close: String) -> String { before + open + selection + close + after }

    /// "line 12" or "lines 12–14".
    public var lineLabel: String {
        lines.lowerBound == lines.upperBound ? "line \(lines.lowerBound)" : "lines \(lines.lowerBound)–\(lines.upperBound)"
    }

    /// The heading path on one line, such as "Setup › Install", or nil outside any section. Long titles
    /// are shortened, and only the innermost three headings of a deep path are named.
    public var section: String? {
        guard !headingPath.isEmpty else { return nil }
        var titles = headingPath.map { title -> String in
            let line = title.split(whereSeparator: \.isNewline).joined(separator: " ")
            return line.count > 80 ? String(line.prefix(79)) + "…" : line
        }
        if titles.count > 4 { titles = ["…"] + titles.suffix(3) }
        return titles.joined(separator: " › ")
    }

    /// The first pair of marks that none of the texts contains, so a mark never reads as document
    /// text, or nil when the texts contain a mark of every pair.
    public static func marks(avoiding texts: [String]) -> (open: String, close: String)? {
        markPairs.first { pair in !texts.contains { $0.contains(pair.open) || $0.contains(pair.close) } }
    }

    private static func isBreak(_ scalar: Unicode.Scalar) -> Bool { scalar == "\n" || scalar == "\r" }

    private static func breaks(in scalars: Substring.UnicodeScalarView) -> Int {
        var count = 0, afterReturn = false
        for scalar in scalars {
            if scalar == "\r" { count += 1; afterReturn = true; continue }
            if scalar == "\n", !afterReturn { count += 1 }
            afterReturn = false
        }
        return count
    }

    /// Keeps at most `contextCharacters` characters next to the selection and starts or ends the kept
    /// text at a word when one is near.
    private static func clip(_ text: String, keepingEnd: Bool) -> String {
        guard text.count > contextCharacters else { return text }
        if keepingEnd {
            var kept = text.suffix(contextCharacters)
            if let space = kept.firstIndex(where: \.isWhitespace), kept.distance(from: kept.startIndex, to: space) < 24 {
                kept = kept[kept.index(after: space)...]
            }
            return "…" + String(kept)
        }
        var kept = text.prefix(contextCharacters)
        if let space = kept.lastIndex(where: \.isWhitespace), kept.distance(from: space, to: kept.endIndex) < 24 {
            kept = kept[..<space]
        }
        return String(kept) + "…"
    }
}
