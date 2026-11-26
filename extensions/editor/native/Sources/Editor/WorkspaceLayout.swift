import AppKit

/// Geometry rules for the sidebar beside the stage. Widths are in points.
enum WorkspaceLayout {
    static let minimumSidebar: CGFloat = 200
    static let minimumStage: CGFloat = 280

    /// A pane this wide keeps the sidebar and the stage side by side. A narrower pane shows
    /// one of them at a time.
    static func fitsBeside(pane: CGFloat) -> Bool { pane >= minimumSidebar + minimumStage }

    /// The width of a sidebar before a person chooses one.
    static func standardSidebar(pane: CGFloat) -> CGFloat { min(320, max(252, (pane * 0.32).rounded())) }

    /// The widest sidebar that leaves a usable stage.
    static func maximumSidebar(pane: CGFloat) -> CGFloat { max(minimumSidebar, pane - minimumStage) }

    /// The sidebar width in force. A narrow pane limits a chosen width without replacing it,
    /// so the choice returns when the pane has room again.
    static func sidebar(chosen: CGFloat?, pane: CGFloat) -> CGFloat {
        min(max(minimumSidebar, chosen ?? standardSidebar(pane: pane)), maximumSidebar(pane: pane)).rounded()
    }
}
