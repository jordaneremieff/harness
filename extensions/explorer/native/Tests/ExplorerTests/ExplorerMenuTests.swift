import AppKit
import Testing
@testable import Explorer

@MainActor
struct ExplorerMenuTests {
    /// Text fields get the standard editing keys from the menu, with the standard actions, so the
    /// responder chain delivers them to the focused field.
    @Test func editMenuSuppliesTheStandardEditingKeys() throws {
        let menu = ExplorerMenu.make()
        let edit = try #require(menu.items.first { $0.title == "Edit" }?.submenu)
        let items = edit.items.map { ($0.title, $0.action.map(NSStringFromSelector) ?? "", $0.keyEquivalent, $0.keyEquivalentModifierMask) }
        let expected: [(String, String, String, NSEvent.ModifierFlags)] = [
            ("Undo", "undo:", "z", .command),
            ("Redo", "redo:", "z", [.command, .shift]),
            ("Cut", "cut:", "x", .command),
            ("Copy", "copy:", "c", .command),
            ("Paste", "paste:", "v", .command),
            ("Select All", "selectAll:", "a", .command),
        ]
        #expect(items.count == expected.count)
        for (item, want) in zip(items, expected) {
            #expect(item.0 == want.0)
            #expect(item.1 == want.1)
            #expect(item.2 == want.2)
            #expect(item.3 == want.3)
        }
        // The first item is the application menu, as AppKit expects of a main menu.
        #expect(menu.items.first?.title == "Explorer")
    }
}
