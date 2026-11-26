import Foundation

struct SyntaxMarkdown {
    private static let atx = try! NSRegularExpression(pattern: #"^[ ]{0,3}#{1,6}(?:[ \t]+|$)"#)
    private static let underline = try! NSRegularExpression(pattern: #"^[ ]{0,3}(?:=+|-+)[ \t]*$"#)
    private static let rule = try! NSRegularExpression(pattern: #"^[ ]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$"#)
    private static let tableRule = try! NSRegularExpression(pattern: #"^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$"#)
    private static let inline: [(String, SyntaxRole)] = [
        (##"\\[!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~]"##, .escape),
        (#"(?<!`)(`+)(?!`).+?(?<!`)\3(?!`)"#, .raw),
        (#"!?\[(?:[^\]\\]|\\.)*\](?:\((?:[^()\\]|\([^()]*\)|\\.)*\)|\[[^\]]*\])|<(?:(?:https?://|mailto:)[^ >]+|[^ <>@]+@[^ <>@]+)>"#, .link),
        (#"(?<!\*)\*\*(?=\S).+?(?<=\S)\*\*(?!\*)|(?<![\p{L}\p{N}_])__(?=\S).+?(?<=\S)__(?![\p{L}\p{N}_])"#, .strong),
        (#"(?<!\*)\*(?=\S).+?(?<=\S)\*(?!\*)|(?<![\p{L}\p{N}_])_(?=\S).+?(?<=\S)_(?![\p{L}\p{N}_])|~~(?=\S).+?(?<=\S)~~"#, .emphasis),
        (#"^[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t])|(?<=\s)\[[ xX]\](?=\s)"#, .listMarker),
        (#"^[ ]{0,3}(?:>[ \t]?)+"#, .quote),
        (#"\|"#, .punctuation),
    ]
    // The inline code alternative captures its backtick run in group three.
    private static let inlinePattern = try! NSRegularExpression(pattern: inline.map { "(\($0.0))" }.joined(separator: "|"))
    private static let inlineGroups = [1, 2, 4, 5, 6, 7, 8, 9]

    static func scan(_ text: String, offset: Int, nextLine: String?, state: SyntaxState, emit: Bool) -> (SyntaxState, [SyntaxToken]) {
        var state = state
        let line = NSRange(location: offset, length: text.utf16.count)
        func token(_ role: SyntaxRole) -> [SyntaxToken] {
            emit && line.length > 0 ? [SyntaxToken(range: line, role: role)] : []
        }
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        let fence = fenceInfo(text)
        switch state.markdown {
        case let .fence(marker, width, language):
            if let fence, fence.marker == marker, fence.width >= width, fence.tail.isEmpty {
                return (SyntaxState(), token(.raw))
            }
            if language == "plain" { return (state, token(.raw)) }
            var lexer = SyntaxLexer(text, offset: offset, profile: .profile(language), state: state, emit: emit)
            return lexer.run()
        case let .frontMatter(marker, language):
            if trimmed == marker || (marker == "---" && trimmed == "...") { return (SyntaxState(), token(.decorator)) }
            var lexer = SyntaxLexer(text, offset: offset, profile: .profile(language), state: state, emit: emit)
            return lexer.run()
        case .text: break
        }
        if !state.frames.isEmpty || trimmed.hasPrefix("<!--") {
            var lexer = SyntaxLexer(text, offset: offset, profile: .profile("html"), state: state, emit: emit)
            return lexer.run()
        }
        if offset == 0 && (trimmed == "---" || trimmed == "+++") {
            state.markdown = .frontMatter(marker: trimmed, language: trimmed == "---" ? "yaml" : "toml")
            return (state, token(.decorator))
        }
        if let fence, fence.marker != 96 || !fence.tail.contains("`") {
            let info = fence.tail.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
            let name = info.trimmingCharacters(in: CharacterSet(charactersIn: "{}."))
            let id = SyntaxLanguage.named(name)?.id ?? "plain"
            state.markdown = .fence(marker: fence.marker, width: fence.width, language: ["markdown", "git-commit"].contains(id) ? "plain" : id)
            return (state, token(.raw))
        }
        guard emit, !trimmed.isEmpty else { return (state, []) }
        if line.length > 16_384 { return (state, token(.raw)) }
        if matches(atx, text) { return (state, token(.heading)) }
        if matches(underline, text) { return (state, token(.punctuation)) }
        if matches(rule, text) || matches(tableRule, text) { return (state, token(.punctuation)) }
        if text.hasPrefix("\t") || text.hasPrefix("    ") { return (state, token(.raw)) }
        let fitsSetext = !trimmed.hasPrefix(">") && !trimmed.hasPrefix("- ") && !trimmed.hasPrefix("+ ") && !trimmed.hasPrefix("* ")
        if fitsSetext, let nextLine, matches(underline, nextLine) { return (state, token(.heading)) }
        let local = NSRange(location: 0, length: line.length)
        let tokens: [SyntaxToken] = inlinePattern.matches(in: text, range: local).compactMap { match in
            for (group, spec) in zip(inlineGroups, inline) {
                let part = match.range(at: group)
                if part.location != NSNotFound {
                    return SyntaxToken(range: NSRange(location: offset + part.location, length: part.length), role: spec.1)
                }
            }
            return nil
        }
        return (state, tokens)
    }

    private static func fenceInfo(_ text: String) -> (marker: UInt16, width: Int, tail: Substring)? {
        let indent = text.prefix(while: { $0 == " " }).count
        guard indent <= 3 else { return nil }
        let content = text.dropFirst(indent)
        guard let marker = content.first, marker == "`" || marker == "~" else { return nil }
        let width = content.prefix(while: { $0 == marker }).count
        guard width >= 3 else { return nil }
        let tail = content.dropFirst(width).drop(while: \.isWhitespace)
        return (marker == "`" ? 96 : 126, width, tail)
    }

    private static func matches(_ expression: NSRegularExpression, _ text: String) -> Bool {
        expression.firstMatch(in: text, range: NSRange(location: 0, length: text.utf16.count)) != nil
    }
}
