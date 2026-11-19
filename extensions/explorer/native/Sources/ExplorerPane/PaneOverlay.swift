import AppKit
import OSLog

@MainActor
public final class PaneOverlay: NSObject, NSWindowDelegate {
    public let anchor: TerminalAnchor
    private var requestedAbove: CGFloat = 0
    private var growthHeight: CGFloat? = nil
    private var prediction: (from: CGRect, to: CGRect)?
    public private(set) var appliedAbove: CGFloat = 0
    public private(set) var appliedGrowth: CGFloat = 0
    /// The largest visible rectangle, from the pane bottom to the extension clamp.
    public private(set) var viewportLimit: CGSize?
    public private(set) var paneHeight: CGFloat = 0
    public let window: PaneWindow
    public let content: PaneContentView
    private var placement: TerminalAnchor.Placement?
    private var activation: NSObjectProtocol?
    public var onChange: (() -> Void)?
    public var ready = true {
        didSet { if ready != oldValue { apply(anchor.status) } }
    }

    public func start() {
        anchor.onChange = { [weak self] in self?.apply($0) }
        anchor.onMarker = { [weak self] in self?.onChange?() }
        anchor.start()
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.order() } }
    }

    public func stop() {
        anchor.stop()
        window.orderOut(nil)
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
    }

    private let paneLog: Logger

    public init(background: @escaping () -> NSColor, logger: Logger, tracksWindowContent: Bool = false, perf: Logger? = nil, eventDriven: Bool = false) {
        anchor = TerminalAnchor(tracksWindowContent: tracksWindowContent, perf: perf, eventDriven: eventDriven)
        paneLog = logger
        let bounds = NSRect(x: 0, y: 0, width: 640, height: 480)
        content = PaneContentView(frame: bounds, background: background)
        window = PaneWindow(contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.contentView = content
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = false
        window.hasShadow = false
        window.animationBehavior = .none
        window.isMovable = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        super.init()
        window.delegate = self
        window.perf = perf
    }

    @discardableResult
    public func extendAbove(_ points: CGFloat) -> CGFloat {
        requestedAbove = points
        apply(placement.map(TerminalAnchor.Status.placed) ?? .searching, notify: false)
        return appliedAbove
    }

    public func grow(to height: CGFloat?) {
        guard growthHeight != height else { return }
        growthHeight = height
        apply(placement.map(TerminalAnchor.Status.placed) ?? .searching, notify: false)
    }

    public func predictShrink(to height: CGFloat, from frame: CGRect) {
        guard placement?.frame == frame,
              placement?.covers.isEmpty == true, placement?.coveredBy == nil,
              height.isFinite, height > 0, height < frame.height else { return }
        prediction = (frame, CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: height))
        apply(placement.map(TerminalAnchor.Status.placed) ?? .searching, notify: false)
    }

    public func clearPrediction() {
        guard prediction != nil else { return }
        prediction = nil
        apply(placement.map(TerminalAnchor.Status.placed) ?? .searching, notify: false)
    }

    static func extensions(_ pane: CGRect, content: CGRect?, growthHeight: CGFloat?, menu: CGFloat) -> (growth: CGFloat, menu: CGFloat) {
        let growth = growthHeight.map { max(0, $0 - pane.height) } ?? 0
        let available = max(0, (content?.maxY ?? pane.maxY) - pane.maxY)
        let appliedGrowth = min(growth, available)
        return (appliedGrowth, min(menu, available - appliedGrowth))
    }

    /// AppKit places windows on whole points and expands a fractional frame outward. The terminal
    /// reports pane edges that move by a fraction of a point when its split layout changes, so an
    /// expanded frame would move the whole pane by a point. Each edge goes to its nearest point.
    static func snapped(_ rect: CGRect) -> CGRect {
        let minX = rect.minX.rounded(), minY = rect.minY.rounded()
        return CGRect(x: minX, y: minY, width: rect.maxX.rounded() - minX, height: rect.maxY.rounded() - minY)
    }

    static func extendedFrame(_ pane: CGRect, content: CGRect?, above: CGFloat) -> CGRect {
        guard let content, above.isFinite, above > 0 else { return pane }
        let height = min(above, max(0, content.maxY - pane.maxY))
        return CGRect(x: pane.minX, y: pane.minY, width: pane.width, height: pane.height + height)
    }

    /// Shows the window over the pane, with holes where other content of the terminal's window
    /// lies over the pane, or hides it.
    func apply(_ status: TerminalAnchor.Status, notify: Bool = true) {
        switch status {
        case .placed(let shown) where !shown.coveredEntirely:
            placement = shown
            if let prediction, prediction.from != shown.frame || !shown.covers.isEmpty || shown.coveredBy != nil {
                self.prediction = nil
            }
            let pane = Self.snapped(prediction?.to ?? shown.frame)
            let split = shown.contentFrame.map(Self.snapped)
            paneHeight = pane.height
            // The current pane can differ slightly from the AX split bounds.
            viewportLimit = CGSize(width: pane.width, height: max(Self.snapped(shown.frame).height, (split?.maxY ?? pane.maxY) - pane.minY))
            let offsets = Self.extensions(pane, content: split, growthHeight: growthHeight, menu: requestedAbove)
            appliedGrowth = offsets.growth
            appliedAbove = offsets.menu
            let frame = Self.extendedFrame(pane, content: split, above: offsets.growth + offsets.menu)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            content.prepareBase(width: frame.width, paneHeight: pane.height)
            if window.frame != frame { window.setFrame(frame, display: true) }
            CATransaction.commit()
            let holes = shown.covers.map { $0.offsetBy(dx: -pane.minX, dy: -pane.minY) }
            if holes != content.holes {
                paneLog.notice("holes \(holes.count, privacy: .public): \(holes.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" }.joined(separator: "; "), privacy: .public)")
                content.holes = holes
            }
            if ready, !window.isVisible { window.orderFrontRegardless() }
            order()
        case .placed, .concealed, .searching, .untrusted:
            placement = nil
            prediction = nil
            viewportLimit = nil
            paneHeight = 0
            appliedAbove = 0
            appliedGrowth = 0
            if window.isVisible { window.orderOut(nil) }
        }
        if notify { onChange?() }
    }

    /// Keeps the window above its host's window. While the host or this app is the active
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
    public func releaseFocus() {
        guard let host = placement?.host, let application = NSRunningApplication(processIdentifier: host) else { return }
        if window.isKeyWindow, window.isVisible {
            window.orderOut(nil)
            window.orderFrontRegardless()
            order()
        }
        application.activate()
    }

    public func windowWillClose(_ notification: Notification) {
        window.onClose?()
    }

}

/// The panel's content, with holes where other content of the terminal's window lies
/// over the pane. A hole is transparent, so the content below shows through it, and the panel
/// takes no clicks there.
public final class PaneContentView: NSView {
    /// Rectangles in this view's coordinates.
    var holes: [CGRect] = [] {
        didSet { if holes != oldValue { updateMask() } }
    }

    private let background: () -> NSColor
    private let base = CALayer()

    init(frame: NSRect, background: @escaping () -> NSColor) {
        self.background = background
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(base)
        prepareBase(width: frame.width, paneHeight: frame.height)
    }

    public required init?(coder: NSCoder) { nil }

    public override var wantsUpdateLayer: Bool { true }

    public override func updateLayer() {
        base.backgroundColor = background().cgColor
    }

    func prepareBase(width: CGFloat, paneHeight: CGFloat) {
        base.frame = CGRect(x: 0, y: 0, width: width, height: max(0, paneHeight))
    }

    public override func layout() {
        super.layout()
        updateMask()
    }

    public override func hitTest(_ point: NSPoint) -> NSView? {
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
public final class PaneWindow: NSPanel {
    public var perf: Logger?
    public var onCancel: (() -> Void)?
    public var onClose: (() -> Void)?

    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { true }

    public override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown {
            perf?.debug("click.mouseDown key=\(self.isKeyWindow)")
            if !isKeyWindow { makeKey() }
            perf?.debug("click.key key=\(self.isKeyWindow)")
        }
        super.sendEvent(event)
    }

    public override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        super.setFrame(frameRect, display: flag)
        perf?.debug("window.setFrame h=\(self.frame.height) bottom=\(self.frame.minY)")
    }

    public override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    public override func performClose(_ sender: Any?) {
        if let onClose { onClose() } else { close() }
    }

    /// A window without a close button disables Close in the menu; this one closes by its own
    /// control, Command-W and Command-Q.
    public override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        item.action == #selector(performClose(_:)) ? true : super.validateUserInterfaceItem(item)
    }
}
