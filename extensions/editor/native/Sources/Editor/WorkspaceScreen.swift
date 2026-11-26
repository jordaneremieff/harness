import AppKit

@MainActor
final class WorkspaceScreen {
    private enum Panel { case files, search, git, notes }
    private enum PathRequest { case newFile, saveAs(CodeEditor) }
    private let api: any EditorAPI
    private let root: String
    private let chrome: WorkspaceChrome
    var view: NSView { chrome }
    private let navigator: ProjectNavigator
    private let collaboration: Collaboration
    private let welcome: NSView
    private var panel: Panel? = .files
    private var buffers: [String: CodeEditor] = [:]
    private var fileOrder: [String] = []
    private var compositions: [String: CompositionPage] = [:]
    private var viewHeaders: [Fields] = []
    private var documents: [Fields] = []
    private var hiddenViews: [String: Int] = [:]
    private var selected: String?
    private var sequence: Int?
    private var pathRequest: PathRequest?
    private var wraps = false
    private var stopped = false
    private var selectionRequest = 0
    private var activeMutation = false
    private var expandedNavigator = false
    private var monitor: Task<Void, Never>?
    private var tasks: [UUID: Task<Void, Never>] = [:]

    init(api: any EditorAPI, root: String) {
        self.api = api
        self.root = root
        chrome = WorkspaceChrome(root: root)
        navigator = ProjectNavigator(api: api)
        collaboration = Collaboration(api: api)
        let start = WorkspaceLanding(folder: URL(fileURLWithPath: root).lastPathComponent)
        welcome = start
        start.open.run = { [weak self] in self?.showNavigator(.files) }
        start.new.run = { [weak self] in self?.command("scratch") }
        chrome.onCommand = { [weak self] in self?.command($0) }
        chrome.onSelect = { [weak self] key in self?.act { try await $0.select(key) } }
        chrome.onNote = { [weak self] in self?.note($0, $1) }
        chrome.onTabMenu = { [weak self] in self?.tabMenu($0) ?? NSMenu() }
        chrome.onMenu = { [weak self] in self?.workspaceMenu() ?? NSMenu() }
        chrome.onCancelPath = { [weak self] in self?.clearPath() }
        chrome.onPath = { [weak self] path in self?.submit(path) }
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
                selected = fileKey(editor.doc); panel = nil; present(reveal: true)
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

    private func fileKey(_ doc: String) -> String { "doc:" + doc }
    private func viewKey(_ id: String) -> String { "view:" + id }
    private var currentEditor: CodeEditor? {
        guard let selected, selected.hasPrefix("doc:") else { return nil }
        return buffers[String(selected.dropFirst(4))]
    }
    private var currentViewID: String? {
        guard let selected, selected.hasPrefix("view:") else { return nil }
        return String(selected.dropFirst(5))
    }
    private func makeBuffer(_ record: Fields) throws -> CodeEditor {
        guard let doc = record["doc"] as? String, record["text"] is String, record["rev"] is Int else {
            throw EditorIssue(code: "response", message: "Pi did not return the requested draft.")
        }
        if let existing = buffers[doc] { return existing }
        let editor = CodeEditor(api: api, record: record)
        buffers[doc] = editor
        fileOrder.append(doc)
        editor.setWrap(wraps)
        editor.onStatus = { [weak self, weak editor] text in
            guard let self, let editor, currentEditor === editor else { return }
            if editor.conflicted || editor.diskConflict { conflictMessage(editor) }
            else { chrome.setMessage(text) }
        }
        editor.onChange = { [weak self, weak editor] in
            guard let self, let editor else { return }
            updateLabels()
            if currentEditor === editor && (editor.conflicted || editor.diskConflict) { conflictMessage(editor) }
        }
        editor.onNote = { [weak self] anchor in self?.compose(anchor) }
        return editor
    }

    func open(_ doc: String, line: Int? = nil, focus: Bool = true) async throws {
        selectionRequest += 1
        let token = selectionRequest
        let editor: CodeEditor
        if let cached = buffers[doc] { editor = cached }
        else {
            let record = try await api.call("read", ["doc":doc])
            guard !stopped else { return }
            editor = try makeBuffer(record)
        }
        guard token == selectionRequest else { updateLabels(); return }
        selected = fileKey(editor.doc)
        if !chrome.showsSideBySide || panel == .notes { panel = nil }
        present(reveal: true)
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
        let composition: CompositionPage
        if let page = compositions[id] { composition = page }
        else {
            composition = CompositionPage(api: api, id: id)
            composition.onOpen = navigator.onOpen
            composition.onNote = { [weak self] in self?.compose($0) }
            compositions[id] = composition
        }
        try await composition.update(revision: rev)
        guard token == selectionRequest, !stopped else { return }
        selected = key
        if !chrome.showsSideBySide || panel == .notes { panel = nil }
        present(reveal: true)
    }

    private func loadState() async throws {
        let state = try await api.call("state", sequence.map { ["since":$0] } ?? [:])
        guard !stopped, state["unchanged"] as? Bool != true else { return }
        guard let next = state["seq"] as? Int, sequence.map({ next >= $0 }) ?? true else { return }
        sequence = next
        documents = state["docs"] as? [Fields] ?? []
        viewHeaders = state["views"] as? [Fields] ?? []
        collaboration.update(state: state)
        updateLabels()
    }
    func synchronise() async throws {
        try await loadState()
        if let currentEditor { try await currentEditor.refresh() }
        if let id = currentViewID, let rev = viewHeaders.first(where: { $0["id"] as? String == id })?["rev"] as? Int {
            try await compositions[id]?.update(revision: rev)
        }
    }
    private func tabs() -> [WorkspaceTab] {
        var result = fileOrder.compactMap { doc -> WorkspaceTab? in
            guard let b = buffers[doc] else { return nil }
            let name = b.title == "Untitled" && doc.hasPrefix("scratch:") ? "Scratch \(doc.dropFirst(8).prefix(4))" : b.title
            let symbol = b.conflicted || b.diskConflict ? "exclamationmark.triangle" : b.dirty ? "circle.fill" : "doc.plaintext"
            return WorkspaceTab(key: fileKey(doc),label: name,detail: doc,symbol: symbol)
        }
        for entry in viewHeaders.reversed() {
            guard let id = entry["id"] as? String, let rev = entry["rev"] as? Int, hiddenViews[id] != rev, let label = entry["title"] as? String else { continue }
            result.append(WorkspaceTab(key: viewKey(id),label: label,detail: "Composed tab: " + label,symbol: "rectangle.3.group"))
        }
        return result
    }
    private func updateLabels(reveal: Bool = false) {
        chrome.setTabs(tabs(), selected: selected, reveal: reveal)
        if let e = currentEditor {
            let status = e.conflicted ? "Local conflict" : e.diskConflict ? "Disk changed" : e.hasPending ? "Local edits" : e.dirty ? "Draft" : "On disk"
            let path = e.doc.hasPrefix("scratch:") ? "Scratch" : e.doc
            chrome.setStatus(path,"\(status)  ·  r\(e.revision)",canSave: !e.conflicted)
        } else if let id = currentViewID, let h = viewHeaders.first(where: { $0["id"] as? String == id }) {
            chrome.setStatus(h["title"] as? String ?? "Composed tab","Composed  ·  r\(h["rev"] as? Int ?? 1)",canSave: false)
        } else { chrome.setStatus(root,"Workspace",canSave: false) }
    }
    private func present(reveal: Bool = false) {
        let page = currentEditor?.view ?? currentViewID.flatMap { compositions[$0]?.view } ?? welcome
        chrome.expandedPanel = expandedNavigator && panel != nil && panel != .notes
        let accessory: NSView? = panel == nil ? nil : panel == .notes ? collaboration.view : navigator.view
        chrome.setContent(page: page, panel: accessory)
        updateLabels(reveal: reveal)
    }
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
            panel = nil; present(); editor.find()
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
            let items = tabs()
            guard let i = items.firstIndex(where: { $0.key == selected }), !items.isEmpty else { return }
            let key = items[(i + (name == "next" ? 1 : items.count - 1)) % items.count].key
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
        if token == selectionRequest { try await open(b.doc) } else { updateLabels() }
    }
    private func save(_ editor: CodeEditor, to path: String?) async throws {
        let previous = editor.doc
        try await editor.save(path: path)
        if editor.doc != previous {
            buffers[previous] = nil; buffers[editor.doc] = editor
            fileOrder = fileOrder.map { $0 == previous ? editor.doc : $0 }
            if selected == fileKey(previous) { selected = fileKey(editor.doc) }
        }
        chrome.setMessage("Saved \(editor.doc).")
        updateLabels()
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
        if key.hasPrefix("doc:"), let editor = buffers[String(key.dropFirst(4))] {
            try await editor.flush()
            guard !editor.hasPending else { chrome.setMessage("The tab changed during close. Your edits are still here."); return }
            buffers[editor.doc] = nil; fileOrder.removeAll { $0 == editor.doc }; editor.stop()
        } else {
            let id = String(key.dropFirst(5)); hiddenViews[id] = viewHeaders.first(where: { $0["id"] as? String == id })?["rev"] as? Int
            compositions[id] = nil
        }
        if key == selected {
            selected = nil
            if let key = tabs().last?.key { try await select(key) } else { showNavigator(.files) }
        }
        present()
    }
    private func tabMenu(_ key: String) -> NSMenu {
        let menu = NSMenu()
        if key.hasPrefix("doc:") {
            let doc = String(key.dropFirst(4))
            menu.addItem(WorkspaceChoice("Note on this tab…") { [weak self] in self?.note("tab",doc) })
            if !doc.hasPrefix("scratch:") { menu.addItem(WorkspaceChoice("Note on this file…") { [weak self] in self?.note("file",doc) }) }
        } else {
            let id = String(key.dropFirst(5)); menu.addItem(WorkspaceChoice("Note on this composed tab…") { [weak self] in self?.note("view",id) })
        }
        menu.addItem(.separator())
        menu.addItem(WorkspaceChoice("Close tab") { [weak self] in self?.act { try await $0.closeTab(key) } })
        return menu
    }
    private func workspaceMenu() -> NSMenu {
        let menu = NSMenu()
        func choice(_ name: String, _ command: String) {
            menu.addItem(WorkspaceChoice(name) { [weak self] in self?.command(command) })
        }
        choice("New scratch   cmd+N","scratch"); choice("New file…   cmd+shift+N","newFile")
        if currentEditor != nil { choice("Save as…   cmd+shift+S","saveAs") }
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
