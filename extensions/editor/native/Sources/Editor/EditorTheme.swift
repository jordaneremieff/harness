import AppKit

/// The Catppuccin palette that native pane apps share (`assets/themes/catppuccin.css`, copied into
/// the bundle at build time): every role of each flavour, by the role names of the stylesheet.
struct CatppuccinPalette: Sendable {
    static let flavours = ["latte", "frappe", "macchiato", "mocha"]
    /// Flavour name, then role name (`base`, `text`, `code-comment` …), to an sRGB colour.
    let roles: [String: [String: Colour]]

    struct Colour: Equatable, Sendable {
        let red: Double, green: Double, blue: Double, alpha: Double
        var ns: NSColor { NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
    }

    static func bundled(_ bundle: Bundle = .main) -> CatppuccinPalette? {
        guard let url = bundle.url(forResource: "catppuccin", withExtension: "css") else { return nil }
        return load(url)
    }

    static func load(_ url: URL) -> CatppuccinPalette? {
        guard let css = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return parse(css)
    }

    /// Reads the custom properties of each rule. `--ctp-latte-*` belongs to Latte. `--ctp-dark-*`
    /// belongs to the flavour that the rule's selector names, or to every dark flavour when the
    /// selector names none. A value is a hex colour, `rgb()`, or `var()` of another role.
    static func parse(_ css: String) -> CatppuccinPalette? {
        let text = css.replacingOccurrences(of: #"/\*[\s\S]*?\*/"#, with: "", options: .regularExpression)
        var raw: [String: [String: String]] = Dictionary(uniqueKeysWithValues: flavours.map { ($0, [:]) })
        var everyDark: [String: String] = [:]
        for rule in text.components(separatedBy: "}") {
            guard let open = rule.firstIndex(of: "{") else { continue }
            let selector = rule[..<open]
            let named = flavours.dropFirst().first { selector.contains("data-ctp-dark=\"\($0)\"") }
            for declaration in rule[rule.index(after: open)...].split(separator: ";") {
                let parts = declaration.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                guard parts.count == 2 else { continue }
                if parts[0].hasPrefix("--ctp-latte-") {
                    raw["latte"]![String(parts[0].dropFirst(12))] = parts[1]
                } else if parts[0].hasPrefix("--ctp-dark-") {
                    let role = String(parts[0].dropFirst(11))
                    if let named { raw[named]![role] = parts[1] } else if selector.contains("[data-ctp-dark]") { everyDark[role] = parts[1] }
                }
            }
        }
        var roles: [String: [String: Colour]] = [:]
        for flavour in flavours {
            let declared = flavour == "latte" ? raw[flavour]! : everyDark.merging(raw[flavour]!) { _, own in own }
            var resolved: [String: Colour] = [:]
            for role in declared.keys {
                if let colour = resolve(role, in: declared, prefix: flavour == "latte" ? "--ctp-latte-" : "--ctp-dark-", depth: 0) {
                    resolved[role] = colour
                }
            }
            guard resolved["base"] != nil, resolved["text"] != nil else { return nil }
            roles[flavour] = resolved
        }
        return CatppuccinPalette(roles: roles)
    }

    private static func resolve(_ role: String, in declared: [String: String], prefix: String, depth: Int) -> Colour? {
        guard depth < 8, let value = declared[role] else { return nil }
        if value.hasPrefix("var(") {
            let name = value.dropFirst(4).prefix { $0 != ")" }.trimmingCharacters(in: .whitespaces)
            guard name.hasPrefix(prefix) else { return nil }
            return resolve(String(name.dropFirst(prefix.count)), in: declared, prefix: prefix, depth: depth + 1)
        }
        return colour(value)
    }

    static func colour(_ value: String) -> Colour? {
        if value.hasPrefix("#") {
            let hex = value.dropFirst()
            guard hex.count == 6 || hex.count == 8, let number = UInt64(hex, radix: 16) else { return nil }
            let channels = hex.count == 8 ? number : number << 8 | 0xff
            return Colour(red: Double(channels >> 24 & 0xff) / 255, green: Double(channels >> 16 & 0xff) / 255,
                          blue: Double(channels >> 8 & 0xff) / 255, alpha: Double(channels & 0xff) / 255)
        }
        guard value.hasPrefix("rgb"), let open = value.firstIndex(of: "("), let close = value.lastIndex(of: ")") else { return nil }
        let numbers = value[value.index(after: open)..<close]
            .split(whereSeparator: { $0 == " " || $0 == "," || $0 == "/" })
            .map { $0.hasSuffix("%") ? Double($0.dropLast()).map { $0 / 100 } : Double($0) }
        guard numbers.count == 3 || numbers.count == 4, numbers.allSatisfy({ $0 != nil }) else { return nil }
        return Colour(red: numbers[0]! / 255, green: numbers[1]! / 255, blue: numbers[2]! / 255,
                      alpha: numbers.count == 4 ? numbers[3]! : 1)
    }
}

/// The colours of the workspace for one appearance. Each role names its use; views read the
/// current theme from `WorkspaceStyle.theme` when they draw.
struct EditorTheme {
    /// `latte`, `frappe`, `macchiato` or `mocha`; `system` when no palette is available.
    let flavour: String
    let isDark: Bool
    private let palette: [String: NSColor]

    init(palette: CatppuccinPalette?, flavour: String) {
        if let roles = palette?.roles[flavour] {
            self.flavour = flavour
            isDark = flavour != "latte"
            self.palette = roles.mapValues(\.ns)
        } else {
            self.flavour = "system"
            isDark = flavour != "latte"
            self.palette = [:]
        }
    }

    /// A palette role by its stylesheet name, such as `blue` or `surface0`.
    func role(_ name: String) -> NSColor? { palette[name] }
    private func pick(_ name: String, _ system: NSColor) -> NSColor { palette[name] ?? system }
    private func tint(_ name: String, _ alpha: CGFloat, _ system: NSColor) -> NSColor {
        palette[name]?.withAlphaComponent(alpha) ?? system
    }

    // MARK: Surfaces

    /// Behind source text and pages.
    var editor: NSColor { pick("base", .textBackgroundColor) }
    /// Behind line numbers and change marks.
    var gutter: NSColor { editor }
    /// Behind the sidebar and tab strips.
    var chrome: NSColor { pick("mantle", NSColor(white: isDark ? 0.17 : 0.95, alpha: 1)) }
    /// Behind the status line and other bars at the edge of the pane.
    var bar: NSColor { pick("crust", NSColor(white: isDark ? 0.14 : 0.92, alpha: 1)) }
    /// Behind overlays such as Go to Anything and the command palette.
    var panel: NSColor { pick(isDark ? "mantle" : "base", .windowBackgroundColor) }
    var panelBorder: NSColor { pick(isDark ? "surface0" : "surface1", .separatorColor) }
    var panelShadow: NSColor { NSColor.black.withAlphaComponent(isDark ? 0.45 : 0.18) }
    /// A separating line between regions.
    var line: NSColor { pick(isDark ? "crust" : "surface0", .separatorColor) }
    /// Under the pointer.
    var hover: NSColor { tint("text", isDark ? 0.07 : 0.06, NSColor(white: isDark ? 1 : 0, alpha: isDark ? 0.07 : 0.05)) }
    /// A control that is on, or a press.
    var engaged: NSColor { tint("text", isDark ? 0.13 : 0.11, NSColor(white: isDark ? 1 : 0, alpha: isDark ? 0.13 : 0.1)) }
    /// The chosen row of a list or an overlay.
    var chosen: NSColor { tint("blue", isDark ? 0.22 : 0.16, .selectedContentBackgroundColor) }
    var accent: NSColor { pick("blue", .controlAccentColor) }

    // MARK: Text

    var text: NSColor { pick("text", .labelColor) }
    var secondaryText: NSColor { pick("subtext0", .secondaryLabelColor) }
    var mutedText: NSColor { pick(isDark ? "overlay1" : "overlay2", .tertiaryLabelColor) }
    /// A matched character in a filtered list.
    var matchText: NSColor { pick(isDark ? "yellow" : "peach-text", .controlAccentColor) }
    var warning: NSColor { pick(isDark ? "yellow" : "peach-text", .systemOrange) }
    var problem: NSColor { pick(isDark ? "red" : "red-text", .systemRed) }

    // MARK: Source marks

    var caret: NSColor { pick("rosewater", .textColor) }
    var selection: NSColor { pick("selection", .selectedTextBackgroundColor) }
    var inactiveSelection: NSColor { tint("overlay2", isDark ? 0.18 : 0.16, .unemphasizedSelectedTextBackgroundColor) }
    var currentLine: NSColor { tint("text", isDark ? 0.055 : 0.06, NSColor(white: isDark ? 1 : 0, alpha: 0.05)) }
    var lineNumber: NSColor { pick(isDark ? "overlay0" : "overlay1", .tertiaryLabelColor) }
    var activeLineNumber: NSColor { pick("lavender", .labelColor) }
    var indentGuide: NSColor { pick(isDark ? "surface0" : "surface0", .separatorColor) }
    var activeIndentGuide: NSColor { pick(isDark ? "surface2" : "surface2", .tertiaryLabelColor) }
    var ruler: NSColor { pick(isDark ? "surface0" : "surface0", .separatorColor) }
    var whitespace: NSColor { pick(isDark ? "surface2" : "surface2", .quaternaryLabelColor) }
    var findMatch: NSColor { tint("yellow", isDark ? 0.24 : 0.3, .findHighlightColor.withAlphaComponent(0.35)) }
    var findCurrent: NSColor { tint("peach", isDark ? 0.5 : 0.45, .findHighlightColor) }
    var selectionMatch: NSColor { tint("overlay2", isDark ? 0.22 : 0.2, .unemphasizedSelectedTextBackgroundColor) }
    var foldMark: NSColor { pick(isDark ? "surface1" : "surface0", .quaternaryLabelColor) }
    var minimapViewport: NSColor { tint("text", isDark ? 0.08 : 0.08, NSColor(white: 0.5, alpha: 0.12)) }
    /// Bracket pairs, one colour per kind: `curly`, `round`, `square`, `angle`, `tag`, and `unmatched`.
    func bracket(_ kind: String) -> NSColor {
        let name = ["curly": "pink", "round": "yellow", "square": "mauve", "angle": "peach", "tag": "green", "unmatched": "red"][kind] ?? "overlay2"
        return pick(isDark ? name : name == "yellow" ? "peach-text" : name, .controlAccentColor)
    }
    var added: NSColor { pick(isDark ? "green" : "green-text", .systemGreen) }
    var modified: NSColor { pick(isDark ? "yellow" : "peach-text", .systemYellow) }
    var deleted: NSColor { pick(isDark ? "red" : "red-text", .systemRed) }

    // MARK: Syntax

    /// The colour of a syntax role by name (`comment`, `string`, `keyword` …); nil keeps the text colour.
    func syntax(_ role: String) -> NSColor? {
        guard let names = Self.syntaxRoles[role] else { return nil }
        if palette.isEmpty { return Self.systemSyntax[role] }
        return palette[isDark ? names.dark : names.light]
    }

    private static let syntaxRoles: [String: (dark: String, light: String)] = [
        "comment": ("code-comment", "code-comment"), "string": ("green", "green-text"),
        "escape": ("code-escape", "code-escape"), "regex": ("pink", "code-escape"),
        "number": ("peach", "peach-text"), "constant": ("peach", "peach-text"),
        "keyword": ("mauve", "mauve-text"), "storage": ("mauve", "mauve-text"),
        "type": ("code-type", "code-type"), "function": ("blue", "blue"),
        "property": ("code-member", "code-member"), "parameter": ("code-param", "code-param"),
        "operator": ("code-operator", "code-operator"), "punctuation": ("code-punct", "code-punct"),
        "tag": ("blue", "blue"), "attribute": ("code-type", "code-type"),
        "decorator": ("code-macro", "code-macro"), "heading": ("blue", "blue"),
        "emphasis": ("maroon", "code-param"), "strong": ("peach", "peach-text"),
        "link": ("link", "link"), "raw": ("code-ink", "code-ink"),
        "listMarker": ("teal", "teal-text"), "quote": ("code-comment", "code-comment"),
        "inserted": ("green", "green-text"), "deleted": ("red", "red-text"),
        "changedHeader": ("code-meta", "code-meta"), "invalid": ("red", "red-text"),
    ]

    private static let systemSyntax: [String: NSColor] = [
        "comment": .secondaryLabelColor, "string": .systemGreen, "regex": .systemPink, "number": .systemBlue,
        "constant": .systemBlue, "keyword": .systemPurple, "storage": .systemPurple, "type": .systemTeal,
        "function": .systemIndigo, "heading": .systemTeal, "raw": .systemGreen, "link": .linkColor,
        "inserted": .systemGreen, "deleted": .systemRed, "invalid": .systemRed,
    ]
}
