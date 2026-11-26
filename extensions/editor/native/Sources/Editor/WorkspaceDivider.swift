import AppKit

/// The reach on both sides of the line belongs to the divider. Adjacent text views would
/// otherwise replace its resize cursor where the hit regions overlap.
@MainActor
final class WorkspaceDivider: NSView {
    enum Axis { case columns, rows }
    nonisolated static let reachBefore: CGFloat = 4
    nonisolated static let reachAfter: CGFloat = 4
    nonisolated static let thickness = reachBefore + 1 + reachAfter

    var onDrag: ((CGFloat) -> Void)?
    var onEnd: (() -> Void)?
    var onFit: (() -> Void)?
    var onStep: ((CGFloat) -> Void)?
    var canShrink = true { didSet { if canShrink != oldValue { window?.invalidateCursorRects(for: self) } } }
    var canGrow = true { didSet { if canGrow != oldValue { window?.invalidateCursorRects(for: self) } } }
    var surfaces: (before: NSColor, after: NSColor) = (.clear, .clear) { didSet { needsDisplay = true } }
    /// Continues a strip across a column divider. Grid dividers continue both strips.
    var stripBands: [NSRect] = [] { didSet { if stripBands != oldValue { needsDisplay = true } } }

    private let label: String
    private let axis: Axis
    private var grab: CGFloat?
    private var pointerArea: NSTrackingArea?
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }

    init(label: String, axis: Axis = .columns) {
        self.label = label
        self.axis = axis
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }
    private var lineOffset: CGFloat { min(Self.reachBefore, (axis == .columns ? bounds.width : bounds.height) / 2) }
    private func axisPosition(_ point: NSPoint) -> CGFloat { axis == .columns ? point.x : point.y }
    /// The position of the line in the superview's coordinates.
    var position: CGFloat { axisPosition(frame.origin) + lineOffset }

    private var cursor: NSCursor {
        guard canShrink || canGrow else { return .arrow }
        if axis == .columns {
            return .columnResize(directions: canShrink && canGrow ? .all : canGrow ? .right : .left)
        }
        return .rowResize(directions: canShrink && canGrow ? .all : canGrow ? .down : .up)
    }

    private func rect(along start: CGFloat, length: CGFloat) -> NSRect {
        if axis == .columns { return NSRect(x: start, y: 0, width: length, height: bounds.height) }
        return NSRect(x: 0, y: start, width: bounds.width, height: length)
    }

    override func draw(_ dirtyRect: NSRect) {
        let extent = axis == .columns ? bounds.width : bounds.height
        let line = lineOffset
        surfaces.before.setFill()
        rect(along: 0, length: line).fill(using: .sourceOver)
        surfaces.after.setFill()
        rect(along: line, length: max(0, extent - line)).fill(using: .sourceOver)
        for band in stripBands {
            WorkspaceStyle.chrome.setFill()
            band.fill()
            WorkspaceStyle.line.setFill()
            NSRect(x: band.minX, y: band.maxY - 1, width: band.width, height: 1).fill()
        }
        let lit = grab != nil || (hovering && (canShrink || canGrow))
        (lit ? WorkspaceStyle.theme.accent : WorkspaceStyle.line).setFill()
        let start = lit ? max(0, line - 1) : line
        rect(along: start, length: min(extent - start, lit ? 3 : 1)).fill(using: .sourceOver)
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: cursor) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        pointerArea = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; cursor.set() }
    override func mouseExited(with event: NSEvent) {
        hovering = false
        if grab == nil { NSCursor.arrow.set() }
    }
    override func viewDidHide() { super.viewDidHide(); hovering = false }

    override func mouseDown(with event: NSEvent) {
        guard event.clickCount < 2 else { grab = nil; onFit?(); return }
        guard canGrow || canShrink, let superview else { return }
        grab = axisPosition(superview.convert(event.locationInWindow, from: nil)) - position
        needsDisplay = true
        cursor.set()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let grab, let superview else { return }
        onDrag?(axisPosition(superview.convert(event.locationInWindow, from: nil)) - grab)
        cursor.set()
    }

    override func mouseUp(with event: NSEvent) {
        guard grab != nil else { return }
        grab = nil
        needsDisplay = true
        onEnd?()
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .splitter }
    override func accessibilityLabel() -> String? { label }
    override func accessibilityValue() -> Any? { Int(position) }
    override func accessibilityOrientation() -> NSAccessibilityOrientation { axis == .columns ? .vertical : .horizontal }
    override func accessibilityPerformIncrement() -> Bool {
        guard canGrow, let onStep else { return false }
        onStep(16)
        return true
    }
    override func accessibilityPerformDecrement() -> Bool {
        guard canShrink, let onStep else { return false }
        onStep(-16)
        return true
    }
}
