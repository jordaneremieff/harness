import AppKit
import MarkdownCore
import ReaderFeature

/// Measures opening, refresh, find and memory for documents built from a corpus at given sizes.
/// The first open in the process includes starting a web content process; later opens do not.
@MainActor
struct Measurement {
    let windows: WindowManager

    static func document(from pieces: [String], bytes: Int) -> String {
        var text = ""
        var index = 0
        while text.utf8.count < bytes, !pieces.isEmpty {
            text += pieces[index % pieces.count] + "\n\n"
            index += 1
        }
        var data = Array(text.utf8.prefix(bytes))
        if let lastBreak = data.lastIndex(of: 0x0A) { data = Array(data[...lastBreak]) }
        return String(decoding: data, as: UTF8.self)
    }

    func run(corpus: [String], sizes: [Int], output: String?) async -> Int32 {
        let pieces = corpus.compactMap { try? String(contentsOfFile: $0, encoding: .utf8) }
        guard !pieces.isEmpty else {
            CheckRunner.emit(["error": "the corpus files could not be read"], to: output)
            return 1
        }
        let workspace = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-reader-measure-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: workspace) }
        var results: [[String: Any]] = []
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
                // Each open's timings are taken right after it, before the refresh replaces them.
                let first = await context.open(store.reference(id), revision: nil, keep: &keep)
                let firstOpen = timing(first)
                let second = await context.open(store.reference(id), revision: nil, keep: &keep)
                let secondOpen = timing(second)
                // The next revision stays within the source limit: the same text, slightly shorter, plus a new last paragraph.
                try store.write(id, revision: 2, source: Self.document(from: pieces, bytes: size - 64) + "\nAn appended paragraph.\n", kind: "response")
                let refreshStart = Date()
                await second.refresh()
                let refreshMs = Date().timeIntervalSince(refreshStart) * 1000
                second.findQuery = "appended paragraph"
                let findStart = Date()
                await second.find()
                let findMs = Date().timeIntervalSince(findStart) * 1000
                let content = keep.compactMap(ProcessProbe.webContentProcess(of:))
                let webBytes = content.compactMap(ProcessProbe.footprint).reduce(0, +)
                let appBytes = ProcessProbe.footprint(getpid()) ?? 0
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
                    "findFound": second.findStatus == .found,
                    "openPages": 2,
                    "appFootprintMB": Double(appBytes) / 1_048_576,
                    "webContentProcesses": content.count,
                    "webContentFootprintMB": Double(webBytes) / 1_048_576,
                ])
                await first.close()
                await second.close()
                for window in keep { window.close() }
            }
        } catch {
            CheckRunner.emit(["error": String(describing: error)], to: output)
            return 1
        }
        CheckRunner.emit(["results": results, "note": "firstOpen of the first size includes starting a web content process"], to: output)
        return 0
    }
}
