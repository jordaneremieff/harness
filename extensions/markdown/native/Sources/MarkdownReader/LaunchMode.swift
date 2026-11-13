import Foundation

enum LaunchMode {
    case application
    /// Renders one document into a PNG image of the page.
    case exportImage(input: String, output: String, width: Double, maxHeight: Double, appearance: String?, textSize: Int?)
    /// Runs the fixed WebKit checks and prints one JSON report.
    case verify(output: String?)
    /// Measures opening, refresh and memory for generated documents of the given sizes.
    case measure(corpus: [String], sizes: [Int], output: String?)
    /// Opens one visible reader window in a prepared state for screen capture, and keeps running.
    case present(input: String, width: Double, height: Double, appearance: String?, find: String?, source: Bool, outline: Bool)
    /// Opens an open request's document offscreen with the real platform operations and runs
    /// Return to Rex once, printing its result.
    case returnCheck(request: String)
    case usage(String)

    /// Check modes show no Dock icon; presentation shows a normal window.
    var isAccessory: Bool {
        switch self {
        case .application, .present: false
        default: true
        }
    }

    var isCheck: Bool {
        if case .application = self { return false }
        return true
    }

    static func parse(_ arguments: [String]) -> LaunchMode {
        guard let first = arguments.first, first.hasPrefix("--") else { return .application }
        var options: [String: String] = [:]
        var positional: [String] = []
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument.hasPrefix("--"), index + 1 < arguments.count {
                options[String(argument.dropFirst(2))] = arguments[index + 1]
                index += 2
            } else {
                positional.append(argument)
                index += 1
            }
        }
        switch first {
        case "--export-image":
            guard let output = options["out"], let input = positional.first else {
                return .usage("--export-image --out <image.png> [--width 900] [--max-height 6000] [--appearance light|dark] [--text-size n] <file.md | open request>")
            }
            return .exportImage(
                input: input,
                output: output,
                width: options["width"].flatMap(Double.init) ?? 900,
                maxHeight: options["max-height"].flatMap(Double.init) ?? 6000,
                appearance: options["appearance"],
                textSize: options["text-size"].flatMap(Int.init)
            )
        case "--present":
            guard let input = positional.first else {
                return .usage("--present [--width 960] [--height 900] [--appearance light|dark] [--find text] [--source yes] [--outline no] <file.md | open request>")
            }
            return .present(
                input: input,
                width: options["width"].flatMap(Double.init) ?? 960,
                height: options["height"].flatMap(Double.init) ?? 900,
                appearance: options["appearance"],
                find: options["find"],
                source: options["source"] == "yes",
                outline: options["outline"] != "no"
            )
        case "--return-check":
            guard let request = positional.first else { return .usage("--return-check <open request>") }
            return .returnCheck(request: request)
        case "--verify":
            return .verify(output: options["out"])
        case "--measure":
            let sizes = (options["sizes"] ?? "51200,512000,2097152").split(separator: ",").compactMap { Int($0) }
            guard !positional.isEmpty else { return .usage("--measure [--sizes a,b,c] [--out report.json] <corpus.md>...") }
            return .measure(corpus: positional, sizes: sizes, output: options["out"])
        default:
            return .application
        }
    }
}
