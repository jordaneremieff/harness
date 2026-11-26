import AppKit

@MainActor
final class CodeScrollView: NSScrollView {
    override func layout() {
        super.layout()
        guard let text = documentView as? CodeTextView else { return }
        let viewport = contentView.bounds.size
        if text.minSize != viewport { text.minSize = viewport }
        let frame = text.frame.size
        let size = NSSize(width: max(frame.width, viewport.width), height: max(frame.height, viewport.height))
        if size != frame { text.setFrameSize(size) }
    }
}

@MainActor
final class CodeTextView: NSTextView {
    var noteTarget: ((NSRange) -> NSMenuItem?)?
    private let syntax = CodeSyntax()

    override func draw(_ dirtyRect: NSRect) {
        prepareVisibleText()
        super.draw(dirtyRect)
    }

    func setSyntax(for doc: String) {
        syntax.setFile(doc)
        invalidateSyntax()
    }

    func invalidateSyntax() {
        syntax.invalidate()
        needsDisplay = true
    }

    func prepareVisibleText() {
        guard let manager = layoutManager, let container = textContainer, let storage = textStorage else { return }
        let origin = textContainerOrigin
        let rect = visibleRect.offsetBy(dx: -origin.x, dy: -origin.y)
        syntax.highlight(rect: rect, in: container, layout: manager, source: storage.mutableString)
    }

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        if let string = (insertString as? String) ?? (insertString as? NSAttributedString)?.string {
            super.insertText(Self.unixNewlines(string), replacementRange: replacementRange)
        } else {
            super.insertText(insertString, replacementRange: replacementRange)
        }
    }

    override func paste(_ sender: Any?) {
        if let string = NSPasteboard.general.string(forType: .string) {
            insertText(string, replacementRange: NSRange(location: NSNotFound, length: 0))
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let selection = selectedRange()
        let point = convert(event.locationInWindow, from: nil)
        let range = noteRange(at: point, selection: selection)
        let menu = super.menu(for: event)
        guard let range, let note = noteTarget?(range) else { return menu }
        // The default menu can select a word at the click. The note is always tied to the
        // selection that existed before the context click, or to the clicked grapheme.
        let result = menu ?? NSMenu()
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
