import AppKit

enum NavigatorFileAction: Equatable {
    case newFile(String), newFolder(String), rename(String, String), duplicate(String)
    case move(String, String), remove(String), copyPath(String), copyRelativePath(String), reveal(String)
}

/// The project tree, open tabs, saved-file search and local Git views of the sidebar.
@MainActor
final class ProjectNavigator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSSearchFieldDelegate {
    private enum Mode { case files, search, git, diff }
    private static let pathType = NSPasteboard.PasteboardType("app.pi.editor.path")

    private let api: any EditorAPI
    private let canvas = NavigatorCanvas()
    private let heading = NSTextField(labelWithString: "Project files")
    private let count = NSTextField(labelWithString: "")
    private let back = WorkspaceButton("", symbol: "chevron.backward", help: "Go back")
    private let reload = WorkspaceButton("", symbol: "arrow.clockwise", help: "Refresh list")
    private let openFile = WorkspaceButton("Open", symbol: "doc", help: "Open file for editing")
    private let query = NSSearchField()
    private let kind = NSSegmentedControl(labels: ["File names", "Contents"], trackingMode: .selectOne, target: nil, action: nil)
    private let list = NSScrollView()
    private let outline = NavigatorOutline()
    private let column = NSTableColumn(identifier: .init("Path"))
    private let diffBox = NSScrollView()
    private let patch = NSTextView()
    private let openHeading = NavigatorNode(.section, path: "", title: "OPEN FILES")
    private let foldersHeading = NavigatorNode(.section, path: "", title: "FOLDERS")
    private var root = NavigatorNode(.folder, path: "", title: "")
    private var tabs: [NavigatorNode] = []
    private var selectedTab: String?
    private var flat: [NavigatorNode] = []
    private var mode: Mode = .files
    private var gitScope: String?
    private var selectedDiff: String?
    private var marks: [String: NavigatorGitMark] = [:]
    private var gitTask: Task<Void, Never>?
    private var gitRevision = 0
    private var task: Task<Void, Never>?
    private var loads: [String: Task<Void, Never>] = [:]
    private var generation = 0
    private var expanded: Set<String> = []
    private var restoringRows = false
    private var treeRequested = false
    private var pendingReveal: String?
    private var rename: (node: NavigatorNode, cell: NavigatorCell, field: NSTextField)?
    private var treeError = false
    private var refreshAfterRename = false

    var view: NSView { canvas }
    var expandedFolders: [String] { expanded.sorted() }
    /// The narrowest width that shows the listed names in full. A diff has no such width.
    var fittingWidth: CGFloat? {
        guard mode != .diff, outline.numberOfRows > 0 else { return nil }
        var widest: CGFloat = 0
        for row in 0..<min(outline.numberOfRows, 600) {
            guard let node = outline.item(atRow: row) as? NavigatorNode else { continue }
            let text = ((node.tab?.label ?? node.title) as NSString).size(withAttributes: [.font: nameFont(node)]).width
            let leading = node.kind == .section ? NavigatorCell.trailingInset : NavigatorCell.textInset
            let accessory = reservesAccessory(node) ? NavigatorCell.accessoryWidth : 0
            widest = max(widest, outline.frameOfCell(atColumn: 0, row: row).minX + text + leading + accessory)
        }
        let scroller = list.frame.width - list.contentSize.width
        return ceil(widest) + NavigatorCell.trailingInset + scroller + 6
    }
    var onOpen: ((String, Int?) -> Void)?
    var onPreview: ((String) -> Void)?
    var onSelectTab: ((String) -> Void)?
    var onCloseTab: ((String) -> Void)?
    var onNote: ((String, String) -> Void)?
    var onNewFile: ((String) -> Void)?
    var onFileAction: ((NavigatorFileAction) -> Void)?
    var onError: ((String) -> Void)?
    var onExpand: ((Bool) -> Void)?
    var onLayoutChange: (() -> Void)?
    var onBranch: ((String?) -> Void)?

    init(api: any EditorAPI) {
        self.api = api; super.init()
        heading.lineBreakMode = .byTruncatingMiddle; count.lineBreakMode = .byTruncatingTail
        query.placeholderString = "Find files by name"; query.setAccessibilityLabel("Project query")
        query.delegate = self; query.sendsSearchStringImmediately = true
        kind.selectedSegment = 0; kind.target = self; kind.action = #selector(switchQuery); kind.controlSize = .small
        kind.setAccessibilityLabel("Search by file name or contents")
        outline.headerView = nil; outline.style = .plain; outline.usesAlternatingRowBackgroundColors = false
        outline.intercellSpacing = .zero; outline.allowsEmptySelection = true
        outline.indentationPerLevel = 14; outline.autoresizesOutlineColumn = false
        outline.addTableColumn(column); outline.outlineTableColumn = column
        outline.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle; column.minWidth = 30
        outline.delegate = self; outline.dataSource = self; outline.target = self; outline.action = #selector(clicked)
        outline.doubleAction = #selector(doubleClicked)
        outline.setAccessibilityLabel("Project results")
        outline.registerForDraggedTypes([Self.pathType])
        outline.setDraggingSourceOperationMask([.copy, .move], forLocal: true)
        outline.setDraggingSourceOperationMask([], forLocal: false)
        outline.backgroundColor = .clear; list.drawsBackground = false
        list.hasVerticalScroller = true; list.autohidesScrollers = true; list.documentView = outline
        patch.font = .monospacedSystemFont(ofSize: 12, weight: .regular); patch.isEditable = false; patch.isSelectable = true
        patch.isRichText = false; patch.textContainerInset = .init(width: 8, height: 6)
        patch.isVerticallyResizable = true; patch.isHorizontallyResizable = false; patch.autoresizingMask = [.width]
        patch.textContainer?.widthTracksTextView = true; patch.setAccessibilityLabel("Git diff")
        diffBox.hasVerticalScroller = true; diffBox.autohidesScrollers = true; diffBox.documentView = patch
        for v in [heading, count, back, reload, openFile, query, kind, list, diffBox] { canvas.addSubview(v) }
        canvas.arrange = { [weak self] in self?.arrange($0) }
        outline.handleKey = { [weak self] in self?.handleTreeKey($0) ?? false }
        outline.menuAt = { [weak self] index in self?.menu(at: index) }
        back.run = { [weak self] in self?.loadGit(nil) }; reload.run = { [weak self] in self?.refresh() }
        openFile.run = { [weak self] in guard let self, let path = selectedDiff else { return }; onOpen?(path, nil) }
        NotificationCenter.default.addObserver(self, selector: #selector(applyStyle), name: .workspaceStyleDidChange, object: nil)
        reloadRows()
        applyStyle()
        refreshChrome()
    }

    func start() async throws {
        let g = reset(.files, clear: false)
        treeRequested = true
        defer { if g == generation { finishTreeRequest() } }
        try await readTree(g)
        if g == generation { refreshGitStatus() }
    }

    func stop() {
        generation += 1; task?.cancel(); task = nil
        treeRequested = false; pendingReveal = nil
        cancelLoads()
        gitTask?.cancel(); gitTask = nil
        refreshAfterRename = false
        finishRename(commit: false)
    }

    func showFiles() { reloadTree() }

    func showSearch(contents: Bool = false) {
        kind.selectedSegment = contents ? 1 : 0
        switchQuery()
        canvas.window?.makeFirstResponder(query)
        query.selectText(nil)
    }

    func showGit(doc: String? = nil) { gitScope = doc; loadGit(nil) }

    func refreshFiles() {
        if mode == .files, rename == nil { reloadTree() }
        else {
            refreshAfterRename = mode == .files
            refreshGitStatus()
        }
    }

    func restoreFolders(_ folders: [String]) {
        let paths = Set(folders.filter(Self.isProjectPath))
        guard paths != expanded else { return }
        expanded = paths
        // Before start, only remember the paths. The first tree read uses them.
        if mode == .files, root.children != nil, !treeRequested { reloadTree() }
    }

    func revealFile(_ path: String) {
        guard mode == .files, Self.isProjectPath(path) else { return }
        pendingReveal = path
        guard !treeRequested else { return }
        if revealLoadedFile(path) { pendingReveal = nil } else { reloadTree() }
    }

    func showOpenTabs(_ next: [WorkspaceTab], selected: String?) {
        let current = tabs.compactMap(\.tab)
        guard next != current || selected != selectedTab else { return }
        let structural = next.map(\.key) != current.map(\.key)
        let oldSelected = selectedTab
        selectedTab = selected
        if structural {
            let oldCount = openSectionCount
            let keep = mode == .files ? (outline.item(atRow: outline.selectedRow) as? NavigatorNode)?.tab?.key : nil
            if mode == .files { outline.beginUpdates() }
            if oldCount > 0 {
                tabs = []
                if mode == .files { outline.removeItems(at: IndexSet(integersIn: 0..<oldCount), inParent: nil, withAnimation: []) }
            }
            tabs = next.map { tab in
                let node = NavigatorNode(.tab, path: tab.key, title: tab.label)
                node.tab = tab
                return node
            }
            if mode == .files {
                if !tabs.isEmpty { outline.insertItems(at: IndexSet(integersIn: 0..<openSectionCount), inParent: nil, withAnimation: []) }
                outline.endUpdates()
                if let keep, let node = tabs.first(where: { $0.path == keep }) { select(node, scroll: false) }
            }
        } else {
            for (index, tab) in next.enumerated() {
                let node = tabs[index]
                let changed = tab != node.tab || tab.key == selected || tab.key == oldSelected
                node.tab = tab
                if mode == .files, changed { repaint(node) }
            }
        }
    }

    // MARK: Modes

    private func cancelLoads() {
        for load in loads.values { load.cancel() }
        loads.removeAll()
    }

    private func reset(_ newMode: Mode, clear: Bool = true) -> Int {
        generation += 1; task?.cancel(); task = nil
        cancelLoads(); treeRequested = false
        refreshAfterRename = false
        finishRename(commit: false)
        let oldMode = mode
        mode = newMode
        outline.flat = mode != .files
        if mode != .files { pendingReveal = nil; if clear { flat = [] } }
        if clear || oldMode != mode { outline.deselectAll(nil); reloadRows() }
        refreshChrome()
        if (oldMode == .diff) != (mode == .diff) { onExpand?(mode == .diff) }
        return generation
    }

    private func reloadRows() {
        let wasRestoring = restoringRows
        restoringRows = true
        outline.reloadData()
        if mode == .files { restoreExpansion(of: root) }
        restoringRows = wasRestoring
    }

    private func restoreExpansion(of node: NavigatorNode) {
        for child in node.children ?? [] where child.kind == .folder && expanded.contains(child.path) {
            if !outline.isItemExpanded(child) { outline.expandItem(child) }
            if outline.isItemExpanded(child) { restoreExpansion(of: child) }
        }
    }

    private func fetch(_ op: String, _ fields: Fields, mode: Mode, delay: Bool = false, apply: @escaping (Fields) -> Void) {
        let g = reset(mode)
        count.stringValue = "Loading…"; refreshChrome()
        task = Task { [weak self, api] in
            do {
                if delay { try await Task.sleep(for: .milliseconds(140)) }
                let data = try await api.call(op, fields)
                guard let self, g == generation, !Task.isCancelled else { return }
                self.task = nil; apply(data)
            } catch {
                guard let self, g == generation, !Task.isCancelled else { return }
                self.task = nil; count.stringValue = "Could not load results"; refreshChrome()
                onError?(error.localizedDescription)
            }
        }
    }

    // MARK: Project tree

    private static func isProjectPath(_ path: String) -> Bool {
        !path.isEmpty && !path.contains("\0") && path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".."
        }
    }

    private static func parent(of path: String) -> String {
        path.lastIndex(of: "/").map { String(path[..<$0]) } ?? ""
    }

    private func addPage(_ data: Fields, to node: NavigatorNode, at offset: Int) {
        var children = offset == 0 ? [] : node.children ?? []
        var seen = Set(children.map(\.path))
        for item in data["entries"] as? [Fields] ?? [] {
            guard let path = item["path"] as? String, let title = item["name"] as? String,
                  let dir = item["dir"] as? Bool, seen.insert(path).inserted else { continue }
            let child = NavigatorNode(dir ? .folder : .file, path: path, title: title)
            child.parent = node; children.append(child)
        }
        children.sort { a, b in
            (a.kind == .folder) == (b.kind == .folder) ? a.title.localizedStandardCompare(b.title) == .orderedAscending : a.kind == .folder
        }
        node.children = children
        node.next = (data["next"] as? Int).flatMap { $0 > offset ? $0 : nil }
        node.limited = data["limited"] as? Bool == true
    }

    private func readPage(_ node: NavigatorNode, offset: Int = 0) async throws {
        try Task.checkCancellation()
        var fields: Fields = ["path": node.path]
        if offset != 0 { fields["offset"] = offset }
        let data = try await api.call("tree", fields)
        try Task.checkCancellation()
        addPage(data, to: node, at: offset)
    }

    private var openByParent: [String: Set<String>] {
        var groups: [String: Set<String>] = [:]
        for path in expanded { groups[Self.parent(of: path), default: []].insert(path) }
        return groups
    }

    private func readTree(_ g: Int) async throws {
        let replacement = NavigatorNode(.folder, path: "", title: "")
        // Resolve the latest reveal after the first request, including one made just after showFiles().
        try await readPage(replacement)
        guard g == generation else { return }
        let target = pendingReveal
        var route: [String: String] = [:]
        var part = target ?? ""
        while !part.isEmpty {
            let parent = Self.parent(of: part)
            route[parent] = part
            part = parent
        }
        try await readChildren(replacement, open: openByParent, route: route)
        guard g == generation, !Task.isCancelled else { return }
        // An outside refresh must not dismiss the field while the person enters a name.
        if rename != nil { refreshAfterRename = true; return }
        let selection = outline.item(atRow: outline.selectedRow) as? NavigatorNode
        cancelLoads()
        root = replacement; treeError = false
        reloadRows()
        if let selection {
            if selection.kind == .tab { select(selection, scroll: false) }
            else if let node = node(at: selection.path), node !== root { select(node, scroll: false) }
        }
        if target == pendingReveal, let target {
            pendingReveal = nil
            if !revealLoadedFile(target) { onError?("File not found in the project sidebar: \(target)") }
        }
        refreshChrome()
    }

    /// Only read descendants of open folders and folders on the route to the reveal target.
    /// Other entries beyond the first page stay behind the More files row.
    private func readChildren(_ node: NavigatorNode, open: [String: Set<String>], route: [String: String]) async throws {
        var missing = open[node.path] ?? []
        if let step = route[node.path] { missing.insert(step) }
        missing.subtract((node.children ?? []).map(\.path))
        while !missing.isEmpty, let next = node.next {
            try await readPage(node, offset: next)
            missing.subtract((node.children ?? []).map(\.path))
        }
        for child in node.children ?? [] where child.kind == .folder {
            if open[node.path]?.contains(child.path) == true || route[node.path] == child.path {
                // A saved path may have disappeared since its parent was read.
                do {
                    try await readPage(child)
                    try await readChildren(child, open: open, route: route)
                } catch { try Task.checkCancellation() }
            }
        }
    }

    private func reloadTree() {
        let g = reset(.files, clear: false)
        treeRequested = true
        refreshGitStatus()
        task = Task { [weak self] in
            guard let self else { return }
            do { try await readTree(g) }
            catch {
                guard g == generation, !Task.isCancelled else { return }
                pendingReveal = nil; treeError = true; refreshChrome()
                onError?(error.localizedDescription)
            }
            guard g == generation, !Task.isCancelled else { return }
            finishTreeRequest()
        }
    }

    private func finishTreeRequest() {
        task = nil; treeRequested = false
        if rename == nil, let pendingReveal { revealFile(pendingReveal) }
    }

    private func load(_ folder: NavigatorNode, offset: Int) {
        guard loads[folder.path] == nil else { return }
        let g = generation
        loads[folder.path] = Task { [weak self, weak folder] in
            guard let self, let folder else { return }
            do {
                try await readPage(folder, offset: offset)
                if offset == 0 { try await readChildren(folder, open: openByParent, route: [:]) }
                guard g == generation, !Task.isCancelled else { return }
                loads[folder.path] = nil
                finishRename(commit: false)
                if folder === root { reloadRows() }
                else {
                    let shouldOpen = offset == 0 || outline.isItemExpanded(folder)
                    outline.reloadItem(folder, reloadChildren: true)
                    if shouldOpen {
                        outline.expandItem(folder)
                        restoreExpansion(of: folder)
                    }
                }
                refreshChrome()
            } catch {
                guard g == generation, !Task.isCancelled else { return }
                loads[folder.path] = nil
                refreshChrome(); onError?(error.localizedDescription)
            }
        }
    }

    private func node(at path: String) -> NavigatorNode? {
        var current = root
        var partial = ""
        for part in path.split(separator: "/") {
            partial += (partial.isEmpty ? "" : "/") + part
            guard let child = current.children?.first(where: { $0.path == partial }) else { return nil }
            current = child
        }
        return current
    }

    private func revealLoadedFile(_ path: String) -> Bool {
        guard let file = node(at: path), file.kind == .file else { return false }
        var ancestors: [NavigatorNode] = []
        var parent = file.parent
        while let folder = parent, folder !== root { ancestors.append(folder); parent = folder.parent }
        let wasExpanded = expanded
        restoringRows = true
        for folder in ancestors.reversed() {
            expanded.insert(folder.path)
            outline.expandItem(folder)
        }
        restoringRows = false
        if expanded != wasExpanded { onLayoutChange?() }
        select(file, scroll: true)
        return true
    }

    private func select(_ node: NavigatorNode, scroll: Bool) {
        let row = outline.row(forItem: node)
        guard row >= 0 else { return }
        outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        if scroll { outline.scrollRowToVisible(row) }
    }

    // MARK: Search and Git

    private func search(delay: Bool) {
        let text = query.stringValue
        guard !text.isEmpty else {
            _ = reset(.search); count.stringValue = kind.selectedSegment == 1 ? "Enter text to search saved files" : "Enter part of a file name"
            refreshChrome(); return
        }
        fetch("search", ["kind": kind.selectedSegment == 1 ? "text" : "paths", "query": text], mode: .search, delay: delay) { [weak self] data in
            guard let self else { return }
            flat = (data["hits"] as? [Fields] ?? []).compactMap { item in
                guard let path = item["path"] as? String else { return nil }
                let line = item["line"] as? Int
                let node = NavigatorNode(.file, path: path, title: line.map { "\(path):\($0)" } ?? path)
                node.detail = item["preview"] as? String ?? ""; node.line = line
                return node
            }
            finish(flat.isEmpty ? "No matches" : "\(flat.count) matches", data)
            if !flat.isEmpty { outline.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
        }
    }

    /// Updates project-wide Git marks and the branch without reading or switching panels.
    func refreshGitStatus() {
        let revision = beginGitStatus()
        gitTask = Task { [weak self, api] in
            guard !Task.isCancelled else { return }
            let data = try? await api.call("git", [:])
            guard let self, revision == gitRevision, !Task.isCancelled else { return }
            gitTask = nil
            if let data { observeGit(data, projectWide: true) }
        }
    }

    private func beginGitStatus() -> Int {
        gitTask?.cancel(); gitTask = nil
        gitRevision += 1
        return gitRevision
    }

    private func observeGit(_ data: Fields, projectWide: Bool) {
        let previous = marks
        if projectWide { marks = [:] }
        for item in data["files"] as? [Fields] ?? [] {
            guard let path = item["path"] as? String, let status = item["status"] as? String else { continue }
            marks[path] = NavigatorGitMark(status: status)
        }
        if projectWide {
            let branch = data["branch"] as? String
            onBranch?(data["repo"] as? Bool == true && branch?.isEmpty == false ? branch : nil)
        }
        if mode == .files, marks != previous { repaintVisibleRows() }
    }

    private func loadGit(_ diff: String?) {
        selectedDiff = diff
        let scope = diff ?? gitScope
        let revision = scope == nil ? beginGitStatus() : gitRevision
        var fields: Fields = [:]; fields["doc"] = scope
        if diff != nil { patch.string = "" }
        fetch("git", fields, mode: diff == nil ? .git : .diff) { [weak self] data in
            guard let self else { return }
            if revision == gitRevision { observeGit(data, projectWide: scope == nil) }
            guard data["repo"] as? Bool == true else { finish("No local Git repository", data); return }
            let branch = data["branch"] as? String ?? ""
            if diff != nil {
                let output = data["diff"] as? String ?? ""
                paintDiff(output)
                patch.scrollToBeginningOfDocument(nil)
                let label = output.isEmpty ? "No diff available" : "Working tree diff"
                finish([branch, label].filter { !$0.isEmpty }.joined(separator: " · "), data)
            } else {
                flat = (data["files"] as? [Fields] ?? []).compactMap { item in
                    guard let path = item["path"] as? String, let status = item["status"] as? String else { return nil }
                    let node = NavigatorNode(.file, path: path, title: path)
                    node.detail = status == "??" ? "Untracked" : "Index / worktree: \(status)"
                    return node
                }
                finish([branch, flat.isEmpty ? "No changed files" : "\(flat.count) changed files"].filter { !$0.isEmpty }.joined(separator: " · "), data)
            }
        }
    }

    private func paintDiff(_ text: String) {
        let theme = WorkspaceStyle.theme
        let base: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: theme.text]
        let result = NSMutableAttributedString(string: text, attributes: base)
        let content = text as NSString
        var start = 0
        while start < content.length {
            let line = content.lineRange(for: NSRange(location: start, length: 0))
            let colour: NSColor? = switch content.character(at: start) { case 43: theme.added; case 45: theme.deleted; case 64: theme.accent; default: nil }
            if let colour { result.addAttribute(.foregroundColor, value: colour, range: line) }
            start = NSMaxRange(line)
        }
        patch.textStorage?.setAttributedString(result)
    }

    private func finish(_ label: String, _ data: Fields) {
        count.stringValue = label + (data["limited"] as? Bool == true ? " · Partial results" : "")
        reloadRows(); refreshChrome()
    }

    // MARK: Layout and appearance

    @objc private func applyStyle() {
        let theme = WorkspaceStyle.theme
        heading.font = WorkspaceStyle.interfaceFont(weight: .semibold)
        count.font = WorkspaceStyle.interfaceFont(-2)
        heading.textColor = theme.text; count.textColor = theme.secondaryText
        query.font = WorkspaceStyle.interfaceFont(-1); query.textColor = theme.text
        query.backgroundColor = theme.editor; kind.selectedSegmentBezelColor = theme.chosen
        for button in [back, reload, openFile] { button.contentTintColor = theme.secondaryText }
        patch.backgroundColor = theme.chrome
        let selectedRange = patch.selectedRange()
        paintDiff(patch.string); patch.setSelectedRange(selectedRange)
        canvas.needsDisplay = true; canvas.needsLayout = true
        outline.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<outline.numberOfRows))
        repaintVisibleRows()
    }

    private func refreshChrome() {
        switch mode {
        case .files:
            heading.stringValue = "Project files"
            count.stringValue = treeError ? "Could not refresh folders" : root.children == nil ? "Loading…"
                : root.rowCount == 0 ? "Empty folder" : root.limited ? "Partial results" : ""
        case .search: heading.stringValue = "Project search"
        case .git: heading.stringValue = "Local Git"
        case .diff: heading.stringValue = selectedDiff ?? "Diff"
        }
        heading.toolTip = heading.stringValue
        heading.isHidden = mode == .files
        reload.isHidden = mode == .files
        count.toolTip = count.stringValue
        count.isHidden = count.stringValue.isEmpty
        back.isHidden = mode != .diff
        query.isHidden = mode != .search; kind.isHidden = mode != .search
        diffBox.isHidden = mode != .diff; openFile.isHidden = mode != .diff; list.isHidden = mode == .diff
        canvas.needsLayout = true
    }

    private func arrange(_ bounds: NSRect) {
        let w = bounds.width, h = bounds.height
        let leading: CGFloat = back.isHidden ? 12 : 37
        let controls: CGFloat = openFile.isHidden ? 36 : 100
        let headerHeight = heading.isHidden ? 5 : max(36, ceil(heading.font?.boundingRectForFont.height ?? 18) + 12)
        back.frame = NSRect(x: 4, y: (headerHeight - 26) / 2, width: 28, height: 26)
        heading.frame = NSRect(x: leading, y: 6, width: max(0, w - leading - controls), height: max(0, headerHeight - 12))
        reload.frame = NSRect(x: w - 31, y: (headerHeight - 26) / 2, width: 25, height: 26)
        openFile.frame = NSRect(x: w - 99, y: (headerHeight - 26) / 2, width: 66, height: 26)
        var y = headerHeight
        if mode == .search {
            let queryHeight = max(24, ceil(query.font?.boundingRectForFont.height ?? 18) + 8)
            kind.frame = NSRect(x: 9, y: y, width: max(0, w - 18), height: 24); y += 29
            query.frame = NSRect(x: 9, y: y, width: max(0, w - 18), height: queryHeight); y += queryHeight + 6
        }
        if !count.isHidden {
            let height = ceil(count.font?.boundingRectForFont.height ?? 17) + 2
            count.frame = NSRect(x: 12, y: y, width: max(0, w - 24), height: height); y += height + 3
        }
        let area = NSRect(x: 0, y: y, width: w, height: max(0, h - y)); list.frame = area; diffBox.frame = area
        column.width = max(30, list.contentSize.width)
    }

    // MARK: Rows

    private var openSectionCount: Int { tabs.isEmpty ? 0 : tabs.count + 1 }

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if let node = item as? NavigatorNode { return node.rowCount }
        return mode == .files ? openSectionCount + 1 + root.rowCount : flat.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if let node = item as? NavigatorNode { return node.row(at: index) }
        guard mode == .files else { return flat[index] }
        if index == openSectionCount { return foldersHeading }
        if index > openSectionCount { return root.row(at: index - openSectionCount - 1) }
        if index == 0 { return openHeading }
        return tabs[index - 1]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        mode == .files && (item as? NavigatorNode)?.kind == .folder
    }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        (item as? NavigatorNode)?.kind != .section
    }

    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        guard let node = item as? NavigatorNode else { return 24 }
        let textHeight = ceil(nameFont(node).boundingRectForFont.height) + 8
        let detailHeight = node.detail.isEmpty ? 0 : ceil(WorkspaceStyle.interfaceFont(-2).boundingRectForFont.height)
        return max(24, textHeight + detailHeight)
    }

    private func nameFont(_ node: NavigatorNode) -> NSFont {
        if node.tab?.preview == true { return NSFontManager.shared.convert(WorkspaceStyle.interfaceFont(), toHaveTrait: .italicFontMask) }
        if node.kind == .section { return WorkspaceStyle.interfaceFont(-2, weight: .semibold) }
        return WorkspaceStyle.interfaceFont(weight: node.kind == .folder ? .bold : .regular)
    }

    private func reservesAccessory(_ node: NavigatorNode) -> Bool { mode == .files && (node.kind == .tab || node.kind == .file) }

    func outlineView(_ outlineView: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
        guard let node = item as? NavigatorNode else { return nil }
        let row = NavigatorRow()
        row.isTab = node.kind == .tab
        row.isCurrentTab = row.isTab && node.path == selectedTab
        row.isFolder = node.kind == .folder || node === foldersHeading
        return row
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? NavigatorNode else { return nil }
        let identity = NSUserInterfaceItemIdentifier("ProjectRow")
        let cell = outlineView.makeView(withIdentifier: identity, owner: self) as? NavigatorCell ?? NavigatorCell(frame: .zero)
        cell.identifier = identity
        cell.editor = nil
        style(cell, node: node)
        return cell
    }

    private func style(_ cell: NavigatorCell, node: NavigatorNode) {
        let theme = WorkspaceStyle.theme
        let tab = node.tab
        let mark = mode == .files && node.kind == .file ? marks[node.path] : nil
        cell.section = node.kind == .section
        cell.reservesBadge = reservesAccessory(node) && tab == nil
        cell.name.stringValue = tab?.label ?? node.title
        cell.name.font = nameFont(node)
        cell.name.textColor = cell.section || node.kind == .more || tab?.preview == true ? theme.secondaryText : theme.text
        cell.detail.stringValue = node.detail; cell.detail.textColor = theme.secondaryText
        cell.detail.font = WorkspaceStyle.interfaceFont(-2)
        cell.badge.stringValue = mark?.letter ?? ""
        cell.badge.font = WorkspaceStyle.interfaceFont(-2, weight: .semibold)
        cell.badge.textColor = mark?.colour ?? theme.mutedText
        cell.badge.toolTip = mark?.label
        cell.editor?.font = cell.name.font
        cell.editor?.backgroundColor = theme.editor; cell.editor?.textColor = theme.text
        let icon: (String, NSColor)?
        switch node.kind {
        case .section: icon = nil
        case .folder:
            let open = outline.isItemExpanded(node)
            icon = (open ? "folder.fill" : "folder", theme.role(open ? "sky" : "blue") ?? theme.accent)
        case .file:
            let file = WorkspaceFileIcon.forPath(node.path)
            icon = (file.symbol, file.colour)
        case .more: icon = ("ellipsis", theme.secondaryText)
        case .tab:
            let role = tab?.colourRole.flatMap { theme.role($0) }
            icon = (tab?.symbol ?? "doc.text", tab?.warns == true ? theme.warning : role ?? theme.secondaryText)
        }
        cell.icon.image = icon.flatMap { NSImage(systemSymbolName: $0.0, accessibilityDescription: nil) }
        cell.icon.contentTintColor = icon?.1
        if let tab {
            cell.setClose(title: tab.label, unsaved: tab.unsaved) { [weak self] in self?.onCloseTab?(tab.key) }
            cell.toolTip = tab.detail
            cell.setAccessibilityLabel([tab.label, tab.preview ? "Preview" : "", tab.unsaved ? "Unsaved" : "", tab.warns ? "Warning" : ""].filter { !$0.isEmpty }.joined(separator: ", "))
            cell.setAccessibilityValue(node.path == selectedTab ? "Selected" : "")
        } else {
            cell.setClose(title: nil, unsaved: false, run: nil)
            cell.toolTip = nil
            cell.setAccessibilityLabel([cell.section ? node.title : node.path, node.detail, mark?.label ?? ""].filter { !$0.isEmpty }.joined(separator: "\n"))
            cell.setAccessibilityValue("")
        }
        cell.needsLayout = true
    }

    private func repaint(_ node: NavigatorNode) {
        let index = outline.row(forItem: node)
        if index >= 0 { repaint(row: index, node: node) }
    }

    private func repaint(row: Int, node: NavigatorNode) {
        if let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: false) as? NavigatorCell { style(cell, node: node) }
        if let view = outline.rowView(atRow: row, makeIfNecessary: false) as? NavigatorRow {
            view.isCurrentTab = view.isTab && node.path == selectedTab
            view.needsDisplay = true
        }
    }

    private func repaintVisibleRows() {
        let visible = outline.rows(in: outline.visibleRect)
        guard visible.location != NSNotFound, visible.length > 0 else { return }
        for row in visible.location..<NSMaxRange(visible) {
            if let node = outline.item(atRow: row) as? NavigatorNode { repaint(row: row, node: node) }
        }
    }

    func outlineView(_ outlineView: NSOutlineView, shouldExpandItem item: Any) -> Bool {
        guard let node = item as? NavigatorNode, node.kind == .folder else { return false }
        if node.children == nil { load(node, offset: 0); return false }
        return true
    }

    func outlineViewItemDidExpand(_ notification: Notification) {
        guard let node = notification.userInfo?["NSObject"] as? NavigatorNode else { return }
        repaint(node)
        guard !restoringRows else { return }
        if expanded.insert(node.path).inserted { onLayoutChange?() }
        let wasRestoring = restoringRows
        restoringRows = true
        restoreExpansion(of: node)
        restoringRows = wasRestoring
    }

    func outlineViewItemDidCollapse(_ notification: Notification) {
        guard let node = notification.userInfo?["NSObject"] as? NavigatorNode else { return }
        repaint(node)
        if !restoringRows, expanded.remove(node.path) != nil { onLayoutChange?() }
    }

    // MARK: Input

    @objc private func clicked() {
        let row = outline.clickedRow
        guard row >= 0, let node = outline.item(atRow: row) as? NavigatorNode else { return }
        if let event = NSApplication.shared.currentEvent, event.type == .leftMouseUp || event.type == .leftMouseDown,
           outline.frameOfOutlineCell(atRow: row).contains(outline.convert(event.locationInWindow, from: nil)) { return }
        if mode == .files, node.kind == .file {
            if WorkspaceStyle.settings.previewOnClick { onPreview?(node.path) }
        } else { activate(node) }
    }

    @objc private func doubleClicked() {
        guard let node = outline.item(atRow: outline.clickedRow) as? NavigatorNode else { return }
        if mode == .files, node.kind == .file { activate(node) }
    }

    private func handleTreeKey(_ event: NSEvent) -> Bool {
        guard let node = outline.item(atRow: outline.selectedRow) as? NavigatorNode else { return false }
        let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if flags.isEmpty, event.keyCode == 36 || event.keyCode == 76 { activate(node); return true }
        guard mode == .files, node.kind == .file || node.kind == .folder, onFileAction != nil else { return false }
        if flags.isEmpty, event.keyCode == 120 { beginRename(node); return true }
        if flags == .command, event.keyCode == 51 || event.keyCode == 117 { onFileAction?(.remove(node.path)); return true }
        return false
    }

    private func activate(_ node: NavigatorNode) {
        switch node.kind {
        case .folder:
            if outline.isItemExpanded(node) { outline.collapseItem(node) }
            else { outline.expandItem(node) }
        case .more:
            if let folder = node.parent, let offset = folder.next { load(folder, offset: offset) }
        case .file:
            if mode == .git { loadGit(node.path) } else { onOpen?(node.path, node.line) }
        case .tab: onSelectTab?(node.path)
        case .section: break
        }
    }

    private func menu(at row: Int) -> NSMenu? {
        let node = outline.item(atRow: row) as? NavigatorNode
        guard node?.kind != .more else { return nil }
        if let tab = node?.tab {
            let menu = NSMenu()
            menu.addItem(WorkspaceChoice("Close \(tab.label)") { [weak self] in self?.onCloseTab?(tab.key) })
            return menu
        }
        if node === openHeading || (node == nil && mode != .files) { return nil }
        let menu = NSMenu()
        let path = node?.path ?? ""
        let dir = node?.kind != .file
        if !dir {
            menu.addItem(WorkspaceChoice("Open file") { [weak self] in self?.onOpen?(path, node?.line) })
        }
        if mode == .files {
            let parent = dir ? path : Self.parent(of: path)
            menu.addItem(WorkspaceChoice("New file in this folder…") { [weak self] in
                guard let self else { return }
                if let onFileAction { onFileAction(.newFile(parent)) } else { onNewFile?(parent) }
            })
            if onFileAction != nil {
                func action(_ label: String, _ value: NavigatorFileAction) {
                    menu.addItem(WorkspaceChoice(label) { [weak self] in self?.onFileAction?(value) })
                }
                action("New folder…", .newFolder(parent))
                if let node, !path.isEmpty {
                    menu.addItem(.separator())
                    menu.addItem(WorkspaceChoice("Rename…") { [weak self] in self?.beginRename(node) })
                    action("Duplicate…", .duplicate(path))
                    action("Move to Trash…", .remove(path))
                    menu.addItem(.separator())
                    action("Copy path", .copyPath(path))
                    action("Copy relative path", .copyRelativePath(path))
                }
                action("Reveal in Finder", .reveal(path))
            }
            menu.addItem(.separator())
        }
        if !dir {
            menu.addItem(WorkspaceChoice("Show Git diff") { [weak self] in self?.gitScope = path; self?.loadGit(path) })
        }
        menu.addItem(WorkspaceChoice(dir ? "Note on folder…" : "Note on file…") { [weak self] in self?.onNote?(dir ? "folder" : "file", path) })
        return menu
    }

    private func beginRename(_ node: NavigatorNode) {
        guard onFileAction != nil, !node.path.isEmpty else { return }
        finishRename(commit: false)
        select(node, scroll: true)
        let row = outline.row(forItem: node)
        guard row >= 0, let cell = outline.view(atColumn: 0, row: row, makeIfNecessary: true) as? NavigatorCell else { return }
        let field = NSTextField(string: node.title)
        field.delegate = self
        field.lineBreakMode = .byClipping
        field.setAccessibilityLabel("Rename \(node.title)")
        rename = (node, cell, field)
        cell.editor = field
        style(cell, node: node)
        cell.layoutSubtreeIfNeeded()
        field.selectText(nil)
        if node.kind == .file, let editor = field.currentEditor() {
            let name = node.title as NSString
            let stem = name.deletingPathExtension as NSString
            editor.selectedRange = NSRange(location: 0, length: stem.length > 0 ? stem.length : name.length)
        }
    }

    private func finishRename(commit: Bool, returnFocus: Bool = false) {
        guard let rename else { return }
        self.rename = nil
        let editor = rename.field.currentEditor()
        let title = editor?.string ?? rename.field.stringValue
        rename.field.delegate = nil
        if editor != nil, commit || returnFocus { canvas.window?.makeFirstResponder(outline) }
        rename.cell.editor = nil
        if refreshAfterRename {
            refreshAfterRename = false
            reloadTree()
        }
        guard commit, title != rename.node.title else { return }
        guard Self.isProjectPath(title), !title.contains("/") else {
            onError?("Enter a file or folder name without a path.")
            return
        }
        let parent = Self.parent(of: rename.node.path)
        onFileAction?(.rename(rename.node.path, parent.isEmpty ? title : parent + "/" + title))
    }

    // Only this outline can move its own project-relative paths. The stage also reads the
    // custom type to open a file, but it never receives a file-system move from this source.
    func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> (any NSPasteboardWriting)? {
        guard mode == .files, let node = item as? NavigatorNode, node.kind == .file || node.kind == .folder else { return nil }
        let paste = NSPasteboardItem()
        paste.setString(node.path, forType: Self.pathType)
        return paste
    }

    private func drop(_ info: any NSDraggingInfo, item: Any?) -> NavigatorFileAction? {
        guard mode == .files, onFileAction != nil, let node = item as? NavigatorNode,
              node.kind == .folder || node === foldersHeading,
              let source = info.draggingSource as? NavigatorOutline, source === outline,
              let path = info.draggingPasteboard.string(forType: Self.pathType), Self.isProjectPath(path),
              node.path != Self.parent(of: path), node.path != path, !node.path.hasPrefix(path + "/") else { return nil }
        return .move(path, node.path)
    }

    func outlineView(_ outlineView: NSOutlineView, validateDrop info: any NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation {
        guard drop(info, item: item) != nil else { return [] }
        outlineView.setDropItem(item, dropChildIndex: NSOutlineViewDropOnItemIndex)
        return .move
    }

    func outlineView(_ outlineView: NSOutlineView, acceptDrop info: any NSDraggingInfo, item: Any?, childIndex index: Int) -> Bool {
        guard let action = drop(info, item: item) else { return false }
        onFileAction?(action)
        return true
    }

    @objc private func switchQuery() {
        query.placeholderString = kind.selectedSegment == 1 ? "Find literal text in saved files" : "Find files by name"
        search(delay: false)
    }

    func controlTextDidChange(_ obj: Notification) {
        if obj.object as? NSSearchField === query { search(delay: true) }
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        if let field = rename?.field, obj.object as? NSTextField === field { finishRename(commit: false) }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if let field = rename?.field, control === field {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) { finishRename(commit: true); return true }
            if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
                finishRename(commit: false, returnFocus: true)
                return true
            }
            return false
        }
        if commandSelector == #selector(NSResponder.insertNewline(_:)), mode == .search {
            if !flat.isEmpty { activate(flat[max(0, outline.selectedRow)]) } else { search(delay: false) }
            return true
        }
        if commandSelector == #selector(NSResponder.moveDown(_:)), outline.numberOfRows > 0 {
            canvas.window?.makeFirstResponder(outline)
            if outline.selectedRow < 0 { outline.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
            return true
        }
        return false
    }

    private func refresh() {
        switch mode {
        case .diff: loadGit(selectedDiff)
        case .files: reloadTree()
        case .search: search(delay: false)
        case .git: loadGit(nil)
        }
    }
}
