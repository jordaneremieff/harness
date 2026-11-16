import Foundation

/// One native source edit. `range` and `selection` are UTF16 coordinates in the source, and
/// `selection` is absolute in the source that results from applying `replacement`.
public struct MarkdownEdit: Sendable, Equatable {
    public var range: NSRange
    public var replacement: String
    public var selection: NSRange
    public var actionName: String

    public init(range: NSRange, replacement: String, selection: NSRange, actionName: String) {
        self.range = range
        self.replacement = replacement
        self.selection = selection
        self.actionName = actionName
    }
}

/// A bounded literal match in a Markdown source.
public struct MarkdownMatch: Sendable, Equatable {
    public var range: NSRange
    public var text: String

    public init(range: NSRange, text: String) {
        self.range = range
        self.text = text
    }
}

/// Options for a literal search. A nil `scope` searches the whole source.
public struct MarkdownLiteralQuery: Sendable, Equatable {
    public var text: String
    public var caseSensitive: Bool
    public var wholeWord: Bool
    public var scope: NSRange?

    public init(text: String, caseSensitive: Bool = true, wholeWord: Bool = false, scope: NSRange? = nil) {
        self.text = text
        self.caseSensitive = caseSensitive
        self.wholeWord = wholeWord
        self.scope = scope
    }
}

public enum MarkdownCommand: Sendable, Equatable {
    /// 1 through 6 set a heading; 0 removes an ATX heading prefix.
    case heading(Int)
    case bold
    case italic
    case strikethrough
    case inlineCode
    case fencedCode(language: String?)
    case quote
    case unorderedList
    case orderedList
    case taskList
    case link
    case indent
    case outdent
    case moveLineUp
    case moveLineDown
    case duplicateLine
    case insertTable
    /// Continues the list item at the caret, or removes an empty item's marker.
    case continueList
    case replace(MarkdownLiteralQuery, with: String)
    case replaceAll(MarkdownLiteralQuery, with: String)
}

/// Native Markdown source commands. This type performs no parsing, rendering or file access:
/// every result is one edit for the caller's undo stack, in the exact source text it is given.
public enum MarkdownCommands {
    /// Matches returned by one literal search.
    public static let matchLimit = 200
    /// Matches one replace-all applies; a bound against unbounded work.
    public static let replaceAllLimit = 10_000

    public static func apply(
        command: MarkdownCommand,
        to source: String,
        selection: NSRange,
        protectedRanges: [NSRange] = []
    ) -> MarkdownEdit? {
        let text = source as NSString
        guard isValid(selection, in: text), protectedRanges.allSatisfy({ isValid($0, in: text) }) else {
            return nil
        }
        let all = lines(of: text)
        guard let selected = selectedLines(selection, in: all, textLength: text.length) else {
            return nil
        }
        let edit: MarkdownEdit?
        switch command {
        case .heading(let level):
            guard (0...6).contains(level) else { return nil }
            edit = lineEdit(all, selected, action: "Set Heading") { content, _ in
                let body = stripHeading(content)
                guard level > 0 else { return body }
                return String(repeating: "#", count: level) + " " + body
            }
        case .bold:
            edit = inlineEdit(command, text, selection, prefix: "**", suffix: "**", action: "Bold")
        case .italic:
            edit = inlineEdit(command, text, selection, prefix: "*", suffix: "*", action: "Italic")
        case .strikethrough:
            edit = inlineEdit(command, text, selection, prefix: "~~", suffix: "~~", action: "Strikethrough")
        case .link:
            edit = inlineEdit(command, text, selection, prefix: "[", suffix: "]()", action: "Link")
        case .inlineCode:
            edit = inlineCodeEdit(text, selection)
        case .fencedCode(let language):
            edit = fencedCodeEdit(all, text, selected, language: language)
        case .quote:
            edit = quoteEdit(all, selected)
        case .unorderedList:
            edit = lineEdit(all, selected, action: "Unordered List") { content, _ in
                listContent(content, kind: .unordered, ordinal: 0)
            }
        case .orderedList:
            var ordinal = 1
            edit = lineEdit(all, selected, action: "Ordered List") { content, _ in
                defer { if !isBlank(content) { ordinal += 1 } }
                return listContent(content, kind: .ordered, ordinal: ordinal)
            }
        case .taskList:
            edit = lineEdit(all, selected, action: "Task List") { content, _ in
                listContent(content, kind: .task, ordinal: 0)
            }
        case .indent:
            edit = lineEdit(all, selected, action: "Indent") { content, _ in
                isBlank(content) ? content : "  " + content
            }
        case .outdent:
            edit = lineEdit(all, selected, action: "Outdent") { content, _ in
                outdented(content)
            }
        case .moveLineUp:
            edit = moveLines(all, selected, up: true)
        case .moveLineDown:
            edit = moveLines(all, selected, up: false)
        case .duplicateLine:
            edit = duplicateLines(all, selected)
        case .insertTable:
            edit = tableEdit(all, text, selection)
        case .continueList:
            edit = continueList(all, text, selection)
        case .replace(let query, let replacement):
            edit = replaceEdit(query, replacement, text, all: false)
        case .replaceAll(let query, let replacement):
            edit = replaceEdit(query, replacement, text, all: true)
        }
        guard let edit else { return nil }
        switch command {
        case .inlineCode, .fencedCode, .replace, .replaceAll:
            // Wrapping code and literal replacement are deliberate source operations, so they
            // may address code ranges. Structural commands still respect protected ranges.
            return edit
        default:
            guard !protectedRanges.contains(where: { overlaps(edit.range, $0) }) else { return nil }
            return edit
        }
    }

    /// All literal matches, bounded by `limit`. Matching is UTF16 literal text, not a pattern.
    public static func matches(
        _ query: MarkdownLiteralQuery,
        in source: String,
        limit: Int = MarkdownCommands.matchLimit
    ) -> [MarkdownMatch] {
        guard !query.text.isEmpty, limit > 0 else { return [] }
        let text = source as NSString
        let scope: NSRange
        if let requested = query.scope {
            guard isValid(requested, in: text) else { return [] }
            scope = requested
        } else {
            scope = NSRange(location: 0, length: text.length)
        }
        var options: NSString.CompareOptions = [.literal]
        if !query.caseSensitive { options.insert(.caseInsensitive) }
        var found: [MarkdownMatch] = []
        var cursor = scope.location
        let end = NSMaxRange(scope)
        while cursor < end, found.count < limit {
            let searchRange = NSRange(location: cursor, length: end - cursor)
            let range = text.range(of: query.text, options: options, range: searchRange)
            if range.location == NSNotFound { break }
            let next = NSMaxRange(range)
            if isComposedBoundary(range.location, in: text),
               isComposedBoundary(next, in: text),
               wholeWordRange(range, query.wholeWord, text) {
                found.append(MarkdownMatch(range: range, text: text.substring(with: range)))
            }
            cursor = next
        }
        return found
    }

    public static func matches(
        of literal: String,
        in source: String,
        caseSensitive: Bool = true,
        wholeWord: Bool = false,
        scope: NSRange? = nil,
        limit: Int = MarkdownCommands.matchLimit
    ) -> [MarkdownMatch] {
        matches(
            MarkdownLiteralQuery(text: literal, caseSensitive: caseSensitive, wholeWord: wholeWord, scope: scope),
            in: source,
            limit: limit
        )
    }
}

// MARK: - Ranges and lines

extension MarkdownCommands {
    private struct Line {
        var start: Int
        var contentEnd: Int
        var end: Int
        var content: String
        var ending: String
    }

    /// Explicit UTF16 boundary check. Composed-character iteration, not `Range(_:in:)`, decides
    /// whether an offset may split a surrogate pair, a combining sequence or an emoji cluster.
    private static func isComposedBoundary(_ offset: Int, in text: NSString) -> Bool {
        guard offset >= 0, offset <= text.length else { return false }
        guard offset > 0, offset < text.length else { return true }
        let previous = text.rangeOfComposedCharacterSequence(at: offset - 1)
        return NSMaxRange(previous) == offset
    }

    private static func isValid(_ range: NSRange, in text: NSString) -> Bool {
        guard range.location != NSNotFound, range.location >= 0, range.length >= 0,
              range.location <= text.length, range.length <= text.length - range.location
        else { return false }
        return isComposedBoundary(range.location, in: text)
            && isComposedBoundary(range.location + range.length, in: text)
    }

    private static func overlaps(_ range: NSRange, _ protected: NSRange) -> Bool {
        guard protected.length > 0 else { return false }
        if range.length == 0 {
            return range.location > protected.location && range.location < NSMaxRange(protected)
        }
        return NSIntersectionRange(range, protected).length > 0
    }

    private static func lines(of text: NSString) -> [Line] {
        var result: [Line] = []
        var start = 0
        while start < text.length {
            let search = NSRange(location: start, length: text.length - start)
            let newline = text.range(of: "\n", options: [], range: search)
            if newline.location == NSNotFound {
                let content = text.substring(with: NSRange(location: start, length: text.length - start))
                result.append(Line(start: start, contentEnd: text.length, end: text.length, content: content, ending: ""))
                start = text.length
                break
            }
            var contentEnd = newline.location
            if contentEnd > start, text.character(at: contentEnd - 1) == 0x0D { contentEnd -= 1 }
            let end = newline.location + 1
            let content = text.substring(with: NSRange(location: start, length: contentEnd - start))
            let ending = text.substring(with: NSRange(location: contentEnd, length: end - contentEnd))
            result.append(Line(start: start, contentEnd: contentEnd, end: end, content: content, ending: ending))
            start = end
        }
        if result.isEmpty || (text.length > 0 && text.character(at: text.length - 1) == 0x0A) {
            result.append(Line(start: text.length, contentEnd: text.length, end: text.length, content: "", ending: ""))
        }
        return result
    }

    private static func lineIndex(at offset: Int, in all: [Line], textLength: Int) -> Int {
        if offset >= textLength { return max(0, all.count - 1) }
        for (index, line) in all.enumerated() where offset >= line.start && offset < line.end {
            return index
        }
        return max(0, all.count - 1)
    }

    private static func selectedLines(_ selection: NSRange, in all: [Line], textLength: Int) -> ClosedRange<Int>? {
        guard !all.isEmpty else { return nil }
        let first = lineIndex(at: selection.location, in: all, textLength: textLength)
        let lastOffset = selection.length == 0 ? selection.location : NSMaxRange(selection) - 1
        let last = lineIndex(at: lastOffset, in: all, textLength: textLength)
        return first...max(first, last)
    }

    private static func defaultEnding(_ all: [Line]) -> String {
        all.first(where: { !$0.ending.isEmpty })?.ending ?? "\n"
    }

    /// Joins reordered lines. A line that is not final always has a break; the final line keeps
    /// the document's final-break state rather than inventing or deleting one.
    private static func join(_ all: [Line], documentFinal: Bool) -> String {
        let ending = defaultEnding(all)
        var result = ""
        for (index, line) in all.enumerated() {
            result += line.content
            if index < all.count - 1 {
                result += line.ending.isEmpty ? ending : line.ending
            } else if !documentFinal {
                result += line.ending.isEmpty ? ending : line.ending
            }
        }
        return result
    }

    private static func prefixLength(_ value: String) -> Int { value.utf16.count }

    private static func lineEdit(
        _ all: [Line],
        _ selected: ClosedRange<Int>,
        action: String,
        _ transform: (String, Int) -> String
    ) -> MarkdownEdit {
        var changed: [Line] = []
        for index in selected {
            var line = all[index]
            line.content = transform(line.content, index - selected.lowerBound)
            changed.append(line)
        }
        let range = NSRange(
            location: all[selected.lowerBound].start,
            length: all[selected.upperBound].end - all[selected.lowerBound].start
        )
        let replacement = changed.map { $0.content + $0.ending }.joined()
        return MarkdownEdit(
            range: range,
            replacement: replacement,
            selection: NSRange(location: range.location, length: replacement.utf16.count),
            actionName: action
        )
    }

    // MARK: - Inline formatting

    private static func inlineEdit(
        _ command: MarkdownCommand,
        _ text: NSString,
        _ selection: NSRange,
        prefix: String,
        suffix: String,
        action: String
    ) -> MarkdownEdit? {
        let selectedText = text.substring(with: selection)
        guard !selectedText.contains("\n"), !selectedText.contains("\r") else { return nil }
        let replacement = prefix + selectedText + suffix
        return MarkdownEdit(
            range: selection,
            replacement: replacement,
            selection: NSRange(location: selection.location + prefixLength(prefix), length: selectedText.utf16.count),
            actionName: action
        )
    }

    private static func inlineCodeEdit(_ text: NSString, _ selection: NSRange) -> MarkdownEdit? {
        let selectedText = text.substring(with: selection)
        guard !selectedText.contains("\n"), !selectedText.contains("\r") else { return nil }
        let fence = String(repeating: "`", count: max(1, longestRun(of: "`", in: selectedText) + 1))
        let padded = selectedText.hasPrefix("`") || selectedText.hasSuffix("`")
            || selectedText.hasPrefix(" ") || selectedText.hasSuffix(" ")
        let pad = padded && !selectedText.isEmpty ? " " : ""
        let replacement = fence + pad + selectedText + pad + fence
        return MarkdownEdit(
            range: selection,
            replacement: replacement,
            selection: NSRange(location: selection.location + prefixLength(fence + pad), length: selectedText.utf16.count),
            actionName: "Inline Code"
        )
    }

    private static func fencedCodeEdit(
        _ all: [Line],
        _ text: NSString,
        _ selected: ClosedRange<Int>,
        language: String?
    ) -> MarkdownEdit? {
        if let language, language.contains("\n") || language.contains("\r") || language.contains("`") {
            return nil
        }
        let range = NSRange(
            location: all[selected.lowerBound].start,
            length: all[selected.upperBound].end - all[selected.lowerBound].start
        )
        var body = text.substring(with: range)
        let ending = all[selected.lowerBound].ending.isEmpty ? defaultEnding(all) : all[selected.lowerBound].ending
        let trailing = body.hasSuffix("\n")
        if !trailing { body += ending }
        let fenceRun = String(repeating: "`", count: max(3, longestRun(of: "`", in: body) + 1))
        let fence = fenceRun + (language ?? "")
        let replacement = fence + ending + body + fenceRun + (trailing ? ending : "")
        return MarkdownEdit(
            range: range,
            replacement: replacement,
            selection: NSRange(
                location: range.location + prefixLength(fence + ending),
                length: body.utf16.count
            ),
            actionName: "Fenced Code"
        )
    }

    private static func longestRun(of character: Character, in text: String) -> Int {
        var longest = 0
        var current = 0
        for value in text {
            if value == character {
                current += 1
                longest = max(longest, current)
            } else {
                current = 0
            }
        }
        return longest
    }

    // MARK: - Block prefixes

    private static func isBlank(_ content: String) -> Bool {
        content.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static func leadingWhitespace(_ content: String) -> (indent: String, rest: String) {
        let indent = content.prefix { $0 == " " || $0 == "\t" }
        return (String(indent), String(content.dropFirst(indent.count)))
    }

    private static func stripHeading(_ content: String) -> String {
        let characters = Array(content)
        var index = 0
        while index < characters.count, index < 3, characters[index] == " " { index += 1 }
        var hashes = 0
        while index + hashes < characters.count, hashes < 6, characters[index + hashes] == "#" { hashes += 1 }
        guard hashes > 0 else { return content }
        var after = index + hashes
        guard after < characters.count else { return String(characters[0..<index]) }
        guard characters[after] == " " || characters[after] == "\t" else { return content }
        while after < characters.count, characters[after] == " " || characters[after] == "\t" { after += 1 }
        return String(characters[0..<index]) + String(characters[after...])
    }

    private static func isASCIIDigit(_ character: Character) -> Bool {
        guard character.unicodeScalars.count == 1, let scalar = character.unicodeScalars.first else { return false }
        return (48...57).contains(scalar.value)
    }

    /// CommonMark bound: an ordered marker is 1–9 ASCII digits. Counting in UTF16 units keeps
    /// the marker length exact; overlong runs are never read as a number.
    private static func orderedDigitsPrefix(_ characters: [Character]) -> Int {
        var index = 0
        while index < characters.count, index < 10, isASCIIDigit(characters[index]) { index += 1 }
        return index <= 9 ? index : 0
    }

    private static func stripListMarker(_ content: String) -> String {
        if content.hasPrefix("- [ ] ") || content.hasPrefix("- [x] ") || content.hasPrefix("- [X] ")
            || content.hasPrefix("* [ ] ") || content.hasPrefix("* [x] ") || content.hasPrefix("* [X] ")
            || content.hasPrefix("+ [ ] ") || content.hasPrefix("+ [x] ") || content.hasPrefix("+ [X] ") {
            return String(content.dropFirst(6))
        }
        if content.hasPrefix("- ") || content.hasPrefix("* ") || content.hasPrefix("+ ") {
            return String(content.dropFirst(2))
        }
        let characters = Array(content)
        let index = orderedDigitsPrefix(characters)
        if index > 0, index + 1 < characters.count,
           characters[index] == "." || characters[index] == ")",
           characters[index + 1] == " " {
            return String(characters[(index + 2)...])
        }
        return content
    }

    private static func isTask(_ content: String) -> Bool {
        content.hasPrefix("- [ ] ") || content.hasPrefix("- [x] ") || content.hasPrefix("- [X] ")
            || content.hasPrefix("* [ ] ") || content.hasPrefix("* [x] ") || content.hasPrefix("* [X] ")
            || content.hasPrefix("+ [ ] ") || content.hasPrefix("+ [x] ") || content.hasPrefix("+ [X] ")
    }

    private enum ListKind { case unordered, ordered, task }

    private static func listContent(_ content: String, kind: ListKind, ordinal: Int) -> String {
        guard !isBlank(content) else { return content }
        let (indent, rest) = leadingWhitespace(content)
        switch kind {
        case .unordered:
            if rest.hasPrefix("- ") || rest.hasPrefix("* ") || rest.hasPrefix("+ ") { return content }
            return indent + "- " + stripListMarker(rest)
        case .ordered:
            return indent + "\(ordinal). " + stripListMarker(rest)
        case .task:
            if isTask(rest) { return content }
            return indent + "- [ ] " + stripListMarker(rest)
        }
    }

    private static func stripQuote(_ content: String) -> String {
        let (indent, rest) = leadingWhitespace(content)
        if rest.hasPrefix("> ") { return indent + String(rest.dropFirst(2)) }
        if rest.hasPrefix(">") { return indent + String(rest.dropFirst(1)) }
        return content
    }

    private static func ensureQuote(_ content: String) -> String {
        let (indent, rest) = leadingWhitespace(content)
        if rest.hasPrefix(">") { return content }
        return indent + "> " + rest
    }

    private static func quoteEdit(_ all: [Line], _ selected: ClosedRange<Int>) -> MarkdownEdit {
        let nonblank = selected.filter { !isBlank(all[$0].content) }
        let allQuoted = !nonblank.isEmpty && nonblank.allSatisfy {
            leadingWhitespace(all[$0].content).rest.hasPrefix(">")
        }
        return lineEdit(all, selected, action: "Quote") { content, _ in
            if isBlank(content) { return content }
            return allQuoted ? stripQuote(content) : ensureQuote(content)
        }
    }

    private static func outdented(_ content: String) -> String {
        let characters = Array(content)
        if characters.first == "\t" { return String(characters.dropFirst()) }
        if characters.count >= 2, characters[0] == " ", characters[1] == " " {
            return String(characters.dropFirst(2))
        }
        if characters.first == " " { return String(characters.dropFirst()) }
        return content
    }

    // MARK: - Line movement

    private static func moveLines(_ all: [Line], _ selected: ClosedRange<Int>, up: Bool) -> MarkdownEdit? {
        let first = selected.lowerBound
        let last = selected.upperBound
        let affectedFirst: Int
        let affectedLast: Int
        let replacementLines: [Line]
        if up {
            guard first > 0 else { return nil }
            affectedFirst = first - 1
            affectedLast = last
            replacementLines = Array(all[first...last]) + [all[first - 1]]
        } else {
            guard last + 1 < all.count else { return nil }
            let next = all[last + 1]
            if next.start == next.end, next.content.isEmpty, next.ending.isEmpty,
               next.start == all[last].end {
                // The empty line after a final break is not a line to move past.
                return nil
            }
            affectedFirst = first
            affectedLast = last + 1
            replacementLines = [next] + Array(all[first...last])
        }
        let final = affectedLast == all.count - 1
        let replacement = join(replacementLines, documentFinal: final)
        let range = NSRange(
            location: all[affectedFirst].start,
            length: all[affectedLast].end - all[affectedFirst].start
        )
        let block = Array(all[first...last])
        var selection: NSRange
        if up {
            let rendered = join(block, documentFinal: false)
            selection = NSRange(location: range.location, length: rendered.utf16.count)
        } else {
            let above = join([all[last + 1]], documentFinal: false)
            let rendered = join(block, documentFinal: final)
            selection = NSRange(
                location: range.location + above.utf16.count,
                length: rendered.utf16.count
            )
        }
        return MarkdownEdit(range: range, replacement: replacement, selection: selection, actionName: up ? "Move Line Up" : "Move Line Down")
    }

    private static func duplicateLines(_ all: [Line], _ selected: ClosedRange<Int>) -> MarkdownEdit? {
        let first = selected.lowerBound
        let last = selected.upperBound
        let block = Array(all[first...last])
        let final = last == all.count - 1
        let firstCopy = join(block, documentFinal: false)
        let secondCopy = join(block, documentFinal: final)
        let range = NSRange(location: all[first].start, length: all[last].end - all[first].start)
        return MarkdownEdit(
            range: range,
            replacement: firstCopy + secondCopy,
            selection: NSRange(location: range.location + firstCopy.utf16.count, length: secondCopy.utf16.count),
            actionName: "Duplicate Line"
        )
    }

    // MARK: - Table and list continuation

    private static func tableEdit(_ all: [Line], _ text: NSString, _ selection: NSRange) -> MarkdownEdit? {
        let index = lineIndex(at: selection.location, in: all, textLength: text.length)
        let line = all[index]
        let ending = line.ending.isEmpty ? defaultEnding(all) : line.ending
        let atLineStart = selection.location == line.start
        let prefix = atLineStart ? "" : ending
        let table = "| Column 1 | Column 2 |\(ending)| --- | --- |\(ending)|  |  |"
        let replacement = prefix + table + ending
        let caret = selection.location + prefix.utf16.count + 2
        return MarkdownEdit(
            range: selection,
            replacement: replacement,
            selection: NSRange(location: caret, length: "Column 1".utf16.count),
            actionName: "Insert Table"
        )
    }

    private struct ListItem {
        var indent: String
        var marker: String
        var body: String
        var ordered: Bool
        var number: Int?
        var delimiter: Character?
        var bullet: Character
        var task: Bool
    }

    private static func listItem(_ content: String) -> ListItem? {
        let (indent, rest) = leadingWhitespace(content)
        let characters = Array(rest)
        guard let first = characters.first else { return nil }
        if first == "-" || first == "*" || first == "+" {
            guard characters.count >= 2, characters[1] == " " else { return nil }
            var index = 2
            var task = false
            if index + 2 < characters.count,
               characters[index] == "[",
               characters[index + 1] == " " || characters[index + 1] == "x" || characters[index + 1] == "X",
               characters[index + 2] == "]" {
                index += 3
                if index < characters.count, characters[index] == " " { index += 1 }
                task = true
            }
            return ListItem(
                indent: indent,
                marker: String(characters[0..<index]),
                body: String(characters[index...]),
                ordered: false,
                number: nil,
                delimiter: nil,
                bullet: first,
                task: task
            )
        }
        let index = orderedDigitsPrefix(characters)
        guard index > 0, index + 1 < characters.count,
           characters[index] == "." || characters[index] == ")",
           characters[index + 1] == " " else { return nil }
        // At most 9 ASCII digits, so this cannot overflow and is never nil for a parsed marker.
        let number = Int(String(characters[0..<index])) ?? 0
        let markerEnd = index + 2
        return ListItem(
            indent: indent,
            marker: String(characters[0..<markerEnd]),
            body: String(characters[markerEnd...]),
            ordered: true,
            number: number,
            delimiter: characters[index],
            bullet: "-",
            task: false
        )
    }

    private static func continueList(_ all: [Line], _ text: NSString, _ selection: NSRange) -> MarkdownEdit? {
        guard selection.length == 0 else { return nil }
        let index = lineIndex(at: selection.location, in: all, textLength: text.length)
        let line = all[index]
        guard let item = listItem(line.content) else { return nil }
        let markerStart = line.start + item.indent.utf16.count
        let markerEnd = markerStart + item.marker.utf16.count
        // A caret inside the marker or its indent is not a Return point; refusing keeps the
        // native insert-newline behaviour intact instead of mangling the marker.
        guard selection.location >= markerEnd else { return nil }
        if item.body.trimmingCharacters(in: .whitespaces).isEmpty {
            let contentEnd = line.start + line.content.utf16.count
            return MarkdownEdit(
                range: NSRange(location: markerStart, length: contentEnd - markerStart),
                replacement: "",
                selection: NSRange(location: markerStart, length: 0),
                actionName: "Finish List"
            )
        }
        let ending = line.ending.isEmpty ? defaultEnding(all) : line.ending
        let nextMarker: String
        if item.ordered {
            guard let number = item.number, number < 999_999_999 else { return nil }
            nextMarker = "\(number + 1)\(String(item.delimiter ?? ".")) "
        } else if item.task {
            nextMarker = String(item.bullet) + " [ ] "
        } else {
            nextMarker = String(item.bullet) + " "
        }
        let inserted = ending + item.indent + nextMarker
        return MarkdownEdit(
            range: selection,
            replacement: inserted,
            selection: NSRange(location: selection.location + inserted.utf16.count, length: 0),
            actionName: "Continue List"
        )
    }

    // MARK: - Literal replacement

    private static func replaceEdit(
        _ query: MarkdownLiteralQuery,
        _ replacement: String,
        _ text: NSString,
        all: Bool
    ) -> MarkdownEdit? {
        let limit = all ? replaceAllLimit : 1
        // One extra probe distinguishes "exactly at the bound" from "more matches than the
        // bound", so an over-bound document is refused rather than silently truncated.
        let found = matches(query, in: text as String, limit: all ? limit + 1 : limit)
        guard let first = found.first else { return nil }
        if !all {
            return MarkdownEdit(
                range: first.range,
                replacement: replacement,
                selection: NSRange(location: first.range.location + replacement.utf16.count, length: 0),
                actionName: "Replace"
            )
        }
        guard found.count <= replaceAllLimit, let last = found.last else { return nil }
        let range = NSRange(
            location: first.range.location,
            length: NSMaxRange(last.range) - first.range.location
        )
        var result = ""
        var cursor = range.location
        for match in found {
            let gap = NSRange(location: cursor, length: match.range.location - cursor)
            result += text.substring(with: gap)
            result += replacement
            cursor = NSMaxRange(match.range)
        }
        return MarkdownEdit(
            range: range,
            replacement: result,
            selection: NSRange(location: range.location + result.utf16.count, length: 0),
            actionName: "Replace All"
        )
    }

    private static let wordCharacters = CharacterSet.alphanumerics
        .union(CharacterSet(charactersIn: "_"))
        .union(.nonBaseCharacters)

    private static func isWord(_ text: String) -> Bool {
        !text.isEmpty && text.unicodeScalars.allSatisfy { wordCharacters.contains($0) }
    }

    private static func wholeWordRange(_ range: NSRange, _ wholeWord: Bool, _ text: NSString) -> Bool {
        guard wholeWord else { return true }
        if range.location > 0 {
            let previous = text.rangeOfComposedCharacterSequence(at: range.location - 1)
            if isWord(text.substring(with: previous)) { return false }
        }
        let end = NSMaxRange(range)
        if end < text.length {
            let next = text.rangeOfComposedCharacterSequence(at: end)
            if isWord(text.substring(with: next)) { return false }
        }
        return true
    }
}
