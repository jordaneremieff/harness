import Foundation

/// An ordered tree of LF-delimited line lengths. Subtree totals locate a line by
/// rank or character offset without rewriting the starts of all later lines.
final class TextLineIndex {
    private final class Node {
        var width: Int
        let priority: UInt64
        var left: Node?
        var right: Node?
        var count = 1
        var length: Int

        init(_ width: Int, priority: UInt64) {
            self.width = width
            self.priority = priority
            length = width
        }

        func measure() {
            count = 1 + (left?.count ?? 0) + (right?.count ?? 0)
            length = width + (left?.length ?? 0) + (right?.length ?? 0)
        }
    }

    private var root: Node?
    private var generator: UInt64 = 0
    var count: Int { root?.count ?? 1 }

    init(_ source: NSString) {
        root = build(Self.widths(in: source, from: 0, to: source.length, includeLast: true))
    }

    func line(at offset: Int) -> Int {
        guard let root else { return 0 }
        if offset >= root.length { return root.count - 1 }
        var node: Node? = root
        var rank = 0
        var distance = max(0, offset)
        while let here = node {
            let left = here.left?.length ?? 0
            if distance < left { node = here.left }
            else {
                rank += here.left?.count ?? 0
                if distance < left + here.width { return rank }
                distance -= left + here.width
                rank += 1
                node = here.right
            }
        }
        return min(rank, root.count - 1)
    }

    func range(of line: Int) -> NSRange {
        var node = root
        var rank = min(max(0, line), count - 1)
        var offset = 0
        while let here = node {
            let left = here.left?.count ?? 0
            if rank < left { node = here.left }
            else {
                offset += here.left?.length ?? 0
                if left == rank { return NSRange(location: offset, length: here.width) }
                offset += here.width
                rank -= left + 1
                node = here.right
            }
        }
        return NSRange(location: offset, length: 0)
    }

    func applyEdit(in source: NSString, range: NSRange, delta: Int) {
        let first = line(at: range.location)
        let last = line(at: NSMaxRange(range) - delta)
        if first == last, !(range.location..<NSMaxRange(range)).contains(where: { source.character(at: $0) == 10 }) {
            if delta != 0 { Self.adjust(root, line: first, delta: delta) }
            return
        }
        let start = self.range(of: first).location
        let end = NSMaxRange(self.range(of: last)) + delta
        let replacement = build(Self.widths(in: source, from: start, to: end, includeLast: last == count - 1))
        let (before, tail) = Self.split(root, at: first)
        let (_, after) = Self.split(tail, at: last - first + 1)
        root = Self.merge(Self.merge(before, replacement), after)
    }

    private static func widths(in source: NSString, from start: Int, to end: Int, includeLast: Bool) -> [Int] {
        var widths: [Int] = []
        var cursor = start, line = start
        let capacity = min(4096, end - start)
        if capacity > 0 {
            withUnsafeTemporaryAllocation(of: UInt16.self, capacity: capacity) { units in
                while cursor < end {
                    let size = min(capacity, end - cursor)
                    source.getCharacters(units.baseAddress!, range: NSRange(location: cursor, length: size))
                    for i in 0..<size where units[i] == 10 {
                        let next = cursor + i + 1
                        widths.append(next - line)
                        line = next
                    }
                    cursor += size
                }
            }
        }
        if includeLast { widths.append(end - line) }
        return widths
    }

    private func build(_ widths: [Int]) -> Node? {
        var spine: [Node] = []
        // The Cartesian tree of random priorities builds the initial file in linear time.
        for width in widths {
            generator &+= 0x9e3779b97f4a7c15
            var bits = generator
            bits = (bits ^ (bits >> 30)) &* 0xbf58476d1ce4e5b9
            bits = (bits ^ (bits >> 27)) &* 0x94d049bb133111eb
            let node = Node(width, priority: bits ^ (bits >> 31))
            while let last = spine.last, node.priority > last.priority {
                last.measure()
                node.left = spine.removeLast()
            }
            spine.last?.right = node
            spine.append(node)
        }
        for node in spine.reversed() { node.measure() }
        return spine.first
    }

    private static func adjust(_ node: Node?, line: Int, delta: Int) {
        guard let node else { return }
        let left = node.left?.count ?? 0
        if line < left { adjust(node.left, line: line, delta: delta) }
        else if line > left { adjust(node.right, line: line - left - 1, delta: delta) }
        else { node.width += delta }
        node.measure()
    }

    private static func split(_ node: Node?, at index: Int) -> (Node?, Node?) {
        guard let node else { return (nil, nil) }
        let before = node.left?.count ?? 0
        if index <= before {
            let (first, rest) = split(node.left, at: index)
            node.left = rest
            node.measure()
            return (first, node)
        }
        let (first, rest) = split(node.right, at: index - before - 1)
        node.right = first
        node.measure()
        return (node, rest)
    }

    private static func merge(_ left: Node?, _ right: Node?) -> Node? {
        guard let left else { return right }
        guard let right else { return left }
        if left.priority > right.priority {
            left.right = merge(left.right, right)
            left.measure()
            return left
        }
        right.left = merge(left, right.left)
        right.measure()
        return right
    }
}
