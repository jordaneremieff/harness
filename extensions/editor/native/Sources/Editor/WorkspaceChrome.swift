import AppKit

/// A layer above the workspace for what follows the pointer. It takes no pointer events.
@MainActor
private final class WorkspaceOverlay: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Marks the part of a page where a dragged tab will land.
@MainActor
private final class WorkspaceDropMark: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7)
        WorkspaceStyle.landing.setFill()
        shape.fill()
        WorkspaceStyle.landingEdge.setStroke()
        shape.lineWidth = 1.5
        shape.stroke()
    }
}

/// The frame of the workspace: the toolbar, the sidebar, one or two tab groups and the status
/// line. It owns the geometry a person arranges with the pointer; the content of each part
/// comes from its owner.
@MainActor
final class WorkspaceChrome: NSView {
    var onCommand: ((String) -> Void)?
    /// Receives the name of the sidebar panel whose button was pressed.
    var onSidebar: ((String) -> Void)?
    var onSelect: ((String) -> Void)?
    var onClose: ((String) -> Void)?
    var onMove: ((String, WorkspaceDrop) -> Void)?
    var onActivate: ((Int) -> Void)?
    var onTabMenu: ((String) -> NSMenu)?
    var onMenu: (() -> NSMenu)?
    var onNote: ((String, String) -> Void)?
    var onPath: ((String) -> Void)?
    var onCancelPath: (() -> Void)?
    /// Returns the sidebar width that shows its content in full, when the content has one.
    var onFitSidebar: (() -> CGFloat?)?

    private static let sidebarKey = "sidebarWidth"
    private static let toolHeight: CGFloat = 38
    private static let footHeight: CGFloat = 24
    private let defaults: UserDefaults
    private let bar = WorkspaceRegion(.bar, line: .bottom)
    private let side = WorkspaceRegion()
    private let stage = WorkspaceRegion(.content)
    private let banner = WorkspaceRegion(line: .bottom)
    private let pathRow = WorkspaceRegion(line: .bottom)
    private let foot = WorkspaceRegion(.bar, line: .top)
    private let overlay = WorkspaceOverlay()
    private let dropMark = WorkspaceDropMark()
    private let sidebarEdge = WorkspaceDivider(label: "Sidebar width")
    private let groupEdge = WorkspaceDivider(label: "Tab group width")
    private let folder: NSTextField
    private let status = NSTextField(labelWithString: "")
    private let details = NSTextField(labelWithString: "")
    private let wrap = WorkspaceButton("", symbol: "text.word.spacing", help: "Wrap lines")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let panels: [(name: String, button: WorkspaceButton)] = [
        ("files", WorkspaceButton("", symbol: "folder", help: "Project files (cmd+O)")),
        ("search", WorkspaceButton("", symbol: "magnifyingglass", help: "Project search (cmd+P)")),
        ("git", WorkspaceButton("", symbol: "arrow.triangle.branch", help: "Local Git")),
        ("notes", WorkspaceButton("", symbol: "bubble.left.and.bubble.right", help: "Conversations (cmd+option+T)")),
    ]
    private let add = WorkspaceButton("", symbol: "plus", help: "New scratch (cmd+N)")
    private let save = WorkspaceButton("", symbol: "square.and.arrow.down", help: "Save file (cmd+S)")
    private let more = WorkspaceButton("", symbol: "ellipsis.circle", help: "Workspace actions")
    private let hideMessage = WorkspaceButton("", symbol: "xmark", help: "Dismiss message")
    private let messageAction = WorkspaceButton("")
    private let pathField = NSTextField()
    private let pathSubmit = WorkspaceButton("")
    private let pathCancel = WorkspaceButton("", symbol: "xmark", help: "Cancel path entry")

    /// The width a person gave the sidebar. The layout limits it while the pane is narrow.
    private var chosenSidebar: CGFloat?
    /// The part of the stage that the first of two groups takes.
    private var share: CGFloat = 0.5
    private var groups: [WorkspaceGroup] = []
    private var groupViews: [WorkspaceGroupView] = []
    private var tabViews: [String: WorkspaceTabView] = [:]
    private var activeGroup = 0
    private var accessory: NSView?
    private var showPath = false
    /// The part of a requested path that Editor supplied, which the person has not typed.
    private var pathStart = ""
    private var showMessage = false
    private var statusText = ""
    private var notice: Task<Void, Never>?

    private struct TabDrag {
        let key: String
        let origin: Int
        let home: Int
        let grab: CGPoint
        let ghost: WorkspaceTabView
        var target: WorkspaceDrop?
        var point: CGPoint
    }
    private var drag: TabDrag?
    private var styleObserver: NSObjectProtocol?
    private var escape: Any?
    private var settle: (() -> Void)?
    private var creep: Task<Void, Never>?

    var expandedPanel = false { didSet { if expandedPanel != oldValue { needsLayout = true } } }
    var showsSideBySide: Bool { WorkspaceLayout.fitsBeside(pane: bounds.width) && !expandedPanel }
    var sidebarWidth: CGFloat { side.isHidden ? 0 : sidebarEdge.isHidden ? side.frame.width : sidebarEdge.position }
    /// A stage with room for a second tab group. A wide sidebar yields to the second group
    /// down to its own limit, so the room is the one the stage would then have.
    var fitsSecondGroup: Bool {
        guard groups.count == 1, !stage.isHidden else { return false }
        let beside = accessory != nil && showsSideBySide
        let sidebar = beside ? WorkspaceLayout.sidebar(chosen: chosenSidebar, pane: bounds.width, groups: 2) + 1 + WorkspaceDivider.reachAfter : 0
        return WorkspaceLayout.fitsTwoGroups(stage: bounds.width - sidebar)
    }
    /// The person typed a path that has not been submitted.
    var hasPathText: Bool { showPath && !pathField.stringValue.isEmpty && pathField.stringValue != pathStart }
    override var isFlipped: Bool { true }

    init(root: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        folder = NSTextField(labelWithString: URL(fileURLWithPath: root).lastPathComponent)
        super.init(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        if let stored = defaults.object(forKey: Self.sidebarKey) as? Double, stored.isFinite, (1...10_000).contains(stored) {
            chosenSidebar = CGFloat(stored)
        }
        folder.font = .systemFont(ofSize: 13, weight: .semibold)
        folder.lineBreakMode = .byTruncatingMiddle
        folder.toolTip = root
        folder.setAccessibilityLabel("Project folder")
        status.font = .systemFont(ofSize: 11)
        status.lineBreakMode = .byTruncatingMiddle
        details.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        details.textColor = .secondaryLabelColor
        message.font = .systemFont(ofSize: 12)
        message.maximumNumberOfLines = 3
        message.lineBreakMode = .byTruncatingTail
        pathField.placeholderString = "Path relative to the project folder"
        pathField.setAccessibilityLabel("Project-relative file path")
        pathField.target = self
        pathField.action = #selector(submitPath)
        dropMark.isHidden = true
        overlay.addSubview(dropMark)
        for view in [bar, stage, side, sidebarEdge, pathRow, banner, foot, overlay] { addSubview(view) }
        stage.addSubview(groupEdge)
        for view in panels.map(\.button) + [folder, add, save, more] { bar.addSubview(view) }
        for view in [pathField, pathSubmit, pathCancel] { pathRow.addSubview(view) }
        for view in [message, hideMessage, messageAction] { banner.addSubview(view) }
        for view in [status, details, wrap] { foot.addSubview(view) }

        for (name, button) in panels { button.run = { [weak self] in self?.onSidebar?(name) } }
        panels[0].button.context = { [weak self] in self?.noteMenu("folder", "") ?? NSMenu() }
        add.run = { [weak self] in self?.onCommand?("scratch") }
        save.run = { [weak self] in self?.onCommand?("save") }
        more.run = { [weak self] in
            guard let self, let menu = onMenu?() else { return }
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: more.bounds.minY - 4), in: more)
        }
        more.context = { [weak self] in self?.noteMenu("pane", "workspace") ?? NSMenu() }
        wrap.run = { [weak self] in self?.onCommand?("wrap") }
        wrap.context = { [weak self] in self?.noteMenu("setting", "line-wrap") ?? NSMenu() }
        pathSubmit.run = { [weak self] in self?.submitPath() }
        pathCancel.run = { [weak self] in self?.onCancelPath?() }
        hideMessage.run = { [weak self] in self?.clearMessage() }

        sidebarEdge.onDrag = { [weak self] position in self?.resizeSidebar(to: position) }
        sidebarEdge.onEnd = { [weak self] in self?.keepSidebar() }
        sidebarEdge.onFit = { [weak self] in self?.fitSidebar() }
        sidebarEdge.onStep = { [weak self] distance in
            guard let self else { return }
            resizeSidebar(to: sidebarWidth + distance)
            keepSidebar()
        }
        groupEdge.onDrag = { [weak self] position in self?.resizeGroups(to: position) }
        groupEdge.onFit = { [weak self] in self?.resizeGroups(share: 0.5) }
        groupEdge.onStep = { [weak self] distance in
            guard let self else { return }
            resizeGroups(to: groupEdge.position + distance)
        }
        styleObserver = NotificationCenter.default.addObserver(forName: .workspaceStyleDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.styleChanged() }
        }
        styleChanged()
    }
    required init?(coder: NSCoder) { nil }

    /// Repaints every part after the theme or the interface size changes.
    private func styleChanged() {
        let theme = WorkspaceStyle.theme
        folder.textColor = theme.text
        status.textColor = theme.text
        details.textColor = theme.secondaryText
        message.textColor = theme.text
        func repaint(_ view: NSView) {
            view.needsDisplay = true
            view.subviews.forEach(repaint)
        }
        repaint(self)
        needsLayout = true
    }

    private func noteMenu(_ kind: String, _ key: String) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(WorkspaceChoice("Note on this \(kind)…") { [weak self] in self?.onNote?(kind, key) })
        return menu
    }
    override func menu(for event: NSEvent) -> NSMenu? { noteMenu("pane", "workspace") }

    // MARK: Overlays

    /// Where an overlay sits: floating at the top of the pane, like Go to Anything, or docked at
    /// the bottom of the stage above the status line, like Find.
    enum OverlayPlacement { case top, bottom }
    private var overlayView: NSView?
    private var overlayPlacement = OverlayPlacement.top
    /// The size an overlay wants inside a pane of the given size.
    private var overlaySize: ((NSSize) -> NSSize)?
    var hasOverlay: Bool { overlayView != nil }

    /// Shows one overlay above the workspace, replacing the one on show. A docked overlay takes
    /// its height from the stage, so the source never sits under it.
    func presentOverlay(_ view: NSView, placement: OverlayPlacement, size: @escaping (NSSize) -> NSSize) {
        if overlayView !== view {
            overlayView?.removeFromSuperview()
            addSubview(view, positioned: .below, relativeTo: overlay)
        }
        overlayView = view
        overlayPlacement = placement
        overlaySize = size
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    func dismissOverlay(_ view: NSView? = nil) {
        guard let current = overlayView, view == nil || view === current else { return }
        current.removeFromSuperview()
        overlayView = nil
        overlaySize = nil
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    // MARK: Status, messages and the path row

    func setStatus(_ text: String, _ detail: String, canSave: Bool) {
        statusText = text
        if notice == nil { showStatus() }
        if details.stringValue != detail { details.stringValue = detail; needsLayout = true }
        save.isEnabled = canSave
    }
    private func showStatus() {
        if status.stringValue != statusText { status.stringValue = statusText }
        status.toolTip = statusText
    }
    /// Returns the status line to the current status before its notice ends.
    func clearNotice() {
        notice?.cancel()
        notice = nil
        showStatus()
    }
    /// Reports a finished action in the status line for a few seconds. The page does not move.
    func notify(_ text: String) {
        notice?.cancel()
        status.stringValue = text
        status.toolTip = text
        notice = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(4, Double(text.count) / 14)))
            guard !Task.isCancelled, let self else { return }
            notice = nil
            showStatus()
        }
    }
    /// Shows a problem or a choice above the body until the person dismisses it.
    func setMessage(_ text: String, action: String? = nil, run: (() -> Void)? = nil) {
        message.stringValue = text
        message.toolTip = text
        messageAction.title = action ?? ""
        messageAction.run = run
        messageAction.isHidden = action == nil
        showMessage = true
        needsLayout = true
    }
    func clearMessage() { showMessage = false; messageAction.run = nil; needsLayout = true }
    /// Asks for a project path. `start` is the part the person need not type, such as a folder.
    func inputPath(action: String, start: String = "") {
        pathSubmit.title = action
        pathSubmit.setAccessibilityLabel(action)
        if !hasPathText { pathField.stringValue = start; pathStart = start }
        showPath = true
        needsLayout = true
        layoutSubtreeIfNeeded()
        window?.makeFirstResponder(pathField)
        pathField.currentEditor()?.selectedRange = NSRange(location: (pathField.stringValue as NSString).length, length: 0)
    }
    func hidePath() { showPath = false; pathField.stringValue = ""; pathStart = ""; needsLayout = true }
    @objc private func submitPath() {
        let path = pathField.stringValue
        guard hasPathText else { window?.makeFirstResponder(pathField); return }
        onPath?(path)
    }
    func setWrap(_ enabled: Bool) {
        wrap.isOn = enabled
        wrap.setAccessibilityValue(enabled ? "On" : "Off")
    }

    // MARK: Sidebar

    /// Shows a panel in the sidebar, or none, and marks the button of the panel on show.
    func setSidebar(_ panel: NSView?, named name: String?) {
        for (candidate, button) in panels { button.isOn = panel != nil && candidate == name }
        guard accessory !== panel else { return }
        accessory?.removeFromSuperview()
        accessory = panel
        if let panel { side.addSubview(panel) }
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    private func resizeSidebar(to position: CGFloat) {
        let limit = WorkspaceLayout.maximumSidebar(pane: bounds.width, groups: max(1, groups.count))
        let width = min(max(WorkspaceLayout.minimumSidebar, position.rounded()), limit)
        guard width != chosenSidebar else { return }
        chosenSidebar = width
        needsLayout = true
        layoutSubtreeIfNeeded()
    }
    private func keepSidebar() {
        if let chosenSidebar { defaults.set(Double(chosenSidebar), forKey: Self.sidebarKey) }
        else { defaults.removeObject(forKey: Self.sidebarKey) }
    }
    /// Fits the sidebar to its content, or returns it to the standard width.
    private func fitSidebar() {
        // The content ends where the reach of the edge begins.
        chosenSidebar = onFitSidebar?().map { max(WorkspaceLayout.minimumSidebar, $0.rounded(.up) + WorkspaceDivider.reachBefore) }
        keepSidebar()
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    // MARK: Tab groups

    /// Shows the tab groups of the stage. Tab and group views are kept by their keys, so a
    /// view under the pointer or with the keyboard stays in place while others change.
    func setGroups(_ next: [WorkspaceGroup], active: Int, reveal: String? = nil) {
        let same = active == activeGroup && next.count == groups.count && zip(next, groups).allSatisfy {
            $0.id == $1.id && $0.tabs == $1.tabs && $0.selected == $1.selected && $0.page === $1.page
        }
        if !same {
            let views = next.map { group in groupViews.first { $0.id == group.id } ?? makeGroup(group.id) }
            for old in groupViews where !views.contains(where: { $0 === old }) { old.removeFromSuperview() }
            if views.count == 2, groupViews.count != 2 { share = 0.5 }
            groupViews = views
            var kept: [String: WorkspaceTabView] = [:]
            for (group, view) in zip(next, views) {
                view.strip.show(group.tabs.map { item in
                    let tab = tabViews[item.key] ?? makeTab(item)
                    if tab.item != item { tab.show(item) }
                    tab.isChosen = item.key == group.selected
                    tab.inActiveGroup = group.id == active
                    kept[item.key] = tab
                    return tab
                })
                view.strip.isHidden = group.tabs.isEmpty
                view.show(page: group.page)
                view.needsLayout = true
            }
            tabViews = kept
            groups = next
            activeGroup = active
            if let drag, kept[drag.key] == nil { finishDrag(commit: false) }
            needsLayout = true
            layoutSubtreeIfNeeded()
        }
        if let reveal, let group = next.first(where: { $0.tabs.contains { $0.key == reveal } }) {
            groupViews.first { $0.id == group.id }?.strip.reveal(reveal)
        }
    }

    private func makeGroup(_ id: Int) -> WorkspaceGroupView {
        let view = WorkspaceGroupView(id: id)
        view.onActivate = { [weak self] in self?.onActivate?(id) }
        view.strip.onBlankDoubleClick = { [weak self] in self?.onCommand?("scratch") }
        stage.addSubview(view, positioned: .below, relativeTo: groupEdge)
        return view
    }

    private func makeTab(_ item: WorkspaceTab) -> WorkspaceTabView {
        let tab = WorkspaceTabView(item: item)
        let key = item.key
        tab.onPress = { [weak self] in self?.onSelect?(key) }
        tab.onClose = { [weak self] in self?.onClose?(key) }
        tab.onMenu = { [weak self] in self?.onTabMenu?(key) ?? NSMenu() }
        tab.onDragStart = { [weak self, weak tab] press in
            guard let self, let tab else { return false }
            return beginDrag(tab, pressedAt: press)
        }
        tab.onDragMove = { [weak self] event in
            guard let self else { return }
            moveDrag(to: convert(event.locationInWindow, from: nil))
        }
        tab.onDragEnd = { [weak self] event in
            guard let self else { return }
            moveDrag(to: convert(event.locationInWindow, from: nil))
            finishDrag(commit: true)
        }
        return tab
    }

    private func resizeGroups(to position: CGFloat) {
        let room = stage.bounds.width - WorkspaceDivider.thickness
        guard room > 0 else { return }
        resizeGroups(share: (position - WorkspaceDivider.reachBefore) / room)
    }
    private func resizeGroups(share next: CGFloat) {
        share = min(max(0, next), 1)
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    // MARK: Dragging a tab

    /// Lifts a tab from its strip. The tab keeps the point of the press under the pointer.
    private func beginDrag(_ tab: WorkspaceTabView, pressedAt press: NSPoint) -> Bool {
        settle?()
        let key = tab.item.key
        guard drag == nil, let group = groups.first(where: { $0.tabs.contains { $0.key == key } }),
              let home = group.tabs.firstIndex(where: { $0.key == key }),
              let view = groupViews.first(where: { $0.id == group.id }) else { return false }
        let point = convert(press, from: nil)
        let frame = convert(tab.bounds, from: tab)
        let ghost = WorkspaceTabView(item: tab.item)
        ghost.isChosen = true
        ghost.frame = frame
        ghost.wantsLayer = true
        ghost.shadow = {
            let shadow = NSShadow()
            shadow.shadowBlurRadius = 8
            shadow.shadowOffset = NSSize(width: 0, height: -2)
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
            return shadow
        }()
        overlay.addSubview(ghost, positioned: .above, relativeTo: dropMark)
        tab.alphaValue = 0
        view.strip.hold(lifted: key, opening: (home, frame.width), animated: false)
        drag = TabDrag(key: key, origin: group.id, home: home, grab: CGPoint(x: point.x - frame.minX, y: point.y - frame.minY),
                       ghost: ghost, target: .slot(group: group.id, index: home), point: point)
        escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, let self, drag != nil else { return event }
            finishDrag(commit: false)
            return nil
        }
        return true
    }

    private func landing(at point: CGPoint, for drag: TabDrag) -> WorkspaceDrop? {
        for (group, view) in zip(groups, groupViews) {
            let strip = convert(view.strip.bounds, from: view.strip)
            if !view.strip.isHidden, strip.insetBy(dx: 0, dy: -10).contains(point) {
                return .slot(group: group.id, index: view.strip.slot(leading: point.x - drag.grab.x - strip.minX))
            }
            let page = convert(view.pageHost.bounds, from: view.pageHost)
            guard page.contains(point) else { continue }
            if groups.count == 1 {
                guard group.tabs.count > 1, fitsSecondGroup else { return nil }
                let part = (point.x - page.minX) / max(1, page.width)
                return part < 0.35 ? .beside(group: group.id, trailing: false) : part > 0.65 ? .beside(group: group.id, trailing: true) : nil
            }
            return group.id == drag.origin ? nil : .slot(group: group.id, index: group.tabs.count)
        }
        return nil
    }

    /// Moves the dragged tab to a point in this view and shows where a drop would put it.
    private func moveDrag(to point: CGPoint) {
        guard var drag else { return }
        let target = landing(at: point, for: drag)
        drag.target = target
        drag.point = point
        self.drag = drag

        var origin = CGPoint(x: point.x - drag.grab.x, y: point.y - drag.grab.y)
        var mark: NSRect?
        var edge: (view: WorkspaceTabStrip, direction: CGFloat)?
        switch target {
        case .slot(let id, _)?:
            guard let view = groupViews.first(where: { $0.id == id }) else { break }
            let strip = convert(view.strip.bounds, from: view.strip)
            if strip.insetBy(dx: 0, dy: -10).contains(point) {
                // Over a strip the tab rides in the row, as it will sit after the drop.
                origin.y = strip.minY + (WorkspaceTabStrip.height - drag.ghost.frame.height)
                origin.x = min(max(strip.minX, origin.x), max(strip.minX, strip.maxX - drag.ghost.frame.width))
                if point.x < strip.minX + 28 { edge = (view.strip, -1) } else if point.x > strip.maxX - 28 { edge = (view.strip, 1) }
            } else {
                mark = convert(view.pageHost.bounds, from: view.pageHost)
            }
        case .beside(let id, let trailing)?:
            guard let view = groupViews.first(where: { $0.id == id }) else { break }
            let page = convert(view.pageHost.bounds, from: view.pageHost)
            mark = NSRect(x: trailing ? page.midX : page.minX, y: page.minY, width: page.width / 2, height: page.height)
        case nil: break
        }
        drag.ghost.setFrameOrigin(origin)
        for view in groupViews {
            var opening: (index: Int, width: CGFloat)?
            if case .slot(let id, let index)? = target, id == view.id { opening = (index, drag.ghost.frame.width) }
            view.strip.hold(lifted: view.id == drag.origin ? drag.key : nil, opening: opening, animated: true)
        }
        dropMark.isHidden = mark == nil
        if let mark { dropMark.frame = mark.insetBy(dx: 6, dy: 6) }

        // A crowded strip scrolls while the dragged tab waits at one of its ends.
        creep?.cancel()
        creep = nil
        guard let edge, edge.view.scroll(by: edge.direction * 9) else { return }
        creep = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(16))
            guard !Task.isCancelled, let self, let drag = self.drag else { return }
            moveDrag(to: drag.point)
        }
    }

    private func finishDrag(commit: Bool) {
        guard let drag else { return }
        self.drag = nil
        creep?.cancel()
        creep = nil
        if let escape { NSEvent.removeMonitor(escape) }
        escape = nil
        dropMark.isHidden = true
        let tab = tabViews[drag.key]
        let release = { [weak self] in
            drag.ghost.removeFromSuperview()
            tab?.alphaValue = 1
            for view in self?.groupViews ?? [] { view.strip.hold(lifted: nil, opening: nil, animated: false) }
        }
        let home = WorkspaceDrop.slot(group: drag.origin, index: drag.home)
        if commit, let target = drag.target, target != home {
            release()
            onMove?(drag.key, target)
            return
        }
        // The tab returns to its place.
        guard window != nil, let view = groupViews.first(where: { $0.id == drag.origin }) else { release(); return }
        for other in groupViews {
            other.strip.hold(lifted: other.id == drag.origin ? drag.key : nil,
                             opening: other.id == drag.origin ? (drag.home, drag.ghost.frame.width) : nil, animated: true)
        }
        let rest = convert(view.strip.landing(at: drag.home, width: drag.ghost.frame.width), from: view.strip)
        settle = { [weak self] in
            self?.settle = nil
            release()
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            drag.ghost.animator().frame = rest
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated { self?.settle?() }
        })
    }

    // MARK: Layout

    override func layout() {
        super.layout()
        let w = bounds.width, h = bounds.height
        let slot = min(30, max(22, (w - 12) / 8))
        bar.frame = NSRect(x: 0, y: 0, width: w, height: Self.toolHeight)
        var left: CGFloat = 6
        for (_, button) in panels {
            button.frame = NSRect(x: left, y: 5, width: slot, height: 28)
            left += slot + 1
        }
        var right = w - 6
        for item in [more, save, add] {
            right -= slot
            item.frame = NSRect(x: right, y: 5, width: slot, height: 28)
            right -= 1
        }
        folder.frame = NSRect(x: left + 8, y: 10, width: max(0, right - left - 16), height: 18)

        var top = Self.toolHeight
        pathRow.isHidden = !showPath
        if showPath {
            pathRow.frame = NSRect(x: 0, y: top, width: w, height: 38)
            pathCancel.frame = NSRect(x: w - 29, y: 6, width: 24, height: 26)
            pathSubmit.frame = NSRect(x: w - 106, y: 6, width: 75, height: 26)
            pathField.frame = NSRect(x: 9, y: 7, width: max(10, w - 123), height: 24)
            top += 38
        }
        banner.isHidden = !showMessage
        if showMessage {
            let buttonWidth: CGFloat = messageAction.isHidden ? 0 : min(120, messageAction.fittingSize.width + 14)
            let textWidth = max(32, w - buttonWidth - 45)
            let textHeight = min(52, max(18, message.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: textWidth, height: 75)).height ?? 18))
            let height = max(33, textHeight + 13)
            banner.frame = NSRect(x: 0, y: top, width: w, height: height)
            message.frame = NSRect(x: 10, y: (height - textHeight) / 2, width: textWidth, height: textHeight)
            messageAction.frame = NSRect(x: w - 31 - buttonWidth, y: (height - 25) / 2, width: buttonWidth, height: 25)
            hideMessage.frame = NSRect(x: w - 29, y: (height - 24) / 2, width: 24, height: 24)
            top += height
        }

        var bottomDock: CGFloat = 0
        if let overlayView, let overlaySize {
            let size = overlaySize(bounds.size)
            switch overlayPlacement {
            case .top:
                let width = min(size.width, w - 16)
                overlayView.frame = NSRect(x: ((w - width) / 2).rounded(), y: top + 8, width: width, height: min(size.height, max(0, h - top - 16)))
            case .bottom:
                bottomDock = min(size.height, max(0, h - top - Self.footHeight - 60))
                overlayView.frame = NSRect(x: 0, y: h - Self.footHeight - bottomDock, width: w, height: bottomDock)
            }
        }
        let height = max(0, h - top - Self.footHeight - bottomDock)
        let count = max(1, groupViews.count)
        let beside = accessory != nil && showsSideBySide
        let sideWidth: CGFloat = accessory == nil ? 0 : beside ? WorkspaceLayout.sidebar(chosen: chosenSidebar, pane: w, groups: count) : w
        side.isHidden = accessory == nil
        // The sidebar width runs to the line; the edge takes its reach from both regions.
        side.frame = NSRect(x: 0, y: top, width: beside ? sideWidth - WorkspaceDivider.reachBefore : sideWidth, height: height)
        accessory?.frame = side.bounds
        sidebarEdge.isHidden = !beside
        sidebarEdge.frame = NSRect(x: sideWidth - WorkspaceDivider.reachBefore, y: top, width: WorkspaceDivider.thickness, height: height)
        sidebarEdge.canShrink = sideWidth > WorkspaceLayout.minimumSidebar
        sidebarEdge.canGrow = sideWidth < WorkspaceLayout.maximumSidebar(pane: w, groups: count)
        let strips = groupViews.contains { !$0.strip.isHidden }
        sidebarEdge.surfaces = (side.colour, stage.colour)
        sidebarEdge.band = strips ? (WorkspaceTabStrip.height, WorkspaceStyle.chrome, WorkspaceDivider.reachBefore) : nil

        stage.isHidden = accessory != nil && !beside
        let inset = beside ? sideWidth + 1 + WorkspaceDivider.reachAfter : 0
        stage.frame = NSRect(x: inset, y: top, width: max(0, w - inset), height: height)
        groupEdge.isHidden = groupViews.count != 2
        if groupViews.count == 2 {
            let first = WorkspaceLayout.firstGroup(share: share, stage: stage.bounds.width)
            groupViews[0].frame = NSRect(x: 0, y: 0, width: first, height: height)
            groupEdge.frame = NSRect(x: first, y: 0, width: WorkspaceDivider.thickness, height: height)
            let start = first + WorkspaceDivider.thickness
            groupViews[1].frame = NSRect(x: start, y: 0, width: max(0, stage.bounds.width - start), height: height)
            groupEdge.surfaces = (stage.colour, stage.colour)
            groupEdge.band = (WorkspaceTabStrip.height, WorkspaceStyle.chrome, 0)
            let least = min(WorkspaceLayout.minimumGroup, ((stage.bounds.width - WorkspaceDivider.thickness) / 2).rounded(.down))
            groupEdge.canShrink = first > least
            groupEdge.canGrow = stage.bounds.width - start > least
        } else {
            groupViews.first?.frame = stage.bounds
        }

        foot.frame = NSRect(x: 0, y: h - Self.footHeight, width: w, height: Self.footHeight)
        let detailWidth = min(w * 0.55, details.intrinsicContentSize.width)
        wrap.frame = NSRect(x: w - 28, y: 2, width: 22, height: 21)
        details.frame = NSRect(x: w - detailWidth - 35, y: 5, width: detailWidth, height: 16)
        status.frame = NSRect(x: 10, y: 5, width: max(0, w - detailWidth - 53), height: 16)
        overlay.frame = bounds
    }
}
