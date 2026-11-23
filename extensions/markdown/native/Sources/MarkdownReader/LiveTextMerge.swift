import Foundation

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

    private static func exact(_ lhs: String, _ rhs: String) -> Bool { lhs.utf8.elementsEqual(rhs.utf8) }

    static func merge(base: String, local: String, remote: String) -> Outcome {
        if exact(local, remote) || exact(base, remote) { return .merged([]) }
        let left = changes(base, local), right = changes(base, remote)
        var result: [Change] = []
        for incoming in right.values {
            let collisions = left.values.filter { intersects($0.range, incoming.range) }
            if collisions.count == 1, collisions[0] == incoming { continue }
            guard collisions.isEmpty else { return left.exact && right.exact ? .conflict : .limited }
            let shift = left.values.filter { $0.range.location + $0.range.length <= incoming.range.location }.reduce(0) { $0 + $1.delta }
            var change = incoming; change.range.location += shift
            guard Range(change.range, in: local) != nil, exact((local as NSString).substring(with: change.range), change.expected) else { return .limited }
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

    private static func changes(_ base: String, _ target: String) -> (values: [Change], exact: Bool) {
        guard !exact(base, target) else { return ([], true) }
        let old = lines(base), new = lines(target)
        guard old.count <= 2048, new.count <= 2048 else { return ([trimmed(base, target, offset: 0)], false) }
        let chunks = differences(old, new)
        var result: [Change] = [], exact = true
        for chunk in chunks {
            let from = chunk.expected, to = chunk.replacement
            if from.count <= 2048, to.count <= 2048 {
                result += differences(from.map(String.init), to.map(String.init)).map {
                    var value = $0; value.range.location += chunk.range.location; return value
                }
            } else {
                result.append(trimmed(from, to, offset: chunk.range.location)); exact = false
            }
        }
        return (result, exact)
    }

    private static func lines(_ text: String) -> [String] {
        var result: [String] = [], start = text.startIndex
        for index in text.indices where text[index] == "\n" || text[index] == "\r\n" {
            let end = text.index(after: index); result.append(String(text[start..<end])); start = end
        }
        if start < text.endIndex { result.append(String(text[start...])) }
        return result
    }

    private static func differences(_ old: [String], _ new: [String]) -> [Change] {
        let delta = new.difference(from: old, by: exact)
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
