import CoreGraphics
import Foundation

/// Screen coordinates. AppKit places windows from the bottom left of the primary screen with y
/// upwards; Accessibility and the window server use the top left of the primary screen with y
/// downwards. Both use points.
public enum Geometry {
    /// A QuickDraw rectangle from an Apple event contains four native-endian signed 16-bit
    /// edges in top, left, bottom, right order, in the same coordinates as Accessibility.
    public static func quickDrawFrame(_ data: Data) -> CGRect? {
        guard data.count == 8 else { return nil }
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            func edge(_ offset: Int) -> Int { Int(raw.loadUnaligned(fromByteOffset: offset, as: Int16.self)) }
            let top = edge(0), left = edge(2), bottom = edge(4), right = edge(6)
            guard right > left, bottom > top else { return nil }
            return CGRect(x: left, y: top, width: right - left, height: bottom - top)
        }
    }

    public static func accessibilityRect(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    /// AppKit places windows on whole points; each edge goes to its nearest point, so the window
    /// covers the pane exactly when the terminal reports fractional edges.
    public static func snapped(_ rect: CGRect) -> CGRect {
        let minX = rect.minX.rounded(), minY = rect.minY.rounded()
        return CGRect(x: minX, y: minY, width: rect.maxX.rounded() - minX, height: rect.maxY.rounded() - minY)
    }

    /// Where a window waits while its pane is not on screen: its top left corner one point inside
    /// the bottom right corner of the screen, so that almost all of it lies outside every screen
    /// and it never appears over another tab. `screen` is in AppKit coordinates.
    public static func parkingOrigin(screen: CGRect, primaryHeight: CGFloat) -> CGPoint {
        CGPoint(x: screen.maxX - 1, y: primaryHeight - screen.minY - 1)
    }

    public static func close(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 1) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }
}

/// What the pane knows about one window of the application when it chooses a window to show.
public struct WindowCandidate: Equatable, Sendable {
    public var title: String
    public var standard: Bool
    public var main: Bool
    public var focused: Bool
    public var minimized: Bool
    /// Another pane already shows this window.
    public var taken: Bool

    public init(title: String, standard: Bool, main: Bool = false, focused: Bool = false, minimized: Bool = false, taken: Bool = false) {
        self.title = title
        self.standard = standard
        self.main = main
        self.focused = focused
        self.minimized = minimized
        self.taken = taken
    }

    /// The index of the window to show: with `title`, the first standard window whose title
    /// contains it; otherwise the main window, the focused window, the first window that is not
    /// minimised, or the first window, among standard windows that no other pane shows.
    public static func choose(_ candidates: [WindowCandidate], title: String?) -> Int? {
        let usable = candidates.indices.filter { candidates[$0].standard && !candidates[$0].taken }
        if let title {
            return usable.first { candidates[$0].title.localizedCaseInsensitiveContains(title) }
        }
        return usable.first { candidates[$0].main } ?? usable.first { candidates[$0].focused }
            ?? usable.first { !candidates[$0].minimized } ?? usable.first
    }
}
