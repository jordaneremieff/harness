import Foundation

struct SyntaxCheckpoints {
    struct Mark {
        let offset: Int
        let state: SyntaxState
    }

    // Runs share fixed-size pages. Splicing at an edit preserves untouched line
    // states without moving every offset after the edit.
    private final class Page {
        var marks: [Mark]
        init(_ marks: [Mark]) { self.marks = marks }
    }

    private struct Run {
        let page: Page
        var indices: Range<Int>
        var delta: Int = 0

        var first: Int { offset(indices.lowerBound) }
        var last: Int { offset(indices.upperBound - 1) }
        func offset(_ i: Int) -> Int { page.marks[i].offset + delta }
        func mark(_ i: Int) -> Mark { Mark(offset: offset(i), state: page.marks[i].state) }

        func lowerBound(_ target: Int) -> Int {
            var low = indices.lowerBound
            var high = indices.upperBound
            while low < high {
                let mid = (low + high) / 2
                if offset(mid) < target { low = mid + 1 } else { high = mid }
            }
            return low
        }
    }

    private var valid: [Run] = [Run(page: Page([Mark(offset: 0, state: SyntaxState())]), indices: 0..<1)]
    private var candidate: [Run] = []
    var end: Mark { valid.last!.mark(valid.last!.indices.upperBound - 1) }

    func atOrBefore(_ offset: Int) -> Mark {
        let index = Self.firstRun(in: valid, endingAtOrAfter: offset)
        if index == valid.count { return end }
        let run = valid[index]
        if run.first <= offset { return run.mark(run.lowerBound(offset + 1) - 1) }
        let prior = valid[index - 1]
        return prior.mark(prior.indices.upperBound - 1)
    }

    mutating func edit(restart: Int, oldEnd: Int, delta: Int) {
        candidate = Self.suffix(of: candidate.isEmpty ? valid : candidate,
                                startingAt: max(oldEnd, restart + 1), shiftedBy: delta)
        let index = Self.firstRun(in: valid, endingAtOrAfter: restart)
        if index < valid.count {
            let end = valid[index].lowerBound(restart + 1)
            let keep = end > valid[index].indices.lowerBound
            if keep { valid[index].indices = valid[index].indices.lowerBound..<end }
            valid.removeSubrange((keep ? index + 1 : index)..<valid.count)
        }
    }

    mutating func record(_ offset: Int, _ state: SyntaxState) {
        guard offset > end.offset else { return }
        let last = valid.count - 1
        let run = valid[last]
        let used = run.indices.upperBound
        if used == run.page.marks.count && used < 128 {
            run.page.marks.append(Mark(offset: offset - run.delta, state: state))
            valid[last].indices = run.indices.lowerBound..<(used + 1)
        } else {
            valid.append(Run(page: Page([Mark(offset: offset, state: state)]), indices: 0..<1))
        }
        guard !candidate.isEmpty else { return }
        let index = Self.firstRun(in: candidate, endingAtOrAfter: offset)
        guard index < candidate.count else { candidate.removeAll(); return }
        let old = candidate[index]
        guard old.first <= offset else { return }
        let match = old.lowerBound(offset)
        if old.offset(match) == offset && old.page.marks[match].state == state {
            for var run in Self.suffix(of: candidate, startingAt: offset + 1) {
                // Coalesce short fragments near a repeatedly edited line.
                let previous = valid.count - 1
                let tail = valid[previous]
                if tail.indices.count + run.indices.count <= 128 {
                    let marks = tail.indices.map(tail.mark) + run.indices.map(run.mark)
                    run = Run(page: Page(marks), indices: marks.indices)
                    valid[previous] = run
                } else {
                    valid.append(run)
                }
            }
            candidate.removeAll()
        }
    }

    private static func firstRun(in runs: [Run], endingAtOrAfter offset: Int) -> Int {
        var low = 0
        var high = runs.count
        while low < high {
            let mid = (low + high) / 2
            if runs[mid].last < offset { low = mid + 1 } else { high = mid }
        }
        return low
    }

    private static func suffix(of runs: [Run], startingAt offset: Int, shiftedBy delta: Int = 0) -> [Run] {
        let start = firstRun(in: runs, endingAtOrAfter: offset)
        guard start < runs.count else { return [] }
        var result = Array(runs[start...])
        result[0].indices = result[0].lowerBound(offset)..<result[0].indices.upperBound
        if delta != 0 { for i in result.indices { result[i].delta += delta } }
        return result
    }
}
