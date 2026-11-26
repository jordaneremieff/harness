import Foundation

struct SyntaxState: Equatable {
    enum Markdown: Equatable {
        case text
        case fence(marker: UInt16, width: Int, language: String)
        case frontMatter(marker: String, language: String)
    }

    var markdown: Markdown = .text
    var frames: [SyntaxFrame] = []
    var hereDocs: [SyntaxHereDoc] = []
    var yamlIndent: Int?
}

struct SyntaxHereDoc: Equatable {
    let end: String
    let stripTabs: Bool
    let expand: Bool
}

struct SyntaxString: Equatable {
    var end: [UInt16]
    var multiline = false
    var escape: [UInt16] = [92]
    var interpolation: [UInt16] = []
    var interpolationEnd: UInt16 = 125
    var doubledQuote = false
    var literalEscapes = false
    var doubledBraces = false
    var role: SyntaxRole = .string
}

enum SyntaxFrame: Equatable {
    case comment(end: [UInt16], nested: [UInt16], depth: Int)
    case string(SyntaxString)
    case interpolation(close: UInt16, depth: Int)
    case tag(jsx: Bool, closing: Bool, name: Bool)
    case jsx(depth: Int)
}

struct SyntaxLexer {
    // This recognises only complete, non-interpolated Swift lines. The stateful
    // scanner handles every line whose delimiters might survive a newline.
    private static let steadySwift = try! NSRegularExpression(pattern:
        ##"\A(?:[^/"#]++|/(?![*/])|"(?!"")(?:[^"\\]++|\\[^(])*")*(?://.*)?\z"##)

    static func swiftStateUnchanged(_ text: String) -> Bool {
        let length = text.utf16.count
        return length <= 16_384 && steadySwift.firstMatch(in: text, range: NSRange(location: 0, length: length)) != nil
    }

    let profile: SyntaxLexicon
    let text: String
    let offset: Int
    private let units: [UInt16]
    private let emit: Bool
    private var i = 0
    private var expectExpression = true
    private var priorWord = ""
    private var priorUnit: UInt16 = 0
    private var parameterDepth: Int?
    private var parenDepth = 0
    private var declaration = false
    private var tokens: [SyntaxToken] = []
    private var state: SyntaxState

    init(_ text: String, offset: Int, profile: SyntaxLexicon, state: SyntaxState, emit: Bool) {
        self.profile = profile
        self.text = text
        self.offset = offset
        self.state = state
        self.emit = emit
        units = Array(text.utf16)
    }

    mutating func run() -> (SyntaxState, [SyntaxToken]) {
        guard profile.language.id != "plain" else { return (state, []) }
        if profile.language.id == "diff" {
            let role: SyntaxRole = text.hasPrefix("@@") || text.hasPrefix("+++ ") || text.hasPrefix("--- ") ||
                text.hasPrefix("diff ") || text.hasPrefix("index ") ? .changedHeader :
                text.hasPrefix("+") ? .inserted : text.hasPrefix("-") ? .deleted : .plain
            add(0, units.count, role)
            return (state, tokens)
        }
        if profile.language.id == "git-commit" {
            add(0, units.count, text.hasPrefix("#") ? .comment : offset == 0 ? .heading : .plain)
            return (state, tokens)
        }
        if !state.hereDocs.isEmpty, state.frames.isEmpty {
            heredocBody(state.hereDocs[0])
            return (state, tokens)
        }
        if let indent = state.yamlIndent {
            let indentEnd = spaces(from: 0)
            if indentEnd == units.count || indentEnd > indent {
                add(0, units.count, .string)
                return (state, tokens)
            }
            state.yamlIndent = nil
        }
        while i < units.count {
            switch state.frames.last {
            case let .comment(end, nested, depth): comment(end: end, nested: nested, depth: depth)
            case let .string(spec): stringBody(spec)
            case let .tag(jsx, closing, name): tag(jsx: jsx, closing: closing, name: name)
            case let .jsx(depth): jsxText(depth: depth)
            case let .interpolation(close, depth) where unit(i) == close:
                if depth == 0 {
                    state.frames.removeLast()
                    add(i, i + 1, .punctuation)
                    i += 1
                } else {
                    state.frames[state.frames.count - 1] = .interpolation(close: close, depth: depth - 1)
                    code()
                }
            case let .interpolation(close, depth) where unit(i) == (close == 41 ? 40 : 123):
                state.frames[state.frames.count - 1] = .interpolation(close: close, depth: depth + 1)
                code()
            default:
                if profile.flags.contains(.markup) { markup() } else { code() }
            }
        }
        if let lineString = state.frames.firstIndex(where: { frame in
            if case let .string(spec) = frame { return !spec.multiline }
            return false
        }), units.last != 92 || units.dropLast().last == 92 {
            state.frames.removeSubrange(lineString...)
        }
        return (state, tokens)
    }

    private mutating func code() {
        let start = i
        let u = unit(i)
        let flags = profile.flags
        if Self.space(u) { i = spaces(from: i + 1); return }
        if !profile.commentOpen.isEmpty, match(profile.commentOpen, at: i) {
            let nested = flags.contains(.nestedComment) ? profile.commentOpen : []
            i += profile.commentOpen.count
            state.frames.append(.comment(end: profile.commentClose, nested: nested, depth: 1))
            comment(end: profile.commentClose, nested: nested, depth: 1, from: start)
            return
        }
        if isLineComment(u) {
            add(i, units.count, .comment)
            i = units.count
            return
        }
        if (i == 0 && offset == 0 && u == 35 && unit(i + 1) == 33) ||
            (flags.contains(.cFamily) && u == 35 && i == spaces(from: 0)) ||
            (flags.contains(.rust) && u == 35 && (unit(i + 1) == 91 || unit(i + 1) == 33)) {
            i = units.count
            add(start, i, .decorator)
            return
        }
        if flags.contains(.swift) && u == 35 {
            var end = i + 1
            while unit(end) == 35 { end += 1 }
            if unit(end) != 34 {
                if end == i + 1 && wordStart(unit(end)) {
                    end += 1
                    while wordPart(unit(end)) { end += 1 }
                    add(i, end, .decorator)
                }
                i = end
                return
            }
        }
        if let (spec, end) = stringStart(at: i) {
            i = end
            state.frames.append(.string(spec))
            expectExpression = false
            priorUnit = u
            priorWord = ""
            stringBody(spec, from: start)
            return
        }
        if flags.contains(.jsx), u == 60, expectExpression, unit(i + 1) == 62 || Self.letter(unit(i + 1)) {
            state.frames.append(.jsx(depth: 0))
            startTag(jsx: true)
            expectExpression = false
            return
        }
        if flags.contains(.js), u == 47, expectExpression, let end = regularExpression(from: i) {
            i = end
            add(start, i, .regex)
            expectExpression = false
            priorWord = ""
            return
        }
        if flags.contains(.shell), profile.language.id != "fish", u == 60, unit(i + 1) == 60,
           unit(i + 2) != 60, (i == 0 || unit(i - 1) != 60), let end = heredocStart() {
            i = end
            return
        }
        if u == 36 && flags.contains(.shell), let end = shellVariable(at: i) {
            i = end
            add(start, end, .property)
            return
        }
        if flags.contains(.yaml), (u == 124 || u == 62), i == spaces(from: 0) || priorUnit == 58 || priorUnit == 45 {
            i += 1
            while (49...57).contains(unit(i)) || unit(i) == 43 || unit(i) == 45 { i += 1 }
            let tail = unit(spaces(from: i))
            if tail == 0 || tail == 35 {
                add(start, i, .string)
                state.yamlIndent = spaces(from: 0)
                return
            }
            i = start
        }
        if flags.contains(.yaml), [33, 38, 42].contains(u), wordStart(unit(i + 1)) {
            i += 2
            while wordPart(unit(i)) { i += 1 }
            add(start, i, .decorator)
            return
        }
        if (profile.language.id == "toml" || profile.language.id == "ini"), u == 91, i == spaces(from: 0), priorUnit == 0 {
            var end = units.count
            while end > i && Self.space(unit(end - 1)) { end -= 1 }
            if unit(end - 1) == 93 {
                add(i, end, .heading)
                i = end
                return
            }
        }
        if u == 64 && flags.contains(.annotation) && wordStart(unit(i + 1)) {
            i += 2
            while wordPart(unit(i)) || unit(i) == 46 { i += 1 }
            add(start, i, .decorator)
            return
        }
        if flags.contains(.css), u == 35, Self.hex(unit(i + 1)) {
            i += 2
            while Self.hex(unit(i)) { i += 1 }
            if [4, 5, 7, 9].contains(i - start), !wordPart(unit(i)) {
                add(start, i, .number)
                return
            }
            i = start
        }
        if Self.digit(u) || (u == 46 && Self.digit(unit(i + 1))) {
            i = numberEnd(from: i)
            add(start, i, .number)
            expectExpression = false
            priorUnit = u
            priorWord = ""
            return
        }
        if wordStart(u) {
            i += 1
            while wordPart(unit(i)) { i += 1 }
            word(start: start, end: i, next: unit(spaces(from: i)))
            priorUnit = u
            return
        }
        i += 1
        if u == 40 {
            parenDepth += 1
            if declaration && parameterDepth == nil { parameterDepth = parenDepth; declaration = false }
        } else if u == 41 {
            if parameterDepth == parenDepth { parameterDepth = nil }
            parenDepth -= 1
        }
        if u == 123 || u == 61 || u == 59 { declaration = false }
        let role: SyntaxRole
        switch u {
        case 40, 41, 44, 46, 58, 59, 91, 93, 123, 125: role = .punctuation
        case 33, 37, 38, 42, 43, 45, 47, 60, 61, 62, 63, 94, 124, 126: role = .operator
        default: role = flags.contains(.json) ? .invalid : .plain
        }
        add(start, i, role)
        if flags.contains(.js) {
            // Postfix ++ and -- end an expression just as their operand does.
            if (u == 43 || u == 45) && unit(i) == u {
                add(i, i + 1, .operator)
                i += 1
            } else { expectExpression = u != 41 && u != 93 && u != 125 && u != 46 }
        }
        priorUnit = u
        priorWord = ""
    }

    private mutating func word(start: Int, end: Int, next: UInt16) {
        guard emit || profile.flags.contains(.js) else { return }
        var word = slice(start, end)
        if profile.flags.contains(.sql) || profile.language.id == "dockerfile" { word = word.lowercased() }
        let role: SyntaxRole
        if profile.constants.contains(word) { role = .constant }
        else if profile.storage.contains(word) { role = .storage }
        else if profile.keywords.contains(word) { role = .keyword }
        else if profile.flags.contains(.data) && (next == 58 || next == 61 && !profile.flags.contains(.json)) { role = .property }
        else if profile.flags.contains(.css) && next == 58 { role = .property }
        else if profile.flags.contains(.rust) && next == 33 && unit(end) == 33 { role = .decorator }
        else if profile.types.contains(word) { role = .type }
        else if profile.flags.contains(.json) { role = .invalid }
        else if priorUnit == 46 { role = next == 40 ? .function : .property }
        else if Self.functionWords.contains(priorWord) || (next == 40 && parameterDepth == nil && !profile.flags.contains(.data)) { role = .function }
        else if Self.typeWords.contains(priorWord) { role = .type }
        else if parameterDepth == parenDepth && (priorUnit == 40 || priorUnit == 44 || Self.letter(priorUnit)) &&
                    (next == 58 || next == 44 || next == 41 || next == 61 || Self.letter(next)) { role = .parameter }
        else if profile.flags.contains(.js) && next == 58 && priorUnit != 63 { role = .property }
        else if (65...90).contains(unit(start)) && profile.flags.contains(.swift) { role = .type }
        else { role = .plain }
        if Self.functionWords.contains(word) || (profile.flags.contains(.swift) && word == "init") { declaration = true }
        if profile.flags.contains(.js) { expectExpression = Self.expressionWords.contains(word) }
        priorWord = word
        add(start, end, role)
    }

    private static let functionWords: Set<String> = ["func", "function", "fn", "def", "fun", "procedure"]
    private static let typeWords: Set<String> = ["actor", "class", "enum", "interface", "protocol", "record", "struct", "trait", "type", "typealias", "extension", "new"]
    private static let expressionWords: Set<String> = ["case", "delete", "do", "else", "in", "instanceof", "of", "return", "throw", "typeof", "void", "yield", "await"]

    private mutating func comment(end: [UInt16], nested: [UInt16], depth: Int, from start: Int? = nil) {
        let start = start ?? i
        var depth = depth
        while i < units.count {
            if match(end, at: i) {
                depth -= 1
                i += end.count
                if depth == 0 { state.frames.removeLast(); break }
            } else if !nested.isEmpty && match(nested, at: i) {
                depth += 1
                i += nested.count
            } else { i += 1 }
        }
        if depth > 0 { state.frames[state.frames.count - 1] = .comment(end: end, nested: nested, depth: depth) }
        add(start, i, .comment)
    }

    private func isLineComment(_ u: UInt16) -> Bool {
        if profile.language.id == "ini", u == 35, i == spaces(from: 0) { return true }
        if profile.language.id == "php", u == 35, unit(i + 1) != 91 { return true }
        guard !profile.lineComment.isEmpty, match(profile.lineComment, at: i) else { return false }
        if profile.flags.contains(.shell), i > 0 { return Self.space(unit(i - 1)) || [59, 124, 38, 40, 41].contains(unit(i - 1)) }
        if profile.flags.contains(.yaml), i > 0 { return Self.space(unit(i - 1)) || [91, 123, 44].contains(unit(i - 1)) }
        return true
    }

    private func stringStart(at begin: Int) -> (SyntaxString, Int)? {
        let flags = profile.flags
        var i = begin
        var u = unit(i)
        if u == 96 && (flags.contains(.js) || flags.contains(.backtick)) {
            return (SyntaxString(end: [96], multiline: true,
                                 escape: profile.language.id == "go" ? [] : [92], interpolation: flags.contains(.js) ? [36, 123] : []), i + 1)
        }
        var rawCount = 0
        if flags.contains(.swift), u == 35 {
            while unit(i) == 35 { i += 1 }
            rawCount = i - begin
            u = unit(i)
        } else if flags.contains(.rust), u == 114 || u == 98 {
            if u == 98 && unit(i + 1) == 114 { i += 1; u = 114 }
            if u == 114 {
                i += 1
                let hashes = i
                while unit(i) == 35 { i += 1 }
                guard unit(i) == 34 else { return nil }
                return (SyntaxString(end: [34] + Array(repeating: 35, count: i - hashes), multiline: true, escape: []), i + 1)
            }
            i += 1
            u = unit(i)
        }
        var format = false
        var rawPython = false
        if flags.contains(.python), !profile.quoteMarks.contains(u) {
            var prefix: [UInt16] = []
            while prefix.count < 2, [98, 102, 114, 117, 116].contains(unit(i) | 32) {
                prefix.append(unit(i) | 32)
                i += 1
            }
            guard !prefix.isEmpty, Set(prefix).count == prefix.count,
                  prefix.count == 1 || prefix.contains(114) && !prefix.contains(117) else { return nil }
            format = prefix.contains(102) || prefix.contains(116)
            rawPython = prefix.contains(114)
            u = unit(i)
        }
        if profile.language.id == "csharp", u == 64, unit(i + 1) == 34 {
            return (SyntaxString(end: [34], multiline: true, escape: [], doubledQuote: true), i + 2)
        }
        guard profile.quoteMarks.contains(u) else { return nil }
        if flags.contains(.rust), u == 39 && Self.letter(unit(i + 1)) && unit(i + 2) != 39 { return nil }
        let triple = flags.contains(.triple) && unit(i + 1) == u && unit(i + 2) == u
        let open = Array(repeating: u, count: triple ? 3 : 1)
        let hashes = Array(repeating: UInt16(35), count: rawCount)
        let doubled = flags.contains(.sql) || flags.contains(.yaml) && u == 39
        let escaped = flags.contains(.toml) && u == 39 || flags.contains(.yaml) && u == 39 ||
            flags.contains(.shell) && u == 39 || flags.contains(.sql) ? [] : [UInt16(92)] + hashes
        let interpolation: [UInt16] = flags.contains(.swift) ? escaped + [40] : format ? [123] : []
        return (SyntaxString(end: open + hashes, multiline: triple || flags.contains(.shell) || flags.contains(.yaml) || flags.contains(.sql) || flags.contains(.rust),
                             escape: escaped, interpolation: interpolation, interpolationEnd: flags.contains(.swift) ? 41 : 125,
                             doubledQuote: doubled, literalEscapes: rawPython, doubledBraces: format), i + open.count)
    }

    private mutating func stringBody(_ spec: SyntaxString, from start: Int? = nil) {
        var paint = start ?? i
        while i < units.count {
            if match(spec.end, at: i) {
                i += spec.end.count
                if spec.doubledQuote, match(spec.end, at: i) { i += spec.end.count; continue }
                state.frames.removeLast()
                break
            }
            if spec.doubledBraces && (unit(i) == 123 || unit(i) == 125) && unit(i + 1) == unit(i) { i += 2; continue }
            if !spec.interpolation.isEmpty && match(spec.interpolation, at: i) {
                add(paint, i, spec.role)
                add(i, i + spec.interpolation.count, .punctuation)
                i += spec.interpolation.count
                state.frames.append(.interpolation(close: spec.interpolationEnd, depth: 0))
                expectExpression = true
                return
            }
            if !spec.escape.isEmpty && match(spec.escape, at: i) {
                if spec.literalEscapes { i += spec.escape.count + 1; continue }
                add(paint, i, spec.role)
                let end = escapeEnd(at: i + spec.escape.count)
                add(i, end, .escape)
                i = end
                paint = i
            } else if profile.flags.contains(.shell), spec.end == [34], unit(i) == 36, let end = shellVariable(at: i) {
                add(paint, i, spec.role)
                add(i, end, .property)
                i = end
                paint = i
            } else { i += 1 }
        }
        add(paint, min(i, units.count), spec.role)
    }

    private func escapeEnd(at start: Int) -> Int {
        var end = start + 1
        let u = unit(start)
        if u == 117 && unit(end) == 123 {
            end += 1
            while Self.hex(unit(end)) { end += 1 }
            if unit(end) == 125 { end += 1 }
        } else if u == 117 || u == 85 || u == 120 {
            let digits = u == 117 ? 4 : u == 85 ? 8 : 2
            while end < start + 1 + digits && Self.hex(unit(end)) { end += 1 }
        } else if (0xD800...0xDBFF).contains(u), (0xDC00...0xDFFF).contains(unit(end)) { end += 1 }
        return min(end, units.count)
    }

    private func regularExpression(from start: Int) -> Int? {
        var end = start + 1
        var inClass = false
        while end < units.count {
            switch unit(end) {
            case 92: end += 2; continue
            case 91: inClass = true
            case 93: inClass = false
            case 47 where !inClass:
                end += 1
                while Self.letter(unit(end)) { end += 1 }
                return end
            default: break
            }
            end += 1
        }
        return nil
    }

    private func numberEnd(from start: Int) -> Int {
        var end = start
        if unit(start) == 48 {
            let base = unit(start + 1) | 32
            if base == 120 || base == 111 || base == 98 {
                end += 2
                while unit(end) == 95 || (base == 120 ? Self.hex(unit(end)) : base == 111 ? (48...55).contains(unit(end)) : (48...49).contains(unit(end))) { end += 1 }
                if profile.flags.contains(.js), unit(end) == 110 { end += 1 }
                return end
            }
        }
        while Self.digit(unit(end)) || unit(end) == 95 { end += 1 }
        if unit(end) == 46, Self.digit(unit(end + 1)) || end == start {
            end += 1
            while Self.digit(unit(end)) || unit(end) == 95 { end += 1 }
        }
        if (unit(end) | 32) == 101 {
            var exponent = end + 1
            if unit(exponent) == 43 || unit(exponent) == 45 { exponent += 1 }
            if Self.digit(unit(exponent)) {
                repeat { exponent += 1 } while Self.digit(unit(exponent)) || unit(exponent) == 95
                end = exponent
            }
        }
        if profile.flags.contains(.js), unit(end) == 110 { end += 1 }
        if profile.flags.contains(.python), (unit(end) | 32) == 106 { end += 1 }
        if profile.flags.contains(.css) { while Self.letter(unit(end)) || unit(end) == 37 { end += 1 } }
        return end
    }

    private mutating func heredocStart() -> Int? {
        let strip = unit(i + 2) == 45
        let word = spaces(from: i + (strip ? 3 : 2))
        var end = word
        var delimiter: [UInt16] = []
        var quote: UInt16 = 0
        var expand = true
        while end < units.count {
            let u = unit(end)
            if quote != 0 {
                if u == quote { quote = 0 } else { delimiter.append(u) }
            } else if u == 34 || u == 39 {
                quote = u
                expand = false
            } else if u == 92, end + 1 < units.count {
                end += 1
                delimiter.append(unit(end))
                expand = false
            } else if Self.space(u) || [38, 40, 41, 59, 60, 62, 124].contains(u) { break }
            else { delimiter.append(u) }
            end += 1
        }
        guard end > word, quote == 0 else { return nil }
        state.hereDocs.append(SyntaxHereDoc(end: String(decoding: delimiter, as: UTF16.self), stripTabs: strip, expand: expand))
        add(i, i + (strip ? 3 : 2), .operator)
        add(word, end, .string)
        return end
    }

    private mutating func heredocBody(_ doc: SyntaxHereDoc) {
        var start = 0
        if doc.stripTabs { while unit(start) == 9 { start += 1 } }
        if text.utf16.dropFirst(start).elementsEqual(doc.end.utf16) {
            add(start, units.count, .string)
            state.hereDocs.removeFirst()
        } else if !doc.expand || !emit { add(0, units.count, .string) }
        else {
            var paint = 0
            var cursor = 0
            while cursor < units.count {
                if unit(cursor) == 92 { cursor += 2; continue }
                if unit(cursor) == 36, let end = shellVariable(at: cursor) {
                    add(paint, cursor, .string)
                    add(cursor, end, .property)
                    cursor = end
                    paint = cursor
                } else { cursor += 1 }
            }
            add(paint, units.count, .string)
        }
    }

    private func shellVariable(at start: Int) -> Int? {
        var end = start + 1
        if unit(end) == 123 {
            end += 1
            while end < units.count, unit(end) != 125 { end += 1 }
            return end < units.count ? end + 1 : end
        }
        guard wordStart(unit(end)) || Self.digit(unit(end)) || [33, 35, 36, 42, 45, 63, 64].contains(unit(end)) else { return nil }
        end += 1
        while wordPart(unit(end)) && unit(end) != 45 { end += 1 }
        return end
    }

    private mutating func markup() {
        if match([60, 33, 45, 45], at: i) {
            let start = i
            i += 4
            state.frames.append(.comment(end: [45, 45, 62], nested: [], depth: 1))
            comment(end: [45, 45, 62], nested: [], depth: 1, from: start)
        } else if match([60, 33, 91, 67, 68, 65, 84, 65, 91], at: i) {
            let start = i
            i += 9
            let spec = SyntaxString(end: [93, 93, 62], multiline: true, escape: [], role: .raw)
            state.frames.append(.string(spec))
            stringBody(spec, from: start)
        } else if unit(i) == 60 && (Self.letter(unit(i + 1)) || [33, 47, 63].contains(unit(i + 1))) { startTag(jsx: false) }
        else if unit(i) == 38, let end = entityEnd(at: i) { add(i, end, .escape); i = end }
        else { i += 1 }
    }

    private mutating func startTag(jsx: Bool) {
        let start = i
        i += 1
        let closing = unit(i) == 47
        if closing || unit(i) == 33 || unit(i) == 63 { i += 1 }
        add(start, i, .punctuation)
        state.frames.append(.tag(jsx: jsx, closing: closing, name: true))
    }

    private mutating func tag(jsx: Bool, closing: Bool, name: Bool) {
        let start = i
        let u = unit(i)
        if Self.space(u) { i = spaces(from: i + 1); return }
        let selfClose = u == 47 && unit(i + 1) == 62
        if selfClose || u == 62 || (u == 63 && unit(i + 1) == 62) {
            i += u == 62 ? 1 : 2
            add(start, i, .punctuation)
            state.frames.removeLast()
            if jsx, case let .jsx(depth) = state.frames.last {
                let next = depth + (selfClose ? 0 : closing ? -1 : 1)
                if next <= 0 { state.frames.removeLast(); expectExpression = false }
                else { state.frames[state.frames.count - 1] = .jsx(depth: next) }
            }
        } else if u == 34 || u == 39 {
            let spec = SyntaxString(end: [u], multiline: true, escape: [])
            state.frames.append(.string(spec))
            i += 1
            stringBody(spec, from: start)
        } else if u == 123 && jsx {
            state.frames.append(.interpolation(close: 125, depth: 0))
            add(i, i + 1, .punctuation)
            i += 1
            expectExpression = true
        } else if markupWord(u) {
            i += 1
            while markupWord(unit(i)) { i += 1 }
            add(start, i, name ? .tag : .attribute)
            if name { state.frames[state.frames.count - 1] = .tag(jsx: jsx, closing: closing, name: false) }
        } else {
            i += 1
            add(start, i, .punctuation)
        }
    }

    private mutating func jsxText(depth _: Int) {
        if unit(i) == 60 && (Self.letter(unit(i + 1)) || [47, 62].contains(unit(i + 1))) { startTag(jsx: true) }
        else if unit(i) == 123 {
            state.frames.append(.interpolation(close: 125, depth: 0))
            add(i, i + 1, .punctuation)
            i += 1
            expectExpression = true
        } else if unit(i) == 38, let end = entityEnd(at: i) { add(i, end, .escape); i = end }
        else { i += 1 }
    }

    private func entityEnd(at start: Int) -> Int? {
        var end = start + 1
        if unit(end) == 35 { end += 1 }
        while Self.letter(unit(end)) || Self.digit(unit(end)) { end += 1 }
        return end > start + 1 && unit(end) == 59 ? end + 1 : nil
    }

    @inline(__always) private func unit(_ index: Int) -> UInt16 { index < units.count ? units[index] : 0 }
    @inline(__always) private static func digit(_ u: UInt16) -> Bool { (48...57).contains(u) }
    @inline(__always) private static func hex(_ u: UInt16) -> Bool { digit(u) || (97...102).contains(u | 32) }
    @inline(__always) private static func letter(_ u: UInt16) -> Bool { (97...122).contains(u | 32) || u >= 0x80 }
    @inline(__always) private static func space(_ u: UInt16) -> Bool { u == 32 || u == 9 || u == 0xFEFF }
    @inline(__always) private func wordStart(_ u: UInt16) -> Bool {
        Self.letter(u) || u == 95 || u == 36 && profile.flags.contains(.dollarWord) || u == 45 && profile.flags.contains(.dashWord) && !profile.flags.contains(.yaml)
    }
    @inline(__always) private func wordPart(_ u: UInt16) -> Bool { wordStart(u) || Self.digit(u) || u == 45 && profile.flags.contains(.yaml) }
    @inline(__always) private func markupWord(_ u: UInt16) -> Bool { Self.letter(u) || Self.digit(u) || u == 45 || u == 58 || u == 95 || u == 46 }

    @inline(__always) private func match(_ marker: [UInt16], at index: Int) -> Bool {
        guard index + marker.count <= units.count else { return false }
        for j in marker.indices where units[index + j] != marker[j] { return false }
        return true
    }

    @inline(__always) private func spaces(from start: Int) -> Int {
        var end = start
        while Self.space(unit(end)) { end += 1 }
        return end
    }

    private func slice(_ start: Int, _ end: Int) -> String { String(decoding: units[start..<end], as: UTF16.self) }

    private mutating func add(_ start: Int, _ end: Int, _ role: SyntaxRole) {
        if emit, end > start {
            tokens.append(SyntaxToken(range: NSRange(location: offset + start, length: end - start), role: role))
        }
    }
}
