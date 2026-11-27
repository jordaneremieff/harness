import AppKit

/// Places a request beside its anchor in flipped viewport coordinates. The caller owns the dock
/// used when a card would obscure the source or leave too little room for the composer.
func requestCardFrame(in bounds: NSRect, avoiding selection: NSRect, preferred: NSSize) -> NSRect? {
    let margin: CGFloat = 6
    let gap: CGFloat = 8
    let minimumWidth: CGFloat = 220
    let minimumHeight: CGFloat = 150
    guard bounds.width >= minimumWidth + 2 * margin, bounds.height >= minimumHeight + 2 * margin else { return nil }
    let area = bounds.insetBy(dx: margin, dy: margin)
    let width = min(335, preferred.width, area.width)
    let height = min(preferred.height, area.height)
    guard width >= minimumWidth, height >= minimumHeight else { return nil }

    let anchor = selection.intersection(bounds)
    guard !anchor.isEmpty else {
        return NSRect(x: area.maxX - width, y: area.minY, width: width, height: height)
    }

    let sideY = max(area.minY, min(anchor.minY, area.maxY - height))
    let rightX = max(area.minX, anchor.maxX + gap)
    let rightWidth = min(width, area.maxX - rightX)
    if rightWidth >= minimumWidth {
        return NSRect(x: rightX, y: sideY, width: rightWidth, height: height)
    }

    let columnX = max(area.minX, min(anchor.minX, area.maxX - width))
    let belowY = max(area.minY, anchor.maxY + gap)
    let belowHeight = min(height, area.maxY - belowY)
    let aboveEnd = min(area.maxY, anchor.minY - gap)
    let aboveHeight = min(height, aboveEnd - area.minY)
    if belowHeight >= minimumHeight, belowHeight >= aboveHeight {
        return NSRect(x: columnX, y: belowY, width: width, height: belowHeight)
    }
    if aboveHeight >= minimumHeight {
        return NSRect(x: columnX, y: aboveEnd - aboveHeight, width: width, height: aboveHeight)
    }

    let leftEnd = min(area.maxX, anchor.minX - gap)
    let leftWidth = min(width, leftEnd - area.minX)
    guard leftWidth >= minimumWidth else { return nil }
    return NSRect(x: leftEnd - leftWidth, y: sideY, width: leftWidth, height: height)
}

@MainActor
final class RequestCardView: NSView, NSTextViewDelegate {
    let input: NSTextView = RequestInput(frame: .zero)
    var onSend: (() -> Void)?
    var onClose: (() -> Void)?
    var onRecipient: ((String) -> Void)?
    var onOpenFile: ((String) -> Void)?

    private let heading = NSTextField(labelWithString: "")
    private let stateLabel = NSTextField(wrappingLabelWithString: "")
    private let joinHint = NSTextField(labelWithString: "Join this folder with /editor.")
    private let shortcut = NSTextField(labelWithString: "cmd+return to send")
    private let recipient = NSPopUpButton(frame: .zero, pullsDown: false)
    private let close = WorkspaceButton("", symbol: "xmark", help: "Close request (Escape)")
    private let send = WorkspaceButton("Send", help: "Send request (cmd+return)")
    private let history = NSScrollView()
    private let transcript = RequestTranscript(frame: .zero)
    private let composer = NSScrollView()
    private let inputWell = RequestInputWell()
    private let hint = NSTextField(labelWithString: "")

    private var recipients: [(id: String, label: String)] = []
    private var selected: String?
    private var pending = false
    private var messages: [(author: String, text: String)] = []
    private var files: [String] = []
    private var historyRows: [(author: CollaborationLabel, body: CollaborationLabel)] = []
    private var fileRows: [WorkspaceButton] = []
    private var transcriptWidth: CGFloat = -1
    private var transcriptHeight: CGFloat = 0
    private var followTranscript = false

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.borderWidth = 1
        layer?.masksToBounds = true

        for label in [heading, joinHint, shortcut, hint] { label.lineBreakMode = .byTruncatingTail }
        stateLabel.maximumNumberOfLines = 2
        stateLabel.cell?.truncatesLastVisibleLine = true
        recipient.bezelStyle = .accessoryBarAction
        recipient.cell?.usesSingleLineMode = true
        recipient.cell?.lineBreakMode = .byTruncatingTail
        recipient.setAccessibilityLabel("Request recipient")
        recipient.target = self
        recipient.action = #selector(selectRecipient)
        close.run = { [weak self] in self?.onClose?() }
        send.run = { [weak self] in self?.sendRequest() }
        send.isOn = true
        send.isEnabled = false
        joinHint.isHidden = true

        for scroll in [history, composer] {
            scroll.borderType = .noBorder
            scroll.drawsBackground = false
            scroll.hasVerticalScroller = true
            scroll.autohidesScrollers = true
            scroll.scrollerStyle = .overlay
        }
        history.documentView = transcript
        input.isRichText = false
        input.importsGraphics = false
        input.allowsUndo = true
        input.isVerticallyResizable = true
        input.isHorizontallyResizable = false
        input.autoresizingMask = [.width]
        input.textContainerInset = NSSize(width: 6, height: 5)
        input.textContainer?.widthTracksTextView = true
        input.setAccessibilityLabel("Request message")
        input.delegate = self
        if let requestInput = input as? RequestInput {
            requestInput.send = { [weak self] in self?.sendRequest() }
            requestInput.close = { [weak self] in self?.onClose?() }
        }
        composer.documentView = input
        for view in [heading, close, recipient, joinHint, stateLabel, history, inputWell, hint, composer, shortcut, send] { addSubview(view) }
        applyLook()
    }

    required init?(coder: NSCoder) { nil }

    func update(title: String, recipients: [(id: String, label: String)], selected: String?, state: String?,
                messages: [(author: String, text: String)], files: [String], pending: Bool) {
        if heading.stringValue != title {
            heading.stringValue = title
            heading.toolTip = title
        }
        if !self.recipients.elementsEqual(recipients, by: ==) || self.selected != selected {
            self.recipients = recipients
            self.selected = selected
            recipient.removeAllItems()
            recipient.addItem(withTitle: "Choose a session")
            recipient.menu?.autoenablesItems = false
            recipient.item(at: 0)?.isEnabled = false
            let byLabel = Dictionary(grouping: recipients, by: \.label)
            for entry in recipients {
                let title = (byLabel[entry.label]?.count ?? 0) > 1 ? "\(entry.label) · \(entry.id)" : entry.label
                let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                item.representedObject = entry.id
                item.toolTip = entry.id
                recipient.menu?.addItem(item)
            }
            showConfirmedRecipient()
        }
        self.pending = pending
        recipient.isEnabled = !pending && !recipients.isEmpty
        if stateLabel.stringValue != (state ?? "") {
            stateLabel.stringValue = state ?? ""
            stateLabel.toolTip = state
        }
        if !self.messages.elementsEqual(messages, by: ==) || self.files != files {
            updateTranscript(messages: messages, files: files)
        }
        hint.stringValue = messages.isEmpty ? "Ask about this selection…" : "Write a follow-up…"
        input.setAccessibilityLabel(hint.stringValue)
        refreshSend()
        needsLayout = true
    }

    func focusInput() { window?.makeFirstResponder(input) }

    func applyLook() {
        let theme = WorkspaceStyle.theme
        layer?.backgroundColor = theme.panel.cgColor
        layer?.borderColor = theme.panelBorder.cgColor
        inputWell.needsDisplay = true
        hint.font = WorkspaceStyle.interfaceFont()
        hint.textColor = theme.secondaryText
        heading.font = WorkspaceStyle.interfaceFont(0, weight: .semibold)
        heading.textColor = theme.text
        for label in [joinHint, stateLabel, shortcut] {
            label.font = WorkspaceStyle.interfaceFont(-1)
            label.textColor = theme.secondaryText
        }
        recipient.font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        recipient.contentTintColor = theme.text
        close.preferredTint = theme.secondaryText
        send.preferredTint = theme.accent
        input.font = WorkspaceStyle.interfaceFont()
        input.textColor = theme.text
        input.insertionPointColor = theme.caret
        input.selectedTextAttributes = [.backgroundColor: theme.selection]
        input.drawsBackground = false
        for row in historyRows { row.author.applyLook(); row.body.applyLook() }
        for row in fileRows { row.preferredTint = theme.accent }
        transcriptWidth = -1
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let pad: CGFloat = bounds.height < 135 ? 6 : 9
        let width = max(0, bounds.width - 2 * pad)
        let line = max(23, ceil(WorkspaceStyle.settings.interfaceSize + 7))
        let footerY = max(0, bounds.height - pad - line)
        let headerY = min(pad, footerY)
        let recipientY = headerY + line + 2
        let recipientWidth = min(width, max(108, recipient.fittingSize.width + 4))
        heading.frame = NSRect(x: pad + 2, y: headerY, width: max(0, width - line - 5), height: line)
        close.frame = NSRect(x: pad + width - line, y: headerY, width: line, height: line)
        recipient.frame = NSRect(x: pad, y: recipientY, width: recipientWidth, height: line)
        joinHint.frame = NSRect(x: pad + 2, y: recipientY, width: max(0, width - 2), height: line)
        let showRecipient = recipientY + line + 26 <= footerY
        recipient.isHidden = recipients.isEmpty || !showRecipient
        joinHint.isHidden = !recipients.isEmpty || !showRecipient
        let headerEnd = showRecipient ? recipientY + line + 5 : headerY + line + 3

        let sendWidth = min(width, max(59, send.fittingSize.width + 12))
        send.frame = NSRect(x: pad + width - sendWidth, y: footerY, width: sendWidth, height: line)
        shortcut.frame = NSRect(x: pad + 2, y: footerY + 2, width: max(0, width - sendWidth - 7), height: line - 2)
        let fieldBottom = max(0, footerY - 4)
        let available = max(0, fieldBottom - headerEnd)
        let hasHistory = !historyRows.isEmpty || !fileRows.isEmpty
        let statusHeight = stateLabel.stringValue.isEmpty ? 0 : textHeight(stateLabel, width: width - 4)
        let showStatus = statusHeight > 0 && available >= statusHeight + 31
        stateLabel.isHidden = !showStatus
        stateLabel.frame = NSRect(x: pad + 2, y: headerEnd, width: max(0, width - 4), height: showStatus ? statusHeight : 0)
        let historyY = headerEnd + (showStatus ? statusHeight + 3 : 0)
        let fieldBudget = max(0, fieldBottom - historyY)
        let fieldHeight = hasHistory ? min(fieldBudget, max(33, min(70, floor(bounds.height * 0.22)))) : fieldBudget
        let fieldY = fieldBottom - fieldHeight
        inputWell.frame = NSRect(x: pad, y: fieldY, width: width, height: fieldHeight)
        composer.frame = inputWell.frame.insetBy(dx: 1, dy: 1)
        hint.frame = NSRect(x: pad + 11, y: fieldY + 6, width: max(0, width - 20), height: min(18, fieldHeight))
        let minimumInputSize = NSSize(width: 0, height: composer.contentSize.height)
        if input.minSize != minimumInputSize { input.minSize = minimumInputSize }
        let inputSize = NSSize(width: composer.contentSize.width, height: max(input.frame.height, minimumInputSize.height))
        if input.frame.size != inputSize { input.setFrameSize(inputSize) }

        history.frame = NSRect(x: pad, y: historyY, width: width, height: max(0, fieldY - historyY - 5))
        let historyWidth = history.contentSize.width
        if transcriptWidth != historyWidth {
            transcriptWidth = historyWidth
            layoutTranscript(width: historyWidth)
        }
        let viewportHeight = history.contentSize.height
        let documentSize = NSSize(width: historyWidth, height: max(transcriptHeight, viewportHeight))
        if transcript.frame.size != documentSize { transcript.setFrameSize(documentSize) }
        if followTranscript, viewportHeight > 0 {
            history.contentView.scroll(to: NSPoint(x: 0, y: max(0, transcriptHeight - viewportHeight)))
            history.reflectScrolledClipView(history.contentView)
            followTranscript = false
        }
        history.isHidden = !hasHistory || history.frame.height == 0
    }

    func textDidChange(_ notification: Notification) { refreshSend() }

    @objc private func selectRecipient() {
        let id = recipient.selectedItem?.representedObject as? String
        showConfirmedRecipient()
        if !pending, let id, id != selected { onRecipient?(id) }
    }

    private func showConfirmedRecipient() {
        let position = recipients.firstIndex { $0.id == selected }.map { $0 + 1 } ?? 0
        if recipient.indexOfSelectedItem != position { recipient.selectItem(at: position) }
        recipient.toolTip = recipient.selectedItem?.title
    }

    private func refreshSend() {
        hint.isHidden = !input.string.isEmpty
        send.isEnabled = !pending && recipient.indexOfSelectedItem > 0 && !input.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendRequest() {
        refreshSend()
        if send.isEnabled && !input.hasMarkedText() { onSend?() }
    }

    private func updateTranscript(messages: [(author: String, text: String)], files: [String]) {
        followTranscript = followTranscript || self.messages.isEmpty || history.documentVisibleRect.maxY + 4 >= transcriptHeight
        self.messages = messages
        self.files = files
        for view in transcript.subviews { view.removeFromSuperview() }
        historyRows = messages.map { author, text in
            let name = CollaborationLabel(author, style: .heading)
            let body = CollaborationLabel(text, style: .body, selectable: true)
            body.lineBreakMode = .byWordWrapping
            transcript.addSubview(name)
            transcript.addSubview(body)
            return (name, body)
        }
        fileRows = files.map { path in
            let button = WorkspaceButton(path, symbol: "doc", help: "Open \(path)")
            button.alignment = .left
            button.cell?.usesSingleLineMode = true
            button.cell?.lineBreakMode = .byTruncatingMiddle
            button.preferredTint = WorkspaceStyle.theme.accent
            button.run = { [weak self] in self?.onOpenFile?(path) }
            transcript.addSubview(button)
            return button
        }
        transcriptWidth = -1
    }

    private func layoutTranscript(width: CGFloat) {
        var y: CGFloat = 0
        let width = max(0, width - 9)
        for row in historyRows {
            for label in [row.author, row.body] {
                let height = textHeight(label, width: width)
                label.frame = NSRect(x: 2, y: y, width: width, height: height)
                y += height
            }
            y += 7
        }
        for row in fileRows {
            let height = max(23, row.fittingSize.height)
            row.frame = NSRect(x: 2, y: y, width: width, height: height)
            y += height + 2
        }
        transcriptHeight = y
    }

    private func textHeight(_ label: NSTextField, width: CGFloat) -> CGFloat {
        let limit = NSSize(width: max(1, width), height: .greatestFiniteMagnitude)
        return ceil(label.sizeThatFits(limit).height)
    }
}

@MainActor
private final class RequestInputWell: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        let theme = WorkspaceStyle.theme
        theme.editor.setFill(); shape.fill()
        theme.panelBorder.setStroke(); shape.stroke()
    }
}

@MainActor
private final class RequestTranscript: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private final class RequestInput: NSTextView {
    var send: (() -> Void)?
    var close: (() -> Void)?
    private var hadMarkedText = false

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, sendIfRequested(event) { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if sendIfRequested(event) { return }
        hadMarkedText = hasMarkedText()
        defer { hadMarkedText = false }
        super.keyDown(with: event)
    }

    override func doCommand(by selector: Selector) {
        if selector == #selector(cancelOperation(_:)), !hadMarkedText, !hasMarkedText() {
            close?()
            return
        }
        super.doCommand(by: selector)
    }

    private func sendIfRequested(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .shift, .control, .option])
        guard modifiers == .command, !hasMarkedText(),
              event.charactersIgnoringModifiers == "\r" || event.charactersIgnoringModifiers == "\u{3}" else { return false }
        send?()
        return true
    }
}
