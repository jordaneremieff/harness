import AppKit

struct TextBracketMatch: Equatable {
    let offset: Int
    let mate: Int?
    let kind: String
}

extension CodeTextView {
    private var language: SyntaxLanguage { syntax.engine.language }

    var indentUnit: String { indentation.spaces ? String(repeating: " ", count: indentation.width) : "\t" }

    func indentString(_ width: Int) -> String {
        let width = max(0, width)
        if indentation.spaces { return String(repeating: " ", count: width) }
        return String(repeating: "\t", count: width / indentation.width) + String(repeating: " ", count: width % indentation.width)
    }

    func isSmartInput(_ text: String) -> Bool {
        guard text.utf16.count == 1 else { return false }
        let isCloser = language.bracketPairs.contains { $0.close == text }
        return (sourceSettings.autoIndent && isCloser) ||
            (sourceSettings.autoClosePairs && language.autoClosePairs.contains { $0.open == text || $0.close == text })
    }

    func typingEdit(_ text: String, replacing range: NSRange) -> TextEdit {
        let source = source
        let offset = range.location
        if sourceSettings.autoClosePairs {
            if range.length == 0, let closer = language.autoClosePairs.first(where: { $0.close == text }),
               has(closer.close, at: offset), closer.open != closer.close || !isEscaped(at: offset) {
                let length = closer.close.utf16.count
                return .caret(NSRange(location: offset, length: length), text)
            }
            if let pair = language.autoClosePairs.first(where: { $0.open == text }) {
                if range.length > 0 {
                    let selection = NSRange(location: text.utf16.count, length: range.length)
                    return TextEdit(range: range, replacement: text + source.substring(with: range) + pair.close, selection: selection)
                }
                if shouldClose(pair, at: offset) { return .caret(range, pair.open + pair.close, at: text.utf16.count) }
            }
        }
        if sourceSettings.autoIndent, range.length == 0, language.bracketPairs.contains(where: { $0.close == text }) {
            let line = line(at: offset)
            let indent = leadingIndent(on: line)
            let start = contents(of: line).location
            if indent.columns > 0, offset == start + indent.length {
                let data = bracketData.first { $0.pair.close == text }
                let opener = data.flatMap { findBracket($0, from: offset, direction: -1, limit: 8_192) }
                let width = opener.map { leadingIndent(on: self.line(at: $0)).columns } ?? max(0, indent.columns - indentation.width)
                if width < indent.columns {
                    return .caret(NSRange(location: start, length: indent.length), indentString(width) + text)
                }
            }
        }
        return .caret(range, text)
    }

    func pairedText(at offset: Int) -> NSRange? {
        for pair in language.autoClosePairs {
            let length = pair.open.utf16.count
            guard offset >= length, has(pair.open, at: offset - length), has(pair.close, at: offset) else { continue }
            if pair.open == pair.close, isEscaped(at: offset - length) { continue }
            return NSRange(location: offset - length, length: length + pair.close.utf16.count)
        }
        return nil
    }

    private func has(_ literal: String, at offset: Int) -> Bool {
        let length = literal.utf16.count
        guard length > 0, offset >= 0, offset <= source.length - length else { return false }
        return source.compare(literal, options: .literal, range: NSRange(location: offset, length: length)) == .orderedSame
    }

    private func isEscaped(at offset: Int) -> Bool {
        var back = offset
        while back > 0, source.character(at: back - 1) == 92 { back -= 1 }
        return (offset - back) % 2 != 0
    }

    private func shouldClose(_ pair: SyntaxPair, at offset: Int) -> Bool {
        let source = source
        guard !isEscaped(at: offset) else { return false }
        if offset < source.length {
            let next = source.character(at: offset)
            if ![9, 10, 32, 41, 44, 59, 62, 93, 125].contains(next) { return false }
        }
        let start = contents(of: line(at: offset)).location
        if offset > start {
            let role = syntax.engine.role(at: offset - 1)
            if role == .comment { return false }
            if pair.open == pair.close && (role == .string || role == .escape || role == .raw) { return false }
            if pair.open == pair.close, word(at: offset - 1).map({ NSMaxRange($0) == offset }) == true { return false }
        }
        return true
    }

    func newlineEdit(at range: NSRange) -> TextEdit {
        guard sourceSettings.autoIndent else { return .caret(range, "\n") }
        let row = line(at: range.location)
        let line = contents(of: row)
        let indent = leadingIndent(on: row)
        let start = range.location
        let end = NSMaxRange(range)
        let before = source.substring(with: NSRange(location: line.location, length: min(line.length, start - line.location)))
        let availableIndent = min(indent.length, start - line.location)
        let base = source.substring(with: NSRange(location: line.location, length: availableIndent))
        var extra = language.increasesIndent(after: before)
        if extra, offsetIsLiteral(before: start) { extra = false }
        let insert = "\n" + base + (extra ? indentUnit : "")
        if extra, range.length == 0, language.bracketPairs.contains(where: {
            before.trimmingCharacters(in: .whitespaces).hasSuffix($0.open) && has($0.close, at: end)
        }) {
            return .caret(range, insert + "\n" + base, at: insert.utf16.count)
        }
        return .caret(range, insert)
    }

    private func offsetIsLiteral(before offset: Int) -> Bool {
        guard offset > 0 else { return false }
        return isLiteral(syntax.engine.role(at: offset - 1))
    }

    private func isLiteral(_ role: SyntaxRole) -> Bool {
        role == .comment || role == .string || role == .raw || role == .regex || role == .escape || role == .quote
    }

    func tabEdit(at range: NSRange) -> TextEdit {
        if !indentation.spaces { return .caret(range, "\t") }
        let column = displayColumn(at: range.location)
        return .caret(range, String(repeating: " ", count: indentation.width - column % indentation.width))
    }

    func indentedPaste(_ text: String, at offset: Int) -> String {
        let lines = text.components(separatedBy: "\n")
        guard lines.count > 1 else { return text }
        func indentOf(_ line: String) -> (columns: Int, prefix: Int) {
            var columns = 0, count = 0
            for unit in line.utf16 {
                if unit == 32 { columns += 1 }
                else if unit == 9 { columns += indentation.width - columns % indentation.width }
                else { break }
                count += 1
            }
            return (columns, count)
        }
        let minimum = lines.lazy.map { ($0, indentOf($0)) }.filter { $0.1.prefix < $0.0.utf16.count }.map(\.1.columns).min() ?? 0
        let base = leadingIndent(on: line(at: offset)).columns
        return lines.enumerated().map { index, line in
            let data = indentOf(line)
            guard data.prefix < line.utf16.count else { return "" }
            return indentString((index == 0 ? 0 : base) + data.columns - minimum) + (line as NSString).substring(from: data.prefix)
        }.joined(separator: "\n")
    }

    private struct Bracket {
        let pair: SyntaxPair
        let open: UInt16
        let close: UInt16
        let kind: String
        var charset: CharacterSet { CharacterSet(charactersIn: pair.open + pair.close) }
    }

    private var bracketData: [Bracket] {
        language.bracketPairs.compactMap { pair in
            guard pair.open.utf16.count == 1, pair.close.utf16.count == 1,
                  let open = pair.open.utf16.first, let close = pair.close.utf16.first else { return nil }
            let kind = [40: "round", 91: "square", 123: "curly", 60: "angle"][Int(open)] ?? "tag"
            return Bracket(pair: pair, open: open, close: close, kind: kind)
        }
    }

    private func findBracket(_ bracket: Bracket, from offset: Int, direction: Int, limit: Int, viewport: Bool = false) -> Int? {
        let text = source
        let low = max(offset - limit, 0)
        let high = min(offset + limit, text.length)
        var cursor = direction > 0 ? offset + 1 : offset
        var depth = 0
        let increase = direction > 0 ? bracket.open : bracket.close
        while direction > 0 ? cursor < high : cursor > low {
            let forward = direction > 0
            let range = forward ? NSRange(location: cursor, length: high - cursor) : NSRange(location: low, length: cursor - low)
            let found = text.rangeOfCharacter(from: bracket.charset, options: forward ? .literal : [.literal, .backwards], range: range)
            guard found.location != NSNotFound else { return nil }
            cursor = forward ? NSMaxRange(found) : found.location
            let role = viewport ? syntax.engine.roleForView(at: found.location) : syntax.engine.role(at: found.location)
            guard !isLiteral(role) else { continue }
            if text.character(at: found.location) == increase { depth += 1 }
            else if depth == 0 { return found.location }
            else { depth -= 1 }
        }
        return nil
    }

    func adjacentBracket(around offset: Int, searchLimit: Int, viewport: Bool = false) -> TextBracketMatch? {
        let text = source
        let data = bracketData
        for here in [offset, offset - 1] where here >= 0 && here < text.length {
            let unit = text.character(at: here)
            guard let bracket = data.first(where: { $0.open == unit || $0.close == unit }) else { continue }
            let role = viewport ? syntax.engine.roleForView(at: here) : syntax.engine.role(at: here)
            guard !isLiteral(role) else { continue }
            if bracket.kind == "angle", let tag = adjacentTag(at: here, limit: searchLimit) { return tag }
            let mate = findBracket(bracket, from: here, direction: unit == bracket.open ? 1 : -1, limit: searchLimit, viewport: viewport)
            return TextBracketMatch(offset: here, mate: mate, kind: bracket.kind)
        }
        return nil
    }

    private func adjacentTag(at offset: Int, limit: Int) -> TextBracketMatch? {
        let text = source
        let low = max(0, offset - limit), high = min(text.length, offset + limit)
        let range = NSRange(location: low, length: high - low)
        let pattern = #"<(/?)([A-Za-z][\w:.-]*)(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*?)?\s*(/?)>"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let slice = text.substring(with: range) as NSString
        let tags = regex.matches(in: slice as String, range: NSRange(location: 0, length: slice.length))
        let relative = offset - low
        guard let current = tags.firstIndex(where: { $0.range.location == relative || NSMaxRange($0.range) - 1 == relative }) else { return nil }
        let tag = tags[current]
        let html = language.id == "html"
        func name(_ match: NSTextCheckingResult) -> String {
            let name = slice.substring(with: match.range(at: 2))
            return html ? name.lowercased() : name
        }
        let target = name(tag)
        let void = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]
        if tag.range(at: 3).length > 0 || (html && void.contains(target)) {
            let mate = relative == tag.range.location ? NSMaxRange(tag.range) - 1 : tag.range.location
            return TextBracketMatch(offset: offset, mate: low + mate, kind: "tag")
        }
        let opening = tag.range(at: 1).length == 0
        let direction = opening ? 1 : -1
        var index = current + direction, depth = 0
        while tags.indices.contains(index) {
            let previous = tags[index]
            if previous.range(at: 3).length == 0, name(previous) == target {
                if (previous.range(at: 1).length == 0) == opening { depth += 1 }
                else if depth == 0 {
                    return TextBracketMatch(offset: offset, mate: low + previous.range.location, kind: "tag")
                } else { depth -= 1 }
            }
            index += direction
        }
        return TextBracketMatch(offset: offset, mate: nil, kind: "tag")
    }

    func selectBrackets(jump: Bool) {
        let text = source
        let data = bracketData
        guard !data.isEmpty else { return }
        let chars = CharacterSet(charactersIn: data.map { $0.pair.open }.joined())
        let result = sourceSelections.map { selection -> NSRange in
            if let match = adjacentBracket(around: selection.location, searchLimit: text.length), let mate = match.mate, jump {
                return NSRange(location: mate, length: 0)
            }
            var cursor = min(text.length, selection.location + 1)
            while cursor > 0 {
                let candidate = text.rangeOfCharacter(from: chars, options: [.literal, .backwards], range: NSRange(location: 0, length: cursor))
                guard candidate.location != NSNotFound else { break }
                cursor = candidate.location
                guard let bracket = data.first(where: { $0.open == text.character(at: cursor) }),
                      !isLiteral(syntax.engine.role(at: cursor)),
                      let mate = findBracket(bracket, from: cursor, direction: 1, limit: text.length),
                      mate + 1 >= NSMaxRange(selection) else { continue }
                if jump { return NSRange(location: mate, length: 0) }
                let inside = NSRange(location: cursor + 1, length: mate - cursor - 1)
                let outside = NSRange(location: cursor, length: mate - cursor + 1)
                if selection != inside, selection != outside, selection.location >= inside.location,
                   NSMaxRange(selection) <= NSMaxRange(inside) { return inside }
                if selection != outside { return outside }
            }
            return selection
        }
        for selection in result { unfold(intersecting: selection) }
        select(result, reveal: result.last)
    }
}
