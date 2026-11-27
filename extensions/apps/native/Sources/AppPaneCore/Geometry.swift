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

    /// Where a window of `size` waits while its pane is not on screen: one point inside a bottom
    /// corner of a screen, so that almost all of it lies outside every screen and it never appears
    /// over another tab or on a neighbouring display. The screen that holds `near` comes first,
    /// and its bottom right corner before its bottom left one. Nil when every corner would put
    /// part of the window on a screen. All rectangles use Accessibility coordinates.
    public static func parkingOrigin(size: CGSize, near: CGRect, screens: [CGRect]) -> CGPoint? {
        let ordered = screens.filter { $0.intersects(near) } + screens.filter { !$0.intersects(near) }
        for screen in ordered {
            for origin in [CGPoint(x: screen.maxX - 1, y: screen.maxY - 1), CGPoint(x: screen.minX + 1 - size.width, y: screen.maxY - 1)] {
                let window = CGRect(origin: origin, size: size)
                let shown = screens.reduce(CGFloat(0)) { total, screen in
                    let part = window.intersection(screen)
                    return part.isNull ? total : total + part.width * part.height
                }
                if shown <= 1.5 { return origin }
            }
        }
        return nil
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

/// Whether a window that the pane asked to fill a frame did so.
public enum Docking: Equatable, Sendable {
    /// The window fills the frame.
    case filled
    /// The window stays at the frame's place with a size of its own that is larger in some
    /// direction, as an application with a minimum window size does.
    case limited
    /// The window is somewhere else, for example because the application did not answer or
    /// applied the request later; the pane asks again.
    case missed

    /// Whether `frame` shows a size limit of the window's own after `requests` requests for
    /// `target`: two requests ended at the target's place with a larger size, and that size is
    /// not the window's size `before` the target changed, which a request that never reached the
    /// application would leave.
    public static func limitConfirmed(_ frame: CGRect, target: CGRect, before: CGRect?, requests: Int) -> Bool {
        guard requests >= 2, check(frame, target: target) == .limited else { return false }
        guard let before else { return true }
        return abs(frame.width - before.width) > 1 || abs(frame.height - before.height) > 1
    }

    public static func check(_ frame: CGRect, target: CGRect) -> Docking {
        if Geometry.close(frame, target) { return .filled }
        let placed = abs(frame.minX - target.minX) <= 1 && abs(frame.minY - target.minY) <= 1
        let width = abs(frame.width - target.width) <= 1 || frame.width > target.width
        let height = abs(frame.height - target.height) <= 1 || frame.height > target.height
        return placed && width && height ? .limited : .missed
    }
}

/// One window as the window server lists it. Bounds use the window server's coordinates: origin
/// at the top left of the primary screen, y downwards.
public struct ServerWindow: Equatable, Sendable {
    public var number: CGWindowID
    public var owner: pid_t
    public var layer: Int
    public var bounds: CGRect
    public var onScreen: Bool

    public init(number: CGWindowID, owner: pid_t, layer: Int = 0, bounds: CGRect, onScreen: Bool = true) {
        self.number = number
        self.owner = owner
        self.layer = layer
        self.bounds = bounds
        self.onScreen = onScreen
    }

    /// Reads one record of `CGWindowListCopyWindowInfo`.
    public init?(_ record: [String: Any]) {
        guard let number = (record[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let owner = (record[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let layer = (record[kCGWindowLayer as String] as? NSNumber)?.intValue,
              let bounds = record[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
        self.init(number: number, owner: owner, layer: layer, bounds: rect,
                  onScreen: (record[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false)
    }
}
