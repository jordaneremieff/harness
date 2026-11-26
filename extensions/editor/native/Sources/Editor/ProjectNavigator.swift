import AppKit

/// One row of the navigator: a folder or a file of the project tree, a search hit, a changed
/// file, or the row that loads the next page of a folder.
@MainActor
private final class NavigatorNode {
    enum Kind { case folder, file, more }
    let kind: Kind
    let path: String
    let title: String
    var detail = ""
    var line: Int?
    /// The entries of a folder that has been read, and nil before that.
    var children: [NavigatorNode]?
    /// The offset of the next page of a folder with more entries than one page holds.
    var next: Int?
    var limited = false
    var expanded = false
    weak var parent: NavigatorNode?
    private(set) lazy var more: NavigatorNode = {
        let node = NavigatorNode(.more, path: path, title: "More files…")
        node.parent = self
        return node
    }()

    init(_ kind: Kind, path: String, title: String) {
        self.kind = kind
        self.path = path
        self.title = title
    }

    var rows: [NavigatorNode] { (children ?? []) + (next == nil ? [] : [more]) }
    var icon: String { kind == .folder ? "folder" : kind == .more ? "ellipsis" : "doc.text" }
}

@MainActor
private final class NavigatorOutline: NSOutlineView {
    var menuAt: ((Int) -> NSMenu?)?
    var activate: (() -> Void)?
    /// A list without folders has no use for the room that disclosure marks take.
    var flat = false
    override func menu(for event: NSEvent) -> NSMenu? { menuAt?(row(at: convert(event.locationInWindow, from: nil))) }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 { activate?(); return }
        super.keyDown(with: event)
    }
    override func frameOfCell(atColumn column: Int, row: Int) -> NSRect {
        var frame = super.frameOfCell(atColumn: column, row: row)
        if flat {
            frame.size.width += frame.minX
            frame.origin.x = 0
        }
        return frame
    }
}

@MainActor
private final class NavigatorCanvas: NSView {
    var arrange: ((NSRect) -> Void)?
    override var isFlipped: Bool { true }
    override func layout() { super.layout(); arrange?(bounds) }
}

@MainActor
private final class NavigatorCell: NSTableCellView {
    let name = NSTextField(labelWithString: "")
    let detail = NSTextField(labelWithString: "")
    let icon = NSImageView()
    static let textInset: CGFloat = 26
    static let trailingInset: CGFloat = 4
    override init(frame: NSRect) {
        super.init(frame: frame)
        name.font = .systemFont(ofSize: 12)
        detail.font = .systemFont(ofSize: 11); detail.textColor = .secondaryLabelColor
        name.lineBreakMode = .byTruncatingMiddle; detail.lineBreakMode = .byTruncatingTail
        icon.symbolConfiguration = .init(pointSize: 12, weight: .regular)
        for view in [icon, name, detail] { addSubview(view) }
    }
    required init?(coder: NSCoder) { nil }
    override func layout() {
        super.layout()
        let h = bounds.height, w = bounds.width
        icon.frame = NSRect(x: 2, y: (h-18)/2, width: 18, height: 18)
        let multi = !detail.stringValue.isEmpty
        let textWidth = max(0, w - Self.textInset - Self.trailingInset)
        name.frame = NSRect(x: Self.textInset, y: multi ? h-18 : (h-17)/2, width: textWidth, height: 17)
        detail.frame = NSRect(x: Self.textInset, y: 1, width: textWidth, height: multi ? 15 : 0)
    }
}

/// The sidebar panel for the project: its folders as a tree that opens in place, a search
/// for paths or text, and the files that local Git reports as changed.
@MainActor
final class ProjectNavigator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSSearchFieldDelegate {
    private enum Mode { case files, search, git, diff }
    private let api: any EditorAPI
    private let canvas = NavigatorCanvas()
    private let heading = NSTextField(labelWithString: "Project files")
    private let count = NSTextField(labelWithString: "")
    private let back = WorkspaceButton("", symbol: "chevron.backward", help: "Go back")
    private let reload = WorkspaceButton("", symbol: "arrow.clockwise", help: "Refresh list")
    private let openFile = WorkspaceButton("Open", symbol: "doc", help: "Open file for editing")
    private let query = NSSearchField()
    private let kind = NSSegmentedControl(labels: ["File names", "Contents"], trackingMode: .selectOne,target:nil,action:nil)
    private let list = NSScrollView()
    private let outline = NavigatorOutline()
    private let column = NSTableColumn(identifier: .init("Path"))
    private let diffBox = NSScrollView()
    private let patch = NSTextView()
    private let root = NavigatorNode(.folder, path: "", title: "")
    /// Search hits or changed files, which have no folders.
    private var flat: [NavigatorNode] = []
    private var mode: Mode = .files
    private var gitScope: String?
    private var selectedDiff: String?
    private var task: Task<Void, Never>?
    private var loads: [String: Task<Void, Never>] = [:]
    private var generation = 0
    var view: NSView { canvas }
    /// The narrowest width that shows every listed name in full. A diff has no such width.
    var fittingWidth: CGFloat? {
        guard mode != .diff, outline.numberOfRows > 0 else { return nil }
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12)]
        var widest: CGFloat = 0
        for row in 0..<min(outline.numberOfRows, 600) {
            guard let node = outline.item(atRow: row) as? NavigatorNode else { continue }
            let text = (node.title as NSString).size(withAttributes: attributes).width
            widest = max(widest, outline.frameOfCell(atColumn: 0, row: row).minX + text)
        }
        let scroller = list.frame.width - list.contentSize.width
        return ceil(widest) + NavigatorCell.textInset + NavigatorCell.trailingInset + scroller + 6
    }
    var onOpen: ((String, Int?) -> Void)?
    var onNote: ((String, String) -> Void)?
    var onError: ((String) -> Void)?
    var onExpand: ((Bool) -> Void)?

    init(api: any EditorAPI) {
        self.api = api; super.init()
        heading.font = .systemFont(ofSize: 13,weight: .semibold); heading.lineBreakMode = .byTruncatingMiddle
        count.font = .systemFont(ofSize: 11); count.textColor = .secondaryLabelColor; count.lineBreakMode = .byTruncatingTail
        query.placeholderString = "Find files by name"; query.setAccessibilityLabel("Project query")
        query.delegate = self; query.sendsSearchStringImmediately = true
        kind.selectedSegment = 0; kind.target = self; kind.action = #selector(switchQuery); kind.controlSize = .small
        kind.setAccessibilityLabel("Search by file name or contents")
        outline.headerView = nil; outline.style = .plain; outline.usesAlternatingRowBackgroundColors = false
        outline.intercellSpacing = NSSize(width: 0,height: 0); outline.allowsEmptySelection = true
        outline.indentationPerLevel = 14; outline.autoresizesOutlineColumn = false
        outline.addTableColumn(column); outline.outlineTableColumn = column
        outline.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle; column.minWidth = 30
        outline.delegate = self; outline.dataSource = self; outline.target = self; outline.action = #selector(clicked)
        outline.setAccessibilityLabel("Project results")
        // The region behind the navigator paints one surface for its heading and its list.
        outline.backgroundColor = .clear; list.drawsBackground = false
        list.hasVerticalScroller = true; list.autohidesScrollers = true; list.documentView = outline
        patch.font = .monospacedSystemFont(ofSize: 12, weight: .regular); patch.isEditable = false; patch.isSelectable = true
        patch.isRichText = false; patch.textContainerInset = .init(width: 8,height: 6)
        patch.isVerticallyResizable = true; patch.isHorizontallyResizable = false; patch.autoresizingMask = [.width]
        patch.textContainer?.widthTracksTextView = true; patch.setAccessibilityLabel("Git diff")
        diffBox.hasVerticalScroller = true; diffBox.autohidesScrollers = true; diffBox.documentView = patch
        for v in [heading, count, back, reload, openFile, query, kind, list, diffBox] { canvas.addSubview(v) }
        canvas.arrange = { [weak self] in self?.arrange($0) }
        outline.activate = { [weak self] in guard let self else { return }; activate(outline.selectedRow) }
        outline.menuAt = { [weak self] index in self?.menu(at: index) }
        back.run = { [weak self] in self?.loadGit(nil) }; reload.run = { [weak self] in self?.refresh() }
        openFile.run = { [weak self] in guard let self, let path = selectedDiff else { return }; onOpen?(path,nil) }
        refreshChrome()
    }

    func start() async throws {
        let g = reset(.files)
        let data = try await api.call("tree", ["path":""])
        guard g == generation else { return }
        apply(data, to: root, append: false)
    }
    func stop() {
        generation += 1; task?.cancel(); task = nil
        for load in loads.values { load.cancel() }
        loads.removeAll()
    }
    func showFiles() { reloadTree() }
    func showSearch(contents: Bool = false) {
        kind.selectedSegment = contents ? 1 : 0
        switchQuery()
        canvas.window?.makeFirstResponder(query)
        query.selectText(nil)
    }
    func showGit(doc: String? = nil) { gitScope = doc; loadGit(nil) }

    // MARK: Modes

    /// Ends the work of the mode on show and starts another. The project tree stays loaded
    /// while a search or the Git list is on show.
    private func reset(_ newMode: Mode, clear: Bool = true) -> Int {
        generation += 1; task?.cancel(); task = nil
        for load in loads.values { load.cancel() }
        loads.removeAll()
        let expanded = mode == .diff
        let changed = mode != newMode
        mode = newMode
        outline.flat = mode != .files
        if clear, mode != .files { flat = [] }
        if clear || changed { outline.deselectAll(nil); reloadRows() }
        refreshChrome()
        if expanded != (mode == .diff) { onExpand?(mode == .diff) }
        return generation
    }
    private func reloadRows() {
        outline.reloadData()
        if mode == .files { restoreExpansion(of: root) }
    }
    private func restoreExpansion(of node: NavigatorNode) {
        for child in node.children ?? [] where child.expanded && child.children != nil {
            outline.expandItem(child)
            restoreExpansion(of: child)
        }
    }
    private func fetch(_ op: String, _ fields: Fields, mode: Mode, delay: Bool = false, apply: @escaping (Fields) -> Void) {
        let g = reset(mode)
        count.stringValue = "Loading…"; refreshChrome()
        task = Task { [weak self, api] in
            do {
                if delay { try await Task.sleep(for: .milliseconds(140)) }
                let data = try await api.call(op,fields)
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

    private func entries(_ data: Fields) -> [NavigatorNode] {
        (data["entries"] as? [Fields] ?? []).compactMap { item in
            guard let path = item["path"] as? String, let title = item["name"] as? String, let dir = item["dir"] as? Bool else { return nil }
            return NavigatorNode(dir ? .folder : .file, path: path, title: title)
        }
    }
    /// Puts one page of a folder into the tree. A later page joins the entries on show.
    private func apply(_ data: Fields, to node: NavigatorNode, append: Bool) {
        var children = (append ? node.children ?? [] : []) + entries(data)
        children.sort { a, b in
            (a.kind == .folder) == (b.kind == .folder) ? a.title.localizedStandardCompare(b.title) == .orderedAscending : a.kind == .folder
        }
        for child in children { child.parent = node }
        node.children = children
        node.next = data["next"] as? Int
        node.limited = data["limited"] as? Bool == true
        guard mode == .files else { return }
        if node === root { reloadRows() }
        else {
            node.expanded = true
            outline.reloadItem(node, reloadChildren: true)
            outline.expandItem(node)
            restoreExpansion(of: node)
        }
        refreshChrome()
    }
    private func load(_ node: NavigatorNode, offset: Int) {
        guard loads[node.path] == nil else { return }
        let g = generation
        loads[node.path] = Task { [weak self, api] in
            do {
                let data = try await api.call("tree", ["path":node.path,"offset":offset])
                guard let self, g == generation, !Task.isCancelled else { return }
                loads[node.path] = nil
                apply(data, to: node, append: offset != 0)
            } catch {
                guard let self, g == generation, !Task.isCancelled else { return }
                loads[node.path] = nil
                refreshChrome()
                onError?(error.localizedDescription)
            }
        }
        refreshChrome()
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
    private func expandedPaths(under node: NavigatorNode) -> [String] {
        (node.children ?? []).filter { $0.expanded && $0.children != nil }.flatMap { [$0.path] + expandedPaths(under: $0) }
    }
    /// Reads the tree again from disk and keeps the folders that were open as they were. The
    /// rows change once, after every open folder has been read.
    private func reloadTree() {
        let open = expandedPaths(under: root)
        let g = reset(.files, clear: false)
        refreshChrome()
        task = Task { [weak self, api] in
            do {
                let top = try await api.call("tree", ["path":""])
                var pages: [(String, Fields)] = []
                for path in open {
                    // A folder that left the disk since the last read drops out of the tree.
                    guard let page = try? await api.call("tree", ["path":path]) else { continue }
                    pages.append((path, page))
                }
                guard let self, g == generation, !Task.isCancelled else { return }
                self.task = nil
                apply(top, to: root, append: false)
                for (path, page) in pages {
                    guard let folder = node(at: path), folder.kind == .folder else { continue }
                    apply(page, to: folder, append: false)
                }
                refreshChrome()
            } catch {
                guard let self, g == generation, !Task.isCancelled else { return }
                self.task = nil; refreshChrome()
                onError?(error.localizedDescription)
            }
        }
    }

    // MARK: Search and Git

    private func search(delay: Bool) {
        let text = query.stringValue
        guard !text.isEmpty else {
            _ = reset(.search); count.stringValue = kind.selectedSegment == 1 ? "Enter text to search saved files" : "Enter part of a file name"
            refreshChrome(); return
        }
        fetch("search", ["kind":kind.selectedSegment == 1 ? "text" : "paths","query":text],mode:.search,delay:delay) { [weak self] data in
            guard let self else { return }
            flat = (data["hits"] as? [Fields] ?? []).compactMap { item in
                guard let path = item["path"] as? String else { return nil }
                let line = item["line"] as? Int
                let node = NavigatorNode(.file, path: path, title: line.map { "\(path):\($0)" } ?? path)
                node.detail = item["preview"] as? String ?? ""; node.line = line
                return node
            }
            finish(flat.isEmpty ? "No matches" : "\(flat.count) matches",data)
            if !flat.isEmpty { outline.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
        }
    }
    private func loadGit(_ diff: String?) {
        selectedDiff = diff
        var fields: Fields = [:]; fields["doc"] = diff ?? gitScope
        if diff != nil { patch.string = "" }
        fetch("git", fields, mode:diff == nil ? .git : .diff) { [weak self] data in
            guard let self else { return }
            guard data["repo"] as? Bool == true else { finish("No local Git repository",data); return }
            let branch = data["branch"] as? String ?? ""
            if let diff {
                let output = data["diff"] as? String ?? ""
                paintDiff(output)
                patch.scrollToBeginningOfDocument(nil)
                let label = output.isEmpty ? "No diff available" : "Working tree diff"
                finish([branch,label].filter { !$0.isEmpty }.joined(separator:" · "),data)
                heading.stringValue = diff; heading.toolTip = diff
            } else {
                flat = (data["files"] as? [Fields] ?? []).compactMap { item in
                    guard let path = item["path"] as? String, let status = item["status"] as? String else { return nil }
                    let node = NavigatorNode(.file, path: path, title: path)
                    node.detail = status == "??" ? "Untracked" : "Index / worktree: \(status)"
                    return node
                }
                finish([branch,flat.isEmpty ? "No changed files" : "\(flat.count) changed files"].filter { !$0.isEmpty }.joined(separator:" · "),data)
            }
        }
    }
    private func paintDiff(_ text: String) {
        let base: [NSAttributedString.Key:Any] = [.font:NSFont.monospacedSystemFont(ofSize:12,weight:.regular),.foregroundColor:NSColor.labelColor]
        let result = NSMutableAttributedString(string:text, attributes:base)
        let content = text as NSString
        var start = 0
        while start < content.length {
            let line = content.lineRange(for:NSRange(location:start,length:0))
            let colour: NSColor? = switch content.character(at:start) { case 43: .systemGreen; case 45: .systemRed; case 64: .systemBlue; default: nil }
            if let colour { result.addAttribute(.foregroundColor,value:colour,range:line) }
            start = NSMaxRange(line)
        }
        patch.textStorage?.setAttributedString(result)
    }
    private func finish(_ label: String, _ data: Fields) {
        count.stringValue = label + (data["limited"] as? Bool == true ? " · Partial results" : "")
        reloadRows(); refreshChrome()
    }

    // MARK: Layout

    private func refreshChrome() {
        switch mode {
        case .files:
            heading.stringValue = "Project files"
            // The tree needs a line of status only while it has something to report.
            count.stringValue = root.children == nil ? "Loading…" : root.rows.isEmpty ? "Empty folder" : root.limited ? "Partial results" : ""
        case .search: heading.stringValue = "Project search"
        case .git: heading.stringValue = "Local Git"
        case .diff: heading.stringValue = selectedDiff ?? "Diff"
        }
        heading.toolTip = heading.stringValue
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
        back.frame = NSRect(x:4,y:5,width:28,height:26)
        heading.frame = NSRect(x:leading,y:9,width:max(0,w-leading-controls),height:20)
        reload.frame = NSRect(x:w-31,y:5,width:25,height:26)
        openFile.frame = NSRect(x:w-99,y:5,width:66,height:26)
        var y: CGFloat = 36
        if mode == .search {
            kind.frame = NSRect(x:9,y:y,width:max(0,w-18),height:24); y += 29
            query.frame = NSRect(x:9,y:y,width:max(0,w-18),height:24); y += 30
        }
        if !count.isHidden { count.frame = NSRect(x:12,y:y,width:max(0,w-24),height:18); y += 21 }
        let area = NSRect(x:0,y:y,width:w,height:max(0,h-y)); list.frame = area; diffBox.frame = area
        column.width = max(30,list.contentSize.width)
    }

    // MARK: Rows

    private func rows(of item: Any?) -> [NavigatorNode] {
        if let node = item as? NavigatorNode { return node.rows }
        return mode == .files ? root.rows : flat
    }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { rows(of: item).count }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { rows(of: item)[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        mode == .files && (item as? NavigatorNode)?.kind == .folder
    }
    func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
        (item as? NavigatorNode)?.detail.isEmpty == false ? 36 : 24
    }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? NavigatorNode else { return nil }
        let identity = NSUserInterfaceItemIdentifier("ProjectRow")
        let cell = outlineView.makeView(withIdentifier:identity,owner:self) as? NavigatorCell ?? NavigatorCell(frame:.zero)
        cell.identifier = identity; cell.name.stringValue = node.title; cell.detail.stringValue = node.detail
        cell.name.textColor = node.kind == .more ? .secondaryLabelColor : .labelColor
        cell.icon.image = NSImage(systemSymbolName:node.icon,accessibilityDescription:nil)
        cell.icon.contentTintColor = node.kind == .folder ? .controlAccentColor : .secondaryLabelColor
        // A name that does not fit shows in full under the pointer; other rows need no hover text.
        cell.name.allowsExpansionToolTips = true; cell.detail.allowsExpansionToolTips = true
        cell.setAccessibilityLabel([node.path,node.detail].filter { !$0.isEmpty }.joined(separator:"\n")); cell.needsLayout = true
        return cell
    }
    /// A folder that has not been read opens when its first page arrives.
    func outlineView(_ outlineView: NSOutlineView, shouldExpandItem item: Any) -> Bool {
        guard let node = item as? NavigatorNode, node.kind == .folder else { return false }
        if node.children == nil { load(node, offset: 0); return false }
        return true
    }
    func outlineViewItemDidExpand(_ notification: Notification) {
        (notification.userInfo?["NSObject"] as? NavigatorNode)?.expanded = true
    }
    func outlineViewItemDidCollapse(_ notification: Notification) {
        (notification.userInfo?["NSObject"] as? NavigatorNode)?.expanded = false
    }
    @objc private func clicked() {
        let row = outline.clickedRow
        // The disclosure mark opens and closes its folder itself.
        if row >= 0, let event = NSApplication.shared.currentEvent, event.type == .leftMouseUp || event.type == .leftMouseDown,
           outline.frameOfOutlineCell(atRow: row).contains(outline.convert(event.locationInWindow, from: nil)) { return }
        activate(row)
    }
    private func activate(_ row: Int) {
        guard let node = outline.item(atRow: row) as? NavigatorNode else { return }
        switch node.kind {
        case .folder:
            if node.children == nil { load(node, offset: 0) }
            else if outline.isItemExpanded(node) { outline.collapseItem(node) }
            else { outline.expandItem(node) }
        case .more:
            if let folder = node.parent, let offset = folder.next { load(folder, offset: offset) }
        case .file:
            if mode == .git { loadGit(node.path) } else { onOpen?(node.path,node.line) }
        }
    }
    private func menu(at row: Int) -> NSMenu? {
        let node = outline.item(atRow: row) as? NavigatorNode
        guard node?.kind != .more, node != nil || mode == .files else { return nil }
        let menu = NSMenu(); let path = node?.path ?? ""; let dir = node.map { $0.kind == .folder } ?? true
        menu.addItem(WorkspaceChoice(dir ? "Note on folder…" : "Note on file…") { [weak self] in self?.onNote?(dir ? "folder" : "file",path) })
        if !dir {
            menu.addItem(WorkspaceChoice("Open file") { [weak self] in self?.onOpen?(path,node?.line) })
            menu.addItem(WorkspaceChoice("Show Git diff") { [weak self] in self?.gitScope = path; self?.loadGit(path) })
        }
        return menu
    }
    @objc private func switchQuery() {
        query.placeholderString = kind.selectedSegment == 1 ? "Find literal text in saved files" : "Find files by name"
        search(delay:false)
    }
    func controlTextDidChange(_ obj: Notification) { search(delay:true) }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)), mode == .search {
            if !flat.isEmpty { activate(max(0,outline.selectedRow)) } else { search(delay:false) }
            return true
        }
        if commandSelector == #selector(NSResponder.moveDown(_:)), outline.numberOfRows > 0 {
            canvas.window?.makeFirstResponder(outline)
            if outline.selectedRow < 0 { outline.selectRowIndexes(IndexSet(integer:0),byExtendingSelection:false) }
            return true
        }
        return false
    }
    private func refresh() {
        switch mode { case .diff: loadGit(selectedDiff); case .files: reloadTree(); case .search: search(delay:false); case .git: loadGit(nil) }
    }
}
