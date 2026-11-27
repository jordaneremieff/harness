import AppKit

struct TextSelection: Equatable {
    var anchor: Int
    var head: Int

    init(anchor: Int, head: Int) {
        self.anchor = anchor
        self.head = head
    }

    init(_ range: NSRange) {
        self.init(anchor: range.location, head: NSMaxRange(range))
    }

    var range: NSRange { NSRange(location: min(anchor, head), length: abs(anchor - head)) }
}

struct TextEdit {
    let range: NSRange
    let replacement: String
    var selection: NSRange?

    static func caret(_ range: NSRange, _ replacement: String, at offset: Int? = nil) -> Self {
        Self(range: range, replacement: replacement, selection: NSRange(location: offset ?? replacement.utf16.count, length: 0))
    }
}

extension CodeTextView {
    var source: NSString { textStorage?.mutableString ?? "" }

    var selections: [TextSelection] {
        if let multiSelection { return multiSelection }
        return [directedSelection ?? TextSelection(selectedRange())]
    }

    var sourceSelections: [NSRange] { selections.map(\.range).sorted { $0.location < $1.location } }

    func select(_ values: [NSRange], reveal: NSRange? = nil) {
        if !folds.isEmpty {
            let ordered = values.sorted { $0.location < $1.location }
            var index = 0
            setFolds(folds.filter { fold in
                while index < ordered.count {
                    let end = NSMaxRange(ordered[index])
                    if end > fold.hidden.location || (end == fold.hidden.location && ordered[index].length == 0) { break }
                    index += 1
                }
                guard index < ordered.count else { return true }
                let range = ordered[index]
                return range.length == 0 ? !NSLocationInRange(range.location, fold.hidden)
                    : NSIntersectionRange(range, fold.hidden).length == 0
            })
        }
        if let reveal { unfold(intersecting: reveal) }
        let order = reveal.flatMap { value in values.firstIndex(of: value).map { index in
            values.enumerated().filter { $0.offset != index }.map(\.element) + [value]
        } } ?? values
        setSelections(order.map(TextSelection.init))
        if let reveal { scrollRangeToVisible(reveal) }
    }

    func setSelections(_ values: [TextSelection]) {
        let length = source.length
        let ordered = values.enumerated().compactMap { index, value -> (selection: TextSelection, index: Int)? in
            guard value.anchor <= length, value.head <= length, min(value.anchor, value.head) >= 0 else { return nil }
            return (TextSelection(anchor: visibleOffset(value.anchor), head: visibleOffset(value.head)), index)
        }.sorted {
            let a = $0.selection.range, b = $1.selection.range
            return a.location == b.location ? a.length > b.length : a.location < b.location
        }
        var merged: [(selection: TextSelection, index: Int)] = []
        for candidate in ordered {
            let b = candidate.selection.range
            if let last = merged.last {
                let a = last.selection.range
                if a == b || b.location < NSMaxRange(a) {
                    let range = NSUnionRange(a, b)
                    let newest = candidate.index > last.index ? candidate : last
                    let forward = newest.selection.head >= newest.selection.anchor
                    let union = forward ? TextSelection(range) : TextSelection(anchor: NSMaxRange(range), head: range.location)
                    merged[merged.count - 1] = (union, newest.index)
                    continue
                }
            }
            merged.append(candidate)
        }
        guard let top = merged.indices.max(by: { merged[$0].index < merged[$1].index }) else { return }
        let primary = merged.remove(at: top).selection
        _ = selectionPaint()
        multiSelection = merged.isEmpty ? nil : merged.map(\.selection) + [primary]
        directedSelection = primary
        settingSelections = true
        setSelectedRange(primary.range)
        settingSelections = false
        selectionChanged?()
    }

    func clearExtraSelections() {
        guard multiSelection != nil else { return }
        setSelections([TextSelection(selectedRange())])
    }

    @discardableResult
    func edit(_ proposed: [TextEdit], reveal: Bool = true) -> Bool {
        guard !proposed.isEmpty, let storage = textStorage, isEditable, !hasMarkedText() else { return false }
        let edits = proposed.sorted { $0.range.location < $1.range.location }
        var boundary = 0
        for item in edits {
            guard item.range.location >= boundary, NSMaxRange(item.range) <= storage.length else { return false }
            boundary = NSMaxRange(item.range)
        }
        for item in edits { unfold(intersecting: item.range) }
        let replacements = edits.map { Self.unixNewlines($0.replacement) }
        let previous = selections
        let explicitSelection = edits.contains { $0.selection != nil }
        let changed = zip(edits, replacements).map { !source.substring(with: $0.0.range).utf8.elementsEqual($0.1.utf8) }
        let changes = changed.contains(true)
        if changes {
            breakUndoCoalescing()
            finishInputUndo()
            let manager = undoManager
            manager?.beginUndoGrouping()
            defer { manager?.endUndoGrouping(); breakUndoCoalescing() }
            guard shouldChangeText(inRanges: edits.map { NSValue(range: $0.range) }, replacementStrings: replacements) else { return false }
            batchingCoordinates = true
            storage.beginEditing()
            for index in edits.indices.reversed() where changed[index] {
                storage.replaceCharacters(in: edits[index].range, with: replacements[index])
            }
            storage.endEditing()
            batchingCoordinates = false
            for index in edits.indices.reversed() where changed[index] {
                onCoordinateEdit?(DraftCoordinateEdit(range: edits[index].range, length: replacements[index].utf16.count))
            }
            didChangeText()
        }
        if explicitSelection {
            var delta = 0
            let next = zip(edits, replacements).map { item, replacement in
                let relative = item.selection ?? NSRange(location: replacement.utf16.count, length: 0)
                defer { delta += replacement.utf16.count - item.range.length }
                return NSRange(location: item.range.location + delta + relative.location, length: relative.length)
            }
            select(next, reveal: reveal ? next.last : nil)
        } else if changes {
            func mapped(_ offset: Int) -> Int {
                var shift = 0
                for (item, replacement) in zip(edits, replacements) {
                    let size = replacement.utf16.count
                    if offset < item.range.location { break }
                    if offset < NSMaxRange(item.range) { return item.range.location + shift + min(offset - item.range.location, size) }
                    shift += size - item.range.length
                }
                return offset + shift
            }
            setSelections(previous.map { TextSelection(anchor: mapped($0.anchor), head: mapped($0.head)) })
        }
        return true
    }

    private func isWordUnit(_ unit: unichar) -> Bool {
        if unit < 128 { return unit == 95 || (48...57).contains(unit) || (65...90).contains(unit) || (97...122).contains(unit) }
        return Unicode.Scalar(unit).map { wordCharacters.contains($0) } ?? false
    }

    func isWholeSourceWord(_ range: NSRange) -> Bool {
        let source = source
        let end = NSMaxRange(range)
        guard range.length > 0, range.location >= 0, end <= source.length,
              range.location == 0 || !isWordUnit(source.character(at: range.location - 1)),
              end == source.length || !isWordUnit(source.character(at: end)) else { return false }
        return (range.location..<end).allSatisfy { isWordUnit(source.character(at: $0)) }
    }

    func word(at offset: Int) -> NSRange? {
        let source = source
        guard source.length > 0 else { return nil }
        var lo = min(offset, source.length)
        var hi = lo
        while lo > 0, isWordUnit(source.character(at: lo - 1)) { lo -= 1 }
        while hi < source.length, isWordUnit(source.character(at: hi)) { hi += 1 }
        return lo < hi ? NSRange(location: lo, length: hi - lo) : nil
    }

    func selectOccurrence(skip: Bool = false, all: Bool = false) {
        var values = selections
        guard let primary = values.last else { return }
        let useWord = primary.range.length == 0 || occurrenceWord == source.substring(with: primary.range)
        guard let range = primary.range.length == 0 ? word(at: primary.head) : primary.range else { return }
        let needle = source.substring(with: range)
        guard !needle.isEmpty else { return }
        if primary.range.length == 0, !all {
            select([range], reveal: range)
            occurrenceWord = needle
            return
        }
        let source = source
        func next(in section: NSRange) -> NSRange? {
            var start = section.location
            while start < NSMaxRange(section) {
                let candidate = source.range(of: needle, options: .literal, range: NSRange(location: start, length: NSMaxRange(section) - start))
                if candidate.location == NSNotFound { return nil }
                if (!useWord || word(at: candidate.location) == candidate) &&
                    (all || !values.contains { NSIntersectionRange($0.range, candidate).length > 0 }) {
                    return candidate
                }
                start = NSMaxRange(candidate)
            }
            return nil
        }
        if all {
            var listed: [NSRange] = []
            var cursor = 0
            while let found = next(in: NSRange(location: cursor, length: source.length - cursor)) {
                listed.append(found)
                cursor = NSMaxRange(found)
            }
            select(listed)
        } else {
            let end = NSMaxRange(range)
            guard let found = next(in: NSRange(location: end, length: source.length - end)) ??
                next(in: NSRange(location: 0, length: range.location)) else { return }
            unfold(intersecting: found)
            if skip { values.removeLast() }
            values.append(TextSelection(found))
            setSelections(values)
            revealSourceRange(found)
        }
        occurrenceWord = useWord ? needle : nil
    }

    func remove(_ backwards: Bool) {
        let source = source
        let edits = sourceSelections.compactMap { selection -> TextEdit? in
            if selection.length > 0 { return .caret(selection, "") }
            let offset = selection.location
            if backwards, sourceSettings.autoClosePairs, let pair = pairedText(at: offset) { return .caret(pair, "") }
            guard backwards ? offset > 0 : offset < source.length else { return nil }
            return .caret(source.rangeOfComposedCharacterSequence(at: backwards ? offset - 1 : offset), "")
        }
        _ = edit(mergeDeletions(edits))
    }

    private func mergeDeletions(_ edits: [TextEdit]) -> [TextEdit] {
        var result: [TextEdit] = []
        for item in edits {
            if let last = result.last, NSIntersectionRange(last.range, item.range).length > 0 {
                result[result.count - 1] = .caret(NSUnionRange(last.range, item.range), "")
            } else { result.append(item) }
        }
        return result
    }

    func moveSelections(horizontal: Int = 0, vertical: Int = 0, extend: Bool) {
        let text = source
        let next = selections.map { selection -> TextSelection in
            var head = selection.head
            if horizontal != 0 {
                if !extend, selection.range.length > 0 {
                    head = horizontal < 0 ? selection.range.location : NSMaxRange(selection.range)
                } else if horizontal < 0, head > 0 {
                    head = text.rangeOfComposedCharacterSequence(at: head - 1).location
                } else if horizontal > 0, head < text.length {
                    head = NSMaxRange(text.rangeOfComposedCharacterSequence(at: head))
                }
                head = visibleOffset(head, forward: horizontal > 0)
            } else {
                head = verticalOffset(from: head, by: vertical)
            }
            return TextSelection(anchor: extend ? selection.anchor : head, head: head)
        }
        setSelections(next)
        if let last = next.last { scrollRangeToVisible(NSRange(location: last.head, length: 0)) }
    }

    func selectionLines() {
        select(sourceSelections.flatMap { selection in
            let first = line(at: selection.location)
            let last = line(at: max(selection.location, NSMaxRange(selection) - 1))
            return (first...last).map { NSIntersectionRange(selection, contents(of: $0)) }
        }.filter { $0.location != NSNotFound })
    }

    func addCaret(by direction: Int) {
        let head = selections.last?.head ?? 0
        let next = verticalOffset(from: head, by: direction)
        if next != head {
            setSelections(selections + [TextSelection(anchor: next, head: next)])
            scrollRangeToVisible(NSRange(location: next, length: 0))
        }
    }
}
