import AppKit

/// A decision inside the pane. The escape key and the Cancel button make the same choice.
@MainActor
final class WorkspaceConfirmation: NSView {
    struct Choice {
        let title: String
        let role: Role

        enum Role { case normal, primary, destructive }
        init(_ title: String, role: Role = .normal) {
            self.title = title
            self.role = role
        }
    }

    private let heading: NSTextField
    private let detail: NSTextField
    private let buttons: [WorkspaceButton]
    private let choices: [Choice]
    private var finish: ((Int?) -> Void)?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(title: String, detail: String, choices: [Choice], finish: @escaping (Int?) -> Void) {
        heading = NSTextField(labelWithString: title)
        self.detail = NSTextField(wrappingLabelWithString: detail)
        self.choices = choices
        buttons = [WorkspaceButton("Cancel")] + choices.map { WorkspaceButton($0.title) }
        self.finish = finish
        super.init(frame: .zero)
        setAccessibilityRole(.group)
        setAccessibilityLabel(title)
        heading.lineBreakMode = .byTruncatingTail
        self.detail.maximumNumberOfLines = 4
        for child in [heading, self.detail] { addSubview(child) }
        for (index, button) in buttons.enumerated() {
            button.run = { [weak self] in self?.resolve(index > 0 ? index - 1 : nil) }
            addSubview(button)
        }
    }
    required init?(coder: NSCoder) { nil }

    func resolve(_ answer: Int?) {
        let reply = finish
        finish = nil
        reply?(answer)
    }

    override func cancelOperation(_ sender: Any?) { resolve(nil) }

    private let inset: CGFloat = 18
    private var titleHeight: CGFloat { WorkspaceStyle.settings.interfaceSize + 10 }
    private var buttonHeight: CGFloat { max(27, WorkspaceStyle.settings.interfaceSize + 13) }

    private func buttonWidths() -> [CGFloat] {
        let font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        return buttons.map { max(60, ceil(($0.title as NSString).size(withAttributes: [.font: font]).width) + 22) }
    }

    func fitting(in pane: NSSize) -> NSSize {
        let w = min(570, max(0, pane.width - 16))
        let contentWidth = max(1, w - 2 * inset)
        let rows: CGFloat = buttonWidths().reduce(0, +) + CGFloat(buttons.count - 1) * 6 <= contentWidth ? 1 : CGFloat(buttons.count)
        let font = WorkspaceStyle.interfaceFont()
        let line = ceil(font.ascender - font.descender + font.leading)
        let textHeight = (detail.stringValue as NSString).boundingRect(
            with: NSSize(width: max(1, contentWidth - 4), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font]
        ).height
        let body = min(line * 4, max(line, ceil(textHeight))) + 4
        let controls = rows * buttonHeight + (rows - 1) * 4
        return NSSize(width: w, height: 2 * inset + titleHeight + 5 + body + 8 + controls)
    }

    override func layout() {
        super.layout()
        let theme = WorkspaceStyle.theme
        heading.font = WorkspaceStyle.interfaceFont(2, weight: .semibold)
        heading.textColor = theme.text
        detail.font = WorkspaceStyle.interfaceFont(0)
        detail.textColor = theme.secondaryText
        let width = max(0, bounds.width - inset * 2)
        heading.frame = NSRect(x: inset, y: inset, width: width, height: titleHeight)
        let widths = buttonWidths()
        let singleRow = widths.reduce(0, +) + CGFloat(buttons.count - 1) * 6 <= width
        var x = bounds.maxX - inset
        var y = bounds.maxY - inset - buttonHeight
        for index in buttons.indices.reversed() {
            let button = buttons[index]
            let w = singleRow ? widths[index] : width
            button.frame = NSRect(x: x - w, y: y, width: w, height: buttonHeight)
            switch index == 0 ? .normal : choices[index - 1].role {
            case .normal: button.contentTintColor = theme.text
            case .primary: button.contentTintColor = theme.accent; button.isOn = true
            case .destructive: button.contentTintColor = theme.problem
            }
            if singleRow { x -= w + 6 } else if index > 0 { y -= buttonHeight + 4 }
        }
        let start = heading.frame.maxY + 5
        detail.frame = NSRect(x: inset, y: start, width: width, height: max(0, y - start - 8))
    }

    override func draw(_ dirtyRect: NSRect) {
        let theme = WorkspaceStyle.theme
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 11, yRadius: 11)
        theme.panel.setFill(); shape.fill()
        theme.panelBorder.setStroke(); shape.stroke()
    }
}
