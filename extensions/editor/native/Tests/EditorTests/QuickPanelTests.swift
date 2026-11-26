import AppKit
import Testing
@testable import Editor

struct QuickPanelTests {
    @Test func fuzzyFavoursRunsWordStartsAndBasenames() throws {
        func score(_ path: String, _ query: String) throws -> Int {
            try #require(FuzzyQuery(query).match(FuzzyLabel(path))).score
        }
        #expect(try score("UI/QuickPanel.swift", "quick") > score("queued/unicode/ink/catalogue/key.swift", "quick"))
        #expect(try score("GraphicsPanel.swift", "gp") > score("xgrapher.swift", "gp"))
        #expect(try score("source/Panel.swift", "panel") > score("Panel/doc.txt", "panel"))
        #expect(try score("Panel.swift", "panel") > score("source/features/Panel.swift", "panel"))
        #expect(FuzzyQuery("qpz").match(FuzzyLabel("QuickPanel.swift")) == nil)
    }

    @Test func fuzzyRangesReferToOriginalUTF16() throws {
        let hit = try #require(FuzzyQuery("cafe").match(FuzzyLabel("🧪/Café.swift")))
        #expect(hit.ranges == [3, 4, 5, 6].map { NSRange(location: $0, length: 1) })
        let combined = try #require(FuzzyQuery("a").match(FuzzyLabel("a\u{0301}")))
        #expect(combined.ranges == [NSRange(location: 0, length: 2)])
    }

    @Test func operatorsKeepPathAndTermSeparate() {
        #expect(QuickLocation("CodeEdit").scope == .files)
        #expect(QuickLocation("UI/Editor.swift:18").path == "UI/Editor.swift")
        #expect(QuickLocation("UI/Editor.swift:18").scope == .line("18"))
        #expect(QuickLocation(":18").path.isEmpty)
        #expect(QuickLocation(":18").scope == .line("18"))
        #expect(QuickLocation("@draw").scope == .symbol("draw"))
        #expect(QuickLocation("UI/Editor.swift@").scope == .symbol(""))
        #expect(QuickLocation("README#colour: 18").scope == .text("colour: 18"))
        #expect(QuickLocation("foo:bar").scope == .files)
    }

    @Test func textResultsKeepUTF16RangesLineNumbersAndLimits() throws {
        let hit = QuickTextMatches.search("wait", in: "a\n🧪 WAIT and wait\nwaiting", limit: 2)
        #expect(hit.limited)
        #expect(hit.hits.map(\.item.detail) == [":2", ":2"])
        #expect(hit.locations["5"] == NSRange(location: 5, length: 4))
        let first = try #require(hit.hits.first)
        #expect((first.item.title as NSString).substring(with: first.match.ranges[0]) == "WAIT")
    }

    @Test @MainActor func paletteIncludesRegisteredCommandsAndPrioritisesRecentChoices() {
        let registry = CommandRegistry()
        registry.register(EditorCommand("a", "Alpha", category: "Go", keys: "cmd+1", isEnabled: { false }) {})
        registry.register(EditorCommand("b", "Toggle Beta", category: "View", keys: "cmd+K cmd+B", isOn: { true }) {})
        registry.register(EditorCommand("c", "Gamma", category: "File") {})
        registry.run("b")
        let items = panelCommandItems(registry)
        #expect(QuickItem.filter(items, query: "").map(\.item.id) == ["b", "c", "a"])
        #expect(QuickItem.filter(items, query: "view beta").map(\.item.id) == ["b"])
        #expect(items[0].enabled == false)
        #expect(items[1].checked)
        #expect(items[1].detail == "cmd+K cmd+B")
    }

    @Test @MainActor func symbolSnapshotMatchesTheSourceSyntaxIndex() async {
        let storage = NSTextStorage(string: "Overview\n========\n\n## Details\n")
        let engine = SyntaxEngine(path: "README.md", storage: storage)
        let snapshot = engine.symbolSnapshot()
        let expected = engine.symbols()
        #expect(expected.map(\.name) == ["Overview", "Details"])
        storage.mutableString.append("\n## Later\n")
        #expect(await snapshot.value == expected)
    }

    @Test func pathsRequireNamesInsideTheProject() {
        #expect(PathChoice("Source/Ed").folder == "Source")
        #expect(PathChoice("Source/Ed").name == "Ed")
        #expect(PathChoice("Source/Editor/").name.isEmpty)
        for path in ["", "/absolute", "../x", "x//y", "docs/", "file\nname"] {
            #expect(PathChoice.problem(path) != nil)
        }
        #expect(PathChoice.problem("docs/My File.md") == nil)
    }
}
