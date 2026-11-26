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

/// The workspace frame owns the geometry of the sidebar, tab groups and status line.
@MainActor
final class WorkspaceChrome: NSView {
    var onCommand: ((String) -> Void)?
    /// Receives the name of the sidebar panel whose button was pressed.
    var onSidebar: ((String) -> Void)?
    var onSelect: ((String) -> Void)?
    var onClose: ((String) -> Void)?
    var onMove: ((String, WorkspaceDrop) -> Void)?
    var onDropFile: ((String, WorkspaceDrop) -> Void)?
    var onKeepTab: ((String) -> Void)?
    var onActivate: ((Int) -> Void)?
    var onTabMenu: ((String) -> NSMenu)?
    var onMenu: (() -> NSMenu)?
    var onIndentationMenu: (() -> NSMenu)?
    var onLanguageMenu: (() -> NSMenu)?
    var onGeometryChange: (() -> Void)?
    var onNote: ((String, String) -> Void)?
    var onPath: ((String) -> Void)?
    var onCancelPath: (() -> Void)?
    /// Returns the sidebar width that shows its content in full, when the content has one.
    var onFitSidebar: (() -> CGFloat?)?

    private static let sidebarKey = "sidebarWidth"
    private static let fileDrop = NSPasteboard.PasteboardType("app.pi.editor.path")
    private let defaults: UserDefaults
    private let side = WorkspaceRegion()
    private let sidebarHeader = WorkspaceRegion(line: .bottom)
    private let stage = WorkspaceRegion(.content)
    private let banner = WorkspaceRegion(line: .bottom)
    private let pathRow = WorkspaceRegion(line: .bottom)
    private let foot = WorkspaceRegion(.bar, line: .top)
    private let overlay = WorkspaceOverlay()
    private let dropMark = WorkspaceDropMark()
    private let sidebarEdge = WorkspaceDivider(label: "Sidebar width")
    private var columnEdges: [WorkspaceDivider] = []
    private var rowEdges: [WorkspaceDivider] = []
    private let folder: NSTextField
    private let status = NSTextField(labelWithString: "")
    private let branch = NSTextField(labelWithString: "")
    private let position = NSTextField(labelWithString: "")
    private let indentation = WorkspaceButton("", help: "Indentation options")
    private let language = WorkspaceButton("", help: "Language options")
    private let format = NSTextField(labelWithString: "")
    private let details = NSTextField(labelWithString: "")
    private let sidebarButton = WorkspaceButton("", symbol: "sidebar.left", help: "Toggle sidebar")
    private let wrap = WorkspaceButton("", symbol: "text.word.spacing", help: "Wrap lines")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let panels: [(name: String, button: WorkspaceButton)] = [
        ("files", WorkspaceButton("", symbol: "folder", help: "Project files (cmd+O)")),
        ("search", WorkspaceButton("", symbol: "magnifyingglass", help: "Project search (cmd+P)")),
        ("git", WorkspaceButton("", symbol: "arrow.triangle.branch", help: "Local Git")),
        ("notes", WorkspaceButton("", symbol: "bubble.left.and.bubble.right", help: "Conversations (cmd+option+T)")),
    ]
    private let more = WorkspaceButton("", symbol: "ellipsis.circle", help: "Workspace actions")
    private let hideMessage = WorkspaceButton("", symbol: "xmark", help: "Dismiss message")
    private let messageAction = WorkspaceButton("")
    private let pathField = NSTextField()
    private let pathSubmit = WorkspaceButton("")
    private let pathCancel = WorkspaceButton("", symbol: "xmark", help: "Cancel path entry")

    /// The chosen sidebar width before the pane's current width limits it.
    var sidebarChoice: Double? { didSet { if sidebarChoice != oldValue { needsLayout = true } } }
    var arrangement: WorkspaceArrangement = .single {
        didSet {
            guard arrangement != oldValue else { return }
            splitWeights = []
            needsLayout = true
        }
    }
    /// Cumulative positions within each axis, with gutters excluded. Columns come first, then
    /// rows, both in display order. An empty array selects equal bands on both axes.
    var splitWeights: [Double] = [] { didSet { if splitWeights != oldValue { needsLayout = true } } }
    private var chosenSidebar: CGFloat? { sidebarChoice.flatMap { $0.isFinite ? CGFloat($0) : nil } }
    private var effectiveArrangement: WorkspaceArrangement {
        arrangement.expanding(to: max(1, groupViews.count), preferRows: arrangement.rows > 1)
    }
    private var geometryEdited = false
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
    private var escape: Any?
    private var settle: (() -> Void)?
    private weak var settlingGhost: WorkspaceTabView?
    private var creep: Task<Void, Never>?
    private var fileTarget: WorkspaceDrop?

    var expandedPanel = false { didSet { if expandedPanel != oldValue { needsLayout = true } } }
    var keepsEmptyGroups = false
    var showsSideBySide: Bool { WorkspaceLayout.fitsBeside(pane: bounds.width) && !expandedPanel }
    var sidebarWidth: CGFloat { side.isHidden ? 0 : sidebarEdge.isHidden ? side.frame.width : sidebarEdge.position }
    /// A stage with room for a second tab group. A wide sidebar yields to the second group
    /// down to its own limit, so the room is the one the stage would then have.
    var fitsSecondGroup: Bool {
        guard groups.count == 1, !stage.isHidden else { return false }
        return WorkspaceLayout.fitsTwoGroups(stage: bounds.width - stageInset(columns: 2))
    }
    /// The person typed a path that has not been submitted.
    var hasPathText: Bool { showPath && !pathField.stringValue.isEmpty && pathField.stringValue != pathStart }
    override var isFlipped: Bool { true }

    init(root: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        folder = NSTextField(labelWithString: URL(fileURLWithPath: root).lastPathComponent)
        super.init(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        if let stored = defaults.object(forKey: Self.sidebarKey) as? Double, stored.isFinite, (1...10_000).contains(stored) {
            sidebarChoice = stored
        }
        folder.lineBreakMode = .byTruncatingMiddle
        folder.toolTip = root
        folder.setAccessibilityLabel("Project folder")
        for label in [status, branch, position, format, details] { label.lineBreakMode = .byTruncatingTail }
        message.maximumNumberOfLines = 3
        message.lineBreakMode = .byTruncatingTail
        pathField.placeholderString = "Path relative to the project folder"
        pathField.setAccessibilityLabel("Project-relative file path")
        pathField.target = self
        pathField.action = #selector(submitPath)
        dropMark.isHidden = true
        overlay.addSubview(dropMark)
        for view in [stage, side, sidebarEdge, pathRow, banner, foot, overlay] { addSubview(view) }
        stage.clipsToBounds = true
        side.clipsToBounds = true
        side.addSubview(sidebarHeader)
        for view in panels.map(\.button) + [folder] { sidebarHeader.addSubview(view) }
        for view in [pathField, pathSubmit, pathCancel] { pathRow.addSubview(view) }
        for view in [message, hideMessage, messageAction] { banner.addSubview(view) }
        for view in [sidebarButton, branch, status, details, position, indentation, language, format, wrap, more] { foot.addSubview(view) }

        for (name, button) in panels { button.run = { [weak self] in self?.onSidebar?(name) } }
        panels[0].button.context = { [weak self] in
            guard let self else { return NSMenu() }
            let menu = noteMenu("folder", "")
            menu.insertItem(WorkspaceChoice("Refresh Files") { [weak self] in self?.onCommand?("refreshFiles") }, at: 0)
            return menu
        }
        sidebarButton.run = { [weak self] in self?.onCommand?("sidebar") }
        more.run = { [weak self] in
            guard let self else { return }
            openMenu(onMenu?(), at: more)
        }
        indentation.run = { [weak self] in
            guard let self else { return }
            openMenu(onIndentationMenu?(), at: indentation)
        }
        language.run = { [weak self] in
            guard let self else { return }
            openMenu(onLanguageMenu?(), at: language)
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
        for index in 0..<3 { columnEdges.append(makeDivider(.columns, index: index)) }
        for index in 0..<2 { rowEdges.append(makeDivider(.rows, index: index)) }
        registerForDraggedTypes([Self.fileDrop])
        NotificationCenter.default.addObserver(self, selector: #selector(styleChanged), name: .workspaceStyleDidChange, object: nil)
        styleChanged()
    }
    required init?(coder: NSCoder) { nil }

    @objc private func styleChanged() {
        let theme = WorkspaceStyle.theme
        folder.font = WorkspaceStyle.interfaceFont(1, weight: .semibold)
        folder.textColor = theme.text
        message.font = WorkspaceStyle.interfaceFont()
        message.textColor = theme.text
        pathField.font = WorkspaceStyle.interfaceFont()
        pathField.backgroundColor = theme.editor
        pathField.textColor = theme.text
        for label in [status, branch, position, format, details] {
            label.font = WorkspaceStyle.interfaceFont(-1)
            label.textColor = label === status ? theme.text : theme.secondaryText
        }
        for tab in tabViews.values { tab.applyStyle() }
        for view in groupViews { view.needsLayout = true; view.strip.needsLayout = true; view.strip.needsDisplay = true }
        for edge in [sidebarEdge] + columnEdges + rowEdges { edge.needsDisplay = true }
        dropMark.needsDisplay = true
        needsLayout = true
    }

    private func openMenu(_ menu: NSMenu?, at button: NSView) {
        guard let menu, menu.numberOfItems > 0, button.window != nil else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY), in: button)
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

    func setStatus(_ text: String, _ detail: String, canSave _: Bool) {
        statusText = text
        if notice == nil { showStatus() }
        if details.stringValue != detail { details.stringValue = detail; layoutStatus() }
    }

    func setEditorStatus(branch: String?, position: String, indentation: String?, language: String?, format: String) {
        var changed = false
        for (label, value) in [(self.branch, branch ?? ""), (self.position, position), (self.format, format)] where label.stringValue != value {
            label.stringValue = value
            label.toolTip = value.isEmpty ? nil : value
            changed = true
        }
        for (button, value) in [(self.indentation, indentation ?? ""), (self.language, language ?? "")] where button.title != value {
            button.title = value
            button.setAccessibilityLabel([button.toolTip, value].compactMap { $0 }.joined(separator: ": "))
            changed = true
        }
        if changed { layoutStatus() }
    }
    private func showStatus() {
        if status.stringValue != statusText {
            status.stringValue = statusText
            layoutStatus()
        }
        status.toolTip = statusText.isEmpty ? nil : statusText
    }
    /// Returns the status line to the current status before its notice ends.
    func clearNotice() {
        notice?.cancel()
        notice = nil
        showStatus()
    }
    /// Reports a finished action in the status line for a few seconds. The page does not move.
    func notify(_ text: String) {
        if text.isEmpty { clearNotice(); return }
        notice?.cancel()
        status.stringValue = text
        status.toolTip = text
        layoutStatus()
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
        sidebarButton.isOn = panel != nil
        sidebarButton.setAccessibilityValue(panel != nil ? "Shown" : "Hidden")
        guard accessory !== panel else { return }
        accessory?.removeFromSuperview()
        accessory = panel
        if let panel { side.addSubview(panel, positioned: .below, relativeTo: sidebarHeader) }
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    private func resizeSidebar(to position: CGFloat) {
        let limit = WorkspaceLayout.maximumSidebar(pane: bounds.width, groups: effectiveArrangement.columns)
        let width = min(max(WorkspaceLayout.minimumSidebar, position.rounded()), limit)
        guard width != sidebarWidth else { return }
        sidebarChoice = Double(width)
        geometryEdited = true
        needsLayout = true
        layoutSubtreeIfNeeded()
    }
    private func keepSidebar() {
        guard geometryEdited else { return }
        if let sidebarChoice { defaults.set(sidebarChoice, forKey: Self.sidebarKey) }
        else { defaults.removeObject(forKey: Self.sidebarKey) }
        reportGeometryEdit()
    }

    private func reportGeometryEdit() {
        guard geometryEdited else { return }
        geometryEdited = false
        onGeometryChange?()
    }

    /// Fits the sidebar to its content, or returns it to the standard width.
    private func fitSidebar() {
        let choice = onFitSidebar?().map { Double(max(WorkspaceLayout.minimumSidebar, $0.rounded(.up) + WorkspaceDivider.reachBefore)) }
        guard sidebarChoice != choice else { return }
        sidebarChoice = choice
        geometryEdited = true
        keepSidebar()
        layoutSubtreeIfNeeded()
    }

    // MARK: Tab groups

    /// Shows the tab groups of the stage. Tab and group views are kept by their keys, so a
    /// view under the pointer or with the keyboard stays in place while others change.
    func setGroups(_ requested: [WorkspaceGroup], active: Int, reveal: String? = nil) {
        let next = Array(requested.prefix(4))
        let same = active == activeGroup && next.count == groups.count && zip(next, groups).allSatisfy {
            $0.id == $1.id && $0.tabs == $1.tabs && $0.selected == $1.selected && $0.page === $1.page
        }
        if !same {
            let views = next.map { group in groupViews.first { $0.id == group.id } ?? makeGroup(group.id) }
            for old in groupViews where !views.contains(where: { $0 === old }) { old.removeFromSuperview() }
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
        view.strip.onNewTab = { [weak self] in
            guard let self else { return }
            onActivate?(id)
            onCommand?("scratch")
        }
        stage.addSubview(view, positioned: .below, relativeTo: columnEdges.first)
        return view
    }

    private func makeTab(_ item: WorkspaceTab) -> WorkspaceTabView {
        let tab = WorkspaceTabView(item: item)
        let key = item.key
        tab.onPress = { [weak self] in self?.onSelect?(key) }
        tab.onKeep = { [weak self] in self?.onKeepTab?(key) }
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

    private func makeDivider(_ axis: WorkspaceDivider.Axis, index: Int) -> WorkspaceDivider {
        let label = axis == .columns ? "Tab group width" : "Tab group height"
        let edge = WorkspaceDivider(label: label, axis: axis)
        edge.onDrag = { [weak self] in self?.resizeGroups(axis, index: index, to: $0) }
        edge.onEnd = { [weak self] in self?.reportGeometryEdit() }
        edge.onFit = { [weak self] in self?.fitGroups(axis: axis, index: index) }
        edge.onStep = { [weak self, weak edge] distance in
            guard let self, let edge else { return }
            resizeGroups(axis, index: index, to: edge.position + distance)
            reportGeometryEdit()
        }
        stage.addSubview(edge)
        return edge
    }

    private func groupGeometry() -> WorkspaceLayout.Stage {
        WorkspaceLayout.Stage(size: stage.bounds.size, arrangement: effectiveArrangement, weights: splitWeights)
    }

    private func storeSplit(_ choice: Double, axis: WorkspaceDivider.Axis, index: Int) {
        let layout = effectiveArrangement
        let horizontal = layout.columns - 1
        let vertical = layout.rows - 1
        var next = splitWeights
        if next.count != horizontal + vertical {
            next = (0..<horizontal).map { Double($0 + 1) / Double(layout.columns) }
                 + (0..<vertical).map { Double($0 + 1) / Double(layout.rows) }
        }
        next[(axis == .columns ? 0 : horizontal) + index] = choice
        guard next != splitWeights else { return }
        splitWeights = next
        geometryEdited = true
        layoutSubtreeIfNeeded()
    }

    private func resizeGroups(_ axis: WorkspaceDivider.Axis, index: Int, to position: CGFloat) {
        let geometry = groupGeometry()
        let bands = axis == .columns ? geometry.columns : geometry.rows
        guard index < bands.count - 1,
              let choice = bands.choice(at: position, divider: index) else { return }
        storeSplit(choice, axis: axis, index: index)
    }

    private func fitGroups(axis: WorkspaceDivider.Axis, index: Int) {
        let geometry = groupGeometry()
        let bands = axis == .columns ? geometry.columns : geometry.rows
        guard index < bands.count - 1, bands.room > 0 else { return }
        let middle = (bands.cuts[index] + bands.cuts[index + 2]) / 2
        storeSplit(Double(middle / bands.room), axis: axis, index: index)
        reportGeometryEdit()
    }

    // MARK: Dragging a tab

    /// Lifts a tab from its strip. The tab keeps the point of the press under the pointer.
    private func beginDrag(_ tab: WorkspaceTabView, pressedAt press: NSPoint) -> Bool {
        clearFileDrop()
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
            shadow.shadowColor = WorkspaceStyle.theme.panelShadow
            return shadow
        }()
        overlay.addSubview(ghost, positioned: .above, relativeTo: dropMark)
        tab.alphaValue = 0
        view.strip.hold(lifted: key, opening: (home, frame.width), animated: false)
        drag = TabDrag(key: key, origin: group.id, home: home, grab: CGPoint(x: point.x - frame.minX, y: point.y - frame.minY),
                       ghost: ghost, target: .slot(group: group.id, index: home), point: point)
        escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, let self, event.window === window, drag != nil else { return event }
            finishDrag(commit: false)
            return nil
        }
        return true
    }

    private func landing(at point: CGPoint, origin: Int?, grabX: CGFloat) -> WorkspaceDrop? {
        guard !stage.isHidden else { return nil }
        for (group, view) in zip(groups, groupViews) {
            let strip = convert(view.strip.bounds, from: view.strip)
            if strip.contains(point) {
                return .slot(group: group.id, index: view.strip.slot(leading: point.x - grabX - strip.minX))
            }
            let page = convert(view.pageHost.bounds, from: view.pageHost)
            guard page.contains(point) else { continue }
            if groups.count < 4, group.id != origin || group.tabs.count > 1 || keepsEmptyGroups {
                let x = (point.x - page.minX) / page.width
                let y = (point.y - page.minY) / page.height
                let edges: [(distance: CGFloat, drop: WorkspaceDrop)] = [
                    (x, .beside(group: group.id, trailing: false)),
                    (1 - x, .beside(group: group.id, trailing: true)),
                    (y, .stacked(group: group.id, trailing: false)),
                    (1 - y, .stacked(group: group.id, trailing: true)),
                ]
                if let next = edges.min(by: { $0.distance < $1.distance }), next.distance <= 0.26,
                   splitFrame(for: next.drop, origin: origin) != nil { return next.drop }
            }
            return group.id == origin ? nil : .slot(group: group.id, index: group.tabs.count)
        }
        return nil
    }

    /// Match the preset and insertion order the screen applies when the drop creates a group.
    private func splitFrame(for target: WorkspaceDrop, origin: Int?) -> NSRect? {
        let id: Int, trailing: Bool, stacked: Bool
        switch target {
        case .beside(let group, let after): (id, trailing, stacked) = (group, after, false)
        case .stacked(let group, let after): (id, trailing, stacked) = (group, after, true)
        case .slot: return nil
        }
        guard let anchor = groups.firstIndex(where: { $0.id == id }) else { return nil }
        var index = anchor + (trailing ? 1 : 0)
        var next = effectiveArrangement.expanding(to: groups.count + 1, preferRows: stacked)
        if !keepsEmptyGroups, let source = groups.firstIndex(where: { $0.id == origin }), groups[source].tabs.count == 1 {
            if source < index { index -= 1 }
            next = next.expanding(to: groups.count, preferRows: next == .rows2 || next == .rows3)
        }
        let x = stageInset(columns: next.columns)
        let size = NSSize(width: max(0, bounds.width - x), height: stage.bounds.height)
        let nextGeometry = WorkspaceLayout.Stage(size: size, arrangement: next, weights: [])
        let box = nextGeometry.group(index)
        guard box.width >= WorkspaceTabView.minimumWidth, box.height >= WorkspaceTabStrip.height + 24 else { return nil }
        return box.offsetBy(dx: x, dy: stage.frame.minY)
    }

    /// Moves the dragged tab to a point in this view and shows where a drop would put it.
    private func moveDrag(to point: CGPoint) {
        guard var drag else { return }
        let target = landing(at: point, origin: drag.origin, grabX: drag.grab.x)
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
            if strip.contains(point) {
                // Over a strip the tab rides in the row, as it will sit after the drop.
                origin.y = strip.maxY - drag.ghost.frame.height
                origin.x = min(max(strip.minX, origin.x), max(strip.minX, strip.maxX - drag.ghost.frame.width))
                if point.x < strip.minX + 28 { edge = (view.strip, -1) } else if point.x > strip.maxX - 28 { edge = (view.strip, 1) }
            } else {
                mark = convert(view.pageHost.bounds, from: view.pageHost)
            }
        case .beside?, .stacked?:
            if let target { mark = splitFrame(for: target, origin: drag.origin) }
        case nil: break
        }
        drag.ghost.setFrameOrigin(origin)
        for view in groupViews {
            var opening: (index: Int, width: CGFloat)?
            if case .slot(let id, let index)? = target, id == view.id { opening = (index, drag.ghost.frame.width) }
            view.strip.hold(lifted: view.id == drag.origin ? drag.key : nil, opening: opening, animated: true)
        }
        showDropMark(mark)

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

    private func finishDrag(commit: Bool, animated: Bool = true) {
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
        guard animated, WorkspaceStyle.settings.animations, window != nil,
              let view = groupViews.first(where: { $0.id == drag.origin }) else { release(); return }
        for other in groupViews {
            other.strip.hold(lifted: other.id == drag.origin ? drag.key : nil,
                             opening: other.id == drag.origin ? (drag.home, drag.ghost.frame.width) : nil, animated: true)
        }
        let rest = convert(view.strip.landing(at: drag.home, width: drag.ghost.frame.width), from: view.strip)
        settlingGhost = drag.ghost
        settle = { [weak self] in
            self?.settle = nil
            self?.settlingGhost = nil
            release()
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.14
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            drag.ghost.animator().frame = rest
        }, completionHandler: { [weak self, weak ghost = drag.ghost] in
            MainActor.assumeIsolated {
                guard let self, let ghost, self.settlingGhost === ghost else { return }
                self.settle?()
            }
        })
    }

    // MARK: File drops from the navigator

    private func showDropMark(_ rect: NSRect?, inset: CGFloat = 6) {
        dropMark.isHidden = rect == nil
        if let rect { dropMark.frame = rect.insetBy(dx: inset, dy: inset) }
    }

    private func clearFileDrop() {
        guard fileTarget != nil else { return }
        fileTarget = nil
        showDropMark(nil)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation { draggingUpdated(sender) }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        let source = sender.draggingSourceOperationMask
        let operation: NSDragOperation = source.contains(.copy) ? .copy : source.intersection(.move)
        guard drag == nil, onDropFile != nil, !operation.isEmpty,
              let outline = sender.draggingSource as? NSOutlineView, outline.window === window,
              sender.draggingPasteboard.string(forType: Self.fileDrop)?.isEmpty == false else {
            clearFileDrop()
            return []
        }
        settle?()
        let point = convert(sender.draggingLocation, from: nil)
        fileTarget = landing(at: point, origin: nil, grabX: 0)
        switch fileTarget {
        case .slot(let id, var index)?:
            guard let view = groupViews.first(where: { $0.id == id }) else { break }
            let strip = convert(view.strip.bounds, from: view.strip)
            if strip.contains(point) {
                let local = point.x - strip.minX
                let distance: CGFloat = local < 22 ? -9 : local > strip.width - 30 ? 9 : 0
                if distance != 0 && view.strip.scroll(by: distance) {
                    index = view.strip.slot(leading: local)
                    fileTarget = .slot(group: id, index: index)
                }
                let slot = view.strip.landing(at: index, width: 4)
                let x = max(1, min(slot.minX, view.strip.bounds.maxX - 5))
                showDropMark(convert(NSRect(x: x, y: 5, width: 4, height: max(0, view.strip.bounds.height - 10)), from: view.strip), inset: 0)
            } else {
                showDropMark(convert(view.pageHost.bounds, from: view.pageHost))
            }
        case .beside?, .stacked?:
            if let fileTarget { showDropMark(splitFrame(for: fileTarget, origin: nil)) }
        case nil: showDropMark(nil)
        }
        return fileTarget == nil ? [] : operation
    }

    override func wantsPeriodicDraggingUpdates() -> Bool { true }
    override func draggingExited(_ sender: (any NSDraggingInfo)?) { clearFileDrop() }
    override func draggingEnded(_ sender: any NSDraggingInfo) { clearFileDrop() }

    override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool { fileTarget != nil }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        defer { clearFileDrop() }
        let point = convert(sender.draggingLocation, from: nil)
        guard let outline = sender.draggingSource as? NSOutlineView, outline.window === window,
              let fileTarget = landing(at: point, origin: nil, grabX: 0),
              let path = sender.draggingPasteboard.string(forType: Self.fileDrop), !path.isEmpty,
              let onDropFile else { return false }
        onDropFile(path, fileTarget)
        return true
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow !== window {
            finishDrag(commit: false, animated: false)
            clearFileDrop()
            settle?()
        }
        super.viewWillMove(toWindow: newWindow)
    }

    // MARK: Layout

    override func layout() {
        super.layout()
        let w = bounds.width, h = bounds.height
        let footHeight = min(h, WorkspaceStyle.statusHeight)
        var top: CGFloat = 0
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
                let width = max(0, min(size.width, w - 16))
                overlayView.frame = NSRect(x: ((w - width) / 2).rounded(), y: top + 8, width: width, height: min(size.height, max(0, h - top - 16)))
            case .bottom:
                bottomDock = min(size.height, max(0, h - top - footHeight - 60))
                overlayView.frame = NSRect(x: 0, y: h - footHeight - bottomDock, width: w, height: bottomDock)
            }
        }
        let height = max(0, h - top - footHeight - bottomDock)
        let columns = effectiveArrangement.columns
        let inset = stageInset(columns: columns)
        let beside = inset > 0
        let sideWidth = accessory == nil ? 0 : beside ? inset - 1 - WorkspaceDivider.reachAfter : w
        side.isHidden = accessory == nil
        side.frame = NSRect(x: 0, y: top, width: beside ? sideWidth - WorkspaceDivider.reachBefore : sideWidth, height: height)
        layoutSidebar()
        sidebarEdge.isHidden = !beside
        sidebarEdge.frame = NSRect(x: sideWidth - WorkspaceDivider.reachBefore, y: top, width: WorkspaceDivider.thickness, height: height)
        sidebarEdge.canShrink = sideWidth > WorkspaceLayout.minimumSidebar
        sidebarEdge.canGrow = sideWidth < WorkspaceLayout.maximumSidebar(pane: w, groups: columns)
        sidebarEdge.surfaces = (side.colour, stage.colour)

        stage.isHidden = accessory != nil && !beside
        stage.frame = NSRect(x: inset, y: top, width: max(0, w - inset), height: height)
        layoutGroups()
        foot.frame = NSRect(x: 0, y: h - footHeight, width: w, height: footHeight)
        layoutStatus()
        overlay.frame = bounds
    }

    private func stageInset(columns: Int) -> CGFloat {
        guard accessory != nil, showsSideBySide else { return 0 }
        return WorkspaceLayout.sidebar(chosen: chosenSidebar, pane: bounds.width, groups: columns) + 1 + WorkspaceDivider.reachAfter
    }

    private func layoutSidebar() {
        let width = side.bounds.width
        let header = min(side.bounds.height, WorkspaceTabStrip.height)
        sidebarHeader.frame = NSRect(x: 0, y: 0, width: width, height: header)
        accessory?.frame = NSRect(x: 0, y: header, width: width, height: max(0, side.bounds.height - header))
        let slot = min(28, max(0, (width - 12) / 5))
        let buttonHeight = min(header, 28)
        var x = width - 5
        for (_, button) in panels.reversed() {
            x -= slot
            button.frame = NSRect(x: x, y: (header - buttonHeight) / 2, width: slot, height: buttonHeight)
        }
        folder.frame = centredLabel(folder, x: 11, width: x - 15, height: header)
    }

    private func layoutGroups() {
        let geometry = groupGeometry()
        for (index, group) in groupViews.enumerated() { group.frame = geometry.group(index) }
        let strips = (0..<geometry.rows.count).compactMap { index -> (y: CGFloat, height: CGFloat)? in
            let row = geometry.rows.band(index)
            let height = min(row.length, WorkspaceTabStrip.height)
            return height >= 1 ? (row.origin, height) : nil
        }
        sidebarEdge.stripBands = strips.prefix(groupViews.isEmpty ? 0 : 1).map {
            NSRect(x: 0, y: $0.y, width: sidebarEdge.bounds.width, height: $0.height)
        }
        layoutDividers(columnEdges, bands: geometry.columns, across: stage.bounds.height, strips: strips, axis: .columns)
        layoutDividers(rowEdges, bands: geometry.rows, across: stage.bounds.width, strips: [], axis: .rows)
    }

    private func layoutDividers(_ edges: [WorkspaceDivider], bands: WorkspaceLayout.Bands, across: CGFloat,
                                strips: [(y: CGFloat, height: CGFloat)], axis: WorkspaceDivider.Axis) {
        for (i, edge) in edges.enumerated() {
            edge.isHidden = i >= bands.count - 1
            guard !edge.isHidden else { continue }
            let start = bands.divider(i)
            if axis == .columns {
                edge.frame = NSRect(x: start, y: 0, width: bands.gutter, height: across)
                edge.surfaces = (stage.colour, stage.colour)
                edge.stripBands = strips.map { NSRect(x: 0, y: $0.y, width: bands.gutter, height: $0.height) }
            } else {
                edge.frame = NSRect(x: 0, y: start, width: across, height: bands.gutter)
                edge.surfaces = (stage.colour, WorkspaceStyle.chrome)
            }
            edge.canShrink = bands.band(i).length > bands.least
            edge.canGrow = bands.band(i + 1).length > bands.least
        }
    }

    private func centredLabel(_ label: NSTextField, x: CGFloat, width: CGFloat, height: CGFloat) -> NSRect {
        let lineHeight = min(height, ceil(label.intrinsicContentSize.height))
        return NSRect(x: x, y: ((height - lineHeight) / 2).rounded(), width: max(0, width), height: lineHeight)
    }

    private func layoutStatus() {
        let w = foot.bounds.width, h = foot.bounds.height
        let square = min(28, w / 5)
        let buttonHeight = max(0, h - 4)
        sidebarButton.frame = NSRect(x: 4, y: 2, width: square, height: buttonHeight)
        var right = w - 4
        for button in [more, wrap] {
            right -= square
            button.frame = NSRect(x: right, y: 2, width: square, height: buttonHeight)
        }
        func measure(_ label: NSTextField) -> CGFloat {
            guard let font = label.font else { return 0 }
            return ceil((label.stringValue as NSString).size(withAttributes: [.font: font]).width) + 4
        }
        for label in [details, format] {
            label.isHidden = label.stringValue.isEmpty || (label === format && w < 520)
            guard !label.isHidden else { continue }
            let width = min(measure(label), w * 0.19)
            right -= width + 8
            label.frame = centredLabel(label, x: right, width: width, height: h)
        }
        for button in [language, indentation] {
            button.isHidden = button.title.isEmpty
            guard !button.isHidden else { continue }
            let width = min(button.fittingSize.width + 8, w * 0.22)
            right -= width
            button.frame = NSRect(x: right, y: 2, width: width, height: buttonHeight)
        }
        var left = square + 10
        let notices = !status.stringValue.isEmpty
        position.isHidden = notices || position.stringValue.isEmpty
        branch.isHidden = notices || branch.stringValue.isEmpty || w < 360
        status.isHidden = !notices
        if !branch.isHidden {
            let cap = max(0, right - left - min(135, measure(position))) / 2
            let width = min(measure(branch), w * 0.18, cap)
            branch.frame = centredLabel(branch, x: left, width: width, height: h)
            left += width + 9
        }
        position.frame = centredLabel(position, x: left, width: right - left - 6, height: h)
        status.frame = centredLabel(status, x: left, width: right - left - 6, height: h)
    }
}
