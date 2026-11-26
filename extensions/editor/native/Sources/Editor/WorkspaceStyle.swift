import AppKit

extension Notification.Name {
    /// Posted after `WorkspaceStyle.theme` or `WorkspaceStyle.settings` changes. Views that keep a
    /// colour or a font outside `draw(_:)` apply the new one when they receive it.
    static let workspaceStyleDidChange = Notification.Name("WorkspaceStyleDidChange")
}

/// The look of the workspace: the theme of the current appearance and the base Editor settings.
/// The workspace paints every surface itself: a system background behind a scroll view takes a
/// tint from the desktop picture that a plain fill does not, and two regions with one role would
/// then show two colours.
@MainActor
enum WorkspaceStyle {
    static var theme = EditorTheme(palette: nil, flavour: "frappe")
    static var settings = EditorSettings()

    /// Applies a new look to every view of the app.
    static func apply(theme: EditorTheme, settings: EditorSettings) {
        self.theme = theme
        self.settings = settings
        NotificationCenter.default.post(name: .workspaceStyleDidChange, object: nil)
    }

    /// Behind source text and pages.
    static var content: NSColor { theme.editor }
    /// Behind the sidebar and tab strips.
    static var chrome: NSColor { theme.chrome }
    /// Behind the toolbar and the status line.
    static var bar: NSColor { theme.bar }
    static var line: NSColor { theme.line }
    /// Under the pointer.
    static var hover: NSColor { theme.hover }
    /// A control that is on, or a press.
    static var engaged: NSColor { theme.engaged }
    /// Where a dragged tab will land.
    static var landing: NSColor { theme.accent.withAlphaComponent(0.16) }
    static var landingEdge: NSColor { theme.accent.withAlphaComponent(0.7) }

    /// Text of the sidebar, tabs and status line at the interface size.
    static func interfaceFont(_ delta: CGFloat = 0, weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: max(9, settings.interfaceSize + delta), weight: weight)
    }
}
