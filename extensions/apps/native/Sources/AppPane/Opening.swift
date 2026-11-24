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

    /// A new browser window, at `url` when given, opened by Apple Events. Returns the window and
    /// its scripting ID, which the browser's own scripting interface also reports.
    static func newBrowserWindow(_ entry: AppEntry, pid: pid_t, scripting: BrowserScripting, url: URL?) async throws(Failure) -> (AXUIElement, String) {
        guard let bundle = entry.bundleIdentifier, let script = scripting.newWindowScript(bundleIdentifier: bundle, url: url) else {
            throw Failure(text: "\(entry.name) has no bundle identifier to address.")
        }
        let before = DockedWindow.windows(of: pid)
        let active = NSWorkspace.shared.frontmostApplication
        let result = await AppleScript.run(script, timeout: 30)
        // A browser activates itself for a new window; the application that was active, usually
        // the terminal, keeps the keyboard.
        defer {
            if let active, active.processIdentifier != pid, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
                active.activate(options: [])
            }
        }
        guard result.status == 0 else {
            let detail = result.error.trimmingCharacters(in: .whitespacesAndNewlines)
            throw Failure(text: "\(entry.name) did not open a window by Apple Events\(detail.isEmpty ? "." : ": \(detail)")")
        }
        let identity = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            let fresh = DockedWindow.windows(of: pid).filter { window in
                !before.contains { CFEqual($0, window) } && DockedWindow.string(window, kAXSubroleAttribute) == kAXStandardWindowSubrole
            }
            if let window = fresh.first { return (window, identity) }
            try? await Task.sleep(for: .milliseconds(100))
        }
        throw Failure(text: "\(entry.name) opened a window that this pane could not find.")
    }
}

/// Runs AppleScript through osascript, the same route as other Apple Events that programs in
/// this terminal send, with a time limit.
enum AppleScript {
    struct Result: Sendable {
        var status: Int32
        var output: String
        var error: String
    }

    static func run(_ script: String, timeout: TimeInterval) async -> Result {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                process.arguments = ["-"]
                let input = Pipe(), output = Pipe(), error = Pipe()
                process.standardInput = input
                process.standardOutput = output
                process.standardError = error
                do { try process.run() } catch {
                    continuation.resume(returning: Result(status: -1, output: "", error: error.localizedDescription))
                    return
                }
                input.fileHandleForWriting.write(Data(script.utf8))
                try? input.fileHandleForWriting.close()
                let timer = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
                let out = output.fileHandleForReading.readDataToEndOfFile()
                let err = error.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                timer.cancel()
                continuation.resume(returning: Result(status: process.terminationStatus,
                                                      output: String(decoding: out.prefix(4096), as: UTF8.self),
                                                      error: String(decoding: err.prefix(4096), as: UTF8.self)))
            }
        }
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

    @MainActor
    static func taken(pid: pid_t, window: AXUIElement) -> Bool {
        guard let frame = DockedWindow.frame(of: window),
              let number = DockedWindow.windowNumber(pid: pid, frame: frame) else { return false }
        return take(pid: pid, number: number) == nil
    }
}
