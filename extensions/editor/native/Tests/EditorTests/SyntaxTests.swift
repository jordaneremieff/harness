import AppKit
import Testing
@testable import Editor

@MainActor
struct SyntaxTests {
    private func document(_ text: String, _ path: String) -> (SyntaxEngine, NSTextStorage) {
        let storage = NSTextStorage(string: text)
        return (SyntaxEngine(path: path, storage: storage), storage)
    }

    private func range(_ word: String, in storage: NSTextStorage, options: NSString.CompareOptions = []) -> NSRange {
        storage.mutableString.range(of: word, options: options)
    }

    @Test func detectsFilesAndShebangsAndSuppliesEditingRules() {
        let paths = ["/src/a.d.ts": "typescript", "a.TSX": "tsx", "a.mjs": "javascript", "a.jsonc": "jsonc", "a.yml": "yaml",
                     "a.toml": "toml", "a.ini": "ini", "a.scss": "scss", "a.svg": "svg", "a.sql": "sql", "a.rs": "rust",
                     "a.go": "go", "a.cpp": "cpp", "a.mm": "objc", "a.kt": "kotlin", "a.cs": "csharp", "a.rb": "ruby", "a.php": "php",
                     "a.lua": "lua", "a.patch": "diff", "Dockerfile.prod": "dockerfile", "GNUmakefile": "makefile", ".env.local": "dotenv",
                     "dotfiles/.zshrc": "zsh", ".git/COMMIT_EDITMSG": "git-commit", "memo": "plain"]
        for (path, id) in paths { #expect(SyntaxLanguage.detect(path: path).id == id) }
        let (engine, storage) = document("#!/usr/bin/env -S python3.13 -u\nprint('yes')\n", "script")
        #expect(engine.language.id == "python")
        #expect(engine.language.lineComment == "#")
        #expect(engine.language.increasesIndent(after: "if ready:"))
        #expect(engine.language.decreasesIndent(before: "else:"))
        #expect(engine.language.autoClosePairs.contains(SyntaxPair("[", "]")))
        storage.replaceCharacters(in: range("/usr/bin/env -S python3.13 -u", in: storage), with: "/bin/zsh")
        #expect(engine.language.id == "zsh")
        engine.setFile("script.swift")
        #expect(engine.language.id == "swift")
        #expect(engine.language.blockComment == SyntaxPair("/*", "*/"))
        #expect(engine.language.increasesIndent(after: "func hello() {"))
        #expect(engine.language.decreasesIndent(before: "} else {"))
    }

    @Test func convergesAfterAnEditWithoutScanningTheCachedTail() {
        let text = "/* open\ncontinued\n*/\nlet body = \"\"\"\ninside\n\"\"\"\n" + String(repeating: "let tail = 2\n", count: 800)
        let (engine, storage) = document(text, "code.swift")
        #expect(engine.visitedLineCount == 0)
        let tail = range("tail", in: storage, options: .backwards)
        #expect(engine.role(at: tail.location - 4) == .storage)
        #expect(engine.role(at: range("continued", in: storage).location) == .comment)
        #expect(engine.role(at: range("inside", in: storage).location) == .string)
        let scanned = engine.visitedLineCount
        storage.replaceCharacters(in: range("continued", in: storage), with: "changed\nand added")
        #expect(engine.role(at: range("and added", in: storage).location) == .comment)
        #expect(engine.role(at: range("tail", in: storage, options: .backwards).location - 4) == .storage)
        #expect(engine.visitedLineCount - scanned < 10)
        storage.replaceCharacters(in: range("\"\"\"", in: storage), with: "\"\"\"")
        #expect(engine.role(at: range("inside", in: storage).location) == .string)
    }

    @Test func recomputesAnOpenCommentOnlyUpToTheRequestedLine() {
        let (engine, storage) = document(String(repeating: "let name = 42\n", count: 900), "code.swift")
        let tail = range("42", in: storage, options: .backwards)
        #expect(engine.role(at: tail.location) == .number)
        let before = engine.visitedLineCount
        storage.replaceCharacters(in: NSRange(location: 0, length: 0), with: "/*\n")
        #expect(engine.visitedLineCount == before)
        #expect(engine.role(at: 5) == .comment)
        #expect(engine.visitedLineCount - before < 5)
        #expect(engine.role(at: tail.location + 3) == .comment)
        #expect(engine.visitedLineCount - before >= 900)
        storage.replaceCharacters(in: NSRange(location: 3, length: 0), with: "*/\n")
        #expect(engine.role(at: tail.location + 6) == .number)
    }

    @Test func reusesShiftedCheckpointsAfterSeveralUnqueriedEdits() {
        let (engine, storage) = document("const head = 0\r\n/* block\nclose */\n" + String(repeating: "const mid = 1\n", count: 280) + "const tail = 2", "code.ts")
        func checkAgainstFresh() {
            let (fresh, freshStorage) = document(storage.string, "code.ts")
            let length = freshStorage.length
            #expect(engine.tokens(in: NSRange(location: 0, length: length)) == fresh.tokens(in: NSRange(location: 0, length: length)))
        }
        checkAgainstFresh()
        // Change and join several lines before the next viewport query.
        storage.replaceCharacters(in: range("\r", in: storage, options: .literal), with: "")
        storage.replaceCharacters(in: range("close */", in: storage), with: "*/\nconst next = `multiline")
        storage.replaceCharacters(in: range("const mid = 1", in: storage, options: .backwards), with: "${{x: 1}.x}`")
        checkAgainstFresh()
        storage.replaceCharacters(in: range("const head = 0\n/* block\n", in: storage), with: "// removed\n")
        checkAgainstFresh()
    }

    @Test func coloursMarkdownMosaicAndEmbeddedLanguages() {
        let text = #"""
        ---
        title: "sample"
        ---
        # Main
        > A **strong** and *emphasised* [link](https://example.com) with `x` or `` `nested` ``.
        - [x] Item
        | One | Two |
        | --- | --- |
        ```typescript
        const matcher = /[a/b]+/gi;
        /* comment
        continued */
        ```
        ~~~python
        def greet(name):
            return f"hello {name}"
        ~~~
        ```unknown
        # not a heading
        ```
        Next section
        ------------
        """#
        let (engine, storage) = document(text, "notes.md")
        let expected: [(String, SyntaxRole)] = [("title", .property), ("\"sample\"", .string), ("# Main", .heading), ("> A", .quote),
            ("**strong", .strong), ("*emphasised", .emphasis), ("[link]", .link), ("`x`", .raw), ("`` `nested`", .raw), ("[x]", .listMarker),
            ("| ---", .punctuation), ("const matcher", .storage), ("/[a/b]+/gi", .regex), ("continued", .comment), ("def greet", .storage),
            ("greet(name)", .function), ("hello ", .string), ("# not a heading", .raw), ("Next section", .heading)]
        for (word, role) in expected { #expect(engine.role(at: range(word, in: storage).location) == role, "\(word)") }
        #expect(engine.symbols().map(\.name) == ["Main", "Next section"])
        #expect(engine.symbols().map(\.kind) == [.heading(level: 1), .heading(level: 2)])
    }

    @Test func coloursNestedTemplateExpressionsAndDistinguishesDivision() {
        let (engine, storage) = document(#"""
        const outer = `first ${/\//.test(x) ? `inner ${make({value: 7}).value}` : total / count}
        tail`;
        const next = <Panel title="test">{outer}<Item value={2}/></Panel>;
        """#, "example.tsx")
        let expected: [(String, SyntaxRole)] = [("`first", .string), ("/\\//", .regex), ("test(x)", .function), ("`inner", .string),
            ("make(", .function), ("value: 7", .property), ("7", .number), (".value}", .punctuation), ("/ count", .operator),
            ("tail`", .string), ("const next", .storage), ("Panel title", .tag), ("title=", .attribute), ("Item value", .tag), ("{2}", .punctuation)]
        for (word, role) in expected { #expect(engine.role(at: range(word, in: storage).location) == role, "\(word)") }
    }

    @Test func honoursSwiftRawDelimitersAndUTF16Ranges() {
        let (engine, storage) = document(####"""
        @MainActor
        let value = #"""
        👩🏽‍🚀 literal  \(ignored)
        next \#(make(7)) \#n """ still inside
        """#
        let next = true
        """####, "file.swift")
        let expected: [(String, SyntaxRole)] = [("@MainActor", .decorator), ("👩🏽‍🚀", .string), ("ignored", .string), ("make(7)", .function),
            ("7", .number), (##"\#n"##, .escape), ("still inside", .string), ("let next", .storage), ("true", .constant)]
        for (word, role) in expected { #expect(engine.role(at: range(word, in: storage).location) == role, "\(word)") }
        let next = range("let next", in: storage).location
        #expect(engine.tokens(in: NSRange(location: next, length: 1)).first?.range == NSRange(location: next, length: 3))
    }

    @Test func carriesPythonTripleQuotesShellHeredocsAndYamlScalars() {
        let (python, py) = document(#"""
        @cache
        def f(user):
            return f'''start {{literal}}
        end {render(user)}'''
        print(5)
        """#, "f.py")
        #expect(python.role(at: range("@cache", in: py).location) == .decorator)
        #expect(python.role(at: range("literal", in: py).location) == .string)
        #expect(python.role(at: range("end ", in: py).location) == .string)
        #expect(python.role(at: range("render", in: py).location) == .function)
        #expect(python.role(at: range("print", in: py).location) == .function)
        let (shell, sh) = document("cat <<-'EOF' <<NEXT\n\t$literal\n\tEOF\n$expanded\nNEXT\nif true; then\n  echo success\nfi", ".zshrc")
        #expect(shell.role(at: range("$literal", in: sh).location) == .string)
        #expect(shell.role(at: range("$expanded", in: sh).location) == .property)
        #expect(shell.role(at: range("if true", in: sh).location) == .keyword)
        let (yaml, yml) = document("report: |-\n  title: no # plain scalar content\nresult: true", "input.yaml")
        #expect(yaml.role(at: range("title", in: yml).location) == .string)
        #expect(yaml.role(at: range("result", in: yml).location) == .property)
        #expect(yaml.role(at: range("true", in: yml).location) == .constant)
    }

    @Test func extractsSymbolsWithNamesLocationsAndKinds() {
        let documents: [(String, String, [String], [CodeSymbol.Kind])] = [
            ("file.ts", "interface Shape {}\nclass Circle {\n  radius() { return 1; }\n}\nfunction draw() {}\n", ["Shape", "Circle", "radius", "draw"], [.interface, .class, .method, .function]),
            ("file.swift", "struct Orbit {\n  func trace() {}\n}\nextension Orbit {}\nenum Direction {}", ["Orbit", "trace", "Orbit", "Direction"], [.struct, .method, .extension, .enum]),
            ("file.py", "# def distractor():\nclass Path:\n    def find(self):\n        pass\n\nasync def collect():\n    pass\n", ["Path", "find", "collect"], [.class, .method, .function]),
        ]
        for (path, text, names, kinds) in documents {
            let (engine, storage) = document(text, path)
            let symbols = engine.symbols()
            #expect(symbols.map(\.name) == names, "\(path)")
            #expect(symbols.map(\.kind) == kinds, "\(path)")
            #expect(symbols.map(\.depth).contains(1), "\(path)")
            for symbol in symbols {
                #expect(storage.mutableString.substring(with: symbol.range) == symbol.name)
                #expect(symbol.line == storage.mutableString.substring(to: symbol.range.location).filter { $0 == "\n" }.count + 1)
            }
        }
    }

    @Test func producesNearAndFarViewportTokensFromALargeFixture() {
        let sample = "let value: String = \"hello 👩🏽‍🚀\" // sample text for viewport measurement\n"
        let repetitions = 2_000_000 / sample.utf8.count
        let width = sample.utf16.count
        let (engine, storage) = document(String(repeating: sample, count: repetitions), "source.swift")
        let clock = ContinuousClock()
        let start = clock.now
        let near = engine.tokens(in: NSRange(location: 0, length: width * 40))
        let nearDuration = start.duration(to: clock.now)
        #expect(engine.visitedLineCount == 40)
        #expect(!near.isEmpty)
        storage.replaceCharacters(in: NSRange(location: 4, length: 0), with: "j")
        let farStart = clock.now
        let farRange = NSRange(location: storage.length - width * 40, length: width * 40)
        let far = engine.tokens(in: farRange)
        let farDuration = farStart.duration(to: clock.now)
        #expect(!far.isEmpty)
        let before = engine.visitedLineCount
        storage.replaceCharacters(in: NSRange(location: 4, length: 0), with: "j")
        let warmStart = clock.now
        #expect(!engine.tokens(in: NSRange(location: farRange.location + 1, length: farRange.length)).isEmpty)
        let warm = warmStart.duration(to: clock.now)
        #expect(engine.visitedLineCount - before <= 42)
        print("Syntax fixture (40 lines): first screen \(nearDuration), end screen after top edit (cold) \(farDuration), after another top edit (cached) \(warm)")
    }
}
