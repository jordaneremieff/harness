import Foundation
import ReaderFeature

/// Exact source changes, independent of Markdown rendering and its bounded display comparisons.
enum LiveTextMerge {
    struct Change: Equatable, Sendable {
        var range: NSRange
        var expected: String
        var replacement: String
        var delta: Int { replacement.utf16.count - range.length }
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.range == rhs.range && exact(lhs.expected, rhs.expected) && exact(lhs.replacement, rhs.replacement)
        }
    }
    enum Outcome: Sendable { case merged([Change]); case conflict; case limited }

    private static let tokenLimit = 2048
    private static let hunkLimit = ReaderBridgeCodec.editLimit

    private struct DiffBudget {
        // A shared allowance for the worst case of the line and character diff calls.
        var remaining = 16 * 1024 * 1024
        mutating func reserve(_ old: Int, _ new: Int) -> Bool {
            guard old <= tokenLimit, new <= tokenLimit else { return false }
            let width = old + new, cost = width * width
            guard cost <= remaining else { return false }
            remaining -= cost
            return true
        }
    }

    private static func exact(_ lhs: String, _ rhs: String) -> Bool { lhs.utf8.elementsEqual(rhs.utf8) }

    static func merge(base: String, local: String, remote: String) -> Outcome {
        if exact(local, remote) || exact(base, remote) { return .merged([]) }
        var budget = DiffBudget()
        let left = changes(base, local, budget: &budget), right = changes(base, remote, budget: &budget)
        let localUnits = local as NSString
        var result: [Change] = [], consumed = 0, shift = 0
        for incoming in right.values {
            // The hunks in each trace are ordered and non-overlapping. Carry the shift from
            // preceding hunks forward, but compare a same-position insertion before consuming it.
            while consumed < left.values.count, NSMaxRange(left.values[consumed].range) <= incoming.range.location,
                  !intersects(left.values[consumed].range, incoming.range) {
                shift += left.values[consumed].delta
                consumed += 1
            }
            var overlap = consumed, same = false
            while overlap < left.values.count, left.values[overlap].range.location <= NSMaxRange(incoming.range) {
                let previous = left.values[overlap]
                if intersects(previous.range, incoming.range) {
                    guard !same, previous == incoming else { return left.exact && right.exact ? .conflict : .limited }
                    same = true
                }
                overlap += 1
            }
            if same { continue }
            var change = incoming; change.range.location += shift
            guard Range(change.range, in: local) != nil, exact(localUnits.substring(with: change.range), change.expected) else { return .limited }
            result.append(change)
        }
        return .merged(result)
    }

    private static func intersects(_ a: NSRange, _ b: NSRange) -> Bool {
        if a.length == 0 && b.length == 0 { return a.location == b.location }
        if a.length == 0 { return b.location < a.location && a.location < NSMaxRange(b) }
        if b.length == 0 { return a.location < b.location && b.location < NSMaxRange(a) }
        return NSIntersectionRange(a, b).length > 0
    }

    private static func changes(_ base: String, _ target: String, budget: inout DiffBudget) -> (values: [Change], exact: Bool) {
        guard !exact(base, target) else { return ([], true) }
        guard let old = lines(base), let new = lines(target), budget.reserve(old.count, new.count),
              let chunks = differences(old, new, limit: hunkLimit) else {
            return ([trimmed(base, target, offset: 0)], false)
        }
        var result: [Change] = [], exact = true
        for (index, chunk) in chunks.enumerated() {
            let from = chunk.expected, to = chunk.replacement
            // Every remaining chunk needs at least one slot, even if it cannot be refined.
            let available = hunkLimit - result.count - (chunks.count - index - 1)
            if budget.reserve(from.count, to.count),
               let refined = differences(from.map(String.init), to.map(String.init), limit: available) {
                for var change in refined {
                    change.range.location += chunk.range.location
                    result.append(change)
                }
            } else {
                result.append(trimmed(from, to, offset: chunk.range.location)); exact = false
            }
        }
        return (result, exact)
    }

    private static func lines(_ text: String) -> [String]? {
        var result: [String] = [], start = text.startIndex
        for index in text.indices where text[index] == "\n" || text[index] == "\r\n" {
            guard result.count < tokenLimit else { return nil }
            let end = text.index(after: index); result.append(String(text[start..<end])); start = end
        }
        if start < text.endIndex {
            guard result.count < tokenLimit else { return nil }
            result.append(String(text[start...]))
        }
        return result
    }

    private static func differences(_ old: [String], _ new: [String], limit: Int) -> [Change]? {
        // Compare integer identities inside the diff so long lines do not magnify its cost.
        var identities: [Data: Int] = [:]
        func id(_ part: String) -> Int {
            let bytes = Data(part.utf8)
            if let existing = identities[bytes] { return existing }
            let next = identities.count
            identities[bytes] = next
            return next
        }
        let before = old.map(id), after = new.map(id)
        let delta = after.difference(from: before)
        var removed = Set<Int>(), inserted = Set<Int>()
        for item in delta {
            switch item {
            case .remove(let index, _, _): removed.insert(index)
            case .insert(let index, _, _): inserted.insert(index)
            }
        }
        var i = 0, j = 0, offset = 0, result: [Change] = []
        while i < old.count || j < new.count {
            if removed.contains(i) || inserted.contains(j) {
                guard result.count < limit else { return nil }
                let start = offset
                var before = "", after = ""
                while i < old.count, removed.contains(i) { before += old[i]; offset += (old[i] as NSString).length; i += 1 }
                while j < new.count, inserted.contains(j) { after += new[j]; j += 1 }
                result.append(Change(range: NSRange(location: start, length: (before as NSString).length), expected: before, replacement: after))
            } else if i < old.count, j < new.count {
                offset += (old[i] as NSString).length; i += 1; j += 1
            } else { break }
        }
        return result
    }

    private static func trimmed(_ old: String, _ new: String, offset: Int) -> Change {
        var before = old[...], after = new[...], start = offset
        while let a = before.first, let b = after.first, exact(String(a), String(b)) { start += String(a).utf16.count; before.removeFirst(); after.removeFirst() }
        while let a = before.last, let b = after.last, exact(String(a), String(b)) { before.removeLast(); after.removeLast() }
        return Change(range: NSRange(location: start, length: before.utf16.count), expected: String(before), replacement: String(after))
    }
}
