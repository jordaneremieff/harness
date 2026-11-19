import AppKit
import Darwin
import ExplorerPane
import Foundation

@MainActor func run() throws {
    let argv = Array(CommandLine.arguments.dropFirst()), resources = resourcesURL()
    guard let mode = argv.first else { throw ExplorerError("arguments", "Use --pane, --verify or --export-image.") }
    if mode == "--verify", argv.count == 1 {
        try ExplorerCheck.verify(resources: resources)
        return
    }
    if mode == "--export-image" {
        try ExplorerCheck.export(Array(argv.dropFirst()), resources: resources)
        return
    }
    guard mode == "--pane" else { throw ExplorerError("arguments", "Unknown Explorer mode: \(mode.debugDescription)") }
    var args = Array(argv.dropFirst())
    let keys: Set<String> = ["store", "live"]
    guard args.count.isMultiple(of: 2) else { throw ExplorerError("arguments", "Each option needs a value.") }
    let extraArgs = stride(from: 0, to: args.count, by: 2).flatMap { i in
        args[i].hasPrefix("--") && keys.contains(String(args[i].dropFirst(2))) ? [args[i], args[i + 1]] : []
    }
    let extra = try options(extraArgs, allowed: keys)
    args = stride(from: 0, to: args.count, by: 2).flatMap { i in
        args[i].hasPrefix("--") && keys.contains(String(args[i].dropFirst(2))) ? [] : [args[i], args[i + 1]]
    }
    guard let store = extra["store"], store.hasPrefix("/"), !store.utf8.contains(0) else {
        throw ExplorerError("arguments", "An absolute --store is required.")
    }
    let target = try Launch(arguments: args)
    let workspace = try prepareWorkspace(target)
    guard let terminal = ExplorerPane.PaneTerminal() else { throw ExplorerError("terminal", "Pane mode requires a terminal.") }
    let live = try extra["live"].map(LiveConfiguration.consume)
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let host = ExplorerHost(target, workspace: workspace, store: URL(fileURLWithPath: store), resources: resources, terminal: terminal)
    withExtendedLifetime(host) {
        host.start(live: live)
        app.run()
    }
}

MainActor.assumeIsolated {
    do { try run() }
    catch {
        let description = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
        let message = description.unicodeScalars.prefix(1024).map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
        FileHandle.standardError.write(Data("Explorer: \(message)\n".utf8))
        exit(2)
    }
}
