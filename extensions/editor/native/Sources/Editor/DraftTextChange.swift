import Foundation

struct DraftTextChange: Equatable, Sendable {
    let range: NSRange
    let oldText: String
    let newText: String
    var delta: Int { newText.utf16.count - range.length }

    static func between(_ old: String, _ new: String) -> [Self] {
        if old.utf8.elementsEqual(new.utf8) { return [] }
        var diff = DraftDifference(a: Array(old.utf16), b: Array(new.utf16))
        let ranges = diff.edits(0..<diff.a.count, 0..<diff.b.count)
        return ranges.map { old, new in
            Self(range: NSRange(location: old.lowerBound, length: old.count),
                 oldText: String(decoding: diff.a[old], as: UTF16.self),
                 newText: String(decoding: diff.b[new], as: UTF16.self))
        }
    }

    static func map(_ range: NSRange, through changes: [Self]) -> NSRange {
        changes.reversed().reduce(range) { range, change in
            DraftCoordinateEdit(range: change.range, length: change.newText.utf16.count).map(range)
        }
    }
}

private struct DraftDifference {
    typealias Match = (Range<Int>, Range<Int>)
    let a: [UInt16]
    let b: [UInt16]
    private var budget = 1_200_000

    init(a: [UInt16], b: [UInt16]) { self.a = a; self.b = b }

    mutating func edits(_ old: Range<Int>, _ new: Range<Int>, anchorLines: Bool = true) -> [Match] {
        var first = 0, last = 0
        while first < min(old.count, new.count), a[old.lowerBound + first] == b[new.lowerBound + first] { first += 1 }
        if splitsScalar(a, old.lowerBound + first) || splitsScalar(b, new.lowerBound + first) { first -= 1 }
        while last < min(old.count, new.count) - first,
              a[old.upperBound - 1 - last] == b[new.upperBound - 1 - last] { last += 1 }
        if splitsScalar(a, old.upperBound - last) || splitsScalar(b, new.upperBound - last) { last -= 1 }
        let left = (old.lowerBound + first)..<(old.upperBound - last)
        let right = (new.lowerBound + first)..<(new.upperBound - last)
        if left.isEmpty && right.isEmpty { return [] }
        if left.isEmpty || right.isEmpty { return [(left, right)] }
        if let islands = matches(left, right) { return complement(islands, inside: (left, right)) }
        if anchorLines {
            let anchors = commonLines(left, right)
            if !anchors.isEmpty {
                let gaps = complement(anchors, inside: (left, right))
                return gaps.flatMap { edits($0.0, $0.1, anchorLines: false) }
            }
        }
        return [(left, right)]
    }

    private func splitsScalar(_ source: [UInt16], _ offset: Int) -> Bool {
        offset > 0 && offset < source.count && (0xdc00...0xdfff).contains(source[offset])
    }

    /// Bounded shortest-edit search. Trace size depends on the edit distance, not document size.
    private mutating func matches(_ old: Range<Int>, _ new: Range<Int>) -> [Match]? {
        let radius = 96
        guard abs(old.count - new.count) <= radius, budget > 0 else { return nil }
        let centre = radius + 1
        var farthest = Array(repeating: 0, count: radius * 2 + 3)
        var trace: [[Int]] = []
        for depth in 0...radius {
            for diagonal in stride(from: -depth, through: depth, by: 2) {
                let index = centre + diagonal
                let insert = diagonal == -depth || (diagonal != depth && farthest[index - 1] < farthest[index + 1])
                var x = insert ? farthest[index + 1] : farthest[index - 1] + 1
                var y = x - diagonal
                budget -= 1
                while x < old.count, y < new.count, a[old.lowerBound + x] == b[new.lowerBound + y] {
                    x += 1; y += 1; budget -= 1
                }
                guard budget > 0 else { return nil }
                farthest[index] = x
                if x >= old.count && y >= new.count {
                    return reconstruct(old, new, depth: depth, trace: trace, centre: centre)
                }
            }
            trace.append(farthest)
        }
        return nil
    }

    private func reconstruct(_ old: Range<Int>, _ new: Range<Int>, depth: Int, trace: [[Int]], centre: Int) -> [Match] {
        var x = old.count, y = new.count
        var runs: [Match] = []
        func record(_ fromX: Int, _ fromY: Int) {
            var p = old.lowerBound + fromX, q = new.lowerBound + fromY
            var endP = old.lowerBound + x, endQ = new.lowerBound + y
            if p < endP, splitsScalar(a, p) || splitsScalar(b, q) { p += 1; q += 1 }
            if p < endP, splitsScalar(a, endP) || splitsScalar(b, endQ) { endP -= 1; endQ -= 1 }
            if p < endP { runs.append((p..<endP, q..<endQ)) }
        }
        if depth > 0 {
            for d in stride(from: depth, through: 1, by: -1) {
                let diagonal = x - y, index = centre + diagonal
                let previous = trace[d - 1]
                let insert = diagonal == -d || (diagonal != d && previous[index - 1] < previous[index + 1])
                let previousK = diagonal + (insert ? 1 : -1)
                let previousX = previous[centre + previousK], previousY = previousX - previousK
                record(previousX + (insert ? 0 : 1), previousY + (insert ? 1 : 0))
                x = previousX; y = previousY
            }
        }
        record(0, 0)
        return runs.reversed()
    }

    private func complement(_ anchors: [Match], inside ranges: Match) -> [Match] {
        var a = ranges.0.lowerBound, b = ranges.1.lowerBound
        var gaps: [Match] = []
        for (x, y) in anchors {
            if a < x.lowerBound || b < y.lowerBound { gaps.append((a..<x.lowerBound, b..<y.lowerBound)) }
            a = x.upperBound; b = y.upperBound
        }
        if a < ranges.0.upperBound || b < ranges.1.upperBound { gaps.append((a..<ranges.0.upperBound, b..<ranges.1.upperBound)) }
        return gaps
    }

    /// Unique complete lines form stable islands even when the surrounding changes are too large to align.
    private func commonLines(_ old: Range<Int>, _ new: Range<Int>) -> [Match] {
        func lines(in units: [UInt16], range: Range<Int>) -> [(UInt64, Range<Int>)] {
            var rows: [(UInt64, Range<Int>)] = []
            var start: Int? = range.lowerBound == 0 || units[range.lowerBound - 1] == 10 ? range.lowerBound : nil
            var hash: UInt64 = 14695981039346656037
            for index in range {
                hash = (hash ^ UInt64(units[index])) &* 1099511628211
                if units[index] == 10 {
                    if let start { rows.append((hash, start..<(index + 1))) }
                    if rows.count > 24_000 { return [] }
                    start = index + 1
                    hash = 14695981039346656037
                }
            }
            return rows
        }
        let left = lines(in: a, range: old), right = lines(in: b, range: new)
        let count = Dictionary(left.map { ($0.0, 1) }, uniquingKeysWith: +)
        let indexed = Dictionary(right.map { ($0.0, $0.1) }, uniquingKeysWith: { _, _ in 0..<0 })
        let candidates = left.compactMap { hash, range -> Match? in
            guard count[hash] == 1, let counterpart = indexed[hash], !counterpart.isEmpty,
                  a[range].elementsEqual(b[counterpart]) else { return nil }
            return (range, counterpart)
        }
        // Keep a longest ordered subset, so moved lines cannot create crossing ranges.
        var tails: [Int] = [], previous = Array(repeating: -1, count: candidates.count)
        for i in candidates.indices {
            var lo = 0, hi = tails.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if candidates[tails[mid]].1.lowerBound < candidates[i].1.lowerBound { lo = mid + 1 } else { hi = mid }
            }
            if lo > 0 { previous[i] = tails[lo - 1] }
            if lo == tails.count { tails.append(i) } else { tails[lo] = i }
        }
        var result: [Match] = [], at = tails.last ?? -1
        while at >= 0 { result.append(candidates[at]); at = previous[at] }
        return result.reversed()
    }
}
