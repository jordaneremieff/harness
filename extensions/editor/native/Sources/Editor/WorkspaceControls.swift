import AppKit

/// A borderless button that shows the pointer and its on state with a tint behind its symbol.
@MainActor
final class WorkspaceButton: NSButton {
    var run: (() -> Void)?
    var context: (() -> NSMenu)?
    var preferredTint: NSColor? { didSet { refreshTint() } }
    /// A control that stays on, such as the button of the sidebar panel on show.
    var isOn = false {
        didSet {
            guard isOn != oldValue else { return }
            refreshTint()
        }
    }
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    private var pointerArea: NSTrackingArea?

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
        styleChanged()
        NotificationCenter.default.addObserver(self, selector: #selector(styleChanged), name: .workspaceStyleDidChange, object: nil)
    }
    required init?(coder: NSCoder) { nil }
    @objc private func pressed() { run?() }

    @objc private func styleChanged() {
        font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        refreshTint()
    }

    private func refreshTint() {
        contentTintColor = preferredTint ?? (isOn ? WorkspaceStyle.theme.text : WorkspaceStyle.theme.secondaryText)
        needsDisplay = true
    }
    override func menu(for event: NSEvent) -> NSMenu? { context?() ?? super.menu(for: event) }

    override func draw(_ dirtyRect: NSRect) {
        if isEnabled, isOn || hovering || isHighlighted {
            (isOn || isHighlighted ? WorkspaceStyle.engaged : WorkspaceStyle.hover).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 5, yRadius: 5).fill()
        }
        super.draw(dirtyRect)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea) }
        // The pane rarely holds the key window while the pointer approaches it.
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        pointerArea = area
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func viewDidHide() { super.viewDidHide(); hovering = false }
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

/// A flat surface with an optional line along one edge.
@MainActor
final class WorkspaceRegion: NSView {
    enum Edge { case top, bottom }
    /// The role of a surface; its colour follows the theme.
    enum Surface { case chrome, content, bar, panel }
    var surface: Surface { didSet { needsDisplay = true } }
    var colour: NSColor {
        switch surface {
        case .chrome: WorkspaceStyle.chrome
        case .content: WorkspaceStyle.content
        case .bar: WorkspaceStyle.bar
        case .panel: WorkspaceStyle.theme.panel
        }
    }
    var line: Edge? { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }

    init(_ surface: Surface = .chrome, line: Edge? = nil) {
        self.surface = surface
        self.line = line
        super.init(frame: .zero)
        NotificationCenter.default.addObserver(self, selector: #selector(styleChanged), name: .workspaceStyleDidChange, object: nil)
    }
    required init?(coder: NSCoder) { nil }
    @objc private func styleChanged() { needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        colour.setFill()
        bounds.fill()
        guard let line else { return }
        WorkspaceStyle.line.setFill()
        NSRect(x: 0, y: line == .top ? 0 : bounds.height - 1, width: bounds.width, height: 1).fill(using: .sourceOver)
    }
}
