import AppKit

extension CodeTextView {
    func drawSourceBackground(_ dirty: NSRect) {
        guard let container = textContainer else { return }
        let rows = visibleRows(in: dirty)
        let source = source
        let settings = sourceSettings
        let paintState = selectionPaint()
        let activeLine = paintState.line
        let startX = textContainerOrigin.x + container.lineFragmentPadding
        if settings.highlightLine {
            sourceTheme.currentLine.setFill()
            for row in rows where row.line == activeLine {
                fill(NSRect(x: visibleRect.minX, y: row.rect.minY, width: visibleRect.width, height: row.rect.height), in: dirty)
            }
        }
        if !settings.rulers.isEmpty {
            sourceTheme.ruler.setFill()
            for column in settings.rulers {
                fill(NSRect(x: floor(startX + CGFloat(column) * spaceWidth), y: dirty.minY, width: 1, height: dirty.height), in: dirty)
            }
        }
        if settings.indentGuides {
            for row in rows {
                let indent = leadingIndent(on: row.line)
                let count = indent.columns / indentation.width
                guard count > 0, row.chars.location <= contents(of: row.line).location + indent.length else { continue }
                let active = activeGuide(for: row.line, indent: indent.columns, state: paintState)
                for level in 0..<min(256, count) {
                    (active == level ? sourceTheme.activeIndentGuide : sourceTheme.indentGuide).setFill()
                    let column = level * indentation.width
                    fill(NSRect(x: floor(startX + CGFloat(column) * spaceWidth), y: row.rect.minY,
                                width: 1, height: row.rect.height), in: dirty)
                }
            }
        }
        guard let visible = paintSpan(rows), source.length > 0 else { return }
        for mark in reviewMarks where mark.range.length > 0 {
            paint(NSIntersectionRange(mark.range, visible), color: sourceTheme.added.withAlphaComponent(0.20), in: dirty)
        }
        if let mark = revealMark {
            paint(NSIntersectionRange(mark.range, visible), color: sourceTheme.accent.withAlphaComponent(0.23), in: dirty)
        }
        if let occurrence = paintState.occurrence, let span = occurrenceSpan(in: dirty) {
            for part in visibleParts(of: span) {
                forEachOccurrence(occurrence, in: part) { paint($0, color: sourceTheme.selectionMatch, in: dirty) }
            }
        }
        var low = 0, high = foundRanges.count
        while low < high {
            let mid = (low + high) / 2
            if NSMaxRange(foundRanges[mid]) <= visible.location { low = mid + 1 } else { high = mid }
        }
        while low < foundRanges.count, foundRanges[low].location < NSMaxRange(visible) {
            let match = foundRanges[low]
            paint(NSIntersectionRange(visible, match), color: match == foundCurrent ? sourceTheme.findCurrent : sourceTheme.findMatch, in: dirty)
            low += 1
        }
        if !paintState.extras.isEmpty {
            let selection = window?.firstResponder === self ? sourceTheme.selection : sourceTheme.inactiveSelection
            for extra in paintState.extras {
                paint(NSIntersectionRange(extra, visible), color: selection, in: dirty)
            }
        }
    }

    func drawSourceForeground(_ dirty: NSRect) {
        let settings = sourceSettings
        let paintState = selectionPaint()
        guard settings.whitespace == "all" || !paintState.whitespace.isEmpty || paintState.bracket != nil ||
                !folds.isEmpty || !threadMarks.isEmpty || !reviewMarks.isEmpty else { return }
        let rows = visibleRows(in: dirty)
        let span = paintSpan(rows)
        drawCollaborationMarks(dirty, rows: rows)
        if settings.whitespace != "none", let span, span.length > 0 {
            let ranges = settings.whitespace == "all" ? [span] : paintState.whitespace.map { NSIntersectionRange($0, span) }
            drawWhitespace(in: ranges.filter { $0.length > 0 }.flatMap(visibleParts), dirty: dirty)
        }
        if let match = paintState.bracket, let span {
            let colour = sourceTheme.bracket(match.mate == nil ? "unmatched" : match.kind)
            for offset in [match.offset, match.mate].compactMap({ $0 }) where NSLocationInRange(offset, span) {
                guard let caret = caretRect(at: offset) else { continue }
                colour.setFill()
                fill(NSRect(x: caret.minX, y: caret.maxY - 1, width: max(caret.width, 3), height: 1.5), in: dirty)
            }
        }
        if !folds.isEmpty {
            for row in rows where isFolded(line: row.line) {
                let end = NSMaxRange(contents(of: row.line))
                guard end >= row.chars.location, end < NSMaxRange(row.chars), let caret = caretRect(at: end) else { continue }
                let rect = NSRect(x: caret.minX + 6, y: caret.midY - 7, width: 20, height: 14)
                sourceTheme.foldMark.setFill()
                NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()
                let dots = "…" as NSString
                let style: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .medium), .foregroundColor: sourceTheme.secondaryText]
                let size = dots.size(withAttributes: style)
                dots.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2), withAttributes: style)
            }
        }
    }

    private func drawWhitespace(in ranges: [NSRange], dirty: NSRect) {
        let blank = CharacterSet(charactersIn: " \t")
        let source = source
        var budget = 4_096
        sourceTheme.whitespace.setFill()
        for range in ranges {
            var cursor = range.location
            while cursor < NSMaxRange(range), budget > 0 {
                let found = source.rangeOfCharacter(from: blank, options: .literal, range: NSRange(location: cursor, length: NSMaxRange(range) - cursor))
                guard found.location != NSNotFound else { break }
                cursor = NSMaxRange(found)
                budget -= 1
                guard let caret = caretRect(at: found.location), caret.intersects(dirty) else { continue }
                let center = floor(caret.midY + 1)
                if source.character(at: found.location) == 9 {
                    let width = max(3, min(caret.width - 4, 10))
                    fill(NSRect(x: caret.minX + 2, y: center, width: width, height: 1), in: dirty)
                    fill(NSRect(x: caret.minX + width + 1, y: center - 1, width: 1, height: 3), in: dirty)
                } else {
                    let dot = NSRect(x: floor(caret.midX) - 1, y: center, width: 2, height: 2)
                    NSBezierPath(ovalIn: dot).fill()
                }
            }
        }
    }

    private func paintSpan(_ rows: [(line: Int, rect: NSRect, chars: NSRange)]) -> NSRange? {
        guard let first = rows.first?.chars, let last = rows.last?.chars else { return nil }
        return NSIntersectionRange(NSUnionRange(first, last), NSRange(location: 0, length: source.length))
    }

    private func paint(_ range: NSRange, color: NSColor, in dirty: NSRect) {
        guard range.length > 0, let layout = layoutManager, let container = textContainer else { return }
        let origin = textContainerOrigin
        color.setFill()
        for part in visibleParts(of: range) {
            let glyphs = layout.glyphRange(forCharacterRange: part, actualCharacterRange: nil)
            layout.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { rect, _ in
                self.fill(rect.offsetBy(dx: origin.x, dy: origin.y), in: dirty)
            }
        }
    }

    private func fill(_ rect: NSRect, in dirty: NSRect) {
        let area = rect.intersection(dirty)
        if !area.isEmpty { NSBezierPath(rect: area).fill() }
    }
}
