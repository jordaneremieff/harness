import AppKit

struct QuickItem: Sendable {
    let id: String
    let title: String
    let search: FuzzyLabel
    let detail: String
    let icon: String
    let enabled: Bool
    let checked: Bool
    let priority: Int

    init(_ id: String, title: String, detail: String = "", icon: String = "", enabled: Bool = true,
         checked: Bool = false, priority: Int = 0, search: FuzzyLabel? = nil) {
        self.id = id; self.title = title; self.search = search ?? FuzzyLabel(title)
        self.detail = detail; self.icon = icon; self.enabled = enabled; self.checked = checked; self.priority = priority
    }

    struct Hit: Sendable {
        let item: QuickItem
        let match: FuzzyMatch
    }

    static func filter(_ items: [Self], query text: String) -> [Hit] {
        let query = FuzzyQuery(text)
        func rank(_ hit: Hit) -> Int {
            hit.match.score + (query.isEmpty ? hit.item.priority : min(18, hit.item.priority / 16))
        }
        return items.compactMap { item -> Hit? in
            guard !Task.isCancelled, let match = query.match(item.search) else { return nil }
            return Hit(item: item, match: match)
        }.sorted { a, b in
            let lhs = rank(a), rhs = rank(b)
            if lhs != rhs { return lhs > rhs }
            if a.item.priority != b.item.priority { return a.item.priority > b.item.priority }
            let order = a.item.title.localizedStandardCompare(b.item.title)
            return order == .orderedSame ? a.item.id < b.item.id : order == .orderedAscending
        }
    }
}

@MainActor
class QuickSurface: NSView {
    override var isFlipped: Bool { true }
    var onDetach: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 11
        layer?.borderWidth = 1
        let shadow = NSShadow()
        shadow.shadowOffset = NSSize(width: 0, height: -6)
        shadow.shadowBlurRadius = 18
        self.shadow = shadow
        NotificationCenter.default.addObserver(self, selector: #selector(applyPanelStyle), name: .workspaceStyleDidChange, object: nil)
        applyPanelStyle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc func applyPanelStyle() {
        let theme = WorkspaceStyle.theme
        layer?.backgroundColor = theme.panel.cgColor
        layer?.borderColor = theme.panelBorder.cgColor
        shadow?.shadowColor = theme.panelShadow
        needsDisplay = true
    }

    override func viewWillMove(toSuperview next: NSView?) {
        if next == nil, superview != nil { onDetach?() }
        super.viewWillMove(toSuperview: next)
    }

    func focus(_ field: NSTextField) {
        guard let window, window.isKeyWindow else { return }
        window.makeFirstResponder(field)
    }

    static func label(_ value: String) -> NSTextField {
        let label = NSTextField(labelWithString: value)
        label.lineBreakMode = .byTruncatingTail
        return label
    }
}

@MainActor
final class QuickPanel: QuickSurface, NSTableViewDelegate, NSTableViewDataSource, NSTextFieldDelegate {
    let field = NSTextField()
    private let fieldBacking = NSView()
    private let heading: NSTextField
    private let status = QuickSurface.label("")
    private let footer = QuickSurface.label("↑ ↓  Move    return  Open    esc  Close")
    private let scroll = NSScrollView()
    private let table = QuickTable()
    private let column = NSTableColumn(identifier: .init("result"))
    private var rows: [QuickItem.Hit] = []
    private var ready = true
    private var updatingRows = false
    private var hoverRow = -1
    var onInput: ((String) -> Void)?
    var onMove: ((QuickItem?) -> Void)?
    var selectsHoveredRows = false
    var onAccept: ((QuickItem?) -> Void)?
    var onClick: ((QuickItem) -> Void)?
    var onCancel: (() -> Void)?
    var onTab: (() -> Bool)?

    init(title: String, placeholder: String, assistance: String? = nil,
         keyboardHelp: String = "↑ ↓  Move    return  Open    esc  Close") {
        heading = QuickSurface.label(title)
        super.init(frame: .zero)
        footer.stringValue = keyboardHelp
        status.alignment = .right
        field.placeholderString = placeholder
        field.setAccessibilityLabel(title)
        field.toolTip = assistance
        field.delegate = self
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        (field.cell as? NSTextFieldCell)?.sendsActionOnEndEditing = false
        fieldBacking.wantsLayer = true
        fieldBacking.layer?.cornerRadius = 6
        fieldBacking.layer?.borderWidth = 1
        fieldBacking.addSubview(field)
        table.style = .plain
        table.headerView = nil
        table.intercellSpacing = .zero
        table.rowHeight = 31
        table.selectionHighlightStyle = .regular
        table.backgroundColor = .clear
        column.minWidth = 0
        table.addTableColumn(column)
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.delegate = self
        table.dataSource = self
        table.target = self
        table.action = #selector(clickRow)
        table.hovered = { [weak self] row in self?.hover(row) }
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = table
        [heading, fieldBacking, scroll, footer, status].forEach { addSubview($0) }
        applyPanelStyle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var item: QuickItem? {
        rows.indices.contains(table.selectedRow) ? rows[table.selectedRow].item : nil
    }

    var text: String { field.currentEditor()?.string ?? field.stringValue }

    func start(_ input: String = "") {
        field.stringValue = input
        focus(field)
        if !input.isEmpty { field.currentEditor()?.selectedRange = NSRange(location: input.utf16.count, length: 0) }
        onInput?(input)
    }

    func replaceInput(_ input: String) {
        if let editor = field.currentEditor() {
            editor.string = input
            editor.selectedRange = NSRange(location: input.utf16.count, length: 0)
        } else { field.stringValue = input }
        onInput?(input)
    }

    func busy(_ message: String = "Searching…") {
        ready = false
        status.stringValue = message
    }

    func show(_ hits: [QuickItem.Hit], status message: String? = nil, keepSelection: Bool = false, autoSelect: Bool = true) {
        let oldID = keepSelection ? item?.id : nil
        ready = true
        updatingRows = true
        hoverRow = -1
        rows = hits
        table.reloadData()
        if let index = oldID.flatMap({ id in rows.firstIndex { $0.item.id == id } }) ?? (autoSelect ? rows.firstIndex { $0.item.enabled } : nil) {
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
            table.scrollRowToVisible(index)
        } else { table.deselectAll(nil) }
        status.stringValue = message ?? (rows.isEmpty ? "No matches" : "\(rows.count.formatted()) results")
        status.toolTip = status.stringValue
        updatingRows = false
        onMove?(item)
    }

    override func layout() {
        super.layout()
        let w = bounds.width, h = bounds.height
        heading.frame = NSRect(x: 17, y: 11, width: max(0, w - 34), height: 20)
        fieldBacking.frame = NSRect(x: 14, y: 35, width: max(0, w - 28), height: 33)
        let fieldHeight = min(31, max(18, field.intrinsicContentSize.height))
        field.frame = NSRect(x: 9, y: ((33 - fieldHeight) / 2).rounded(), width: max(0, w - 46), height: fieldHeight)
        scroll.frame = NSRect(x: 8, y: 76, width: max(0, w - 16), height: max(0, h - 106))
        column.width = scroll.contentSize.width
        let left = min(max(0, w - 34), footer.intrinsicContentSize.width + 8)
        footer.frame = NSRect(x: 17, y: max(0, h - 24), width: left, height: 17)
        status.frame = NSRect(x: 17 + left, y: max(0, h - 24), width: max(0, w - 34 - left), height: 17)
    }

    override func applyPanelStyle() {
        super.applyPanelStyle()
        let theme = WorkspaceStyle.theme
        heading.font = WorkspaceStyle.interfaceFont(-1, weight: .semibold)
        heading.textColor = theme.secondaryText
        field.font = WorkspaceStyle.interfaceFont(3)
        fieldBacking.layer?.backgroundColor = theme.editor.cgColor
        field.textColor = theme.text
        paintFieldEditor()
        [footer, status].forEach { label in
            label.font = WorkspaceStyle.interfaceFont(-2)
            label.textColor = theme.mutedText
        }
        table.enumerateAvailableRowViews { view, _ in
            view.needsDisplay = true
            view.subviews.forEach { $0.needsDisplay = true }
        }
        needsLayout = true
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let id = NSUserInterfaceItemIdentifier("background")
        let view = tableView.makeView(withIdentifier: id, owner: self) as? QuickBackground ?? QuickBackground()
        view.identifier = id
        view.hovered = hoverRow == row
        return view
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("item")
        let cell = tableView.makeView(withIdentifier: id, owner: self) as? QuickCell ?? QuickCell()
        cell.identifier = id
        cell.hit = rows[row]
        return cell
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { rows[row].item.enabled }

    func tableViewSelectionDidChange(_ notification: Notification) {
        if !updatingRows, ready { onMove?(item) }
    }

    private func hover(_ row: Int) {
        guard hoverRow != row else { return }
        let old = hoverRow
        hoverRow = row
        for index in [old, row] where rows.indices.contains(index) {
            (table.rowView(atRow: index, makeIfNecessary: false) as? QuickBackground)?.hovered = index == row
        }
        if selectsHoveredRows, ready, rows.indices.contains(row), rows[row].item.enabled {
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        }
    }

    @objc private func clickRow() {
        guard ready, table.clickedRow == table.selectedRow, let item, item.enabled else { return }
        if let onClick { onClick(item); focus(field) }
        else { onAccept?(item) }
    }

    func controlTextDidBeginEditing(_ notification: Notification) { paintFieldEditor() }
    func controlTextDidEndEditing(_ notification: Notification) { paintFieldEditor() }

    private func paintFieldEditor() {
        let theme = WorkspaceStyle.theme
        let editor = field.currentEditor() as? NSTextView
        fieldBacking.layer?.borderColor = (editor == nil ? theme.panelBorder : theme.accent.withAlphaComponent(0.55)).cgColor
        editor?.textColor = theme.text
        editor?.insertionPointColor = theme.caret
        editor?.selectedTextAttributes = [.backgroundColor: theme.selection, .foregroundColor: theme.text]
    }

    func controlTextDidChange(_ notification: Notification) {
        if let editor = field.currentEditor() as? NSTextView, editor.hasMarkedText() { return }
        onInput?(text)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if textView.hasMarkedText() { return false }
        switch selector {
        case #selector(NSResponder.moveUp(_:)): move(-1)
        case #selector(NSResponder.moveDown(_:)): move(1)
        case #selector(NSResponder.pageUp(_:)), #selector(NSResponder.scrollPageUp(_:)): move(-max(1, Int(scroll.bounds.height / table.rowHeight) - 1))
        case #selector(NSResponder.pageDown(_:)), #selector(NSResponder.scrollPageDown(_:)): move(max(1, Int(scroll.bounds.height / table.rowHeight) - 1))
        case #selector(NSResponder.insertNewline(_:)): if ready { onAccept?(item) }
        case #selector(NSResponder.cancelOperation(_:)): onCancel?()
        case #selector(NSResponder.insertTab(_:)): return onTab?() ?? false
        default: return false
        }
        return true
    }

    private func move(_ delta: Int) {
        guard ready, !rows.isEmpty else { return }
        let current = table.selectedRow
        let direction = delta > 0 ? 1 : -1
        var index = current < 0 ? (delta > 0 ? 0 : rows.count - 1) : min(rows.count - 1, max(0, current + delta))
        while rows.indices.contains(index), !rows[index].item.enabled { index += direction }
        guard rows.indices.contains(index) else { return }
        table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        table.scrollRowToVisible(index)
    }
}

@MainActor
private final class QuickTable: NSTableView {
    var hovered: ((Int) -> Void)?
    private var tracking: NSTrackingArea?
    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let next = NSTrackingArea(rect: .zero, options: [.activeInKeyWindow, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect], owner: self)
        addTrackingArea(next); tracking = next
        super.updateTrackingAreas()
    }
    override func mouseMoved(with event: NSEvent) { hovered?(row(at: convert(event.locationInWindow, from: nil))) }
    override func mouseExited(with event: NSEvent) { hovered?(-1) }
}

@MainActor
private final class QuickBackground: NSTableRowView {
    var hovered = false { didSet { if hovered != oldValue { needsDisplay = true } } }
    override func drawBackground(in dirtyRect: NSRect) {
        if hovered && !isSelected {
            WorkspaceStyle.theme.hover.setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6).fill()
        }
    }
    override func drawSelection(in dirtyRect: NSRect) {
        WorkspaceStyle.theme.chosen.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6).fill()
    }
}

@MainActor
private final class QuickCell: NSView {
    var hit: QuickItem.Hit? { didSet { needsDisplay = true } }
    override func accessibilityLabel() -> String? { hit.map { "\($0.item.title) \($0.item.detail)" } }

    override func draw(_ dirtyRect: NSRect) {
        guard let hit else { return }
        let item = hit.item
        let theme = WorkspaceStyle.theme
        let colour = item.enabled ? theme.text : theme.mutedText
        let font = WorkspaceStyle.interfaceFont()
        let detailFont = WorkspaceStyle.interfaceFont(-1)
        let details = NSAttributedString(string: item.detail, attributes: [.font: detailFont, .foregroundColor: theme.mutedText])
        let detailWidth = min(max(0, bounds.width * 0.27), ceil(details.size().width))
        let glyph = item.checked ? "checkmark" : item.icon
        if !glyph.isEmpty, let image = NSImage(systemSymbolName: glyph, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium).applying(.init(paletteColors: [item.enabled ? theme.accent : theme.mutedText]))) {
            image.draw(in: NSRect(x: 10, y: (bounds.height - 14) / 2, width: 14, height: 14))
        }
        let para = NSMutableParagraphStyle(); para.lineBreakMode = .byTruncatingTail
        let text = NSMutableAttributedString(string: item.title, attributes: [.font: font, .foregroundColor: colour, .paragraphStyle: para])
        if item.enabled {
            for range in hit.match.ranges where NSMaxRange(range) <= text.length { text.addAttribute(.foregroundColor, value: theme.matchText, range: range) }
        }
        let gap: CGFloat = detailWidth > 0 ? 13 : 0
        let titleX: CGFloat = 35
        text.draw(with: NSRect(x: titleX, y: (bounds.height - text.size().height) / 2, width: max(0, bounds.width - titleX - 12 - detailWidth - gap), height: bounds.height), options: [.truncatesLastVisibleLine])
        if detailWidth > 0 {
            details.draw(with: NSRect(x: bounds.width - detailWidth - 12, y: (bounds.height - details.size().height) / 2, width: detailWidth, height: bounds.height), options: [.truncatesLastVisibleLine])
        }
    }
}
