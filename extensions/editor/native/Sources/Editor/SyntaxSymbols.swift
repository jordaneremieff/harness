import Foundation

struct SyntaxSymbolCollector {
    private enum Scope { case type, function, block, interpolation }

    private struct Word {
        let text: String
        let token: SyntaxToken

        var name: Bool {
            guard token.role != .comment && token.role != .string && token.role != .regex && token.role != .raw,
                  let first = text.first else { return false }
            return first.isLetter || first == "_" || first == "$"
        }
    }

    private static let modifiers: Set<String> = ["abstract", "async", "extern", "final", "mutating", "override", "private", "protected", "public", "readonly", "static", "virtual", "get", "set", "declare"]
    private static let js = Set(["typescript", "tsx", "javascript", "jsx"])
    private static let nativeMethods = Set(["java", "csharp", "cpp", "c"])

    private(set) var symbols: [CodeSymbol] = []
    private var scopes: [Scope] = []
    private var pendingScope: Scope?
    private var pythonScopes: [(indent: Int, scope: Scope)] = []
    private var setext: CodeSymbol?

    mutating func consume(_ line: String, tokens: [SyntaxToken], offset: Int, number: Int, language: SyntaxLanguage) {
        if language.id == "markdown" {
            markdown(line, tokens: tokens, offset: offset, number: number)
            return
        }
        let source = line as NSString
        let words: [Word] = tokens.compactMap { token in
            guard token.role != .comment, token.role != .escape, token.role != .decorator else { return nil }
            let text = source.substring(with: NSRange(location: token.range.location - offset, length: token.range.length))
            return Word(text: text, token: token)
        }
        if language.id == "python" { python(line, words, number: number) }
        else if Self.declarations[language.id] != nil { code(words, number: number, id: language.id) }
    }

    private mutating func markdown(_ line: String, tokens: [SyntaxToken], offset: Int, number: Int) {
        let text = line.trimmingCharacters(in: .whitespaces)
        if var previous = setext {
            setext = nil
            if let marker = text.first, marker == "=" || marker == "-", text.allSatisfy({ $0 == marker }),
               tokens.first?.role == .punctuation {
                let level = marker == "=" ? 1 : 2
                previous.kind = .heading(level: level)
                previous.depth = level - 1
                symbols.append(previous)
                return
            }
        }
        guard tokens.first?.role == .heading else { return }
        let level = text.prefix(while: { $0 == "#" }).count
        let markerEnd = text.index(text.startIndex, offsetBy: level)
        if (1...6).contains(level), markerEnd == text.endIndex || text[markerEnd].isWhitespace {
            var title = String(text[markerEnd...]).trimmingCharacters(in: .whitespaces)
            let trail = title.reversed().prefix(while: { $0 == "#" }).count
            if trail > 0, let preceding = title.dropLast(trail).last, preceding.isWhitespace {
                title = String(title.dropLast(trail)).trimmingCharacters(in: .whitespaces)
            }
            let searchStart = line.utf16.count - line.drop(while: { $0 == " " }).utf16.count + level
            let search = NSRange(location: searchStart, length: line.utf16.count - searchStart)
            let local = (line as NSString).range(of: title, options: .literal, range: search)
            if !title.isEmpty && local.location != NSNotFound {
                symbols.append(CodeSymbol(name: title, kind: .heading(level: level), range: NSRange(location: offset + local.location, length: local.length), line: number, depth: level - 1))
            }
        } else if !text.isEmpty {
            let local = (line as NSString).range(of: text, options: .literal)
            setext = CodeSymbol(name: text, kind: .heading(level: 1), range: NSRange(location: offset + local.location, length: local.length), line: number, depth: 0)
        }
    }

    private mutating func python(_ line: String, _ words: [Word], number: Int) {
        guard let first = words.first, first.token.role != .string, first.token.role != .raw else { return }
        let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $1 == "\t" ? ($0 / 8 + 1) * 8 : $0 + 1 }
        while let last = pythonScopes.last, last.indent >= indent { pythonScopes.removeLast() }
        let keyword = first.text == "async" ? 1 : 0
        guard keyword + 1 < words.count, words[keyword + 1].name else { return }
        let name = words[keyword + 1]
        if words[keyword].text == "class" {
            append(name, kind: .class, number: number, depth: pythonScopes.count)
            pythonScopes.append((indent, .type))
        } else if words[keyword].text == "def" {
            append(name, kind: pythonScopes.last?.scope == .type ? .method : .function, number: number, depth: pythonScopes.count)
            pythonScopes.append((indent, .function))
        }
    }

    private mutating func code(_ words: [Word], number: Int, id: String) {
        guard let declarations = Self.declarations[id], !words.isEmpty else { return }
        var lastDeclaration = -1
        var memberPosition = true
        for i in words.indices {
            let word = words[i]
            let text = word.text
            if word.token.role == .punctuation {
                switch text {
                case "${": scopes.append(.interpolation)
                case "{":
                    scopes.append(pendingScope ?? .block)
                    pendingScope = nil
                    memberPosition = true
                case "}":
                    if !scopes.isEmpty { scopes.removeLast() }
                    pendingScope = nil
                    memberPosition = true
                case ";": pendingScope = nil; memberPosition = true
                default: break
                }
                continue
            }
            guard !scopes.contains(.interpolation), word.name, i > lastDeclaration else { continue }
            let depth = scopes.count
            let directMember = scopes.last == .type
            if let kind = declarations[text], word.token.role == .storage || word.token.role == .keyword {
                var nameIndex = i + 1
                if id == "go", text == "func", nameIndex < words.count, words[nameIndex].text == "(" {
                    nameIndex = (Self.closeParen(words, at: nameIndex) ?? i) + 1
                } else if text == "function", nameIndex < words.count, words[nameIndex].text == "*" {
                    nameIndex += 1
                }
                if id == "swift", ["init", "deinit", "subscript"].contains(text) { nameIndex = i }
                guard nameIndex < words.count, words[nameIndex].name else { continue }
                var actualKind = kind
                if id == "go", text == "type", nameIndex + 1 < words.count {
                    if words[nameIndex + 1].text == "struct" { actualKind = .struct; lastDeclaration = nameIndex + 1 }
                    if words[nameIndex + 1].text == "interface" { actualKind = .interface; lastDeclaration = nameIndex + 1 }
                }
                if Self.js.contains(id), kind == .constant || kind == .variable,
                   Self.assignedFunction(words, after: nameIndex) { actualKind = .function }
                if actualKind == .function, directMember || (id == "go" && nameIndex > i + 1) { actualKind = .method }
                append(words[nameIndex], kind: actualKind, number: number, depth: depth)
                lastDeclaration = max(lastDeclaration, nameIndex)
                pendingScope = Self.scope(for: actualKind)
                memberPosition = false
            } else if Self.js.contains(id), directMember, memberPosition, word.token.role != .keyword,
                      i + 1 < words.count, words[i + 1].text == "(" {
                append(word, kind: .method, number: number, depth: depth)
                pendingScope = .function
                memberPosition = false
            } else if Self.nativeMethods.contains(id), i > 0, i + 1 < words.count, words[i + 1].text == "(",
                      (words[i - 1].token.role == .type || words[i - 1].token.role == .storage),
                      scopes.last != .function {
                append(word, kind: directMember ? .method : .function, number: number, depth: depth)
                pendingScope = .function
                memberPosition = false
            } else if !Self.modifiers.contains(text) { memberPosition = false }
        }
    }

    private static func scope(for kind: CodeSymbol.Kind) -> Scope? {
        switch kind {
        case .class, .struct, .enum, .interface, .protocol, .extension, .module: .type
        case .function, .method: .function
        default: nil
        }
    }

    private static func closeParen(_ words: [Word], at start: Int) -> Int? {
        var nested = 0
        for i in start..<words.count {
            guard words[i].token.role == .punctuation else { continue }
            if words[i].text == "(" { nested += 1 }
            if words[i].text == ")" {
                nested -= 1
                if nested == 0 { return i }
            }
        }
        return nil
    }

    private static func assignedFunction(_ words: [Word], after name: Int) -> Bool {
        var i = name + 1
        guard i < words.count, words[i].text == "=" else { return false }
        i += 1
        if i < words.count, words[i].text == "async" { i += 1 }
        guard i < words.count else { return false }
        if words[i].text == "function" { return true }
        if words[i].text == "(" {
            guard let end = closeParen(words, at: i) else { return false }
            i = end
        } else if !words[i].name { return false }
        return i + 2 < words.count && words[i + 1].text == "=" && words[i + 2].text == ">"
    }

    private mutating func append(_ word: Word, kind: CodeSymbol.Kind, number: Int, depth: Int) {
        symbols.append(CodeSymbol(name: word.text, kind: kind, range: word.token.range, line: number, depth: depth))
    }

    private static let declarations: [String: [String: CodeSymbol.Kind]] = {
        let js: [String: CodeSymbol.Kind] = ["class": .class, "const": .constant, "enum": .enum, "function": .function, "interface": .interface, "let": .variable, "namespace": .module, "type": .type, "var": .variable]
        let c: [String: CodeSymbol.Kind] = ["class": .class, "enum": .enum, "interface": .interface, "namespace": .module, "record": .struct, "struct": .struct, "union": .struct]
        return [
            "typescript": js, "tsx": js, "javascript": js, "jsx": js,
            "swift": ["actor": .class, "class": .class, "deinit": .method, "enum": .enum, "extension": .extension, "func": .function, "init": .method, "let": .constant, "protocol": .protocol, "struct": .struct, "subscript": .method, "typealias": .type, "var": .variable],
            "rust": ["const": .constant, "enum": .enum, "fn": .function, "impl": .extension, "let": .variable, "mod": .module, "static": .variable, "struct": .struct, "trait": .interface, "type": .type, "union": .struct],
            "go": ["const": .constant, "func": .function, "package": .module, "type": .type, "var": .variable],
            "c": c, "cpp": c, "objc": c, "java": c, "csharp": c,
            "kotlin": ["class": .class, "fun": .function, "interface": .interface, "object": .class, "typealias": .type, "val": .constant, "var": .variable],
            "ruby": ["class": .class, "def": .function, "module": .module],
            "php": ["class": .class, "const": .constant, "enum": .enum, "function": .function, "interface": .interface, "namespace": .module, "trait": .interface],
            "lua": ["function": .function], "bash": ["function": .function], "zsh": ["function": .function], "fish": ["function": .function],
        ]
    }()
}
