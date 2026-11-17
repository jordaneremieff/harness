import AppKit
import MarkdownCore
import ReaderFeature

/// Measures generated documents of characteristic shapes: many sections, a wide table, long
/// code, many retained images, rapid successive revisions and several reader windows. Each
/// result names the work it observed: latency of each step, CPU time of the app and its web
/// content processes, and their memory footprints.
@MainActor
struct ShapeMeasurement {
    nonisolated static let allShapes = ["sections", "table", "code", "images", "revisions", "windows"]

    let windows: WindowManager
    let context: Context
    let store: VerifyStore

    // MARK: - Generated documents

    static func sections(count: Int) -> String {
        var text = "# Sections\n\n"
        for index in 0..<count {
            text += "## Section \(index)\n\nParagraph \(index) has *emphasis*, `inline code` and a [link](https://example.com/\(index)). "
            text += String(repeating: "The reader keeps its place while the document grows. ", count: 4) + "\n\n"
            if index % 10 == 0 { text += "- First point \(index)\n- Second point\n- Third point\n\n" }
        }
        return text
    }

    static func table(columns: Int, rows: Int) -> String {
        var text = "# Table\n\n|" + (0..<columns).map { " Column \($0) |" }.joined() + "\n|" + String(repeating: " --- |", count: columns) + "\n"
        for row in 0..<rows {
            text += "|" + (0..<columns).map { column in
                column == 1 ? " A sentence that describes row \(row) in some detail |" : " r\(row)c\(column) |"
            }.joined() + "\n"
        }
        return text + "\nAfter the table.\n"
    }

    static func code(lines: Int, blocks: Int) -> String {
        var text = "# Code\n\n```swift\n"
        for line in 0..<lines { text += "let value\(line) = compute(\(line), scale: \(line % 17)) // line \(line)\n" }
        text += "```\n\n"
        for block in 0..<blocks {
            text += "## Block \(block)\n\n```\n" + (0..<200).map { "    step \(block).\($0)" }.joined(separator: "\n") + "\n```\n\n"
        }
        return text
    }

    /// A PNG of the given size whose pixels come from a seeded generator, so that each image has
    /// its own bytes and digest and compresses about as badly as a photograph.
    static func noisePNG(width: Int, height: Int, seed: UInt64) -> Data {
        guard let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32),
              let pixels = image.bitmapData else { return Data() }
        var state = seed &+ 0x9E37_79B9_7F4A_7C15
        for offset in stride(from: 0, to: width * height * 4, by: 4) {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            pixels[offset] = UInt8(truncatingIfNeeded: state >> 24)
            pixels[offset + 1] = UInt8(truncatingIfNeeded: state >> 32)
            pixels[offset + 2] = UInt8(truncatingIfNeeded: state >> 40)
            pixels[offset + 3] = 255
        }
        return image.representation(using: .png, properties: [:]) ?? Data()
    }

    // MARK: - Process observation

    struct Usage {
        var app: Double?
        var web: [pid_t: Double]
        var unresolvedWindows: Int
        var unavailableProcesses: Int

        static func - (lhs: Usage, rhs: Usage) -> UsageDelta {
            let same = Set(lhs.web.keys).intersection(rhs.web.keys)
            let deltas = same.compactMap { pid -> Double? in
                let delta = lhs.web[pid]! - rhs.web[pid]!
                return delta >= 0 ? delta : nil
            }
            let complete = Set(lhs.web.keys) == Set(rhs.web.keys)
                && lhs.unresolvedWindows + rhs.unresolvedWindows == 0
                && lhs.unavailableProcesses + rhs.unavailableProcesses == 0
                && deltas.count == same.count && !same.isEmpty
            let app = lhs.app.flatMap { end in rhs.app.flatMap { end >= $0 ? end - $0 : nil } }
            return UsageDelta(app: app, web: complete ? deltas.reduce(0, +) : nil,
                              knownWeb: deltas.isEmpty ? nil : deltas.reduce(0, +),
                              startPIDs: rhs.web.keys.sorted(), endPIDs: lhs.web.keys.sorted(),
                              unresolvedWindows: lhs.unresolvedWindows + rhs.unresolvedWindows,
                              unavailableProcesses: lhs.unavailableProcesses + rhs.unavailableProcesses)
        }
    }

    struct UsageDelta {
        var app: Double?
        var web: Double?
        var knownWeb: Double?
        var startPIDs: [pid_t]
        var endPIDs: [pid_t]
        var unresolvedWindows: Int
        var unavailableProcesses: Int

        var json: [String: Any] {
            ["appCpuMs": app.map { ($0 * 1000).rounded() } as Any? ?? NSNull(),
             "appCpuCoverage": app == nil ? "unavailable" : "complete",
             "webContentCpuMs": web.map { ($0 * 1000).rounded() } as Any? ?? NSNull(),
             "webContentKnownCpuMs": knownWeb.map { ($0 * 1000).rounded() } as Any? ?? NSNull(),
             "webContentCpuCoverage": web != nil ? "complete" : knownWeb != nil ? "partial" : "unavailable",
             "startPIDs": startPIDs, "endPIDs": endPIDs,
             "unresolvedWindowSamples": unresolvedWindows, "unavailableProcessSamples": unavailableProcesses]
        }
    }

    static func usage(_ keep: [NSWindow]) -> Usage {
        let resolved = keep.compactMap(ProcessProbe.webContentProcess(of:))
        let content = Set(resolved)
        var readings: [pid_t: Double] = [:]
        for pid in content { readings[pid] = ProcessProbe.cpuSeconds(pid) }
        return Usage(app: ProcessProbe.cpuSeconds(getpid()), web: readings,
                     unresolvedWindows: keep.count - resolved.count,
                     unavailableProcesses: content.count - readings.count)
    }

    static func memory(_ keep: [NSWindow]) -> [String: Any] {
        let resolved = keep.compactMap(ProcessProbe.webContentProcess(of:))
        let content = Set(resolved)
        let values = content.compactMap(ProcessProbe.footprint)
        let app = ProcessProbe.footprint(getpid())
        let complete = resolved.count == keep.count && values.count == content.count && !content.isEmpty
        let known = values.isEmpty ? nil : Double(values.reduce(0, +)) / 1_048_576
        return [
            "appFootprintMB": app.map { Double($0) / 1_048_576 } as Any? ?? NSNull(),
            "appMemoryCoverage": app == nil ? "unavailable" : "complete",
            "webContentProcesses": content.count,
            "webContentFootprintMB": complete ? known! as Any : NSNull(),
            "webContentKnownFootprintMB": known as Any? ?? NSNull(),
            "webContentMemoryCoverage": complete ? "complete" : values.isEmpty ? "unavailable" : "partial",
            "unresolvedWindows": keep.count - resolved.count,
            "unavailableProcesses": content.count - values.count,
        ]
    }

    /// CPU used while nothing is asked of the reader, in consecutive periods of the given length,
    /// so that work that settles after a load is separate from steady work.
    func idle(_ keep: [NSWindow], seconds: Double, periods: Int = 3) async -> [String: Any] {
        var intervals: [[String: Any]] = []
        for _ in 0..<periods {
            let start = ContinuousClock.now
            let before = Self.usage(keep)
            try? await Task.sleep(for: .seconds(seconds))
            let used = Self.usage(keep) - before
            let duration = start.duration(to: .now).components
            let elapsed = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
            intervals.append(used.json.merging([
                "elapsedSeconds": elapsed,
                "appCpuPercent": used.app.map { $0 / elapsed * 100 } as Any? ?? NSNull(),
                "webContentCpuPercent": used.web.map { $0 / elapsed * 100 } as Any? ?? NSNull(),
            ], uniquingKeysWith: { $1 }))
        }
        return ["requestedPeriodSeconds": seconds, "intervals": intervals]
    }

    static func timing(_ model: ReaderModel) -> [String: Any] {
        guard let t = model.timings else { return [:] }
        return ["readMs": t.readMilliseconds, "renderMs": t.renderMilliseconds, "displayMs": t.displayMilliseconds, "totalMs": t.totalMilliseconds]
    }

    /// Opens a document, then a second window of it, refreshes to a changed revision, finds
    /// text near its end and observes idle CPU. Process changes make a CPU interval partial or
    /// unavailable; a new process's lifetime CPU is not the CPU of this interval.
    func document(_ shape: String, source: String, references: Any? = nil, assets: [String: Data] = [:], next: String) async throws -> [String: Any] {
        let id = VerifyStore.newId()
        try store.write(id, revision: 1, source: source, kind: "file", references: references, assets: assets)
        var keep: [NSWindow] = []
        var start = Self.usage(keep)
        var clock = Date()
        let first = await context.open(store.reference(id), revision: nil, keep: &keep)
        defer { for window in keep { window.close() } }
        try CheckRunner.requireReady(first)
        let firstWall = Date().timeIntervalSince(clock) * 1000
        let firstUsage = Self.usage(keep) - start
        let firstOpen = Self.timing(first)
        let images = first.imageEvidence
        start = Self.usage(keep)
        clock = Date()
        let second = await context.open(store.reference(id), revision: nil, keep: &keep)
        try CheckRunner.requireReady(second)
        let secondWall = Date().timeIntervalSince(clock) * 1000
        let secondUsage = Self.usage(keep) - start
        let secondOpen = Self.timing(second)
        try store.write(id, revision: 2, source: next, kind: "file", references: references, assets: assets)
        start = Self.usage(keep)
        clock = Date()
        await second.refresh()
        try CheckRunner.requireReady(second)
        let refreshMs = Date().timeIntervalSince(clock) * 1000
        let refreshUsage = Self.usage(keep) - start
        clock = Date()
        let found = await context.findState(second, query: "appended paragraph")
        let findMs = Date().timeIntervalSince(clock) * 1000
        let idle = await idle(keep, seconds: 3)
        let settledImages = assets.isEmpty ? [] : await first.inspectImages()
        var result: [String: Any] = [
            "shape": shape,
            "bytes": source.utf8.count,
            "topLevelBlocks": first.rendered?.blockCount ?? 0,
            "headings": first.rendered?.outline.count ?? 0,
            "codeBlocks": first.rendered?.codeBlocks.count ?? 0,
            "firstOpen": firstOpen.merging(["wallMs": firstWall], uniquingKeysWith: { $1 }).merging(firstUsage.json, uniquingKeysWith: { $1 }),
            "secondOpen": secondOpen.merging(["wallMs": secondWall], uniquingKeysWith: { $1 }).merging(secondUsage.json, uniquingKeysWith: { $1 }),
            "refresh": ["wallMs": refreshMs, "restore": second.lastRestore.rawValue, "revision": second.snapshot?.revision ?? 0].merging(refreshUsage.json, uniquingKeysWith: { $1 }),
            "findNearEndMs": findMs,
            "findFound": (found?.count ?? 0) > 0,
            "findCount": found?.count as Any? ?? NSNull(),
            "memoryWithTwoWindows": Self.memory(keep),
            "idleWithTwoWindows": idle,
        ]
        if !assets.isEmpty {
            result["images"] = [
                "count": assets.count,
                "bytes": assets.values.map(\.count).reduce(0, +),
                "inspected": images.count,
                "displayed": images.filter(\.displayed).count,
                "failed": images.filter { $0.failure != nil }.count,
                "servedRequests": first.servedAssetRequests,
                "displayedAfterIdle": settledImages.filter(\.displayed).count,
            ]
        }
        await first.close()
        await second.close()
        for window in keep { window.close() }
        return result
    }

    // MARK: - Shapes

    func run(_ shape: String) async throws -> [String: Any] {
        switch shape {
        case "sections":
            let source = Self.sections(count: 1500)
            return try await document(shape, source: source, next: source + "\nAn appended paragraph.\n")
        case "table":
            let source = Self.table(columns: 24, rows: 1500)
            return try await document(shape, source: source, next: source + "\nAn appended paragraph.\n")
        case "code":
            let source = Self.code(lines: 20000, blocks: 40)
            return try await document(shape, source: source, next: source + "\nAn appended paragraph.\n")
        case "images":
            return try await images(count: 120)
        case "revisions":
            return try await revisions(count: 10)
        case "windows":
            return try await windowsShape(count: 6)
        default:
            return ["shape": shape, "error": "unknown shape; shapes: \(Self.allShapes.joined(separator: ","))"]
        }
    }

    func images(count: Int) async throws -> [String: Any] {
        var items: [[String: Any]] = []
        var assets: [String: Data] = [:]
        var source = "# Images\n\n"
        for index in 0..<count {
            let png = Self.noisePNG(width: 320, height: 200, seed: UInt64(index))
            let hex = String(VerifyStore.digest(png).dropFirst(7))
            assets["\(hex).png"] = png
            items.append(["kind": "image", "reference": "figure-\(index).png", "state": "retained", "file": "assets/\(hex).png", "mediaType": "image/png", "bytes": png.count, "digest": "sha256:\(hex)"])
            source += "## Figure \(index)\n\n![Figure \(index)](figure-\(index).png)\n\nCaption for figure \(index).\n\n"
        }
        let references: [String: Any] = ["state": "inspected", "omitted": 0, "items": items]
        return try await document("images", source: source, references: references, assets: assets, next: source + "\nAn appended paragraph.\n")
    }

    /// Successive revisions while one window is open: one refresh as the reference, then a burst
    /// of explicit refreshes that each start before the previous one settled, then publications
    /// that a following window loads by itself.
    func revisions(count: Int) async throws -> [String: Any] {
        let base = Self.sections(count: 1500)
        let id = VerifyStore.newId()
        var revision = 1
        try store.write(id, revision: revision, source: base, kind: "file")
        var keep: [NSWindow] = []
        let model = await context.open(store.reference(id), revision: nil, keep: &keep)
        defer { for window in keep { window.close() } }
        try CheckRunner.requireReady(model)

        revision += 1
        try store.write(id, revision: revision, source: base + "\nRevision \(revision).\n", kind: "file")
        var start = Self.usage(keep)
        var clock = Date()
        await model.refresh()
        try CheckRunner.requireReady(model)
        let single = ["wallMs": Date().timeIntervalSince(clock) * 1000, "revision": model.snapshot?.revision ?? 0].merging((Self.usage(keep) - start).json, uniquingKeysWith: { $1 })
        let preparationsBefore = model.preparationsStartedForCheck

        start = Self.usage(keep)
        clock = Date()
        var tasks: [Task<Void, Never>] = []
        for _ in 0..<count {
            revision += 1
            try store.write(id, revision: revision, source: base + "\nRevision \(revision).\n", kind: "file")
            tasks.append(Task { @MainActor in await model.refresh() })
            await Task.yield()
        }
        for task in tasks { await task.value }
        try CheckRunner.requireReady(model)
        let burst: [String: Any] = [
            "refreshes": count,
            "wallMs": Date().timeIntervalSince(clock) * 1000,
            "shownRevision": model.snapshot?.revision ?? 0,
            "latestRevision": revision,
            "preparationsStarted": model.preparationsStartedForCheck - preparationsBefore,
        ].merging((Self.usage(keep) - start).json, uniquingKeysWith: { $1 })

        model.followsLatest = true
        let followBefore = model.preparationsStartedForCheck
        start = Self.usage(keep)
        clock = Date()
        for _ in 0..<count {
            revision += 1
            try store.write(id, revision: revision, source: base + "\nRevision \(revision).\n", kind: "file")
            try? await Task.sleep(for: .milliseconds(40))
        }
        let caughtUp = await context.wait(seconds: 20) { model.snapshot?.revision == revision && !model.isLoadingForCheck }
        let following: [String: Any] = [
            "publications": count,
            "intervalMs": 40,
            "caughtUp": caughtUp,
            "wallMs": Date().timeIntervalSince(clock) * 1000,
            "shownRevision": model.snapshot?.revision ?? 0,
            "latestRevision": revision,
            "preparationsStarted": model.preparationsStartedForCheck - followBefore,
        ].merging((Self.usage(keep) - start).json, uniquingKeysWith: { $1 })
        await model.close()
        for window in keep { window.close() }
        return ["shape": "revisions", "bytes": base.utf8.count, "singleRefresh": single, "refreshBurst": burst, "following": following]
    }

    /// Several direct page windows: memory, idle CPU with all windows
    /// shown and with half of them hidden, and CPU during repeated resizing.
    func windowsShape(count: Int) async throws -> [String: Any] {
        let source = Self.sections(count: 600)
        var keep: [NSWindow] = []
        var models: [ReaderModel] = []
        var opens: [Double] = []
        defer { for window in keep { window.close() } }
        for _ in 0..<count {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: source, kind: "file")
            let clock = Date()
            let model = await context.open(store.reference(id), revision: nil, trackedScroll: true, keep: &keep)
            try CheckRunner.requireReady(model)
            models.append(model)
            opens.append(Date().timeIntervalSince(clock) * 1000)
        }
        let memory = Self.memory(keep)
        let idleShown = await idle(keep, seconds: 3)
        for window in keep.prefix(count / 2) { window.orderOut(nil) }
        let idleHalfHidden = await idle(keep, seconds: 3)
        for window in keep.prefix(count / 2) { window.orderFrontRegardless() }
        // Resizes every window through the given widths, one step per frame interval.
        func resize(_ widths: [Double]) async -> [String: Any] {
            let start = Self.usage(keep)
            let clock = Date()
            for width in widths {
                for window in keep {
                    var frame = window.frame
                    frame.size.width = width
                    window.setFrame(frame, display: true)
                }
                try? await Task.sleep(for: .milliseconds(16))
            }
            return ["steps": widths.count, "windows": count, "wallMs": Date().timeIntervalSince(clock) * 1000].merging((Self.usage(keep) - start).json, uniquingKeysWith: { $1 })
        }
        // A drag that stays wide enough for the outline, then one that shows and hides it each step.
        let drag = await resize(stride(from: 900.0, to: 700, by: -5).map { $0 })
        let crossing = await resize((0..<10).map { $0 % 2 == 0 ? 520 : 900 })
        for model in models { await model.close() }
        for window in keep { window.close() }
        return [
            "shape": "windows",
            "windows": count,
            "bytesEach": source.utf8.count,
            "openWallMs": opens,
            "memory": memory,
            "idleAllShown": idleShown,
            "idleHalfHidden": idleHalfHidden,
            "resizeAboveOutlineWidth": drag,
            "resizeAcrossOutlineWidth": crossing,
        ]
    }
}
