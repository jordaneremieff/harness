import AppKit

@MainActor
final class WorkspaceButton: NSButton {
    var run: (() -> Void)?
    var context: (() -> NSMenu)?

    init(_ title: String, symbol: String? = nil, help: String? = nil) {
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .accessoryBarAction
        isBordered = false
        if let symbol {
            image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            imagePosition = title.isEmpty ? .imageOnly : .imageLeading
        }
        toolTip = help
        setAccessibilityLabel(help ?? title)
        target = self
        action = #selector(pressed)
    }
    required init?(coder: NSCoder) { nil }
    @objc private func pressed() { run?() }
    override func menu(for event: NSEvent) -> NSMenu? { context?() ?? super.menu(for: event) }
}

@MainActor
final class WorkspaceChoice: NSMenuItem {
    private let run: () -> Void
    init(_ title: String, _ run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(choose), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError("Unsupported archive") }
    @objc private func choose() { run() }
}

@MainActor
private final class WorkspaceRegion: NSView {
    var colour = NSColor.controlBackgroundColor
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) { colour.setFill(); bounds.intersection(dirtyRect).fill() }
}

struct WorkspaceTab: Equatable {
    let key: String
    let label: String
    let detail: String
    var symbol: String
}

@MainActor
final class WorkspaceChrome: NSView {
    var onCommand: ((String) -> Void)?
    var onSelect: ((String) -> Void)?
    var onTabMenu: ((String) -> NSMenu)?
    var onMenu: (() -> NSMenu)?
    var onNote: ((String, String) -> Void)?
    var onPath: ((String) -> Void)?
    var onCancelPath: (() -> Void)?
    /// Returns the sidebar width that shows its content in full, when the content has one.
    var onFitSidebar: (() -> CGFloat?)?
    private static let sidebarKey = "sidebarWidth"
    private let defaults: UserDefaults
    private let sidebarEdge = WorkspaceDivider(label: "Sidebar width")
    /// The width a person gave the sidebar. The layout limits it while the pane is narrow.
    private var chosenSidebar: CGFloat?
    private let bar = WorkspaceRegion()
    private let tabStrip = NSScrollView()
    private let tabRow = WorkspaceRegion()
    private let side = WorkspaceRegion()
    private let stage = WorkspaceRegion()
    private let banner = WorkspaceRegion()
    private let foot = WorkspaceRegion()
    private let pathRow = WorkspaceRegion()
    private let folder: NSTextField
    private let status = NSTextField(labelWithString: "")
    private let details = NSTextField(labelWithString: "")
    private let wrap = WorkspaceButton("", symbol: "text.word.spacing", help: "Wrap lines")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let files = WorkspaceButton("", symbol: "sidebar.left", help: "Project files (cmd+O)")
    private let search = WorkspaceButton("", symbol: "magnifyingglass", help: "Project search (cmd+P)")
    private let add = WorkspaceButton("", symbol: "plus", help: "New scratch (cmd+N)")
    private let save = WorkspaceButton("", symbol: "square.and.arrow.down", help: "Save file (cmd+S)")
    private let notes = WorkspaceButton("", symbol: "bubble.left.and.bubble.right", help: "Conversations (cmd+option+T)")
    private let more = WorkspaceButton("", symbol: "ellipsis.circle", help: "Workspace actions")
    private let hideMessage = WorkspaceButton("", symbol: "xmark", help: "Dismiss message")
    private let messageAction = WorkspaceButton("")
    private let pathField = NSTextField()
    private let pathSubmit = WorkspaceButton("")
    private let pathCancel = WorkspaceButton("", symbol: "xmark", help: "Cancel path entry")
    private var tabButtons: [WorkspaceButton] = []
    private var tabItems: [WorkspaceTab] = []
    private var highlighted: String?
    private var accessory: NSView?
    private var currentPage: NSView?
    private var showPath = false
    private var showMessage = false
    var expandedPanel = false { didSet { needsLayout = true } }
    var showsSideBySide: Bool { WorkspaceLayout.fitsBeside(pane: bounds.width) && !expandedPanel }
    var sidebarWidth: CGFloat { side.isHidden ? 0 : sidebarEdge.isHidden ? side.frame.width : sidebarEdge.position }
    var hasPathText: Bool { showPath && !pathField.stringValue.isEmpty }
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
        tabStrip.drawsBackground = false
        tabStrip.horizontalScrollElasticity = .allowed
        tabStrip.hasHorizontalScroller = true
        tabStrip.autohidesScrollers = true
        tabStrip.scrollerStyle = .overlay
        tabStrip.documentView = tabRow
        tabRow.colour = .windowBackgroundColor
        bar.colour = .windowBackgroundColor
        foot.colour = .windowBackgroundColor
        banner.colour = .controlBackgroundColor
        // The stage shows through pages without a background of their own, and beside the source.
        stage.colour = .textBackgroundColor
        for v in [bar, tabStrip, stage, side, sidebarEdge, pathRow, banner, foot] { addSubview(v) }
        sidebarEdge.onDrag = { [weak self] position in self?.resizeSidebar(to: position) }
        sidebarEdge.onEnd = { [weak self] in self?.keepSidebar() }
        sidebarEdge.onFit = { [weak self] in self?.fitSidebar() }
        sidebarEdge.onStep = { [weak self] distance in
            guard let self else { return }
            resizeSidebar(to: sidebarWidth + distance)
            keepSidebar()
        }
        for v in [files, folder, search, add, save, notes, more] { bar.addSubview(v) }
        for v in [pathField, pathSubmit, pathCancel] { pathRow.addSubview(v) }
        for v in [message, hideMessage, messageAction] { banner.addSubview(v) }
        for v in [status, details, wrap] { foot.addSubview(v) }
        wrap.run = { [weak self] in self?.onCommand?("wrap") }
        wrap.context = { [weak self] in self?.noteMenu("setting", "line-wrap") ?? NSMenu() }
        for (control, name) in [(files,"files"),(search,"search"),(add,"scratch"),(save,"save"),(notes,"notes")] {
            control.run = { [weak self] in self?.onCommand?(name) }
        }
        pathSubmit.run = { [weak self] in self?.submitPath() }
        pathCancel.run = { [weak self] in self?.onCancelPath?() }
        hideMessage.run = { [weak self] in self?.clearMessage() }
        more.run = { [weak self] in
            guard let self, let menu = onMenu?() else { return }
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: more.bounds.minY - 4), in: more)
        }
        files.context = { [weak self] in self?.noteMenu("folder", "") ?? NSMenu() }
        more.context = { [weak self] in self?.noteMenu("pane", "workspace") ?? NSMenu() }
    }
    required init?(coder: NSCoder) { nil }
    private func noteMenu(_ kind: String, _ key: String) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(WorkspaceChoice("Note on this \(kind)…") { [weak self] in self?.onNote?(kind, key) })
        return menu
    }
    override func menu(for event: NSEvent) -> NSMenu? { noteMenu("pane", "workspace") }

    private func resizeSidebar(to position: CGFloat) {
        let width = min(max(WorkspaceLayout.minimumSidebar, position.rounded()), WorkspaceLayout.maximumSidebar(pane: bounds.width))
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
        chosenSidebar = onFitSidebar?().map { max(WorkspaceLayout.minimumSidebar, $0.rounded(.up)) }
        keepSidebar()
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection([.command, .shift, .control, .option])
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        var action: String?
        if mods == .command {
            action = ["s":"save", "n":"scratch", "o":"files", "p":"search"][key]
            if key == "f", window?.firstResponder is CodeTextView { action = "find" }
        } else if mods == [.command,.shift] {
            action = ["s":"saveAs", "n":"newFile", "f":"searchContents", "[":"previous", "{":"previous", "]":"next", "}":"next"][key]
        } else if mods == [.command,.option] && key == "t" { action = "notes" }
        if let action { onCommand?(action); return true }
        return super.performKeyEquivalent(with: event)
    }
    func setStatus(_ text: String, _ detail: String, canSave: Bool) {
        if status.stringValue != text { status.stringValue = text; status.toolTip = text }
        if details.stringValue != detail { details.stringValue = detail; needsLayout = true }
        save.isEnabled = canSave
    }
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
    func inputPath(action: String) {
        pathSubmit.title = action
        pathSubmit.setAccessibilityLabel(action)
        if !showPath { pathField.stringValue = "" }
        showPath = true
        needsLayout = true
        layoutSubtreeIfNeeded()
        window?.makeFirstResponder(pathField)
    }
    func hidePath() { showPath = false; pathField.stringValue = ""; needsLayout = true }
    @objc private func submitPath() {
        let path = pathField.stringValue
        guard !path.isEmpty else { window?.makeFirstResponder(pathField); return }
        onPath?(path)
    }
    func setWrap(_ enabled: Bool) {
        wrap.contentTintColor = enabled ? .controlAccentColor : .secondaryLabelColor
        wrap.setAccessibilityValue(enabled ? "On" : "Off")
    }
    func setContent(page: NSView?, panel: NSView?) {
        if currentPage !== page {
            currentPage?.removeFromSuperview()
            currentPage = page
            if let page { stage.addSubview(page) }
        }
        if accessory !== panel {
            accessory?.removeFromSuperview()
            accessory = panel
            if let panel { side.addSubview(panel) }
        }
        needsLayout = true
        layoutSubtreeIfNeeded()
    }
    func setTabs(_ items: [WorkspaceTab], selected: String?, reveal: Bool = false) {
        let changed = items != tabItems
        guard changed || selected != highlighted || reveal else { return }
        if changed {
            let old = Dictionary(uniqueKeysWithValues: zip(tabItems.map(\.key), tabButtons))
            tabButtons = items.map { item in
                let button = old[item.key] ?? WorkspaceButton("")
                button.title = item.label
                button.toolTip = item.detail
                button.setAccessibilityLabel(item.detail)
                button.image = NSImage(systemSymbolName: item.symbol, accessibilityDescription: nil)?
                    .withSymbolConfiguration(.init(pointSize: 10, weight: .regular))
                button.imagePosition = .imageLeading
                button.font = .systemFont(ofSize: 12)
                button.cell?.lineBreakMode = .byTruncatingTail
                button.run = { [weak self] in self?.onSelect?(item.key) }
                button.context = { [weak self] in self?.onTabMenu?(item.key) ?? NSMenu() }
                if button.superview == nil { tabRow.addSubview(button) }
                return button
            }
            let keys = Set(items.map(\.key))
            for (key, button) in old where !keys.contains(key) { button.removeFromSuperview() }
            tabItems = items
        }
        highlighted = selected
        var x: CGFloat = 5
        for (item, button) in zip(items,tabButtons) {
            let selected = item.key == highlighted
            button.bezelStyle = .accessoryBarAction
            button.isBordered = selected
            button.contentTintColor = selected ? .labelColor : .secondaryLabelColor
            button.setAccessibilityValue(selected ? "Selected" : "")
            let w = min(180, max(68, button.fittingSize.width + 14))
            button.frame = NSRect(x: x, y: 3, width: w, height: 24)
            x += w + 3
        }
        tabRow.frame = NSRect(x: 0, y: 0, width: x, height: 30)
        needsLayout = true
        if reveal, let i = items.firstIndex(where: { $0.key == selected }) { tabButtons[i].scrollToVisible(tabButtons[i].bounds) }
    }
    override func layout() {
        super.layout()
        let w = bounds.width, h = bounds.height
        let toolHeight: CGFloat = 36, footHeight: CGFloat = 23
        let tabHeight: CGFloat = tabItems.isEmpty ? 0 : 31
        let slot = min(32, max(22, (w - 10) / 7))
        bar.frame = NSRect(x: 0, y: 0, width: w, height: toolHeight)
        files.frame = NSRect(x: 4, y: 4, width: slot, height: 28)
        var right = w - 4
        for item in [more, notes, save, add, search] { right -= slot; item.frame = NSRect(x: right, y: 4, width: slot, height: 28) }
        folder.frame = NSRect(x: 8 + slot, y: 9, width: max(0, right - slot - 14), height: 18)
        tabStrip.frame = NSRect(x: 0, y: toolHeight, width: w, height: tabHeight)
        tabStrip.isHidden = tabHeight == 0
        var top = toolHeight + tabHeight
        pathRow.isHidden = !showPath
        if showPath {
            pathRow.frame = NSRect(x: 0, y: top, width: w, height: 38)
            pathCancel.frame = NSRect(x: w - 29, y: 5, width: 24, height: 26)
            pathSubmit.frame = NSRect(x: w - 106, y: 5, width: 75, height: 26)
            pathField.frame = NSRect(x: 9, y: 6, width: max(10,w - 123), height: 24)
            top += 38
        }
        banner.isHidden = !showMessage
        if showMessage {
            let buttonWidth: CGFloat = messageAction.isHidden ? 0 : min(120, messageAction.fittingSize.width + 14)
            let mw = max(32,w - buttonWidth - 45)
            let textH = min(52,max(18, message.cell?.cellSize(forBounds: NSRect(x: 0,y: 0,width: mw,height: 75)).height ?? 18))
            let bh = max(32,textH + 12)
            banner.frame = NSRect(x: 0,y: top,width: w,height: bh)
            message.frame = NSRect(x: 10,y: (bh - textH)/2,width: mw,height: textH)
            messageAction.frame = NSRect(x: w - 31 - buttonWidth,y: (bh - 25)/2,width: buttonWidth,height: 25)
            hideMessage.frame = NSRect(x: w - 29,y: (bh - 24)/2,width: 24,height: 24)
            top += bh
        }
        let height = max(0,h - top - footHeight)
        let beside = accessory != nil && showsSideBySide
        let sideWidth: CGFloat = accessory == nil ? 0 : beside ? WorkspaceLayout.sidebar(chosen: chosenSidebar, pane: w) : w
        side.isHidden = accessory == nil
        // The sidebar width runs to the line; the edge takes its reach from both regions.
        side.frame = NSRect(x: 0, y: top, width: beside ? sideWidth - WorkspaceDivider.reachBefore : sideWidth, height: height)
        stage.isHidden = accessory != nil && !beside
        let inset = beside ? sideWidth + 1 + WorkspaceDivider.reachAfter : 0
        stage.frame = NSRect(x: inset, y: top, width: max(0,w - inset), height: height)
        sidebarEdge.isHidden = !beside
        sidebarEdge.frame = NSRect(x: sideWidth - WorkspaceDivider.reachBefore, y: top, width: WorkspaceDivider.thickness, height: height)
        sidebarEdge.surfaces = (side.colour, stage.colour)
        sidebarEdge.canShrink = sideWidth > WorkspaceLayout.minimumSidebar
        sidebarEdge.canGrow = sideWidth < WorkspaceLayout.maximumSidebar(pane: w)
        currentPage?.frame = stage.bounds
        accessory?.frame = side.bounds
        foot.frame = NSRect(x: 0,y: h - footHeight,width: w,height: footHeight)
        let rightW = min(w * 0.55, details.intrinsicContentSize.width)
        wrap.frame = NSRect(x: w - 28,y: 1,width: 22,height: 21)
        details.frame = NSRect(x: w - rightW - 35,y: 4,width: rightW,height: 16)
        status.frame = NSRect(x: 10,y: 4,width: max(0,w - rightW - 53),height: 16)
    }
}
