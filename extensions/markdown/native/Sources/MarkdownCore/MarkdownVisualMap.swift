import Foundation
import cmark_gfm

/// A lossless projection: hidden syntax remains in the source; visible runs keep exact UTF-16 units.
public struct MarkdownVisualMap: Sendable {
    public struct Hidden: Sendable {
        public var range: NSRange
        public let opening: Bool
    }
    public let source: String
    public let text: String
    public let hidden: [Hidden]
    public let spans: [EditorSemanticSpan]
    public let fallbackRanges: [NSRange]
    private let removedEnds: [Int]
    private let sourceLength: Int
    private let textLength: Int

    public init(source: String) {
        var builder = VisualMapBuilder(source: source)
        let result = builder.build()
        self.init(source: source, hidden: result.0, spans: result.1, fallbackRanges: result.2)
    }

    private init(source: String, hidden: [Hidden], spans: [EditorSemanticSpan], fallbackRanges: [NSRange]) {
        self.source = source
        let ordered = hidden.sorted { $0.range.location < $1.range.location }
        self.hidden = ordered
        var removed = 0
        removedEnds = ordered.map { item in removed += item.range.length; return removed }
        self.fallbackRanges = fallbackRanges
        let native = source as NSString
        sourceLength = native.length
        var text = "", offset = 0
        for item in self.hidden {
            text += native.substring(with: NSRange(location: offset, length: item.range.location - offset))
            offset = NSMaxRange(item.range)
        }
        text += native.substring(from: offset)
        self.text = text
        textLength = text.utf16.count
        self.spans = spans
    }

    public func visualOffset(forSource offset: Int) -> Int {
        var low = 0, high = hidden.count
        while low < high {
            let middle = (low + high) / 2
            if hidden[middle].range.location < offset { low = middle + 1 } else { high = middle }
        }
        guard low > 0 else { return max(0, min(textLength, offset)) }
        let index = low - 1, item = hidden[index]
        let removed = (index > 0 ? removedEnds[index - 1] : 0) + min(item.range.length, offset - item.range.location)
        return max(0, min(textLength, offset - removed))
    }

    public func visualRange(forSource range: NSRange) -> NSRange {
        let start = visualOffset(forSource: range.location)
        return NSRange(location: start, length: visualOffset(forSource: NSMaxRange(range)) - start)
    }

    public func sourceOffset(forVisual offset: Int) -> Int {
        var removed = 0
        for item in hidden {
            let position = item.range.location - removed
            if position > offset { break }
            if position == offset && !item.opening { break }
            removed += item.range.length
        }
        return min(sourceLength, offset + removed)
    }

    /// Selections map through syntax, but an edit across hidden delimiters is ambiguous.
    public func sourceRange(forVisual range: NSRange) -> NSRange {
        let start = sourceOffset(forVisual: range.location)
        let end = sourceOffset(forVisual: NSMaxRange(range))
        return NSRange(location: start, length: max(0, end - start))
    }

    public func editRange(forVisual range: NSRange) -> NSRange? {
        guard Range(range, in: text) != nil else { return nil }
        if range.length == 0 { return sourceRange(forVisual: range) }
        // Range endpoints refer to the selected characters, not caret affinity.
        var removed = 0, start: Int?, end: Int?
        for item in hidden {
            let boundary = item.range.location - removed
            if boundary <= range.location { removed += item.range.length; continue }
            if start == nil { start = range.location + removed }
            if boundary < NSMaxRange(range) { return nil }
            end = NSMaxRange(range) + removed
            break
        }
        let result = NSRange(location: start ?? (range.location + removed),
                             length: (end ?? (NSMaxRange(range) + removed)) - (start ?? (range.location + removed)))
        return Range(result, in: source) == nil ? nil : result
    }

    /// During marked text, move existing syntax offsets without reparsing or replacing native input.
    public func replacing(visual range: NSRange, with replacement: String) -> MarkdownVisualMap? {
        guard let sourceRange = editRange(forVisual: range) else { return nil }
        let next = (source as NSString).replacingCharacters(in: sourceRange, with: replacement)
        let delta = replacement.utf16.count - sourceRange.length
        let shifted = hidden.map { item -> Hidden in
            var item = item
            if item.range.location >= NSMaxRange(sourceRange) { item.range.location += delta }
            return item
        }
        return MarkdownVisualMap(source: next, hidden: shifted, spans: [], fallbackRanges: [])
    }
}

private struct VisualMapBuilder {
    typealias Node = UnsafeMutablePointer<cmark_node>
    let source: String
    let native: NSString
    let coordinates: EditorSourceCoordinates
    var hidden: [MarkdownVisualMap.Hidden] = []
    var spans: [EditorSemanticSpan] = []
    var fallback: [NSRange] = []

    init(source: String) {
        self.source = source; native = source as NSString; coordinates = EditorSourceCoordinates(source)
    }

    mutating func build() -> ([MarkdownVisualMap.Hidden], [EditorSemanticSpan], [NSRange]) {
        // Front matter changes the parser's document origin. Keep its exact source visible.
        guard MarkdownRenderer.splitFrontMatter(source).0 == nil,
              let parsed = MarkdownParser.parse(Array(source.utf8)) else { return ([], [], [NSRange(location: 0, length: native.length)]) }
        defer { parsed.free() }
        var child = cmark_node_first_child(parsed.document)
        while let node = child {
            let oldHidden = hidden.count, oldSpans = spans.count
            if !visit(node) {
                hidden.removeSubrange(oldHidden...); spans.removeSubrange(oldSpans...)
                if let range = range(node) { fallback.append(range) }
            }
            child = cmark_node_next(node)
        }
        spans.sort {
            if $0.range.location != $1.range.location { return $0.range.location < $1.range.location }
            return $0.range.length > $1.range.length
        }
        return (hidden, spans, fallback)
    }

    func parserRange(_ node: Node) -> NSRange? {
        coordinates.range(startLine: Int(cmark_node_get_start_line(node)), startColumn: Int(cmark_node_get_start_column(node)),
                          endLine: Int(cmark_node_get_end_line(node)), endColumn: Int(cmark_node_get_end_column(node)))
    }

    func range(_ node: Node) -> NSRange? {
        if cmark_node_get_type(node) == CMARK_NODE_CODE, let code = codeSpan(node) {
            return NSRange(location: code.opening.location, length: NSMaxRange(code.closing) - code.opening.location)
        }
        return parserRange(node)
    }

    private func codeSpan(_ node: Node) -> (content: NSRange, opening: NSRange, closing: NSRange)? {
        guard let content = parserRange(node), let literal = cmark_node_get_literal(node),
              native.substring(with: content).utf16.elementsEqual(String(cString: literal).utf16) else { return nil }
        // cmark's code positions exclude the fences; its backtick count owns their width.
        let count = Int(cmark_node_get_backtick_count(node))
        guard count > 0, content.location >= count, NSMaxRange(content) <= native.length - count else { return nil }
        let opening = NSRange(location: content.location - count, length: count)
        let closing = NSRange(location: NSMaxRange(content), length: count)
        let delimiter = String(repeating: "`", count: count)
        guard native.substring(with: opening) == delimiter, native.substring(with: closing) == delimiter else { return nil }
        return (content, opening, closing)
    }

    mutating func visit(_ node: Node) -> Bool {
        let type = cmark_node_get_type(node)
        if type == CMARK_NODE_SOFTBREAK { return true }
        guard let outer = range(node) else { return false }
        if type == CMARK_NODE_CODE {
            guard let code = codeSpan(node) else { return false }
            hidden.append(.init(range: code.opening, opening: true))
            hidden.append(.init(range: code.closing, opening: false))
            spans.append(.init(range: code.content, role: .inlineCode))
            return true
        }
        if type == CMARK_NODE_TEXT {
            guard let literal = cmark_node_get_literal(node) else { return false }
            // Entities and escapes are source fallback, not normalised or guessed offsets.
            return native.substring(with: outer).utf16.elementsEqual(String(cString: literal).utf16)
        }
        guard type == CMARK_NODE_PARAGRAPH || type == CMARK_NODE_HEADING || type == CMARK_NODE_EMPH ||
                type == CMARK_NODE_STRONG || type == CMARK_NODE_LINK,
              let first = cmark_node_first_child(node), let last = cmark_node_last_child(node),
              let firstRange = range(first), let lastRange = range(last),
              firstRange.location >= outer.location, NSMaxRange(lastRange) <= NSMaxRange(outer) else { return false }
        var child: Node? = first
        while let current = child {
            guard visit(current) else { return false }
            child = cmark_node_next(current)
        }
        if type == CMARK_NODE_PARAGRAPH { return true }
        let prefix = NSRange(location: outer.location, length: firstRange.location - outer.location)
        let suffix = NSRange(location: NSMaxRange(lastRange), length: NSMaxRange(outer) - NSMaxRange(lastRange))
        let before = native.substring(with: prefix), after = native.substring(with: suffix)
        let role: EditorSemanticRole
        if type == CMARK_NODE_HEADING {
            // Setext headings and closing markers remain source until their full range is mapped.
            guard before.first == "#", before.allSatisfy({ $0 == "#" || $0 == " " || $0 == "\t" }),
                  after.allSatisfy({ $0 == "#" || $0 == " " || $0 == "\t" }) else { return false }
            role = [.heading1, .heading2, .heading3, .heading4, .heading5, .heading6][max(0, min(5, Int(cmark_node_get_heading_level(node)) - 1))]
        } else if type == CMARK_NODE_EMPH || type == CMARK_NODE_STRONG {
            let count = type == CMARK_NODE_STRONG ? 2 : 1
            guard before == after, before.count == count, before.allSatisfy({ $0 == "*" }) || before.allSatisfy({ $0 == "_" }) else { return false }
            role = type == CMARK_NODE_STRONG ? .strong : .emphasis
        } else {
            guard before == "[", after.hasPrefix("]("), after.hasSuffix(")") else { return false }
            role = .linkLabel
        }
        if prefix.length > 0 { hidden.append(.init(range: prefix, opening: true)) }
        if suffix.length > 0 { hidden.append(.init(range: suffix, opening: false)) }
        spans.append(.init(range: NSRange(location: firstRange.location, length: NSMaxRange(lastRange) - firstRange.location), role: role))
        return true
    }
}
