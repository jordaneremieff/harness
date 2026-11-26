import AppKit

extension WorkspaceScreen {
    func registerPanelCommands() {
        let quick = QuickNavigation()
        let find = FindPanelState()
        let project = PanelProjectSearch()
        onPanelEditorChange = { [weak find] in find?.activeEditorChanged($0) }
        let editing: @MainActor () -> Bool = { [weak self] in self?.currentEditor != nil }
        for (id, replaced) in [("view.search", "cmd+P"), ("view.searchContents", "cmd+shift+F")] {
            if var command = registry.command(id), command.shortcut?.label == replaced {
                command.shortcut = nil
                registry.register(command)
            }
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
        add("find.find", "Find…", "Find", keys: "cmd+F", enabled: editing) { find.show(in: $0, replace: false) }
        add("find.replace", "Replace…", "Find", keys: "cmd+option+F", enabled: editing) { find.show(in: $0, replace: true) }
        add("find.next", "Find Next", "Find", keys: "cmd+G", enabled: editing) { find.move(in: $0, backwards: false) }
        add("find.previous", "Find Previous", "Find", keys: "cmd+shift+G", enabled: editing) { find.move(in: $0, backwards: true) }
        add("find.useSelection", "Use Selection for Find", "Find", keys: "cmd+E", enabled: editing) { find.useSelection(in: $0, replace: false) }
        add("find.useSelectionForReplace", "Use Selection for Replace", "Find", keys: "cmd+shift+E", enabled: editing) { find.useSelection(in: $0, replace: true) }
        add("find.project", "Find in Files…", "Find", keys: "cmd+shift+F") { project.show(in: $0) }
        add("find.nextResult", "Next Result", "Find", keys: "F4", enabled: { project.hasResults }) { project.move(in: $0, backwards: false) }
        add("find.previousResult", "Previous Result", "Find", keys: "shift+F4", enabled: { project.hasResults }) { project.move(in: $0, backwards: true) }
        add("view.settings", "Settings…", "View", keys: "cmd+,") { $0.showSettingsPanel() }
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
