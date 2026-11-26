import AppKit

@MainActor
final class CollaborationButton: NSButton {
    var actionBody: (() -> Void)?

    init(_ title: String, action: (() -> Void)? = nil) {
        self.actionBody = action
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded
        target = self
        self.action = #selector(activate)
    }

    required init?(coder: NSCoder) { nil }

    @objc private func activate() { actionBody?() }
}

@MainActor
final class CollaborationLabel: NSTextField {
    enum Style { case body, heading, secondary, code }

    init(_ text: String, style: Style = .body, selectable: Bool = false) {
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
        switch style {
        case .body: font = .systemFont(ofSize: NSFont.systemFontSize)
        case .heading: font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        case .secondary:
            font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            textColor = .secondaryLabelColor
        case .code: font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        }
    }

    required init?(coder: NSCoder) { nil }

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

    init() {
        view.hasVerticalScroller = true
        view.autohidesScrollers = true
        view.drawsBackground = false
        let canvas = CollaborationCanvas()
        view.documentView = canvas
        canvas.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        canvas.addSubview(content)
        NSLayoutConstraint.activate([
            canvas.topAnchor.constraint(equalTo: view.contentView.topAnchor),
            canvas.leadingAnchor.constraint(equalTo: view.contentView.leadingAnchor),
            canvas.widthAnchor.constraint(equalTo: view.contentView.widthAnchor),
            content.topAnchor.constraint(equalTo: canvas.topAnchor, constant: 10),
            content.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -12),
            content.bottomAnchor.constraint(equalTo: canvas.bottomAnchor, constant: -10),
        ])
    }

    static func column() -> NSStackView {
        let result = NSStackView()
        result.orientation = .vertical
        result.alignment = .leading
        result.spacing = 8
        return result
    }

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

private final class CollaborationCanvas: NSView {
    override var isFlipped: Bool { true }
}
