import AppKit
import MarkdownCore
import ReaderFeature

/// Measures opening, refresh, find and memory for documents built from a corpus at given sizes.
/// The first open in the process includes starting a web content process; later opens do not.
@MainActor
struct Measurement {
    let windows: WindowManager

    static func document(from pieces: [String], bytes: Int) -> String {
        guard bytes > 0, !pieces.isEmpty else { return "" }
        var data = Data()
        var index = 0
        while data.count < bytes {
            let piece = Data((pieces[index % pieces.count] + "\n\n").utf8)
            data.append(piece.prefix(bytes - data.count))
            index += 1
        }
        if let lastBreak = data.lastIndex(of: 0x0A) { data = Data(data[...lastBreak]) }
        while !data.isEmpty {
            if let text = String(data: data, encoding: .utf8) { return text }
            data.removeLast()
        }
        return ""
    }

    func run(corpus: [String], sizes: [Int], shapes: [String], output: String?) async -> Int32 {
        let pieces = corpus.compactMap { try? String(contentsOfFile: $0, encoding: .utf8) }
        guard !pieces.isEmpty || corpus.isEmpty else {
            CheckRunner.emit(["error": "the corpus files could not be read"], to: output)
            return 1
        }
        let workspace = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-reader-measure-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: workspace) }
        var results: [[String: Any]] = []
        var shapeResults: [[String: Any]] = []
        do {
            let store = try VerifyStore(root: workspace.appendingPathComponent("store"))
            let context = Context(windows: windows, workspace: workspace, store: store)
            for size in sizes {
                let source = Self.document(from: pieces, bytes: size)
                let id = VerifyStore.newId()
                try store.write(id, revision: 1, source: source, kind: "response")
                func timing(_ model: ReaderModel) -> [String: Any] {
                    guard let t = model.timings else { return [:] }
                    return ["readMs": t.readMilliseconds, "renderMs": t.renderMilliseconds, "displayMs": t.displayMilliseconds, "totalMs": t.totalMilliseconds]
                }
                var keep: [NSWindow] = []
                defer { for window in keep { window.close() } }
                // Each open's timings are taken right after it, before the refresh replaces them.
                let first = await context.open(store.reference(id), revision: nil, keep: &keep)
                try CheckRunner.requireReady(first)
                let firstOpen = timing(first)
                let second = await context.open(store.reference(id), revision: nil, keep: &keep)
                try CheckRunner.requireReady(second)
                let secondOpen = timing(second)
                // The next revision stays within the source limit: the same text, slightly shorter, plus a new last paragraph.
                try store.write(id, revision: 2, source: Self.document(from: pieces, bytes: size - 64) + "\nAn appended paragraph.\n", kind: "response")
                let refreshStart = Date()
                await second.refresh()
                try CheckRunner.requireReady(second)
                let refreshMs = Date().timeIntervalSince(refreshStart) * 1000
                let findStart = Date()
                let found = await context.findState(second, query: "appended paragraph")
                let findMs = Date().timeIntervalSince(findStart) * 1000
                results.append([
                    "bytes": source.utf8.count,
                    "topLevelBlocks": first.rendered?.blockCount ?? 0,
                    "headings": first.rendered?.outline.count ?? 0,
                    "codeBlocks": first.rendered?.codeBlocks.count ?? 0,
                    "firstOpen": firstOpen,
                    "secondOpen": secondOpen,
                    "refreshMs": refreshMs,
                    "refreshRestore": second.lastRestore.rawValue,
                    "findNearEndMs": findMs,
                    "findFound": (found?.count ?? 0) > 0,
                    "findCount": found?.count as Any? ?? NSNull(),
                    "openPages": 2,
                ].merging(ShapeMeasurement.memory(keep), uniquingKeysWith: { $1 }))
                await first.close()
                await second.close()
            }
            let shapeMeasurement = ShapeMeasurement(windows: windows, context: context, store: store)
            for shape in shapes { shapeResults.append(try await shapeMeasurement.run(shape)) }
        } catch {
            CheckRunner.emit(["ok": false, "error": String(describing: error), "results": results, "shapes": shapeResults], to: output)
            return 1
        }
        CheckRunner.emit([
            "ok": true,
            "results": results,
            "shapes": shapeResults,
            "note": "the first open in the process includes starting a web content process; check-mode windows lie outside the visible screen area",
        ], to: output)
        return 0
    }
}
