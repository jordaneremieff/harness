import AppKit
import Observation
import ReaderFeature

/// The native paper behind the page. The page draws its own Catppuccin colours; the paper shows
/// while a page loads or resizes and around a pane, so it takes the base colour of the same flavour:
/// Latte in the light appearance and the chosen flavour in the dark one. The saved appearance
/// choice also sets the application's appearance, so the paper, the web view's colour scheme and
/// the page's own choice always agree.
@MainActor
enum ReaderTheme {
    static let changed = Notification.Name("MarkdownReaderThemeChanged")

    /// Catppuccin base colours, as 8-bit sRGB components.
    static func base(light: Bool, darkTheme: String) -> (red: Int, green: Int, blue: Int) {
        if light { return (239, 241, 245) }
        switch darkTheme {
        case "macchiato": return (36, 39, 58)
        case "mocha": return (30, 30, 46)
        default: return (48, 52, 70)
        }
    }

    nonisolated(unsafe) private static var darkTheme = "frappe"

    static var paper: NSColor {
        NSColor(name: nil) { appearance in
            let light = appearance.bestMatch(from: [.aqua, .darkAqua]) != .darkAqua
            let base = ReaderTheme.base(light: light, darkTheme: ReaderTheme.darkTheme)
            return NSColor(srgbRed: CGFloat(base.red) / 255, green: CGFloat(base.green) / 255, blue: CGFloat(base.blue) / 255, alpha: 1)
        }
    }

    /// The application appearance for a saved choice; `system` follows the system.
    static func appearance(for choice: String) -> NSAppearance? {
        switch choice {
        case "light": NSAppearance(named: .aqua)
        case "dark": NSAppearance(named: .darkAqua)
        default: nil
        }
    }

    /// Applies the saved choice now and after each change. Check modes pass `setsAppearance: false`
    /// so the appearance their options chose stays in force.
    static func follow(_ state: ReadingStateStore, setsAppearance: Bool) {
        let (choice, flavour) = withObservationTracking { (state.appearance, state.darkTheme) } onChange: {
            Task { @MainActor in follow(state, setsAppearance: setsAppearance) }
        }
        darkTheme = flavour
        if setsAppearance, NSApp.appearance?.name != appearance(for: choice)?.name { NSApp.appearance = appearance(for: choice) }
        NotificationCenter.default.post(name: changed, object: nil)
    }
}
