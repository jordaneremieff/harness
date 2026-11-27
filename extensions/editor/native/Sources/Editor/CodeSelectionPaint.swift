import AppKit

struct CodeSelectionPaint {
    struct Occurrence: Equatable {
        let word: String
        let selected: NSRange
    }

    let line: Int
    let indent: Int
    let extras: [NSRange]
    let whitespace: [NSRange]
    let occurrence: Occurrence?
    let bracket: TextBracketMatch?
}

extension CodeTextView {
    func selectionPaint() -> CodeSelectionPaint {
        if let cachedSelectionPaint { return cachedSelectionPaint }
        let paint = makeSelectionPaint()
        cachedSelectionPaint = paint
        return paint
    }

    private func makeSelectionPaint() -> CodeSelectionPaint {
        let ranges = selections
        let head = min(ranges.last?.head ?? 0, source.length)
        let line = line(at: head)
        let settings = sourceSettings
        let selected = ranges.last?.range ?? NSRange(location: head, length: 0)
        let occurrence: CodeSelectionPaint.Occurrence? = if settings.matchSelection, (1...100).contains(selected.length),
            isWholeSourceWord(selected) {
            .init(word: source.substring(with: selected), selected: selected)
        } else { nil }
        return CodeSelectionPaint(line: line, indent: settings.indentGuides ? leadingIndent(on: line).columns : 0,
            extras: ranges.dropLast().map(\.range).filter { $0.length > 0 },
            whitespace: settings.whitespace == "selection" ? ranges.map(\.range).filter { $0.length > 0 } : [],
            occurrence: occurrence,
            bracket: settings.matchBrackets ? adjacentBracket(around: head, searchLimit: 8_192, viewport: true) : nil)
    }

    func updateSelectionPaint(from old: CodeSelectionPaint) {
        let next = makeSelectionPaint()
        cachedSelectionPaint = next
        let settings = sourceSettings
        if old.line != next.line, settings.highlightLine { activeLineChanged?(old.line, next.line) }
        let tint = settings.highlightLine && old.line != next.line
        let guides = settings.indentGuides && old.indent != next.indent
        let occurrences = old.occurrence != next.occurrence
        let brackets = old.bracket != next.bracket
        var ranges = changedCoverage(old.extras, next.extras) + changedCoverage(old.whitespace, next.whitespace)
        guard tint || guides || occurrences || brackets || !ranges.isEmpty else { return }
        let offsets = brackets ? [old.bracket?.offset, old.bracket?.mate, next.bracket?.offset, next.bracket?.mate].compactMap { $0 } : []
        let viewport = visibleRect
        guard !viewport.isEmpty else { return }
        if occurrences, let span = occurrenceSpan(in: viewport) {
            for occurrence in [old.occurrence, next.occurrence].compactMap({ $0 }) {
                for part in visibleParts(of: span) {
                    forEachOccurrence(occurrence, in: part) { ranges.append($0) }
                }
            }
        }
        for row in visibleRows(in: viewport) {
            var changed = tint && (row.line == old.line || row.line == next.line)
            if !changed, guides {
                let indent = leadingIndent(on: row.line)
                if row.chars.location <= contents(of: row.line).location + indent.length {
                    changed = activeGuide(for: row.line, indent: indent.columns, state: old)
                        != activeGuide(for: row.line, indent: indent.columns, state: next)
                }
            }
            if !changed { changed = offsets.contains { NSLocationInRange($0, row.chars) } }
            if !changed { changed = ranges.contains { NSIntersectionRange($0, row.chars).length > 0 } }
            if changed {
                setNeedsDisplay(NSRect(x: viewport.minX, y: row.rect.minY, width: viewport.width, height: row.rect.height).intersection(viewport))
            }
        }
    }

    func activeGuide(for line: Int, indent: Int, state: CodeSelectionPaint) -> Int? {
        let level = state.indent / indentation.width
        guard level > 0, level <= min(256, indent / indentation.width), line == state.line || indent >= state.indent else { return nil }
        return level - 1
    }

    private func changedCoverage(_ old: [NSRange], _ next: [NSRange]) -> [NSRange] {
        guard old != next else { return [] }
        let boundaries = (old + next).flatMap { [$0.location, NSMaxRange($0)] }.sorted()
        return stride(from: 0, to: boundaries.count, by: 2).compactMap { i in
            let start = boundaries[i], end = boundaries[i + 1]
            return end > start ? NSRange(location: start, length: end - start) : nil
        }
    }

    func occurrenceSpan(in rect: NSRect) -> NSRange? {
        guard let span = visibleCharacterSpan(in: rect) else { return nil }
        // A word can straddle the clip or a wrapped fragment.
        let start = max(0, span.location - 100)
        return NSRange(location: start, length: min(source.length, NSMaxRange(span) + 100) - start)
    }

    func forEachOccurrence(_ occurrence: CodeSelectionPaint.Occurrence, in range: NSRange, _ body: (NSRange) -> Void) {
        let source = source
        let end = min(source.length, NSMaxRange(range))
        var start = range.location
        while start < end {
            let match = source.range(of: occurrence.word, options: .literal, range: NSRange(location: start, length: end - start))
            if match.location == NSNotFound { break }
            if match != occurrence.selected, isWholeSourceWord(match) { body(match) }
            start = NSMaxRange(match)
        }
    }

    func visibleCharacterSpan(in rect: NSRect) -> NSRange? {
        guard let layout = layoutManager, let container = textContainer else { return nil }
        let origin = textContainerOrigin
        let viewport = rect.offsetBy(dx: -origin.x, dy: -origin.y)
        guard !viewport.isEmpty else { return nil }
        let glyphs = layout.glyphRange(forBoundingRect: viewport, in: container)
        if glyphs.length > 0 {
            return layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        }
        if source.length == 0 || layout.extraLineFragmentRect.intersects(viewport) {
            return NSRange(location: source.length, length: 0)
        }
        return nil
    }
}
