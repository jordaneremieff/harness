import Foundation
import MarkdownCore

/// Platform operations the reader needs. The host supplies them; the reader feature never calls
/// the operating system for these effects itself.
public struct ReaderPlatform: Sendable {
    public var copyText: @MainActor @Sendable (String) -> Void
    /// Opens a web address in the default browser after the reader obtained confirmation.
    public var openExternal: @MainActor @Sendable (URL) -> Bool
    /// Shows a file or folder in the file manager.
    public var reveal: @MainActor @Sendable (URL) -> Void
    /// Selects the origin's pane when possible, then brings the running terminal application to
    /// the front. It runs once and never retries.
    public var returnToTerminal: @MainActor @Sendable (LaunchOrigin) async -> TerminalReturnResult

    public init(
        copyText: @escaping @MainActor @Sendable (String) -> Void,
        openExternal: @escaping @MainActor @Sendable (URL) -> Bool,
        reveal: @escaping @MainActor @Sendable (URL) -> Void,
        returnToTerminal: @escaping @MainActor @Sendable (LaunchOrigin) async -> TerminalReturnResult
    ) {
        self.copyText = copyText
        self.openExternal = openExternal
        self.reveal = reveal
        self.returnToTerminal = returnToTerminal
    }
}
