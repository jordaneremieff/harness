import AppKit
import NativePane

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
        guard let terminal = PaneTerminal() else {
            Self.fail("Start Editor in its terminal pane with /editor.")
        }
        let ticket: EditorTicket
        do { ticket = try EditorTicket.consume(ticketPath) }
        catch { Self.fail("The launch ticket is invalid or expired. Run /editor again.") }
        let client = NativeEditorClient(ticket: ticket)
        let files = WorkspaceFiles(settings: ticket.settings.map { URL(fileURLWithPath: $0) },
                                   layout: ticket.layout.map { URL(fileURLWithPath: $0) },
                                   appearance: Self.paneAppearanceFile())
        let screen = WorkspaceScreen(api: client, root: ticket.root, files: files)
        let host = PaneHost(terminal: terminal, api: client, screen: screen)
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
