import AppKit
import Testing
@testable import ReaderFeature

@MainActor private final class Target: NSObject {
    var asked = 0
    @objc func ask(_ sender: Any?) { asked += 1 }
}

@MainActor struct ContextMenuTests {
    private func menu(_ items: [(String, Bool)]) -> NSMenu {
        let menu = NSMenu()
        for (identifier, enabled) in items {
            let item = NSMenuItem(title: identifier, action: nil, keyEquivalent: "")
            item.identifier = NSUserInterfaceItemIdentifier(identifier)
            item.isEnabled = enabled
            menu.addItem(item)
        }
        menu.autoenablesItems = false
        return menu
    }

    @Test func aSelectionMenuStartsWithAskAndKeepsWebKitItems() throws {
        let target = Target()
        let menu = menu([("WKMenuItemIdentifierLookUp", true), ("WKMenuItemIdentifierTranslate", true), ("WKMenuItemIdentifierCopy", true), ("WKMenuItemIdentifierShareMenu", true)])
        ReaderContextMenu.addAsk(to: menu, target: target, action: #selector(Target.ask(_:)))
        #expect(menu.items.first?.title == "Ask about this")
        #expect(menu.items[1].isSeparatorItem)
        #expect(menu.items.dropFirst(2).compactMap(\.identifier?.rawValue) == ["WKMenuItemIdentifierLookUp", "WKMenuItemIdentifierTranslate", "WKMenuItemIdentifierCopy", "WKMenuItemIdentifierShareMenu"])
        let ask = try #require(menu.items.first)
        _ = ask.target.map { NSApp.sendAction(ask.action!, to: $0, from: ask) }
        #expect(target.asked == 1)
        ReaderContextMenu.addAsk(to: menu, target: target, action: #selector(Target.ask(_:)))
        #expect(menu.items.filter { $0.identifier == ReaderContextMenu.askIdentifier }.count == 1)
    }

    @Test func aMenuWithoutSelectedTextGetsNoAsk() {
        let target = Target()
        for items in [[("WKMenuItemIdentifierPaste", true)], [("WKMenuItemIdentifierCopy", false), ("WKMenuItemIdentifierPaste", true)], [("WKMenuItemIdentifierOpenLink", true)]] {
            let menu = menu(items)
            ReaderContextMenu.addAsk(to: menu, target: target, action: #selector(Target.ask(_:)))
            #expect(!menu.items.contains { $0.identifier == ReaderContextMenu.askIdentifier })
        }
    }
}
