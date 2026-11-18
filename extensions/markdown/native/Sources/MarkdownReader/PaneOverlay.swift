import AppKit
import MacPlatform

@MainActor
final class PaneOverlay: NSObject, NSWindowDelegate {
    let anchor = TerminalAnchor()
    let window: PaneWindow
    let content: PaneContentView
    private var placement: TerminalAnchor.Placement?
    private var activation: NSObjectProtocol?
    var onChange: (() -> Void)?
    var ready = true {
        didSet { if ready != oldValue { apply(anchor.status) } }
    }

    func start() {
        anchor.onChange = { [weak self] in self?.apply($0) }
        anchor.onMarker = { [weak self] in self?.onChange?() }
        anchor.start()
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.order() } }
    }

    func stop() {
        anchor.stop()
        window.orderOut(nil)
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
    }

    override init() {
        let bounds = NSRect(x: 0, y: 0, width: 640, height: 480)
        content = PaneContentView(frame: bounds)
        window = PaneWindow(contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.contentView = content
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = false
        window.hasShadow = false
        window.isMovable = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        super.init()
        window.delegate = self
    }

    /// Shows the window over the pane, with holes where other content of the terminal's window
    /// lies over the pane, or hides it.
    private func apply(_ status: TerminalAnchor.Status) {
        switch status {
        case .placed(let shown) where !shown.coveredEntirely:
            placement = shown
            if window.frame != shown.frame { window.setFrame(shown.frame, display: true) }
            let holes = shown.covers.map { $0.offsetBy(dx: -shown.frame.minX, dy: -shown.frame.minY) }
            if holes != content.holes {
                paneLog.notice("holes \(holes.count, privacy: .public): \(holes.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" }.joined(separator: "; "), privacy: .public)")
                content.holes = holes
            }
            if ready, !window.isVisible { window.orderFrontRegardless() }
            order()
        case .placed, .concealed, .searching, .untrusted:
            placement = nil
            if window.isVisible { window.orderOut(nil) }
        }
        onChange?()
    }

    /// Keeps the window above its host's window. While the host or the reader is the active
    /// application the window floats, so that activating the host never covers it. It sits at the
    /// normal level just above the host window when another application is active, so other
    /// applications cover both, and while another window of the host lies over the pane, so that
    /// window, such as a command palette, stays on top.
    private func order() {
        guard let placement, window.isVisible else { return }
        let active = NSWorkspace.shared.frontmostApplication?.processIdentifier
        if let cover = placement.coveredBy {
            if window.level != .normal { window.level = .normal }
            window.order(.below, relativeTo: Int(cover))
        } else if active == placement.host || active == ProcessInfo.processInfo.processIdentifier {
            if window.level != .floating { window.level = .floating }
            window.orderFrontRegardless()
        } else {
            if window.level != .normal { window.level = .normal }
            if let number = placement.window { window.order(.above, relativeTo: Int(number)) }
        }
    }

    /// Gives the keyboard back to the terminal. The pane is a non-activating panel, so the
    /// terminal application usually stays frontmost while the panel holds the key window;
    /// activating the terminal alone then changes nothing. Ordering the panel out and back in
    /// without making it key returns key status to the terminal's window.
    func releaseFocus() {
        guard let host = placement?.host, let application = NSRunningApplication(processIdentifier: host) else { return }
        if window.isKeyWindow, window.isVisible {
            window.orderOut(nil)
            window.orderFrontRegardless()
            order()
        }
        application.activate()
    }

    func windowWillClose(_ notification: Notification) {
        window.onClose?()
    }

}

/// The panel's content: the reader, with holes where other content of the terminal's window lies
/// over the pane. A hole is transparent, so the content below shows through it, and the panel
/// takes no clicks there.
final class PaneContentView: NSView {
    /// Rectangles in this view's coordinates.
    var holes: [CGRect] = [] {
        didSet { if holes != oldValue { updateMask() } }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = ReaderSurface.paperColour.cgColor
    }

    override func layout() {
        super.layout()
        updateMask()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        if holes.contains(where: { $0.contains(local) }) { return nil }
        return super.hitTest(point)
    }

    private func updateMask() {
        guard let layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        guard let path = TerminalAnchor.maskPath(bounds: bounds, holes: holes) else {
            layer.mask = nil
            return
        }
        let mask = (layer.mask as? CAShapeLayer) ?? CAShapeLayer()
        mask.frame = bounds
        mask.fillRule = .nonZero
        mask.path = path
        layer.mask = mask
    }
}

/// A non-activating panel whose first click reaches the page.
final class PaneWindow: NSPanel {
    var onCancel: (() -> Void)?
    var onClose: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, !isKeyWindow { makeKey() }
        super.sendEvent(event)
    }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    override func performClose(_ sender: Any?) {
        if let onClose { onClose() } else { close() }
    }

    /// A window without a close button disables Close in the menu; this one closes by its own
    /// control, Command-W and Command-Q.
    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        item.action == #selector(performClose(_:)) ? true : super.validateUserInterfaceItem(item)
    }
}
