import Foundation

struct SyntaxPair: Equatable, Sendable {
    let open: String
    let close: String

    init(_ open: String, _ close: String) {
        self.open = open
        self.close = close
    }
}

struct SyntaxLanguage: Sendable {
    let id: String
    let displayName: String
    let lineComment: String?
    let blockComment: SyntaxPair?
    let bracketPairs: [SyntaxPair]
    let autoClosePairs: [SyntaxPair]
    let wordCharacters: CharacterSet

    func increasesIndent(after line: String) -> Bool {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = text.last else { return false }
        switch id {
        case "python", "yaml": if last == ":" { return true }
        case "bash", "zsh", "fish", "ruby", "lua":
            let words = text.split(whereSeparator: \.isWhitespace)
            if let last = words.last, ["then", "do", "else", "begin", "repeat"].contains(last) { return true }
            if let first = words.first {
                switch id {
                case "fish": if ["if", "else", "while", "for", "switch", "case", "function"].contains(first) { return true }
                case "ruby": if ["if", "elsif", "unless", "def", "class", "module", "case", "when", "while", "until", "for"].contains(first) { return true }
                case "lua": if first == "function" { return true }
                default: if first == "case", words.last == "in" { return true }
                }
            }
        case "html", "xml", "svg":
            guard let start = text.lastIndex(of: "<"), last == ">" else { return false }
            let tag = text[text.index(after: start)...].prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == ":" }
            return !tag.isEmpty && !text.hasSuffix("/>") && (id != "html" || !Self.voidTags.contains(tag.lowercased()))
        default: break
        }
        return bracketPairs.contains { $0.open.last == last }
    }

    func decreasesIndent(before line: String) -> Bool {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if bracketPairs.contains(where: { text.hasPrefix($0.close) }) { return true }
        if ["html", "xml", "svg"].contains(id) { return text.hasPrefix("</") }
        let first = text.prefix { $0.isLetter }
        switch id {
        case "python": return ["elif", "else", "except", "finally"].contains(first)
        case "bash", "zsh": return ["elif", "else", "fi", "done", "esac"].contains(first)
        case "fish": return ["else", "case", "end"].contains(first)
        case "ruby": return ["elsif", "else", "when", "rescue", "ensure", "end"].contains(first)
        case "lua": return ["elseif", "else", "until", "end"].contains(first)
        default: return false
        }
    }

    private static let voidTags: Set<String> = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]
    private static let brackets = [SyntaxPair("(", ")"), SyntaxPair("[", "]"), SyntaxPair("{", "}")]
    private static let quotes = [SyntaxPair("\"", "\""), SyntaxPair("'", "'")]
    private static let backtick = SyntaxPair("`", "`")
    private static let slashBlock = SyntaxPair("/*", "*/")
    private static let markupBlock = SyntaxPair("<!--", "-->")

    private init(_ id: String, _ displayName: String, _ line: String? = nil, _ block: SyntaxPair? = nil,
                 pairs: [SyntaxPair] = brackets, quotes: [SyntaxPair] = quotes, extraWord: String = "") {
        self.id = id
        self.displayName = displayName
        lineComment = line
        blockComment = block
        bracketPairs = pairs
        autoClosePairs = pairs + quotes
        wordCharacters = CharacterSet.alphanumerics.union(.nonBaseCharacters)
            .union(CharacterSet(charactersIn: "_" + extraWord))
    }

    static let plain = SyntaxLanguage("plain", "Plain Text", pairs: [], quotes: [])

    static let languages = [
        plain, SyntaxLanguage("markdown", "Markdown", nil, markupBlock, quotes: [backtick]),
        SyntaxLanguage("typescript", "TypeScript", "//", slashBlock, quotes: quotes + [backtick], extraWord: "$"),
        SyntaxLanguage("tsx", "TypeScript JSX", "//", slashBlock, quotes: quotes + [backtick], extraWord: "$"),
        SyntaxLanguage("javascript", "JavaScript", "//", slashBlock, quotes: quotes + [backtick], extraWord: "$"),
        SyntaxLanguage("jsx", "JavaScript JSX", "//", slashBlock, quotes: quotes + [backtick], extraWord: "$"),
        SyntaxLanguage("swift", "Swift", "//", slashBlock, quotes: [quotes[0]], extraWord: "$"),
        SyntaxLanguage("python", "Python", "#"),
        SyntaxLanguage("bash", "Bash", "#", quotes: quotes + [backtick]), SyntaxLanguage("zsh", "Zsh", "#", quotes: quotes + [backtick]),
        SyntaxLanguage("fish", "Fish", "#"),
        SyntaxLanguage("json", "JSON", quotes: [quotes[0]]), SyntaxLanguage("jsonc", "JSON with Comments", "//", slashBlock, quotes: [quotes[0]]),
        SyntaxLanguage("yaml", "YAML", "#"), SyntaxLanguage("toml", "TOML", "#"), SyntaxLanguage("ini", "INI", ";"),
        SyntaxLanguage("dotenv", "Environment", "#"),
        SyntaxLanguage("css", "CSS", nil, slashBlock, extraWord: "-"), SyntaxLanguage("scss", "SCSS", "//", slashBlock, extraWord: "-$"),
        SyntaxLanguage("html", "HTML", nil, markupBlock, pairs: [SyntaxPair("<", ">")], extraWord: "-:"),
        SyntaxLanguage("xml", "XML", nil, markupBlock, pairs: [SyntaxPair("<", ">")], extraWord: "-:"),
        SyntaxLanguage("svg", "SVG", nil, markupBlock, pairs: [SyntaxPair("<", ">")], extraWord: "-:"),
        SyntaxLanguage("sql", "SQL", "--", slashBlock), SyntaxLanguage("rust", "Rust", "//", slashBlock),
        SyntaxLanguage("go", "Go", "//", slashBlock, quotes: quotes + [backtick]),
        SyntaxLanguage("c", "C", "//", slashBlock), SyntaxLanguage("cpp", "C++", "//", slashBlock),
        SyntaxLanguage("objc", "Objective-C", "//", slashBlock), SyntaxLanguage("java", "Java", "//", slashBlock),
        SyntaxLanguage("kotlin", "Kotlin", "//", slashBlock), SyntaxLanguage("csharp", "C#", "//", slashBlock),
        SyntaxLanguage("ruby", "Ruby", "#"), SyntaxLanguage("php", "PHP", "//", slashBlock, extraWord: "$"),
        SyntaxLanguage("lua", "Lua", "--", SyntaxPair("--[[", "]]")), SyntaxLanguage("dockerfile", "Dockerfile", "#"),
        SyntaxLanguage("makefile", "Makefile", "#"), SyntaxLanguage("diff", "Diff", pairs: [], quotes: []),
        SyntaxLanguage("git-commit", "Git Commit", "#", pairs: [], quotes: []),
    ]
    private static let byID = Dictionary(uniqueKeysWithValues: languages.map { ($0.id, $0) })
    private static let aliases: [String: String] = {
        let groups = [
            "markdown md markdown mdown mkd", "typescript ts mts cts", "tsx", "javascript js mjs cjs node", "jsx",
            "swift", "python py pyw pyi python2 python3 pypy pypy3", "bash sh bash dash ksh", "zsh", "fish", "json", "jsonc",
            "yaml yml", "toml", "ini cfg conf gitconfig", "dotenv env", "css", "scss sass", "html htm xhtml", "xml plist xsd xsl rss atom",
            "svg", "sql", "rust rs", "go golang", "c h", "cpp cc cxx c++ hh hpp hxx", "objc m mm objective-c", "java", "kotlin kt kts",
            "csharp cs c#", "ruby rb", "php phtml", "lua", "dockerfile", "makefile make mk", "diff patch", "git-commit gitcommit",
        ]
        return Dictionary(uniqueKeysWithValues: groups.flatMap { group -> [(String, String)] in
            let fields = group.split(separator: " ").map(String.init)
            return Set(fields).map { ($0, fields[0]) }
        })
    }()

    static func named(_ name: String) -> SyntaxLanguage? {
        let name = name.lowercased()
        return byID[aliases[name] ?? name]
    }

    static func detect(path: String, shebang: String? = nil) -> SyntaxLanguage {
        let file = (path as NSString).lastPathComponent.lowercased()
        let extensionName = (file as NSString).pathExtension
        if ["makefile", "gnumakefile", "bsdmakefile"].contains(file) { return byID["makefile"]! }
        if file == "dockerfile" || file == "containerfile" || file.hasPrefix("dockerfile.") || file.hasPrefix("containerfile.") {
            return byID["dockerfile"]!
        }
        if file == ".env" || file.hasPrefix(".env.") { return byID["dotenv"]! }
        if [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout"].contains(file) { return byID["zsh"]! }
        if [".bashrc", ".bash_profile", ".bash_logout", ".profile"].contains(file) { return byID["bash"]! }
        if ["commit_editmsg", "merge_msg", "tag_editmsg"].contains(file) { return byID["git-commit"]! }
        if [".gitconfig", ".editorconfig"].contains(file) { return byID["ini"]! }
        if [".eslintrc", ".babelrc", "tsconfig.json", "jsconfig.json"].contains(file) { return byID["jsonc"]! }
        if let language = named(extensionName) { return language }
        if let shebang, shebang.hasPrefix("#!") {
            let words = shebang.dropFirst(2).split(whereSeparator: \.isWhitespace)
            var interpreter = words.first.map { ($0 as NSString).lastPathComponent } ?? ""
            if interpreter == "env" {
                interpreter = words.dropFirst().first { !$0.hasPrefix("-") && !$0.contains("=") }.map(String.init) ?? ""
            }
            if interpreter.hasPrefix("python3.") { interpreter = "python3" }
            if ["deno", "bun", "nodejs"].contains(interpreter) { interpreter = "node" }
            if let language = named(interpreter) { return language }
        }
        return .plain
    }
}

enum SyntaxRole: UInt8, CaseIterable, Sendable {
    case plain, comment, string, escape, regex, number, constant, keyword, storage, type, function, property, parameter
    case `operator`, punctuation, tag, attribute, decorator, heading, emphasis, strong, link, raw, listMarker, quote
    case inserted, deleted, changedHeader, invalid
}

struct SyntaxToken: Equatable, Sendable {
    var range: NSRange
    var role: SyntaxRole
}

struct CodeSymbol: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case function, method, `class`, `struct`, `enum`, interface, `protocol`, type, `extension`, variable, constant, module
        case heading(level: Int)
    }

    var name: String
    var kind: Kind
    var range: NSRange
    var line: Int
    var depth: Int
}
