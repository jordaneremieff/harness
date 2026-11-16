import Foundation
import cmark_gfm
import cmark_gfm_extensions

/// One top-level block of a Markdown source, located by the line where the parser says it
/// starts. A block's extent ends where the next block starts, so every source line belongs to
/// exactly one block.
public struct SourceBlock: Sendable, Equatable {
    /// The block's lines in the exact source, counted from 1, without the blank lines after it.
    public var lines: ClosedRange<Int>
    /// The block's lines and every line up to the next block.
    public var span: ClosedRange<Int>
    /// Set for a heading block.
    public var headingLevel: Int?
    public var headingTitle: String?
    /// Whether the rendering wraps the block in an element with a position key. Footnote
    /// definitions are rendered elsewhere and carry none.
    public var keyed: Bool
    /// Image destinations inside the block, exactly as the parser reports them.
    public var images: [String]
}

/// The lines and top-level blocks of one Markdown source. Line numbers always refer to the exact
/// source, including a front matter block.
public struct SourceStructure: Sendable {
    /// Image destinations kept per block.
    static let imagesPerBlock = 32

    /// The source's lines without their line feed. A carriage return before it stays.
    public var lines: [String]
    public var endsWithLineBreak: Bool
    public var blocks: [SourceBlock]
    /// False when the parser's start lines did not give every keyed block its own extent. The
    /// blocks then cover the source, but they do not correspond one to one to rendered blocks.
    public var matchesRendering: Bool
    /// For each block, the index of the heading block that governs it: itself for a heading.
    private var governing: [Int?]
    /// For each heading block, the index of the heading above it.
    private var parent: [Int: Int]

    public static func scan(_ source: String) -> SourceStructure {
        let (lines, endsWithLineBreak) = splitLines(source)
        let (frontMatter, body) = MarkdownRenderer.splitFrontMatter(source)
        var starts: [Start] = []
        var offset = 0
        if frontMatter != nil {
            offset = lineBreakCount(source) - lineBreakCount(body)
            starts.append(Start(line: 1, keyed: true))
        }
        var matchesRendering = true
        if let parsed = MarkdownParser.parse(Array(body.utf8)) {
            defer { parsed.free() }
            var node = cmark_node_first_child(parsed.document)
            while let current = node {
                node = cmark_node_next(current)
                let type = cmark_node_get_type(current)
                var start = Start(line: max(1, Int(cmark_node_get_start_line(current))) + offset, keyed: type != CMARK_NODE_FOOTNOTE_DEFINITION)
                if type == CMARK_NODE_HEADING {
                    start.level = Int(cmark_node_get_heading_level(current))
                    let title = MarkdownRenderer.plainText(current)
                    start.title = title.isEmpty ? "Untitled section" : title
                }
                start.images = images(in: current)
                if start.line > lines.count || start.line <= (starts.last?.line ?? 0) {
                    // The start line gives this block no extent of its own; its lines stay with
                    // the block before it.
                    if start.keyed { matchesRendering = false }
                    if !starts.isEmpty { starts[starts.count - 1].images += start.images }
                    continue
                }
                starts.append(start)
            }
        } else {
            matchesRendering = false
        }
        if starts.isEmpty, !lines.isEmpty {
            starts.append(Start(line: 1, keyed: false))
            matchesRendering = false
        }
        var blocks: [SourceBlock] = []
        var governing: [Int?] = []
        var parent: [Int: Int] = [:]
        var open: [(index: Int, level: Int)] = []
        for (index, start) in starts.enumerated() {
            let first = index == 0 ? 1 : start.line
            let last = index + 1 < starts.count ? starts[index + 1].line - 1 : lines.count
            var end = last
            while end > start.line, isBlank(lines[end - 1]) { end -= 1 }
            blocks.append(SourceBlock(
                lines: start.line...max(start.line, end),
                span: first...max(first, last),
                headingLevel: start.level,
                headingTitle: start.title,
                keyed: start.keyed,
                images: Array(start.images.prefix(imagesPerBlock))
            ))
            if let level = start.level {
                while let top = open.last, top.level >= level { open.removeLast() }
                if let above = open.last { parent[index] = above.index }
                open.append((index, level))
            }
            governing.append(open.last?.index)
        }
        return SourceStructure(lines: lines, endsWithLineBreak: endsWithLineBreak, blocks: blocks, matchesRendering: matchesRendering, governing: governing, parent: parent)
    }

    /// The titles of the headings above a block, outermost first. A heading block ends its own path.
    public func headingPath(at block: Int) -> [String] {
        guard governing.indices.contains(block), var index = governing[block] else { return [] }
        var titles: [String] = []
        while true {
            titles.append(blocks[index].headingTitle ?? "")
            guard let above = parent[index] else { break }
            index = above
        }
        return titles.reversed()
    }

    /// The block that the rendering wraps as its `ordinal`-th keyed element, when the blocks
    /// correspond to the rendering.
    public func block(renderedOrdinal ordinal: Int) -> Int? {
        guard matchesRendering, ordinal >= 0 else { return nil }
        var seen = 0
        for (index, block) in blocks.enumerated() where block.keyed {
            if seen == ordinal { return index }
            seen += 1
        }
        return nil
    }

    /// The position of each keyed block among the rendering's keyed elements.
    public func renderedOrdinals() -> [Int?] {
        guard matchesRendering else { return blocks.map { _ in nil } }
        var next = 0
        return blocks.map { block in
            guard block.keyed else { return nil }
            defer { next += 1 }
            return next
        }
    }

    /// The exact text of a range of lines, joined with line feeds.
    public func text(_ range: ClosedRange<Int>) -> String {
        guard range.lowerBound >= 1, range.upperBound <= lines.count else { return "" }
        return lines[(range.lowerBound - 1)...(range.upperBound - 1)].joined(separator: "\n")
    }

    private struct Start {
        var line: Int
        var keyed: Bool
        var level: Int?
        var title: String?
        var images: [String] = []
    }

    static func splitLines(_ source: String) -> (lines: [String], endsWithLineBreak: Bool) {
        let bytes = Array(source.utf8)
        var lines: [String] = []
        var start = 0
        SourceLineBreaks.forEach(in: source) { boundary in
            // Keep CR before LF in the line text, so existing source rows remain exact.
            let end = bytes[boundary.endUTF8 - 1] == 0x0A ? boundary.endUTF8 - 1 : boundary.startUTF8
            lines.append(String(decoding: bytes[start..<end], as: UTF8.self))
            start = boundary.endUTF8
        }
        if start < bytes.count {
            lines.append(String(decoding: bytes[start...], as: UTF8.self))
            return (lines, false)
        }
        return (lines, !bytes.isEmpty)
    }

    static func lineBreakCount(_ text: String) -> Int {
        SourceLineBreaks.count(in: text)
    }

    static func isBlank(_ line: String) -> Bool {
        line.utf8.allSatisfy { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
    }

    private static func images(in node: MarkdownRenderer.Node) -> [String] {
        var found: [String] = []
        guard let iterator = cmark_iter_new(node) else { return found }
        defer { cmark_iter_free(iterator) }
        while found.count < imagesPerBlock {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let child = cmark_iter_get_node(iterator), cmark_node_get_type(child) == CMARK_NODE_IMAGE else { continue }
            let reference = MarkdownRenderer.string(cmark_node_get_url(child))
            if !found.contains(reference) { found.append(reference) }
        }
        return found
    }
}

extension RenderedDocument {
    private static let blockMarker = "<div class=\"blk\" data-key=\""
    private static let footnotesMarker = "<section class=\"footnotes\""

    /// The rendered HTML of each keyed block, in document order. The renderer escapes every
    /// character of the content that could spell the wrapper's opening tag, so the tag marks
    /// block boundaries. The footnote section after the last block belongs to no block.
    public func blockFragments() -> [String] {
        var parts = body.components(separatedBy: Self.blockMarker)
        guard parts.count > 1 else { return [] }
        parts.removeFirst()
        if let last = parts.last, let cut = last.range(of: Self.footnotesMarker) {
            parts[parts.count - 1] = String(last[..<cut.lowerBound])
        }
        return parts.map { Self.blockMarker + $0 }
    }
}
