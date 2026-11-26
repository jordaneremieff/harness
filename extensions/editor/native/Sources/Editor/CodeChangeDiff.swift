import Foundation

enum CodeChangeKind: Sendable, Equatable {
    case added, modified, deleted
}

struct CodeChangeMark: Sendable, Equatable {
    let line: Int
    let kind: CodeChangeKind
}

enum CodeChangeDiff {
    static func between(base: String, current: String) -> [CodeChangeMark] {
        let old = base.split(separator: "\n", omittingEmptySubsequences: false)
        let new = current.split(separator: "\n", omittingEmptySubsequences: false)
        func equal(_ a: Int, _ b: Int) -> Bool { old[a].utf8.elementsEqual(new[b].utf8) }
        var start = 0, oldEnd = old.count, newEnd = new.count
        while start < min(oldEnd, newEnd), equal(start, start) { start += 1 }
        while oldEnd > start, newEnd > start, equal(oldEnd - 1, newEnd - 1) { oldEnd -= 1; newEnd -= 1 }
        guard oldEnd > start || newEnd > start else { return [] }
        let a = oldEnd - start, b = newEnd - start
        let steps = script(a, b) { equal(start + $0, start + $1) }
        var result: [CodeChangeMark] = []
        func mark(_ first: Int, removed: Int, inserted: Int) {
            if inserted == 0 && removed > 0 {
                result.append(CodeChangeMark(line: max(0, min(first, new.count - 1)), kind: .deleted))
                return
            }
            for line in 0..<inserted {
                result.append(CodeChangeMark(line: first + line, kind: line < removed ? .modified : .added))
            }
        }
        if let steps {
            var line = start, removed = 0, inserted = 0
            for step in steps {
                switch step {
                case .equal:
                    mark(line, removed: removed, inserted: inserted)
                    line += inserted + 1
                    removed = 0; inserted = 0
                case .remove: removed += 1
                case .insert: inserted += 1
                }
            }
            mark(line, removed: removed, inserted: inserted)
        } else {
            mark(start, removed: a, inserted: b)
        }
        return result
    }

    private enum Step { case equal, remove, insert }

    private static func script(_ a: Int, _ b: Int, equal: (Int, Int) -> Bool) -> [Step]? {
        if a == 0 { return Array(repeating: .insert, count: b) }
        if b == 0 { return Array(repeating: .remove, count: a) }
        let depth = 192
        guard abs(a - b) <= depth else { return nil }
        let center = depth + 1
        var frontier = Array(repeating: 0, count: center * 2 + 1)
        var trace: [[Int]] = []
        // Bound both the number of candidate paths and line comparisons on a large rewrite.
        var budget = 1_200_000
        for d in 0...depth {
            if Task.isCancelled { return nil }
            trace.append(frontier)
            for diagonal in stride(from: -d, through: d, by: 2) {
                let slot = center + diagonal
                let down = diagonal == -d || (diagonal != d && frontier[slot - 1] < frontier[slot + 1])
                var x = down ? frontier[slot + 1] : frontier[slot - 1] + 1
                var y = x - diagonal
                while x < a, y < b, equal(x, y) {
                    x += 1; y += 1; budget -= 1
                    if budget == 0 { return nil }
                }
                frontier[slot] = x
                if x >= a, y >= b {
                    var steps: [Step] = []
                    var x = a, y = b
                    for depth in (0...d).reversed() {
                        let previous = trace[depth]
                        let diagonal = x - y, slot = center + diagonal
                        let down = diagonal == -depth || (diagonal != depth && previous[slot - 1] < previous[slot + 1])
                        let priorDiagonal = diagonal + (down ? 1 : -1)
                        let priorX = previous[center + priorDiagonal]
                        let priorY = priorX - priorDiagonal
                        while x > priorX, y > priorY { steps.append(.equal); x -= 1; y -= 1 }
                        if depth > 0 {
                            if down { steps.append(.insert); y -= 1 }
                            else { steps.append(.remove); x -= 1 }
                        }
                    }
                    return steps.reversed()
                }
            }
        }
        return nil
    }
}
