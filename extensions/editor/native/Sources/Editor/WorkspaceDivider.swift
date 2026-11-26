import AppKit

/// A vertical line between two regions that a person drags sideways. The view is wider than
/// the line it draws, so the pointer does not need to hit a single point. It takes that width
/// in the layout and paints each side like its neighbour: a view that sets its own cursor,
/// such as a text view, would otherwise replace the resize cursor where the two overlap.
@MainActor
final class WorkspaceDivider: NSView {
    static let reachBefore: CGFloat = 4
    static let reachAfter: CGFloat = 4
    static let thickness = reachBefore + 1 + reachAfter

    /// Receives the wanted position of the line in the superview's coordinates.
    var onDrag: ((CGFloat) -> Void)?
    var onEnd: (() -> Void)?
    var onFit: (() -> Void)?
    /// Receives a signed distance for a resize without a pointer.
    var onStep: ((CGFloat) -> Void)?
    var canShrink = true { didSet { if canShrink != oldValue { window?.invalidateCursorRects(for: self) } } }
    var canGrow = true { didSet { if canGrow != oldValue { window?.invalidateCursorRects(for: self) } } }
    /// The surface colours of the regions before and after the line.
    var surfaces: (before: NSColor, after: NSColor) = (.clear, .clear) { didSet { needsDisplay = true } }

    private let label: String
    private var grab: CGFloat?
    private var hovering = false
    private var hover: Task<Void, Never>?
    private var lit = false { didSet { if lit != oldValue { needsDisplay = true } } }

    init(label: String) {
        self.label = label
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { nil }

    /// The position of the drawn line in the superview's coordinates.
    var position: CGFloat { frame.minX + Self.reachBefore }
    var isDragging: Bool { grab != nil }

    private var cursor: NSCursor {
        .columnResize(directions: canShrink && canGrow ? .all : canGrow ? .right : .left)
    }

    override func draw(_ dirtyRect: NSRect) {
        surfaces.before.setFill()
        NSRect(x: 0, y: 0, width: Self.reachBefore, height: bounds.height).fill(using: .sourceOver)
        surfaces.after.setFill()
        NSRect(x: Self.reachBefore, y: 0, width: 1 + Self.reachAfter, height: bounds.height).fill(using: .sourceOver)
        if lit {
            NSColor.controlAccentColor.setFill()
            NSRect(x: Self.reachBefore - 1, y: 0, width: 3, height: bounds.height).fill(using: .sourceOver)
        } else {
            NSColor.separatorColor.setFill()
            NSRect(x: Self.reachBefore, y: 0, width: 1, height: bounds.height).fill(using: .sourceOver)
        }
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: cursor) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        // The pane rarely holds the key window while the pointer approaches it.
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        cursor.set()
        hover?.cancel()
        // A pointer that only crosses the line does not light it.
        hover = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(140))
            guard !Task.isCancelled, let self, self.hovering else { return }
            self.lit = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        hover?.cancel()
        if grab == nil {
            lit = false
            NSCursor.arrow.set()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard event.clickCount < 2 else {
            grab = nil
            onFit?()
            return
        }
        guard let superview else { return }
        grab = superview.convert(event.locationInWindow, from: nil).x - position
        lit = true
        cursor.set()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let grab, let superview else { return }
        onDrag?(superview.convert(event.locationInWindow, from: nil).x - grab)
        cursor.set()
    }

    override func mouseUp(with event: NSEvent) {
        guard grab != nil else { return }
        grab = nil
        lit = hovering
        onEnd?()
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .splitter }
    override func accessibilityLabel() -> String? { label }
    override func accessibilityValue() -> Any? { Int(position) }
    override func accessibilityOrientation() -> NSAccessibilityOrientation { .vertical }
    override func accessibilityPerformIncrement() -> Bool { onStep?(16); return onStep != nil }
    override func accessibilityPerformDecrement() -> Bool { onStep?(-16); return onStep != nil }
}
