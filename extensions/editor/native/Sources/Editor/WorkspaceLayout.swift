import AppKit

enum WorkspaceArrangement: String, Codable, CaseIterable {
    case single, columns2, columns3, columns4, rows2, rows3, grid

    var columns: Int {
        switch self {
        case .single, .rows2, .rows3: 1
        case .columns2, .grid: 2
        case .columns3: 3
        case .columns4: 4
        }
    }

    var rows: Int {
        switch self {
        case .rows2, .grid: 2
        case .rows3: 3
        default: 1
        }
    }

    var count: Int { columns * rows }

    func expanding(to count: Int, preferRows: Bool) -> Self {
        guard self.count != count else { return self }
        return switch count {
        case 2: preferRows ? .rows2 : .columns2
        case 3: preferRows ? .rows3 : .columns3
        case 4: preferRows || self == .rows3 ? .grid : .columns4
        default: .single
        }
    }
}

/// Geometry rules for the sidebar, the stage and the tab groups on it. Widths are in points.
enum WorkspaceLayout {
    static let minimumSidebar: CGFloat = 200
    static let minimumGroup: CGFloat = 220
    static let minimumRow: CGFloat = 110

    private static func minimumStage(columns: Int) -> CGFloat {
        columns < 2 ? 280 : WorkspaceDivider.reachAfter + 1 + CGFloat(columns) * minimumGroup
            + CGFloat(columns - 1) * WorkspaceDivider.thickness
    }

    /// A narrower pane shows either the sidebar or the stage at a time.
    static func fitsBeside(pane: CGFloat) -> Bool { pane >= minimumSidebar + minimumStage(columns: 1) }

    static func standardSidebar(pane: CGFloat) -> CGFloat { min(320, max(252, (pane * 0.32).rounded())) }

    static func maximumSidebar(pane: CGFloat, groups: Int = 1) -> CGFloat {
        max(minimumSidebar, pane - minimumStage(columns: groups))
    }

    /// A tight pane limits a chosen width without replacing it.
    static func sidebar(chosen: CGFloat?, pane: CGFloat, groups: Int = 1) -> CGFloat {
        min(max(minimumSidebar, chosen ?? standardSidebar(pane: pane)), maximumSidebar(pane: pane, groups: groups)).rounded()
    }

    static func fitsTwoGroups(stage: CGFloat) -> Bool { stage >= 2 * minimumGroup + WorkspaceDivider.thickness }

    /// A set of bands along one axis. The stored cuts divide only the space available to bands;
    /// a divider's hit area sits between successive bands and is not part of the stored ratio.
    struct Bands {
        let count: Int
        let gutter: CGFloat
        let room: CGFloat
        let least: CGFloat
        let cuts: [CGFloat]

        init(length: CGFloat, count: Int, minimum: CGFloat, choices: [Double]) {
            self.count = count
            let gutter = min(WorkspaceDivider.thickness, length / CGFloat(max(count * 2 - 1, 1)))
            let room = max(0, length - CGFloat(count - 1) * gutter)
            let least = min(minimum, (room / CGFloat(count)).rounded(.down))
            self.gutter = gutter
            self.room = room
            self.least = least
            var cuts: [CGFloat] = [0]
            for i in 1..<count {
                let choice = choices.count == count - 1 && choices[i - 1].isFinite ? choices[i - 1] : Double(i) / Double(count)
                let desired = (room * CGFloat(min(1, max(0, choice)))).rounded()
                cuts.append(min(max(cuts[i - 1] + least, desired), room - CGFloat(count - i) * least))
            }
            cuts.append(room)
            self.cuts = cuts
        }

        func band(_ index: Int) -> (origin: CGFloat, length: CGFloat) {
            (cuts[index] + CGFloat(index) * gutter, cuts[index + 1] - cuts[index])
        }

        func divider(_ index: Int) -> CGFloat { cuts[index + 1] + CGFloat(index) * gutter }

        func limits(_ index: Int) -> ClosedRange<CGFloat> {
            (cuts[index] + least)...max(cuts[index] + least, cuts[index + 2] - least)
        }

        func choice(at position: CGFloat, divider index: Int) -> Double? {
            guard room > 0 else { return nil }
            let target = position - min(WorkspaceDivider.reachBefore, gutter / 2) - CGFloat(index) * gutter
            let range = limits(index)
            return Double(min(max(range.lowerBound, target.rounded()), range.upperBound) / room)
        }
    }

    struct Stage {
        let columns: Bands
        let rows: Bands

        init(size: NSSize, arrangement: WorkspaceArrangement, weights: [Double]) {
            let horizontal = arrangement.columns - 1
            let valid = weights.count == horizontal + arrangement.rows - 1
            columns = Bands(length: size.width, count: arrangement.columns, minimum: minimumGroup,
                            choices: valid ? Array(weights.prefix(horizontal)) : [])
            rows = Bands(length: size.height, count: arrangement.rows, minimum: minimumRow,
                         choices: valid ? Array(weights.dropFirst(horizontal)) : [])
        }

        func group(_ index: Int) -> NSRect {
            let x = columns.band(index % columns.count)
            let y = rows.band(index / columns.count)
            return NSRect(x: x.origin, y: y.origin, width: x.length, height: y.length)
        }
    }

    /// A resting tab gives way when the dragged tab's leading edge passes its midpoint.
    static func slot(leading: CGFloat, widths: [CGFloat]) -> Int {
        var start: CGFloat = 0
        for (index, width) in widths.enumerated() {
            if leading <= start + width / 2 { return index }
            start += width
        }
        return widths.count
    }
}
