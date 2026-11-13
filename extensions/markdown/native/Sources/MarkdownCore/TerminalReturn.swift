import Foundation

/// The result of asking the terminal's helper to select the exact pane of an origin.
public enum PaneSelection: Sendable, Equatable {
    /// The terminal selected the pane and its tab. Nothing is known about the Mac window.
    case focused
    /// The original pane no longer exists; nothing else was selected.
    case stale(String)
    case unavailable(String)
}

public enum ApplicationActivation: Sendable, Equatable {
    case activated
    /// The application is not running; the reader does not launch it.
    case notRunning
    case failed(String)
}

/// What one Return action did: pane selection first, then application activation.
public struct TerminalReturnResult: Sendable, Equatable {
    public var pane: PaneSelection
    public var application: ApplicationActivation

    public init(pane: PaneSelection, application: ApplicationActivation) {
        self.pane = pane
        self.application = application
    }
}
