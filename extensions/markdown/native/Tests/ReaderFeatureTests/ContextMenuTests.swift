import AppKit
import Testing
@testable import ReaderFeature

@MainActor struct ContextMenuTests {
    @Test func everyWebKitMenuIsEmptied() {
        for identifiers in [["WKMenuItemIdentifierLookUp", "WKMenuItemIdentifierCopy", "WKMenuItemIdentifierShareMenu"], ["WKMenuItemIdentifierPaste"], ["WKMenuItemIdentifierOpenLink", "WKMenuItemIdentifierCopyLink"], []] {
            let menu = NSMenu()
            for identifier in identifiers {
                let item = NSMenuItem(title: identifier, action: nil, keyEquivalent: "")
                item.identifier = NSUserInterfaceItemIdentifier(identifier)
                menu.addItem(item)
            }
            ReaderContextMenu.suppress(menu)
            #expect(menu.items.isEmpty)
        }
    }
}
