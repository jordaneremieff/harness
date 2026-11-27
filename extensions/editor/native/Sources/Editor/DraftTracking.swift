import Foundation

/// The old range and new length of an edit, in the coordinate space at the time of the edit.
struct DraftCoordinateEdit {
    let range: NSRange
    let length: Int

    func map(_ target: NSRange) -> NSRange {
        let left = range.location, right = NSMaxRange(range)
        func point(_ offset: Int, after: Bool) -> Int {
            if offset < left { return offset }
            if right == left && offset == left { return left + (after ? length : 0) }
            if offset >= right { return offset + length - range.length }
            return left + min(offset - left, length)
        }
        if target.length == 0 { return NSRange(location: point(target.location, after: true), length: 0) }
        let start = point(target.location, after: true)
        let end = point(NSMaxRange(target), after: false)
        return NSRange(location: start, length: max(0, end - start))
    }

    /// A review hunk is still reversible if a later edit only changes text beside it.
    func intersects(_ target: NSRange) -> Bool {
        if range.length == 0 {
            if target.length == 0 { return target.location == range.location }
            return target.location < range.location && range.location < NSMaxRange(target)
        }
        if target.length == 0 { return range.location < target.location && target.location < NSMaxRange(range) }
        return NSIntersectionRange(range, target).length != 0
    }
}

@MainActor
final class TrackedDraftRange {
    fileprivate(set) var range: NSRange
    private(set) var intact = true

    init(_ range: NSRange) { self.range = range }

    func apply(_ edit: DraftCoordinateEdit) {
        intact = intact && !edit.intersects(range)
        range = edit.map(range)
    }
}

@MainActor
final class DraftRevisionMap {
    private struct Edge {
        let from: Int
        let to: Int
        let edits: [DraftCoordinateEdit]
    }

    private struct WeakRange { weak var value: TrackedDraftRange? }
    private var tracked: [WeakRange] = []
    private var tracksUntilSweep = 0
    private var edges: [Edge] = []
    private(set) var pending: [DraftCoordinateEdit] = []

    func track(_ range: NSRange) -> TrackedDraftRange {
        if tracksUntilSweep == 0 {
            tracked.removeAll { $0.value == nil }
            tracksUntilSweep = 64
        }
        tracksUntilSweep -= 1
        let span = TrackedDraftRange(range)
        tracked.append(WeakRange(value: span))
        return span
    }

    func edit(_ edit: DraftCoordinateEdit) {
        for reference in tracked { reference.value?.apply(edit) }
        pending.append(edit)
    }

    func commit(from: Int, to: Int, count: Int? = nil) {
        let count = count ?? pending.count
        guard count <= pending.count else { return }
        if from != to {
            edges.append(Edge(from: from, to: to, edits: Array(pending.prefix(count))))
            if edges.count > 32 { edges.removeFirst(edges.count - 32) }
            while edges.count > 1 && edges.reduce(0, { $0 + $1.edits.count }) > 20_000 { edges.removeFirst() }
        }
        pending.removeFirst(count)
    }

    func abandon() { edges.removeAll(); pending.removeAll() }

    func map(_ range: NSRange, from revision: Int, to current: Int) -> NSRange? {
        var value = range, rev = revision
        for edge in edges where rev != current && edge.from == rev {
            value = edge.edits.reduce(value) { $1.map($0) }
            rev = edge.to
        }
        guard rev == current else { return nil }
        return pending.reduce(value) { $1.map($0) }
    }
}

struct CodeThreadAnchor: Equatable {
    let id: String
    let doc: String
    let revision: Int
    let range: NSRange
    let quote: String?

    init?(_ fields: [String: Any]) {
        guard let id = fields["id"] as? String, let doc = fields["doc"] as? String, !doc.isEmpty,
              let revision = fields["rev"] as? Int, let start = fields["start"] as? Int,
              let end = fields["end"] as? Int, start >= 0 && end >= start else { return nil }
        self.id = id
        self.doc = doc
        self.revision = revision
        range = NSRange(location: start, length: end - start)
        quote = fields["quoteShortened"] as? Bool == true ? nil : fields["quote"] as? String
    }

    @MainActor func locate(in source: NSString, revision current: Int, map: DraftRevisionMap) -> NSRange? {
        if let mapped = map.map(range, from: revision, to: current), NSMaxRange(mapped) <= source.length {
            return mapped
        }
        // Without the intervening revisions, a unique literal match is the only safe live location.
        guard let quote, !quote.isEmpty, range.length == quote.utf16.count else { return nil }
        let match = source.range(of: quote, options: .literal)
        guard match.location != NSNotFound else { return nil }
        let first = source.rangeOfComposedCharacterSequence(at: match.location)
        let after = min(source.length, NSMaxRange(first))
        let tail = NSRange(location: after, length: source.length - after)
        return source.range(of: quote, options: .literal, range: tail).location == NSNotFound ? match : nil
    }
}
