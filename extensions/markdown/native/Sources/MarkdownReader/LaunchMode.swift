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
                  arguments.first == "--pane" || arguments.first == "--editor" else {
                return Self(mode: .usage("--live requires one private absolute configuration path with --pane or --editor"), livePath: nil)
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
    case composer(String)
    case exportComposer(String)
    /// Shows one stored document in a reader window over the terminal pane that runs the
    /// program, for as long as the pane and the reader stay open.
    case pane(PaneTarget)

    enum PaneTarget: Sendable {
        case document(store: String, document: String)
        case request(String)
    }
    /// Renders one document into a PNG image of the page. `review` names the revision to compare
    /// the document's revision with (`previous` for the one before it); the image then shows the
    /// comparison.
    case exportImage(input: String, output: String, width: Double, maxHeight: Double, appearance: String?, textSize: Int?, review: String?)
    /// Runs the fixed WebKit checks and prints one JSON report.
    case verify(output: String?)
    /// Measures opening, refresh, CPU and memory for documents built from a corpus at the given
    /// sizes and for generated documents of the given shapes.
    case measure(corpus: [String], sizes: [Int], shapes: [String], output: String?)
    /// Opens one visible reader window in a prepared state for screen capture, and keeps running.
    /// `inspect` names an image to open in the inspection, counted from 1: `2` shows it at Fit,
    /// `2:actual` at actual size.
    case present(input: String, width: Double, height: Double, appearance: String?, find: String?, source: Bool, outline: Bool, embedded: Bool, textSize: Int?, review: String?, inspect: String?)
    /// Opens an open request's document offscreen with the real platform operations and runs
    /// Return to Rex once, printing its result.
    case returnCheck(request: String)
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
        case .application, .pane, .editor, .composer: false
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
        if first == "--composer" || first == "--export-composer" {
            guard arguments.count == 2, arguments[1].hasPrefix("/"), arguments[1].count > 1 else {
                return .usage("\(first) <absolute path>")
            }
            return first == "--composer" ? .composer(arguments[1]) : .exportComposer(arguments[1])
        }
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
                options[String(argument.dropFirst(2))] = arguments[index + 1]
                index += 2
            } else {
                positional.append(argument)
                index += 1
            }
        }
        switch first {
        case "--pane":
            if options.count == 1, let store = options["store"], positional.count == 1, let document = positional.first {
                return .pane(.document(store: store, document: document))
            }
            if options.isEmpty, positional.count == 1, let request = positional.first, !request.hasPrefix("--") {
                return .pane(.request(request))
            }
            return .usage("--pane <open request.json> | --pane --store <store directory> <document ID>")
        case "--export-image":
            guard let output = options["out"], let input = positional.first else {
                return .usage("--export-image --out <image.png> [--width 900] [--max-height 6000] [--appearance light|dark] [--text-size n] [--review previous|n] <file.md | open request>")
            }
            return .exportImage(
                input: input,
                output: output,
                width: options["width"].flatMap(Double.init) ?? 900,
                maxHeight: options["max-height"].flatMap(Double.init) ?? 6000,
                appearance: options["appearance"],
                textSize: options["text-size"].flatMap(Int.init),
                review: options["review"]
            )
        case "--present":
            guard let input = positional.first else {
                return .usage("--present [--width 960] [--height 900] [--appearance light|dark] [--find text] [--source yes] [--outline no] [--embedded yes] [--text-size n] [--review previous|n] [--inspect n[:actual]] <file.md | open request>")
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
                inspect: options["inspect"]
            )
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
            return .usage("unknown option \(first); options: --pane, --present, --export-image, --verify, --measure, --return-check")
        }
    }
}
