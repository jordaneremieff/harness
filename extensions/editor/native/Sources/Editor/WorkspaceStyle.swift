import AppKit

/// Surfaces of the workspace. The workspace paints every surface itself: a system background
/// behind a scroll view takes a tint from the desktop picture that a plain fill does not, and
/// two regions with one role would then show two colours.
enum WorkspaceStyle {
    private static func tone(dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light }
    }

    /// Behind source text and pages.
    static let content = NSColor.textBackgroundColor
    /// Behind the toolbar, the sidebar, tab strips and the status line.
    static let chrome = tone(dark: NSColor(white: 0.17, alpha: 1), light: NSColor(white: 0.95, alpha: 1))
    static let line = NSColor.separatorColor
    /// Under the pointer.
    static let hover = tone(dark: NSColor(white: 1, alpha: 0.07), light: NSColor(white: 0, alpha: 0.05))
    /// A control that is on, or a press.
    static let engaged = tone(dark: NSColor(white: 1, alpha: 0.13), light: NSColor(white: 0, alpha: 0.1))
    /// Where a dragged tab will land.
    static var landing: NSColor { .controlAccentColor.withAlphaComponent(0.16) }
    static var landingEdge: NSColor { .controlAccentColor.withAlphaComponent(0.7) }
}
