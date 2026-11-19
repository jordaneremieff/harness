import Foundation
import cmark_gfm

/// One rendered block. Offsets count UTF-16 code units in the exact Markdown source.
public struct WebBlock: Codable, Sendable, Equatable {
    public var key: String
    public var start: Int
    public var end: Int
    public var type: String
    public var html: String
    /// DOM textContent UTF-16 ranges paired with absolute source UTF-16 ranges.
    public var map: [[Int]]

    public init(key: String, start: Int, end: Int, type: String, html: String, map: [[Int]] = []) {
        self.key = key
        self.start = start
        self.end = end
        self.type = type
        self.html = html
        self.map = map
    }

    static func make(source: String, range: NSRange, type: String, html: String, nonce: String, occurrence: Int, map: [[Int]] = []) -> WebBlock {
        // A fresh action secret changes transport HTML, not the document's rendered context.
        let stableHTML = html
            .replacingOccurrences(of: "href=\"reader-action:inspect-image/\(nonce)/", with: "href=\"reader-action:inspect-image/{nonce}/")
            .replacingOccurrences(of: "data-image-rendering=\"\(nonce)\"", with: "data-image-rendering=\"{nonce}\"")
        var identity = Data((source as NSString).substring(with: range).utf8)
        identity.append(0)
        identity.append(contentsOf: type.utf8)
        identity.append(0)
        identity.append(contentsOf: stableHTML.utf8)
        let digest = Digest.sha256(identity)
        return WebBlock(key: "w\(digest)-\(occurrence)", start: range.location, end: NSMaxRange(range), type: type, html: html, map: map)
    }
}

/// Line extents exclude their terminator, but retain indentation and trailing spaces.
/// cmark's top-level line positions therefore map without normalising any source byte.
struct WebSourceLines {
    struct Row {
        var range: NSRange
        var next: Int
        var blank: Bool
    }

    let rows: [Row]

    init(_ source: String) {
        let units = Array(source.utf16)
        var rows: [Row] = []
        var start = 0
        var position = 0
        var blank = true
        while position < units.count {
            let unit = units[position]
            if unit == 0x0D || unit == 0x0A {
                let end = position
                position += 1
                if unit == 0x0D, position < units.count, units[position] == 0x0A { position += 1 }
                rows.append(Row(range: NSRange(location: start, length: end - start), next: position, blank: blank))
                start = position
                blank = true
            } else {
                if unit != 0x20 && unit != 0x09 { blank = false }
                position += 1
            }
        }
        if start < units.count {
            rows.append(Row(range: NSRange(location: start, length: units.count - start), next: units.count, blank: blank))
        }
        self.rows = rows
    }

    var nonblankRange: NSRange? {
        range(firstLine: 1, lastLine: rows.count)
    }

    func range(firstLine: Int, lastLine: Int) -> NSRange? {
        guard !rows.isEmpty else { return nil }
        var first = max(0, min(firstLine - 1, rows.count - 1))
        var last = max(first, min(lastLine - 1, rows.count - 1))
        while first <= last, rows[first].blank { first += 1 }
        while last >= first, rows[last].blank { last -= 1 }
        guard first <= last else { return nil }
        return NSRange(location: rows[first].range.location, length: NSMaxRange(rows[last].range) - rows[first].range.location)
    }
}

/// The parser removes reference definitions and relocates footnotes. Preserve source positions
/// before substitution, then associate them with fragments of the whole-document HTML.
struct WebBlockLayout {
    private struct Entry {
        var range: NSRange
        var type: String
        var ordinal: Int?
        var footnoteOrdinal: Int?
    }

    private let source: String
    private var entries: [Entry] = []

    init(document: MarkdownRenderer.Node, source: String) {
        self.source = source
        let lines = WebSourceLines(source)
        var covered = Array(repeating: false, count: lines.rows.count)
        var ordinal = 0
        var footnoteOrdinal = 0
        var node = cmark_node_first_child(document)
        while let current = node {
            node = cmark_node_next(current)
            let footnote = cmark_node_get_type(current) == CMARK_NODE_FOOTNOTE_DEFINITION
            let first = max(1, Int(cmark_node_get_start_line(current)))
            let last = max(first, Int(cmark_node_get_end_line(current)))
            if let range = lines.range(firstLine: first, lastLine: last) {
                entries.append(Entry(range: range, type: Self.type(of: current), ordinal: footnote ? nil : ordinal, footnoteOrdinal: footnote ? footnoteOrdinal : nil))
                if first <= lines.rows.count {
                    for index in (first - 1)..<min(last, lines.rows.count) { covered[index] = true }
                }
            }
            if footnote { footnoteOrdinal += 1 } else { ordinal += 1 }
        }

        // Definitions have no rendered node. They still need a source block for editing.
        var index = 0
        while index < lines.rows.count {
            guard !covered[index], !lines.rows[index].blank else { index += 1; continue }
            let first = index
            repeat { index += 1 } while index < lines.rows.count && !covered[index] && !lines.rows[index].blank
            if let range = lines.range(firstLine: first + 1, lastLine: index) {
                let text = (source as NSString).substring(with: range).trimmingCharacters(in: .whitespaces)
                entries.append(Entry(range: range, type: text.hasPrefix("[^") ? "footnotes" : "other"))
            }
        }
        entries.sort { $0.range.location < $1.range.location }
    }

    func rendered(html: String, nonce: String, mapping: WebTextMap) -> [WebBlock] {
        let sectionMarker = "<section class=\"footnotes\" data-footnotes>\n<ol>\n"
        let section = html.range(of: sectionMarker)
        let mainHTML = section.map { String(html[..<$0.lowerBound]) } ?? html
        let marker = "<div class=\"blk\" data-key=\""
        let fragments = mainHTML.components(separatedBy: marker).dropFirst().map { part -> String in
            guard let opening = part.range(of: "\">"), let closing = part.range(of: "</div>", options: .backwards) else { return "" }
            return String(part[opening.upperBound..<closing.lowerBound])
        }
        var notes: [String] = []
        if let section {
            var inner = String(html[section.upperBound...])
            let ending = "</ol>\n</section>\n"
            if inner.hasSuffix(ending) { inner.removeLast(ending.count) }
            // Only cmark creates a list item with this ID prefix. Raw document HTML is escaped.
            notes = inner.components(separatedBy: "<li id=\"fn-").dropFirst().enumerated().map { index, part in
                "<section class=\"footnotes\" data-footnotes>\n<ol start=\"\(index + 1)\">\n<li id=\"fn-" + part + "</ol>\n</section>\n"
            }
        }
        var occurrences: [String: Int] = [:]
        return entries.map { entry in
            let fragment: String
            if let ordinal = entry.ordinal, fragments.indices.contains(ordinal) {
                fragment = fragments[ordinal]
            } else if let ordinal = entry.footnoteOrdinal, notes.indices.contains(ordinal) {
                fragment = notes[ordinal]
            } else {
                fragment = ""
            }
            let mapped = mapping.finish(fragment)
            var block = WebBlock.make(source: source, range: entry.range, type: entry.type, html: mapped.html, nonce: nonce, occurrence: 0, map: mapped.map)
            let occurrence = occurrences[block.key, default: 0]
            occurrences[block.key] = occurrence + 1
            if occurrence > 0 { block.key = String(block.key.dropLast()) + String(occurrence) }
            return block
        }
    }

    private static func type(of node: MarkdownRenderer.Node) -> String {
        switch cmark_node_get_type(node) {
        case CMARK_NODE_PARAGRAPH: "paragraph"
        case CMARK_NODE_HEADING: "heading\(cmark_node_get_heading_level(node))"
        case CMARK_NODE_LIST: "list"
        case CMARK_NODE_BLOCK_QUOTE: "quote"
        case CMARK_NODE_CODE_BLOCK: "code"
        case CMARK_NODE_THEMATIC_BREAK: "rule"
        case CMARK_NODE_HTML_BLOCK: "html"
        case CMARK_NODE_FOOTNOTE_DEFINITION: "footnotes"
        default: MarkdownRenderer.string(cmark_node_get_type_string(node)) == "table" ? "table" : "other"
        }
    }
}

/// Temporary AST markers bind literal runs to final DOM text positions, including the
/// whitespace and controls that the HTML renderer adds. No marker reaches the reader.
final class WebTextMap {
    typealias Node = MarkdownRenderer.Node
    struct Record {
        var text: String
        var runs: [[Int]]
    }
    private let units: [UInt16]
    private let parserByteCount: Int
    private let lines: WebSourceLines
    private let byteToUTF16: [Int]
    private let lineBytes: [Int]
    private var records: [Record] = []
    private var identifiers: [Node: Int] = [:]
    private var entities: [String: String] = [:]

    init(source: String) {
        units = Array(source.utf16)
        let parserSource = Self.normalised(source)
        parserByteCount = parserSource.utf8.count
        lines = WebSourceLines(source)
        var offsets = [0]
        SourceLineBreaks.forEach(in: parserSource) { offsets.append($0.endUTF8) }
        lineBytes = offsets
        var positions: [Int] = []
        positions.reserveCapacity(parserSource.utf8.count + 1)
        var offset = 0
        var previousCR = false
        for scalar in source.unicodeScalars {
            if scalar.value != 0x0A || !previousCR {
                positions.append(contentsOf: repeatElement(offset, count: scalar.value == 0x0D ? 1 : scalar.utf8.count))
            }
            offset += scalar.utf16.count
            previousCR = scalar.value == 0x0D
        }
        positions.append(offset)
        byteToUTF16 = positions
    }

    static func normalised(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }

    private func range(_ node: Node, shift: Int = 0, endShift: Int? = nil) -> NSRange? {
        let first = Int(cmark_node_get_start_line(node)) - 1 + shift
        let last = Int(cmark_node_get_end_line(node)) - 1 + (endShift ?? shift)
        guard lineBytes.indices.contains(first), lineBytes.indices.contains(last) else { return nil }
        let start = lineBytes[first] + max(0, Int(cmark_node_get_start_column(node)) - 1)
        let end = lineBytes[last] + max(0, Int(cmark_node_get_end_column(node)))
        guard start <= end, end <= parserByteCount else { return nil }
        return NSRange(location: byteToUTF16[start], length: byteToUTF16[end] - byteToUTF16[start])
    }

    private func entity(_ text: String) -> String {
        if let value = entities[text] { return value }
        var value = text
        if let parsed = MarkdownParser.parse(Array(text.utf8)) {
            if let paragraph = cmark_node_first_child(parsed.document), let text = cmark_node_first_child(paragraph),
               cmark_node_get_type(text) == CMARK_NODE_TEXT, cmark_node_next(text) == nil {
                value = MarkdownRenderer.string(cmark_node_get_literal(text))
            }
            parsed.free()
        }
        entities[text] = value
        return value
    }

    /// Match the literal against only its AST source extent. A mismatch remains unmapped.
    private func aligned(_ extent: NSRange, expected: String, markdown: Bool, code: Bool = false) -> Record {
        var first = extent.location
        var last = NSMaxRange(extent)
        guard first >= 0, last <= units.count else { return Record(text: expected, runs: []) }
        if code, first < last, units[first] == 0x20, units[last - 1] == 0x20,
           units[first..<last].contains(where: { $0 != 0x20 }) {
            first += 1
            last -= 1
        }
        var text: [UInt16] = []
        var runs: [[Int]] = []
        var index = first
        while index < last {
            let start = index
            var replacement: [UInt16]
            if units[index] == 0x0D || units[index] == 0x0A {
                index += 1
                if units[start] == 0x0D, index < last, units[index] == 0x0A { index += 1 }
                replacement = [code ? 0x20 : 0x0A]
            } else if markdown, units[index] == 0x5C, index + 1 < last, Self.punctuation(units[index + 1]) {
                replacement = [units[index + 1]]
                index += 2
            } else if markdown, units[index] == 0x26,
                      let semicolon = units[index..<min(last, index + 34)].firstIndex(of: 0x3B) {
                let original = String(decoding: units[index...semicolon], as: UTF16.self)
                let decoded = entity(original)
                if decoded != original {
                    replacement = Array(decoded.utf16)
                    index = semicolon + 1
                } else {
                    replacement = [units[index]]
                    index += 1
                }
            } else {
                replacement = [units[index] == 0 ? 0xFFFD : units[index]]
                index += 1
            }
            let run = [text.count, replacement.count, start, index - start]
            if let previous = runs.last, previous[1] == previous[3], run[1] == run[3],
               previous[0] + previous[1] == run[0], previous[2] + previous[3] == run[2] {
                runs[runs.count - 1][1] += run[1]
                runs[runs.count - 1][3] += run[3]
            } else {
                runs.append(run)
            }
            text.append(contentsOf: replacement)
        }
        let decoded = String(decoding: text, as: UTF16.self)
        if decoded == expected { return Record(text: expected, runs: runs) }
        let expectedCount = expected.utf16.count
        if markdown, decoded.hasPrefix(expected),
           text.dropFirst(expectedCount).allSatisfy({ $0 == 0x20 || $0 == 0x09 }) {
            let clipped = runs.compactMap { run -> [Int]? in
                let length = min(run[1], expectedCount - run[0])
                guard length > 0 else { return nil }
                if run[1] != run[3] { return length == run[1] ? run : nil }
                return [run[0], length, run[2], length]
            }
            return Record(text: expected, runs: clipped)
        }
        return Record(text: expected, runs: [])
    }

    private static func punctuation(_ unit: UInt16) -> Bool {
        (0x21...0x2F).contains(unit) || (0x3A...0x40).contains(unit) ||
            (0x5B...0x60).contains(unit) || (0x7B...0x7E).contains(unit)
    }

    private func codeBlock(_ node: Node, expected: String) -> Record {
        let first = max(0, Int(cmark_node_get_start_line(node)) - 1)
        let last = min(lines.rows.count, Int(cmark_node_get_end_line(node)))
        var fenceLength: Int32 = 0
        var fenceOffset: Int32 = 0
        var fenceCharacter: CChar = 0
        let fenced = cmark_node_get_fenced(node, &fenceLength, &fenceOffset, &fenceCharacter) != 0
        var rowIndex = first + (fenced ? 1 : 0)
        var output = 0
        var runs: [[Int]] = []
        let parts = expected.components(separatedBy: "\n")
        for (partIndex, part) in parts.enumerated() {
            guard rowIndex < last else { return Record(text: expected, runs: []) }
            let row = lines.rows[rowIndex]
            let count = part.utf16.count
            if count <= row.range.length {
                let start = NSMaxRange(row.range) - count
                if String(decoding: units[start..<NSMaxRange(row.range)], as: UTF16.self) == part, count > 0 {
                    runs.append([output, count, start, count])
                }
            }
            output += count
            if partIndex < parts.count - 1 {
                let length = row.next - NSMaxRange(row.range)
                if length > 0 { runs.append([output, 1, NSMaxRange(row.range), length]) }
                output += 1
            }
            rowIndex += 1
        }
        return Record(text: expected, runs: runs)
    }

    private func register(_ node: Node, _ record: Record) {
        identifiers[node] = records.count
        records.append(record)
    }

    func capture(_ document: Node) {
        guard let iterator = cmark_iter_new(document) else { return }
        var leaves: [Node] = []
        var cursor = 0
        var escapedLines = 0
        var lineShift = 0
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard let node = cmark_iter_get_node(iterator) else { continue }
            let type = cmark_node_get_type(node)
            if event == CMARK_EVENT_ENTER, type == CMARK_NODE_PARAGRAPH || type == CMARK_NODE_HEADING ||
                type == CMARK_NODE_CODE_BLOCK || type == CMARK_NODE_HTML_BLOCK,
               let extent = range(node) {
                cursor = extent.location
                escapedLines = 0
                lineShift = 0
            }
            if event == CMARK_EVENT_EXIT {
                if type == CMARK_NODE_LINK || type == CMARK_NODE_IMAGE, let extent = range(node) {
                    cursor = max(cursor, NSMaxRange(extent))
                }
                if type == CMARK_NODE_IMAGE { register(node, imageRecord(node)) }
                continue
            }
            if type == CMARK_NODE_SOFTBREAK || type == CMARK_NODE_LINEBREAK {
                if let newline = units[cursor...].firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
                    let length = units[newline] == 0x0D && newline + 1 < units.count && units[newline + 1] == 0x0A ? 2 : 1
                    register(node, Record(text: "\n", runs: [[0, 1, newline, length]]))
                    cursor = newline + length
                    // A backslash break consumes its newline without advancing cmark's line.
                    // Its byte columns continue across that newline until the next normal break.
                    if type == CMARK_NODE_LINEBREAK, newline > 0, units[newline - 1] == 0x5C {
                        escapedLines += 1
                    } else { lineShift = escapedLines }
                    leaves.append(node)
                }
                continue
            }
            guard type == CMARK_NODE_TEXT || type == CMARK_NODE_CODE || type == CMARK_NODE_HTML_INLINE ||
                  type == CMARK_NODE_CODE_BLOCK || type == CMARK_NODE_HTML_BLOCK,
                  let extent = range(node, shift: lineShift, endShift: cmark_node_get_end_line(node) > cmark_node_get_start_line(node) ? escapedLines : lineShift) else { continue }
            if cmark_node_get_end_line(node) > cmark_node_get_start_line(node) { lineShift = escapedLines }
            var literal = MarkdownRenderer.string(cmark_node_get_literal(node))
            if type == CMARK_NODE_CODE_BLOCK {
                if literal.hasSuffix("\n") { literal.removeLast() }
                register(node, codeBlock(node, expected: literal))
            } else if type == CMARK_NODE_HTML_BLOCK {
                while literal.hasSuffix("\n") { literal.removeLast() }
                register(node, aligned(extent, expected: literal, markdown: false))
            } else {
                register(node, aligned(extent, expected: literal, markdown: type == CMARK_NODE_TEXT, code: type == CMARK_NODE_CODE))
                if type != CMARK_NODE_HTML_INLINE { leaves.append(node) }
            }
            cursor = max(cursor, NSMaxRange(extent))
        }
        cmark_iter_free(iterator)
        for node in leaves where !insideImage(node) {
            guard let id = identifiers[node] else { continue }
            insertMarker(node, html: "<!--reader-map-start:\(id)-->", before: true)
            insertMarker(node, html: "<!--reader-map-end:\(id)-->", before: false)
        }
    }

    private func insideImage(_ node: Node) -> Bool {
        var parent = cmark_node_parent(node)
        while let current = parent {
            if cmark_node_get_type(current) == CMARK_NODE_IMAGE { return true }
            parent = cmark_node_parent(current)
        }
        return false
    }

    private func imageRecord(_ node: Node) -> Record {
        var text = ""
        var runs: [[Int]] = []
        if let iterator = cmark_iter_new(node) {
            while cmark_iter_next(iterator) != CMARK_EVENT_DONE {
                guard cmark_iter_get_event_type(iterator) == CMARK_EVENT_ENTER,
                      let child = cmark_iter_get_node(iterator), child != node,
                      let id = identifiers[child], cmark_node_get_type(child) != CMARK_NODE_IMAGE else { continue }
                let record = records[id]
                let offset = text.utf16.count
                runs += record.runs.map { [$0[0] + offset, $0[1], $0[2], $0[3]] }
                let type = cmark_node_get_type(child)
                text += type == CMARK_NODE_SOFTBREAK || type == CMARK_NODE_LINEBREAK ? " " : record.text
            }
            cmark_iter_free(iterator)
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = text.utf16.count - text.drop(while: { $0.isWhitespace }).utf16.count
        let end = prefix + trimmed.utf16.count
        runs = runs.compactMap { run in
            let lower = max(prefix, run[0])
            let upper = min(end, run[0] + run[1])
            guard lower < upper else { return nil }
            if run[1] != run[3] { return lower == run[0] && upper == run[0] + run[1] ? [lower - prefix, run[1], run[2], run[3]] : nil }
            return [lower - prefix, upper - lower, run[2] + lower - run[0], upper - lower]
        }
        return Record(text: trimmed, runs: runs)
    }

    private func insertMarker(_ node: Node, html: String, before: Bool) {
        guard let marker = cmark_node_new(CMARK_NODE_CUSTOM_INLINE) else { return }
        cmark_node_set_on_enter(marker, html)
        let inserted = before ? cmark_node_insert_before(node, marker) : cmark_node_insert_after(node, marker)
        if inserted == 1 { return }
        guard let wrapper = cmark_node_new(CMARK_NODE_ATTRIBUTE) else { cmark_node_free(marker); return }
        cmark_node_append_child(wrapper, marker)
        if (before ? cmark_node_insert_before(node, wrapper) : cmark_node_insert_after(node, wrapper)) == 0 { cmark_node_free(wrapper) }
    }

    func literalHTML(_ node: Node, text: String) -> String {
        guard let id = identifiers[node] else { return MarkdownRenderer.escape(text) }
        return markedHTML(id: id, text: text)
    }

    func sourceLiteralHTML(_ extent: NSRange, text: String) -> String {
        let id = records.count
        records.append(aligned(extent, expected: Self.normalised(text), markdown: false))
        return markedHTML(id: id, text: text)
    }

    private func markedHTML(id: Int, text: String) -> String {
        "<!--reader-map-start:\(id)-->" + MarkdownRenderer.escape(text) + "<!--reader-map-end:\(id)-->"
    }

    func finish(_ html: String) -> (html: String, map: [[Int]], text: String) {
        let input = Array(html.utf16)
        var cleaned: [UInt16] = []
        var text: [UInt16] = []
        var active: [Int: Int] = [:]
        var map: [[Int]] = []
        var index = 0
        while index < input.count {
            if input[index] == 0x3C, let end = input[index...].firstIndex(of: 0x3E) {
                let tag = String(decoding: input[index...end], as: UTF16.self)
                if tag.hasPrefix("<!--reader-map-"), tag.hasSuffix("-->") {
                    let opening = tag.hasPrefix("<!--reader-map-start:")
                    let prefix = opening ? "<!--reader-map-start:" : "<!--reader-map-end:"
                    if let id = Int(tag.dropFirst(prefix.count).dropLast(3)), records.indices.contains(id) {
                        if opening { active[id] = text.count }
                        else if let start = active.removeValue(forKey: id),
                                String(decoding: text[start...], as: UTF16.self) == records[id].text {
                            map += records[id].runs.map { [$0[0] + start, $0[1], $0[2], $0[3]] }
                        }
                    }
                } else { cleaned.append(contentsOf: input[index...end]) }
                index = end + 1
            } else if input[index] == 0x26, let end = input[index..<min(input.count, index + 34)].firstIndex(of: 0x3B) {
                let original = String(decoding: input[index...end], as: UTF16.self)
                let decoded = entity(original)
                if decoded != original {
                    cleaned.append(contentsOf: input[index...end])
                    text.append(contentsOf: decoded.utf16)
                    index = end + 1
                } else {
                    cleaned.append(input[index]); text.append(input[index]); index += 1
                }
            } else {
                let unit = input[index]
                cleaned.append(unit)
                text.append(unit == 0x0D ? 0x0A : unit)
                index += 1
                if unit == 0x0D, index < input.count, input[index] == 0x0A { cleaned.append(input[index]); index += 1 }
            }
        }
        return (String(decoding: cleaned, as: UTF16.self), map.sorted { $0[0] < $1[0] }, String(decoding: text, as: UTF16.self))
    }
}
