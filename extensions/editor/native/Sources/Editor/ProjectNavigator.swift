import AppKit

@MainActor
private final class NavigatorTable: NSTableView {
    var menuAt: ((Int) -> NSMenu?)?
    var activate: (() -> Void)?
    override func menu(for event: NSEvent) -> NSMenu? { menuAt?(row(at: convert(event.locationInWindow, from: nil))) }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 { activate?(); return }
        super.keyDown(with: event)
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
    static let textInset: CGFloat = 28
    static let trailingInset: CGFloat = 4
    override init(frame: NSRect) {
        super.init(frame: frame)
        name.font = .systemFont(ofSize: 12)
        detail.font = .systemFont(ofSize: 11); detail.textColor = .secondaryLabelColor
        name.lineBreakMode = .byTruncatingMiddle; detail.lineBreakMode = .byTruncatingTail
        icon.symbolConfiguration = .init(pointSize: 13, weight: .regular)
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

@MainActor
final class ProjectNavigator: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private enum Mode { case files, search, git, diff }
    private struct Row {
        let path: String
        let title: String
        let icon: String
        var detail = ""
        var folder = false
        var line: Int?
    }
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
    private let table = NavigatorTable()
    private let column = NSTableColumn(identifier: .init("Path"))
    private let diffBox = NSScrollView()
    private let patch = NSTextView()
    private let more = WorkspaceButton("More files…", help: "Load the next directory page")
    private var rows: [Row] = []
    private var mode: Mode = .files
    private var folder = ""
    private var next: Int?
    private var gitScope: String?
    private var selectedDiff: String?
    private var task: Task<Void, Never>?
    private var generation = 0
    var view: NSView { canvas }
    /// The narrowest width that shows every listed name in full. A diff has no such width.
    var fittingWidth: CGFloat? {
        guard mode != .diff, !rows.isEmpty else { return nil }
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12)]
        let widest = rows.prefix(400).reduce(CGFloat(0)) { max($0, ($1.title as NSString).size(withAttributes: attributes).width) }
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
        table.headerView = nil; table.style = .plain; table.usesAlternatingRowBackgroundColors = false
        table.intercellSpacing = NSSize(width: 0,height: 0); table.allowsEmptySelection = true
        table.addTableColumn(column); table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle; column.minWidth = 30
        table.delegate = self; table.dataSource = self; table.target = self; table.action = #selector(clicked)
        table.setAccessibilityLabel("Project results")
        // The region behind the navigator paints one surface for its heading and its list.
        table.backgroundColor = .clear; list.drawsBackground = false
        list.hasVerticalScroller = true; list.autohidesScrollers = true; list.documentView = table
        patch.font = .monospacedSystemFont(ofSize: 12, weight: .regular); patch.isEditable = false; patch.isSelectable = true
        patch.isRichText = false; patch.textContainerInset = .init(width: 8,height: 6)
        patch.isVerticallyResizable = true; patch.isHorizontallyResizable = false; patch.autoresizingMask = [.width]
        patch.textContainer?.widthTracksTextView = true; patch.setAccessibilityLabel("Git diff")
        diffBox.hasVerticalScroller = true; diffBox.autohidesScrollers = true; diffBox.documentView = patch
        for v in [heading, count, back, reload, openFile, query, kind, list, diffBox, more] { canvas.addSubview(v) }
        canvas.arrange = { [weak self] in self?.arrange($0) }
        table.activate = { [weak self] in guard let self else { return }; activate(table.selectedRow) }
        table.menuAt = { [weak self] index in self?.menu(at: index) }
        back.run = { [weak self] in self?.goBack() }; reload.run = { [weak self] in self?.refresh() }
        more.run = { [weak self] in guard let self, let offset = next else { return }; loadFolder(folder, offset: offset) }
        openFile.run = { [weak self] in guard let self, let path = selectedDiff else { return }; onOpen?(path,nil) }
        refreshChrome()
    }

    func start() async throws {
        let g = reset(.files)
        let data = try await api.call("tree", ["path":folder])
        guard g == generation else { return }
        applyTree(data, append: false)
    }
    func stop() { generation += 1; task?.cancel(); task = nil }
    func showFiles() { loadFolder(folder, offset: 0) }
    func showSearch(contents: Bool = false) {
        kind.selectedSegment = contents ? 1 : 0
        switchQuery()
        canvas.window?.makeFirstResponder(query)
        query.selectText(nil)
    }
    func showGit(doc: String? = nil) { gitScope = doc; loadGit(nil) }

    private func reset(_ newMode: Mode, clear: Bool = true) -> Int {
        generation += 1; task?.cancel(); task = nil
        let expanded = mode == .diff
        mode = newMode
        if clear { rows = []; next = nil; table.deselectAll(nil); table.reloadData() }
        refreshChrome()
        if expanded != (mode == .diff) { onExpand?(mode == .diff) }
        return generation
    }
    private func fetch(_ op: String, _ fields: Fields, mode: Mode, clear: Bool = true, delay: Bool = false,
                       apply: @escaping (Fields) -> Void) {
        let g = reset(mode, clear: clear)
        count.stringValue = "Loading…"; more.isEnabled = false
        task = Task { [weak self, api] in
            do {
                if delay { try await Task.sleep(for: .milliseconds(140)) }
                let data = try await api.call(op,fields)
                guard let self, g == generation, !Task.isCancelled else { return }
                self.task = nil; apply(data)
            } catch {
                guard let self, g == generation, !Task.isCancelled else { return }
                self.task = nil; count.stringValue = "Could not load results"; more.isEnabled = true
                onError?(error.localizedDescription)
            }
        }
    }
    private func loadFolder(_ path: String, offset: Int) {
        folder = path
        fetch("tree", ["path":path,"offset":offset],mode:.files,clear:offset == 0) { [weak self] data in
            self?.applyTree(data,append:offset != 0)
        }
    }
    private func applyTree(_ data: Fields, append: Bool) {
        let entries: [Row] = (data["entries"] as? [Fields] ?? []).compactMap { item in
            guard let path = item["path"] as? String, let title = item["name"] as? String, let dir = item["dir"] as? Bool else { return nil }
            return Row(path:path,title:title,icon:dir ? "folder" : "doc.text",folder:dir)
        }
        if append { rows.append(contentsOf:entries) } else { rows = entries }
        rows.sort { a,b in a.folder == b.folder ? a.title.localizedStandardCompare(b.title) == .orderedAscending : a.folder }
        next = data["next"] as? Int
        finish(rows.isEmpty ? "Empty folder" : "\(rows.count) items",data)
    }
    private func search(delay: Bool) {
        let text = query.stringValue
        guard !text.isEmpty else {
            _ = reset(.search); count.stringValue = kind.selectedSegment == 1 ? "Enter text to search saved files" : "Enter part of a file name"; return
        }
        fetch("search", ["kind":kind.selectedSegment == 1 ? "text" : "paths","query":text],mode:.search,delay:delay) { [weak self] data in
            guard let self else { return }
            rows = (data["hits"] as? [Fields] ?? []).compactMap { item in
                guard let path = item["path"] as? String else { return nil }
                let line = item["line"] as? Int
                return Row(path:path,title:line.map { "\(path):\($0)" } ?? path, icon:"doc.text",detail:item["preview"] as? String ?? "", line:line)
            }
            finish(rows.isEmpty ? "No matches" : "\(rows.count) matches",data)
            if !rows.isEmpty { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
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
                heading.stringValue = diff; heading.toolTip = diff
                let label = output.isEmpty ? "No diff available" : "Working tree diff"
                finish([branch,label].filter { !$0.isEmpty }.joined(separator:" · "),data)
            } else {
                rows = (data["files"] as? [Fields] ?? []).compactMap { item in
                    guard let path = item["path"] as? String, let status = item["status"] as? String else { return nil }
                    return Row(path:path,title:path,icon:"doc",detail:status == "??" ? "Untracked" : "Index / worktree: \(status)")
                }
                finish([branch,rows.isEmpty ? "No changed files" : "\(rows.count) changed files"].filter { !$0.isEmpty }.joined(separator:" · "),data)
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
        count.toolTip = count.stringValue
        more.isEnabled = true; table.reloadData(); refreshChrome()
    }
    private func refreshChrome() {
        switch mode {
        case .files: heading.stringValue = folder.isEmpty ? "Project files" : folder
        case .search: heading.stringValue = "Project search"
        case .git: heading.stringValue = "Local Git"
        case .diff: heading.stringValue = selectedDiff ?? "Diff"
        }
        heading.toolTip = heading.stringValue
        back.isHidden = mode != .diff && (mode != .files || folder.isEmpty)
        query.isHidden = mode != .search; kind.isHidden = mode != .search
        diffBox.isHidden = mode != .diff; openFile.isHidden = mode != .diff; list.isHidden = mode == .diff
        more.isHidden = mode != .files || next == nil
        canvas.needsLayout = true
    }
    private func arrange(_ bounds: NSRect) {
        let w = bounds.width, h = bounds.height
        let leading: CGFloat = back.isHidden ? 11 : 37
        let controls: CGFloat = openFile.isHidden ? 36 : 100
        back.frame = NSRect(x:4,y:4,width:28,height:26)
        heading.frame = NSRect(x:leading,y:8,width:max(0,w-leading-controls),height:20)
        reload.frame = NSRect(x:w-31,y:4,width:25,height:26)
        openFile.frame = NSRect(x:w-99,y:4,width:66,height:26)
        var y: CGFloat = 35
        if mode == .search {
            kind.frame = NSRect(x:9,y:y,width:max(0,w-18),height:24); y += 29
            query.frame = NSRect(x:9,y:y,width:max(0,w-18),height:24); y += 30
        }
        count.frame = NSRect(x:11,y:y,width:max(0,w-22),height:18); y += 21
        let bottom: CGFloat = more.isHidden ? 0 : 30
        more.frame = NSRect(x:8,y:h-29,width:max(0,w-16),height:26)
        let area = NSRect(x:0,y:y,width:w,height:max(0,h-y-bottom)); list.frame = area; diffBox.frame = area
        column.width = max(30,list.contentSize.width)
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { rows[row].detail.isEmpty ? 26 : 36 }
    func tableView(_ tableView: NSTableView,viewFor tableColumn: NSTableColumn?,row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        let item = rows[row], identity = NSUserInterfaceItemIdentifier("ProjectRow")
        let cell = tableView.makeView(withIdentifier:identity,owner:self) as? NavigatorCell ?? NavigatorCell(frame:.zero)
        cell.identifier = identity; cell.name.stringValue = item.title; cell.detail.stringValue = item.detail
        cell.icon.image = NSImage(systemSymbolName:item.icon,accessibilityDescription:nil)
        cell.icon.contentTintColor = item.folder ? .controlAccentColor : .secondaryLabelColor
        cell.toolTip = [item.path,item.detail].filter { !$0.isEmpty }.joined(separator:"\n")
        cell.setAccessibilityLabel(cell.toolTip); cell.needsLayout = true
        return cell
    }
    @objc private func clicked() { activate(table.clickedRow) }
    private func activate(_ row: Int) {
        guard rows.indices.contains(row) else { return }
        let item = rows[row]
        if item.folder { loadFolder(item.path,offset:0) }
        else if mode == .git { loadGit(item.path) }
        else { onOpen?(item.path,item.line) }
    }
    private func menu(at row: Int) -> NSMenu? {
        let item = rows.indices.contains(row) ? rows[row] : nil
        guard item != nil || mode == .files else { return nil }
        let menu = NSMenu(); let path = item?.path ?? folder; let dir = item?.folder ?? true
        menu.addItem(WorkspaceChoice(dir ? "Note on folder…" : "Note on file…") { [weak self] in self?.onNote?(dir ? "folder" : "file",path) })
        if !dir {
            menu.addItem(WorkspaceChoice("Open file") { [weak self] in self?.onOpen?(path,item?.line) })
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
            if !rows.isEmpty { activate(max(0,table.selectedRow)) } else { search(delay:false) }
            return true
        }
        if commandSelector == #selector(NSResponder.moveDown(_:)), !rows.isEmpty {
            canvas.window?.makeFirstResponder(table)
            if table.selectedRow < 0 { table.selectRowIndexes(IndexSet(integer:0),byExtendingSelection:false) }
            return true
        }
        return false
    }
    private func goBack() {
        switch mode {
        case .diff: loadGit(nil)
        case .files: loadFolder((folder as NSString).deletingLastPathComponent,offset:0)
        default: break
        }
    }
    private func refresh() {
        switch mode { case .diff: loadGit(selectedDiff); case .files: showFiles(); case .search: search(delay:false); case .git: loadGit(nil) }
    }
}
