import AppKit

struct SelectionCharacterIndex: Sendable {
    private struct Entry: Sendable {
        let start: Int
        let end: Int
        let excess: Int
    }

    private let entries: [Entry]

    init?(_ text: String) {
        var entries: [Entry] = []
        var offset = 0, excess = 0
        // Plain ASCII without CR has one UTF-16 code unit per grapheme.
        if !text.utf8.allSatisfy({ $0 < 128 && $0 != 13 }) {
            for character in text {
                if offset.isMultiple(of: 1024), Task.isCancelled { return nil }
                let width = character.utf16.count
                if width > 1 {
                    excess += width - 1
                    entries.append(Entry(start: offset, end: offset + width, excess: excess))
                }
                offset += width
            }
        }
        self.entries = entries
    }

    func count(in range: NSRange) -> Int? {
        guard let start = excess(before: range.location), let end = excess(before: NSMaxRange(range)) else { return nil }
        return range.length - (end - start)
    }

    private func excess(before offset: Int) -> Int? {
        var low = 0, high = entries.count
        while low < high {
            let mid = (low + high) / 2
            if entries[mid].end <= offset { low = mid + 1 } else { high = mid }
        }
        if low < entries.count, entries[low].start < offset { return nil }
        return low == 0 ? 0 : entries[low - 1].excess
    }
}

@MainActor
final class SelectionCharacterCount {
    private var task: Task<SelectionCharacterIndex?, Never>?
    private var index: SelectionCharacterIndex?
    private var generation = 0
    var onReady: (() -> Void)?

    func invalidate() {
        generation &+= 1
        task?.cancel()
        task = nil
        index = nil
    }

    func count(in storage: NSTextStorage, ranges: [NSRange]) -> Int? {
        let length = ranges.reduce(0) { $0 + $1.length }
        if length <= 4096 || index != nil {
            return ranges.reduce(0) { result, range in
                guard range.length > 0, NSMaxRange(range) <= storage.length else { return result }
                if let count = index?.count(in: range) { return result + count }
                // A programmatic selection can split a grapheme. Count that slice as text.
                return result + storage.mutableString.substring(with: range).count
            }
        }
        if task == nil {
            let snapshot = storage.string
            let generation = generation
            let task = Task.detached(priority: .userInitiated) { SelectionCharacterIndex(snapshot) }
            self.task = task
            Task { [weak self] in
                let ready = await task.value
                guard let self, self.generation == generation else { return }
                self.task = nil
                self.index = ready
                self.onReady?()
            }
        }
        return nil
    }
}
