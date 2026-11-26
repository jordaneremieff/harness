import AppKit

struct TextFold: Hashable {
    var hidden: NSRange
    var header: Int
}

extension CodeTextView {
    var wordCharacters: CharacterSet { syntax.engine.language.wordCharacters }
    var lineCount: Int { lineIndex?.count ?? 1 }

    func line(at offset: Int) -> Int { lineIndex?.line(at: min(source.length, max(0, offset))) ?? 0 }
    func lineRange(_ line: Int) -> NSRange { lineIndex?.range(of: line) ?? NSRange(location: 0, length: 0) }
    func contents(of line: Int) -> NSRange {
        var range = lineRange(line)
        if range.length > 0, source.character(at: NSMaxRange(range) - 1) == 10 { range.length -= 1 }
        return range
    }

    func storageDidEdit(range: NSRange, delta: Int) {
        let oldEnd = NSMaxRange(range) - delta
        if let columnCheckpoint, range.location < columnCheckpoint.offset { self.columnCheckpoint = nil }
        lineIndex?.applyEdit(in: source, range: range, delta: delta)
        if !folds.isEmpty {
            var expanded: NSRange?
            folds = folds.compactMap { fold in
                if oldEnd <= fold.header && range.location < fold.header {
                    return TextFold(hidden: NSRange(location: fold.hidden.location + delta, length: fold.hidden.length), header: fold.header + delta)
                }
                if range.location >= NSMaxRange(fold.hidden) { return fold }
                if oldEnd <= fold.hidden.location {
                    let start = fold.hidden.location + delta
                    if start > 0, source.character(at: start - 1) == 10 {
                        let header = lineRange(line(at: start - 1)).location
                        return TextFold(hidden: NSRange(location: start, length: fold.hidden.length), header: header)
                    }
                }
                let start = min(fold.header, range.location)
                let end = min(source.length, max(NSMaxRange(range), NSMaxRange(fold.hidden) + delta))
                let affected = NSRange(location: start, length: max(0, end - start))
                expanded = expanded.map { NSUnionRange($0, affected) } ?? affected
                return nil
            }
            if let expanded, expanded.length > 0 {
                // Text storage reports the change before the layout manager processes it.
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    let valid = NSIntersectionRange(expanded, NSRange(location: 0, length: source.length))
                    if valid.length > 0 {
                        layoutManager?.invalidateGlyphs(forCharacterRange: valid, changeInLength: 0, actualCharacterRange: nil)
                        layoutManager?.invalidateLayout(forCharacterRange: valid, actualCharacterRange: nil)
                        invalidateAdornment()
                    }
                }
            }
        }
        foundRanges.removeAll(keepingCapacity: true)
        foundCurrent = nil
        mapFindLines.removeAll(keepingCapacity: true)
    }

    func revealSourceRange(_ range: NSRange) {
        unfold(intersecting: range)
        scrollRangeToVisible(range)
    }

    func visibleOffset(_ offset: Int, forward: Bool = false) -> Int {
        var here = offset
        while let fold = hiddenFold(at: here) {
            let exit = NSMaxRange(fold.hidden)
            here = forward && (exit < source.length || (exit > 0 && source.character(at: exit - 1) == 10))
                ? exit : NSMaxRange(contents(of: line(at: fold.header)))
        }
        return here
    }

    private func hiddenFold(at offset: Int) -> TextFold? {
        var lo = 0, hi = folds.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if NSMaxRange(folds[mid].hidden) <= offset { lo = mid + 1 } else { hi = mid }
        }
        if lo < folds.count, NSLocationInRange(offset, folds[lo].hidden) { return folds[lo] }
        if offset == source.length, offset > 0, source.character(at: offset - 1) != 10,
           let last = folds.last, NSMaxRange(last.hidden) == offset { return last }
        return nil
    }

    func isHidden(line: Int) -> Bool { hiddenFold(at: lineRange(line).location) != nil }

    func isFolded(line: Int) -> Bool {
        let offset = lineRange(line).location
        var low = 0, high = folds.count
        while low < high {
            let mid = (low + high) / 2
            if folds[mid].header < offset { low = mid + 1 } else { high = mid }
        }
        return low < folds.count && folds[low].header == offset
    }

    func canFold(line: Int) -> Bool {
        guard line + 1 < lineCount, !isHidden(line: line) else { return false }
        let level = leadingIndent(on: line)
        guard !level.blank else { return false }
        for next in (line + 1)..<min(lineCount, line + 9) {
            let candidate = leadingIndent(on: next)
            if !candidate.blank {
                if candidate.columns > level.columns { return true }
                break
            }
        }
        return line + 2 < lineCount && blockOpener(on: line) != nil
    }

    func toggleFold(line: Int) {
        if isFolded(line: line) { unfold(line: line) }
        else if let candidate = foldRange(line: line) { setFolds(folds + [candidate]) }
    }

    func foldSelection() {
        var next = folds
        for selection in sourceSelections {
            let row = line(at: selection.location)
            let lastSelected = line(at: max(selection.location, NSMaxRange(selection) - 1))
            if lastSelected > row {
                let start = NSMaxRange(lineRange(row)), end = NSMaxRange(lineRange(lastSelected))
                if end > start {
                    next.append(TextFold(hidden: NSRange(location: start, length: end - start), header: lineRange(row).location))
                }
            } else if let fold = foldRange(line: row) {
                next.append(fold)
            } else if row > 0 {
                let columns = leadingIndent(on: row).columns
                for header in (0..<row).reversed() {
                    let candidate = leadingIndent(on: header)
                    if !candidate.blank, candidate.columns < columns,
                       let fold = foldRange(line: header), NSLocationInRange(selection.location, fold.hidden) {
                        next.append(fold)
                        break
                    }
                }
            }
        }
        setFolds(next)
    }

    func unfold(line: Int) {
        let header = lineRange(line).location
        setFolds(folds.filter { $0.header != header })
    }

    func unfoldSelections() {
        for selection in sourceSelections { unfold(line: line(at: selection.location)); unfold(intersecting: selection) }
    }

    func unfold(intersecting range: NSRange) {
        guard !folds.isEmpty else { return }
        if range.length == 0 {
            guard let hidden = hiddenFold(at: range.location) else { return }
            setFolds(folds.filter { $0 != hidden })
        } else {
            setFolds(folds.filter { NSIntersectionRange($0.hidden, range).length == 0 })
        }
    }

    func fold(to level: Int) {
        guard level > 0 else { setFolds([]); return }
        var next: [TextFold] = []
        var row = 0
        while row < lineCount {
            let indent = leadingIndent(on: row)
            if !indent.blank, indent.columns / indentation.width == level - 1, let fold = foldRange(line: row) {
                next.append(fold)
                row = max(row + 1, line(at: NSMaxRange(fold.hidden)))
            } else { row += 1 }
        }
        setFolds(next)
    }

    private func foldRange(line: Int) -> TextFold? {
        guard line + 1 < lineCount else { return nil }
        let header = lineRange(line)
        let indent = leadingIndent(on: line)
        guard !indent.blank else { return nil }
        if let opener = blockOpener(on: line), let match = adjacentBracket(around: opener, searchLimit: source.length),
           let mate = match.mate, mate > opener {
            let start = NSMaxRange(header)
            let end = lineRange(self.line(at: mate)).location
            if end > start { return TextFold(hidden: NSRange(location: start, length: end - start), header: header.location) }
        }
        var last: Int?
        var row = line + 1
        while row < lineCount {
            let next = leadingIndent(on: row)
            if !next.blank {
                if next.columns <= indent.columns { break }
                last = row
            }
            row += 1
        }
        guard let last else { return nil }
        let start = NSMaxRange(header)
        let end = NSMaxRange(lineRange(last))
        return end > start ? TextFold(hidden: NSRange(location: start, length: end - start), header: header.location) : nil
    }

    func setFolds(_ values: [TextFold]) {
        var next: [TextFold] = []
        for fold in values.sorted(by: { $0.hidden.location == $1.hidden.location ? $0.hidden.length > $1.hidden.length : $0.hidden.location < $1.hidden.location }) {
            if let last = next.last, NSIntersectionRange(last.hidden, fold.hidden).length > 0 { continue }
            next.append(fold)
        }
        guard folds != next else { return }
        let previous = selections
        var invalidated = Set(folds).symmetricDifference(Set(next)).map { fold in
            NSRange(location: fold.header, length: NSMaxRange(fold.hidden) - fold.header)
        }
        if invalidated.count > 32, let first = invalidated.first {
            invalidated = [invalidated.dropFirst().reduce(first, NSUnionRange)]
        }
        folds = next
        for range in invalidated {
            layoutManager?.invalidateGlyphs(forCharacterRange: range, changeInLength: 0, actualCharacterRange: nil)
            layoutManager?.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
        }
        setSelections(previous)
        invalidateSyntax()
    }

    private func blockOpener(on line: Int) -> Int? {
        let range = contents(of: line)
        let text = source
        var end = NSMaxRange(range)
        while end > range.location, text.character(at: end - 1) == 32 || text.character(at: end - 1) == 9 { end -= 1 }
        guard end > range.location, [40, 91, 123].contains(text.character(at: end - 1)) else { return nil }
        return end - 1
    }

    func leadingIndent(on line: Int) -> (columns: Int, length: Int, blank: Bool) {
        let range = contents(of: line)
        let limit = NSMaxRange(range)
        var index = range.location, width = 0
        while index < limit {
            let unit = source.character(at: index)
            if unit == 32 { width += 1 }
            else if unit == 9 { width += indentation.width - width % indentation.width }
            else { break }
            index += 1
        }
        return (width, index - range.location, index == limit)
    }

    func displayColumn(at offset: Int) -> Int {
        let start = contents(of: line(at: offset)).location
        var column = 0, cursor = start
        let end = min(source.length, max(start, offset))
        if let columnCheckpoint, columnCheckpoint.lineStart == start, columnCheckpoint.offset <= end,
           columnCheckpoint.offset == end || source.rangeOfComposedCharacterSequence(at: columnCheckpoint.offset).location == columnCheckpoint.offset {
            cursor = columnCheckpoint.offset
            column = columnCheckpoint.column
        }
        while cursor < end {
            if source.character(at: cursor) == 9 { column += indentation.width - column % indentation.width }
            else { column += 1 }
            cursor = NSMaxRange(source.rangeOfComposedCharacterSequence(at: cursor))
        }
        columnCheckpoint = (start, end, column)
        return column
    }

    func offset(on line: Int, column: Int) -> Int {
        let range = contents(of: line)
        var cursor = range.location, current = 0
        while cursor < NSMaxRange(range), current < column {
            let next = current + (source.character(at: cursor) == 9 ? indentation.width - current % indentation.width : 1)
            if column < next { break }
            cursor = NSMaxRange(source.rangeOfComposedCharacterSequence(at: cursor))
            current = next
        }
        return cursor
    }

    func verticalOffset(from offset: Int, by direction: Int) -> Int {
        let column = displayColumn(at: offset)
        var row = line(at: offset) + direction
        while row >= 0, row < lineCount, isHidden(line: row) { row += direction }
        guard row >= 0, row < lineCount else { return offset }
        return self.offset(on: row, column: column)
    }

    func offset(at point: NSPoint) -> Int {
        guard let manager = layoutManager, let container = textContainer, source.length > 0 else { return 0 }
        let origin = textContainerOrigin
        let position = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
        var fraction: CGFloat = 0
        let index = manager.characterIndex(for: position, in: container, fractionOfDistanceBetweenInsertionPoints: &fraction)
        if index >= source.length { return visibleOffset(source.length) }
        let unit = source.rangeOfComposedCharacterSequence(at: index)
        return visibleOffset(fraction > 0.5 && source.character(at: index) != 10 ? NSMaxRange(unit) : unit.location)
    }

    func visibleParts(of range: NSRange) -> [NSRange] {
        guard !folds.isEmpty else { return [range] }
        var low = 0, high = folds.count
        while low < high {
            let mid = (low + high) / 2
            if NSMaxRange(folds[mid].hidden) <= range.location { low = mid + 1 } else { high = mid }
        }
        var parts: [NSRange] = []
        var offset = range.location
        let end = NSMaxRange(range)
        while low < folds.count, folds[low].hidden.location < end {
            let hidden = folds[low].hidden
            if hidden.location > offset {
                parts.append(NSRange(location: offset, length: hidden.location - offset))
            }
            offset = NSMaxRange(hidden)
            low += 1
        }
        if offset < end { parts.append(NSRange(location: offset, length: end - offset)) }
        return parts
    }

    func visibleRows(in rect: NSRect) -> [(line: Int, rect: NSRect, chars: NSRange)] {
        guard let layout = layoutManager, let container = textContainer else { return [] }
        let origin = textContainerOrigin
        let query = rect.offsetBy(dx: -origin.x, dy: -origin.y)
        let glyphs = layout.glyphRange(forBoundingRect: query, in: container)
        var rows: [(line: Int, rect: NSRect, chars: NSRange)] = []
        if glyphs.length > 0 {
            layout.enumerateLineFragments(forGlyphRange: glyphs) { lineRect, _, _, fragment, _ in
                let chars = layout.characterRange(forGlyphRange: fragment, actualGlyphRange: nil)
                let row = self.line(at: chars.location)
                if !self.isHidden(line: row), lineRect.height > 0 {
                    rows.append((row, lineRect.offsetBy(dx: origin.x, dy: origin.y), chars))
                }
            }
        }
        if layout.extraLineFragmentTextContainer != nil {
            let extra = layout.extraLineFragmentRect.offsetBy(dx: origin.x, dy: origin.y)
            let last = lineCount - 1
            if extra.intersects(rect), extra.height > 0, !isHidden(line: last), rows.last?.line != last {
                rows.append((last, extra, NSRange(location: source.length, length: 0)))
            }
        }
        return rows
    }

    func caretRect(at offset: Int) -> NSRect? {
        guard let layout = layoutManager, let container = textContainer, offset >= 0, offset <= source.length else { return nil }
        let origin = textContainerOrigin
        let height = layout.defaultLineHeight(for: font ?? sourceSettings.sourceFont)
        if offset == source.length, source.length == 0 || source.character(at: source.length - 1) == 10 {
            if layout.extraLineFragmentTextContainer != nil {
                let extra = layout.extraLineFragmentUsedRect
                return NSRect(x: container.lineFragmentPadding + origin.x, y: extra.minY + origin.y, width: spaceWidth, height: height)
            }
            if source.length == 0 { return NSRect(x: container.lineFragmentPadding + origin.x, y: origin.y, width: spaceWidth, height: height) }
        }
        guard source.length > 0 else { return nil }
        let prev = offset == source.length
        let glyph = layout.glyphIndexForCharacter(at: prev ? offset - 1 : offset)
        let fragment = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let position = layout.location(forGlyphAt: glyph)
        let width = layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).width
        return NSRect(x: fragment.minX + position.x + origin.x + (prev ? width : 0), y: fragment.minY + origin.y,
                      width: width > 0 ? width : spaceWidth, height: height)
    }
}

extension CodeTextView {
    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorageEditActions,
                     range editedRange: NSRange, changeInLength delta: Int) {
        if editedMask.contains(.editedCharacters), editedRange.location != NSNotFound {
            storageDidEdit(range: editedRange, delta: delta)
        }
    }

    func layoutManager(_ layoutManager: NSLayoutManager, lineSpacingAfterGlyphAt glyphIndex: Int,
                       withProposedLineFragmentRect rect: NSRect) -> CGFloat { layoutSpacing }

    func layoutManager(_ layoutManager: NSLayoutManager, shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>,
                       properties props: UnsafePointer<NSLayoutManager.GlyphProperty>, characterIndexes indexes: UnsafePointer<Int>,
                       font: NSFont, forGlyphRange range: NSRange) -> Int {
        guard !folds.isEmpty else { return 0 }
        var properties: [NSLayoutManager.GlyphProperty]?
        for index in 0..<range.length where hiddenFold(at: indexes[index]) != nil {
            if properties == nil { properties = Array(UnsafeBufferPointer(start: props, count: range.length)) }
            properties?[index] = .null
        }
        guard let properties else { return 0 }
        properties.withUnsafeBufferPointer {
            layoutManager.setGlyphs(glyphs, properties: $0.baseAddress!, characterIndexes: indexes, font: font, forGlyphRange: range)
        }
        return range.length
    }
}
