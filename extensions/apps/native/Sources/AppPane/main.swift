import AppKit
import AppPaneCore
import NativePane

/// `--list` prints the applications that a pane can show as JSON; `--resolve <text>` prints the
/// application that the text names. Otherwise the program runs as the program of a terminal pane.
@MainActor
private func run() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    if arguments == ["--list"] {
        let data = (try? encoder.encode(Catalogue.entries())) ?? Data("[]".utf8)
        FileHandle.standardOutput.write(data + Data("\n".utf8))
        exit(0)
    }
    if arguments.count == 2, arguments[0] == "--resolve" {
        struct Answer: Encodable {
            var app: AppEntry?
            var candidates: [AppEntry]?
        }
        let answer: Answer
        switch Catalogue.resolve(arguments[1]) {
        case .found(let entry): answer = Answer(app: entry)
        case .ambiguous(let entries): answer = Answer(candidates: entries)
        case .missing: answer = Answer()
        }
        FileHandle.standardOutput.write(((try? encoder.encode(answer)) ?? Data("{}".utf8)) + Data("\n".utf8))
        exit(0)
    }
    let request: PaneRequest
    do {
        request = try PaneRequest.parse(arguments)
    } catch {
        FileHandle.standardError.write(Data("App Pane: \(error.description)\n".utf8))
        exit(2)
    }
    guard let terminal = PaneTerminal() else {
        FileHandle.standardError.write(Data("App Pane runs as the program of a terminal pane.\n".utf8))
        exit(2)
    }
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let host = AppPaneHost(request: request, terminal: terminal)
    host.start()
    withExtendedLifetime(host) { application.run() }
}

run()
