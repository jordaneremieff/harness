import AppKit

struct PathChoice {
    let folder: String
    let name: String

    init(_ path: String) {
        if let at = path.lastIndex(of: "/") {
            folder = String(path[..<at])
            name = String(path[path.index(after: at)...])
        } else { folder = ""; name = path }
    }

    static func problem(_ path: String) -> String? {
        if path.isEmpty || path.hasSuffix("/") { return "Enter a name after the folder path" }
        if path.utf8.count > 4096 { return "The path exceeds 4,096 bytes" }
        if path.hasPrefix("scratch:") || path.contains("\\") || path.unicodeScalars.contains(where: { $0.value <= 31 || $0.value == 127 }) || path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            return "Use a path relative to the project folder"
        }
        return nil
    }
}

extension WorkspaceScreen {
    func showPathPrompt(action: String, start: String = "", run: @escaping @MainActor (String) async throws -> Void) {
        let panel = QuickPanel(title: action, placeholder: "Folder/name", assistance: "Use a project-relative path.",
                               keyboardHelp: "tab  Complete folder    return  Confirm    esc  Cancel")
        panel.field.setAccessibilityLabel("Project-relative file path")
        let prompt = PathPrompt(screen: self, panel: panel, run: run)
        prompt.bind()
        chrome.presentOverlay(panel, placement: .top) { pane in
            NSSize(width: min(610, max(0, pane.width - 24)), height: 282)
        }
        panel.start(start)
    }
}

@MainActor
private final class PathPrompt {
    private struct Entry {
        let path: String
        let name: String
        let folder: Bool
    }
    private weak var screen: WorkspaceScreen?
    private weak var panel: QuickPanel?
    private let run: @MainActor (String) async throws -> Void
    private var loaded: [String: ([Entry], limited: Bool)] = [:]
    private var request: Task<Void, Never>?
    private var requestedFolder: String?
    private var submitting = false

    init(screen: WorkspaceScreen, panel: QuickPanel, run: @escaping @MainActor (String) async throws -> Void) {
        self.screen = screen; self.panel = panel; self.run = run
    }

    func bind() {
        panel?.onInput = { [self] input in update(input) }
        panel?.onAccept = { [weak self] _ in self?.submit() }
        panel?.onClick = { [weak self] item in self?.complete(item) }
        panel?.onTab = { [weak self] in
            guard let self, let item = panel?.item else { return false }
            complete(item)
            return true
        }
        panel?.onCancel = { [weak self] in self?.dismiss() }
        panel?.onDetach = { [weak self] in self?.request?.cancel() }
    }

    private func update(_ input: String) {
        guard let panel, let screen, !submitting else { return }
        let choice = PathChoice(input)
        let folder = choice.folder
        if input.hasPrefix("/") || (!folder.isEmpty && PathChoice.problem(folder) != nil) {
            request?.cancel(); requestedFolder = nil
            panel.show([], status: "Use a path relative to the project folder")
            return
        }
        if let data = loaded[folder] { show(data, for: choice); return }
        if requestedFolder == folder { return }
        request?.cancel()
        requestedFolder = folder
        panel.show([], status: "Checking folders…")
        let api = screen.api
        request = Task { [weak self] in
            var offset = 0
            var items: [Entry] = []
            do {
                var limited = false
                while true {
                    try Task.checkCancellation()
                    let result = try await api.call("tree", ["path": folder, "offset": offset])
                    let rows = result["entries"] as? [Fields] ?? []
                    items.append(contentsOf: rows.compactMap { row in
                        guard let path = row["path"] as? String, let name = row["name"] as? String else { return nil }
                        return Entry(path: path, name: name, folder: row["dir"] as? Bool ?? false)
                    })
                    if let next = result["next"] as? Int, next > offset, items.count < 10_000 { offset = next }
                    else { limited = result["limited"] as? Bool == true || result["next"] is Int; break }
                }
                guard !Task.isCancelled, let self, requestedFolder == folder, let panel = self.panel else { return }
                requestedFolder = nil
                loaded[folder] = (items, limited)
                let latest = PathChoice(panel.text)
                if latest.folder == folder { show((items, limited), for: latest) }
            } catch {
                guard !Task.isCancelled, let self, requestedFolder == folder, let panel = self.panel else { return }
                requestedFolder = nil
                if PathChoice(panel.text).folder == folder { panel.show([], status: error.localizedDescription) }
            }
        }
    }

    private func show(_ data: ([Entry], limited: Bool), for choice: PathChoice) {
        let rows = data.0.filter { $0.folder && $0.name.lowercased().hasPrefix(choice.name.lowercased()) }
            .map { QuickItem($0.path, title: $0.name + "/", icon: "folder") }
        let found = data.0.contains { $0.name == choice.name }
        let message = found ? "A file or folder already uses this path" : data.limited ? "Partial folder list" : rows.isEmpty ? "No folder completions" : nil
        panel?.show(QuickItem.filter(rows, query: choice.name), status: message)
    }

    private func complete(_ item: QuickItem) {
        guard !submitting, let panel else { return }
        panel.focus(panel.field)
        panel.replaceInput(item.id + "/")
    }

    private func dismiss() {
        guard !submitting, let panel else { return }
        screen?.chrome.dismissOverlay(panel)
        if screen?.chrome.window?.isKeyWindow == true { screen?.currentEditor?.focus() }
    }

    private func submit() {
        guard !submitting, let panel else { return }
        let path = panel.text
        if let problem = PathChoice.problem(path) { panel.show([], status: problem); return }
        let choice = PathChoice(path)
        if loaded[choice.folder]?.0.contains(where: { $0.name == choice.name }) == true {
            panel.show([], status: "A file or folder already uses this path")
            return
        }
        request?.cancel(); requestedFolder = nil
        submitting = true
        panel.field.isEditable = false
        panel.busy("Applying…")
        Task { [self, weak panel] in
            defer { submitting = false; panel?.field.isEditable = true }
            do {
                try await run(path)
                guard let panel, panel.superview != nil else { return }
                submitting = false
                dismiss()
            } catch {
                guard let panel, panel.superview != nil else { return }
                panel.field.isEditable = true
                panel.show([], status: error.localizedDescription)
                panel.focus(panel.field)
            }
        }
    }
}
