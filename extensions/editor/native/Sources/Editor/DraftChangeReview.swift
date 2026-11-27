import AppKit

@MainActor
final class DraftChangeReview {
    struct Hunk {
        let span: TrackedDraftRange
        let before: String
        let after: String
    }

    let author: String
    let hunks: [Hunk]
    let id = UUID()
    let byteCount: Int
    let excerpts: [ReviewExcerpt]

    init(author: String, changes: [DraftTextChange], before: String, after: String, track: (NSRange) -> TrackedDraftRange) {
        self.author = author
        var shift = 0
        var bytes = 0
        let records = changes.map { change in
            let range = NSRange(location: change.range.location + shift, length: change.newText.utf16.count)
            shift += change.delta
            bytes += change.oldText.utf8.count + change.newText.utf8.count
            return Hunk(span: track(range), before: change.oldText, after: change.newText)
        }
        hunks = records
        let snippets = ReviewExcerpt.make(before: before as NSString, after: after as NSString,
                                          locations: Array(zip(changes.map(\.range), records.map(\.span.range))))
        excerpts = snippets
        byteCount = bytes + snippets.reduce(0) { $0 + $1.before.text.utf8.count + $1.after.text.utf8.count }
    }

    func inverse(in source: NSString) -> [DraftTextChange]? {
        var result: [DraftTextChange] = []
        for hunk in hunks {
            let range = hunk.span.range
            guard hunk.span.intact, NSMaxRange(range) <= source.length,
                  source.substring(with: range).utf8.elementsEqual(hunk.after.utf8) else { return nil }
            result.append(DraftTextChange(range: range, oldText: hunk.after, newText: hunk.before))
        }
        return result
    }
}

extension CodeTextView {
    /// External edits use plain storage changes, not the input path that unfolds the range and
    /// adds an AppKit undo step. The caller records the inverse as one operation instead.
    func applyDraftChanges(_ changes: [DraftTextChange]) {
        guard let storage = textStorage, !changes.isEmpty else { return }
        let previous = selections
        let clip = enclosingScrollView?.contentView
        let origin = clip?.bounds.origin
        let top = visibleRows(in: visibleRect).first.map { ($0.chars.location, $0.rect.minY) }
        preserveEditedFolds = true
        for change in changes.reversed() { storage.replaceCharacters(in: change.range, with: change.newText) }
        preserveEditedFolds = false
        setSelections(previous.map { selection in
            let mapped = DraftTextChange.map(selection.range, through: changes)
            return selection.anchor <= selection.head ? TextSelection(mapped)
                : TextSelection(anchor: NSMaxRange(mapped), head: mapped.location)
        })
        if let clip, var next = origin {
            if let (offset, y) = top {
                let mapped = DraftTextChange.map(NSRange(location: offset, length: 0), through: changes).location
                if let caret = caretRect(at: visibleOffset(mapped)) { next.y += caret.minY - y }
            }
            clip.scroll(to: next)
            enclosingScrollView?.reflectScrolledClipView(clip)
        }
    }
}
