import AppKit

@MainActor
final class WorkspaceScreen {
    private enum Panel: String { case files, search, git, notes }
    private enum PathRequest { case newFile, saveAs(CodeEditor) }
    /// The tabs on one side of the stage, in the order a person gave them. The arrangement
    /// belongs to this pane: it changes no draft, thread or other participant's view.
    private struct Group {
        let id: Int
        var keys: [String]
        var selected: String?
    }

    private let api: any EditorAPI
    private let root: String
    private let chrome: WorkspaceChrome
    var view: NSView { chrome }
    private let navigator: ProjectNavigator
    private let collaboration: Collaboration
    private let welcome: NSView
    private var panel: Panel? = .files
    private var buffers: [String: CodeEditor] = [:]
    private var compositions: [String: CompositionPage] = [:]
    private var viewHeaders: [Fields] = []
    private var documents: [Fields] = []
    private var hiddenViews: [String: Int] = [:]
    private var groups = [Group(id: 0, keys: [], selected: nil)]
    /// The group that commands such as Save and Find apply to.
    private var active = 0
    private var nextGroup = 1
    private var sequence: Int?
    private var pathRequest: PathRequest?
    private var wraps = false
    private var stopped = false
    private var selectionRequest = 0
    private var activeMutation = false
    private var expandedNavigator = false
    private var monitor: Task<Void, Never>?
    private var tasks: [UUID: Task<Void, Never>] = [:]

    /// `defaults` keeps the layout a person chose for this pane between launches.
    init(api: any EditorAPI, root: String, defaults: UserDefaults = .standard) {
        self.api = api
        self.root = root
        chrome = WorkspaceChrome(root: root, defaults: defaults)
        navigator = ProjectNavigator(api: api)
        collaboration = Collaboration(api: api)
        let start = WorkspaceLanding(folder: URL(fileURLWithPath: root).lastPathComponent)
        welcome = start
        start.open.run = { [weak self] in self?.showNavigator(.files) }
        start.new.run = { [weak self] in self?.command("scratch") }
        chrome.onCommand = { [weak self] in self?.command($0) }
        chrome.onSidebar = { [weak self] name in
            guard let self, let panel = Panel(rawValue: name) else { return }
            toggle(panel)
        }
        chrome.onSelect = { [weak self] key in self?.act { try await $0.select(key) } }
        chrome.onClose = { [weak self] key in self?.act { try await $0.closeTab(key) } }
        chrome.onMove = { [weak self] key, drop in self?.move(key, to: drop) }
        chrome.onActivate = { [weak self] id in self?.activate(id) }
        chrome.onNote = { [weak self] in self?.note($0, $1) }
        chrome.onTabMenu = { [weak self] in self?.tabMenu($0) ?? NSMenu() }
        chrome.onMenu = { [weak self] in self?.workspaceMenu() ?? NSMenu() }
        chrome.onCancelPath = { [weak self] in self?.clearPath() }
        chrome.onPath = { [weak self] path in self?.submit(path) }
        chrome.onFitSidebar = { [weak self] in
            guard let self, panel != nil, panel != .notes else { return nil }
            return navigator.fittingWidth
        }
        navigator.onOpen = { [weak self] path, line in self?.act { try await $0.open(path, line: line) } }
        navigator.onNote = { [weak self] in self?.note($0, $1) }
        navigator.onExpand = { [weak self] expanded in
            guard let self else { return }; expandedNavigator = expanded
            if expanded { panel = .git }; present()
        }
        navigator.onError = { [weak self] text in self?.chrome.setMessage(text) }
        collaboration.onOpen = navigator.onOpen
        collaboration.onError = navigator.onError
        collaboration.onStatus = { [weak self] text in
            self?.chrome.setMessage(text)
            self?.act { try await $0.loadState() }
        }
        chrome.setWrap(wraps)
        present()
    }

    func start(file: String?) async throws {
        try await loadState()
        if let file {
            panel = nil
            try await open(file, focus: false)
        } else {
            try await navigator.start()
            present()
        }
        guard !stopped else { return }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(1200)) } catch { return }
                guard let self, !self.stopped else { return }
                do { try await self.synchronise() }
                catch { if !Task.isCancelled { self.chrome.setMessage(error.localizedDescription) } }
            }
        }
    }

    func prepareToClose() async -> Bool {
        guard !activeMutation else { chrome.setMessage("Finish the current file operation before closing Editor."); return false }
        if collaboration.hasUnpostedText {
            panel = .notes; present(); collaboration.showInbox()
            chrome.setMessage("Post or clear your unsent message before closing Editor."); return false
        }
        if chrome.hasPathText { chrome.setMessage("Submit or cancel the file path before closing Editor."); return false }
        for editor in Array(buffers.values) {
            do { try await editor.flush() }
            catch {
                let key = fileKey(editor.doc)
                if let index = groupIndex(of: key) { groups[index].selected = key; active = groups[index].id }
                panel = nil; present(reveal: key)
                showProblem(error, editor: editor); return false
            }
        }
        guard !activeMutation, !chrome.hasPathText, !collaboration.hasUnpostedText,
              buffers.values.allSatisfy({ !$0.hasPending }) else {
            chrome.setMessage("The workspace changed during close. Your edits are still here.")
            return false
        }
        return true
    }

    func stop() {
        stopped = true
        monitor?.cancel(); monitor = nil
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        collaboration.stop(); navigator.stop()
        for editor in buffers.values { editor.stop() }
    }

    private func act(_ body: @escaping @MainActor (WorkspaceScreen) async throws -> Void) {
        guard !stopped else { return }
        let id = UUID()
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            defer { tasks[id] = nil }
            do { try await body(self) }
            catch { if !Task.isCancelled { showProblem(error, editor: currentEditor) } }
        }
    }

    // MARK: Tabs and groups

    private func fileKey(_ doc: String) -> String { "doc:" + doc }
    private func viewKey(_ id: String) -> String { "view:" + id }
    private var activeIndex: Int { groups.firstIndex { $0.id == active } ?? 0 }
    private var selected: String? { groups[activeIndex].selected }
    private func groupIndex(of key: String) -> Int? { groups.firstIndex { $0.keys.contains(key) } }
    private func editor(for key: String?) -> CodeEditor? {
        guard let key, key.hasPrefix("doc:") else { return nil }
        return buffers[String(key.dropFirst(4))]
    }
    private func viewID(for key: String?) -> String? {
        guard let key, key.hasPrefix("view:") else { return nil }
        return String(key.dropFirst(5))
    }
    private var currentEditor: CodeEditor? { editor(for: selected) }

    /// Puts a key in a group when none holds it, and returns the index of its group. A page that
    /// sends the person to a file stays on show when the stage has a second group: the file
    /// goes to that group, also when it was a tab beside the page.
    private func place(_ key: String, awayFrom source: String? = nil) -> Int {
        let beside = groups.count > 1 ? source.flatMap(groupIndex(of:)).map { 1 - $0 } : nil
        if let index = groupIndex(of: key) {
            guard let beside, beside != index, let place = groups[index].keys.firstIndex(of: key) else { return index }
            groups[index].keys.remove(at: place)
            if groups[index].selected == key { groups[index].selected = neighbour(in: index, at: place) }
            groups[beside].keys.append(key)
            return beside
        }
        let index = beside ?? activeIndex
        groups[index].keys.append(key)
        return index
    }

    /// The key that takes the place of a tab removed from `place` in a group.
    private func neighbour(in index: Int, at place: Int) -> String? {
        let keys = groups[index].keys
        return keys.isEmpty ? nil : keys[min(place, keys.count - 1)]
    }

    private func makeBuffer(_ record: Fields) throws -> CodeEditor {
        guard let doc = record["doc"] as? String, record["text"] is String, record["rev"] is Int else {
            throw EditorIssue(code: "response", message: "Pi did not return the requested draft.")
        }
        if let existing = buffers[doc] { return existing }
        let editor = CodeEditor(api: api, record: record)
        buffers[doc] = editor
        editor.setWrap(wraps)
        editor.onStatus = { [weak self, weak editor] text in
            guard let self, let editor, currentEditor === editor else { return }
            if editor.conflicted || editor.diskConflict { conflictMessage(editor) }
            else { chrome.setMessage(text) }
        }
        editor.onChange = { [weak self, weak editor] in
            guard let self, let editor else { return }
            refresh()
            if currentEditor === editor && (editor.conflicted || editor.diskConflict) { conflictMessage(editor) }
        }
        editor.onNote = { [weak self] anchor in self?.compose(anchor) }
        return editor
    }

    func open(_ doc: String, line: Int? = nil, focus: Bool = true, awayFrom source: String? = nil) async throws {
        selectionRequest += 1
        let token = selectionRequest
        let editor: CodeEditor
        if let cached = buffers[doc] { editor = cached }
        else {
            let record = try await api.call("read", ["doc":doc])
            guard !stopped else { return }
            editor = try makeBuffer(record)
        }
        let key = fileKey(editor.doc)
        let index = place(key, awayFrom: source)
        guard token == selectionRequest else { refresh(); return }
        groups[index].selected = key
        active = groups[index].id
        if !chrome.showsSideBySide || panel == .notes { panel = nil }
        present(reveal: key)
        if let line { editor.go(line: line) }
        if focus { editor.focus() }
        if editor.conflicted || editor.diskConflict { conflictMessage(editor) }
    }

    private func select(_ key: String) async throws {
        if key.hasPrefix("doc:") { try await open(String(key.dropFirst(4))); return }
        let id = String(key.dropFirst(5))
        guard let header = viewHeaders.first(where: { $0["id"] as? String == id }), let rev = header["rev"] as? Int else { return }
        selectionRequest += 1
        let token = selectionRequest
        hiddenViews[id] = nil
        try await composition(id).update(revision: rev)
        guard token == selectionRequest, !stopped else { return }
        let index = place(key)
        groups[index].selected = key
        active = groups[index].id
        if !chrome.showsSideBySide || panel == .notes { panel = nil }
        present(reveal: key)
    }

    private func composition(_ id: String) -> CompositionPage {
        if let page = compositions[id] { return page }
        let page = CompositionPage(api: api, id: id)
        let key = viewKey(id)
        page.onOpen = { [weak self] path, line in self?.act { try await $0.open(path, line: line, awayFrom: key) } }
        page.onNote = { [weak self] in self?.compose($0) }
        compositions[id] = page
        return page
    }

    private func activate(_ id: Int) {
        guard active != id, groups.contains(where: { $0.id == id }) else { return }
        active = id
        refresh()
    }

    /// Moves a tab to another place in its group, to the other group, or to a new group.
    private func move(_ key: String, to drop: WorkspaceDrop) {
        guard let from = groupIndex(of: key), let place = groups[from].keys.firstIndex(of: key) else { return }
        let moved = editor(for: key)
        let typing = moved?.hasFocus == true
        let wasSelected = groups[from].selected == key
        switch drop {
        case .slot(let id, let index):
            guard let to = groups.firstIndex(where: { $0.id == id }) else { return }
            groups[from].keys.remove(at: place)
            groups[to].keys.insert(key, at: min(max(0, index), groups[to].keys.count))
            if to != from {
                if wasSelected { groups[from].selected = neighbour(in: from, at: place) }
                groups[to].selected = key
            }
            active = id
        case .beside(let id, let trailing):
            guard groups.count == 1, groups[from].keys.count > 1, let anchor = groups.firstIndex(where: { $0.id == id }) else { return }
            groups[from].keys.remove(at: place)
            if wasSelected { groups[from].selected = neighbour(in: from, at: place) }
            groups.insert(Group(id: nextGroup, keys: [key], selected: key), at: trailing ? anchor + 1 : anchor)
            active = nextGroup
            nextGroup += 1
        }
        present(reveal: key)
        // A page that changes its group leaves the responder chain for a moment.
        if typing { moved?.focus() }
    }

    private func loadState() async throws {
        let state = try await api.call("state", sequence.map { ["since":$0] } ?? [:])
        guard !stopped, state["unchanged"] as? Bool != true else { return }
        guard let next = state["seq"] as? Int, sequence.map({ next >= $0 }) ?? true else { return }
        sequence = next
        documents = state["docs"] as? [Fields] ?? []
        viewHeaders = state["views"] as? [Fields] ?? []
        collaboration.update(state: state)
        refresh()
    }
    func synchronise() async throws {
        try await loadState()
        for key in groups.compactMap(\.selected) {
            if let editor = editor(for: key) { try await editor.refresh() }
            if let id = viewID(for: key), let rev = viewHeaders.first(where: { $0["id"] as? String == id })?["rev"] as? Int {
                try await compositions[id]?.update(revision: rev)
            }
        }
    }

    /// Brings the groups in line with the drafts and composed tabs that exist. A composed tab
    /// arrives without a request: it joins the group that holds the latest one, or the active group.
    private func reconcile() {
        let composed = viewHeaders.reversed().compactMap { entry -> String? in
            guard let id = entry["id"] as? String, let rev = entry["rev"] as? Int, hiddenViews[id] != rev, entry["title"] is String else { return nil }
            return viewKey(id)
        }
        let shown = Set(composed)
        for index in groups.indices {
            groups[index].keys.removeAll { key in
                key.hasPrefix("view:") ? !shown.contains(key) : editor(for: key) == nil
            }
            if let key = groups[index].selected, !groups[index].keys.contains(key) { groups[index].selected = groups[index].keys.last }
        }
        for key in composed where groupIndex(of: key) == nil {
            let home = groups.lastIndex { $0.keys.contains { $0.hasPrefix("view:") } } ?? activeIndex
            groups[home].keys.append(key)
        }
        if groups.count > 1, let keep = groups.first(where: { !$0.keys.isEmpty }) ?? groups.first {
            groups.removeAll { $0.keys.isEmpty && $0.id != keep.id }
        }
        if !groups.contains(where: { $0.id == active }) { active = groups[0].id }
        // A tab can become the selected one without a press, for example when its neighbour moves away.
        for group in groups {
            guard let id = viewID(for: group.selected), compositions[id] == nil,
                  let rev = viewHeaders.first(where: { $0["id"] as? String == id })?["rev"] as? Int else { continue }
            let page = composition(id)
            act { screen in
                try await page.update(revision: rev)
                screen.refresh()
            }
        }
    }

    private func tab(for key: String) -> WorkspaceTab? {
        if let editor = editor(for: key) {
            let doc = editor.doc
            let name = editor.title == "Untitled" && doc.hasPrefix("scratch:") ? "Scratch \(doc.dropFirst(8).prefix(4))" : editor.title
            let warns = editor.conflicted || editor.diskConflict
            return WorkspaceTab(key: key, label: name, detail: doc, symbol: warns ? "exclamationmark.triangle" : "doc.plaintext",
                                unsaved: editor.dirty, warns: warns)
        }
        guard let id = viewID(for: key), let label = viewHeaders.first(where: { $0["id"] as? String == id })?["title"] as? String else { return nil }
        return WorkspaceTab(key: key, label: label, detail: "Composed tab: " + label, symbol: "rectangle.3.group")
    }

    private func page(for group: Group) -> NSView? {
        if let page = editor(for: group.selected)?.view ?? viewID(for: group.selected).flatMap({ compositions[$0]?.view }) { return page }
        return groups.count == 1 ? welcome : nil
    }

    /// Shows the current tabs, pages and status. The chrome changes only what differs.
    private func refresh(reveal: String? = nil) {
        reconcile()
        chrome.setGroups(groups.map { WorkspaceGroup(id: $0.id, tabs: $0.keys.compactMap(tab(for:)), selected: $0.selected, page: page(for: $0)) },
                         active: active, reveal: reveal)
        if let e = currentEditor {
            let status = e.conflicted ? "Local conflict" : e.diskConflict ? "Disk changed" : e.hasPending ? "Local edits" : e.dirty ? "Draft" : "On disk"
            let path = e.doc.hasPrefix("scratch:") ? "Scratch" : e.doc
            chrome.setStatus(path,"\(status)  ·  r\(e.revision)",canSave: !e.conflicted)
        } else if let id = viewID(for: selected), let h = viewHeaders.first(where: { $0["id"] as? String == id }) {
            chrome.setStatus(h["title"] as? String ?? "Composed tab","Composed  ·  r\(h["rev"] as? Int ?? 1)",canSave: false)
        } else { chrome.setStatus(root,"Workspace",canSave: false) }
    }
    private func present(reveal: String? = nil) {
        chrome.expandedPanel = expandedNavigator && panel != nil && panel != .notes
        refresh(reveal: reveal)
        chrome.setSidebar(panel == nil ? nil : panel == .notes ? collaboration.view : navigator.view, named: panel?.rawValue)
    }

    // MARK: Sidebar and commands

    private func showNavigator(_ want: Panel) {
        selectionRequest += 1
        panel = want; present()
        switch want {
        case .git: navigator.showGit(doc: currentEditor.flatMap { $0.doc.hasPrefix("scratch:") ? nil : $0.doc })
        case .search: navigator.showSearch()
        default: navigator.showFiles()
        }
    }
    private func toggle(_ want: Panel) {
        if panel == want { selectionRequest += 1; panel = nil; present(); currentEditor?.focus() }
        else if want == .notes { selectionRequest += 1; panel = .notes; present(); collaboration.showInbox() }
        else { showNavigator(want) }
    }
    private func note(_ kind: String, _ key: String) { compose(["target":["kind":kind,"key":key]]) }
    private func compose(_ anchor: Fields) {
        selectionRequest += 1
        panel = .notes; present()
        collaboration.compose(anchor: anchor)
    }
    private func command(_ name: String) {
        switch name {
        case "files": toggle(.files)
        case "search": showNavigator(.search)
        case "searchContents": selectionRequest += 1; panel = .search; present(); navigator.showSearch(contents: true)
        case "git": showNavigator(.git)
        case "find":
            guard let editor = currentEditor else { return }
            // A sidebar that covers the source would hide what Find shows.
            if !chrome.showsSideBySide { panel = nil; present() }
            editor.find()
        case "wrap":
            wraps.toggle(); chrome.setWrap(wraps)
            for buffer in buffers.values { buffer.setWrap(wraps) }
        case "notes": toggle(.notes)
        case "scratch": mutate { try await $0.create(nil) }
        case "newFile": requestPath(.newFile)
        case "saveAs": if let e = currentEditor, !e.conflicted { requestPath(.saveAs(e)) }
        case "save":
            guard let e = currentEditor else { return }
            if e.conflicted { conflictMessage(e) }
            else if e.doc.hasPrefix("scratch:") || e.diskConflict { requestPath(.saveAs(e)) }
            else { mutate { try await $0.save(e, to: nil) } }
        case "next", "previous":
            let keys = groups[activeIndex].keys
            guard let i = keys.firstIndex(where: { $0 == selected }) else { return }
            let key = keys[(i + (name == "next" ? 1 : keys.count - 1)) % keys.count]
            act { try await $0.select(key) }
        default: break
        }
    }
    private func mutate(_ body: @escaping @MainActor (WorkspaceScreen) async throws -> Void) {
        guard !activeMutation else { return }
        activeMutation = true
        act { screen in
            defer { screen.activeMutation = false }
            try await body(screen)
        }
    }
    private func requestPath(_ request: PathRequest) {
        if pathRequest != nil && chrome.hasPathText { chrome.setMessage("Submit or cancel the current file path first."); return }
        pathRequest = request
        switch request { case .newFile: chrome.inputPath(action: "Create file"); case .saveAs: chrome.inputPath(action: "Save as") }
    }
    private func clearPath() { pathRequest = nil; chrome.hidePath(); currentEditor?.focus() }
    private func submit(_ path: String) {
        guard let request = pathRequest else { return }
        mutate { screen in
            switch request { case .newFile: try await screen.create(path); case .saveAs(let e): try await screen.save(e, to: path) }
            screen.clearPath()
        }
    }
    private func create(_ path: String?) async throws {
        let token = selectionRequest
        let record = try await api.call("new", path.map { ["path":$0] } ?? [:])
        guard !stopped else { return }
        let b = try makeBuffer(record)
        if token == selectionRequest { try await open(b.doc) } else { _ = place(fileKey(b.doc)); refresh() }
    }
    private func save(_ editor: CodeEditor, to path: String?) async throws {
        let previous = editor.doc
        try await editor.save(path: path)
        if editor.doc != previous {
            buffers[previous] = nil; buffers[editor.doc] = editor
            let old = fileKey(previous), new = fileKey(editor.doc)
            for index in groups.indices {
                groups[index].keys = groups[index].keys.map { $0 == old ? new : $0 }
                if groups[index].selected == old { groups[index].selected = new }
            }
        }
        chrome.setMessage("Saved \(editor.doc).")
        refresh()
        if panel == .files { navigator.showFiles() }
    }
    private func conflictMessage(_ editor: CodeEditor) {
        if editor.conflicted {
            chrome.setMessage("The shared draft changed. Your local text is intact.",action: "Keep both") { [weak self, weak editor] in
                guard let self, let editor else { return }; keepBoth(editor)
            }
        } else if editor.diskConflict {
            chrome.setMessage("The disk file changed. Save the draft to a new path to keep both versions.",action: "Save as…") { [weak self, weak editor] in
                guard let self, let editor else { return }; requestPath(.saveAs(editor))
            }
        }
    }
    private func showProblem(_ error: Error, editor: CodeEditor?) {
        if let editor, editor.conflicted || editor.diskConflict { conflictMessage(editor) }
        else { chrome.setMessage(error.localizedDescription) }
    }
    private func keepBoth(_ editor: CodeEditor) {
        mutate { screen in
            let scratch = try await editor.recoverAsScratch()
            let kept = try screen.makeBuffer(scratch)
            try await screen.open(kept.doc)
            try await editor.discardLocalChanges(ifMatching: scratch["text"] as? String)
            screen.chrome.setMessage("Your local text is in a new scratch. The original tab shows the shared draft.")
        }
    }
    private func closeTab(_ key: String) async throws {
        if let editor = editor(for: key) {
            try await editor.flush()
            guard !editor.hasPending else { chrome.setMessage("The tab changed during close. Your edits are still here."); return }
            buffers[editor.doc] = nil; editor.stop()
        } else if let id = viewID(for: key) {
            hiddenViews[id] = viewHeaders.first(where: { $0["id"] as? String == id })?["rev"] as? Int
            compositions[id] = nil
        }
        if let index = groupIndex(of: key), let place = groups[index].keys.firstIndex(of: key) {
            let wasSelected = groups[index].selected == key
            groups[index].keys.remove(at: place)
            if wasSelected {
                groups[index].selected = nil
                if let next = neighbour(in: index, at: place) {
                    active = groups[index].id
                    try await select(next)
                }
            }
        }
        if groups.allSatisfy({ $0.keys.isEmpty }) { showNavigator(.files) }
        present()
    }
    private func closeOthers(_ key: String) async throws {
        guard let index = groupIndex(of: key) else { return }
        for other in groups[index].keys where other != key { try await closeTab(other) }
    }

    // MARK: Menus

    private func tabMenu(_ key: String) -> NSMenu {
        let menu = NSMenu()
        if let doc = editor(for: key)?.doc {
            menu.addItem(WorkspaceChoice("Note on this tab…") { [weak self] in self?.note("tab",doc) })
            if !doc.hasPrefix("scratch:") { menu.addItem(WorkspaceChoice("Note on this file…") { [weak self] in self?.note("file",doc) }) }
        } else if let id = viewID(for: key) {
            menu.addItem(WorkspaceChoice("Note on this composed tab…") { [weak self] in self?.note("view",id) })
        }
        menu.addItem(.separator())
        if let index = groupIndex(of: key) {
            let group = groups[index]
            if groups.count == 1, group.keys.count > 1, chrome.fitsSecondGroup {
                menu.addItem(WorkspaceChoice("Move to the right side") { [weak self] in self?.move(key, to: .beside(group: group.id, trailing: true)) })
                menu.addItem(WorkspaceChoice("Move to the left side") { [weak self] in self?.move(key, to: .beside(group: group.id, trailing: false)) })
                menu.addItem(.separator())
            } else if groups.count == 2 {
                let other = groups[1 - index]
                menu.addItem(WorkspaceChoice(index == 0 ? "Move to the right side" : "Move to the left side") { [weak self] in
                    self?.move(key, to: .slot(group: other.id, index: other.keys.count))
                })
                menu.addItem(.separator())
            }
            menu.addItem(WorkspaceChoice("Close tab") { [weak self] in self?.act { try await $0.closeTab(key) } })
            if group.keys.count > 1 {
                menu.addItem(WorkspaceChoice("Close other tabs") { [weak self] in self?.act { try await $0.closeOthers(key) } })
            }
        }
        return menu
    }
    private func workspaceMenu() -> NSMenu {
        let menu = NSMenu()
        func choice(_ name: String, _ command: String) {
            menu.addItem(WorkspaceChoice(name) { [weak self] in self?.command(command) })
        }
        choice("New scratch   cmd+N","scratch"); choice("New file…   cmd+shift+N","newFile")
        if currentEditor != nil { choice("Save as…   cmd+shift+S","saveAs"); choice("Find in this file…   cmd+F","find") }
        let drafts = NSMenu()
        for doc in documents {
            guard let path = doc["doc"] as? String else { continue }
            let title = path.hasPrefix("scratch:") ? "Scratch \(path.dropFirst(8).prefix(8))" : path
            let item = WorkspaceChoice(title) { [weak self] in self?.act { try await $0.open(path) } }
            item.toolTip = path; drafts.addItem(item)
        }
        if !drafts.items.isEmpty { let item = menu.addItem(withTitle: "Workspace drafts",action:nil,keyEquivalent:""); item.submenu = drafts }
        if !viewHeaders.isEmpty {
            let pages = NSMenu()
            for h in viewHeaders { if let id = h["id"] as? String, let title = h["title"] as? String {
                pages.addItem(WorkspaceChoice(title) { [weak self] in self?.act { try await $0.select($0.viewKey(id)) } })
            } }
            menu.addItem(withTitle:"Composed tabs",action:nil,keyEquivalent:"").submenu = pages
        }
        menu.addItem(.separator()); choice("Project search   cmd+P","search"); choice("Local Git","git"); choice("Conversations   cmd+option+T","notes")
        menu.addItem(.separator())
        let wrap = WorkspaceChoice("Wrap lines") { [weak self] in
            self?.command("wrap")
        }
        wrap.state = wraps ? .on : .off; menu.addItem(wrap)
        menu.addItem(WorkspaceChoice("Note on line wrapping…") { [weak self] in self?.note("setting","line-wrap") })
        menu.addItem(WorkspaceChoice("Note on this pane…") { [weak self] in self?.note("pane","workspace") })
        if let selected {
            menu.addItem(.separator()); menu.addItem(WorkspaceChoice("Close current tab") { [weak self] in self?.act { try await $0.closeTab(selected) } })
        }
        return menu
    }
}

@MainActor
private final class WorkspaceLanding: NSView {
    let open = WorkspaceButton("Open file",symbol: "folder")
    let new = WorkspaceButton("New scratch",symbol: "square.and.pencil")
    private let heading: NSTextField
    private let caption = NSTextField(labelWithString: "Choose a file or start a scratch draft.")
    init(folder: String) {
        heading = NSTextField(labelWithString: folder)
        super.init(frame: .zero)
        heading.alignment = .center; heading.font = .systemFont(ofSize: 19,weight:.semibold); heading.lineBreakMode = .byTruncatingMiddle
        caption.alignment = .center; caption.textColor = .secondaryLabelColor
        for v in [heading, caption, open, new] { addSubview(v) }
    }
    required init?(coder: NSCoder) { nil }
    override func layout() {
        super.layout(); let w = bounds.width, y = bounds.midY
        heading.frame = NSRect(x: 8,y: y+18,width: max(0,w-16),height: 30)
        caption.frame = NSRect(x: 8,y:y-7,width:max(0,w-16),height:20)
        open.frame = NSRect(x:w/2-104,y:y-48,width:100,height:30)
        new.frame = NSRect(x:w/2,y:y-48,width:108,height:30)
    }
}
