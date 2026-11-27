import CoreGraphics
import Foundation

/// One window in the browser's own order, which its scripting dictionary reports: the order in
/// which the browser chooses a window for a link from another application.
public struct BrowserWindow: Equatable, Sendable {
    /// The window's ID in the browser's scripting dictionary.
    public var id: String
    /// The frame in window-server coordinates.
    public var bounds: CGRect
    /// The window server shows the window: it is neither minimised nor hidden.
    public var drawn: Bool
    /// A pane shows the window.
    public var inPane: Bool

    public init(id: String, bounds: CGRect, drawn: Bool = true, inPane: Bool = false) {
        self.id = id
        self.bounds = bounds
        self.drawn = drawn
        self.inPane = inPane
    }
}

/// Which browser window receives the links that other applications send to the browser.
///
/// Chromium browsers and Safari open such a link in the first window of their own order, the
/// window that was active last. A window that a pane shows does not move up that order when the
/// operator works in the pane's tab, and a window that waits outside the screen for a hidden tab
/// can stay first. A pane on screen in the terminal window where the operator works therefore
/// puts its window first; any other pane whose window is first hands that place to a window on
/// screen, preferring one that no pane shows.
public enum LinkPolicy {
    public enum Action: Equatable, Sendable {
        case none
        /// Put this window first in the browser's order.
        case raise(String)
    }

    /// What one pane knows when it decides.
    public struct Situation: Sendable {
        /// The scripting ID of the window that the pane opened and shows.
        public var own: String
        /// The terminal window that shows the pane, while the pane is on screen.
        public var terminalWindow: CGWindowID?
        /// The terminal window where the operator works now.
        public var workingWindow: CGWindowID?
        public var browserActive: Bool
        /// The browser's windows in its own order, first to last.
        public var windows: [BrowserWindow]
        public var terminalBounds: CGRect?
        public var screens: [CGRect]

        public init(own: String, terminalWindow: CGWindowID?, workingWindow: CGWindowID?, browserActive: Bool,
                    windows: [BrowserWindow], terminalBounds: CGRect?, screens: [CGRect]) {
            self.own = own
            self.terminalWindow = terminalWindow
            self.workingWindow = workingWindow
            self.browserActive = browserActive
            self.windows = windows
            self.terminalBounds = terminalBounds
            self.screens = screens
        }
    }

    /// Area on screen, in square points, that makes a window visible whatever its size.
    static let visibleArea: CGFloat = 100 * 100

    /// Whether a window shows on a screen: half of it, or at least `visibleArea`, lies on one. A
    /// window that waits outside the screen for a hidden tab keeps one point inside its corner,
    /// while a window wider than its pane can reach past the screen's edge.
    public static func visible(_ bounds: CGRect, screens: [CGRect]) -> Bool {
        let area = bounds.width * bounds.height
        guard area > 0 else { return false }
        let shown = screens.reduce(CGFloat(0)) { total, screen in
            let part = bounds.intersection(screen)
            return part.isNull ? total : total + part.width * part.height
        }
        return shown >= min(area / 2, visibleArea)
    }

    /// The terminal window that the operator works in: the one under the pointer, or else the
    /// terminal's frontmost window. `terminal` lists the terminal application's windows on
    /// screen, front to back.
    public static func workingWindow(pointer: CGPoint, terminal: [ServerWindow]) -> CGWindowID? {
        let normal = terminal.filter { $0.layer == 0 && $0.onScreen }
        return (normal.first { $0.bounds.contains(pointer) } ?? normal.first)?.number
    }

    /// The step that keeps links where the operator works. While the browser is the active
    /// application the operator chooses its windows directly, so nothing changes. Another pane's
    /// window that the same terminal window shows keeps the first place, so the operator's own
    /// choice between two browser panes of one tab stands.
    public static func decide(_ situation: Situation) -> Action {
        guard !situation.browserActive, let first = situation.windows.first else { return .none }
        let isOwn: (BrowserWindow) -> Bool = { $0.id == situation.own }
        let onScreen: (BrowserWindow) -> Bool = { $0.drawn && visible($0.bounds, screens: situation.screens) }
        if let terminalWindow = situation.terminalWindow, situation.workingWindow == terminalWindow {
            if isOwn(first) { return .none }
            // A pane's window starts at its pane's top left corner; a window with a minimum size
            // larger than its pane reaches past the terminal window.
            if first.inPane, onScreen(first),
               let bounds = situation.terminalBounds, bounds.insetBy(dx: -2, dy: -2).contains(first.bounds.origin) {
                return .none
            }
            return situation.windows.first(where: isOwn).map { .raise($0.id) } ?? .none
        }
        guard isOwn(first) else { return .none }
        let others = situation.windows.dropFirst().filter { !isOwn($0) && onScreen($0) }
        guard let next = others.first(where: { !$0.inPane }) ?? others.first else { return .none }
        return .raise(next.id)
    }
}
