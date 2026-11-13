import AppKit
import MarkdownCore
import ReaderFeature

/// The Mac implementations of the reader's platform operations.
public enum MacPlatform {
    @MainActor
    public static func operations() -> ReaderPlatform {
        ReaderPlatform(
            copyText: { text in
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(text, forType: .string)
            },
            openExternal: { url in
                guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
                return NSWorkspace.shared.open(url)
            },
            reveal: { url in
                NSWorkspace.shared.activateFileViewerSelecting([url])
            },
            returnToTerminal: { origin in
                await returnToTerminal(origin, helper: TerminalFocusHelper.fromBundle())
            }
        )
    }

    /// Pane selection first, so that the right tab shows when the application comes forward;
    /// then activation of the already running application. Each runs once.
    @MainActor
    public static func returnToTerminal(_ origin: LaunchOrigin, helper: TerminalFocusHelper?) async -> TerminalReturnResult {
        let pane: PaneSelection
        if origin.exact == nil {
            pane = .unavailable("the open recorded no pane")
        } else if let helper {
            pane = await helper.focus(origin)
        } else {
            pane = .unavailable("this build has no pane helper")
        }
        return TerminalReturnResult(pane: pane, application: activateRunningApplication(origin))
    }

    /// Brings the running application of a launch origin to the front. It never launches one.
    @MainActor
    static func activateRunningApplication(_ origin: LaunchOrigin) -> ApplicationActivation {
        guard origin.isUsable else { return .failed("the window has no usable origin") }
        guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: origin.application.bundleId).first else {
            return .notRunning
        }
        return running.activate(options: [.activateAllWindows]) ? .activated : .failed("\(origin.terminal) did not accept activation")
    }
}
