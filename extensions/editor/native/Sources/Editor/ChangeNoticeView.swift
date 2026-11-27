import AppKit

@MainActor
final class ChangeNoticeView: NSView {
    private let label = NSTextField(labelWithString: "")
    private let show = WorkspaceButton("Show", help: "Show the previous and current text")
    private let undo = WorkspaceButton("Undo", help: "Reverse this external change")
    private let older = WorkspaceButton("", symbol: "chevron.left", help: "Previous external change")
    private let close = WorkspaceButton("", symbol: "xmark", help: "Dismiss this change notice")
    private weak var editor: CodeEditor?
    private var review: DraftChangeReview?
    private let popover = NSPopover()

    override var isFlipped: Bool { true }

    override init(frame: NSRect = .zero) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("External change")
        label.lineBreakMode = .byTruncatingTail
        [label, show, undo, older, close].forEach { addSubview($0) }
        show.run = { [weak self] in
            guard let self, let review else { return }
            showDiff(review, from: show)
        }
        undo.run = { [weak self] in
            guard let self, let review else { return }
            editor?.undoReview(review)
        }
        older.run = { [weak self] in
            guard let self, let editor, let review, let index = editor.reviews.firstIndex(where: { $0 === review }),
                  !editor.reviews.isEmpty else { return }
            update(editor, select: (index + 1) % editor.reviews.count)
        }
        close.run = { [weak self] in
            guard let self, let review else { return }
            editor?.dismissReview(review)
        }
        popover.behavior = .transient
        popover.animates = false
        NotificationCenter.default.addObserver(self, selector: #selector(applyLook), name: .workspaceStyleDidChange, object: nil)
        applyLook()
    }
    required init?(coder: NSCoder) { nil }

    func update(_ editor: CodeEditor, select index: Int = 0) {
        self.editor = editor
        review = editor.reviews.indices.contains(index) ? editor.reviews[index] : nil
        older.isHidden = editor.reviews.count < 2
        guard let review else { popover.close(); isHidden = true; return }
        isHidden = false
        label.stringValue = "\(review.author) changed this file"
        if editor.reviews.count > 1 { label.stringValue += "  ·  \(index + 1)/\(editor.reviews.count)" }
        label.toolTip = label.stringValue
        undo.isEnabled = review.hunks.allSatisfy { $0.span.intact }
        undo.toolTip = undo.isEnabled ? "Reverse this external change" : "Later edits overlap this change"
        needsLayout = true
    }

    @objc private func applyLook() {
        label.font = WorkspaceStyle.interfaceFont(-1, weight: .medium)
        label.textColor = WorkspaceStyle.theme.text
        needsDisplay = true
    }

    override func draw(_ rect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        WorkspaceStyle.theme.panel.setFill(); shape.fill()
        WorkspaceStyle.theme.panelBorder.setStroke(); shape.stroke()
    }

    override func layout() {
        super.layout()
        let w = bounds.width
        close.frame = NSRect(x: w - 26, y: 4, width: 22, height: 22)
        undo.frame = NSRect(x: w - 74, y: 4, width: 46, height: 22)
        show.frame = NSRect(x: w - 123, y: 4, width: 48, height: 22)
        older.frame = NSRect(x: 3, y: 4, width: 21, height: 22)
        let x: CGFloat = older.isHidden ? 10 : 27
        label.frame = NSRect(x: x, y: 7, width: max(0, w - x - 126), height: 16)
    }

    func showLatest(in editor: CodeEditor, fallback: NSView) {
        guard let latest = editor.reviews.first else { return }
        update(editor)
        layoutSubtreeIfNeeded()
        showDiff(latest, from: frame.isEmpty ? fallback : show)
    }

    private func showDiff(_ review: DraftChangeReview, from anchor: NSView) {
        guard let editor else { return }
        if popover.isShown { popover.close() }
        if let first = review.hunks.first(where: { $0.span.intact }) { editor.textView.revealSourceRange(first.span.range) }
        let content = ChangeComparisonView(review: review)
        let controller = NSViewController()
        controller.view = content
        popover.contentViewController = controller
        popover.contentSize = NSSize(width: min(490, max(280, window?.frame.width ?? 490)), height: 320)
        let edge: NSRectEdge = anchor.isFlipped ? .minY : .maxY
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: edge)
    }
}

@MainActor
private final class ChangeComparisonView: NSView {
    override var isFlipped: Bool { true }
    private let page = CollaborationLayout()

    init(review: DraftChangeReview) {
        super.init(frame: .zero)
        addSubview(page.view)
        page.add(CollaborationLabel("Change by \(review.author)", style: .heading))
        for (index, excerpt) in review.excerpts.enumerated() {
            if review.excerpts.count > 1 { page.add(CollaborationLabel("Part \(index + 1)", style: .heading)) }
            addText("Before", snippet: excerpt.before, colour: WorkspaceStyle.theme.deleted)
            addText("After", snippet: excerpt.after, colour: WorkspaceStyle.theme.added)
        }
        if review.excerpts.count == ReviewExcerpt.limit {
            page.add(CollaborationLabel("See the highlighted text for the rest of this change.", style: .secondary))
        }
    }
    required init?(coder: NSCoder) { nil }
    override func layout() { super.layout(); page.view.frame = bounds }

    private func addText(_ caption: String, snippet: ReviewExcerpt.Snippet, colour: NSColor) {
        page.add(CollaborationLabel(caption, style: .secondary))
        let label = NSTextField(wrappingLabelWithString: "")
        label.isSelectable = true
        let text = snippet.text.isEmpty ? "(empty)" : snippet.text
        let rich = NSMutableAttributedString(string: text, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: WorkspaceStyle.theme.text])
        for range in snippet.marked { rich.addAttribute(.backgroundColor, value: colour.withAlphaComponent(0.29), range: range) }
        label.attributedStringValue = rich
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        page.add(page.card(label))
    }
}

struct ReviewExcerpt {
    struct Snippet {
        let text: String
        let marked: [NSRange]
    }
    static let limit = 24
    let before: Snippet
    let after: Snippet

    static func make(before: NSString, after: NSString, locations: [(NSRange, NSRange)]) -> [Self] {
        var groups: [[(NSRange, NSRange)]] = []
        for pair in locations {
            if let previous = groups.last?.last,
               max(pair.0.location - NSMaxRange(previous.0), pair.1.location - NSMaxRange(previous.1)) < 44 {
                groups[groups.count - 1].append(pair)
            } else if groups.count < limit { groups.append([pair]) }
            else { break }
        }
        return groups.map { Self(before: snippet(before, $0.map(\.0)), after: snippet(after, $0.map(\.1))) }
    }

    private static func snippet(_ text: NSString, _ ranges: [NSRange]) -> Snippet {
        guard let first = ranges.first, let last = ranges.last else { return Snippet(text: "", marked: []) }
        func scalarBoundary(_ offset: Int) -> Int {
            guard offset > 0, offset < text.length, (0xdc00...0xdfff).contains(text.character(at: offset)) else { return offset }
            return offset - 1
        }
        var low = first.location, high = min(NSMaxRange(last), first.location + 1600)
        while low > max(0, first.location - 64), text.character(at: low - 1) != 10 { low -= 1 }
        while high < min(text.length, min(NSMaxRange(last) + 64, first.location + 1600)), text.character(at: high) != 10 { high += 1 }
        low = scalarBoundary(low); high = scalarBoundary(high)
        let lead = low > 0 && text.character(at: low - 1) != 10 ? "…" : ""
        let tail = high < text.length && text.character(at: high) != 10 ? "…" : ""
        func word(_ offset: Int) -> Bool {
            offset >= low && offset < high && Unicode.Scalar(text.character(at: offset)).map {
                CharacterSet.alphanumerics.contains($0) || $0 == "_"
            } == true
        }
        let marks = ranges.compactMap { range -> NSRange? in
            var start = range.location, end = min(high, NSMaxRange(range))
            guard start < high || (start == high && range.length == 0) else { return nil }
            if start == end, word(start - 1) { start -= 1 }
            if start == end, word(end) { end += 1 }
            if word(start) { while word(start - 1) { start -= 1 } }
            if word(end - 1) { while word(end) { end += 1 } }
            return end > start ? NSRange(location: start - low + lead.utf16.count, length: end - start) : nil
        }
        return Snippet(text: lead + text.substring(with: NSRange(location: low, length: high - low)) + tail, marked: marks)
    }
}
