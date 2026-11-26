import AppKit

@MainActor
final class NavigatorNode {
    enum Kind { case folder, file, more, section, tab }
    let kind: Kind
    let path: String
    let title: String
    var detail = ""
    var line: Int?
    var tab: WorkspaceTab?
    /// Nil until the first page is read.
    var children: [NavigatorNode]?
    var next: Int?
    var limited = false
    weak var parent: NavigatorNode?
    private lazy var more: NavigatorNode = {
        let node = NavigatorNode(.more, path: path, title: "More files…")
        node.parent = self
        return node
    }()

    init(_ kind: Kind, path: String, title: String) {
        self.kind = kind
        self.path = path
        self.title = title
    }

    var rowCount: Int { (children?.count ?? 0) + (next == nil ? 0 : 1) }
    func row(at index: Int) -> NavigatorNode {
        if let children, index < children.count { return children[index] }
        return more
    }
}

enum NavigatorGitMark: Equatable {
    case added, modified, untracked, deleted

    init?(status: String) {
        if status == "??" { self = .untracked }
        else if status.contains("D") { self = .deleted }
        else if status.contains("A") { self = .added }
        else if status.contains(where: { "MTRCU".contains($0) }) { self = .modified }
        else { return nil }
    }

    var letter: String {
        switch self { case .added: "A"; case .modified: "M"; case .untracked: "?"; case .deleted: "D" }
    }

    var label: String {
        switch self { case .added: "Added"; case .modified: "Modified"; case .untracked: "Untracked"; case .deleted: "Deleted" }
    }

    @MainActor var colour: NSColor {
        switch self {
        case .added: WorkspaceStyle.theme.added
        case .modified: WorkspaceStyle.theme.modified
        case .untracked: WorkspaceStyle.theme.accent
        case .deleted: WorkspaceStyle.theme.deleted
        }
    }
}

@MainActor
final class NavigatorOutline: NSOutlineView {
    var menuAt: ((Int) -> NSMenu?)?
    var handleKey: ((NSEvent) -> Bool)?
    var flat = false
    override func menu(for event: NSEvent) -> NSMenu? { menuAt?(row(at: convert(event.locationInWindow, from: nil))) }
    override func keyDown(with event: NSEvent) {
        if handleKey?(event) == true { return }
        super.keyDown(with: event)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func frameOfCell(atColumn column: Int, row: Int) -> NSRect {
        var frame = super.frameOfCell(atColumn: column, row: row)
        let kind = row >= 0 ? (item(atRow: row) as? NavigatorNode)?.kind : nil
        if flat || kind == .section || kind == .tab {
            frame.size.width += frame.minX
            frame.origin.x = 0
        }
        return frame
    }
}

@MainActor
final class NavigatorCanvas: NSView {
    var arrange: ((NSRect) -> Void)?
    override var isFlipped: Bool { true }
    override func layout() { super.layout(); arrange?(bounds) }
    override func draw(_ dirtyRect: NSRect) { WorkspaceStyle.chrome.setFill(); dirtyRect.intersection(bounds).fill() }
}

@MainActor
final class NavigatorRow: NSTableRowView {
    var isTab = false
    var isCurrentTab = false { didSet { if isCurrentTab != oldValue { needsDisplay = true } } }
    var isFolder = false

    override func drawBackground(in dirtyRect: NSRect) {
        if isCurrentTab { drawChoice(WorkspaceStyle.theme.chosen) }
    }

    override func drawSelection(in dirtyRect: NSRect) {
        if !isCurrentTab { drawChoice(isTab ? WorkspaceStyle.theme.inactiveSelection : WorkspaceStyle.theme.chosen) }
    }

    override func drawDraggingDestinationFeedback(in dirtyRect: NSRect) {
        guard isFolder else { return }
        WorkspaceStyle.landing.setFill()
        let target = NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 1), xRadius: 5, yRadius: 5)
        target.fill()
        WorkspaceStyle.landingEdge.setStroke()
        target.stroke()
    }

    private func drawChoice(_ colour: NSColor) {
        colour.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 1), xRadius: 5, yRadius: 5).fill()
    }
}

@MainActor
final class NavigatorCell: NSTableCellView {
    static let textInset: CGFloat = 31
    static let trailingInset: CGFloat = 10
    static let accessoryWidth: CGFloat = 22
    let name = NSTextField(labelWithString: "")
    let detail = NSTextField(labelWithString: "")
    let badge = NSTextField(labelWithString: "")
    let icon = NSImageView()
    // A close control always has its own hit area, including when it shows the unsaved mark.
    let close = WorkspaceButton("", symbol: "xmark")
    var section = false
    var reservesBadge = false
    var editor: NSTextField? {
        didSet {
            oldValue?.removeFromSuperview()
            if let editor { addSubview(editor) }
            name.isHidden = editor != nil
            needsLayout = true
        }
    }
    private var unsaved = false
    private var hovering = false
    private var pointerArea: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        name.lineBreakMode = .byTruncatingMiddle; detail.lineBreakMode = .byTruncatingTail
        name.allowsExpansionToolTips = true; detail.allowsExpansionToolTips = true
        badge.alignment = .center
        icon.symbolConfiguration = .init(pointSize: 13, weight: .regular)
        for view in [icon, name, detail, badge, close] { addSubview(view) }
    }
    required init?(coder: NSCoder) { nil }

    func setClose(title: String?, unsaved: Bool, run: (() -> Void)?) {
        close.isHidden = title == nil
        close.run = run
        if let title { close.setAccessibilityLabel("Close \(title)") }
        self.unsaved = unsaved
        updateClose()
    }

    override func layout() {
        super.layout()
        let h = bounds.height, w = bounds.width
        let left = section ? Self.trailingInset : Self.textInset
        let right = Self.trailingInset + (reservesBadge || !close.isHidden ? Self.accessoryWidth : 0)
        let textHeight = ceil(name.font?.boundingRectForFont.height ?? 18) + 2
        let detailHeight = ceil(detail.font?.boundingRectForFont.height ?? 14) + 1
        let multi = !detail.stringValue.isEmpty
        let y = multi ? (h + detailHeight - textHeight) / 2 : (h - textHeight) / 2
        let textWidth = max(0, w - left - right)
        icon.frame = NSRect(x: 8, y: (h - 17) / 2, width: 17, height: 17)
        name.frame = NSRect(x: left, y: y, width: textWidth, height: textHeight)
        editor?.frame = NSRect(x: left - 3, y: y, width: textWidth + 3, height: textHeight)
        detail.frame = NSRect(x: left, y: y - detailHeight, width: textWidth, height: multi ? detailHeight : 0)
        let accessory = NSRect(x: max(0, w - Self.trailingInset - Self.accessoryWidth), y: (h - 20) / 2, width: Self.accessoryWidth, height: 20)
        badge.frame = accessory.insetBy(dx: 0, dy: 3)
        close.frame = accessory
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea); self.pointerArea = nil }
        guard !close.isHidden else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        pointerArea = area
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; updateClose() }
    override func mouseExited(with event: NSEvent) { hovering = false; updateClose() }
    override func viewDidHide() { super.viewDidHide(); hovering = false; updateClose() }

    private func updateClose() {
        guard !close.isHidden else { return }
        let mark = unsaved && !hovering
        close.image = NSImage(systemSymbolName: mark ? "circle.fill" : "xmark", accessibilityDescription: nil)
        close.symbolConfiguration = .init(pointSize: mark ? 6 : 8, weight: .semibold)
        close.contentTintColor = mark ? WorkspaceStyle.theme.modified : WorkspaceStyle.theme.mutedText
    }
}
