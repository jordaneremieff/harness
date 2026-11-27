import AppKit
import ApplicationServices
import AppPaneCore

/// Starts the application when it is not running and finds or opens the window that the pane
/// shows. Every wait has a bound.
@MainActor
enum Opening {
    struct Failure: Error {
        var text: String
    }

    static func running(_ entry: AppEntry) async throws(Failure) -> NSRunningApplication {
        let url = URL(fileURLWithPath: entry.path).standardizedFileURL
        if let application = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.standardizedFileURL == url && !$0.isTerminated }) {
            return application
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        let application: NSRunningApplication
        do {
            application = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        } catch {
            throw Failure(text: "\(entry.name) did not start: \(error.localizedDescription)")
        }
        let deadline = Date().addingTimeInterval(20)
        while !application.isFinishedLaunching, Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
        return application
    }

    /// An existing window: the one whose title contains `title`, or the application's main
    /// window. An application without windows is asked to reopen, which usually opens one.
    static func existing(_ entry: AppEntry, pid: pid_t, title: String?) async throws(Failure) -> AXUIElement {
        var reopened = false
        let deadline = Date().addingTimeInterval(8)
        while true {
            let windows = DockedWindow.windows(of: pid)
            let application = AXUIElementCreateApplication(pid)
            let main = DockedWindow.element(application, kAXMainWindowAttribute)
            let focused = DockedWindow.element(application, kAXFocusedWindowAttribute)
            let candidates = windows.map { window in
                WindowCandidate(
                    title: DockedWindow.string(window, kAXTitleAttribute) ?? "",
                    standard: DockedWindow.string(window, kAXSubroleAttribute) == kAXStandardWindowSubrole,
                    main: main.map { CFEqual($0, window) } ?? false,
                    focused: focused.map { CFEqual($0, window) } ?? false,
                    minimized: DockedWindow.bool(window, kAXMinimizedAttribute),
                    taken: WindowLock.taken(pid: pid, window: window))
            }
            if let index = WindowCandidate.choose(candidates, title: title) { return windows[index] }
            if title == nil, candidates.contains(where: { $0.standard }) {
                throw Failure(text: "Every window of \(entry.name) is already in another pane.")
            }
            if let title, Date() >= deadline {
                throw Failure(text: "\(entry.name) has no free window whose title contains \"\(title)\".")
            }
            if !reopened, title == nil {
                reopened = true
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = false
                configuration.addsToRecentItems = false
                _ = try? await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: entry.path), configuration: configuration)
            }
            guard Date() < deadline else { throw Failure(text: "\(entry.name) shows no window that this pane can hold.") }
            try? await Task.sleep(for: .milliseconds(150))
        }
    }

    /// Finds the Accessibility window only after the pane has recorded its scripting identity.
    static func newAccessibilityWindow(_ entry: AppEntry, pid: pid_t, before: [AXUIElement], frame: CGRect) async throws(Failure) -> AXUIElement {
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            let fresh = DockedWindow.windows(of: pid).filter { window in
                !before.contains { CFEqual($0, window) } && DockedWindow.string(window, kAXSubroleAttribute) == kAXStandardWindowSubrole
            }
            if fresh.count == 1, let actual = DockedWindow.frame(of: fresh[0]), Geometry.close(frame, actual) { return fresh[0] }
            if fresh.count > 1 { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        throw Failure(text: "\(entry.name) opened a window that this pane could not identify in Accessibility.")
    }

    /// Restore focus only when the browser took it while it opened a window or tab.
    static func restoreFrontmost(_ previous: NSRunningApplication?, browser pid: pid_t) {
        if let previous, previous.processIdentifier != pid, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
            previous.activate(options: [])
        }
    }

    /// Gives the keyboard back to `previous` whenever the browser takes it within `duration`
    /// after it opened a window or a tab. A Chromium browser can activate itself a moment after
    /// it answers the request, which a single check right after the answer misses. The watch ends
    /// when the person clicks a window of the browser, or when `handed` reports that the pane
    /// gave the browser the keyboard itself.
    static func returnFocus(to previous: NSRunningApplication?, from pid: pid_t, within duration: TimeInterval = 1,
                            handed: @MainActor () -> Bool = { false }) async {
        guard let previous, previous.processIdentifier != pid, !previous.isTerminated else { return }
        let deadline = Date().addingTimeInterval(duration)
        while Date() < deadline {
            if handed() || clickedWindow(of: pid) { return }
            restoreFrontmost(previous, browser: pid)
            try? await Task.sleep(for: .milliseconds(50))
        }
        if !handed(), !clickedWindow(of: pid) { restoreFrontmost(previous, browser: pid) }
    }

    /// Whether the last click, within half a second, went to a window of the application.
    private static func clickedWindow(of pid: pid_t) -> Bool {
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        guard types.contains(where: { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) < 0.5 }) else { return false }
        let location = NSEvent.mouseLocation
        let pointer = CGPoint(x: location.x, y: (NSScreen.screens.first?.frame.height ?? 0) - location.y)
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
            .compactMap(ServerWindow.init)
        return windows.first { $0.layer == 0 && $0.bounds.contains(pointer) }?.owner == pid
    }
}

/// One pane per window: each pane holds an exclusive lock named after the window while it shows
/// it, and the lock ends with the process.
final class WindowLock {
    private let descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    deinit { close(descriptor) }

    static func path(pid: pid_t, number: CGWindowID) -> String {
        FileManager.default.temporaryDirectory.appendingPathComponent("app-pane-\(pid)-\(number).lock").path
    }

    static func take(pid: pid_t, number: CGWindowID) -> WindowLock? {
        let descriptor = open(path(pid: pid, number: number), O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { return nil }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return nil
        }
        return WindowLock(descriptor: descriptor)
    }

    /// Whether a pane holds the window now. Unlike `take`, it creates no lock file.
    static func held(pid: pid_t, number: CGWindowID) -> Bool {
        let descriptor = open(path(pid: pid, number: number), O_RDWR | O_CLOEXEC)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        return flock(descriptor, LOCK_EX | LOCK_NB) != 0
    }

    @MainActor
    static func taken(pid: pid_t, window: AXUIElement) -> Bool {
        guard let frame = DockedWindow.frame(of: window),
              let number = DockedWindow.windowNumber(pid: pid, frame: frame) else { return false }
        return take(pid: pid, number: number) == nil
    }
}
