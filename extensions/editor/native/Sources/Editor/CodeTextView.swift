import AppKit

@MainActor
final class CodeScrollView: NSScrollView {
    let gutter = CodeGutterView()
    let minimap = CodeMinimapView()
    let caretOverlay = CodeCaretOverlay()
    private var marginViewport: NSRect?

    func bindSourceMargins(to text: CodeTextView) {
        gutter.editor = text
        minimap.editor = text
        gutter.clipsToBounds = true
        minimap.clipsToBounds = true
        caretOverlay.observe(text)
        addSubview(caretOverlay, positioned: .above, relativeTo: contentView)
        addSubview(gutter)
        addSubview(minimap)
        text.caretOverlay = caretOverlay
        text.activeLineChanged = { [weak self] old, next in
            self?.gutter.invalidateActiveLine(from: old, to: next)
        }
        minimap.onScroll = { [weak self, weak text] line in
            guard let self, let text else { return }
            let location = text.visibleOffset(text.lineRange(line).location)
            guard let caret = text.caretRect(at: location) else { return }
            var point = contentView.bounds.origin
            point.y = max(0, caret.minY - contentView.bounds.height / 2)
            contentView.scroll(to: point)
            reflectScrolledClipView(contentView)
        }
        text.adornmentChanged = { [weak self] in
            self?.gutter.needsDisplay = true
            self?.minimap.needsDisplay = true
        }
        tile()
    }

    override func tile() {
        super.tile()
        guard let text = gutter.editor else { return }
        let frame = contentView.frame
        let settings = text.sourceSettings
        let digits = String(text.lineCount).count
        let gutterWidth: CGFloat = settings.lineNumbers || settings.foldButtons || settings.gitGutter
            ? (settings.gitGutter ? 13 : 4) + (settings.lineNumbers ? CGFloat(max(2, digits)) * 8 + 5 : 0) + (settings.foldButtons ? 14 : 3) : 0
        let mapWidth: CGFloat = settings.minimap && frame.width - gutterWidth >= 680 ? min(120, max(85, floor(frame.width * 0.10))) : 0
        var viewport = frame
        viewport.origin.x += gutterWidth
        viewport.size.width = max(1, viewport.width - gutterWidth - mapWidth)
        if contentView.frame != viewport { contentView.frame = viewport }
        gutter.isHidden = gutterWidth == 0
        gutter.frame = NSRect(x: frame.minX, y: frame.minY, width: gutterWidth, height: frame.height)
        minimap.isHidden = mapWidth == 0
        minimap.frame = NSRect(x: viewport.maxX, y: frame.minY, width: mapWidth, height: frame.height)
        text.updateWrapWidth(viewport.width)
        caretOverlay.frame = viewport
        caretOverlay.synchronize(restart: false)
    }

    func setChanges(_ changes: [Int: CodeChangeKind]) {
        gutter.changes = changes
        let stride = max(1, (gutter.editor?.lineCount ?? 1) / 600)
        minimap.changes = Dictionary(changes.sorted { $0.key < $1.key }.map { ($0.key / stride * stride, $0.value) },
            uniquingKeysWith: { first, later in first == .modified ? later : first })
        gutter.needsDisplay = true
        minimap.needsDisplay = true
    }

    override func reflectScrolledClipView(_ clip: NSClipView) {
        super.reflectScrolledClipView(clip)
        guard clip === contentView, marginViewport != clip.bounds else { return }
        marginViewport = clip.bounds
        gutter.needsDisplay = true
        minimap.needsDisplay = true
        caretOverlay.synchronize(restart: false)
    }

    override func layout() {
        super.layout()
        guard let text = documentView as? CodeTextView else { return }
        let viewport = contentView.bounds.size
        if text.minSize != viewport { text.minSize = viewport }
        let frame = text.frame.size
        let size = NSSize(width: max(frame.width, viewport.width), height: max(frame.height, viewport.height))
        if size != frame { text.setFrameSize(size) }
        text.updateWrapWidth(viewport.width)
    }
}

@MainActor
final class CodeClipView: NSClipView {
    override var documentRect: NSRect {
        var rect = super.documentRect
        if let source = documentView as? CodeTextView, source.sourceSettings.scrollPastEnd {
            rect.size.height += bounds.height / 2
        }
        return rect
    }
}

@MainActor
final class CodeTextView: NSTextView, @preconcurrency NSLayoutManagerDelegate, @preconcurrency NSTextStorageDelegate {
    var noteTarget: ((NSRange) -> NSMenuItem?)?
    var onFind: (() -> Void)?
    let syntax = CodeSyntax()
    var sourceSettings = EditorSettings()
    var sourceTheme = WorkspaceStyle.theme
    var multiSelection: [TextSelection]?
    var directedSelection: TextSelection?
    var settingSelections = false
    var occurrenceWord: String?
    var selectionChanged: (() -> Void)?
    var adornmentChanged: (() -> Void)?
    var activeLineChanged: ((Int, Int) -> Void)?
    weak var caretOverlay: CodeCaretOverlay?
    var cachedSelectionPaint: CodeSelectionPaint?
    let selectionCharacters = SelectionCharacterCount()
    var lineIndex: TextLineIndex?
    var folds: [TextFold] = []
    var foundRanges: [NSRange] = []
    var foundCurrent: NSRange?
    var mapFindLines: [Int] = []
    var indentation = (spaces: true, width: 4) {
        didSet { if oldValue.width != indentation.width { columnCheckpoint = nil } }
    }
    var layoutSpacing: CGFloat = 0
    var spaceWidth: CGFloat = 8
    var columnCheckpoint: (lineStart: Int, offset: Int, column: Int)?
    private var drag: (anchor: Int, previous: [TextSelection], column: Bool)?

    func attachSource() {
        lineIndex = TextLineIndex(source)
        textStorage?.delegate = self
        layoutManager?.delegate = self
        if let storage = textStorage { syntax.engine.attach(to: storage) }
        syntax.engine.onViewportSyntax = { [weak self] in self?.invalidateSyntax() }
    }

    override func draw(_ dirtyRect: NSRect) {
        prepareVisibleText()
        super.draw(dirtyRect)
        drawSourceForeground(dirtyRect)
    }

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        drawSourceBackground(rect)
    }

    override var shouldDrawInsertionPoint: Bool { false }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result {
            DispatchQueue.main.async { [weak self] in self?.caretOverlay?.synchronize(restart: true) }
            if multiSelection != nil { setNeedsDisplay(visibleRect) }
        }
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result {
            DispatchQueue.main.async { [weak self] in self?.caretOverlay?.synchronize(restart: false) }
            if multiSelection != nil { setNeedsDisplay(visibleRect) }
        }
        return result
    }

    func invalidateAdornment() {
        cachedSelectionPaint = nil
        setNeedsDisplay(visibleRect)
        adornmentChanged?()
        caretOverlay?.synchronize(restart: true)
    }

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        let previous = selectionPaint()
        if !settingSelections {
            multiSelection = nil
            directedSelection = nil
            occurrenceWord = nil
        }
        let clamped = folds.isEmpty ? ranges : ranges.map { value in
            let range = value.rangeValue
            let first = visibleOffset(range.location, forward: affinity == .downstream)
            let end = visibleOffset(NSMaxRange(range), forward: affinity == .downstream)
            return NSValue(range: NSRange(location: min(first, end), length: abs(end - first)))
        }
        super.setSelectedRanges(clamped, affinity: affinity, stillSelecting: stillSelecting)
        updateSelectionPaint(from: previous)
        caretOverlay?.synchronize(restart: true)
        if stillSelecting && !settingSelections { selectionChanged?() }
    }

    func updateWrapWidth(_ viewport: CGFloat) {
        guard let container = textContainer, container.widthTracksTextView else { return }
        let inset = 2 * textContainerInset.width
        let available = max(1, viewport - inset)
        let preferred = sourceSettings.wrapColumn > 0 ? CGFloat(sourceSettings.wrapColumn) * spaceWidth + 2 * container.lineFragmentPadding : available
        let width = min(available, preferred)
        if container.containerSize.width != width {
            container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        }
    }

    func setSyntax(for doc: String) {
        syntax.setFile(doc)
        invalidateSyntax()
    }

    func invalidateSyntax() {
        syntax.invalidate()
        cachedSelectionPaint = nil
        needsDisplay = true
    }

    func prepareVisibleText() {
        guard let manager = layoutManager, let container = textContainer, let storage = textStorage else { return }
        let origin = textContainerOrigin
        let rect = visibleRect.offsetBy(dx: -origin.x, dy: -origin.y)
        syntax.highlight(rect: rect, in: container, layout: manager, source: storage.mutableString, visibleParts: visibleParts)
    }

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        guard let value = (insertString as? String) ?? (insertString as? NSAttributedString)?.string else {
            super.insertText(insertString, replacementRange: replacementRange)
            return
        }
        let text = Self.unixNewlines(value)
        if replacementRange.location == NSNotFound, !hasMarkedText() {
            if multiSelection != nil || isSmartInput(text) {
                let edits = sourceSelections.map { typingEdit(text, replacing: $0) }
                if edit(edits) { return }
            }
        } else { clearExtraSelections() }
        super.insertText(text, replacementRange: replacementRange)
    }

    override func paste(_ sender: Any?) { paste(from: .general, reindent: false) }

    func paste(from board: NSPasteboard, reindent: Bool) {
        guard let value = board.string(forType: .string) else { return }
        let text = Self.unixNewlines(value)
        let selections = sourceSelections
        var parts = text.components(separatedBy: "\n")
        if parts.count == selections.count + 1, parts.last == "" { parts.removeLast() }
        let distribute = selections.count > 1 && parts.count == selections.count
        _ = edit(selections.enumerated().map { index, range in
            let insertion = distribute ? parts[index] : text
            return .caret(range, reindent ? indentedPaste(insertion, at: range.location) : insertion)
        })
    }

    override func copy(_ sender: Any?) { copy(to: .general, cut: false) }
    override func cut(_ sender: Any?) { copy(to: .general, cut: true) }

    func copy(to board: NSPasteboard, cut: Bool) {
        let ranges = sourceSelections
        let wholeLine = ranges.allSatisfy { $0.length == 0 }
        guard !wholeLine || sourceSettings.copyLineWithEmptySelection else { return }
        let targets = wholeLine ? Array(Set(ranges.map { line(at: $0.location) })).sorted().map { lineRange($0) } : ranges
        let values = targets.map { range -> String in
            let text = source.substring(with: range)
            return wholeLine && !text.hasSuffix("\n") ? text + "\n" : text
        }
        board.clearContents()
        board.setString(values.joined(separator: wholeLine ? "" : "\n"), forType: .string)
        if cut { _ = edit(targets.map { .caret($0, "") }) }
    }

    override func doCommand(by selector: Selector) {
        switch NSStringFromSelector(selector) {
        case "cancelOperation:":
            if multiSelection != nil { clearExtraSelections(); return }
        case "deleteBackward:", "deleteForward:":
            let back = NSStringFromSelector(selector) == "deleteBackward:"
            if multiSelection != nil || (back && sourceSettings.autoClosePairs && selectedRange().length == 0 && pairedText(at: selectedRange().location) != nil) {
                remove(back); return
            }
        case "insertNewline:":
            if multiSelection != nil || sourceSettings.autoIndent {
                if edit(sourceSelections.map { newlineEdit(at: $0) }) { return }
            }
        case "insertTab:":
            if sourceSelections.contains(where: { $0.length > 0 }) { run(.indent); return }
            if edit(sourceSelections.map { tabEdit(at: $0) }) { return }
        case "insertBacktab:":
            run(.outdent); return
        case "moveLeft:", "moveRight:", "moveUp:", "moveDown:",
             "moveLeftAndModifySelection:", "moveRightAndModifySelection:", "moveUpAndModifySelection:", "moveDownAndModifySelection:":
            if multiSelection != nil || !folds.isEmpty {
                let command = NSStringFromSelector(selector)
                moveSelections(horizontal: command.contains("Left") ? -1 : command.contains("Right") ? 1 : 0,
                               vertical: command.contains("Up") ? -1 : command.contains("Down") ? 1 : 0,
                               extend: command.contains("Modify"))
                return
            }
        default: break
        }
        super.doCommand(by: selector)
    }

    override func mouseDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection([.command, .option, .shift, .control])
        if flags == .command || flags == .option {
            window?.makeFirstResponder(self)
            let offset = offset(at: convert(event.locationInWindow, from: nil))
            drag = (offset, flags == .command ? selections : [], flags == .option)
            updateSelectionDrag(with: event)
        } else {
            clearExtraSelections()
            super.mouseDown(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        if drag != nil { _ = autoscroll(with: event); updateSelectionDrag(with: event) }
        else { super.mouseDragged(with: event) }
    }

    override func mouseUp(with event: NSEvent) {
        if drag != nil { updateSelectionDrag(with: event); drag = nil }
        else { super.mouseUp(with: event) }
    }

    private func updateSelectionDrag(with event: NSEvent) {
        guard let drag else { return }
        let end = offset(at: convert(event.locationInWindow, from: nil))
        if drag.column {
            let first = line(at: drag.anchor), last = line(at: end)
            let left = displayColumn(at: drag.anchor), right = displayColumn(at: end)
            let lines = first <= last ? Array(first...last) : Array((last...first).reversed())
            setSelections(lines.filter { !isHidden(line: $0) }.map { row in
                TextSelection(anchor: offset(on: row, column: left), head: offset(on: row, column: right))
            })
        } else {
            setSelections(drag.previous + [TextSelection(anchor: drag.anchor, head: end)])
        }
    }

    override func performTextFinderAction(_ sender: Any?) {
        if let onFind, (sender as? NSMenuItem)?.tag == NSTextFinder.Action.showFindInterface.rawValue { onFind() }
        else { super.performTextFinderAction(sender) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let selection = selectedRange()
        let point = convert(event.locationInWindow, from: nil)
        let range = noteRange(at: point, selection: selection)
        let result = super.menu(for: event) ?? NSMenu()
        let find = NSMenuItem(title: "Find…", action: #selector(performTextFinderAction(_:)), keyEquivalent: "")
        find.tag = NSTextFinder.Action.showFindInterface.rawValue
        find.target = self
        result.insertItem(find, at: 0)
        result.insertItem(.separator(), at: 1)
        guard let range, let note = noteTarget?(range) else { return result }
        // The default menu can select a word at the click. The note is always tied to the
        // selection that existed before the context click, or to the clicked grapheme.
        result.insertItem(note, at: 0)
        result.insertItem(.separator(), at: 1)
        return result
    }

    func noteRange(at point: NSPoint, selection: NSRange) -> NSRange? {
        guard let layout = layoutManager, let container = textContainer, let source = textStorage?.mutableString,
              source.length > 0 else { return nil }
        let origin = textContainerOrigin
        let hit = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
        let probe = NSRect(x: hit.x, y: hit.y, width: 1, height: 1)
        let glyphs = layout.glyphRange(forBoundingRect: probe, in: container)
        guard glyphs.length > 0 else { return nil }
        let glyph = layout.glyphIndex(for: hit, in: container)
        guard NSLocationInRange(glyph, glyphs) else { return nil }
        let glyphRect = layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard glyphRect.contains(hit) else { return nil }
        let offset = layout.characterIndexForGlyph(at: glyph)
        guard offset < source.length, source.character(at: offset) != 10 else { return nil }
        if NSLocationInRange(offset, selection) {
            return source.rangeOfComposedCharacterSequences(for: selection)
        }
        return source.rangeOfComposedCharacterSequence(at: offset)
    }

    static func unixNewlines(_ text: String) -> String {
        guard text.utf8.contains(13) else { return text }
        return text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    }
}
