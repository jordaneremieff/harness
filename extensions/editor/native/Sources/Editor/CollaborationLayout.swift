import AppKit

@MainActor
func collaborationButton(_ title: String, symbol: String? = nil, run: (() -> Void)? = nil) -> WorkspaceButton {
    let button = WorkspaceButton(title, symbol: symbol)
    button.run = run
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 26).isActive = true
    return button
}

@MainActor
final class CollaborationLabel: NSTextField {
    enum Style { case body, heading, secondary, code }
    private let style: Style

    init(_ text: String, style: Style = .body, selectable: Bool = false) {
        self.style = style
        super.init(frame: .zero)
        stringValue = text
        isBordered = false
        isEditable = false
        isSelectable = selectable
        drawsBackground = false
        lineBreakMode = style == .code ? .byCharWrapping : .byWordWrapping
        cell?.usesSingleLineMode = false
        cell?.wraps = true
        cell?.isScrollable = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        applyLook()
    }

    required init?(coder: NSCoder) { nil }

    func applyLook() {
        let theme = WorkspaceStyle.theme
        switch style {
        case .body: font = WorkspaceStyle.interfaceFont(); textColor = theme.text
        case .heading: font = WorkspaceStyle.interfaceFont(1, weight: .semibold); textColor = theme.text
        case .secondary: font = WorkspaceStyle.interfaceFont(-1); textColor = theme.secondaryText
        case .code:
            font = .monospacedSystemFont(ofSize: WorkspaceStyle.settings.interfaceSize, weight: .regular)
            textColor = theme.syntax("string") ?? theme.text
        }
        invalidateIntrinsicContentSize()
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        if width > 0, width != preferredMaxLayoutWidth { preferredMaxLayoutWidth = width }
    }
}

@MainActor
struct CollaborationLayout {
    let view = NSScrollView()
    private let content = column()
    private let canvas = CollaborationCanvas()
    var onLook: (() -> Void)? { get { canvas.onLook } nonmutating set { canvas.onLook = newValue } }

    init() {
        view.hasVerticalScroller = true
        view.autohidesScrollers = true
        view.drawsBackground = false
        view.scrollerStyle = .overlay
        view.documentView = canvas
        canvas.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        canvas.addSubview(content)
        NSLayoutConstraint.activate([
            canvas.topAnchor.constraint(equalTo: view.contentView.topAnchor),
            canvas.leadingAnchor.constraint(equalTo: view.contentView.leadingAnchor),
            canvas.widthAnchor.constraint(equalTo: view.contentView.widthAnchor),
            content.topAnchor.constraint(equalTo: canvas.topAnchor, constant: 16),
            content.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 14),
            content.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -14),
            content.bottomAnchor.constraint(equalTo: canvas.bottomAnchor, constant: -16),
        ])
    }

    static func column() -> NSStackView {
        let result = NSStackView()
        result.orientation = .vertical
        result.alignment = .leading
        result.spacing = 10
        return result
    }

    func card(_ child: NSView) -> NSView { CollaborationCard(content: child) }

    static func spacer() -> NSView {
        let space = NSView()
        space.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return space
    }

    func row(_ items: [NSView]) -> NSStackView {
        let result = NSStackView(views: items)
        result.orientation = .horizontal
        result.alignment = .centerY
        result.spacing = 6
        return result
    }

    func add(_ child: NSView, to stack: NSStackView? = nil) {
        let parent = stack ?? content
        child.translatesAutoresizingMaskIntoConstraints = false
        parent.addArrangedSubview(child)
        if parent.orientation == .vertical {
            child.widthAnchor.constraint(equalTo: parent.widthAnchor).isActive = true
        }
    }

    func clear(_ stack: NSStackView? = nil) {
        let parent = stack ?? content
        for item in parent.arrangedSubviews {
            parent.removeArrangedSubview(item)
            item.removeFromSuperview()
        }
    }

    func scrollToTop() {
        view.contentView.scroll(to: .zero)
        view.reflectScrolledClipView(view.contentView)
    }

    func reveal(_ child: NSView) {
        view.layoutSubtreeIfNeeded()
        if let canvas = view.documentView {
            canvas.scrollToVisible(canvas.convert(child.bounds, from: child))
        }
    }
}

@MainActor
private final class CollaborationCanvas: NSView {
    var onLook: (() -> Void)?
    private var observer: NSObjectProtocol?
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        observer = NotificationCenter.default.addObserver(forName: .workspaceStyleDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.applyLook(to: self)
                self.onLook?()
            }
        }
    }
    required init?(coder: NSCoder) { nil }

    isolated deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    private func applyLook(to view: NSView) {
        (view as? CollaborationLabel)?.applyLook()
        view.needsDisplay = true
        view.subviews.forEach { applyLook(to: $0) }
    }
}

@MainActor
private final class CollaborationCard: NSView {
    init(content: NSView) {
        super.init(frame: .zero)
        addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
        ])
    }
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let theme = WorkspaceStyle.theme
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        theme.panel.setFill(); shape.fill()
        theme.panelBorder.setStroke(); shape.stroke()
    }
}
