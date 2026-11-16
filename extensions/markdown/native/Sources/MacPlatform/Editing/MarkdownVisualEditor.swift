import AppKit
import MarkdownCore

/// Native input over a derived projection. Only the source controller owns document edits and Undo.
@MainActor final class MarkdownVisualEditor: NSObject, NSTextViewDelegate {
    weak var controller: MarkdownEditorTextController?
    let textView = MarkdownSourceTextView(usingTextLayoutManager: true)
    private(set) var map: MarkdownVisualMap
    private var pending: (range: NSRange, replacement: String, next: MarkdownVisualMap)?
    private var applying = false
    private var composing = false
    private var compositionGroup = false
    var hasMarkedText: Bool { composing || textView.hasMarkedText() }

    init(controller: MarkdownEditorTextController) {
        self.controller = controller
        map = MarkdownVisualMap(source: controller.source)
        super.init()
        textView.registerForDraggedTypes(textView.registeredDraggedTypes + [.fileURL])
        textView.onImageFiles = controller.onImageFiles
        textView.onImageData = controller.onImageData
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = false
        textView.undoManager?.disableUndoRegistration()
        textView.commandUndoManager = controller.textView.undoManager
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticDataDetectionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.usesFindBar = true
        textView.isIncrementalSearchingEnabled = true
        textView.textContainerInset = NSSize(width: 24, height: 20)
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.delegate = self
        textView.compositionWillChange = { [weak self] in
            guard let self else { return }
            self.composing = true
            if !self.compositionGroup {
                self.controller?.textView.undoManager?.beginUndoGrouping()
                self.compositionGroup = true
            }
        }
        textView.compositionDidChange = { [weak self] in
            guard let self else { return }
            if self.pending != nil { self.textDidChange(Notification(name: NSText.didChangeNotification)) }
            self.composing = self.textView.hasMarkedText()
            if !self.composing {
                self.endComposition()
                self.synchronise(force: true)
                self.controller?.visualCompositionEnded()
            }
        }
        textView.appearanceDidChange = { [weak self] in self?.synchronise(force: true) }
        synchronise(force: true)
    }

    private func endComposition() {
        if compositionGroup {
            controller?.textView.undoManager?.endUndoGrouping()
            compositionGroup = false
        }
    }

    func synchronise(force: Bool = false) {
        guard let controller, controller.presentation.mode == .visual, !applying, !hasMarkedText else { return }
        let changed = !map.source.utf16.elementsEqual(controller.source.utf16)
        guard force || changed else { return }
        applying = true
        defer { applying = false }
        if changed { map = MarkdownVisualMap(source: controller.source) }
        let value = controller.presentation
        let palette = MarkdownEditorTheme.palette(for: textView)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 5
        let attributed = NSMutableAttributedString(string: map.text, attributes: [
            .font: MarkdownEditorTheme.font(value), .foregroundColor: MarkdownEditorTheme.colour(palette.text),
            .paragraphStyle: paragraph,
        ])
        for span in map.spans {
            let range = map.visualRange(forSource: span.range)
            guard range.length > 0 else { continue }
            if span.role == .emphasis || span.role == .strong {
                let trait: NSFontTraitMask = span.role == .strong ? .boldFontMask : .italicFontMask
                attributed.enumerateAttribute(.font, in: range) { font, run, _ in
                    let base = font as? NSFont ?? MarkdownEditorTheme.font(value)
                    attributed.addAttribute(.font, value: NSFontManager.shared.convert(base, toHaveTrait: trait), range: run)
                }
            } else {
                attributed.addAttributes(MarkdownEditorTheme.attributes(for: span.role, presentation: value, palette: palette), range: range)
            }
        }
        for sourceRange in map.fallbackRanges {
            let range = map.visualRange(forSource: sourceRange)
            if range.length > 0 {
                attributed.addAttributes([.font: NSFont.monospacedSystemFont(ofSize: value.fontSize * 0.94, weight: .regular),
                                          .backgroundColor: MarkdownEditorTheme.colour(palette.surface)], range: range)
            }
        }
        textView.textStorage?.setAttributedString(attributed)
        textView.typingAttributes = [.font: MarkdownEditorTheme.font(value), .foregroundColor: MarkdownEditorTheme.colour(palette.text)]
        textView.backgroundColor = MarkdownEditorTheme.colour(palette.background)
        textView.insertionPointColor = MarkdownEditorTheme.colour(palette.link)
        textView.selectedTextAttributes = [.backgroundColor: MarkdownEditorTheme.colour(palette.selection)]
        textView.isHorizontallyResizable = !value.wrapsLines
        textView.autoresizingMask = value.wrapsLines ? [.width] : []
        textView.textContainer?.widthTracksTextView = value.wrapsLines
        textView.textContainer?.containerSize = NSSize(width: value.wrapsLines ? max(1, controller.scrollView.contentSize.width - 48) : CGFloat.greatestFiniteMagnitude,
                                                       height: CGFloat.greatestFiniteMagnitude)
        textView.setSelectedRange(map.visualRange(forSource: controller.selectedRange))
    }

    func select(source range: NSRange) {
        guard !applying, !hasMarkedText else { return }
        applying = true
        textView.setSelectedRange(map.visualRange(forSource: range))
        textView.scrollRangeToVisible(textView.selectedRange())
        applying = false
    }

    func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
        guard let replacementString, let controller,
              let range = map.editRange(forVisual: affectedCharRange),
              MarkdownEditorTextController.validSelection(range, in: controller.source),
              let next = map.replacing(visual: affectedCharRange, with: replacementString),
              next.source.utf8.count <= Limits.sourceBytes else {
            controller?.onError?("This selection crosses Markdown formatting. Use Source to change its structure.")
            return false
        }
        guard map.source.utf16.elementsEqual(controller.source.utf16) else { return false }
        pending = (range, replacementString, next)
        return true
    }

    func textDidChange(_ notification: Notification) {
        guard let controller, let edit = pending else { return }
        pending = nil
        applying = true
        let caret = edit.next.sourceRange(forVisual: textView.selectedRange())
        let success = controller.applyVisual(range: edit.range, replacement: edit.replacement, selection: caret)
        if success { map = edit.next }
        applying = false
        // Never replace native marked text; its current projection moves with the source patch.
        if !hasMarkedText {
            map = MarkdownVisualMap(source: controller.source)
            synchronise(force: true)
        }
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        guard !applying, pending == nil, let controller else { return }
        let range = map.sourceRange(forVisual: textView.selectedRange())
        controller.textView.setSelectedRange(range)
    }

    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard !hasMarkedText else { return false }
        if selector == NSSelectorFromString("undo:") { controller?.textView.undoManager?.undo(); return true }
        if selector == NSSelectorFromString("redo:") { controller?.textView.undoManager?.redo(); return true }
        return controller?.onCommand?(selector) ?? false
    }
}
