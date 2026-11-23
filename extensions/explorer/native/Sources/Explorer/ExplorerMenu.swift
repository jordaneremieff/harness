import AppKit

/// The pane app shows no menu bar, but its menu still supplies the standard editing keys: Undo,
/// Redo, Cut, Copy, Paste and Select All reach the focused text field through the responder chain.
/// The page sees each key first, so its own shortcuts keep their meaning.
@MainActor
enum ExplorerMenu {
    struct Entry {
        let title: String
        let action: Selector
        let key: String
        let modifiers: NSEvent.ModifierFlags
    }

    static let editing: [Entry] = [
        Entry(title: "Undo", action: Selector(("undo:")), key: "z", modifiers: .command),
        Entry(title: "Redo", action: Selector(("redo:")), key: "z", modifiers: [.command, .shift]),
        Entry(title: "Cut", action: #selector(NSText.cut(_:)), key: "x", modifiers: .command),
        Entry(title: "Copy", action: #selector(NSText.copy(_:)), key: "c", modifiers: .command),
        Entry(title: "Paste", action: #selector(NSText.paste(_:)), key: "v", modifiers: .command),
        Entry(title: "Select All", action: #selector(NSText.selectAll(_:)), key: "a", modifiers: .command),
    ]

    static func make() -> NSMenu {
        let edit = NSMenu(title: "Edit")
        for entry in editing {
            let item = NSMenuItem(title: entry.title, action: entry.action, keyEquivalent: entry.key)
            item.keyEquivalentModifierMask = entry.modifiers
            edit.addItem(item)
        }
        let application = NSMenuItem(title: "Explorer", action: nil, keyEquivalent: "")
        application.submenu = NSMenu(title: "Explorer")
        let editHolder = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editHolder.submenu = edit
        let main = NSMenu()
        main.addItem(application)
        main.addItem(editHolder)
        return main
    }
}
