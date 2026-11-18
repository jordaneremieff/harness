import AppKit
import NativePane

@MainActor
private final class ComposerApp: NSObject, NSApplicationDelegate {
    private let mode: String
    private let path: URL
    private var host: ComposerHost?

    init(mode: String, path: URL) {
        self.mode = mode
        self.path = path
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        if mode == "--composer" { NSApp.mainMenu = ComposerHost.menu() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if mode == "--export-composer" {
            Task { await ComposerCheck.run(directory: path) }
            return
        }
        do {
            guard let terminal = PaneTerminal() else { throw CocoaError(.fileReadUnknown) }
            let configuration = try ComposerConfiguration.consume(path)
            let host = try ComposerHost(configuration: configuration, launchFile: path, stateDirectory: Self.stateDirectory(), terminal: terminal)
            self.host = host
            host.start()
        } catch {
            FileHandle.standardError.write(Data("Composer: invalid launch or no terminal.\n".utf8))
            exit(2)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let host else { return .terminateNow }
        host.close()
        return .terminateCancel
    }

    private static func stateDirectory() throws -> URL {
        if let path = ProcessInfo.processInfo.environment["PI_COMPOSER_STATE_DIRECTORY"] {
            guard path.hasPrefix("/"), path.count > 1 else { throw CocoaError(.fileWriteInvalidFileName) }
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Composer", isDirectory: true)
    }
}

@MainActor
private func run() {
    let args = CommandLine.arguments.dropFirst()
    guard args.count == 2, let mode = args.first, ["--composer", "--export-composer"].contains(mode),
          let path = args.last, path.hasPrefix("/"), path.count > 1 else {
        FileHandle.standardError.write(Data("usage: Composer --composer <absolute launch file> | --export-composer <absolute directory>\n".utf8))
        exit(2)
    }
    let application = NSApplication.shared
    let delegate = ComposerApp(mode: mode, path: URL(fileURLWithPath: path))
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { application.run() }
}

run()
