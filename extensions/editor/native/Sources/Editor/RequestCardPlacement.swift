import AppKit

/// The panel uses flipped coordinates. A vertical placement spans complete rows or empty space.
func requestCardPlacement(in bounds: NSRect, anchor: NSRect, codeEnd: CGFloat, rows: [NSRect], preferred: NSSize) -> NSRect? {
    let area = bounds.insetBy(dx: 6, dy: 6)
    let width = min(preferred.width, area.width)
    let height = min(preferred.height, area.height)
    guard width >= 220, height >= 150 else { return nil }
    let selection = anchor.intersection(area)
    let right = max(area.minX, codeEnd + 8)
    let rightWidth = min(width, area.maxX - right)
    if rightWidth >= 220 {
        let top = selection.isEmpty ? area.minY : min(selection.minY, area.maxY - height)
        return NSRect(x: right, y: top, width: rightWidth, height: height)
    }
    guard !selection.isEmpty else { return nil }
    func boundary(_ y: CGFloat, down: Bool) -> CGFloat {
        guard let row = rows.first(where: { $0.minY < y && y < $0.maxY }) else { return y }
        return down ? row.maxY : row.minY
    }
    let start = boundary(selection.maxY + 4, down: true)
    let end = boundary(min(area.maxY, start + height), down: false)
    if end - start >= 150 { return NSRect(x: bounds.minX, y: start, width: bounds.width, height: end - start) }

    let bottom = boundary(selection.minY - 4, down: false)
    let top = boundary(max(area.minY, bottom - height), down: true)
    guard bottom - top >= 150 else { return nil }
    return NSRect(x: bounds.minX, y: top, width: bounds.width, height: bottom - top)
}

extension CodeTextView {
    func placeRequestCard(in area: NSRect, panel: NSView, anchor: NSRange, preferred: NSSize) -> NSRect? {
        let viewport = visibleRect
        let selection = collaborationBounds(for: anchor, in: viewport).map { panel.convert($0, from: self) } ?? .null
        let rows = visibleRows(in: viewport)
        let edge: CGFloat
        if let layout = layoutManager {
            let origin = textContainerOrigin
            edge = rows.reduce(area.minX - 8) { edge, row in
                guard row.chars.length > 0 else { return edge }
                let glyph = layout.glyphIndexForCharacter(at: row.chars.location)
                let used = layout.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
                let end = panel.convert(NSPoint(x: used.maxX + origin.x, y: row.rect.minY), from: self).x
                return max(edge, end)
            }
        } else { edge = area.minX - 8 }
        return requestCardPlacement(in: area, anchor: selection, codeEnd: edge,
                                    rows: rows.map { panel.convert($0.rect, from: self) }, preferred: preferred)
    }
}
