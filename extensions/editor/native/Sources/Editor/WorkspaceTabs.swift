import AppKit

struct WorkspaceTab: Equatable {
    let key: String
    let label: String
    let detail: String
    var symbol: String
    var unsaved = false
    var warns = false
}

/// One set of tabs with the page of its selected tab. A stage shows one or two of them.
struct WorkspaceGroup {
    let id: Int
    var tabs: [WorkspaceTab]
    var selected: String?
    var page: NSView?
}

/// Where a dragged tab lands.
enum WorkspaceDrop: Equatable {
    /// A place among the other tabs of a group.
    case slot(group: Int, index: Int)
    /// A new group on one side of an existing one.
    case beside(group: Int, trailing: Bool)
}

/// One tab. The pointer selects it on a press, drags it after a short distance and closes it
/// with its close control or the middle button.
@MainActor
final class WorkspaceTabView: NSButton {
    static let minimumWidth: CGFloat = 76
    static let maximumWidth: CGFloat = 220
    /// The least width of a tab in a crowded strip, where a shorter name would not read.
    static let crowdedWidth: CGFloat = 120
    private static let dragDistance: CGFloat = 4

    private(set) var item: WorkspaceTab
    var isChosen = false { didSet { if isChosen != oldValue { refresh() } } }
    var inActiveGroup = true { didSet { if inActiveGroup != oldValue { refresh() } } }
    var onPress: (() -> Void)?
    var onClose: (() -> Void)?
    var onMenu: (() -> NSMenu)?
    /// Receives the window location of the press that started a drag. Returns false when a
    /// drag cannot start now.
    var onDragStart: ((NSPoint) -> Bool)?
    var onDragMove: ((NSEvent) -> Void)?
    var onDragEnd: ((NSEvent) -> Void)?

    private let icon = NSImageView()
    private let name = NSTextField(labelWithString: "")
    private let closer = WorkspaceButton("", symbol: "xmark")
    private var hovering = false { didSet { if hovering != oldValue { refresh() } } }
    private var pressedAt: NSPoint?
    private var dragging = false
    private var pointerArea: NSTrackingArea?

    init(item: WorkspaceTab) {
        self.item = item
        super.init(frame: .zero)
        title = ""
        isBordered = false
        setButtonType(.momentaryChange)
        focusRingType = .none
        target = self
        action = #selector(press)
        name.font = .systemFont(ofSize: 12)
        name.lineBreakMode = .byTruncatingMiddle
        icon.symbolConfiguration = .init(pointSize: 11, weight: .regular)
        closer.run = { [weak self] in self?.onClose?() }
        for view in [icon, name, closer] { addSubview(view) }
        show(item)
    }
    required init?(coder: NSCoder) { nil }

    func show(_ next: WorkspaceTab) {
        item = next
        name.stringValue = next.label
        toolTip = next.detail
        setAccessibilityLabel(next.detail)
        closer.setAccessibilityLabel("Close \(next.label)")
        icon.image = NSImage(systemSymbolName: next.symbol, accessibilityDescription: nil)
        refresh()
    }

    var fittingWidth: CGFloat {
        min(Self.maximumWidth, max(Self.minimumWidth, ceil(name.intrinsicContentSize.width) + 64))
    }

    private func refresh() {
        let strong = isChosen && inActiveGroup || hovering
        name.textColor = strong ? .labelColor : .secondaryLabelColor
        icon.contentTintColor = item.warns ? .systemOrange : .secondaryLabelColor
        // An unsaved tab shows its mark where the close control sits; the pointer brings the control back.
        let mark = item.unsaved && !hovering
        closer.image = NSImage(systemSymbolName: mark ? "circle.fill" : "xmark", accessibilityDescription: nil)
        closer.symbolConfiguration = .init(pointSize: mark ? 6.5 : 8.5, weight: mark ? .regular : .semibold)
        closer.isHidden = !(mark || hovering || isChosen)
        setAccessibilityValue(isChosen ? "Selected" : "")
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        let h = bounds.height
        icon.frame = NSRect(x: 9, y: (h - 14) / 2, width: 14, height: 14)
        closer.frame = NSRect(x: bounds.width - 23, y: (h - 16) / 2, width: 16, height: 16)
        name.frame = NSRect(x: 28, y: (h - 16) / 2, width: max(0, bounds.width - 28 - 24), height: 16)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard isChosen || hovering else { return }
        (isChosen ? WorkspaceStyle.content : WorkspaceStyle.hover).setFill()
        // Only the top corners are round: the chosen tab runs into the page below it.
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: bounds).addClip()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height + 6), xRadius: 6, yRadius: 6).fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        return hit === closer ? hit : self
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        pointerArea = area
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    @objc private func press() { onPress?() }

    override func mouseDown(with event: NSEvent) {
        pressedAt = event.locationInWindow
        dragging = false
        onPress?()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let pressedAt else { return }
        if !dragging {
            let now = event.locationInWindow
            guard hypot(now.x - pressedAt.x, now.y - pressedAt.y) >= Self.dragDistance else { return }
            guard onDragStart?(pressedAt) == true else { self.pressedAt = nil; return }
            dragging = true
        }
        onDragMove?(event)
    }

    override func mouseUp(with event: NSEvent) {
        if dragging { onDragEnd?(event) }
        pressedAt = nil
        dragging = false
    }

    override func otherMouseDown(with event: NSEvent) {
        if event.buttonNumber == 2 { onClose?() } else { super.otherMouseDown(with: event) }
    }

    override func menu(for event: NSEvent) -> NSMenu? { onMenu?() }
}

/// The row of tabs above a page.
@MainActor
final class WorkspaceTabStrip: NSView {
    static let height: CGFloat = 34
    private static let tabTop: CGFloat = 4

    private final class Row: NSView {
        var onBlankDoubleClick: (() -> Void)?
        override var isFlipped: Bool { true }
        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 { onBlankDoubleClick?() } else { super.mouseDown(with: event) }
        }
    }

    private let scroll = NSScrollView()
    private let row = Row()
    private(set) var tabs: [WorkspaceTabView] = []
    private var resting: [CGFloat] = []
    /// The key of a tab that follows the pointer and takes no place in the row.
    private(set) var lifted: String?
    /// Room kept open among the resting tabs for a tab that would land there.
    private(set) var opening: (index: Int, width: CGFloat)?
    var onBlankDoubleClick: (() -> Void)? {
        get { row.onBlankDoubleClick }
        set { row.onBlankDoubleClick = newValue }
    }
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.hasVerticalScroller = false
        scroll.horizontalScrollElasticity = .allowed
        scroll.verticalScrollElasticity = .none
        scroll.documentView = row
        addSubview(scroll)
        setAccessibilityRole(.tabGroup)
    }
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        WorkspaceStyle.chrome.setFill()
        bounds.fill()
        WorkspaceStyle.line.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill(using: .sourceOver)
    }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        arrange()
    }

    /// Replaces the tabs. Views are kept by key, so a tab under the pointer stays the same view.
    func show(_ views: [WorkspaceTabView]) {
        for old in tabs where !views.contains(where: { $0 === old }) && old.superview === row { old.removeFromSuperview() }
        for view in views where view.superview !== row { row.addSubview(view) }
        tabs = views
        arrange()
    }

    /// Takes one tab out of the row and keeps room open for a tab that would land at an index.
    func hold(lifted key: String?, opening next: (index: Int, width: CGFloat)?, animated: Bool) {
        guard key != lifted || next?.index != opening?.index || next?.width != opening?.width else { return }
        lifted = key
        opening = next
        arrange(animated: animated)
    }

    /// Scrolls a crowded row by a distance and reports whether it moved.
    func scroll(by distance: CGFloat) -> Bool {
        let clip = scroll.contentView
        let limit = max(0, row.frame.width - clip.bounds.width)
        let x = min(max(0, clip.bounds.minX + distance), limit)
        guard x != clip.bounds.minX else { return false }
        clip.scroll(to: NSPoint(x: x, y: 0))
        scroll.reflectScrolledClipView(clip)
        return true
    }

    /// The place for a dragged tab whose leading edge is at `x` in this strip's coordinates.
    func slot(leading x: CGFloat) -> Int {
        WorkspaceLayout.slot(leading: x + scroll.contentView.bounds.minX, widths: resting)
    }

    /// The frame in this strip's coordinates that a tab at `index` among the resting tabs takes.
    func landing(at index: Int, width: CGFloat) -> NSRect {
        let start = resting.prefix(index).reduce(0, +) - scroll.contentView.bounds.minX
        return NSRect(x: start, y: Self.tabTop, width: width, height: Self.height - Self.tabTop)
    }

    func reveal(_ key: String) {
        guard let tab = tabs.first(where: { $0.item.key == key }) else { return }
        layoutSubtreeIfNeeded()
        tab.scrollToVisible(tab.bounds)
    }

    private func arrange(animated: Bool = false) {
        let placed = tabs.filter { $0.item.key != lifted }
        let room = max(0, bounds.width - (opening?.width ?? 0))
        // Tabs share a crowded strip evenly while their names still read. After that the row scrolls.
        let share = placed.isEmpty ? 0 : max(WorkspaceTabView.crowdedWidth, (room / CGFloat(placed.count)).rounded(.down))
        resting = placed.map { min($0.fittingWidth, share) }
        var x: CGFloat = 0
        var frames: [NSRect] = []
        for (index, width) in resting.enumerated() {
            if opening?.index == index { x += opening?.width ?? 0 }
            frames.append(NSRect(x: x, y: Self.tabTop, width: width, height: Self.height - Self.tabTop))
            x += width
        }
        if let opening, opening.index >= placed.count { x += opening.width }
        row.frame = NSRect(x: 0, y: 0, width: max(x, bounds.width), height: Self.height)
        let move = { for (tab, frame) in zip(placed, frames) where tab.frame != frame { (animated ? tab.animator() : tab).frame = frame } }
        if animated, window != nil {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.14
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                context.allowsImplicitAnimation = true
                move()
            }
        } else { move() }
    }
}

/// A tab strip above the page of its selected tab.
@MainActor
final class WorkspaceGroupView: NSView {
    let id: Int
    let strip = WorkspaceTabStrip()
    let pageHost = WorkspaceRegion(WorkspaceStyle.content)
    var onActivate: (() -> Void)?
    private var page: NSView?
    override var isFlipped: Bool { true }

    init(id: Int) {
        self.id = id
        super.init(frame: .zero)
        addSubview(pageHost)
        addSubview(strip)
    }
    required init?(coder: NSCoder) { nil }

    func show(page next: NSView?) {
        guard page !== next else { return }
        if page?.superview === pageHost { page?.removeFromSuperview() }
        page = next
        if let next { pageHost.addSubview(next) }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let top = strip.isHidden ? 0 : WorkspaceTabStrip.height
        strip.frame = NSRect(x: 0, y: 0, width: bounds.width, height: WorkspaceTabStrip.height)
        pageHost.frame = NSRect(x: 0, y: top, width: bounds.width, height: max(0, bounds.height - top))
        page?.frame = pageHost.bounds
    }

    /// A press anywhere in the group makes it the one that commands apply to.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        if hit != nil, let type = NSApplication.shared.currentEvent?.type, type == .leftMouseDown || type == .rightMouseDown { onActivate?() }
        return hit
    }
}
