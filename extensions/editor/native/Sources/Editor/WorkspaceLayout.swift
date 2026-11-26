import AppKit

/// Geometry rules for the sidebar, the stage and the tab groups on it. Widths are in points.
enum WorkspaceLayout {
    static let minimumSidebar: CGFloat = 200
    static let minimumGroup: CGFloat = 220

    /// The least distance from the sidebar's line to the far edge of the pane.
    static func minimumStage(groups: Int = 1) -> CGFloat {
        groups < 2 ? 280 : WorkspaceDivider.reachAfter + 1 + 2 * minimumGroup + WorkspaceDivider.thickness
    }

    /// A pane this wide keeps the sidebar and the stage side by side. A narrower pane shows
    /// one of them at a time. Two groups on a stage do not change the answer: they share
    /// what the narrowest sidebar leaves.
    static func fitsBeside(pane: CGFloat) -> Bool { pane >= minimumSidebar + minimumStage() }

    /// The width of a sidebar before a person chooses one.
    static func standardSidebar(pane: CGFloat) -> CGFloat { min(320, max(252, (pane * 0.32).rounded())) }

    /// The widest sidebar that leaves a usable stage.
    static func maximumSidebar(pane: CGFloat, groups: Int = 1) -> CGFloat {
        max(minimumSidebar, pane - minimumStage(groups: groups))
    }

    /// The sidebar width in force. A narrow pane limits a chosen width without replacing it,
    /// so the choice returns when the pane has room again.
    static func sidebar(chosen: CGFloat?, pane: CGFloat, groups: Int = 1) -> CGFloat {
        min(max(minimumSidebar, chosen ?? standardSidebar(pane: pane)), maximumSidebar(pane: pane, groups: groups)).rounded()
    }

    /// A stage this wide has room for a second tab group.
    static func fitsTwoGroups(stage: CGFloat) -> Bool { stage >= 2 * minimumGroup + WorkspaceDivider.thickness }

    /// The width of the first of two groups for the share of the stage a person gave it. Each
    /// group keeps the minimum width while the stage has room for both.
    static func firstGroup(share: CGFloat, stage: CGFloat) -> CGFloat {
        let room = max(0, stage - WorkspaceDivider.thickness)
        let least = min(minimumGroup, (room / 2).rounded(.down))
        return min(max(least, (room * share).rounded()), room - least)
    }

    /// The place among resting tabs for a dragged tab whose leading edge is at `leading`. A tab
    /// gives way when the dragged one covers more than half of it, so a tab that has not moved
    /// keeps its place.
    static func slot(leading: CGFloat, widths: [CGFloat]) -> Int {
        var start: CGFloat = 0
        for (index, width) in widths.enumerated() {
            if leading <= start + width / 2 { return index }
            start += width
        }
        return widths.count
    }
}
