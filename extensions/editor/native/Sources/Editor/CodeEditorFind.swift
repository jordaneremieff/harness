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

    var findSelections: [NSRange] { textView.sourceSelections }

    func selectFound(_ ranges: [NSRange], reveal: NSRange?) {
        textView.select(ranges, reveal: reveal)
    }

    func markFound(_ ranges: [NSRange], current: NSRange?) {
        let length = findText.length
        textView.foundRanges = ranges.filter { $0.location >= 0 && $0.location <= length && $0.length > 0 && $0.length <= length - $0.location }
            .sorted { $0.location < $1.location }
        textView.foundCurrent = current
        let stride = max(1, textView.lineCount / 600)
        textView.mapFindLines = Set(textView.foundRanges.map { textView.line(at: $0.location) / stride * stride }).sorted()
        textView.invalidateAdornment()
    }

    @discardableResult
    func replaceFound(_ ranges: [NSRange], with replacements: [String]) -> Bool {
        guard ranges.count == replacements.count else { return false }
        return textView.edit(zip(ranges, replacements).map { TextEdit(range: $0, replacement: $1) }, reveal: false)
    }
}
