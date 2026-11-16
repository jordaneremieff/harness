import Foundation
import cmark_gfm
import cmark_gfm_extensions

/// The presentation role of one source range.
public enum EditorSemanticRole: String, Sendable {
    case heading1
    case heading2
    case heading3
    case heading4
    case heading5
    case heading6
    case marker
    case emphasis
    case strong
    case strikethrough
    case inlineCode
    case codeBlock
    case fenceLanguage
    case linkLabel
    case destination
    case imageLabel
    case listMarker
    case taskMarker
    case checkedTask
    case quote
    case rule
    case tableDelimiter
    case reference
    case footnote
    case frontMatter
    case escape
    case html
}

/// One semantic range in the exact source. Ranges do not change the source.
public struct EditorSemanticSpan: Sendable, Equatable {
    public let range: NSRange
    public let role: EditorSemanticRole

    public init(range: NSRange, role: EditorSemanticRole) {
        self.range = range
        self.role = role
    }
}

/// The ordered semantic overlays of a Markdown source. Broad constructs come first and inner
/// tokens follow, so a reader that paints later spans keeps the inner mark visible.
public struct EditorSourceAnalysis: Sendable {
    static let spanLimit = 100_000

    public let spans: [EditorSemanticSpan]

    public static func scan(_ source: String) -> Self {
        var builder = Builder(source: source)
        return builder.analyze()
    }
}

private struct Builder {
    typealias Node = UnsafeMutablePointer<cmark_node>

    private let source: String
    private let nativeSource: NSString
    private let coordinates: EditorSourceCoordinates
    private let lines: [String]
    private let body: String
    private let lineOffset: Int
    private let frontMatterClosingLine: Int?
    private let sourceLength: Int

    private var spans: [(span: EditorSemanticSpan, order: Int)] = []
    private var nextOrder = 0
    private var excludedLines: Set<Int> = []

    init(source: String) {
        self.source = source
        self.nativeSource = source as NSString
        let split = SourceStructure.splitLines(source)
        self.lines = split.lines
        self.coordinates = EditorSourceCoordinates(source)
        let (frontMatter, body) = MarkdownRenderer.splitFrontMatter(source)
        self.body = body
        self.lineOffset = SourceStructure.lineFeeds(source) - SourceStructure.lineFeeds(body)
        self.sourceLength = source.utf16.count
        if frontMatter != nil {
            var closing: Int?
            if split.lines.count > 1 {
                for index in 1..<min(split.lines.count, 400) {
                    let trimmed = split.lines[index].hasSuffix("\r") ? String(split.lines[index].dropLast()) : split.lines[index]
                    if trimmed == "---" || trimmed == "..." {
                        closing = index + 1
                        break
                    }
                }
            }
            self.frontMatterClosingLine = closing
        } else {
            self.frontMatterClosingLine = nil
        }
    }

    mutating func analyze() -> EditorSourceAnalysis {
        if frontMatterClosingLine != nil {
            addFrontMatter()
        }
        if let parsed = MarkdownParser.parse(Array(body.utf8)) {
            defer { parsed.free() }
            traverse(parsed.document)
        }
        scanReferenceDefinitions()
        let ordered = spans.sorted { left, right in
            if left.span.range.location != right.span.range.location {
                return left.span.range.location < right.span.range.location
            }
            if left.span.range.length != right.span.range.length {
                return left.span.range.length > right.span.range.length
            }
            return left.order < right.order
        }
        return EditorSourceAnalysis(spans: ordered.map(\.span))
    }

    // MARK: - Tree walking

    private mutating func traverse(_ document: Node) {
        guard let iterator = cmark_iter_new(document) else { return }
        defer { cmark_iter_free(iterator) }
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iterator) else { continue }
            visit(node)
        }
    }

    private mutating func visit(_ node: Node) {
        let type = cmark_node_get_type(node)
        let typeString = String(cString: cmark_node_get_type_string(node))
        switch type {
        case CMARK_NODE_HEADING:
            visitHeading(node)
        case CMARK_NODE_CODE_BLOCK:
            visitCodeBlock(node)
        case CMARK_NODE_HTML_BLOCK:
            if let range = nodeRange(node) {
                add(.html, range)
                excludeLines(start: Int(cmark_node_get_start_line(node)) + lineOffset, end: Int(cmark_node_get_end_line(node)) + lineOffset)
            }
        case CMARK_NODE_HTML_INLINE:
            add(.html, nodeRange(node))
        case CMARK_NODE_THEMATIC_BREAK:
            add(.rule, nodeRange(node))
        case CMARK_NODE_BLOCK_QUOTE:
            visitQuote(node)
        case CMARK_NODE_ITEM:
            visitItem(node, task: typeString == "tasklist")
        case CMARK_NODE_EMPH:
            add(.emphasis, nodeRange(node))
        case CMARK_NODE_STRONG:
            add(.strong, nodeRange(node))
        case CMARK_NODE_CODE:
            add(.inlineCode, nodeRange(node))
        case CMARK_NODE_LINK:
            visitLink(node, image: false)
        case CMARK_NODE_IMAGE:
            visitLink(node, image: true)
        case CMARK_NODE_TEXT:
            scanEscapes(node)
        case CMARK_NODE_FOOTNOTE_DEFINITION:
            add(.footnote, nodeRange(node))
        case CMARK_NODE_FOOTNOTE_REFERENCE:
            add(.footnote, nodeRange(node))
        default:
            if typeString == "strikethrough" {
                add(.strikethrough, nodeRange(node))
            } else if typeString == "table" {
                visitTable(node)
            }
        }
    }

    private mutating func visitHeading(_ node: Node) {
        if let range = nodeRange(node) {
            add(headingRole(Int(cmark_node_get_heading_level(node))), range)
        }
        let line = Int(cmark_node_get_start_line(node)) + lineOffset
        let column = Int(cmark_node_get_start_column(node))
        guard line >= 1, line <= lines.count, column >= 1 else { return }
        let bytes = content(of: lines[line - 1])
        let start = min(column - 1, bytes.count)
        var end = start
        while end < bytes.count, end - start < 6, bytes[end] == 0x23 {
            end += 1
        }
        guard end > start else { return }
        if end < bytes.count, bytes[end] != 0x20, bytes[end] != 0x09 { return }
        add(.marker, range(line: line, from: start, to: end))
    }

    private mutating func visitCodeBlock(_ node: Node) {
        let startLine = Int(cmark_node_get_start_line(node)) + lineOffset
        let endLine = Int(cmark_node_get_end_line(node)) + lineOffset
        guard startLine >= 1, startLine <= lines.count, endLine >= startLine else { return }
        excludeLines(start: startLine, end: endLine)

        var fenceLength: Int32 = 0
        var fenceOffset: Int32 = 0
        var fenceCharacter: CChar = 0
        let fenced = cmark_node_get_fenced(node, &fenceLength, &fenceOffset, &fenceCharacter) != 0
        guard fenced else {
            add(.codeBlock, nodeRange(node))
            return
        }

        let fenceByte = UInt8(bitPattern: fenceCharacter)
        let openingBytes = content(of: lines[startLine - 1])
        let openingStartColumn = Int(cmark_node_get_start_column(node))
        var openingStart = max(0, min(openingStartColumn - 1, openingBytes.count))
        if openingStart >= openingBytes.count || openingBytes[openingStart] != fenceByte {
            openingStart = openingBytes.firstIndex(of: fenceByte) ?? 0
        }
        var openingEnd = openingStart
        while openingEnd < openingBytes.count, openingBytes[openingEnd] == fenceByte {
            openingEnd += 1
        }
        if openingEnd > openingStart {
            add(.marker, range(line: startLine, from: openingStart, to: openingEnd))
        }

        var languageStart = openingEnd
        while languageStart < openingBytes.count, openingBytes[languageStart] == 0x20 || openingBytes[languageStart] == 0x09 {
            languageStart += 1
        }
        var languageEnd = languageStart
        while languageEnd < openingBytes.count, openingBytes[languageEnd] != 0x20, openingBytes[languageEnd] != 0x09 {
            languageEnd += 1
        }
        if languageEnd > languageStart {
            add(.fenceLanguage, range(line: startLine, from: languageStart, to: languageEnd))
        }

        var contentEnd = min(endLine, lines.count)
        if endLine > startLine, endLine <= lines.count {
            let closingBytes = content(of: lines[endLine - 1])
            let closingStart = closingBytes.firstIndex(of: fenceByte) ?? closingBytes.count
            let containerPrefix = max(0, openingStart - Int(fenceOffset))
            var runEnd = closingStart
            while runEnd < closingBytes.count, closingBytes[runEnd] == fenceByte {
                runEnd += 1
            }
            var rest = runEnd
            while rest < closingBytes.count, closingBytes[rest] == 0x20 || closingBytes[rest] == 0x09 {
                rest += 1
            }
            if closingStart <= containerPrefix + 3,
               runEnd - closingStart >= Int(fenceLength), rest == closingBytes.count {
                add(.marker, range(line: endLine, from: closingStart, to: runEnd))
                contentEnd = endLine - 1
            }
        }

        let contentStart = startLine + 1
        guard contentStart <= contentEnd else { return }
        let endColumn = max(1, content(of: lines[contentEnd - 1]).count)
        add(.codeBlock, coordinates.range(
            startLine: contentStart,
            startColumn: 1,
            endLine: contentEnd,
            endColumn: endColumn
        ))
    }

    private mutating func visitQuote(_ node: Node) {
        guard let blockRange = nodeRange(node) else { return }
        add(.quote, blockRange)
        let startLine = Int(cmark_node_get_start_line(node)) + lineOffset
        let endLine = Int(cmark_node_get_end_line(node)) + lineOffset
        guard startLine >= 1, endLine >= startLine, endLine <= lines.count else { return }
        for line in startLine...endLine {
            let bytes = content(of: lines[line - 1])
            var index = 0
            while index < bytes.count {
                var spaces = 0
                while index < bytes.count, spaces < 3, bytes[index] == 0x20 {
                    index += 1
                    spaces += 1
                }
                guard index < bytes.count, bytes[index] == 0x3E else { break }
                add(.marker, range(line: line, from: index, to: index + 1))
                index += 1
                while index < bytes.count, bytes[index] == 0x20 || bytes[index] == 0x09 {
                    index += 1
                }
            }
        }
    }

    private mutating func visitItem(_ node: Node, task: Bool) {
        let line = Int(cmark_node_get_start_line(node)) + lineOffset
        let column = Int(cmark_node_get_start_column(node))
        guard line >= 1, line <= lines.count, column >= 1 else { return }
        let bytes = content(of: lines[line - 1])
        var index = min(column - 1, bytes.count)
        while index < bytes.count, bytes[index] == 0x20 || bytes[index] == 0x09 {
            index += 1
        }
        let marker = listMarker(in: bytes, from: index)
        if let marker {
            add(.listMarker, range(line: line, from: marker.start, to: marker.end))
            index = marker.end
        }
        guard task else { return }
        while index < bytes.count, bytes[index] == 0x20 || bytes[index] == 0x09 {
            index += 1
        }
        guard index + 2 < bytes.count, bytes[index] == 0x5B, bytes[index + 2] == 0x5D else { return }
        let state = bytes[index + 1]
        guard state == 0x20 || state == 0x78 || state == 0x58 else { return }
        add(.taskMarker, range(line: line, from: index, to: index + 3))
        if state == 0x78 || state == 0x58 {
            add(.checkedTask, range(line: line, from: index, to: index + 3))
        }
    }

    private mutating func visitTable(_ node: Node) {
        let headerLine = Int(cmark_node_get_start_line(node)) + lineOffset
        let endLine = Int(cmark_node_get_end_line(node)) + lineOffset
        let delimiterLine = headerLine + 1
        guard delimiterLine >= 1, delimiterLine <= endLine, delimiterLine <= lines.count else { return }
        let bytes = content(of: lines[delimiterLine - 1])
        var start = 0
        while start < bytes.count, bytes[start] == 0x20 || bytes[start] == 0x09 { start += 1 }
        var end = bytes.count
        while end > start, bytes[end - 1] == 0x20 || bytes[end - 1] == 0x09 { end -= 1 }
        guard end > start, bytes[start..<end].contains(0x2D) else { return }
        add(.tableDelimiter, range(line: delimiterLine, from: start, to: end))
    }

    private mutating func visitLink(_ node: Node, image: Bool) {
        guard let range = nodeRange(node), range.length > 0 else { return }
        let characters = Array(nativeSource.substring(with: range))
        guard !characters.isEmpty else { return }
        var offsets = [Int](repeating: 0, count: characters.count + 1)
        for index in characters.indices {
            offsets[index + 1] = offsets[index] + characters[index].utf16.count
        }
        let base = range.location

        func addRelative(_ role: EditorSemanticRole, _ start: Int, _ end: Int) {
            guard start >= 0, end > start, end <= characters.count else { return }
            let location = base + offsets[start]
            let length = offsets[end] - offsets[start]
            add(role, NSRange(location: location, length: length))
        }

        func marker(_ index: Int) {
            addRelative(.marker, index, index + 1)
        }

        var cursor = 0
        if image, characters[0] == "!" {
            marker(0)
            cursor = 1
        }

        guard cursor < characters.count, characters[cursor] == "[" else {
            if characters.first == "<", characters.last == ">", !characters.contains("[") {
                marker(0)
                marker(characters.count - 1)
                addRelative(.destination, 1, characters.count - 1)
            } else {
                add(.destination, range)
            }
            return
        }

        let opening = cursor
        var depth = 0
        var closing: Int?
        var scan = opening
        while scan < characters.count {
            let character = characters[scan]
            if character == "\\" {
                scan += 2
                continue
            }
            if character == "[" {
                depth += 1
            } else if character == "]" {
                depth -= 1
                if depth == 0 {
                    closing = scan
                    break
                }
            }
            scan += 1
        }
        guard let closing else { return }

        let labelRole: EditorSemanticRole = image ? .imageLabel : .linkLabel
        addRelative(labelRole, opening + 1, closing)
        marker(opening)
        marker(closing)

        let after = closing + 1
        if after < characters.count, characters[after] == "(" {
            marker(after)
            var parenthesisDepth = 1
            var end = after + 1
            while end < characters.count {
                let character = characters[end]
                if character == "\\" {
                    end += 2
                    continue
                }
                if character == "(" {
                    parenthesisDepth += 1
                } else if character == ")" {
                    parenthesisDepth -= 1
                    if parenthesisDepth == 0 { break }
                }
                end += 1
            }
            if end < characters.count, parenthesisDepth == 0 {
                marker(end)
                if let destination = inlineDestination(characters, from: after + 1, to: end) {
                    if let opening = destination.openingMarker { marker(opening) }
                    if let closing = destination.closingMarker { marker(closing) }
                    addRelative(.destination, destination.start, destination.end)
                }
            }
        } else if after < characters.count, characters[after] == "[" {
            marker(after)
            var end = after + 1
            while end < characters.count, characters[end] != "]" {
                if characters[end] == "\\" { end += 1 }
                end += 1
            }
            if end < characters.count {
                marker(end)
                addRelative(.reference, after + 1, end)
            }
        }
    }

    private func inlineDestination(_ characters: [Character], from start: Int, to end: Int) -> (start: Int, end: Int, openingMarker: Int?, closingMarker: Int?)? {
        var index = start
        while index < end, characters[index] == " " || characters[index] == "\t" || characters[index] == "\n" || characters[index] == "\r" {
            index += 1
        }
        guard index < end else { return nil }
        if characters[index] == "<" {
            var close = index + 1
            while close < end, characters[close] != ">" {
                if characters[close] == "\\" { close += 1 }
                close += 1
            }
            guard close < end, close > index + 1 else { return nil }
            return (index + 1, close, index, close)
        }
        var destinationEnd = index
        var depth = 0
        while destinationEnd < end {
            let character = characters[destinationEnd]
            if character == "\\" {
                destinationEnd += 2
                continue
            }
            if character == "(" {
                depth += 1
            } else if character == ")" {
                if depth == 0 { break }
                depth -= 1
            } else if depth == 0, character == " " || character == "\t" || character == "\n" || character == "\r" {
                break
            }
            destinationEnd += 1
        }
        if destinationEnd > end { destinationEnd = end }
        guard destinationEnd > index else { return nil }
        return (index, destinationEnd, nil, nil)
    }

    // MARK: - Front matter, references and escapes

    private mutating func addFrontMatter() {
        guard let closingLine = frontMatterClosingLine, !lines.isEmpty,
              closingLine >= 1, closingLine <= lines.count else { return }
        let endColumn = content(of: lines[closingLine - 1]).count
        guard endColumn > 0 else { return }
        add(.frontMatter, coordinates.range(startLine: 1, startColumn: 1, endLine: closingLine, endColumn: endColumn))
        excludeLines(start: 1, end: closingLine)
    }

    private mutating func scanReferenceDefinitions() {
        guard !lines.isEmpty else { return }
        for index in lines.indices {
            let line = index + 1
            if excludedLines.contains(line) { continue }
            let bytes = content(of: lines[index])
            let indent = bytes.prefix(while: { $0 == 0x20 }).count
            if indent <= 3, bytes.count > indent + 4, bytes[indent] == 0x5B, bytes[indent + 1] == 0x5E,
               let end = bytes[(indent + 2)...].firstIndex(of: 0x5D), end + 1 < bytes.count, bytes[end + 1] == 0x3A {
                add(.footnote, range(line: line, from: indent, to: end + 2))
                continue
            }
            guard let definition = referenceDefinition(in: bytes) else { continue }
            add(.reference, range(line: line, from: definition.start, to: definition.end))
            add(.linkLabel, range(line: line, from: definition.labelStart, to: definition.labelEnd))
            add(.destination, range(line: line, from: definition.destinationStart, to: definition.destinationEnd))
        }
    }

    private func referenceDefinition(in bytes: [UInt8]) -> (start: Int, end: Int, labelStart: Int, labelEnd: Int, destinationStart: Int, destinationEnd: Int)? {
        var start = 0
        while start < bytes.count, start < 3, bytes[start] == 0x20 || bytes[start] == 0x09 { start += 1 }
        guard start + 2 < bytes.count, bytes[start] == 0x5B else { return nil }
        var labelEnd = start + 1
        while labelEnd < bytes.count, bytes[labelEnd] != 0x5D {
            if bytes[labelEnd] == 0x5C { labelEnd += 1 }
            labelEnd += 1
        }
        guard labelEnd < bytes.count, labelEnd > start + 1, labelEnd + 1 < bytes.count, bytes[labelEnd + 1] == 0x3A else { return nil }
        guard labelEnd - start - 1 <= 999, bytes[start + 1] != 0x5E else { return nil }

        var destinationStart = labelEnd + 2
        while destinationStart < bytes.count, bytes[destinationStart] == 0x20 || bytes[destinationStart] == 0x09 {
            destinationStart += 1
        }
        guard destinationStart < bytes.count else { return nil }
        var destinationEnd: Int
        if bytes[destinationStart] == 0x3C {
            destinationStart += 1
            destinationEnd = destinationStart
            while destinationEnd < bytes.count, bytes[destinationEnd] != 0x3E {
                if bytes[destinationEnd] == 0x5C { destinationEnd += 1 }
                destinationEnd += 1
            }
            guard destinationEnd < bytes.count else { return nil }
        } else {
            destinationEnd = destinationStart
            while destinationEnd < bytes.count, bytes[destinationEnd] != 0x20, bytes[destinationEnd] != 0x09 {
                destinationEnd += 1
            }
        }
        guard destinationEnd > destinationStart else { return nil }

        var end = bytes.count
        while end > start, bytes[end - 1] == 0x20 || bytes[end - 1] == 0x09 {
            end -= 1
        }
        guard end >= destinationEnd else { return nil }
        return (start, end, start + 1, labelEnd, destinationStart, destinationEnd)
    }

    private mutating func scanEscapes(_ node: Node) {
        guard let range = nodeRange(node), range.length > 0 else { return }
        let literal = nativeSource.substring(with: range)
        guard literal.utf8.contains(0x5C) else { return }
        let characters = Array(literal)
        guard characters.count >= 2 else { return }
        var offsets = [Int](repeating: 0, count: characters.count + 1)
        for index in characters.indices {
            offsets[index + 1] = offsets[index] + characters[index].utf16.count
        }
        var index = 0
        while index + 1 < characters.count {
            if characters[index] == "\\", isEscapable(characters[index + 1]) {
                let location = range.location + offsets[index]
                let length = offsets[index + 2] - offsets[index]
                add(.escape, NSRange(location: location, length: length))
                index += 2
            } else {
                index += 1
            }
        }
    }

    private func isEscapable(_ character: Character) -> Bool {
        switch character {
        case "!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/",
             ":", ";", "<", "=", ">", "?", "@", "[", "\\", "]", "^", "_", "`", "{", "|", "}", "~":
            return true
        default:
            return false
        }
    }

    // MARK: - Small helpers

    private func headingRole(_ level: Int) -> EditorSemanticRole {
        switch level {
        case 1: .heading1
        case 2: .heading2
        case 3: .heading3
        case 4: .heading4
        case 5: .heading5
        default: .heading6
        }
    }

    private func listMarker(in bytes: [UInt8], from start: Int) -> (start: Int, end: Int)? {
        guard start < bytes.count else { return nil }
        if bytes[start] == 0x2D || bytes[start] == 0x2B || bytes[start] == 0x2A {
            return (start, start + 1)
        }
        var index = start
        while index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39, index - start < 9 {
            index += 1
        }
        if index > start, index < bytes.count, bytes[index] == 0x2E || bytes[index] == 0x29 {
            return (start, index + 1)
        }
        return nil
    }

    private func nodeRange(_ node: Node) -> NSRange? {
        let startLine = Int(cmark_node_get_start_line(node)) + lineOffset
        let endLine = Int(cmark_node_get_end_line(node)) + lineOffset
        let startColumn = Int(cmark_node_get_start_column(node))
        let endColumn = Int(cmark_node_get_end_column(node))
        guard startLine > lineOffset, startLine >= 1, endLine >= startLine,
              startColumn >= 1, endColumn >= 1 else { return nil }
        return coordinates.range(
            startLine: startLine,
            startColumn: startColumn,
            endLine: endLine,
            endColumn: endColumn
        )
    }

    private func content(of line: String) -> [UInt8] {
        var bytes = Array(line.utf8)
        if bytes.last == 0x0D { bytes.removeLast() }
        return bytes
    }

    private func range(line: Int, from start: Int, to end: Int) -> NSRange? {
        guard end > start else { return nil }
        return coordinates.range(startLine: line, startColumn: start + 1, endLine: line, endColumn: end)
    }

    private mutating func excludeLines(start: Int, end: Int) {
        guard start <= end, end >= 1, start <= lines.count else { return }
        for line in max(1, start)...min(end, lines.count) {
            excludedLines.insert(line)
        }
    }

    private mutating func add(_ role: EditorSemanticRole, _ range: NSRange?) {
        guard let range, range.length > 0, range.location >= 0,
              range.location + range.length <= sourceLength,
              spans.count < EditorSourceAnalysis.spanLimit else { return }
        spans.append((EditorSemanticSpan(range: range, role: role), nextOrder))
        nextOrder += 1
    }
}
