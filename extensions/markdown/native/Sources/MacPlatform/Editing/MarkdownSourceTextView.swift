import AppKit

/// A retained native input surface. No helper accesses the legacy layout manager.
@MainActor public final class MarkdownSourceTextView: NSTextView {
    private let editingUndoManager = UndoManager()
    private var focusRequested = false
    public var commandUndoManager: UndoManager?
    public var compositionWillChange: (() -> Void)?
    public var compositionDidChange: (() -> Void)?
    public var appearanceDidChange: (() -> Void)?
    public var currentLineColour: NSColor = .clear
    public var onImageFiles: (([URL]) -> Void)?
    public var onImageData: ((Data, String) -> Void)?
    public override var undoManager: UndoManager? { editingUndoManager }

    @objc public func undo(_ sender: Any?) {
        guard !hasMarkedText() else { return }
        (commandUndoManager ?? editingUndoManager).undo()
    }
    @objc public func redo(_ sender: Any?) {
        guard !hasMarkedText() else { return }
        (commandUndoManager ?? editingUndoManager).redo()
    }

    // Handles the Undo and Redo keys only while this view has keyboard focus. Key equivalents reach
    // every view in the window, so another field's Undo never changes the document.
    private func handleUndoKey(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])
        guard event.type == .keyDown, window?.firstResponder === self, event.charactersIgnoringModifiers?.lowercased() == "z",
              modifiers == .command || modifiers == [.command, .shift] else { return false }
        if modifiers.contains(.shift) { redo(self) } else { undo(self) }
        return true
    }

    public override func performKeyEquivalent(with event: NSEvent) -> Bool {
        handleUndoKey(event) || super.performKeyEquivalent(with: event)
    }

    public override func keyDown(with event: NSEvent) {
        if !handleUndoKey(event) { super.keyDown(with: event) }
    }

    public override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        let manager = commandUndoManager ?? editingUndoManager
        if item.action == #selector(undo(_:)) { return !hasMarkedText() && manager.canUndo }
        if item.action == #selector(redo(_:)) { return !hasMarkedText() && manager.canRedo }
        return super.validateUserInterfaceItem(item)
    }

    public func requestFocus() {
        if let window { window.makeFirstResponder(self) } else { focusRequested = true }
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if focusRequested, let window {
            focusRequested = false
            window.makeFirstResponder(self)
        }
    }

    public override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        compositionWillChange?()
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        compositionDidChange?()
    }

    public override func unmarkText() {
        super.unmarkText()
        compositionDidChange?()
    }

    public override func insertText(_ string: Any, replacementRange: NSRange) {
        let wasMarked = hasMarkedText()
        super.insertText(string, replacementRange: replacementRange)
        if wasMarked { compositionDidChange?() }
    }

    public override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        if board.string(forType: .string) != nil {
            pasteAsPlainText(sender)
        } else if let data = board.data(forType: .png), let onImageData {
            onImageData(data, "image/png")
        } else if let data = board.data(forType: .tiff), let onImageData {
            onImageData(data, "image/tiff")
        } else {
            super.paste(sender)
        }
    }

    private func imageFiles(_ board: NSPasteboard) -> [URL] {
        let extensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
        let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.filter { $0.isFileURL && extensions.contains($0.pathExtension.lowercased()) }
    }

    public override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        if sender.draggingPasteboard.types?.contains(.fileURL) == true {
            return onImageFiles != nil && !imageFiles(sender.draggingPasteboard).isEmpty ? .copy : []
        }
        return super.draggingEntered(sender)
    }

    public override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        if sender.draggingPasteboard.types?.contains(.fileURL) == true {
            let files = imageFiles(sender.draggingPasteboard)
            guard !files.isEmpty, let onImageFiles else { return false }
            onImageFiles(files)
            return true
        }
        return super.performDragOperation(sender)
    }

    public override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        appearanceDidChange?()
    }

    public override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        guard selectedRange().length == 0, let manager = textLayoutManager,
              let content = manager.textContentManager,
              let location = content.location(content.documentRange.location, offsetBy: selectedRange().location),
              let range = NSTextRange(location: location, end: location) else { return }
        manager.enumerateTextSegments(in: range, type: .standard, options: []) { _, frame, _, _ in
            let line = NSRect(x: self.visibleRect.minX, y: frame.minY + self.textContainerOrigin.y,
                              width: self.visibleRect.width, height: frame.height)
            self.currentLineColour.setFill()
            line.intersection(rect).fill()
            return false
        }
    }

    public override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        needsDisplay = true
        return result
    }

    public override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        needsDisplay = true
        return result
    }
}
