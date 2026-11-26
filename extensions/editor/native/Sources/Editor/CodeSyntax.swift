import AppKit

@MainActor
final class CodeSyntax {
    private enum Token {
        case comment, literal, keyword, number, heading

        var colour: NSColor {
            switch self {
            case .comment: .secondaryLabelColor
            case .literal: .systemGreen
            case .keyword: .systemPurple
            case .number: .systemBlue
            case .heading: .systemTeal
            }
        }
    }

    private struct Rules {
        let pattern: NSRegularExpression
        let tokens: [Token]

        init(_ groups: [(String, Token)]) {
            pattern = try! NSRegularExpression(pattern: groups.map { "(\($0.0))" }.joined(separator: "|"))
            tokens = groups.map(\.1)
        }
    }

    private static let strings = #""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#
    private static let numbers = #"\b(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b"#

    private static func code(comment: String, words: String) -> Rules {
        Rules([(comment, .comment), (strings, .literal), (#"\b(?:"# + words + #")\b"#, .keyword), (numbers, .number)])
    }

    private static let slash = code(
        comment: #"//.*|/\*.*?(?:\*/|$)"#,
        words: "actor|as|async|await|bool|boolean|break|case|catch|char|class|const|continue|def|defer|default|do|double|else|enum|export|extends|extern|false|final|float|fn|for|func|function|guard|if|impl|import|in|int|interface|internal|let|long|match|mod|mut|namespace|new|nil|null|number|override|package|private|protected|protocol|pub|public|return|self|short|signed|static|struct|super|switch|template|this|throw|throws|trait|true|try|type|typedef|typeof|undefined|union|unsigned|use|using|var|void|while|yield"
    )
    private static let hash = code(
        comment: #"#.*"#,
        words: "and|as|async|await|begin|break|case|class|continue|def|do|elif|else|end|esac|except|export|False|false|fi|finally|for|from|function|if|import|in|is|lambda|let|local|match|module|nil|None|not|null|or|pass|raise|rescue|return|self|set|then|True|true|try|unless|until|while|with|yield"
    )
    private static let data = Rules([(#"#[^\n]*"#, .comment), (strings, .literal), (#"\b(?:true|false|null)\b"#, .keyword), (numbers, .number)])
    private static let json = Rules([(strings, .literal), (#"\b(?:true|false|null)\b"#, .keyword), (numbers, .number)])
    private static let markdown = Rules([(#"^\s{0,3}#{1,6}[ \t].*"#, .heading), (#"`+[^`]+`+"#, .literal), (#"\[[^\]]+\]\([^)]+\)"#, .keyword)])
    private static let markup = Rules([(#"<!--.*?(?:-->|$)"#, .comment), (#"</?[A-Za-z][\w:-]*|/?>"#, .keyword), (strings, .literal)])
    private static let sql = Rules([(#"--.*|/\*.*?(?:\*/|$)"#, .comment), (strings, .literal), (#"(?i:\b(?:alter|and|as|asc|between|by|case|create|delete|desc|distinct|drop|else|end|from|group|having|in|insert|into|join|limit|not|null|on|or|order|select|set|table|then|union|update|values|when|where|with)\b)"#, .keyword), (numbers, .number)])

    private var rules: Rules?
    private var styled = NSRange(location: 0, length: 0)
    private var invalidated = true

    func invalidate() { invalidated = true }

    func setFile(_ doc: String) {
        switch (doc as NSString).pathExtension.lowercased() {
        case "c", "cc", "cpp", "cs", "cxx", "go", "h", "hpp", "java", "js", "jsx", "kt", "m", "mjs", "mm", "mts", "rs", "swift", "ts", "tsx": rules = Self.slash
        case "bash", "fish", "pl", "py", "rb", "sh", "zsh": rules = Self.hash
        case "json": rules = Self.json
        case "toml", "yaml", "yml": rules = Self.data
        case "md", "markdown": rules = Self.markdown
        case "html", "svg", "xml": rules = Self.markup
        case "sql": rules = Self.sql
        default: rules = nil
        }
    }

    func highlight(rect: NSRect, in container: NSTextContainer, layout: NSLayoutManager, source: NSString) {
        let document = NSRange(location: 0, length: source.length)
        guard let rules, !rect.isEmpty, document.length > 0 else {
            let previous = NSIntersectionRange(styled, document)
            if previous.length > 0 { layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: previous) }
            styled = NSRange(location: 0, length: 0)
            return
        }
        let visibleGlyphs = layout.glyphRange(forBoundingRect: rect, in: container)
        guard visibleGlyphs.length > 0 else { return }
        let visible = layout.characterRange(forGlyphRange: visibleGlyphs, actualGlyphRange: nil)
        if !invalidated && NSIntersectionRange(visible, styled).length == visible.length { return }

        // Highlight only the viewport and its immediate surroundings. Temporary attributes
        // neither change the stored draft nor enter the text view's undo history.
        let nearbyGlyphs = layout.glyphRange(forBoundingRect: rect.insetBy(dx: 0, dy: -rect.height / 2), in: container)
        let nearby = NSIntersectionRange(layout.characterRange(forGlyphRange: nearbyGlyphs, actualGlyphRange: nil), document)
        guard nearby.length > 0 else { return }
        let range = source.lineRange(for: nearby)
        let previous = NSIntersectionRange(styled, document)
        styled = range
        invalidated = false
        if previous.length > 0 { layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: previous) }
        layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: range)

        var offset = range.location
        while offset < NSMaxRange(range) {
            let line = source.lineRange(for: NSRange(location: offset, length: 0))
            guard line.length > 0 else { break }
            if line.length <= 16_384 { highlightLine(line, in: source, layout: layout, using: rules) }
            offset = NSMaxRange(line)
        }
    }

    private func highlightLine(_ range: NSRange, in source: NSString, layout: NSLayoutManager, using rules: Rules) {
        let text = source.substring(with: range)
        rules.pattern.enumerateMatches(in: text, range: NSRange(location: 0, length: range.length)) { match, _, _ in
            guard let match else { return }
            for (offset, token) in rules.tokens.enumerated() {
                let tokenRange = match.range(at: offset + 1)
                if tokenRange.location != NSNotFound {
                    layout.addTemporaryAttribute(.foregroundColor, value: token.colour,
                                                 forCharacterRange: NSRange(location: range.location + tokenRange.location,
                                                                            length: tokenRange.length))
                    break
                }
            }
        }
    }
}
