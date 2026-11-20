import AppKit
import NativePane

@MainActor
private final class Application: NSObject, NSApplicationDelegate {
    enum Launch {
        case live(path: String, query: String?)
        case check(URL)
        case checkLive(path: String, script: URL, output: URL)
    }
    private let launch: Launch
    private var host: ConfigHost?

    init(_ launch: Launch) { self.launch = launch }

    func applicationWillFinishLaunching(_ notification: Notification) {
        if case .live = launch { NSApp.mainMenu = ConfigHost.menu() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        switch launch {
        case .check(let directory):
            Task { await ConfigCheck.run(directory: directory) }
        case .checkLive(let path, let script, let output):
            Task { await ConfigCheck.run(directory: output, live: (path: path, script: script)) }
        case .live(let path, let query):
            Task {
                do {
                    guard let terminal = PaneTerminal() else { throw ConfigFailure("Open Config in the terminal pane that launched it.") }
                    let (capability, build) = try await Task.detached {
                        let capability = try Capability.consume(path: path)
                        return (capability, installedDigest())
                    }.value
                    let host = try ConfigHost(terminal: terminal, capability: capability, query: query, build: build)
                    self.host = host
                    host.start()
                } catch {
                    FileHandle.standardError.write(Data("Config: The original launch is unavailable. Run /config again.\n".utf8))
                    exit(2)
                }
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let host else { return .terminateNow }
        host.requestClose()
        return .terminateCancel
    }
}

func installedDigest() -> String? {
    guard let manifest = Bundle.main.resourceURL?.appendingPathComponent("build.json"),
          let bytes = try? Data(contentsOf: manifest),
          let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { return nil }
    return object["sourceDigest"] as? String
}

@MainActor
private func run() {
    let args = Array(CommandLine.arguments.dropFirst())
    let launch: Application.Launch
    let policy: NSApplication.ActivationPolicy
    if args.count == 2, args[0] == "--check", args[1].hasPrefix("/") {
        launch = .check(URL(fileURLWithPath: args[1], isDirectory: true))
        policy = .prohibited
    } else if args.count == 6, args[0] == "--check-live", args[2] == "--script", args[4] == "--out", [args[1], args[3], args[5]].allSatisfy({ $0.hasPrefix("/") }) {
        launch = .checkLive(path: args[1], script: URL(fileURLWithPath: args[3]), output: URL(fileURLWithPath: args[5], isDirectory: true))
        policy = .prohibited
    } else if (args.count == 2 || (args.count == 4 && args[2] == "--query")), args[0] == "--live", args[1].hasPrefix("/") {
        launch = .live(path: args[1], query: args.count == 4 ? args[3] : nil)
        policy = .accessory
    } else {
        FileHandle.standardError.write(Data("Usage: Config --live <absolute path> [--query <text>] | --check <absolute directory> | --check-live <capability> --script <file.js> --out <directory>\n".utf8))
        exit(2)
    }
    let app = NSApplication.shared
    let delegate = Application(launch)
    app.setActivationPolicy(policy)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}

run()
