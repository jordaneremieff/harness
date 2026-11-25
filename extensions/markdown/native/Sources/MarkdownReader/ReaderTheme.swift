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

    typealias Components = (red: Int, green: Int, blue: Int)

    /// The base colour of each Catppuccin flavour from the shared palette that the build copies to
    /// themes/catppuccin.json in the bundle's resources.
    nonisolated static let bundledBases: [String: Components] = Bundle.main.resourceURL
        .flatMap { try? Data(contentsOf: $0.appendingPathComponent("themes/catppuccin.json")) }
        .map(bases) ?? [:]

    /// The `base` map of the palette's JSON: flavour names to `#rrggbb` colours.
    nonisolated static func bases(_ data: Data) -> [String: Components] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let base = object["base"] as? [String: String] else { return [:] }
        return base.compactMapValues { text in
            guard text.count == 7, text.hasPrefix("#"), let value = Int(text.dropFirst(), radix: 16) else { return nil }
            return (value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff)
        }
    }

    /// The base colour as 8-bit sRGB components: Latte in light, the chosen flavour in dark.
    nonisolated static func base(light: Bool, darkTheme: String, from bases: [String: Components] = bundledBases) -> Components? {
        bases[light ? "latte" : darkTheme] ?? (light ? nil : bases["frappe"])
    }

    nonisolated(unsafe) private static var darkTheme = "frappe"

    static var paper: NSColor {
        NSColor(name: nil) { appearance in
            let light = appearance.bestMatch(from: [.aqua, .darkAqua]) != .darkAqua
            guard let base = ReaderTheme.base(light: light, darkTheme: ReaderTheme.darkTheme) else { return .windowBackgroundColor }
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
