import AppKit

/// Files that keep the look and the arrangement of the workspace beyond one pane. A missing file
/// keeps its state in memory, as in checks.
struct WorkspaceFiles {
    var settings: URL?
    var layout: URL?
    var appearance: URL?
}

@MainActor
final class WorkspaceScreen {
    private enum Panel: String { case files, search, git, notes }
    private enum PathRequest {
        case newFile, newProjectFile
    }
    /// The tabs on one side of the stage, in the order a person gave them. The arrangement
    /// belongs to this pane: it changes no draft, thread or other participant's view.
    private typealias Group = SessionLayout.Group

    let api: any EditorAPI
    let root: String
    let chrome: WorkspaceChrome
    var view: NSView { chrome }
    let files: WorkspaceFiles
    let registry = CommandRegistry()
    let appearance: PaneAppearance
    let preferences: SettingsStore
    private let palette = CatppuccinPalette.bundled()
    private var keyMonitor: Any?
    private let navigator: ProjectNavigator
    private let collaboration: Collaboration
    let requests: WorkspaceRequests
    private var pendingShow: Fields?
    private let welcome: WorkspaceLanding
    private var panel: Panel? = .files
    private var lastPanel: Panel = .files
    private var buffers: [String: CodeEditor] = [:]
    private(set) var recentDocuments: [String] = []
    var onPanelEditorChange: ((CodeEditor?) -> Void)?
    private weak var panelEditor: CodeEditor?
    private var compositions: [String: CompositionPage] = [:]
    private var viewHeaders: [Fields] = []
    private var documents: [Fields] = []
    private var hiddenViews: [String: Int] = [:]
    private var groups = [Group(id: 0, keys: [], selected: nil)]
    /// The group that commands such as Save and Find apply to.
    private var active = 0
    private var nextGroup = 1
    private var sequence: Int?
    private var stopped = false
    private var selectionRequest = 0
    private var activeMutation = false
    private var expandedNavigator = false
    private var monitor: Task<Void, Never>?
    private var watchTask: Task<Void, Never>?
    private var watchedPaths: [String] = []
    private var watchVersion = 0
    private var pendingDiskEvents: Set<String> = []
    private var pendingWorkspaceEvent = false
    var onWorkspaceEvent: ((Fields) -> Void)?
    var onWorkspaceState: ((Fields) -> Void)?
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var fixedLayout = false
    private var previewKeys: Set<String> = []
    private var closedTabs: [(key: String, group: Int, index: Int, position: WorkspacePosition?)] = []
    private var branch: String?
    private var formats: [String: (ending: String?, bom: Bool?)] = [:]
    private var expectedGitBases: [String: UUID] = [:]
    private var diskConflictAcknowledged: Set<String> = []
    private var confirmation: WorkspaceConfirmation?
    private let makeSavePanel: (String, String, String) -> any WorkspaceSaveChoosing
    private var savePanel: (any WorkspaceSaveChoosing)?
    private weak var pathPrompt: QuickPanel?
    private var layoutReady = false
    private var layoutWrite: Task<Void, Never>?
    private var selectionStatusTimer: Timer?
    private var savedLayout: SessionLayout?
    private var pendingPositions: [String: WorkspacePosition] = [:]
    private var scrollObservers: [String: NSObjectProtocol] = [:]
    private var disconnected = false
    var onDisconnect: ((Bool) -> Void)?
    var isDisconnected: Bool { disconnected }

    /// `defaults` keeps the layout a person chose for this pane between launches.
    init(api: any EditorAPI, root: String, defaults: UserDefaults = .standard, files: WorkspaceFiles = WorkspaceFiles(),
         makeSavePanel: @escaping (String, String, String) -> any WorkspaceSaveChoosing = { WorkspaceSavePanel(root: $0, doc: $1, title: $2) }) {
        self.makeSavePanel = makeSavePanel
        self.api = api
        self.root = root
        self.files = files
        appearance = PaneAppearance(file: files.appearance)
        preferences = SettingsStore(file: files.settings)
        // The look is known before the first view exists, so nothing repaints after it shows.
        WorkspaceStyle.apply(theme: EditorTheme(palette: palette, flavour: appearance.shownFlavour), settings: preferences.base)
        chrome = WorkspaceChrome(root: root, defaults: defaults)
        navigator = ProjectNavigator(api: api)
        collaboration = Collaboration(api: api)
        requests = WorkspaceRequests(api: api)
        welcome = WorkspaceLanding(folder: URL(fileURLWithPath: root).lastPathComponent)
        welcome.files.run = { [weak self] in self?.showNavigator(.files) }
        welcome.new.run = { [weak self] in self?.command("scratch") }
        chrome.onCommand = { [weak self] in self?.command($0) }
        chrome.onSidebar = { [weak self] name in
            guard let self, let panel = Panel(rawValue: name) else { return }
            toggle(panel)
        }
        chrome.onSelect = { [weak self] key in
            guard let self else { return }
            if disconnected { selectCached(key) }
            else { act { try await $0.select(key) } }
        }
        chrome.onClose = { [weak self] key in self?.act { _ = try await $0.closeTab(key) } }
        chrome.onMove = { [weak self] key, drop in self?.move(key, to: drop) }
        chrome.onKeepTab = { [weak self] key in self?.keepPreview(key) }
        chrome.onDropFile = { [weak self] path, drop in self?.act { try await $0.dropFile(path, at: drop) } }
        chrome.onGeometryChange = { [weak self] in self?.scheduleLayoutWrite() }
        chrome.onIndentationMenu = { [weak self] in self?.indentationMenu() ?? NSMenu() }
        chrome.onLanguageMenu = { [weak self] in self?.languageMenu() ?? NSMenu() }
        chrome.onActivate = { [weak self] id in self?.activate(id) }
        chrome.onNote = { [weak self] in self?.note($0, $1) }
        chrome.onTabMenu = { [weak self] in self?.tabMenu($0) ?? NSMenu() }
        chrome.onMenu = { [weak self] in self?.workspaceMenu() ?? NSMenu() }
        chrome.onFitSidebar = { [weak self] in
            guard let self, panel != nil, panel != .notes else { return nil }
            return navigator.fittingWidth
        }
        navigator.onOpen = { [weak self] path, line in self?.act { try await $0.open(path, line: line) } }
        navigator.onPreview = { [weak self] in self?.previewFromTree($0) }
        navigator.onSelectTab = chrome.onSelect
        navigator.onCloseTab = chrome.onClose
        navigator.onLayoutChange = { [weak self] in self?.scheduleLayoutWrite() }
        navigator.onBranch = { [weak self] branch in self?.branch = branch; self?.refreshStatus() }
        navigator.onFileAction = { [weak self] in self?.fileAction($0) }
        navigator.onNote = { [weak self] in self?.note($0, $1) }
        navigator.onNewFile = { [weak self] folder in self?.fileAction(.newFile(folder)) }
        navigator.onExpand = { [weak self] expanded in
            guard let self else { return }; expandedNavigator = expanded
            if expanded { panel = .git }; present()
        }
        navigator.onError = { [weak self] text in
            guard let self, !disconnected else { return }
            chrome.setMessage(text)
        }
        collaboration.onOpen = navigator.onOpen
        collaboration.onError = navigator.onError
        collaboration.onStatus = { [weak self] text in
            guard let self, !disconnected else { return }
            chrome.notify(text)
            act { try await $0.loadState() }
        }
        configureRequests()
        chrome.setWrap(preferences.base.wordWrap)
        appearance.onChange = { [weak self] in self?.applyLook() }
        preferences.onChange = { [weak self] in self?.applyLook() }
        registerWorkspaceCommands()
        registerTextCommands()
        registerPanelCommands()
        registry.onPending = { [weak self] chord in
            guard let self else { return }
            if let chord { chrome.notify("\(chord) was pressed. Waiting for the second key.") } else { chrome.notify("") }
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, !stopped, let window = event.window, window === chrome.window else { return event }
            if let confirmation {
                if event.keyCode == 53 { confirmation.resolve(nil); return nil }
                return event
            }
            let handled = handleWorkspaceKey(event, responder: window.firstResponder) { action in
                window === NSApp.keyWindow && NSApp.sendAction(action, to: nil, from: nil)
            }
            return handled ? nil : event
        }
        Self.setApplicationAppearance(appearance.applicationAppearance)
        present()
    }

    func handleWorkspaceKey(_ event: NSEvent, responder: NSResponder?, sendEditAction: (Selector) -> Bool) -> Bool {
        guard (responder as? NSTextView)?.hasMarkedText() != true else { return false }
        if let action = KeyChord(event: event)?.standardEditAction { return sendEditAction(action) }
        if responder === requests.view.input { return false }
        let field = (responder as? NSTextView)?.isFieldEditor ?? false
        return registry.handle(event, textInput: field, composing: false)
    }

    /// Sets the application appearance only when it changes: each assignment makes AppKit report
    /// a new effective appearance.
    private static func setApplicationAppearance(_ next: NSAppearance?) {
        guard let app = NSApp, app.appearance?.name != next?.name else { return }
        app.appearance = next
    }

    /// Applies the current appearance and settings to every view and open file.
    func applyLook() {
        guard !stopped else { return }
        let theme = EditorTheme(palette: palette, flavour: appearance.shownFlavour)
        Self.setApplicationAppearance(appearance.applicationAppearance)
        WorkspaceStyle.apply(theme: theme, settings: preferences.base)
        for editor in buffers.values { editor.apply(settings: preferences.settings(language: editor.languageID), theme: theme) }
        requests.applyLook()
        chrome.setWrap(preferences.base.wordWrap)
        refresh()
    }

    func start(file: String?) async throws {
        try await loadState(paint: false)
        let restored = await restoreLayout()
        if let file {
            if !restored { panel = nil }
            try await open(file, focus: true)
        }
        switch panel {
        case .files: try await navigator.start()
        case .search: navigator.showSearch()
        case .git: navigator.showGit()
        case .notes: collaboration.showInbox()
        case nil: break
        }
        navigator.refreshGitStatus()
        present(reveal: selected)
        restoreVisiblePositions()
        layoutReady = true
        scheduleLayoutWrite()
        restartWorkspaceEvents()
    }

    func restartWorkspaceEvents() {
        guard layoutReady, !stopped, !disconnected else { return }
        monitor?.cancel()
        updateWatchedFiles(force: true)
        monitor = Task { [weak self, api] in
            var cursor = 0
            var reconnectDelay = 200
            while !Task.isCancelled {
                do {
                    let batch = try await api.call("events", ["since": cursor])
                    guard !Task.isCancelled, let next = batch["cursor"] as? Int, next > 0,
                          let events = batch["events"] as? [Fields] else { return }
                    if cursor == 0, let self {
                        try await loadState()
                        pendingWorkspaceEvent = true
                        pendingDiskEvents.formUnion(watchedPaths)
                        await refreshChangedDrafts()
                    }
                    try await self?.receiveWorkspaceEvents(events)
                    cursor = next
                    reconnectDelay = 200
                } catch {
                    if Task.isCancelled { return }
                    do { try await Task.sleep(for: .milliseconds(reconnectDelay)) } catch { return }
                    reconnectDelay = min(reconnectDelay * 2, 2000)
                }
            }
        }
    }

    private func updateWatchedFiles(force: Bool = false) {
        guard layoutReady, !stopped, !disconnected else { return }
        let docs = Array(buffers.keys.filter { !$0.hasPrefix("scratch:") }.sorted().prefix(2048))
        guard force || docs != watchedPaths else { return }
        watchedPaths = docs
        watchTask?.cancel()
        watchVersion += 1
        watchTask = Task { [api, version = watchVersion] in
            _ = try? await api.call("watch", ["docs": docs, "version": version])
        }
    }

    private func receiveWorkspaceEvents(_ events: [Fields]) async throws {
        guard !events.isEmpty, !stopped, !disconnected else { return }
        var reloadState = false
        for event in events {
            switch event["type"] as? String {
            case "workspace": pendingWorkspaceEvent = true; reloadState = true
            case "members", "request", "attach": reloadState = true
            case "file": if let path = event["path"] as? String { pendingDiskEvents.insert(path) }
            default: break
            }
        }
        if reloadState { try await loadState() }
        await refreshChangedDrafts()
        for event in events where !Task.isCancelled {
            if event["type"] as? String == "attach", let doc = event["doc"] as? String {
                do { try await open(doc, line: event["line"] as? Int, focus: false) }
                catch { showProblem(error, editor: currentEditor) }
            }
            onWorkspaceEvent?(event)
        }
    }

    private func refreshChangedDrafts() async {
        guard !activeMutation, !Task.isCancelled else { return }
        let disk = pendingDiskEvents
        let workspace = pendingWorkspaceEvent
        pendingDiskEvents.removeAll()
        pendingWorkspaceEvent = false
        guard workspace || !disk.isEmpty else { return }
        let headers = Dictionary(documents.compactMap { row in
            (row["doc"] as? String).map { ($0, row) }
        }, uniquingKeysWith: { newest, _ in newest })
        for (doc, editor) in Array(buffers) where !Task.isCancelled && buffers[doc] === editor {
            let header = headers[doc]
            let changed = header.map { $0["rev"] as? Int != editor.revision ||
                (!editor.hasPending && $0["dirty"] as? Bool != editor.dirty) } ?? workspace
            guard disk.contains(doc) || workspace && changed else { continue }
            do { try await refreshDraft(editor) }
            catch { if editor === currentEditor { showProblem(error, editor: editor) } }
        }
        if !disk.isEmpty {
            navigator.refreshFiles()
            navigator.refreshGitStatus()
        }
        if workspace {
            do { try await refreshCompositions() }
            catch { showProblem(error, editor: currentEditor) }
        }
    }

    func prepareToClose() async -> Bool {
        if disconnected { return true }
        guard !activeMutation, confirmation == nil else {
            chrome.setMessage("Finish the current file operation before closing Editor."); return false
        }
        if requests.hasUnpostedText {
            requests.resumeDraft()
            chrome.notify("Send or clear the unsent request before closing Editor.")
            return false
        }
        if collaboration.hasUnpostedText {
            panel = .notes; present(); collaboration.showInbox()
            chrome.setMessage("Post or clear your unsent message before closing Editor."); return false
        }
        if pathPrompt?.superview != nil {
            chrome.setMessage("Submit or cancel the file path before closing Editor."); return false
        }
        for editor in Array(buffers.values) {
            do { try await editor.flush() }
            catch {
                let key = fileKey(editor.doc)
                if let index = groupIndex(of: key) { groups[index].selected = key; active = groups[index].id }
                panel = nil; present(reveal: key)
                showProblem(error, editor: editor); return false
            }
        }
        guard !activeMutation, pathPrompt?.superview == nil, !collaboration.hasUnpostedText,
              buffers.values.allSatisfy({ !$0.hasPending }) else {
            chrome.setMessage("The workspace changed during close. Your edits are still here.")
            return false
        }
        writeLayout()
        return true
    }

    func stop() {
        writeLayout()
        stopped = true
        savePanel?.cancel()
        confirmation?.resolve(nil)
        layoutWrite?.cancel(); layoutWrite = nil
        selectionStatusTimer?.invalidate(); selectionStatusTimer = nil
        previewChain?.cancel(); previewChain = nil
        for observer in scrollObservers.values { NotificationCenter.default.removeObserver(observer) }
        scrollObservers.removeAll()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        monitor?.cancel(); monitor = nil
        watchTask?.cancel(); watchTask = nil
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        requests.stop(); collaboration.stop(); navigator.stop()
        for editor in buffers.values { editor.stop() }
    }

    private func act(_ body: @escaping @MainActor (WorkspaceScreen) async throws -> Void) {
        guard !stopped, !disconnected else { return }
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
    var currentEditor: CodeEditor? { editor(for: selected) }

    /// Puts a key in a group when none holds it, and returns the index of its group. A page that
    /// sends the person to a file stays on show when the stage has a second group: the file
    /// goes to that group, also when it was a tab beside the page.
    private func place(_ key: String, awayFrom source: String? = nil) -> Int {
        let beside = groups.count > 1 ? source.flatMap(groupIndex(of:)).map { ($0 + 1) % groups.count } : nil
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
        updateWatchedFiles()
        recordFormat(record, for: doc)
        observePosition(of: editor)
        refreshGitBase(editor)
        editor.apply(settings: preferences.settings(language: editor.languageID), theme: WorkspaceStyle.theme)
        editor.onStatus = { [weak self, weak editor] text in
            guard let self, let editor, currentEditor === editor, !disconnected else { return }
            if editor.conflicted || editor.diskConflict { conflictMessage(editor) }
            else { chrome.setMessage(text) }
        }
        editor.onChange = { [weak self, weak editor] in
            guard let self, let editor else { return }
            if editor.hasPending { keepPreview(fileKey(editor.doc)) }
            refresh()
            if !editor.diskConflict { diskConflictAcknowledged.remove(editor.doc) }
            if currentEditor === editor && (editor.conflicted || editor.diskConflict) { conflictMessage(editor) }
            if !editor.hasPending, let event = pendingShow {
                pendingShow = nil
                showAgentLocation(event)
            }
        }
        editor.onSelectionChange = { [weak self, weak editor] in
            guard let self, let editor, currentEditor === editor else { return }
            scheduleSelectionStatus()
            editor.scroll.repositionCollaboration()
        }
        editor.onNote = { [weak self] anchor in self?.compose(anchor) }
        requests.bind(editor)
        editor.onReviewChange = { [weak editor] in
            guard let editor else { return }
            editor.scroll.updateChangeNotice(editor)
        }
        editor.textView.onFind = { [weak self] in self?.registry.run("find.find") }
        return editor
    }

    func open(_ doc: String, line: Int? = nil, focus: Bool = true, awayFrom source: String? = nil) async throws {
        try await openDocument(doc, line: line, focus: focus, awayFrom: source, preservePreview: false)
    }

    private func openDocument(_ doc: String, line: Int? = nil, focus: Bool = true, awayFrom source: String? = nil,
                              preservePreview: Bool) async throws {
        selectionRequest += 1
        let token = selectionRequest
        let editor: CodeEditor
        if let cached = buffers[doc] { editor = cached }
        else {
            let record = try await api.call("read", ["doc":doc])
            guard !stopped, token == selectionRequest else { return }
            editor = try makeBuffer(record)
        }
        let key = fileKey(editor.doc)
        if !preservePreview { previewKeys.remove(key) }
        if let source, groupIndex(of: source) != nil, groups.count == 1 {
            let chosen = fixedLayout
            chooseArrangement(chrome.fitsSecondGroup ? .columns2 : .rows2)
            fixedLayout = chosen
        }
        let index = place(key, awayFrom: source)
        groups[index].selected = key
        active = groups[index].id
        if !chrome.showsSideBySide || panel == .notes { panel = nil }
        present(reveal: key)
        if let line { editor.go(line: line) }
        if focus {
            recentDocuments.removeAll { $0 == editor.doc }
            recentDocuments.insert(editor.doc, at: 0)
            if recentDocuments.count > 40 { recentDocuments.removeLast() }
            editor.focus()
        }
        if editor.conflicted || editor.diskConflict { conflictMessage(editor) }
    }

    private func select(_ key: String, focus: Bool = true) async throws {
        if key.hasPrefix("doc:") {
            try await openDocument(String(key.dropFirst(4)), focus: focus, preservePreview: true)
            return
        }
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

    private func selectCached(_ key: String) {
        guard let index = groupIndex(of: key) else { return }
        groups[index].selected = key
        active = groups[index].id
        if !chrome.showsSideBySide { panel = nil }
        present(reveal: key)
        currentEditor?.focus()
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
        scheduleLayoutWrite()
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
        case .beside(let id, let trailing), .stacked(let id, let trailing):
            guard groups.count < 4, from != groups.firstIndex(where: { $0.id == id }) || groups[from].keys.count > 1 || fixedLayout,
                  let anchor = groups.firstIndex(where: { $0.id == id }) else { return }
            let vertical: Bool
            if case .stacked = drop { vertical = true } else { vertical = false }
            groups[from].keys.remove(at: place)
            if wasSelected { groups[from].selected = neighbour(in: from, at: place) }
            groups.insert(Group(id: nextGroup, keys: [key], selected: key), at: trailing ? anchor + 1 : anchor)
            active = nextGroup
            nextGroup += 1
            matchArrangementToGroups(preferRows: vertical)
        }
        present(reveal: key)
        // A page that changes its group leaves the responder chain for a moment.
        if typing { moved?.focus() }
    }

    private func matchArrangementToGroups(preferRows: Bool? = nil) {
        guard chrome.arrangement.count != groups.count else { return }
        let rows = preferRows ?? (chrome.arrangement == .rows2 || chrome.arrangement == .rows3)
        chrome.arrangement = chrome.arrangement.expanding(to: groups.count, preferRows: rows)
    }

    func chooseArrangement(_ arrangement: WorkspaceArrangement) {
        guard !activeMutation, confirmation == nil else { return }
        let focus = currentEditor?.hasFocus == true ? currentEditor : nil
        fixedLayout = true
        let keep = arrangement.count
        if keep < groups.count {
            let overflow = Array(groups.dropFirst(keep))
            let activeKey = selected
            groups.removeLast(groups.count - keep)
            groups[keep - 1].keys += overflow.flatMap(\.keys)
            if !groups.contains(where: { $0.id == active }) {
                active = groups[keep - 1].id
                groups[keep - 1].selected = activeKey ?? groups[keep - 1].selected
            }
            for i in groups.indices where groups[i].selected == nil { groups[i].selected = groups[i].keys.first }
        }
        while groups.count < keep {
            groups.append(Group(id: nextGroup, keys: [], selected: nil))
            nextGroup += 1
        }
        chrome.arrangement = arrangement
        present(reveal: selected)
        focus?.focus()
    }

    private func dropFile(_ path: String, at drop: WorkspaceDrop) async throws {
        try await open(path)
        guard let editor = currentEditor, editor.doc == path else { return }
        let key = fileKey(editor.doc)
        if groups.count == 1, groups[0].keys.count == 1 {
            switch drop {
            case .slot: break
            case .beside(_, let trailing), .stacked(_, let trailing):
                let vertical: Bool
                if case .stacked = drop { vertical = true } else { vertical = false }
                chooseArrangement(vertical ? .rows2 : .columns2)
                if trailing { move(key, to: .slot(group: groups[1].id, index: 0)) }
                return
            }
        }
        move(key, to: drop)
    }

    private func loadState(paint: Bool = true) async throws {
        let state = try await api.call("state", sequence.map { ["since":$0] } ?? [:])
        guard !stopped, let next = state["seq"] as? Int, sequence.map({ next >= $0 }) ?? true else { return }
        defer { onWorkspaceState?(state) }
        guard state["unchanged"] as? Bool != true else { return }
        sequence = next
        documents = state["docs"] as? [Fields] ?? []
        viewHeaders = state["views"] as? [Fields] ?? []
        collaboration.update(state: state)
        if paint { refresh() }
    }
    func flushOpenProjectDrafts() async throws {
        for editor in Array(buffers.values) where !editor.doc.hasPrefix("scratch:") && editor.hasPending {
            try await editor.flush()
            if editor.hasPending {
                throw EditorIssue(code: "pending", message: "Finish the active edit before replacing project text.")
            }
        }
    }

    func refreshProjectDrafts(_ documents: [String]) async throws {
        for doc in documents { try await buffers[doc]?.refresh() }
        try await loadState()
    }

    func synchronise() async throws {
        try await loadState()
        if !activeMutation { for editor in Array(buffers.values) { try await refreshDraft(editor) } }
        try await refreshCompositions()
    }

    private func refreshDraft(_ editor: CodeEditor) async throws {
        let rev = editor.revision, conflict = editor.diskConflict
        try await editor.refresh()
        if editor.diskConflict != conflict || (editor.revision != rev && !editor.dirty) {
            refreshGitBase(editor)
            refreshFormat(of: editor)
        }
    }

    private func refreshCompositions() async throws {
        for key in groups.compactMap(\.selected) {
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
        if !fixedLayout, groups.count > 1, let keep = groups.first(where: { !$0.keys.isEmpty }) ?? groups.first {
            groups.removeAll { $0.keys.isEmpty && $0.id != keep.id }
            matchArrangementToGroups()
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

    private func tab(for key: String, repeatedNames: Set<String>) -> WorkspaceTab? {
        if let editor = editor(for: key) {
            let doc = editor.doc
            var name = editor.title == "Untitled" && doc.hasPrefix("scratch:") ? "Scratch \(doc.dropFirst(8).prefix(4))" : editor.title
            if repeatedNames.contains(editor.title), !doc.hasPrefix("scratch:") {
                let parent = (doc as NSString).deletingLastPathComponent
                name += parent.isEmpty ? "  ·  /" : "  ·  \(parent)"
            }
            let warns = editor.conflicted || editor.diskConflict
            let icon = WorkspaceFileIcon.forPath(doc)
            return WorkspaceTab(key: key, label: name, detail: doc, symbol: warns ? "exclamationmark.triangle" : icon.symbol,
                                unsaved: editor.dirty, warns: warns, preview: previewKeys.contains(key), colourRole: icon.role)
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
        var seen: Set<String> = [], repeated: Set<String> = []
        for editor in buffers.values where !seen.insert(editor.title).inserted { repeated.insert(editor.title) }
        let shown = groups.map { group in
            WorkspaceGroup(id: group.id, tabs: group.keys.compactMap { tab(for: $0, repeatedNames: repeated) },
                           selected: group.selected, page: page(for: group))
        }
        chrome.keepsEmptyGroups = fixedLayout
        chrome.setGroups(shown, active: active, reveal: reveal)
        navigator.showOpenTabs(shown.flatMap(\.tabs), selected: selected)
        refreshStatus()
        restoreVisiblePositions()
        let editor = currentEditor
        if editor !== panelEditor {
            panelEditor = editor
            onPanelEditorChange?(editor)
        }
    }
    private func present(reveal: String? = nil) {
        if let panel { lastPanel = panel }
        chrome.expandedPanel = expandedNavigator && panel != nil && panel != .notes
        welcome.listsFiles = panel == .files
        refresh(reveal: reveal)
        chrome.setSidebar(panel == nil ? nil : panel == .notes ? collaboration.view : navigator.view, named: panel?.rawValue)
        scheduleLayoutWrite()
    }

    // MARK: Session

    private func restoreLayout() async -> Bool {
        guard preferences.base.restoreSession, let path = files.layout,
              let saved = try? SessionLayout.read(path), saved.groups.count == saved.arrangement.count,
              Set(saved.groups.map(\.id)).count == saved.groups.count,
              saved.groups.allSatisfy({ (0...1_000_000).contains($0.id) }) else { return false }
        let viewIDs = Set(viewHeaders.compactMap { $0["id"] as? String })
        var seen: Set<String> = []
        var restored: [Group] = []
        for group in saved.groups {
            var keys: [String] = []
            for key in group.keys where seen.insert(key).inserted {
                if let id = viewID(for: key), viewIDs.contains(id) { keys.append(key); continue }
                guard key.hasPrefix("doc:"), key.count > 4 else { continue }
                let doc = String(key.dropFirst(4))
                do {
                    let record = try await api.call("read", ["doc": doc])
                    guard !stopped else { return false }
                    let editor = try makeBuffer(record)
                    let canonical = fileKey(editor.doc)
                    if canonical != key, !seen.insert(canonical).inserted { continue }
                    whenRestoringPosition(saved.positions[key], for: canonical)
                    if saved.previewKeys.contains(key), !editor.dirty { previewKeys.insert(canonical) }
                    keys.append(canonical)
                } catch let issue as EditorIssue where issue.code == "not_found" {
                    continue
                } catch {
                    if (error as? URLError)?.code == .cannotConnectToHost { return false }
                    chrome.notify("Editor skipped \(doc): \(error.localizedDescription)")
                }
            }
            let selection = group.selected.flatMap { keys.contains($0) ? $0 : nil } ?? keys.first
            restored.append(Group(id: group.id, keys: keys, selected: selection))
        }
        groups = restored
        nextGroup = (groups.map(\.id).max() ?? 0) + 1
        active = groups.contains(where: { $0.id == saved.active }) ? saved.active : groups[0].id
        panel = saved.sidebar.flatMap(Panel.init(rawValue:))
        lastPanel = Panel(rawValue: saved.lastSidebar) ?? .files
        fixedLayout = saved.fixedLayout
        hiddenViews = saved.hiddenViews.filter { viewIDs.contains($0.key) }
        chrome.arrangement = saved.arrangement
        chrome.splitWeights = saved.splitWeights.map { $0.isFinite ? min(1, max(0, $0)) : 0.5 }
        chrome.sidebarChoice = saved.sidebarWidth.flatMap { $0.isFinite && $0 >= 1 && $0 <= 10_000 ? $0 : nil }
        navigator.restoreFolders(saved.expandedFolders)
        let selectedViews = groups.compactMap { viewID(for: $0.selected) }
        for id in selectedViews {
            guard let rev = viewHeaders.first(where: { $0["id"] as? String == id })?["rev"] as? Int else { continue }
            try? await composition(id).update(revision: rev)
        }
        savedLayout = saved
        return true
    }

    private func observePosition(of editor: CodeEditor) {
        let doc = editor.doc
        let clip = editor.scroll.contentView
        clip.postsBoundsChangedNotifications = true
        scrollObservers[doc] = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleLayoutWrite() }
        }
    }

    private func unobservePosition(of doc: String) {
        if let observer = scrollObservers.removeValue(forKey: doc) { NotificationCenter.default.removeObserver(observer) }
    }

    private func whenRestoringPosition(_ position: WorkspacePosition?, for key: String) {
        pendingPositions[key] = position
    }

    private func restoreVisiblePositions() {
        guard !pendingPositions.isEmpty else { return }
        for key in groups.compactMap(\.selected) {
            guard let editor = editor(for: key), editor.view.window != nil, !editor.view.isHiddenOrHasHiddenAncestor,
                  editor.view.bounds.width > 0, editor.view.bounds.height > 0,
                  let position = pendingPositions.removeValue(forKey: key) else { continue }
            position.apply(to: editor)
        }
    }

    private func scheduleLayoutWrite() {
        guard layoutReady, files.layout != nil, preferences.base.restoreSession, !stopped else { return }
        layoutWrite?.cancel()
        layoutWrite = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            self?.writeLayout()
        }
    }

    private func writeLayout() {
        guard layoutReady, preferences.base.restoreSession, let path = files.layout else { return }
        var groups = groups
        if let key = transient?.key, previewKeys.contains(key), let index = groups.firstIndex(where: { $0.keys.contains(key) }) {
            groups[index].keys.removeAll { $0 == key }
            if groups[index].selected == key {
                groups[index].selected = transient?.previous.flatMap { groups[index].keys.contains($0) ? $0 : nil } ?? groups[index].keys.first
            }
        }
        let keys = groups.flatMap(\.keys)
        let positions = Dictionary(uniqueKeysWithValues: keys.compactMap { key in
            (pendingPositions[key] ?? editor(for: key).map(WorkspacePosition.init)).map { (key, $0) }
        })
        let state = SessionLayout(arrangement: chrome.arrangement, fixedLayout: fixedLayout, groups: groups, active: active,
                                  sidebar: panel?.rawValue, lastSidebar: lastPanel.rawValue, sidebarWidth: chrome.sidebarChoice,
                                  expandedFolders: navigator.expandedFolders,
                                  splitWeights: chrome.splitWeights, positions: positions, previewKeys: keys.filter(previewKeys.contains), hiddenViews: hiddenViews)
        guard state != savedLayout else { return }
        do { try state.write(path); savedLayout = state }
        catch { chrome.notify("Editor could not store this workspace layout.") }
    }

    // MARK: Status

    private func recordFormat(_ record: Fields, for doc: String) {
        formats[doc] = (record["eol"] as? String, record["bom"] as? Bool)
    }

    private func refreshFormat(of editor: CodeEditor) {
        let doc = editor.doc
        let rev = editor.revision
        act { [weak editor] screen in
            let record = try await screen.api.call("read", ["doc": doc, "ifRev": rev])
            guard let editor, screen.buffers[doc] === editor else { return }
            screen.recordFormat(record, for: doc)
            if screen.currentEditor === editor { screen.refreshStatus() }
        }
    }

    private func refreshGitBase(_ editor: CodeEditor) {
        let doc = editor.doc
        guard !doc.hasPrefix("scratch:") else { return }
        let token = UUID()
        expectedGitBases[doc] = token
        act { [weak editor] screen in
            let data = try? await screen.api.call("git", ["doc": doc, "base": true])
            guard let editor, screen.buffers[doc] === editor, screen.expectedGitBases[doc] == token else { return }
            editor.setBaseText(data?["text"] as? String)
            screen.expectedGitBases.removeValue(forKey: doc)
        }
    }

    private func scheduleSelectionStatus() {
        guard selectionStatusTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.selectionStatusTimer = nil
                self.refreshStatus()
                self.scheduleLayoutWrite()
            }
        }
        selectionStatusTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func refreshStatus() {
        if let editor = currentEditor {
            let status = disconnected ? "Service stopped" : editor.conflicted ? "Local conflict" : editor.diskConflict ? "Disk changed" : editor.hasPending ? "Local edits" : editor.dirty ? "Draft" : "Saved"
            let caret = editor.caretPosition
            var at = "Line \(caret.line), Column \(caret.column)"
            let selections = editor.selectionCount
            if selections > 1 { at += "  ·  \(selections) selections" }
            if let count = editor.selectedCharacterCount, count > 0 { at += "  ·  \(count) selected" }
            let indentation = editor.indentation
            let ending: String? = switch formats[editor.doc]?.ending {
            case "\r\n": "CRLF"
            case "\n": "LF"
            case "\r": "CR"
            default: nil
            }
            let encoding = formats[editor.doc]?.bom.map { $0 ? "UTF-8 BOM" : "UTF-8" }
            let format = [ending, encoding].compactMap { $0 }.joined(separator: "  ·  ")
            chrome.setEditorStatus(branch: branch, position: at, compactPosition: "Ln \(caret.line), Col \(caret.column)", indentation: "\(indentation.spaces ? "Spaces" : "Tabs"): \(indentation.width)", language: editor.languageName, format: format)
            chrome.setStatus("", status, canSave: !disconnected && !editor.conflicted)
        } else if let id = viewID(for: selected), let h = viewHeaders.first(where: { $0["id"] as? String == id }) {
            chrome.setEditorStatus(branch: branch, position: h["title"] as? String ?? "Composed tab", indentation: nil, language: nil, format: "")
            chrome.setStatus("", "Composed", canSave: false)
        } else {
            chrome.setEditorStatus(branch: branch, position: "", indentation: nil, language: nil, format: "")
            chrome.setStatus("", disconnected ? "Service stopped" : "", canSave: false)
        }
    }

    private func indentationMenu() -> NSMenu {
        let menu = NSMenu()
        guard let editor = currentEditor else { return menu }
        let indentation = editor.indentation
        func choice(_ name: String, checked: Bool = false, _ run: @escaping (CodeEditor) -> Void) {
            let item = WorkspaceChoice(name) { [weak self, weak editor] in
                guard let self, let editor else { return }
                run(editor); refreshStatus(); editor.focus()
            }
            item.state = checked ? .on : .off
            menu.addItem(item)
        }
        choice("Indent with spaces", checked: indentation.spaces) { $0.chooseIndentation(spaces: true, width: indentation.width) }
        choice("Indent with tabs", checked: !indentation.spaces) { $0.chooseIndentation(spaces: false, width: indentation.width) }
        menu.addItem(.separator())
        for width in 1...8 {
            choice("Width: \(width)", checked: indentation.width == width) { $0.chooseIndentation(spaces: indentation.spaces, width: width) }
        }
        menu.addItem(.separator())
        choice("Convert indentation to spaces") { $0.convertIndentation(spaces: true) }
        choice("Convert indentation to tabs") { $0.convertIndentation(spaces: false) }
        return menu
    }

    private func languageMenu() -> NSMenu {
        let menu = NSMenu()
        guard let editor = currentEditor else { return menu }
        func choice(_ title: String, id: String?) {
            let item = WorkspaceChoice(title) { [weak self, weak editor] in
                guard let self, let editor else { return }
                editor.chooseLanguage(id); editor.apply(settings: preferences.settings(language: editor.languageID), theme: WorkspaceStyle.theme)
                refreshStatus(); editor.focus()
            }
            item.state = id != nil && title == editor.languageName ? .on : .off
            menu.addItem(item)
        }
        choice("Detect from file", id: nil)
        menu.addItem(.separator())
        for language in SyntaxLanguage.languages.sorted(by: { $0.displayName < $1.displayName }) {
            choice(language.displayName, id: language.id)
        }
        return menu
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
    func revealEditorForFind() {
        if panel != nil && !chrome.showsSideBySide { panel = nil; present() }
    }

    func command(_ name: String) {
        guard confirmation == nil else { return }
        switch name {
        case "sidebar": toggle(panel ?? lastPanel)
        case "files": toggle(.files)
        case "refreshFiles": navigator.refreshFiles()
        case "search": showNavigator(.search)
        case "searchContents": selectionRequest += 1; panel = .search; present(); navigator.showSearch(contents: true)
        case "git": showNavigator(.git)
        case "find": registry.run("find.find")
        case "wrap":
            preferences.set("wordWrap", .flag(!preferences.base.wordWrap))
        case "notes": toggle(.notes)
        case "scratch": mutate { try await $0.create(nil) }
        case "newFile": requestPath(.newFile)
        case "saveAs": if let e = currentEditor, !e.conflicted { requestSave(e) }
        case "saveAll":
            mutate { screen in
                let editors = screen.openDocuments.compactMap { screen.buffers[$0] }.filter(\.dirty)
                for editor in editors where !editor.doc.hasPrefix("scratch:") && !editor.diskConflict && !editor.conflicted {
                    try await screen.save(editor, to: nil)
                }
                if editors.contains(where: \.dirty) { screen.chrome.notify("Some drafts need Save As or a conflict decision.") }
            }
        case "reopen": act { try await $0.reopenTab() }
        case "save":
            guard let e = currentEditor else { return }
            if e.conflicted { conflictMessage(e) }
            else if e.diskConflict { act { try await $0.resolveDiskChange(e) } }
            else if e.doc.hasPrefix("scratch:") { requestSave(e) }
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
        guard !activeMutation, !stopped, !disconnected else { return }
        activeMutation = true
        act { screen in
            defer {
                screen.activeMutation = false
                if screen.pendingWorkspaceEvent || !screen.pendingDiskEvents.isEmpty {
                    screen.act { await $0.refreshChangedDrafts() }
                }
            }
            try await body(screen)
        }
    }
    private func requestPath(_ request: PathRequest, start: String = "") {
        switch request {
        case .newFile, .newProjectFile:
            let disk: Bool
            if case .newProjectFile = request { disk = true } else { disk = false }
            promptPath(action: "Create file", start: start) { [weak self] path in try await self?.create(path, publish: disk) }
        }
    }

    private func requestSave(_ editor: CodeEditor) {
        mutate { _ = try await $0.saveWithPanel(editor) }
    }

    private func saveWithPanel(_ editor: CodeEditor) async throws -> Bool {
        guard savePanel == nil, buffers[editor.doc] === editor, let window = chrome.window else { return false }
        let panel = makeSavePanel(root, editor.doc, editor.title)
        savePanel = panel
        defer {
            savePanel = nil
            if currentEditor === editor, !stopped, !disconnected { editor.focus() }
        }
        guard let target = try await panel.choose(in: window), !stopped, !disconnected else { return false }
        savePanel = nil
        if target.path == editor.doc {
            try await save(editor, to: nil)
        } else {
            let other = buffers[target.path]
            if let other, other.dirty || other.conflicted {
                throw EditorIssue(code: "conflict", message: "The destination has unsaved changes. Both drafts are intact.")
            }
            try await withFrozenInput(other.map { [$0] } ?? []) {
                try await save(editor, to: target.path, replacement: target.replacement)
            }
        }
        return true
    }

    func promptPath(action: String, start: String = "", run: @escaping @MainActor (String) async throws -> Void) {
        guard confirmation == nil, !stopped, !disconnected else { return }
        guard pathPrompt?.superview == nil else { chrome.notify("Submit or cancel the current path first."); return }
        pathPrompt = showPathPrompt(action: action, start: start) { [weak self] path in
            guard let self, !stopped, !disconnected else { throw CancellationError() }
            guard !activeMutation else { throw EditorIssue(code: "busy", message: "Finish the current file operation first.") }
            activeMutation = true
            defer { activeMutation = false }
            try await run(path)
        }
    }

    // MARK: Transient tabs

    var openDocuments: [String] {
        groups.flatMap(\.keys).compactMap { editor(for: $0)?.doc }
    }

    private var transient: (key: String?, previous: String?, group: Int, panel: Panel?)?
    private var previewChain: Task<Void, Never>?
    private var previewRequest = 0

    /// Shows a file without moving the keyboard. A later preview supersedes an in-flight read.
    func showTransient(_ doc: String, line: Int?, onPreview: (@MainActor (Result<CodeEditor, Error>) -> Void)? = nil) {
        enqueueFilePreview(doc, line: line, temporary: true, onPreview: onPreview)
    }

    func endTransient(commit: Bool, focus: Bool = true) {
        if !commit { previewRequest += 1 }
        enqueuePreview { screen in
            guard let current = screen.transient else {
                if focus { screen.currentEditor?.focus() }
                return
            }
            screen.transient = nil
            if commit {
                if let key = current.key, let editor = screen.editor(for: key) { try await screen.open(editor.doc, focus: focus) }
                return
            }
            if let key = current.key, screen.previewKeys.contains(key) { screen.removeTab(key, remember: false) }
            if let previous = current.previous, let home = screen.groupIndex(of: previous) {
                screen.groups[home].selected = previous
                screen.active = screen.groups[home].id
            } else if screen.groups.contains(where: { $0.id == current.group }) { screen.active = current.group }
            screen.panel = current.panel
            screen.present(reveal: current.previous)
            if focus { screen.currentEditor?.focus() }
        }
    }

    func previewFromTree(_ doc: String) { enqueueFilePreview(doc, line: nil, temporary: false) }

    private func enqueueFilePreview(_ doc: String, line: Int?, temporary: Bool,
                                    onPreview: (@MainActor (Result<CodeEditor, Error>) -> Void)? = nil) {
        previewRequest += 1
        let request = previewRequest, selection = selectionRequest
        enqueuePreview { screen in
            guard request == screen.previewRequest, selection == screen.selectionRequest else { return }
            if temporary, screen.transient == nil { screen.transient = (nil, screen.selected, screen.active, screen.panel) }
            do {
                guard let key = try await screen.preview(doc, line: line, request: request, selection: selection) else { return }
                if temporary { screen.transient?.key = key }
                if let editor = screen.editor(for: key) { onPreview?(.success(editor)) }
            } catch {
                if request == screen.previewRequest, selection == screen.selectionRequest {
                    if let onPreview { onPreview(.failure(error)) } else { throw error }
                }
            }
        }
    }

    private func enqueuePreview(_ step: @escaping @MainActor (WorkspaceScreen) async throws -> Void) {
        let previous = previewChain
        let next = Task { [weak self] in
            await previous?.value
            guard let self, !stopped, !disconnected, !Task.isCancelled else { return }
            do { try await step(self) }
            catch { if !Task.isCancelled { showProblem(error, editor: currentEditor) } }
        }
        previewChain = next
        Task { [weak self] in
            await next.value
            if let self, previewChain == next { previewChain = nil }
        }
    }

    private func preview(_ doc: String, line: Int?, request: Int, selection: Int) async throws -> String? {
        let home = active
        let editor: CodeEditor
        if let existing = buffers[doc] { editor = existing }
        else {
            let record = try await api.call("read", ["doc": doc])
            guard !stopped, request == previewRequest, selection == selectionRequest, home == active else { return nil }
            editor = try makeBuffer(record)
        }
        let key = fileKey(editor.doc)
        let alreadyOpen = groupIndex(of: key) != nil
        if !alreadyOpen, !editor.dirty { previewKeys.insert(key) }
        let index = place(key)
        let others = groups[index].keys.filter { $0 != key && previewKeys.contains($0) }
        groups[index].selected = key
        active = groups[index].id
        for other in others { removeTab(other, remember: false) }
        if !chrome.showsSideBySide { panel = nil }
        present(reveal: key)
        if let line { editor.go(line: line) }
        return key
    }

    private func keepPreview(_ key: String) {
        guard previewKeys.remove(key) != nil else { return }
        refresh()
        scheduleLayoutWrite()
    }

    private func create(_ path: String?, publish: Bool = false) async throws {
        let token = selectionRequest
        let record = try await api.call("new", path.map { ["path":$0] } ?? [:])
        guard !stopped else { return }
        let b = try makeBuffer(record)
        if token == selectionRequest { try await open(b.doc) } else { _ = place(fileKey(b.doc)); present() }
        if publish { try await save(b, to: nil) }
        if path != nil { navigator.refreshFiles() }
    }
    private func save(_ editor: CodeEditor, to path: String?, replacement: String? = nil) async throws {
        let previous = editor.doc
        try await editor.save(path: path, replacement: replacement)
        if editor.doc != previous {
            if let other = buffers[editor.doc], other !== editor { removeTab(fileKey(editor.doc), remember: false) }
            remapDocument(previous, to: editor.doc, editor: editor)
        }
        refreshGitBase(editor)
        refreshFormat(of: editor)
        navigator.refreshFiles()
        chrome.notify("Saved \(editor.doc).")
        refresh()
        scheduleLayoutWrite()
    }
    private func conflictMessage(_ editor: CodeEditor) {
        if editor.conflicted {
            chrome.setMessage("The shared draft changed. Your local text is intact.",action: "Keep both") { [weak self, weak editor] in
                guard let self, let editor else { return }; keepBoth(editor)
            }
        } else if editor.diskConflict, !diskConflictAcknowledged.contains(editor.doc) {
            chrome.setMessage("The file on disk changed. Your draft is intact.", action: "Review changes…") { [weak self, weak editor] in
                guard let self, let editor else { return }
                act { screen in try await screen.resolveDiskChange(editor) }
            }
        }
    }
    private func showProblem(_ error: Error, editor: CodeEditor?) {
        if (error as? URLError)?.code == .cannotConnectToHost {
            connectionClosed()
        } else if let editor, editor.conflicted || editor.diskConflict && !diskConflictAcknowledged.contains(editor.doc) {
            conflictMessage(editor)
        } else { chrome.setMessage(error.localizedDescription) }
    }

    private func connectionClosed() {
        guard !disconnected else { return }
        disconnected = true
        monitor?.cancel(); monitor = nil
        savePanel?.cancel()
        watchTask?.cancel(); watchTask = nil
        confirmation?.resolve(nil)
        let unsent = collaboration.hasUnpostedText || buffers.values.contains(where: \.hasPending)
        writeLayout()
        onDisconnect?(unsent)
    }

    func showDisconnected(problem: String, close: @escaping () -> Void) {
        connectionClosed()
        for editor in buffers.values { editor.stop(); editor.textView.isEditable = false }
        requests.goOffline()
        collaboration.goOffline()
        refreshStatus()
        chrome.setMessage("Copy any unsent text before you close this pane. \(problem)",
                          action: "Close Editor", run: close)
    }

    private func ask(_ title: String, detail: String, choices: [WorkspaceConfirmation.Choice]) async -> Int? {
        guard confirmation == nil, !stopped, !disconnected else { return nil }
        return await withCheckedContinuation { continuation in
            let card = WorkspaceConfirmation(title: title, detail: detail, choices: choices) { [weak self] result in
                if let self {
                    chrome.dismissOverlay(confirmation)
                    confirmation = nil
                }
                continuation.resume(returning: result)
            }
            confirmation = card
            chrome.presentOverlay(card, placement: .top) { [weak card] in card?.fitting(in: $0) ?? .zero }
            chrome.window?.makeFirstResponder(card)
        }
    }

    private func resolveDiskChange(_ editor: CodeEditor) async throws {
        let answer = await ask("File changed on disk", detail: editor.doc,
                               choices: [.init("Reload from disk", role: .destructive), .init("Save as…"), .init("Keep my draft", role: .primary)])
        guard buffers[editor.doc] === editor else { return }
        switch answer {
        case 0: mutate { screen in
            let removed = try await screen.discard(editor)
            if removed { screen.removeTab(screen.fileKey(editor.doc)); screen.present() }
            screen.chrome.clearMessage()
            screen.currentEditor?.focus()
        }
        case 1: requestSave(editor)
        case 2: diskConflictAcknowledged.insert(editor.doc); chrome.clearMessage(); editor.focus()
        default: editor.focus()
        }
    }

    private func withFrozenInput<T>(_ editors: [CodeEditor], _ operation: () async throws -> T) async rethrows -> T {
        let flags = editors.map(\.textView.isEditable)
        for editor in editors { editor.textView.isEditable = false }
        defer { for (editor, value) in zip(editors, flags) { editor.textView.isEditable = value } }
        return try await operation()
    }

    /// The revision check belongs to Pi; the pane does not drop its copy until Pi accepts it.
    private func discard(_ editor: CodeEditor) async throws -> Bool {
        try await withFrozenInput([editor]) {
            try await editor.flush()
            let record = try await api.call("revert", ["doc": editor.doc, "rev": editor.revision])
            if record["discarded"] as? Bool == true { return true }
            recordFormat(record, for: editor.doc)
            try await editor.discardLocalChanges()
            refreshGitBase(editor)
            navigator.refreshFiles()
            return false
        }
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
    @discardableResult
    func closeTab(_ key: String) async throws -> Bool {
        guard !activeMutation, confirmation == nil, !disconnected else { return false }
        if let editor = editor(for: key), requests.hasDraft(in: editor) {
            requests.resumeDraft(in: editor)
            chrome.notify("Send or clear the unsent request before closing this tab.")
            return false
        }
        if let editor = editor(for: key), editor.dirty {
            let answer = await ask("Close \(editor.title)?", detail: "This tab has unsaved changes.",
                                   choices: [.init("Discard changes", role: .destructive), .init("Keep as draft"), .init("Save", role: .primary)])
            guard buffers[editor.doc] === editor, !activeMutation else { return false }
            activeMutation = true
            defer { activeMutation = false }
            var discarded = false
            switch answer {
            case 0: discarded = try await discard(editor)
            case 1: try await editor.flush()
            case 2:
                if editor.doc.hasPrefix("scratch:") || editor.diskConflict {
                    guard try await saveWithPanel(editor) else { return false }
                } else {
                    try await save(editor, to: nil)
                }
            default: currentEditor?.focus(); return false
            }
            guard !editor.hasPending else {
                chrome.setMessage("The tab changed during close. Your edits are still here."); return false
            }
            removeTab(fileKey(editor.doc), remember: !discarded)
        } else { removeTab(key) }
        if groups.allSatisfy({ $0.keys.isEmpty }), !fixedLayout { showNavigator(.files) }
        present()
        currentEditor?.focus()
        return true
    }

    private func removeTab(_ key: String, remember: Bool = true) {
        guard let index = groupIndex(of: key), let order = groups[index].keys.firstIndex(of: key) else { return }
        if remember {
            let position = pendingPositions[key] ?? editor(for: key).map(WorkspacePosition.init)
            closedTabs.append((key, groups[index].id, order, position))
            if closedTabs.count > 30 { closedTabs.removeFirst() }
        }
        if let editor = editor(for: key) {
            requests.close(editor)
            buffers.removeValue(forKey: editor.doc)
            updateWatchedFiles()
            unobservePosition(of: editor.doc)
            expectedGitBases.removeValue(forKey: editor.doc)
            formats.removeValue(forKey: editor.doc)
            diskConflictAcknowledged.remove(editor.doc)
            editor.stop()
        } else if let id = viewID(for: key) {
            hiddenViews[id] = viewHeaders.first(where: { $0["id"] as? String == id })?["rev"] as? Int
            compositions[id] = nil
        }
        previewKeys.remove(key)
        pendingPositions.removeValue(forKey: key)
        groups[index].keys.remove(at: order)
        if groups[index].selected == key { groups[index].selected = neighbour(in: index, at: order) }
    }

    private func reopenTab() async throws {
        guard let closed = closedTabs.popLast() else { return }
        whenRestoringPosition(closed.position, for: closed.key)
        try await select(closed.key)
        if let index = groups.firstIndex(where: { $0.id == closed.group }) {
            move(closed.key, to: .slot(group: closed.group, index: min(closed.index, groups[index].keys.count)))
        }
    }

    private func closeOthers(_ key: String, right: Bool = false) async throws {
        guard let index = groupIndex(of: key), let order = groups[index].keys.firstIndex(of: key) else { return }
        let others = right ? Array(groups[index].keys.dropFirst(order + 1)) : groups[index].keys.filter { $0 != key }
        for other in others { if !(try await closeTab(other)) { break } }
    }

    // MARK: Project files

    func fileAction(_ action: NavigatorFileAction) {
        guard confirmation == nil, !activeMutation, !disconnected else { return }
        switch action {
        case .newFile(let folder): requestPath(.newProjectFile, start: folder.isEmpty ? "" : folder + "/")
        case .newFolder(let folder):
            promptPath(action: "Create folder", start: folder.isEmpty ? "" : folder + "/") { [weak self] path in
                guard let self else { return }
                _ = try await api.call("mkdir", ["path": path])
                navigator.refreshFiles()
                chrome.notify("Created \(path).")
            }
        case .rename(let from, let to): mutate { try await $0.renameEntry(from, to: to) }
        case .moveToPath(let source):
            let parent = (source as NSString).deletingLastPathComponent
            promptPath(action: "Move to", start: parent.isEmpty ? "" : parent + "/") { [weak self] target in
                try await self?.renameEntry(source, to: target)
            }
        case .move(let from, let folder):
            let destination = folder.isEmpty ? (from as NSString).lastPathComponent : folder + "/" + (from as NSString).lastPathComponent
            guard destination != from else { return }
            mutate { try await $0.renameEntry(from, to: destination) }
        case .duplicate(let source):
            let parent = (source as NSString).deletingLastPathComponent
            promptPath(action: "Duplicate", start: parent.isEmpty ? "" : parent + "/") { [weak self] target in
                guard let self else { return }
                _ = try await api.call("copy", ["from": source, "to": target])
                navigator.refreshFiles()
                chrome.notify("Copied to \(target).")
            }
        case .remove(let path): act { try await $0.confirmTrash(path) }
        case .copyPath(let path): copyPath(path, relative: false)
        case .copyRelativePath(let path): copyPath(path, relative: true)
        case .reveal(let path): NSWorkspace.shared.activateFileViewerSelecting([fileURL(path)])
        }
    }

    private func fileURL(_ path: String) -> URL { URL(fileURLWithPath: root, isDirectory: true).appendingPathComponent(path) }

    private func copyPath(_ path: String, relative: Bool) {
        let paste = NSPasteboard.general
        paste.clearContents()
        paste.setString(relative ? path : fileURL(path).path, forType: .string)
        chrome.notify(relative ? "Relative path copied." : "Path copied.")
    }

    private func includes(_ child: String, in parent: String) -> Bool { child == parent || child.hasPrefix(parent + "/") }

    private func renameEntry(_ source: String, to destination: String) async throws {
        let editors = buffers.values.filter { includes($0.doc, in: source) }
        let focus = currentEditor?.hasFocus == true ? currentEditor : nil
        try await withFrozenInput(editors) {
            for editor in editors { try await editor.flush() }
            let data = try await api.call("rename", ["from": source, "to": destination])
            guard let old = data["from"] as? String, let target = data["to"] as? String, let mapping = data["mapping"] as? [Fields] else {
                throw EditorIssue(code: "response", message: "Pi did not return the file move result.")
            }
            for item in mapping {
                guard let from = item["from"] as? String, let to = item["to"] as? String else { continue }
                if let editor = buffers[from] {
                    editor.relocate(to: to)
                    remapDocument(from, to: to, editor: editor)
                    refreshGitBase(editor)
                }
                for index in closedTabs.indices where closedTabs[index].key == fileKey(from) { closedTabs[index].key = fileKey(to) }
            }
            let folders = navigator.expandedFolders.map { includes($0, in: old) ? target + String($0.dropFirst(old.count)) : $0 }
            navigator.restoreFolders(folders)
            navigator.refreshFiles()
            chrome.notify("Moved to \(target).")
            present(reveal: selected)
        }
        focus?.focus()
    }

    private func remapDocument(_ source: String, to destination: String, editor: CodeEditor) {
        buffers.removeValue(forKey: source)
        buffers[destination] = editor
        updateWatchedFiles()
        formats[destination] = formats.removeValue(forKey: source)
        expectedGitBases.removeValue(forKey: source)
        unobservePosition(of: source)
        observePosition(of: editor)
        let old = fileKey(source), new = fileKey(destination)
        if previewKeys.remove(old) != nil { previewKeys.insert(new) }
        pendingPositions[new] = pendingPositions.removeValue(forKey: old)
        if diskConflictAcknowledged.remove(source) != nil { diskConflictAcknowledged.insert(destination) }
        for index in groups.indices {
            groups[index].keys = groups[index].keys.map { $0 == old ? new : $0 }
            if groups[index].selected == old { groups[index].selected = new }
        }
    }

    private func confirmTrash(_ path: String) async throws {
        try await loadState()
        let local = buffers.values.filter { $0.dirty && includes($0.doc, in: path) }.map(\.doc)
        let shared = documents.compactMap { $0["dirty"] as? Bool == true ? $0["doc"] as? String : nil }.filter { includes($0, in: path) }
        let drafts = Array(Set(local + shared)).sorted()
        let summary = drafts.prefix(3).joined(separator: ", ") + (drafts.count > 3 ? " and \(drafts.count - 3) more" : "")
        let detail = drafts.isEmpty ? path : "\(path)\nEditor keeps these unsaved drafts: \(summary)"
        guard await ask("Move to Trash?", detail: detail, choices: [.init("Move to Trash", role: .destructive)]) == 0 else {
            currentEditor?.focus(); return
        }
        mutate { screen in
            let editors = screen.buffers.values.filter { screen.includes($0.doc, in: path) }
            try await screen.withFrozenInput(editors) {
                for editor in editors { try await editor.flush() }
                let receipt = try await screen.api.call("remove", ["path": path])
                guard let kept = receipt["kept"] as? [String] else {
                    throw EditorIssue(code: "response", message: "Pi did not return the Trash result.")
                }
                for editor in editors {
                    if kept.contains(editor.doc) { try await editor.refresh() }
                    else { screen.removeTab(screen.fileKey(editor.doc), remember: false) }
                }
                screen.navigator.refreshFiles()
                screen.present()
                screen.chrome.notify("Moved \(path) to Trash.")
            }
            screen.currentEditor?.focus()
        }
    }

    // MARK: Commands

    /// Registers the commands of files, tabs, panels, the view and the theme.
    private func configureRequests() {
        onWorkspaceState = { [weak self] fields in
            guard let self else { return }
            requests.state(fields, editors: Array(buffers.values))
        }
        onWorkspaceEvent = { [weak self] fields in
            guard let self else { return }
            if fields["type"] as? String == "file", let path = fields["path"] as? String,
               let revision = fields["rev"] as? Int, let writer = (fields["by"] as? Fields).flatMap(RequestParticipant.init) {
                buffers[path]?.nameDiskWriter(writer.label, at: revision)
            }
            requests.event(fields)
        }
        requests.onOpen = { [weak self] doc in self?.act { try await $0.open(doc) } }
        requests.onResumeFile = { [weak self] doc, resume in
            self?.act { screen in try await screen.open(doc); resume() }
        }
        requests.onCompose = { [weak self] editor in
            guard let self else { return }
            keepPreview(fileKey(editor.doc))
        }
        requests.onSession = { [weak self] in
            guard let self else { return }
            chrome.setSessionStatus(requests.session?.label)
        }
        requests.onError = { [weak self] in self?.chrome.notify($0) }
        requests.onReveal = { [weak self] in self?.showAgentLocation($0) }
        chrome.setSessionStatus(nil)
    }

    private func showAgentLocation(_ event: Fields) {
        guard let doc = event["doc"] as? String, !doc.isEmpty else { return }
        if currentEditor?.hasFocus == true, currentEditor?.hasPending == true {
            pendingShow = event
            return
        }
        act { screen in
            let editor: CodeEditor
            if let cached = screen.buffers[doc] { editor = cached }
            else { editor = try screen.makeBuffer(await screen.api.call("read", ["doc": doc])) }
            guard !screen.stopped else { return }
            if screen.currentEditor?.hasFocus == true, screen.currentEditor?.hasPending == true {
                screen.pendingShow = event
                return
            }
            let key = screen.fileKey(editor.doc)
            screen.previewKeys.remove(key)
            if !screen.groups.contains(where: { $0.selected == key }) {
                let responder = screen.chrome.window?.firstResponder
                let protectsSource = responder is CodeTextView || responder === screen.requests.view.input
                let source = protectsSource ? screen.selected : nil
                if source != nil, screen.groups.count == 1 {
                    let fixed = screen.fixedLayout
                    screen.chooseArrangement(screen.chrome.fitsSecondGroup ? .columns2 : .rows2)
                    screen.fixedLayout = fixed
                }
                let index = screen.place(key, awayFrom: source)
                screen.groups[index].selected = key
                if !protectsSource { screen.active = screen.groups[index].id }
                if !screen.chrome.showsSideBySide { screen.panel = nil }
                screen.present(reveal: key)
            }
            screen.chrome.layoutSubtreeIfNeeded()
            editor.revealAgentRange(start: event["start"] as? Int, end: event["end"] as? Int, line: event["line"] as? Int)
            if let message = event["message"] as? String, !message.isEmpty {
                let author = (event["by"] as? Fields).flatMap(RequestParticipant.init)?.label
                screen.chrome.notify(author.map { "\($0): \(message)" } ?? message)
            }
        }
    }

    private func registerWorkspaceCommands() {
        func add(_ id: String, _ title: String, _ category: String, keys: String? = nil,
                 enabled: @escaping @MainActor () -> Bool = { true }, on: (@MainActor () -> Bool)? = nil,
                 _ run: @escaping @MainActor (WorkspaceScreen) -> Void) {
            registry.register(EditorCommand(id, title, category: category, keys: keys, isEnabled: enabled, isOn: on) { [weak self] in
                if let self { run(self) }
            })
        }
        let editing: @MainActor () -> Bool = { [weak self] in self?.currentEditor != nil }
        add("collaboration.ask", "Ask About Selection…", "Conversations", keys: "cmd+shift+A", enabled: editing) { $0.currentEditor?.askSelection() }
        add("collaboration.resume", "Resume Unsent Request", "Conversations", enabled: { [weak self] in self?.requests.hasUnpostedText == true }) { $0.requests.resumeDraft() }
        add("collaboration.showChange", "Show Latest External Change", "File", enabled: { [weak self] in
            self?.currentEditor?.reviews.isEmpty == false
        }) { screen in
            if let editor = screen.currentEditor { editor.scroll.showLatestChange(editor) }
        }
        add("collaboration.undoChange", "Undo Latest External Change", "File", enabled: { [weak self] in
            guard let editor = self?.currentEditor, let review = editor.reviews.first else { return false }
            return !editor.conflicted && !editor.textView.hasMarkedText() && review.hunks.allSatisfy { $0.span.intact }
        }) { screen in
            if let editor = screen.currentEditor, let review = editor.reviews.first { editor.undoReview(review) }
        }
        add("file.newScratch", "New Scratch", "File", keys: "cmd+N") { $0.command("scratch") }
        add("file.newFile", "New File…", "File", keys: "cmd+shift+N") { $0.command("newFile") }
        add("file.save", "Save", "File", keys: "cmd+S", enabled: editing) { $0.command("save") }
        add("file.saveAll", "Save All", "File", keys: "cmd+option+S", enabled: editing) { $0.command("saveAll") }
        add("file.reopenTab", "Reopen Closed Tab", "File", keys: "cmd+shift+T", enabled: { [weak self] in self?.closedTabs.isEmpty == false }) { $0.command("reopen") }
        add("file.saveAs", "Save As…", "File", keys: "cmd+shift+S", enabled: editing) { $0.command("saveAs") }
        add("file.closeTab", "Close Tab", "File", keys: "cmd+W", enabled: { [weak self] in self?.selected != nil }) { screen in
            guard let key = screen.selected else { return }
            screen.act { _ = try await $0.closeTab(key) }
        }
        add("view.files", "Show Project Files", "View", keys: "cmd+O") { $0.command("files") }
        add("view.search", "Show Project Search", "View", keys: "cmd+P") { $0.command("search") }
        add("view.searchContents", "Search Text in Files", "View", keys: "cmd+shift+F") { $0.command("searchContents") }
        add("view.git", "Show Local Git", "View") { $0.command("git") }
        add("view.notes", "Show Conversations", "View", keys: "cmd+option+T") { $0.command("notes") }
        add("view.sidebar", "Toggle Side Bar", "View", keys: "cmd+K cmd+B", on: { [weak self] in self?.panel != nil }) { $0.command("sidebar") }
        add("go.nextTab", "Next Tab", "Go", keys: "cmd+shift+]") { $0.command("next") }
        add("go.previousTab", "Previous Tab", "Go", keys: "cmd+shift+[") { $0.command("previous") }
        add("go.nextTabArrow", "Next Tab", "Go", keys: "cmd+option+right") { $0.command("next") }
        add("go.previousTabArrow", "Previous Tab", "Go", keys: "cmd+option+left") { $0.command("previous") }
        for number in 1...9 {
            add("go.tab\(number)", "Tab \(number)", "Go", keys: "cmd+\(number)") { screen in
                let keys = screen.groups[screen.activeIndex].keys
                guard !keys.isEmpty else { return }
                let key = number == 9 ? keys[keys.count - 1] : keys[min(number, keys.count) - 1]
                screen.act { try await $0.select(key) }
            }
        }
        for number in 1...4 {
            let available: @MainActor () -> Bool = { [weak self] in (self?.groups.count ?? 0) >= number }
            add("layout.focusGroup\(number)", "Focus Group \(number)", "Layout", keys: "control+\(number)", enabled: available) { screen in
                let group = screen.groups[number - 1]
                screen.activate(group.id)
                if let editor = screen.currentEditor { editor.focus() }
                else { screen.chrome.window?.makeFirstResponder(nil) }
                screen.present(reveal: group.selected)
            }
            add("layout.moveToGroup\(number)", "Move Tab to Group \(number)", "Layout", keys: "control+shift+\(number)", enabled: available) { screen in
                guard let tab = screen.selected, screen.activeIndex != number - 1 else { return }
                let group = screen.groups[number - 1]
                screen.move(tab, to: .slot(group: group.id, index: group.keys.count))
            }
        }
        for (layout, label, keys) in Self.layoutChoices {
            add("layout.\(layout.rawValue)", label, "Layout", keys: keys, on: { [weak self] in self?.chrome.arrangement == layout }) {
                $0.chooseArrangement(layout)
            }
        }
        func addToggle(_ key: String, _ title: String) {
            add("view.\(key)", "Toggle \(title)", "View", on: { [weak self] in self?.preferences.base.flag(key) ?? false }) { screen in
                screen.preferences.set(key, .flag(!screen.preferences.base.flag(key)))
            }
        }
        addToggle("wordWrap", "Word Wrap")
        addToggle("lineNumbers", "Line Numbers")
        addToggle("minimap", "Minimap")
        addToggle("indentGuides", "Indent Guides")
        addToggle("highlightLine", "Current Line Highlight")
        addToggle("gitGutter", "Change Marks")
        func zoom(_ delta: Double?) -> @MainActor @Sendable (WorkspaceScreen) -> Void {
            { screen in
                let size = screen.preferences.base.number("fontSize")
                screen.preferences.set("fontSize", delta.map { .number(min(40, max(8, size + $0))) })
            }
        }
        add("view.zoomIn", "Increase Font Size", "View", keys: "cmd+=", zoom(1))
        add("view.zoomInShift", "Increase Font Size", "View", keys: "cmd+shift+=", zoom(1))
        add("view.zoomOut", "Decrease Font Size", "View", keys: "cmd+-", zoom(-1))
        add("view.zoomReset", "Reset Font Size", "View", keys: "cmd+0", zoom(nil))
        for mode in PaneAppearance.Mode.allCases {
            add("theme.\(mode.rawValue)", "Appearance \(mode.rawValue.capitalized)", "Theme",
                on: { [weak self] in self?.appearance.mode == mode }) { $0.appearance.choose(mode: mode) }
        }
        for (flavour, name) in zip(PaneAppearance.Flavour.allCases, ["Frappé", "Macchiato", "Mocha"]) {
            add("theme.\(flavour.rawValue)", "Dark Theme \(name)", "Theme",
                on: { [weak self] in self?.appearance.flavour == flavour }) { $0.appearance.choose(flavour: flavour) }
        }
    }

    // MARK: Menus

    private static let layoutChoices: [(WorkspaceArrangement, String, String)] = [
        (.single, "Single Group", "cmd+option+1"), (.columns2, "Two Columns", "cmd+option+2"),
        (.columns3, "Three Columns", "cmd+option+3"), (.columns4, "Four Columns", "cmd+option+4"),
        (.rows2, "Two Rows", "cmd+option+shift+2"), (.rows3, "Three Rows", "cmd+option+shift+3"),
        (.grid, "Four Groups in a Grid", "cmd+option+5"),
    ]

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
            if previewKeys.contains(key) { menu.addItem(WorkspaceChoice("Keep Preview") { [weak self] in self?.keepPreview(key) }) }
            menu.addItem(WorkspaceChoice("Close Tab") { [weak self] in self?.act { _ = try await $0.closeTab(key) } })
            if group.keys.count > 1 { menu.addItem(WorkspaceChoice("Close Other Tabs") { [weak self] in self?.act { try await $0.closeOthers(key) } }) }
            if let last = group.keys.last, last != key { menu.addItem(WorkspaceChoice("Close Tabs to the Right") { [weak self] in self?.act { try await $0.closeOthers(key, right: true) } }) }
            let moveMenu = NSMenu()
            for (slot, other) in groups.enumerated() where slot != index {
                moveMenu.addItem(WorkspaceChoice("Group \(slot + 1)") { [weak self] in self?.move(key, to: .slot(group: other.id, index: other.keys.count)) })
            }
            if groups.count < 4, group.keys.count > 1 || fixedLayout {
                for (title, drop) in [("New Group on the Right", WorkspaceDrop.beside(group: group.id, trailing: true)),
                                      ("New Group Below", WorkspaceDrop.stacked(group: group.id, trailing: true))] {
                    moveMenu.addItem(WorkspaceChoice(title) { [weak self] in self?.move(key, to: drop) })
                }
            }
            if !moveMenu.items.isEmpty { menu.addItem(withTitle: "Move to Group", action: nil, keyEquivalent: "").submenu = moveMenu }
            if let path = editor(for: key)?.doc, !path.hasPrefix("scratch:") {
                menu.addItem(.separator())
                menu.addItem(WorkspaceChoice("Reveal in Sidebar") { [weak self] in
                    guard let self else { return }
                    if panel != .files { showNavigator(.files) }
                    navigator.revealFile(path)
                })
                menu.addItem(WorkspaceChoice("Copy Path") { [weak self] in self?.copyPath(path, relative: false) })
            }
        }
        return menu
    }
    private func workspaceMenu() -> NSMenu {
        let menu = NSMenu()
        func choice(_ name: String, _ command: String) {
            menu.addItem(WorkspaceChoice(name) { [weak self] in self?.command(command) })
        }
        choice("New Scratch   cmd+N", "scratch"); choice("New File…   cmd+shift+N", "newFile")
        if currentEditor != nil {
            choice("Save   cmd+S", "save"); choice("Save As…   cmd+shift+S", "saveAs"); choice("Save All   cmd+option+S", "saveAll")
        }
        if !closedTabs.isEmpty { choice("Reopen Closed Tab   cmd+shift+T", "reopen") }
        let layouts = NSMenu()
        for (layout, label, keys) in Self.layoutChoices {
            let item = WorkspaceChoice("\(label)   \(keys)") { [weak self] in self?.chooseArrangement(layout) }
            item.state = chrome.arrangement == layout ? .on : .off
            layouts.addItem(item)
        }
        menu.addItem(withTitle: "Layout", action: nil, keyEquivalent: "").submenu = layouts
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
        menu.addItem(.separator()); choice("Project Search", "search"); choice("Local Git", "git"); choice("Conversations   cmd+option+T", "notes")
        menu.addItem(.separator())
        let wrap = WorkspaceChoice("Wrap lines") { [weak self] in
            self?.command("wrap")
        }
        wrap.state = preferences.base.wordWrap ? .on : .off; menu.addItem(wrap)
        menu.addItem(WorkspaceChoice("Note on line wrapping…") { [weak self] in self?.note("setting","line-wrap") })
        menu.addItem(WorkspaceChoice("Note on this pane…") { [weak self] in self?.note("pane","workspace") })
        if let selected {
            menu.addItem(.separator()); menu.addItem(WorkspaceChoice("Close current tab") { [weak self] in self?.act { _ = try await $0.closeTab(selected) } })
        }
        return menu
    }
}

/// The page of a stage without a selected tab.
@MainActor
private final class WorkspaceLanding: NSView {
    let files = WorkspaceButton("Project files",symbol: "folder")
    let new = WorkspaceButton("New scratch",symbol: "square.and.pencil")
    /// The sidebar already lists the project files, so the page needs no control for them.
    var listsFiles = false { didSet { if listsFiles != oldValue { needsLayout = true } } }
    private let heading: NSTextField
    private let caption = NSTextField(labelWithString: "")
    init(folder: String) {
        heading = NSTextField(labelWithString: folder)
        super.init(frame: .zero)
        heading.alignment = .center; heading.lineBreakMode = .byTruncatingMiddle
        caption.alignment = .center; caption.lineBreakMode = .byTruncatingTail
        for v in [heading, caption, files, new] { addSubview(v) }
    }
    required init?(coder: NSCoder) { nil }
    override func layout() {
        super.layout(); let w = bounds.width, y = bounds.midY
        heading.font = WorkspaceStyle.interfaceFont(5, weight: .semibold)
        heading.textColor = WorkspaceStyle.theme.text
        caption.font = WorkspaceStyle.interfaceFont()
        caption.textColor = WorkspaceStyle.theme.secondaryText
        caption.stringValue = listsFiles ? "Choose a file in the sidebar, or start a scratch draft." : "Choose a project file or start a scratch draft."
        files.isHidden = listsFiles
        heading.frame = NSRect(x: 8,y: y+18,width: max(0,w-16),height: 30)
        caption.frame = NSRect(x: 8,y:y-7,width:max(0,w-16),height:20)
        if listsFiles { new.frame = NSRect(x:w/2-58,y:y-48,width:116,height:30) }
        else {
            files.frame = NSRect(x:w/2-120,y:y-48,width:116,height:30)
            new.frame = NSRect(x:w/2+4,y:y-48,width:116,height:30)
        }
    }
}
