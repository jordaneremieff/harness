import AppKit

/// One key press with its modifiers, such as cmd+shift+P.
struct KeyChord: Hashable, Sendable {
    static let modifierOrder: [(String, NSEvent.ModifierFlags)] = [("cmd", .command), ("control", .control), ("option", .option), ("shift", .shift)]
    private static let names: [String: String] = ["ctrl": "control", "alt": "option", "opt": "option", "super": "cmd", "command": "cmd"]
    private static let keyNames: [String: String] = ["escape": "esc", "enter": "return", "forwarddelete": "delete"]
    private static let codes: [UInt16: String] = [
        36: "return", 76: "return", 53: "esc", 48: "tab", 49: "space", 51: "backspace", 117: "delete",
        123: "left", 124: "right", 125: "down", 126: "up", 115: "home", 119: "end", 116: "pageup", 121: "pagedown",
        122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8", 101: "f9", 109: "f10", 103: "f11", 111: "f12",
    ]
    private static let glyphs = ["left": "←", "right": "→", "up": "↑", "down": "↓"]

    /// The key: a character as typed without modifiers, or a name such as `return` or `f5`.
    let key: String
    let modifiers: NSEvent.ModifierFlags.RawValue

    init(key: String, modifiers: NSEvent.ModifierFlags) {
        self.key = key
        self.modifiers = modifiers.intersection([.command, .control, .option, .shift]).rawValue
    }

    /// Reads text such as `cmd+shift+P`, `control+G`, `cmd+=` or `f5`.
    init?(_ text: String) {
        var parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        // A trailing empty part is the plus key itself, as in `cmd++`.
        if parts.count > 1, parts.last == "", parts[parts.count - 2] == "" { parts.removeLast(2); parts.append("+") }
        guard let last = parts.popLast(), !last.isEmpty else { return nil }
        var flags = NSEvent.ModifierFlags()
        for part in parts {
            let name = Self.names[part.lowercased()] ?? part.lowercased()
            guard let flag = Self.modifierOrder.first(where: { $0.0 == name })?.1 else { return nil }
            flags.insert(flag)
        }
        let key = Self.keyNames[last.lowercased()] ?? last.lowercased()
        guard key.count == 1 || Self.codes.values.contains(key) else { return nil }
        self.init(key: key, modifiers: flags)
    }

    init?(event: NSEvent) {
        guard event.type == .keyDown else { return nil }
        if let name = Self.codes[event.keyCode] {
            self.init(key: name, modifiers: event.modifierFlags)
            return
        }
        guard let base = event.characters(byApplyingModifiers: []), base.count == 1 else { return nil }
        self.init(key: base.lowercased(), modifiers: event.modifierFlags)
    }

    var flags: NSEvent.ModifierFlags { NSEvent.ModifierFlags(rawValue: modifiers) }

    /// The words that Editor shows for this chord, such as `cmd+shift+P`.
    var label: String {
        let words = Self.modifierOrder.filter { flags.contains($0.1) }.map(\.0)
        let isFunction = key.count > 1 && key.hasPrefix("f") && key.dropFirst().allSatisfy(\.isNumber)
        let key = Self.glyphs[key] ?? (key.count == 1 || isFunction ? key.uppercased() : key)
        return (words + [key]).joined(separator: "+")
    }
}

/// The key presses of a command: one chord, or two in a row such as cmd+K cmd+U.
struct Shortcut: Hashable, Sendable {
    let chords: [KeyChord]

    init?(_ text: String) {
        let chords = text.split(separator: " ").compactMap { KeyChord(String($0)) }
        guard (1...2).contains(chords.count), chords.count == text.split(separator: " ").count else { return nil }
        self.chords = chords
    }

    var label: String { chords.map(\.label).joined(separator: " ") }
}

/// An action that a person can run from the command palette, a menu or its shortcut.
struct EditorCommand {
    let id: String
    let title: String
    /// Groups the command in the palette, as in "View: Toggle Minimap".
    let category: String?
    var shortcut: Shortcut?
    var isEnabled: @MainActor () -> Bool
    /// The state of a command that switches something on or off.
    var isOn: (@MainActor () -> Bool)?
    let run: @MainActor () -> Void

    init(_ id: String, _ title: String, category: String? = nil, keys: String? = nil,
         isEnabled: @escaping @MainActor () -> Bool = { true }, isOn: (@MainActor () -> Bool)? = nil,
         run: @escaping @MainActor () -> Void) {
        self.id = id
        self.title = title
        self.category = category
        shortcut = keys.flatMap(Shortcut.init)
        self.isEnabled = isEnabled
        self.isOn = isOn
        self.run = run
    }

    /// The name that the palette shows.
    var caption: String { category.map { "\($0): \(title)" } ?? title }
}

/// The commands of the workspace and their shortcuts. Standard text keys (cmd+A, cmd+C, cmd+V,
/// cmd+X, cmd+Z and cmd+shift+Z) stay with the responder chain, so text fields keep them.
@MainActor
final class CommandRegistry {
    private static let textKeys: Set<String> = ["cmd+A", "cmd+C", "cmd+V", "cmd+X", "cmd+Z", "cmd+shift+Z"]
    private(set) var commands: [EditorCommand] = []
    private var index: [String: Int] = [:]
    private var bindings: [Shortcut: String] = [:]
    private var prefixes: Set<KeyChord> = []
    private var pending: KeyChord?
    /// Ids of the commands run most recently, newest first.
    private(set) var recent: [String] = []
    /// Shows the first chord of a two-chord shortcut while Editor waits for the second; nil clears it.
    var onPending: ((String?) -> Void)?

    /// Adds a command, or replaces the command with the same id.
    func register(_ command: EditorCommand) {
        if let at = index[command.id] {
            if let old = commands[at].shortcut, bindings[old] == command.id { bindings[old] = nil }
            commands[at] = command
        } else {
            index[command.id] = commands.count
            commands.append(command)
        }
        if let shortcut = command.shortcut, !Self.textKeys.contains(shortcut.label) {
            bindings[shortcut] = command.id
            if shortcut.chords.count == 2 { prefixes.insert(shortcut.chords[0]) }
        }
    }

    func command(_ id: String) -> EditorCommand? { index[id].map { commands[$0] } }

    /// Runs an enabled command and reports whether it ran.
    @discardableResult
    func run(_ id: String) -> Bool {
        guard let command = command(id), command.isEnabled() else { return false }
        recent.removeAll { $0 == id }
        recent.insert(id, at: 0)
        if recent.count > 40 { recent.removeLast() }
        command.run()
        return true
    }

    /// Handles a key press that belongs to a shortcut and reports whether it did. A press during
    /// text composition, or a plain typing key in a text field, is left alone.
    func handle(_ event: NSEvent, textInput: Bool, composing: Bool) -> Bool {
        guard !composing, let chord = KeyChord(event: event) else { return false }
        if let first = pending {
            pending = nil
            onPending?(nil)
            if let shortcut = Shortcut(chords: [first, chord]), let id = bindings[shortcut] { run(id); return true }
            return chord.flags.contains(.command) || chord.flags.contains(.control)
        }
        let modified = chord.flags.contains(.command) || chord.flags.contains(.control) || chord.key.hasPrefix("f") && chord.key.count > 1
        // A field keeps its own keys: typing, option and arrow moves, and the standard edit keys.
        if textInput && !modified { return false }
        if prefixes.contains(chord) {
            pending = chord
            onPending?(chord.label)
            return true
        }
        guard let shortcut = Shortcut(chords: [chord]), let id = bindings[shortcut],
              let command = command(id), command.isEnabled() else { return false }
        run(id)
        return true
    }

    /// The shortcut label of a command, for menus and lists.
    func keys(_ id: String) -> String? { command(id)?.shortcut?.label }
}

extension Shortcut {
    init?(chords: [KeyChord]) {
        guard (1...2).contains(chords.count) else { return nil }
        self.chords = chords
    }
}
