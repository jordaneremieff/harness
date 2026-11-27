import AppKit
import Darwin
import NativePane

struct EditorStartupReport {
    let ticketPath: String

    // Only pass app-authored messages. The ticket and child output do not belong in the report.
    func write(_ problem: String) {
        var line = Data()
        for scalar in problem.unicodeScalars {
            let clean = CharacterSet.controlCharacters.contains(scalar) || CharacterSet.newlines.contains(scalar)
                ? " " : String(scalar)
            guard line.count + clean.utf8.count < 1024 else { break }
            line.append(contentsOf: clean.utf8)
        }
        guard !line.isEmpty else { return }
        line.append(10)

        let path = ticketPath + ".failure"
        let fd = open(path, O_WRONLY | O_CREAT | O_NOFOLLOW | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return }
        defer { close(fd) }
        guard fchmod(fd, 0o600) == 0 else { return }
        line.withUnsafeBytes { bytes in
            guard let start = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, start.advanced(by: offset), bytes.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { return }
                offset += count
            }
        }
    }
}

@MainActor
private final class EditorApplication: NSObject, NSApplicationDelegate {
    private let ticketPath: String
    private var host: PaneHost?

    init(ticketPath: String) {
        self.ticketPath = ticketPath
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = Self.menu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let ticket: EditorTicket
        do { ticket = try EditorTicket.consume(ticketPath) }
        catch { Self.fail("The launch ticket is invalid or expired. Run /editor again.") }
        let report = EditorStartupReport(ticketPath: ticketPath)
        guard let terminal = PaneTerminal() else {
            let problem = "Editor did not start in a terminal pane. Run /editor again."
            report.write(problem)
            Self.fail(problem)
        }
        let workspace = URL(fileURLWithPath: ticketPath).deletingLastPathComponent()
        let service = EditorService(ticket: ticket, workspace: workspace)
        let files = WorkspaceFiles(settings: ticket.settings.map { URL(fileURLWithPath: $0) },
                                   layout: ticket.layout.map { URL(fileURLWithPath: $0) },
                                   appearance: Self.paneAppearanceFile())
        let screen = WorkspaceScreen(api: service, root: ticket.root, files: files)
        let host = PaneHost(terminal: terminal, service: service, screen: screen, startupReport: report)
        self.host = host
        host.start(file: ticket.file)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let host else { return .terminateNow }
        host.requestClose()
        return .terminateCancel
    }

    /// The shared pane appearance file that the install recorded in the bundle's build record.
    private static func paneAppearanceFile() -> URL? {
        guard let url = Bundle.main.url(forResource: "build", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = record["paneAppearance"] as? String, path.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: path)
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("Editor: \(message)\n".utf8))
        exit(2)
    }

    private static func menu() -> NSMenu {
        let main = NSMenu()
        func addMenu(_ title: String) -> NSMenu {
            let item = NSMenuItem()
            let menu = NSMenu(title: title)
            item.submenu = menu
            main.addItem(item)
            return menu
        }
        let app = addMenu("Editor")
        // cmd+W closes the current tab through the command registry; cmd+shift+W closes the pane.
        app.addItem(withTitle: "Close Editor", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "W")
        app.addItem(withTitle: "Quit Editor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let edit = addMenu("Edit")
        for (title, action, key) in [
            ("Undo", "undo:", "z"), ("Redo", "redo:", "Z"),
            ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
            ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a"),
        ] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        return main
    }
}

@MainActor
private func runEditor() {
    let args = CommandLine.arguments
    guard args.count == 3, args[1] == "--pane", args[2].hasPrefix("/"), args[2] != "/" else {
        FileHandle.standardError.write(Data("usage: Editor --pane <absolute launch ticket path>\n".utf8))
        exit(2)
    }
    let app = NSApplication.shared
    let delegate = EditorApplication(ticketPath: args[2])
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}

runEditor()
