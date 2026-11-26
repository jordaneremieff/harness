import AppKit
import Testing
@testable import Editor

@MainActor
@Suite(.serialized)
struct EditorLookTests {
    /// The shared palette of the repository, as the build copies it into the bundle.
    private static let paletteFile = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("../../../../../assets/themes/catppuccin.css").standardized

    private func scratch() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("editor-look-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @Test func paletteReadsEveryFlavourAndResolvesSharedDarkRoles() throws {
        let palette = try #require(CatppuccinPalette.load(Self.paletteFile))
        #expect(palette.roles["frappe"]?["base"] == CatppuccinPalette.colour("#303446"))
        #expect(palette.roles["macchiato"]?["base"] == CatppuccinPalette.colour("#24273a"))
        #expect(palette.roles["mocha"]?["base"] == CatppuccinPalette.colour("#1e1e2e"))
        #expect(palette.roles["latte"]?["base"] == CatppuccinPalette.colour("#eff1f5"))
        // A role that every dark flavour takes from another role resolves within each flavour.
        #expect(palette.roles["mocha"]?["code-type"] == palette.roles["mocha"]?["yellow"])
        #expect(palette.roles["frappe"]?["code-type"] == palette.roles["frappe"]?["yellow"])
        let selection = try #require(palette.roles["frappe"]?["selection"])
        #expect(abs(selection.alpha - 0.28) < 0.001 && abs(selection.red - 148.0 / 255) < 0.001)
    }

    @Test func themeMapsSyntaxRolesToTheFlavour() throws {
        let palette = try #require(CatppuccinPalette.load(Self.paletteFile))
        let dark = EditorTheme(palette: palette, flavour: "mocha")
        let light = EditorTheme(palette: palette, flavour: "latte")
        #expect(dark.isDark && !light.isDark)
        #expect(dark.syntax("keyword") == dark.role("mauve"))
        #expect(light.syntax("string") == light.role("green-text"))
        #expect(dark.syntax("plain") == nil)
        #expect(dark.editor == dark.role("base"))
        let missing = EditorTheme(palette: nil, flavour: "frappe")
        #expect(missing.flavour == "system" && missing.syntax("comment") != nil)
    }

    @Test func paneAppearanceFollowsTheSharedFileAndWritesItWhole() throws {
        let folder = try scratch()
        let file = folder.appendingPathComponent("pane-appearance.json")
        try Data(#"{ "version": 1, "appearance": "dark", "darkTheme": "mocha", "other": 1 }"#.utf8).write(to: file)
        let appearance = PaneAppearance(file: file)
        #expect(appearance.mode == .dark && appearance.flavour == .mocha && appearance.shownFlavour == "mocha")
        appearance.choose(flavour: .macchiato)
        let written = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        #expect(written["appearance"] as? String == "dark" && written["darkTheme"] as? String == "macchiato")
        #expect(written["version"] as? Int == 1)
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o600)
        try Data(#"{ "version": 2, "appearance": "light" }"#.utf8).write(to: file)
        #expect(PaneAppearance(file: file).mode == .system)
        #expect(PaneAppearance(file: file).flavour == .frappe)
    }

    @Test func settingsFileAcceptsCommentsAndReportsValuesItIgnores() {
        let text = """
        {
          // A comment and a trailing comma are allowed.
          "fontSize": 18,
          "ligatures": false,
          "caretStyle": "wobble",
          "tabSize": true,
          "unknown": 1,
          "rulers": [88, 120],
          "languages": { "markdown": { "wordWrap": true, "minimap": false }, "python": { "rulers": [79] } },
        }
        """
        let parsed = SettingsStore.parse(Data(text.utf8))
        #expect(parsed.base.fontSize == 18 && !parsed.base.ligatures && parsed.base.rulers == [88, 120])
        #expect(parsed.base.caretStyle == "smooth" && parsed.base.tabSize == 4)
        #expect(parsed.languages["markdown"]?.wordWrap == true)
        #expect(parsed.languages["python"]?.rulers == [79])
        #expect(parsed.problems.contains { $0.hasPrefix("caretStyle:") })
        #expect(parsed.problems.contains { $0.hasPrefix("tabSize:") })
        #expect(parsed.problems.contains { $0.hasPrefix("unknown:") })
        #expect(parsed.problems.contains { $0.hasPrefix("languages.markdown.minimap:") })
    }

    @Test func settingsStoreWritesOnlyChangedValuesAndMergesLanguages() throws {
        let file = try scratch().appendingPathComponent("settings.json")
        let store = SettingsStore(file: file)
        var changes = 0
        store.onChange = { changes += 1 }
        store.set("fontSize", .number(16))
        store.set("wordWrap", .flag(true), language: "markdown")
        store.set("minimap", .flag(false), language: "markdown")
        #expect(changes == 2)
        let written = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        #expect(written["fontSize"] as? Int == 16 && written.count == 2)
        #expect((written["languages"] as? [String: [String: Bool]])?["markdown"] == ["wordWrap": true])
        #expect(store.settings(language: "markdown").wordWrap && store.settings(language: "markdown").fontSize == 16)
        #expect(!store.settings(language: "swift").wordWrap)
        store.set("fontSize", nil)
        let again = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        #expect(again["fontSize"] == nil)
        #expect(SettingsStore(file: file).settings(language: "markdown").wordWrap)
    }

    @Test func shortcutsReadAndShowInWords() throws {
        #expect(KeyChord("cmd+shift+P")?.label == "cmd+shift+P")
        #expect(KeyChord("super+shift+p") == KeyChord("cmd+shift+P"))
        #expect(KeyChord("ctrl+g")?.label == "control+G")
        #expect(KeyChord("cmd+=")?.label == "cmd+=")
        #expect(KeyChord("option+cmd+left")?.label == "cmd+option+←")
        #expect(KeyChord("f5")?.label == "F5")
        #expect(KeyChord("escape")?.label == "esc")
        #expect(KeyChord("cmd+bogus") == nil)
        #expect(Shortcut("cmd+K cmd+U")?.label == "cmd+K cmd+U")
    }

    private func key(_ characters: String, code: UInt16, _ flags: NSEvent.ModifierFlags) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
                                      characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
    }

    @Test func registryRunsSingleAndTwoChordShortcutsAndLeavesTextKeysAlone() throws {
        let registry = CommandRegistry()
        var ran: [String] = []
        registry.register(EditorCommand("palette", "Command Palette", keys: "cmd+shift+P") { ran.append("palette") })
        registry.register(EditorCommand("upper", "Upper Case", keys: "cmd+K cmd+U") { ran.append("upper") })
        registry.register(EditorCommand("copy", "Copy", keys: "cmd+C") { ran.append("copy") })
        registry.register(EditorCommand("off", "Disabled", keys: "cmd+J", isEnabled: { false }) { ran.append("off") })
        var pending: [String?] = []
        registry.onPending = { pending.append($0) }

        #expect(registry.handle(try key("p", code: 35, [.command, .shift]), textInput: false, composing: false))
        #expect(registry.handle(try key("k", code: 40, .command), textInput: false, composing: false))
        #expect(registry.handle(try key("u", code: 32, .command), textInput: false, composing: false))
        #expect(!registry.handle(try key("c", code: 8, .command), textInput: false, composing: false))
        #expect(!registry.handle(try key("j", code: 38, .command), textInput: false, composing: false))
        #expect(!registry.handle(try key("p", code: 35, [.command, .shift]), textInput: false, composing: true))
        #expect(!registry.handle(try key("p", code: 35, []), textInput: true, composing: false))
        #expect(ran == ["palette", "upper"])
        #expect(pending == ["cmd+K", nil])
        #expect(registry.recent.first == "upper")
    }
}
