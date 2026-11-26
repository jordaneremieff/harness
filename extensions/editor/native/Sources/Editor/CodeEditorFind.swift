import AppKit

/// What Find and Replace act on: the text of one open file, its selections and the marks of
/// found text. Edits through it are one undo step and reach the shared draft like typing.
@MainActor
protocol FindTarget: AnyObject {
    /// The current text, in UTF-16 offsets.
    var findText: NSString { get }
    /// Every selection, in document order.
    var findSelections: [NSRange] { get }
    /// Selects the ranges, as several selections when there are more than one, and scrolls
    /// `reveal` into view.
    func selectFound(_ ranges: [NSRange], reveal: NSRange?)
    /// Marks found ranges, and `current` more strongly; an empty list clears the marks.
    func markFound(_ ranges: [NSRange], current: NSRange?)
    /// Replaces each range with its string in one undo step. Returns false when the text view
    /// refuses the change.
    @discardableResult
    func replaceFound(_ ranges: [NSRange], with replacements: [String]) -> Bool
}

extension CodeEditor: FindTarget {
    var findText: NSString { textView.textStorage?.mutableString ?? "" }

    var findSelections: [NSRange] { textView.selectedRanges.map(\.rangeValue) }

    func selectFound(_ ranges: [NSRange], reveal: NSRange?) {
        guard !ranges.isEmpty else { return }
        textView.selectedRanges = ranges.map { NSValue(range: $0) }
        if let reveal { textView.scrollRangeToVisible(reveal); textView.showFindIndicator(for: reveal) }
    }

    func markFound(_ ranges: [NSRange], current: NSRange?) {
        guard let layout = textView.layoutManager, let length = textView.textStorage?.length else { return }
        layout.removeTemporaryAttribute(.backgroundColor, forCharacterRange: NSRange(location: 0, length: length))
        let theme = WorkspaceStyle.theme
        for range in ranges where NSMaxRange(range) <= length {
            layout.addTemporaryAttribute(.backgroundColor, value: range == current ? theme.findCurrent : theme.findMatch, forCharacterRange: range)
        }
    }

    @discardableResult
    func replaceFound(_ ranges: [NSRange], with replacements: [String]) -> Bool {
        guard ranges.count == replacements.count, !ranges.isEmpty, let storage = textView.textStorage else { return false }
        let order = ranges.indices.sorted { ranges[$0].location > ranges[$1].location }
        guard textView.shouldChangeText(inRanges: ranges.map { NSValue(range: $0) }, replacementStrings: replacements) else { return false }
        storage.beginEditing()
        for index in order { storage.replaceCharacters(in: ranges[index], with: CodeTextView.unixNewlines(replacements[index])) }
        storage.endEditing()
        textView.didChangeText()
        return true
    }
}
