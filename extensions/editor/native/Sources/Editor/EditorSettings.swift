import AppKit

/// One value of an Editor setting.
enum SettingValue: Equatable, Sendable {
    case flag(Bool)
    case number(Double)
    case text(String)
    case columns([Int])

    var json: Any {
        switch self {
        case .flag(let value): value
        case .number(let value): value.rounded() == value && abs(value) < 1e9 ? Int(value) as Any : value
        case .text(let value): value
        case .columns(let value): value
        }
    }
}

/// The declaration of one setting: its key in the settings file, how a person sees and changes
/// it, its default, and whether a language may override it.
struct SettingSpec: Sendable {
    enum Kind: Sendable, Equatable {
        case toggle
        case number(ClosedRange<Double>, step: Double, unit: String)
        /// Allowed values and their titles, in the order a choice shows them.
        case choice([String], titles: [String])
        /// A font family name; empty for the system monospaced font.
        case font
        /// Column numbers, such as the positions of rulers.
        case columns
    }

    let key: String
    let title: String
    let detail: String
    let group: String
    let kind: Kind
    let initial: SettingValue
    let perLanguage: Bool

    /// The value when it is valid for this setting, else nil.
    func accept(_ object: Any) -> SettingValue? {
        switch kind {
        case .toggle:
            guard let number = object as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
            return .flag(number.boolValue)
        case .number(let range, let step, _):
            guard let number = object as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            let value = number.doubleValue
            guard value.isFinite, range.contains(value) else { return nil }
            return .number(step >= 1 ? value.rounded() : value)
        case .choice(let values, _):
            guard let value = object as? String, values.contains(value) else { return nil }
            return .text(value)
        case .font:
            guard let value = object as? String, value.count <= 200 else { return nil }
            return .text(value)
        case .columns:
            guard let list = object as? [NSNumber], list.count <= 8 else { return nil }
            let columns = list.map(\.intValue)
            guard list.allSatisfy({ CFGetTypeID($0) != CFBooleanGetTypeID() }), columns.allSatisfy({ (1...1000).contains($0) }) else { return nil }
            return .columns(columns)
        }
    }

    var expectation: String {
        switch kind {
        case .toggle: "true or false"
        case .number(let range, _, _): "a number from \(Int(range.lowerBound)) to \(Int(range.upperBound))"
        case .choice(let values, _): values.map { "\"\($0)\"" }.joined(separator: ", ")
        case .font: "a font family name, or \"\" for the system font"
        case .columns: "a list of up to 8 column numbers"
        }
    }
}

/// The effective Editor settings for one context: the defaults, the values of the settings file,
/// and the overrides of the file's language when there is one.
struct EditorSettings: Equatable, Sendable {
    static let specs: [SettingSpec] = [
        SettingSpec(key: "fontFamily", title: "Font", detail: "The font of source text. Empty uses the system monospaced font.",
                    group: "Font", kind: .font, initial: .text(""), perLanguage: false),
        SettingSpec(key: "fontSize", title: "Size", detail: "The size of source text in points.",
                    group: "Font", kind: .number(8...40, step: 1, unit: "pt"), initial: .number(14), perLanguage: true),
        SettingSpec(key: "lineSpacing", title: "Line spacing", detail: "Space added between lines, in points.",
                    group: "Font", kind: .number(0...16, step: 1, unit: "pt"), initial: .number(3), perLanguage: true),
        SettingSpec(key: "ligatures", title: "Ligatures", detail: "Join character pairs such as => when the font draws them as one.",
                    group: "Font", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "interfaceSize", title: "Interface text size", detail: "The size of text in the sidebar, the tabs and the status line.",
                    group: "Font", kind: .number(11...18, step: 1, unit: "pt"), initial: .number(13), perLanguage: false),

        SettingSpec(key: "caretStyle", title: "Caret", detail: "How the insertion point blinks.",
                    group: "Caret and selection", kind: .choice(["smooth", "phase", "blink", "solid"], titles: ["Smooth", "Phase", "Blink", "Solid"]),
                    initial: .text("smooth"), perLanguage: false),
        SettingSpec(key: "caretWidth", title: "Caret width", detail: "The width of the insertion point in points.",
                    group: "Caret and selection", kind: .number(1...4, step: 1, unit: "pt"), initial: .number(2), perLanguage: false),
        SettingSpec(key: "blockCaret", title: "Block caret", detail: "Show the insertion point as a block over the next character.",
                    group: "Caret and selection", kind: .toggle, initial: .flag(false), perLanguage: false),
        SettingSpec(key: "highlightLine", title: "Highlight current line", detail: "Tint the line and the line number that hold the insertion point.",
                    group: "Caret and selection", kind: .toggle, initial: .flag(true), perLanguage: false),
        SettingSpec(key: "matchSelection", title: "Highlight selection matches", detail: "Mark other occurrences of the selected word.",
                    group: "Caret and selection", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "matchBrackets", title: "Highlight matching brackets", detail: "Mark the bracket pair around the insertion point, one colour per bracket kind.",
                    group: "Caret and selection", kind: .toggle, initial: .flag(true), perLanguage: true),

        SettingSpec(key: "lineNumbers", title: "Line numbers", detail: "Show line numbers in the gutter.",
                    group: "View", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "foldButtons", title: "Fold buttons", detail: "Show buttons in the gutter that fold and unfold blocks.",
                    group: "View", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "gitGutter", title: "Change marks", detail: "Mark added, changed and removed lines against the last Git commit.",
                    group: "View", kind: .toggle, initial: .flag(true), perLanguage: false),
        SettingSpec(key: "minimap", title: "Minimap", detail: "Show an overview of the file beside the source.",
                    group: "View", kind: .toggle, initial: .flag(true), perLanguage: false),
        SettingSpec(key: "indentGuides", title: "Indent guides", detail: "Draw a line at each indentation level.",
                    group: "View", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "rulers", title: "Rulers", detail: "Draw vertical lines at these columns.",
                    group: "View", kind: .columns, initial: .columns([]), perLanguage: true),
        SettingSpec(key: "whitespace", title: "Show whitespace", detail: "Draw spaces and tabs as faint marks.",
                    group: "View", kind: .choice(["none", "selection", "all"], titles: ["Never", "In the selection", "Always"]),
                    initial: .text("selection"), perLanguage: true),
        SettingSpec(key: "wordWrap", title: "Wrap lines", detail: "Wrap long lines instead of scrolling sideways.",
                    group: "View", kind: .toggle, initial: .flag(false), perLanguage: true),
        SettingSpec(key: "wrapColumn", title: "Wrap column", detail: "The column where wrapped lines break. 0 wraps at the edge of the page.",
                    group: "View", kind: .number(0...400, step: 1, unit: ""), initial: .number(0), perLanguage: true),
        SettingSpec(key: "scrollPastEnd", title: "Scroll past the end", detail: "Let the last line scroll up to the middle of the page.",
                    group: "View", kind: .toggle, initial: .flag(true), perLanguage: false),
        SettingSpec(key: "animations", title: "Animations", detail: "Move overlays, tabs and the caret with short animations.",
                    group: "View", kind: .toggle, initial: .flag(true), perLanguage: false),

        SettingSpec(key: "tabSize", title: "Tab width", detail: "The width of a tab and of one indentation level, in columns.",
                    group: "Typing", kind: .number(1...16, step: 1, unit: ""), initial: .number(4), perLanguage: true),
        SettingSpec(key: "indentWithSpaces", title: "Indent with spaces", detail: "Insert spaces when you press Tab or indent.",
                    group: "Typing", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "detectIndentation", title: "Detect indentation", detail: "Use the indentation that an opened file already uses.",
                    group: "Typing", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "autoIndent", title: "Automatic indentation", detail: "Indent a new line like the line above it, and deeper after an opening bracket.",
                    group: "Typing", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "autoClosePairs", title: "Close brackets and quotes", detail: "Type the closing bracket or quote with the opening one.",
                    group: "Typing", kind: .toggle, initial: .flag(true), perLanguage: true),
        SettingSpec(key: "copyLineWithEmptySelection", title: "Copy the line without a selection", detail: "Copy or cut the whole line when nothing is selected.",
                    group: "Typing", kind: .toggle, initial: .flag(true), perLanguage: false),

        SettingSpec(key: "trimTrailingWhitespaceOnSave", title: "Trim trailing spaces on save", detail: "Remove spaces and tabs at the ends of lines when you save.",
                    group: "Saving", kind: .toggle, initial: .flag(false), perLanguage: true),
        SettingSpec(key: "ensureNewlineAtEndOnSave", title: "End the file with a line break", detail: "Add a final line break when you save a file without one.",
                    group: "Saving", kind: .toggle, initial: .flag(false), perLanguage: true),

        SettingSpec(key: "restoreSession", title: "Reopen tabs", detail: "Open the tabs, sides and scroll positions of a folder as you left them.",
                    group: "Workspace", kind: .toggle, initial: .flag(true), perLanguage: false),
        SettingSpec(key: "previewOnClick", title: "Preview on click", detail: "A click in the file tree shows the file in a preview tab that the next preview replaces.",
                    group: "Workspace", kind: .toggle, initial: .flag(true), perLanguage: false),
    ]

    static let specsByKey: [String: SettingSpec] = Dictionary(uniqueKeysWithValues: specs.map { ($0.key, $0) })

    /// Non-default base values, or the explicitly chosen values of a language.
    private(set) var values: [String: SettingValue] = [:]

    init(values: [String: SettingValue] = [:]) {
        for (key, value) in values { set(key, value) }
    }

    func value(_ key: String) -> SettingValue {
        values[key] ?? Self.specsByKey[key]?.initial ?? .flag(false)
    }

    /// Nil removes the value. A language can explicitly choose the factory default instead of inheriting the base.
    mutating func set(_ key: String, _ value: SettingValue?, keepDefault: Bool = false) {
        guard let spec = Self.specsByKey[key] else { return }
        values[key] = !keepDefault && value == spec.initial ? nil : value
    }

    func flag(_ key: String) -> Bool { if case .flag(let value) = value(key) { value } else { false } }
    func number(_ key: String) -> Double { if case .number(let value) = value(key) { value } else { 0 } }
    func text(_ key: String) -> String { if case .text(let value) = value(key) { value } else { "" } }
    func columns(_ key: String) -> [Int] { if case .columns(let value) = value(key) { value } else { [] } }

    var fontFamily: String { text("fontFamily") }
    var fontSize: CGFloat { CGFloat(number("fontSize")) }
    var lineSpacing: CGFloat { CGFloat(number("lineSpacing")) }
    var ligatures: Bool { flag("ligatures") }
    var interfaceSize: CGFloat { CGFloat(number("interfaceSize")) }
    var caretStyle: String { text("caretStyle") }
    var caretWidth: CGFloat { CGFloat(number("caretWidth")) }
    var blockCaret: Bool { flag("blockCaret") }
    var highlightLine: Bool { flag("highlightLine") }
    var matchSelection: Bool { flag("matchSelection") }
    var matchBrackets: Bool { flag("matchBrackets") }
    var lineNumbers: Bool { flag("lineNumbers") }
    var foldButtons: Bool { flag("foldButtons") }
    var gitGutter: Bool { flag("gitGutter") }
    var minimap: Bool { flag("minimap") }
    var indentGuides: Bool { flag("indentGuides") }
    var rulers: [Int] { columns("rulers") }
    var whitespace: String { text("whitespace") }
    var wordWrap: Bool { flag("wordWrap") }
    var wrapColumn: Int { Int(number("wrapColumn")) }
    var scrollPastEnd: Bool { flag("scrollPastEnd") }
    var animations: Bool { flag("animations") }
    var tabSize: Int { Int(number("tabSize")) }
    var indentWithSpaces: Bool { flag("indentWithSpaces") }
    var detectIndentation: Bool { flag("detectIndentation") }
    var autoIndent: Bool { flag("autoIndent") }
    var autoClosePairs: Bool { flag("autoClosePairs") }
    var copyLineWithEmptySelection: Bool { flag("copyLineWithEmptySelection") }
    var trimTrailingWhitespaceOnSave: Bool { flag("trimTrailingWhitespaceOnSave") }
    var ensureNewlineAtEndOnSave: Bool { flag("ensureNewlineAtEndOnSave") }
    var restoreSession: Bool { flag("restoreSession") }
    var previewOnClick: Bool { flag("previewOnClick") }

    /// The source font of these settings. An unknown family uses the system monospaced font.
    var sourceFont: NSFont {
        let size = fontSize
        var font = fontFamily.isEmpty ? nil : NSFontManager.shared.font(withFamily: fontFamily, traits: [], weight: 5, size: size)
        if font == nil { font = .monospacedSystemFont(ofSize: size, weight: .regular) }
        guard !ligatures, let font else { return font! }
        // Contextual alternates and ligatures off: each character keeps its own glyph.
        let features: [[NSFontDescriptor.FeatureKey: Int]] = [
            [.typeIdentifier: kLigaturesType, .selectorIdentifier: kCommonLigaturesOffSelector],
            [.typeIdentifier: kContextualAlternatesType, .selectorIdentifier: kContextualAlternatesOffSelector],
        ]
        return NSFont(descriptor: font.fontDescriptor.addingAttributes([.featureSettings: features]), size: size) ?? font
    }
}

/// The Editor settings file of this Mac: values that differ from the defaults, and per-language
/// overrides under `languages`. The file accepts comments and trailing commas. Editor reads it at
/// launch and again whenever it changes, so a change by hand or by an agent applies at once.
@MainActor
final class SettingsStore {
    let file: URL?
    private(set) var base = EditorSettings()
    private(set) var languages: [String: EditorSettings] = [:]
    /// Values of the file that Editor ignored, each with the reason.
    private(set) var problems: [String] = []
    var onChange: (() -> Void)?
    private var watch: FileWatch?

    /// Without a file the settings stay in memory.
    init(file: URL?) {
        self.file = file
        read()
        if let file { watch = FileWatch(file) { [weak self] in self?.reload() } }
    }

    /// The settings for a file of a language, such as `markdown`; nil for the base settings.
    func settings(language: String?) -> EditorSettings {
        guard let language, let overrides = languages[language] else { return base }
        var merged = base
        for (key, value) in overrides.values { merged.set(key, value) }
        return merged
    }

    /// Changes one setting and writes the file. Nil restores the default or the inherited base value.
    func set(_ key: String, _ value: SettingValue?, language: String? = nil) {
        set([(key, value, language)])
    }

    /// Applies a set of choices with one file write and one appearance update.
    func set(_ changes: [(key: String, value: SettingValue?, language: String?)]) {
        let before = (base, languages)
        for (key, value, language) in changes {
            guard let spec = EditorSettings.specsByKey[key], language == nil || spec.perLanguage,
                  value == nil || value.flatMap({ spec.accept($0.json) }) != nil else { continue }
            if let language {
                var overrides = languages[language] ?? EditorSettings()
                overrides.set(key, value, keepDefault: true)
                languages[language] = overrides.values.isEmpty ? nil : overrides
            } else {
                base.set(key, value)
            }
        }
        guard before.0 != base || before.1 != languages else { return }
        write()
        onChange?()
    }

    /// The JSON text that the file holds for the current values.
    var encoded: Data {
        var record: [String: Any] = base.values.mapValues(\.json)
        let languageRecords = languages.compactMapValues { settings -> [String: Any]? in
            settings.values.isEmpty ? nil : settings.values.mapValues(\.json)
        }
        if !languageRecords.isEmpty { record["languages"] = languageRecords }
        let data = (try? JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return data + Data("\n".utf8)
    }

    private func write() {
        guard let file else { return }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try replaceFileAtomically(file, with: encoded)
        } catch {
            problems = ["Editor could not write \(file.path): \(error.localizedDescription)"]
        }
    }

    private func reload() {
        let before = (base, languages, problems)
        read()
        if before.0 != base || before.1 != languages || before.2 != problems { onChange?() }
    }

    private func read() {
        guard let file, let data = try? Data(contentsOf: file) else {
            base = EditorSettings(); languages = [:]; problems = []
            return
        }
        let parsed = Self.parse(data)
        base = parsed.base
        languages = parsed.languages
        problems = parsed.problems
    }

    static func parse(_ data: Data) -> (base: EditorSettings, languages: [String: EditorSettings], problems: [String]) {
        guard data.count <= 262_144 else { return (EditorSettings(), [:], ["The settings file is larger than 256 KiB; Editor uses the defaults."]) }
        guard let object = try? JSONSerialization.jsonObject(with: data, options: [.json5Allowed]),
              let record = object as? [String: Any] else {
            return (EditorSettings(), [:], ["The settings file is not a JSON object; Editor uses the defaults until it is fixed."])
        }
        var problems: [String] = []
        func settings(_ record: [String: Any], language: String?) -> EditorSettings {
            var result = EditorSettings()
            for key in record.keys.sorted() where !(language == nil && key == "languages") {
                guard let spec = EditorSettings.specsByKey[key] else { problems.append("\(key): not an Editor setting."); continue }
                if language != nil && !spec.perLanguage { problems.append("languages.\(language!).\(key): applies to every language only."); continue }
                guard let value = spec.accept(record[key]!) else {
                    problems.append("\(language.map { "languages.\($0)." } ?? "")\(key): expected \(spec.expectation); the default applies.")
                    continue
                }
                result.set(key, value, keepDefault: language != nil)
            }
            return result
        }
        let base = settings(record, language: nil)
        var languages: [String: EditorSettings] = [:]
        if let entries = record["languages"] {
            if let entries = entries as? [String: Any] {
                for (language, value) in entries {
                    guard let overrides = value as? [String: Any] else { problems.append("languages.\(language): expected an object."); continue }
                    let parsed = settings(overrides, language: language)
                    if !parsed.values.isEmpty { languages[language] = parsed }
                }
            } else {
                problems.append("languages: expected an object of language names.")
            }
        }
        return (base, languages, problems)
    }
}
