import AppKit

extension CodeTextView {
    /// The union of visible line fragments that contain the anchor, not the full line width.
    func collaborationBounds(for range: NSRange, in viewport: NSRect) -> NSRect? {
        guard range.location >= 0, NSMaxRange(range) <= source.length,
              let layout = layoutManager, let container = textContainer else { return nil }
        if range.length == 0 {
            let offset = visibleOffset(range.location)
            return caretRect(at: offset).flatMap { $0.intersects(viewport) ? $0.intersection(viewport) : nil }
        }
        let origin = textContainerOrigin
        var result = NSRect.null
        let rows = visibleRows(in: viewport)
        for row in rows {
            let part = NSIntersectionRange(range, row.chars)
            guard part.length > 0 else { continue }
            let glyphs = layout.glyphRange(forCharacterRange: part, actualCharacterRange: nil)
            let rect = layout.boundingRect(forGlyphRange: glyphs, in: container).offsetBy(dx: origin.x, dy: origin.y)
            if rect.intersects(viewport) { result = result.union(rect.intersection(viewport)) }
        }
        if result.isNull, let first = rows.first, range.location >= first.chars.location,
           range.location <= NSMaxRange(rows.last?.chars ?? first.chars), let caret = caretRect(at: visibleOffset(range.location)),
           caret.intersects(viewport) { result = caret.intersection(viewport) }
        return result.isNull ? nil : result
    }

    func invalidateCollaborationRows(from old: [NSRange], to next: [NSRange]) {
        for rect in collaborationRowRects(for: Set(old).symmetricDifference(next)) { setNeedsDisplay(rect) }
    }

    func collaborationRowRects(for ranges: Set<NSRange>) -> [NSRect] {
        guard !ranges.isEmpty else { return [] }
        let viewport = visibleRect
        let rows = visibleRows(in: viewport)
        guard let first = rows.first, let last = rows.last else { return [] }
        let points = ranges.compactMap { range -> CGFloat? in
            guard range.length == 0, range.location >= first.chars.location, range.location <= NSMaxRange(last.chars) else { return nil }
            return caretRect(at: range.location)?.midY
        }
        return rows.compactMap { row in
            guard ranges.contains(where: { NSIntersectionRange($0, row.chars).length > 0 }) ||
                    points.contains(where: { row.rect.minY <= $0 && $0 < row.rect.maxY }) else { return nil }
            return NSRect(x: viewport.minX, y: row.rect.minY, width: viewport.width, height: row.rect.height).intersection(viewport)
        }
    }

    var threadMarkerLines: Set<Int> {
        Set(threadMarks.map { line(at: visibleOffset($0.span.range.location)) })
    }

    func threadMarker(on line: Int) -> String? {
        threadMarks.first { self.line(at: visibleOffset($0.span.range.location)) == line }?.id
    }

    func threadMarker(at point: NSPoint) -> String? {
        guard openThread != nil, !threadMarks.isEmpty else { return nil }
        let nearby = NSRect(x: visibleRect.minX, y: point.y - 5, width: visibleRect.width, height: 10)
        guard let row = visibleRows(in: nearby).first(where: { $0.rect.minY <= point.y && point.y <= $0.rect.maxY }) else { return nil }
        return threadMarks.first { mark in
            guard let rect = threadUnderline(mark.span.range, in: row.chars, row: row.rect) else { return false }
            return rect.insetBy(dx: -1, dy: -2).contains(point)
        }?.id
    }

    func drawCollaborationMarks(_ dirty: NSRect, rows: [(line: Int, rect: NSRect, chars: NSRange)]) {
        guard !threadMarks.isEmpty || !reviewMarks.isEmpty || revealMark != nil else { return }
        for row in rows {
            sourceTheme.accent.withAlphaComponent(0.66).setFill()
            for mark in threadMarks {
                threadUnderline(mark.span.range, in: row.chars, row: row.rect)?.intersection(dirty).fill()
            }
            for mark in reviewMarks where mark.range.length == 0 && line(at: mark.range.location) == row.line {
                if let caret = caretRect(at: mark.range.location), row.rect.minY <= caret.midY, caret.midY < row.rect.maxY {
                    sourceTheme.modified.setFill()
                    NSRect(x: caret.minX, y: row.rect.minY + 2, width: 3, height: max(1, row.rect.height - 4)).intersection(dirty).fill()
                }
            }
        }
    }

    private func threadUnderline(_ range: NSRange, in chars: NSRange, row: NSRect) -> NSRect? {
        let part = NSIntersectionRange(range, chars)
        if range.length == 0, line(at: range.location) == line(at: chars.location),
           range.location >= chars.location, range.location <= NSMaxRange(chars), let caret = caretRect(at: range.location),
           row.minY <= caret.midY, caret.midY < row.maxY {
            return NSRect(x: caret.minX, y: row.maxY - 3, width: 7, height: 2)
        }
        guard part.length > 0, let layout = layoutManager, let container = textContainer else { return nil }
        let glyphs = layout.glyphRange(forCharacterRange: part, actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
        return NSRect(x: rect.minX + textContainerOrigin.x, y: row.maxY - 3, width: max(6, rect.width), height: 2)
    }
}
