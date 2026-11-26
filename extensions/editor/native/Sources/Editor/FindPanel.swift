import AppKit

@MainActor
final class FindPanelState {
    private var query = ""
    private var replacement = ""
    private var options = FindOptions()
    private weak var panel: FindBar?
    private weak var editor: CodeEditor?
    private var sourceSnapshot: String?
    private var result = FindMatches()
    private var selection: [NSRange] = []
    private var current: Int?
    private var work: Task<FindMatches, Never>?
    private var job: Task<Void, Never>?
    private var pendingMove: Bool?
    private var stale = true
    private var epoch: UInt = 0

    func show(in screen: WorkspaceScreen, replace: Bool) {
        guard let editor = screen.currentEditor else { return }
        screen.revealEditorForFind()
        if let existing = panel, self.editor === editor, existing.showsReplace == replace {
            existing.focus(existing.findField)
            return
        }
        if let panel { screen.chrome.dismissOverlay(panel) }
        self.editor = editor
        selection = editor.findSelections
        if query.isEmpty { query = selectedText(in: editor) ?? "" }
        let bar = FindBar(replace: replace, query: query, replacement: replacement, options: options)
        panel = bar
        bar.onEdit = { [weak self, weak bar] in
            guard let self, let bar else { return }
            let updatedQuery = bar.findValue
            let updatedReplacement = bar.replaceValue
            if query == updatedQuery && replacement == updatedReplacement { return }
            query = updatedQuery; replacement = updatedReplacement
            scan()
        }
        bar.onOptions = { [weak self] next in
            guard let self else { return }
            if next.inSelection && !options.inSelection { selection = self.editor?.findSelections ?? [] }
            var before = options
            before.wrap = next.wrap; before.highlight = next.highlight
            options = next
            if before == next { render() } else { scan() }
        }
        bar.onMove = { [weak self, weak screen] backwards in if let screen { self?.move(in: screen, backwards: backwards) } }
        bar.onFindAll = { [weak self] in self?.selectAll() }
        bar.onReplace = { [weak self] in self?.replace(all: $0) }
        bar.onClose = { [weak self, weak screen, weak bar] in
            guard let self, let screen, let bar else { return }
            screen.chrome.dismissOverlay(bar)
            if screen.chrome.window?.isKeyWindow == true { screen.currentEditor?.focus() }
            panel = nil
        }
        bar.onDetach = { [weak self, weak bar] in
            guard let self, panel === bar else { return }
            detach()
        }
        bar.onCharacterEdit = { [weak self] edited, delta in
            guard let self else { return }
            sourceSnapshot = nil
            if options.inSelection { selection = FindMatches.adjust(selection, edited: edited, delta: delta) }
            scan()
        }
        bar.onStyle = { [weak self] in self?.render() }
        bar.observe(editor.textView.textStorage)
        screen.chrome.presentOverlay(bar, placement: .bottom) { size in
            NSSize(width: size.width, height: replace ? 124 : 86)
        }
        bar.focus(bar.findField)
        scan()
    }

    func move(in screen: WorkspaceScreen, backwards: Bool) {
        guard let active = screen.currentEditor else { return }
        if query.isEmpty { show(in: screen, replace: false); return }
        if panel?.superview == nil {
            editor = active
            sourceSnapshot = nil
            selection = active.findSelections
            pendingMove = backwards
            scan()
        } else if active !== editor {
            show(in: screen, replace: panel?.showsReplace == true)
            pendingMove = backwards
        } else if stale { pendingMove = backwards }
        else { move(backwards: backwards) }
    }

    func activeEditorChanged(_ next: CodeEditor?) {
        guard let panel, next !== editor else { return }
        editor?.markFound([], current: nil)
        editor = next
        sourceSnapshot = nil
        selection = next?.findSelections ?? []
        panel.observe(next?.textView.textStorage)
        if next != nil { scan() }
        else {
            work?.cancel(); job?.cancel(); pendingMove = nil
            stale = true
            panel.describe("Open a file to find text", hasMatches: false, replaceAll: false)
        }
    }

    func useSelection(in screen: WorkspaceScreen, replace: Bool) {
        guard let active = screen.currentEditor, let value = selectedText(in: active) else { return }
        if replace { replacement = value } else { query = value; options.regularExpression = false }
        if let panel, editor === active {
            panel.setInput(query, replacement: replacement, options: options)
            scan()
        }
    }

    private func selectedText(in editor: CodeEditor) -> String? {
        guard let range = editor.findSelections.first, range.length > 0, range.length <= 2_048,
              NSMaxRange(range) <= editor.findText.length else { return nil }
        return editor.findText.substring(with: range)
    }

    private func detach() {
        epoch &+= 1
        work?.cancel(); job?.cancel(); pendingMove = nil
        editor?.markFound([], current: nil)
        panel = nil; editor = nil; current = nil; sourceSnapshot = nil
    }

    private func scan() {
        guard let editor else { return }
        work?.cancel(); job?.cancel()
        epoch &+= 1
        stale = true
        current = nil
        if query.isEmpty {
            result = FindMatches(); stale = false; pendingMove = nil
            render()
            return
        }
        panel?.describe("Finding…", hasMatches: false, replaceAll: false)
        let expected = epoch
        let source = sourceSnapshot ?? String(editor.findText)
        sourceSnapshot = source
        let query = query, options = options, selection = selection, replacement = replacement
        let task = Task.detached(priority: .userInitiated) {
            FindMatches.search(query, in: source, options: options, selection: selection, replacement: replacement)
        }
        work = task
        job = Task { [weak self, weak editor] in
            let found = await task.value
            guard let self, let editor, self.editor === editor, !Task.isCancelled, expected == epoch else { return }
            result = found; stale = false
            let selected = editor.findSelections.first
            current = found.matches.firstIndex { $0.range == selected }
            if let pendingMove {
                self.pendingMove = nil
                move(backwards: pendingMove)
            } else { render() }
        }
    }

    private func move(backwards: Bool) {
        guard !stale, let editor else { return }
        let selected = editor.findSelections.first ?? NSRange(location: 0, length: 0)
        if let current, result.matches[current].range == selected {
            let next = current + (backwards ? -1 : 1)
            if result.matches.indices.contains(next) { self.current = next }
            else if options.wrap { self.current = backwards ? result.matches.indices.last : result.matches.indices.first }
            else { return }
        } else {
            current = result.nearest(to: backwards ? selected.location : NSMaxRange(selected), backwards: backwards, wrap: options.wrap)
        }
        if let range = current.map({ result.matches[$0].range }) { editor.selectFound([range], reveal: range) }
        render()
    }

    private func selectAll() {
        guard !stale, !result.limited, let editor else { return }
        editor.selectFound(result.matches.map(\.range), reveal: result.matches.first?.range)
        if editor.textView.window?.isKeyWindow == true { editor.focus() }
    }

    private func replace(all: Bool) {
        guard !stale, let editor, !result.matches.isEmpty else { return }
        let matches: [FindMatches.Match]
        if all {
            guard !result.limited else { return }
            matches = result.matches
        } else {
            guard let index = current ?? result.nearest(to: editor.findSelections.first?.location ?? 0, backwards: false, wrap: options.wrap) else { return }
            matches = [result.matches[index]]
        }
        if editor.replaceFound(matches.map(\.range), with: matches.map(\.replacement)) { scan() }
    }

    private func render() {
        guard !stale else { return }
        let count = result.matches.count
        let total = count.formatted() + (result.limited ? "+" : "")
        let countText = current.map { "\(($0 + 1).formatted()) of \(total)" } ?? "\(total) matches"
        let message = result.problem ?? (query.isEmpty ? "Enter text to find" : countText)
        panel?.describe(message, hasMatches: count > 0, replaceAll: count > 0 && !result.limited, problem: result.problem != nil)
        guard panel != nil else { return }
        let active = current.map { result.matches[$0].range }
        if options.highlight {
            var marks = result.matches.prefix(1_500).map(\.range)
            if let active, marks.last.map({ $0.location < active.location }) == true { marks.append(active) }
            editor?.markFound(marks, current: active)
        } else { editor?.markFound([], current: nil) }
    }
}

@MainActor
private final class FindBar: QuickSurface, NSTextFieldDelegate {
    let findField = NSTextField()
    let replaceField = NSTextField()
    let showsReplace: Bool
    var onEdit: (() -> Void)?
    var onOptions: ((FindOptions) -> Void)?
    var onMove: ((Bool) -> Void)?
    var onFindAll: (() -> Void)?
    var onReplace: ((Bool) -> Void)?
    var onClose: (() -> Void)?
    var onCharacterEdit: ((NSRange, Int) -> Void)?
    private weak var observedStorage: NSTextStorage?
    var onStyle: (() -> Void)?
    private let counter = QuickSurface.label("")
    private let title = QuickSurface.label("Find")
    private let replaceLabel = QuickSurface.label("Replace")
    private let regex = FindButton(".*", hint: "Regular expression", toggle: true)
    private let matchCase = FindButton("Aa", hint: "Match case", toggle: true)
    private let word = FindButton("Word", hint: "Whole word", toggle: true)
    private let selected = FindButton("Selection", hint: "In selection", toggle: true)
    private let wrap = FindButton("Wrap", hint: "Wrap around", toggle: true)
    private let highlight = FindButton("Highlight", hint: "Highlight matches", toggle: true)
    private let previous = FindButton("↑", hint: "Previous match")
    private let next = FindButton("↓", hint: "Next match")
    private let all = FindButton("Find All", hint: "Select all matches")
    private let close = FindButton("×", hint: "Close Find")
    private let replace = FindButton("Replace", hint: "Replace current match")
    private let replaceAll = FindButton("Replace All", hint: "Replace all matches")
    private var hasProblem = false

    init(replace: Bool, query: String, replacement: String, options: FindOptions) {
        showsReplace = replace
        super.init(frame: .zero)
        shadow = nil
        layer?.cornerRadius = 0
        [title, findField, counter, previous, next, all, close, regex, matchCase, word, selected, wrap, highlight].forEach { addSubview($0) }
        if replace { [replaceLabel, replaceField, self.replace, replaceAll].forEach { addSubview($0) } }
        for (field, name) in [(findField, "Find in this file"), (replaceField, "Replace with")] {
            field.placeholderString = name
            field.setAccessibilityLabel(name)
            field.delegate = self
            field.isBezeled = false; field.isBordered = true
            field.focusRingType = .none
        }
        counter.alignment = .right
        setInput(query, replacement: replacement, options: options)
        for toggle in [regex, matchCase, word, selected, wrap, highlight] { toggle.run = { [weak self] in self?.changeOptions() } }
        previous.run = { [weak self] in self?.onMove?(true) }
        next.run = { [weak self] in self?.onMove?(false) }
        all.run = { [weak self] in self?.onFindAll?() }
        close.run = { [weak self] in self?.onClose?() }
        self.replace.run = { [weak self] in self?.onReplace?(false) }
        replaceAll.run = { [weak self] in self?.onReplace?(true) }
        applyPanelStyle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var findValue: String { findField.currentEditor()?.string ?? findField.stringValue }
    var replaceValue: String { replaceField.currentEditor()?.string ?? replaceField.stringValue }

    func setInput(_ query: String, replacement: String, options: FindOptions) {
        findField.stringValue = query; replaceField.stringValue = replacement
        if let field = findField.currentEditor(), field.string != query { field.string = query }
        if let field = replaceField.currentEditor(), field.string != replacement { field.string = replacement }
        for (button, enabled) in [(regex, options.regularExpression), (matchCase, options.caseSensitive), (word, options.wholeWord),
                                  (selected, options.inSelection), (wrap, options.wrap), (highlight, options.highlight)] {
            button.state = enabled ? .on : .off
            button.needsDisplay = true
        }
    }

    private func changeOptions() {
        onOptions?(FindOptions(regularExpression: regex.state == .on, caseSensitive: matchCase.state == .on, wholeWord: word.state == .on,
                               inSelection: selected.state == .on, wrap: wrap.state == .on, highlight: highlight.state == .on))
    }

    func describe(_ message: String, hasMatches: Bool, replaceAll enabled: Bool, problem: Bool = false) {
        counter.stringValue = message
        counter.toolTip = message
        hasProblem = problem
        counter.textColor = problem ? WorkspaceStyle.theme.problem : WorkspaceStyle.theme.secondaryText
        [previous, next, replace].forEach { $0.isEnabled = hasMatches; $0.needsDisplay = true }
        [all, replaceAll].forEach { $0.isEnabled = enabled; $0.needsDisplay = true }
    }

    override func applyPanelStyle() {
        super.applyPanelStyle()
        let theme = WorkspaceStyle.theme
        for field in [findField, replaceField] {
            field.font = WorkspaceStyle.interfaceFont(1)
            field.backgroundColor = theme.editor; field.textColor = theme.text
            if let text = field.currentEditor() as? NSTextView { text.insertionPointColor = theme.caret; text.textColor = theme.text }
        }
        for label in [title, replaceLabel] { label.font = WorkspaceStyle.interfaceFont(weight: .semibold); label.textColor = theme.secondaryText }
        counter.font = WorkspaceStyle.interfaceFont(-1)
        counter.textColor = hasProblem ? theme.problem : theme.secondaryText
        subviews.forEach { $0.needsDisplay = true }
        needsLayout = true
        onStyle?()
    }

    override func layout() {
        super.layout()
        let w = bounds.width
        let left: CGFloat = 14, indent: CGFloat = 77
        let inputHeight: CGFloat = 25
        let counterWidth = min(175.0, w * 0.26)
        title.frame = NSRect(x: left, y: 12, width: indent - left - 8, height: 23)
        let actionsWidth: CGFloat = 178
        findField.frame = NSRect(x: indent, y: 9, width: max(0, w - indent - actionsWidth - counterWidth - 12), height: inputHeight)
        counter.frame = NSRect(x: w - actionsWidth - counterWidth - 12, y: 13, width: max(0, counterWidth), height: 22)
        previous.frame = NSRect(x: w - 176, y: 8, width: 30, height: 27)
        next.frame = NSRect(x: w - 141, y: 8, width: 30, height: 27)
        all.frame = NSRect(x: w - 106, y: 8, width: 64, height: 27)
        close.frame = NSRect(x: w - 34, y: 8, width: 27, height: 27)
        let optionY: CGFloat = showsReplace ? 85 : 45
        var x = indent
        for (button, width) in [(regex, 33.0), (matchCase, 36.0), (word, 55.0), (selected, 75.0), (wrap, 51.0), (highlight, 71.0)] {
            button.frame = NSRect(x: x, y: optionY, width: width, height: 27)
            x += width + 5
        }
        if showsReplace {
            replaceLabel.frame = NSRect(x: left, y: 51, width: indent - left - 6, height: 21)
            replaceField.frame = NSRect(x: indent, y: 47, width: max(0, w - indent - 206), height: inputHeight)
            replace.frame = NSRect(x: w - 197, y: 46, width: 80, height: 27)
            replaceAll.frame = NSRect(x: w - 110, y: 46, width: 96, height: 27)
        }
    }

    func observe(_ storage: NSTextStorage?) {
        if let observedStorage {
            NotificationCenter.default.removeObserver(self, name: NSTextStorage.didProcessEditingNotification, object: observedStorage)
        }
        observedStorage = storage
        if let storage { NotificationCenter.default.addObserver(self, selector: #selector(edited(_:)), name: NSTextStorage.didProcessEditingNotification, object: storage) }
    }

    @objc private func edited(_ notice: Notification) {
        guard let storage = notice.object as? NSTextStorage, storage.editedMask.contains(.editedCharacters) else { return }
        onCharacterEdit?(storage.editedRange, storage.changeInLength)
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField, (field.currentEditor() as? NSTextView)?.hasMarkedText() != true else { return }
        onEdit?()
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if textView.hasMarkedText() { return false }
        switch selector {
        case #selector(NSResponder.cancelOperation(_:)): onClose?()
        case #selector(NSResponder.insertNewline(_:)):
            if control === replaceField { onReplace?(false) } else { onMove?(false) }
        default: return false
        }
        return true
    }
}

@MainActor
private final class FindButton: NSButton {
    let toggle: Bool
    var run: (() -> Void)?

    init(_ title: String, hint: String, toggle: Bool = false) {
        self.toggle = toggle
        super.init(frame: .zero)
        self.title = title
        setButtonType(toggle ? .toggle : .momentaryPushIn)
        isBordered = false
        focusRingType = .none
        toolTip = hint; setAccessibilityLabel(hint)
        target = self; action = #selector(pressed)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func pressed() { needsDisplay = true; run?() }

    override func draw(_ dirtyRect: NSRect) {
        let theme = WorkspaceStyle.theme
        let on = toggle && state == .on
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 5, yRadius: 5)
        (on ? theme.chosen : cell?.isHighlighted == true ? theme.engaged : theme.editor).setFill(); path.fill()
        (on ? theme.accent.withAlphaComponent(0.6) : theme.panelBorder).setStroke(); path.stroke()
        let text = NSAttributedString(string: title, attributes: [.font: WorkspaceStyle.interfaceFont(-1, weight: .medium),
                                                                 .foregroundColor: !isEnabled ? theme.mutedText : on ? theme.accent : theme.text])
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}
