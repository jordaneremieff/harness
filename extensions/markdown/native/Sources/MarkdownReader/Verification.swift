import AppKit
import CryptoKit
import MarkdownCore
import Network
import ReaderFeature
import WebKit

/// The fixed WebKit checks of this Mac: content script, remote loads, asset containment, find,
/// code copy, position across a refresh, pinned open requests, link confirmation and recovery
/// after the web content process ends. It prints one JSON report and exits nonzero on a failure.
@MainActor
struct Verification {
    let windows: WindowManager

    struct Check {
        var name: String
        var pass: Bool
        var detail: String
    }

    func run(output: String?) async -> Int32 {
        let workspace = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-reader-verify-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: workspace) }
        var checks: [Check] = []
        var keep: [NSWindow] = []
        do {
            let store = try VerifyStore(root: workspace.appendingPathComponent("store"))
            let context = Context(windows: windows, workspace: workspace, store: store)
            checks.append(await context.latestExplicitOpen(keep: &keep))
            checks.append(await context.inlineFind(keep: &keep))
            checks.append(await context.codeLineEndings(keep: &keep))
            checks.append(await context.tableColumnWidths(keep: &keep))
            checks.append(await context.contentScript(keep: &keep))
            checks.append(await context.remoteLoads(keep: &keep))
            checks.append(await context.assetContainment(keep: &keep))
            checks.append(await context.find(keep: &keep))
            checks.append(await context.codeCopy(keep: &keep))
            checks.append(await context.externalLink(keep: &keep))
            checks.append(await context.pinnedOpen(keep: &keep))
            checks.append(await context.positionAcrossRefresh(keep: &keep))
            checks.append(await context.positionAcrossReopen(keep: &keep))
            checks.append(await context.launchOrigins(keep: &keep))
            checks.append(await context.recovery(keep: &keep))
        } catch {
            checks.append(Check(name: "setup", pass: false, detail: String(describing: error)))
        }
        for window in keep { window.close() }
        let pass = checks.allSatisfy(\.pass)
        CheckRunner.emit([
            "pass": pass,
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "checks": checks.map { ["name": $0.name, "pass": $0.pass, "detail": $0.detail] },
        ], to: output)
        return pass ? 0 : 1
    }
}

/// A store in the version-1 layout written for the checks, in a temporary directory.
struct VerifyStore {
    let root: URL
    let storeId: String

    init(root: URL) throws {
        self.root = root
        storeId = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        for directory in ["documents", "snapshots", "opens"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(directory), withIntermediateDirectories: true)
        }
        try json(["version": 1, "storeId": storeId], to: root.appendingPathComponent("store.json"))
    }

    static func newId() -> String {
        "md-" + (0..<10).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    static func digest(_ data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func json(_ object: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: object).write(to: url)
    }

    @discardableResult
    func write(_ id: String, revision: Int, source: String, kind: String = "published", references: Any? = nil, assets: [String: Data] = [:]) throws -> URL {
        let collection = kind == "published" ? "documents" : "snapshots"
        let documentDir = root.appendingPathComponent("\(collection)/\(id)")
        let revisionDir = documentDir.appendingPathComponent("revisions/\(revision)")
        try FileManager.default.createDirectory(at: revisionDir.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let data = Data(source.utf8)
        try data.write(to: revisionDir.appendingPathComponent("source.md"))
        for (name, bytes) in assets { try bytes.write(to: revisionDir.appendingPathComponent("assets/\(name)")) }
        var record: [String: Any] = [
            "version": 1, "document": id, "revision": revision, "title": "Check \(revision)", "createdAt": "2026-11-13T00:00:00Z",
            "digest": Self.digest(data), "bytes": data.count, "completeness": ["state": "complete"],
        ]
        if let references { record["references"] = references }
        try json(record, to: revisionDir.appendingPathComponent("revision.json"))
        try json([
            "version": 1, "id": id, "kind": kind, "title": "Check", "createdAt": "2026-11-13T00:00:00Z",
            "updatedAt": "2026-11-13T00:00:0\(revision)Z", "revision": revision, "digest": Self.digest(data), "bytes": data.count,
        ], to: documentDir.appendingPathComponent("document.json.tmp"))
        _ = try FileManager.default.replaceItemAt(documentDir.appendingPathComponent("document.json"), withItemAt: documentDir.appendingPathComponent("document.json.tmp"))
        return revisionDir
    }

    func reference(_ id: String) -> DocumentReference {
        .stored(root: FileAccess.canonicalPath(root.path), storeId: storeId, document: id)
    }
}

/// Counts connections to a loopback port. It proves that nothing was requested.
final class LoopbackListener: @unchecked Sendable {
    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func increment() { lock.withLock { value += 1 } }
        func reset() { lock.withLock { value = 0 } }
        var count: Int { lock.withLock { value } }
    }

    private let listener: NWListener
    private let counter = Counter()
    let port: UInt16

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        let counter = self.counter
        listener.newConnectionHandler = { connection in
            counter.increment()
            connection.cancel()
        }
        listener.start(queue: .global())
        _ = ready.wait(timeout: .now() + 5)
        port = listener.port?.rawValue ?? 0
    }

    var count: Int { counter.count }
    func reset() { counter.reset() }
    func stop() { listener.cancel() }
}

@MainActor
struct Context {
    let windows: WindowManager
    let workspace: URL
    let store: VerifyStore

    func js(_ model: ReaderModel, _ body: String, _ arguments: [String: Any] = [:]) async -> Any? {
        try? await model.page.callJavaScript(body, arguments: arguments, contentWorld: .world(name: "markdown-reader"))
    }

    func wait(seconds: Double, until condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return await condition()
    }

    func openFile(_ name: String, _ source: String, keep: inout [NSWindow]) async throws -> ReaderModel {
        let url = workspace.appendingPathComponent(name)
        try Data(source.utf8).write(to: url)
        return await open(.file(path: FileAccess.canonicalPath(url.path)), revision: nil, keep: &keep)
    }

    func open(_ reference: DocumentReference, revision: Int?, digest: String? = nil, state: ReadingStateStore? = nil, keep: inout [NSWindow]) async -> ReaderModel {
        let model = ReaderModel(reference: reference, platform: windows.platform, state: state ?? windows.state)
        keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
        await model.open(revision: revision, digest: digest, origin: nil)
        return model
    }

    static func png() -> Data {
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        image?.setColor(.red, atX: 0, y: 0)
        return image?.representation(using: .png, properties: [:]) ?? Data()
    }

    // MARK: - Checks

    func contentScript(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let model = try await openFile("script.md", "# Script check\n\nText.\n", keep: &keep)
            let injected = """
            <p id="probe">probe</p>
            <script>document.documentElement.dataset.ran = "body";</script>
            <img src="reader-asset://doc/none" onerror="document.documentElement.dataset.ran = 'onerror'">
            <a id="jslink" href="javascript:document.documentElement.dataset.ran='link'">x</a>
            """
            let html = PageTemplate.page(body: injected, title: "check", settings: PageSettings(), extraHead: "<script>document.documentElement.dataset.ran = 'head';</script>")
            await model.displayForCheck(html: html)
            _ = await js(model, "document.getElementById('jslink').click(); return true;")
            try? await Task.sleep(for: .milliseconds(400))
            let probe = await js(model, "return document.getElementById('probe') !== null") as? Bool ?? false
            let ran = await js(model, "return document.documentElement.dataset.ran || ''") as? String ?? "?"
            return .init(name: "content-javascript-disabled", pass: probe && ran.isEmpty, detail: probe ? "inline, event-handler and javascript: link scripts did not run (marker '\(ran)')" : "the page did not load")
        } catch {
            return .init(name: "content-javascript-disabled", pass: false, detail: String(describing: error))
        }
    }

    func remoteLoads(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let listener = try LoopbackListener()
            defer { listener.stop() }
            let base = "http://127.0.0.1:\(listener.port)"
            _ = try? await URLSession.shared.data(from: URL(string: base + "/control")!)
            let control = await wait(seconds: 3) { listener.count >= 1 }
            listener.reset()
            let model = try await openFile("remote.md", "# Remote\n\n![beacon](\(base)/markdown.png) [link](\(base)/link)\n", keep: &keep)
            let rendered = model.rendered?.body ?? ""
            let injected = """
            <link rel="stylesheet" href="\(base)/style.css">
            <link rel="preload" as="image" href="\(base)/preload.png">
            <link rel="prefetch" href="\(base)/prefetch">
            <img src="\(base)/image.png"><img srcset="\(base)/srcset.png 1x">
            <video src="\(base)/video.mp4" autoplay></video><iframe src="\(base)/frame"></iframe>
            <object data="\(base)/object"></object>
            """
            await model.displayForCheck(html: PageTemplate.page(body: rendered + injected, title: "remote", settings: PageSettings(), extraHead: "<link rel=\"stylesheet\" href=\"\(base)/head.css\">"))
            try? await Task.sleep(for: .seconds(2))
            let count = listener.count
            let pass = control && count == 0 && rendered.contains("Remote image not loaded")
            return .init(name: "no-remote-requests", pass: pass, detail: "control request reached the listener: \(control); requests from the page: \(count); markdown image shown as placeholder: \(rendered.contains("Remote image not loaded"))")
        } catch {
            return .init(name: "no-remote-requests", pass: false, detail: String(describing: error))
        }
    }

    func assetContainment(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let png = Self.png()
            let outside = workspace.appendingPathComponent("outside.png")
            try png.write(to: outside)
            let good = String(repeating: "a", count: 64)
            let linked = String(repeating: "b", count: 64)
            let id = VerifyStore.newId()
            let references: [String: Any] = ["state": "inspected", "omitted": 0, "items": [
                ["kind": "image", "reference": "good.png", "state": "retained", "file": "assets/\(good).png"],
                ["kind": "image", "reference": "linked.png", "state": "retained", "file": "assets/\(linked).png"],
            ]]
            let dir = try store.write(id, revision: 1, source: "# Assets\n\n![good](good.png)\n\n![linked](linked.png)\n", kind: "file", references: references, assets: ["\(good).png": png])
            try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("assets/\(linked).png"), withDestinationURL: outside)
            let model = await open(store.reference(id), revision: nil, keep: &keep)
            let loaded = await wait(seconds: 3) {
                (await js(model, "const i = document.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0") as? Bool) ?? false
            }
            let linkedShown = model.rendered?.unavailableImages.first?.reason == "outside-root"
            let refusedBefore = model.refusedAssetRequests
            // Requests the renderer never produces: traversal, unknown token, other host.
            _ = await js(model, """
            for (const src of ["reader-asset://doc/../../../../etc/hosts", "reader-asset://doc/a99", "reader-asset://other/x", "reader-asset://doc/%2e%2e%2fsecret"]) {
              const img = document.createElement("img"); img.className = "probe"; img.src = src; document.body.appendChild(img);
            }
            return true;
            """)
            let refused = await wait(seconds: 3) { model.refusedAssetRequests - refusedBefore >= 4 }
            // A retained file replaced by a symlink after rendering is refused when served.
            let retained = dir.appendingPathComponent("assets/\(good).png")
            try FileManager.default.removeItem(at: retained)
            try FileManager.default.createSymbolicLink(at: retained, withDestinationURL: outside)
            let beforeSwap = model.refusedAssetRequests
            _ = await js(model, "const img = document.createElement('img'); img.src = 'reader-asset://doc/a0?again'; document.body.appendChild(img); return true;")
            let swapRefused = await wait(seconds: 3) { model.refusedAssetRequests > beforeSwap }
            let pass = loaded && linkedShown && refused && swapRefused
            return .init(name: "asset-scheme-containment", pass: pass, detail: "retained image served: \(loaded); symlink escape shown as unavailable: \(linkedShown); traversal, unknown token and other host refused: \(refused); file swapped for a symlink refused: \(swapRefused)")
        } catch {
            return .init(name: "asset-scheme-containment", pass: false, detail: String(describing: error))
        }
    }

    func find(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let model = try await openFile("find.md", "# Find\n\nalpha needle beta\n\n| a | b |\n|---|---|\n| gamma | needle |\n\ndelta needle\n", keep: &keep)
            let position = "const r = getSelection().rangeCount ? getSelection().getRangeAt(0) : null; return r ? r.startContainer.parentElement.tagName + ':' + r.startContainer.textContent.slice(0, 12) + ':' + r.startOffset : ''"
            model.findQuery = "needle"
            await model.find()
            let first = await js(model, position) as? String ?? ""
            let text = await model.selectedText()
            await model.find()
            let second = await js(model, position) as? String ?? ""
            await model.find()
            let third = await js(model, position) as? String ?? ""
            await model.find(backwards: true)
            let back = await js(model, position) as? String ?? ""
            model.findQuery = "absent-word"
            await model.find()
            let missing = model.findStatus
            let pass = text == "needle" && !first.isEmpty && first != second && second != third && back == second && missing == .notFound
            return .init(name: "find-moves-selection", pass: pass, detail: "matches: [\(first)] [\(second)] [\(third)], previous: [\(back)], missing word: \(missing)")
        } catch {
            return .init(name: "find-moves-selection", pass: false, detail: String(describing: error))
        }
    }

    func latestExplicitOpen(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: "# First revision\n")
            try store.write(id, revision: 2, source: "# Second revision\n\n" + String(repeating: "A paragraph with **formatted** text.\n\n", count: 1000))
            let model = await open(store.reference(id), revision: 1, keep: &keep)
            let origin = LaunchOrigin(terminal: "Rex", bundleId: "com.superlogical.rex")
            var results: [String] = []
            var pass = true
            for duringDisplay in [false, true] {
                let pending = Task { await model.open(revision: 2, origin: origin) }
                let deadline = Date().addingTimeInterval(5)
                while Date() < deadline && (duringDisplay ? !model.isDisplayingForCheck : model.launchOrigin == nil) {
                    await Task.yield()
                }
                let overlapped = duringDisplay ? model.isDisplayingForCheck : model.launchOrigin != nil
                await model.open(revision: 1, origin: nil)
                await pending.value
                let heading = await js(model, "return document.querySelector('h1').textContent") as? String ?? "?"
                let correct = overlapped && model.snapshot?.revision == 1 && heading.trimmingCharacters(in: .whitespacesAndNewlines) == "First revision" && model.launchOrigin == nil
                pass = pass && correct
                results.append("\(duringDisplay ? "display" : "preparation") overlap: \(overlapped); revision: \(model.snapshot?.revision ?? 0); heading: \(heading)")
            }
            return .init(name: "latest-explicit-open-wins", pass: pass, detail: results.joined(separator: "; "))
        } catch { return .init(name: "latest-explicit-open-wins", pass: false, detail: String(describing: error)) }
    }

    func inlineFind(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let model = try await openFile("inline-find.md", "# Find\n\nSearch for **joined** words.\n\nSearch for joined words.\n", keep: &keep)
            let position = "const r = getSelection().getRangeAt(0); return r.startContainer.parentElement.tagName;"
            model.findQuery = "joined words"
            await model.find()
            let first = await js(model, position) as? String ?? ""
            let firstText = await model.selectedText()
            await model.find()
            let second = await js(model, position) as? String ?? ""
            let secondText = await model.selectedText()
            await model.find(backwards: true)
            let back = await js(model, position) as? String ?? ""
            let pass = first == "STRONG" && second == "P" && back == first && firstText == "joined words" && secondText == firstText
            return .init(name: "find-across-inline-formatting", pass: pass, detail: "first: \(first) [\(firstText)]; next: \(second) [\(secondText)]; previous: \(back)")
        } catch { return .init(name: "find-across-inline-formatting", pass: false, detail: String(describing: error)) }
    }

    func codeLineEndings(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let source = "```text\r\nfirst\r\nsecond\r\n```\r\n"
            let model = try await openFile("crlf-copy.md", source, keep: &keep)
            model.copyCode(0)
            let copied = CheckRunner.checkPasteboard.string(forType: .string) ?? ""
            let pass = copied == "first\r\nsecond" && model.snapshot?.source == source
            return .init(name: "code-copy-crlf", pass: pass, detail: "source retained exactly: \(model.snapshot?.source == source); copy UTF8: \(Array(copied.utf8))")
        } catch { return .init(name: "code-copy-crlf", pass: false, detail: String(describing: error)) }
    }

    func tableColumnWidths(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let url = workspace.appendingPathComponent("table-width.md")
            let source = """
            # Table

            | Label | Description | Code |
            |---|---|---|
            | One | Several ordinary words describe this `item` and explain its purpose. | `\(String(repeating: "long_identifier_", count: 5))` |

            | Term | Meaning |
            |---|---|
            | Fresh | The time during which a cache serves a stored response without a request to the origin, which sets it with `max-age` or with an expiry date in the response. |

            """
            try Data(source.utf8).write(to: url)
            var pass = true
            var details: [String] = []
            for width in [600.0, 900.0] {
                let model = ReaderModel(reference: .file(path: url.path), platform: windows.platform, state: windows.state)
                keep.append(CheckRunner.offscreenWindow(page: model.page, width: width, height: 700))
                await model.open(origin: nil)
                for textSize in [PageSettings.defaultTextSize, PageSettings.defaultTextSize + 2] {
                    model.settings = PageSettings(textSize: textSize, wrapCode: false)
                    _ = await wait(seconds: 2) {
                        (await js(model, "return document.documentElement.dataset.ts") as? String) == String(textSize)
                    }
                    let result = await js(model, """
                    const [wide, fitting] = document.querySelectorAll('table');
                    const widths = (t) => [...t.rows[1].cells].map(c => Math.round(c.getBoundingClientRect().width));
                    const em = parseFloat(getComputedStyle(wide.rows[1].cells[1]).fontSize);
                    const w = widths(wide), f = widths(fitting);
                    const code = wide.rows[1].cells[2].querySelector('code');
                    const selection = getSelection();
                    selection.selectAllChildren(wide.rows[1]);
                    const row = String(selection).trim();
                    selection.removeAllRanges();
                    const scrolls = wide.scrollWidth > wide.clientWidth && w[0] < 6 * em && w[1] >= 12 * em && w[1] <= 16 * em && w[2] > 30 * em && getComputedStyle(code).whiteSpace === 'nowrap';
                    const fits = fitting.scrollWidth <= fitting.clientWidth && f[1] > 18 * em;
                    return {pass: scrolls && fits && !row.includes('\\n'), detail: JSON.stringify({viewport: innerWidth, em, wide: {client: wide.clientWidth, scroll: wide.scrollWidth, cells: w}, fitting: {client: fitting.clientWidth, scroll: fitting.scrollWidth, cells: f}, rowLines: row.split('\\n').length})};
                    """) as? [String: Any]
                    pass = pass && result?["pass"] as? Bool == true
                    details.append("text \(textSize): \(result?["detail"] as? String ?? "no geometry")")
                }
            }
            return .init(name: "table-column-geometry", pass: pass, detail: details.joined(separator: "; "))
        } catch { return .init(name: "table-column-geometry", pass: false, detail: String(describing: error)) }
    }

    func codeCopy(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let literal = "\tlet tab = 1  \n<script>alert('x')</script> & \"quotes\"\nÜnïcödé 👩🏽‍💻 e\u{301}\n\n  trailing blank above"
            let model = try await openFile("copy.md", "# Copy\n\n```swift\n\(literal)\n```\n", keep: &keep)
            CheckRunner.checkPasteboard.clearContents()
            _ = await js(model, "document.querySelector('figure.code a.copy').click(); return true;")
            let copied = await wait(seconds: 3) { CheckRunner.checkPasteboard.string(forType: .string) != nil }
            let value = CheckRunner.checkPasteboard.string(forType: .string)
            CheckRunner.checkPasteboard.clearContents()
            _ = await js(model, "const a = document.createElement('a'); a.href = 'reader-action:copy-code/forged/0'; document.body.appendChild(a); a.click(); return true;")
            try? await Task.sleep(for: .milliseconds(500))
            let forged = CheckRunner.checkPasteboard.string(forType: .string)
            let pass = copied && value == literal && forged == nil
            return .init(name: "code-copy-exact", pass: pass, detail: "copied literal equals the fenced code: \(value == literal); action with a forged nonce copied nothing: \(forged == nil)")
        } catch {
            return .init(name: "code-copy-exact", pass: false, detail: String(describing: error))
        }
    }

    func externalLink(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let model = try await openFile("links.md", "[web](https://example.org/a) [inert](file:///etc/hosts)\n", keep: &keep)
            _ = await js(model, "document.querySelector('a.ext').click(); return true;")
            let asked = await wait(seconds: 3) { model.pendingExternalURL?.absoluteString == "https://example.org/a" }
            let inertIsLink = await js(model, "return document.querySelector('.inert-link').tagName") as? String
            model.pendingExternalURL = nil
            let pass = asked && inertIsLink == "SPAN"
            return .init(name: "external-link-confirmation", pass: pass, detail: "web link asked for confirmation instead of loading: \(asked); file: link rendered as \(inertIsLink ?? "?")")
        } catch {
            return .init(name: "external-link-confirmation", pass: false, detail: String(describing: error))
        }
    }

    func pinnedOpen(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: "# Revision one\n", kind: "response")
            try store.write(id, revision: 2, source: "# Revision two\n", kind: "response")
            let digest = VerifyStore.digest(Data("# Revision one\n".utf8))
            let requestURL = store.root.appendingPathComponent("opens/\(UUID().uuidString).json")
            try store.json(["version": 1, "storeId": store.storeId, "document": id, "revision": 1, "digest": digest, "requestedAt": "2026-11-13T00:00:00Z", "launchOrigin": NSNull()], to: requestURL)
            guard case .stored(let reader, let request, let file) = try OpenIntake.classify(requestURL) else {
                return .init(name: "pinned-open-request", pass: false, detail: "not classified as an open request")
            }
            _ = try OpenIntake.accept(reader, request, requestFile: file)
            let removed = !FileManager.default.fileExists(atPath: requestURL.path)
            let model = await open(store.reference(id), revision: request.revision, digest: request.digest, keep: &keep)
            let heading = await js(model, "return document.querySelector('h1').textContent.trim()") as? String
            let pass = removed && model.snapshot?.revision == 1 && heading == "Revision one" && model.update == .revision(2)
            return .init(name: "pinned-open-request", pass: pass, detail: "request removed on acceptance: \(removed); shown revision \(model.snapshot?.revision ?? 0) (\(heading ?? "?")); update notice: \(String(describing: model.update))")
        } catch {
            return .init(name: "pinned-open-request", pass: false, detail: String(describing: error))
        }
    }

    static func longDocument(insert: String = "", change: Int? = nil) -> String {
        var parts = ["# Long document\n"]
        if !insert.isEmpty { parts.append(insert) }
        for section in 1...20 {
            parts.append("## Section \(section)\n")
            for paragraph in 1...10 {
                let n = (section - 1) * 10 + paragraph
                let text = n == change ? "Changed paragraph \(n)." : "Paragraph \(n) of the long document, with enough words to wrap over a couple of lines at the reading measure so that offsets inside a block matter."
                parts.append(text + "\n")
            }
        }
        return parts.joined(separator: "\n")
    }

    func positionAcrossRefresh(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: Self.longDocument())
            let model = await open(store.reference(id), revision: nil, keep: &keep)
            _ = await js(model, """
            const block = [...document.querySelectorAll('[data-key]')].find(b => b.textContent.trim().startsWith('Paragraph 120 '));
            const rect = block.getBoundingClientRect();
            window.scrollTo(0, rect.top + window.scrollY + 0.4 * rect.height);
            document.body.dataset.marker = "kept";
            return true;
            """)
            let before = await model.capturePositionForCheck()
            let scrollBefore = await js(model, "return window.scrollY") as? Double ?? -1
            _ = await js(model, "const p = [...document.querySelectorAll('p')].find(p => p.textContent.startsWith('Paragraph 121 ')); getSelection().selectAllChildren(p); return true;")
            try store.write(id, revision: 2, source: Self.longDocument(insert: "An inserted paragraph.\n\nAnother inserted paragraph.\n", change: 30))
            let watched = await wait(seconds: 3) { model.update == .revision(2) }
            let marker = await js(model, "return document.body.dataset.marker || ''") as? String
            let scrollDuring = await js(model, "return window.scrollY") as? Double ?? -2
            let selection = await model.selectedText()
            await model.refresh()
            let after = await model.capturePositionForCheck()
            let shown = model.snapshot?.revision
            let samePlace = before?.blockKey != nil && before?.blockKey == after?.blockKey && abs((before?.fraction ?? 0) - (after?.fraction ?? 1)) < 0.05
            let pass = watched && model.update == nil && marker == "kept" && scrollDuring == scrollBefore && selection.hasPrefix("Paragraph 121") && shown == 2 && model.lastRestore == .block && samePlace
            return .init(name: "position-survives-refresh", pass: pass, detail: "update noticed by the watcher: \(watched); page untouched until refresh (marker \(marker ?? "?"), scroll \(scrollBefore) -> \(scrollDuring), selection kept: \(selection.hasPrefix("Paragraph 121"))); after refresh revision \(shown ?? 0), restore \(model.lastRestore.rawValue), block \(before?.blockKey ?? "-") -> \(after?.blockKey ?? "-"), fraction \(before?.fraction ?? -1) -> \(after?.fraction ?? -1)")
        } catch {
            return .init(name: "position-survives-refresh", pass: false, detail: String(describing: error))
        }
    }

    /// The second window reads its position from a second state store built from the same
    /// directory, so the check covers the state file on disk.
    func positionAcrossReopen(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: Self.longDocument(), kind: "response")
            let stateDirectory = workspace.appendingPathComponent("reading-state")
            let first = await open(store.reference(id), revision: nil, state: ReadingStateStore(directory: stateDirectory), keep: &keep)
            _ = await js(first, "window.scrollTo(0, 3100); return true;")
            first.scrolled()
            try? await Task.sleep(for: .milliseconds(800))
            let saved = await first.capturePositionForCheck()
            await first.close()
            let second = await open(store.reference(id), revision: nil, state: ReadingStateStore(directory: stateDirectory), keep: &keep)
            let restored = await second.capturePositionForCheck()
            let scroll = await js(second, "return window.scrollY") as? Double ?? 0
            let pass = second.lastRestore == .block && saved?.blockKey == restored?.blockKey && abs(scroll - 3100) < 40
            return .init(name: "position-survives-reopen", pass: pass, detail: "closed at scroll 3100 (block \(saved?.blockKey ?? "-")); reopened at \(Int(scroll)) (block \(restored?.blockKey ?? "-"), restore \(second.lastRestore.rawValue))")
        } catch {
            return .init(name: "position-survives-reopen", pass: false, detail: String(describing: error))
        }
    }

    func launchOrigins(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let model = try await openFile("origin.md", "# Origin\n", keep: &keep)
            let rex = LaunchOrigin(terminal: "Rex", bundleId: "com.superlogical.rex", exact: .object(["session": .string("s1")]))
            let other = LaunchOrigin(terminal: "Rex", bundleId: "com.superlogical.rex", exact: .object(["session": .string("s2")]))
            await model.open(revision: nil, origin: rex)
            let first = model.launchOrigin?.exact
            await model.open(revision: nil, origin: other)
            let second = model.launchOrigin?.exact
            await model.open(revision: nil, origin: nil)
            let third = model.returnLabel
            await model.open(revision: nil, origin: LaunchOrigin(terminal: "Terminal", bundleId: "com.apple.Terminal"))
            let fourth = model.returnLabel
            let pass = first == .object(["session": .string("s1")]) && second == .object(["session": .string("s2")]) && third == nil && fourth == nil
            return .init(name: "launch-origin-per-open", pass: pass, detail: "a second explicit open replaced the window's origin: \(second != first); an open without origin (recents, Finder) removed Return to Rex: \(third == nil); an origin outside the version-1 contract was ignored: \(fourth == nil)")
        } catch {
            return .init(name: "launch-origin-per-open", pass: false, detail: String(describing: error))
        }
    }

    func recovery(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let model = try await openFile("recover.md", Self.longDocument(), keep: &keep)
            _ = await js(model, "window.scrollTo(0, 2400); return true;")
            model.scrolled()
            try? await Task.sleep(for: .milliseconds(800))
            let before = model.recoveries
            guard let window = keep.last, let pid = ProcessProbe.webContentProcess(of: window) else {
                return .init(name: "webcontent-recovery", pass: false, detail: "the page's web content process was not found")
            }
            let processes = [pid]
            kill(pid, SIGKILL)
            let recovered = await wait(seconds: 10) { model.recoveries > before }
            let content = await wait(seconds: 5) {
                (await js(model, "return document.querySelectorAll('[data-key]').length") as? Int ?? 0) > 100
            }
            let scroll = await js(model, "return window.scrollY") as? Double ?? 0
            let pass = recovered && content && scroll > 1000
            return .init(name: "webcontent-recovery", pass: pass, detail: "killed \(processes.count) content process(es); reloaded: \(recovered); content back: \(content); scroll position after reload: \(Int(scroll)) (was 2400); saved \(String(describing: model.savedPositionForCheck)); restore \(model.lastRestore.rawValue)")
        } catch {
            return .init(name: "webcontent-recovery", pass: false, detail: String(describing: error))
        }
    }
}
