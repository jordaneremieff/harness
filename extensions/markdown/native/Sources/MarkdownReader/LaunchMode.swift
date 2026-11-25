import Foundation

struct NativeLaunch {
    let mode: LaunchMode
    let livePath: String?

    static func parse(_ input: [String]) -> Self {
        var arguments = input
        var livePath: String?
        if let index = arguments.firstIndex(of: "--live") {
            guard index + 1 < arguments.count, arguments[index + 1].hasPrefix("/"),
                  arguments.filter({ $0 == "--live" }).count == 1,
                  ["--pane", "--editor", "--ask-check"].contains(arguments.first) else {
                return Self(mode: .usage("--live requires one private absolute configuration path with --pane, --editor or --ask-check"), livePath: nil)
            }
            livePath = arguments[index + 1]
            arguments.removeSubrange(index...index + 1)
        }
        return Self(mode: LaunchMode.parse(arguments), livePath: livePath)
    }
}

enum LaunchMode {
    case application
    case editor(EditorLaunch)
    /// Shows one stored document in a reader window over the terminal pane that runs the
    /// program, for as long as the pane and the reader stay open.
    case pane(PaneTarget)

    enum PaneTarget: Sendable {
        struct Pin: Sendable {
            let revision: Int
            let digest: String
        }

        case document(store: String, document: String, pin: Pin?)
        case request(String)
    }

    private static let paneUsage = "--pane <open request.json> | --pane --store <store directory> [--revision <positive integer> --digest <sha256:digest>] <document ID>"
    /// Renders one document into a PNG image of the page. `review` names the revision to compare
    /// the document's revision with (`previous` for the one before it); the image then shows the
    /// comparison. `darkTheme` names the Catppuccin flavour of the dark appearance; `click` names a
    /// control, by CSS selector, that the export clicks before the capture, to show a menu or panel.
    /// `answer` names a Markdown file: the export asks about the document and shows that file's text
    /// as the agent's answer in the Ask card.
    case exportImage(input: String, output: String, width: Double, maxHeight: Double, appearance: String?, textSize: Int?, review: String?, darkTheme: String?, click: String?, answer: String?)
    /// Runs the fixed WebKit checks and prints one JSON report.
    case verify(output: String?)
    /// Measures opening, refresh, CPU and memory for documents built from a corpus at the given
    /// sizes and for generated documents of the given shapes.
    case measure(corpus: [String], sizes: [Int], shapes: [String], output: String?)
    /// Opens one visible reader window in a prepared state for screen capture, and keeps running.
    /// `inspect` names an image to open in the inspection, counted from 1: `2` shows it at Fit,
    /// `2:actual` at actual size.
    case present(input: String, width: Double, height: Double, appearance: String?, find: String?, source: Bool, outline: Bool, embedded: Bool, textSize: Int?, review: String?, inspect: String?, darkTheme: String?)
    /// Opens an open request's document offscreen with the real platform operations and runs
    /// Return to Rex once, printing its result.
    case returnCheck(request: String)
    /// Opens one stored document offscreen as a live pane does, with the `--live` connection, and
    /// sends `text` from the Ask card with real key events. It reports what the card shows until the
    /// conversation answers or `seconds` pass.
    case askCheck(store: String, document: String, text: String, seconds: Double, output: String?)
    case usage(String)

    /// Check and pane modes show no Dock icon; presentation shows a normal window.
    var isAccessory: Bool {
        switch self {
        case .application, .present: false
        case .editor(let launch): launch.surface == .pane
        default: true
        }
    }

    var isCheck: Bool {
        switch self {
        case .application, .pane, .editor: false
        default: true
        }
    }

    var isPane: Bool {
        if case .pane = self { return true }
        if case .editor(let launch) = self { return launch.surface == .pane }
        return false
    }

    static func parse(_ arguments: [String]) -> LaunchMode {
        guard let first = arguments.first, first.hasPrefix("--") else { return .application }
        if first == "--editor" {
            do { return .editor(try EditorLaunch.parse(Array(arguments.dropFirst()))) }
            catch { return .usage(String(describing: error)) }
        }
        var options: [String: String] = [:]
        var positional: [String] = []
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument.hasPrefix("--"), index + 1 < arguments.count {
                let key = String(argument.dropFirst(2))
                if first == "--pane", options[key] != nil { return .usage(paneUsage) }
                options[key] = arguments[index + 1]
                index += 2
            } else {
                positional.append(argument)
                index += 1
            }
        }
        switch first {
        case "--pane":
            guard positional.count == 1, let document = positional.first, !document.hasPrefix("--") else { return .usage(paneUsage) }
            if options.isEmpty { return .pane(.request(document)) }
            guard let store = options["store"] else { return .usage(paneUsage) }
            if options.count == 1 { return .pane(.document(store: store, document: document, pin: nil)) }
            if options.count == 3, let number = options["revision"], let revision = Int(number), revision > 0,
               let digest = options["digest"], digest.wholeMatch(of: /sha256:[a-f0-9]{64}/) != nil {
                return .pane(.document(store: store, document: document, pin: .init(revision: revision, digest: digest)))
            }
            return .usage(paneUsage)
        case "--export-image":
            guard let output = options["out"], let input = positional.first else {
                return .usage("--export-image --out <image.png> [--width 900] [--max-height 6000] [--appearance light|dark] [--dark-theme frappe|macchiato|mocha] [--text-size n] [--review previous|n] [--click <selector>] [--answer <answer.md>] <file.md | open request>")
            }
            return .exportImage(
                input: input,
                output: output,
                width: options["width"].flatMap(Double.init) ?? 900,
                maxHeight: options["max-height"].flatMap(Double.init) ?? 6000,
                appearance: options["appearance"],
                textSize: options["text-size"].flatMap(Int.init),
                review: options["review"],
                darkTheme: options["dark-theme"],
                click: options["click"],
                answer: options["answer"]
            )
        case "--present":
            guard let input = positional.first else {
                return .usage("--present [--width 960] [--height 900] [--appearance light|dark] [--dark-theme frappe|macchiato|mocha] [--find text] [--source yes] [--outline no] [--embedded yes] [--text-size n] [--review previous|n] [--inspect n[:actual]] <file.md | open request>")
            }
            return .present(
                input: input,
                width: options["width"].flatMap(Double.init) ?? 960,
                height: options["height"].flatMap(Double.init) ?? 900,
                appearance: options["appearance"],
                find: options["find"],
                source: options["source"] == "yes",
                outline: options["outline"] != "no",
                embedded: options["embedded"] == "yes",
                textSize: options["text-size"].flatMap(Int.init),
                review: options["review"],
                inspect: options["inspect"],
                darkTheme: options["dark-theme"]
            )
        case "--ask-check":
            let usage = "--ask-check --store <store directory> --text <question> [--seconds 90] [--out report.json] --live <configuration> <document ID>"
            guard positional.count == 1, let document = positional.first, let store = options["store"], let text = options["text"],
                  !text.isEmpty, Set(options.keys).isSubset(of: ["store", "text", "seconds", "out"]) else { return .usage(usage) }
            let seconds = options["seconds"].map { Double($0) } ?? 90
            guard let seconds, seconds > 0, seconds <= 600 else { return .usage(usage) }
            return .askCheck(store: store, document: document, text: text, seconds: seconds, output: options["out"])
        case "--return-check":
            guard let request = positional.first else { return .usage("--return-check <open request>") }
            return .returnCheck(request: request)
        case "--verify":
            return .verify(output: options["out"])
        case "--measure":
            let sizeWords = (options["sizes"] ?? "51200,512000,2097152").split(separator: ",", omittingEmptySubsequences: false)
            let sizes = sizeWords.compactMap { Int($0) }
            guard !sizes.isEmpty, sizes.count == sizeWords.count, sizes.count <= 8,
                  sizes.allSatisfy({ (256...2_097_152).contains($0) }), positional.count <= 8 else {
                return .usage("--measure accepts at most eight sizes (256...2097152 bytes) and eight corpus files")
            }
            let shapes = options["shapes"].map { $0 == "all" ? ShapeMeasurement.allShapes : $0.split(separator: ",", omittingEmptySubsequences: false).map(String.init) } ?? []
            guard shapes.count <= ShapeMeasurement.allShapes.count,
                  Set(shapes).count == shapes.count, shapes.allSatisfy(ShapeMeasurement.allShapes.contains) else {
                return .usage("--measure --shapes accepts all or distinct names from \(ShapeMeasurement.allShapes.joined(separator: ","))")
            }
            guard !positional.isEmpty || !shapes.isEmpty else { return .usage("--measure [--sizes a,b,c] [--shapes all|\(ShapeMeasurement.allShapes.joined(separator: ","))] [--out report.json] [<corpus.md>...]") }
            return .measure(corpus: positional, sizes: positional.isEmpty ? [] : sizes, shapes: shapes, output: options["out"])
        default:
            // An unknown option is an error, so that a caller that expects a newer mode never
            // starts the library application in its place.
            return .usage("unknown option \(first); options: --pane, --present, --export-image, --verify, --measure, --return-check, --ask-check")
        }
    }
}
