import AppKit

@MainActor
final class CodeSyntax {
    let engine = SyntaxEngine()
    var colours: (SyntaxRole) -> NSColor? = CodeSyntax.defaultColour {
        didSet { invalidate() }
    }

    private var styled = NSRange(location: 0, length: 0)
    private var styledRevision: UInt64?

    func invalidate() { styledRevision = nil }
    func setFile(_ doc: String) { engine.setFile(doc) }

    func highlight(rect: NSRect, in container: NSTextContainer, layout: NSLayoutManager, source: NSString) {
        guard let storage = layout.textStorage else { return }
        engine.attach(to: storage)
        let document = NSRange(location: 0, length: source.length)
        let previous = NSIntersectionRange(styled, document)
        guard engine.language.id != "plain", !rect.isEmpty, document.length > 0 else {
            if previous.length > 0 { layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: previous) }
            styled = NSRange(location: 0, length: 0)
            styledRevision = nil
            return
        }
        let visibleGlyphs = layout.glyphRange(forBoundingRect: rect, in: container)
        guard visibleGlyphs.length > 0 else { return }
        let visible = layout.characterRange(forGlyphRange: visibleGlyphs, actualGlyphRange: nil)
        if styledRevision == engine.revision && NSIntersectionRange(visible, styled).length == visible.length { return }

        let nearbyGlyphs = layout.glyphRange(forBoundingRect: rect.insetBy(dx: 0, dy: -rect.height / 2), in: container)
        let nearby = NSIntersectionRange(layout.characterRange(forGlyphRange: nearbyGlyphs, actualGlyphRange: nil), document)
        guard nearby.length > 0 else { return }
        let range = source.lineRange(for: nearby)
        if previous.length > 0 { layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: previous) }
        layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: range)

        for token in engine.tokens(in: range) {
            guard let colour = colours(token.role) else { continue }
            layout.addTemporaryAttribute(.foregroundColor, value: colour, forCharacterRange: token.range)
        }
        styled = range
        styledRevision = engine.revision
    }

    nonisolated private static func defaultColour(_ role: SyntaxRole) -> NSColor? {
        switch role {
        case .plain, .punctuation, .operator, .parameter, .property: nil
        case .comment, .quote: .secondaryLabelColor
        case .string, .regex, .raw, .inserted: .systemGreen
        case .escape, .decorator, .attribute: .systemOrange
        case .storage, .keyword, .constant, .tag: .systemPurple
        case .number, .link, .function: .systemBlue
        case .type, .heading, .changedHeader, .emphasis, .strong, .listMarker: .systemTeal
        case .deleted, .invalid: .systemRed
        }
    }
}
