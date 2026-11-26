import AppKit

extension WorkspaceScreen {
    func registerPanelCommands() {
        let quick = QuickNavigation()
        let editing: @MainActor () -> Bool = { [weak self] in self?.currentEditor != nil }
        if var command = registry.command("view.search"), command.shortcut?.label == "cmd+P" {
            command.shortcut = nil
            registry.register(command)
        }
        func add(_ id: String, _ title: String, _ category: String, keys: String,
                 enabled: @escaping @MainActor () -> Bool = { true }, _ body: @escaping @MainActor (WorkspaceScreen) -> Void) {
            registry.register(EditorCommand(id, title, category: category, keys: keys, isEnabled: enabled) { [weak self] in
                if let self { body(self) }
            })
        }
        add("go.anything", "Go to Anything…", "Go", keys: "cmd+P") { quick.show(in: $0, mode: .anything) }
        add("go.line", "Go to Line…", "Go", keys: "control+G", enabled: editing) { quick.show(in: $0, mode: .line) }
        add("go.symbol", "Go to Symbol…", "Go", keys: "cmd+R", enabled: editing) { quick.show(in: $0, mode: .symbols) }
        add("view.commandPalette", "Show Command Palette…", "View", keys: "cmd+shift+P") { $0.showCommandPalette() }
        Task { [weak self] in if let self { quick.fetch(in: self) } }
    }

    private func showCommandPalette() {
        let panel = QuickPanel(title: "Command Palette", placeholder: "Search all Editor commands", keyboardHelp: "↑ ↓  Move    return  Run    esc  Close")
        let items = panelCommandItems(registry)
        panel.onInput = { [weak panel] text in panel?.show(QuickItem.filter(items, query: text)) }
        panel.onCancel = { [weak self, weak panel] in
            guard let self, let panel else { return }
            chrome.dismissOverlay(panel)
            if chrome.window?.isKeyWindow == true { currentEditor?.focus() }
        }
        panel.onAccept = { [weak self, weak panel] item in
            guard let self, let panel, let item, registry.command(item.id)?.isEnabled() == true else { return }
            chrome.dismissOverlay(panel)
            if chrome.window?.isKeyWindow == true { currentEditor?.focus() }
            registry.run(item.id)
        }
        chrome.presentOverlay(panel, placement: .top) { pane in
            NSSize(width: min(682, max(0, pane.width - 24)), height: 422)
        }
        panel.start()
    }
}

@MainActor
func panelCommandItems(_ registry: CommandRegistry) -> [QuickItem] {
    let ranks = Dictionary(uniqueKeysWithValues: registry.recent.enumerated().map { ($0.element, registry.recent.count - $0.offset) })
    return registry.commands.map { command in
        QuickItem(command.id, title: command.caption, detail: command.shortcut?.label ?? "", icon: "command",
                  enabled: command.isEnabled(), checked: command.isOn?() == true,
                  priority: command.id == "view.commandPalette" ? 0 : ranks[command.id] ?? 0)
    }
}
