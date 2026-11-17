import AppKit
import CryptoKit
import EditorFeature
import MarkdownCore
import Network
import ReaderFeature
import WebKit

/// Offscreen checks of the bundled reader page, its bridge, containment and document lifecycle.
/// Missing page resources are a failed integration check, never a substitute test interface.
@MainActor
struct Verification {
    let windows: WindowManager

    struct Check {
        var name: String
        var pass: Bool
        var detail: String
        var skipped = false

        var json: [String: Any] {
            ["name": name, "pass": pass, "detail": detail, "status": skipped ? "skipped" : pass ? "passed" : "failed"]
        }
    }

    static let pageCheckNames = [
        "latest-explicit-open-wins", "find-across-inline-formatting", "code-copy-crlf", "table-column-geometry",
        "document-script-inert-under-csp", "reading-lock-blocks-edit", "bridge-typing-exact-line-endings",
        "no-remote-requests", "asset-scheme-containment", "image-inspection-deadline", "find-moves-selection",
        "code-copy-exact", "external-link-confirmation", "pinned-open-request", "initial-gap-announces-update",
        "initial-gap-follows-latest", "position-captured-at-installation", "interaction-during-revision-preparation",
        "position-survives-refresh", "position-survives-reopen", "launch-origin-per-open", "webcontent-recovery",
        "selected-revision-exports",
    ]

    func run(output: String?) async -> Int32 {
        let workspace = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-reader-verify-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: workspace) }
        var checks: [Check] = []
        var keep: [NSWindow] = []
        let deadline = VerificationDeadline()
        func run(_ name: String, operation: () async -> Check) async {
            let previous = checks
            deadline.start { stage in
                CheckRunner.emit([
                    "pass": false,
                    "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
                    "checks": (previous + [Check(name: name, pass: false, detail: "Deadline exceeded (30 seconds); stage: \(stage)")])
                        .map(\.json),
                ], to: output)
                exit(1)
            }
            checks.append(await operation())
            deadline.stop()
        }
        do {
            let store = try VerifyStore(root: workspace.appendingPathComponent("store"))
            let context = Context(windows: windows, workspace: workspace, store: store, progress: deadline)
            var loaded = Check(name: "bundled-reader-page-csp", pass: false, detail: "The page load did not complete.")
            await run(loaded.name) {
                loaded = await context.pageLoad(keep: &keep)
                return loaded
            }
            if loaded.pass {
                await run("latest-explicit-open-wins") { await context.latestExplicitOpen(keep: &keep) }
                await run("find-across-inline-formatting") { await context.inlineFind(keep: &keep) }
                await run("code-copy-crlf") { await context.codeLineEndings(keep: &keep) }
                await run("table-column-geometry") { await context.tableColumnWidths(keep: &keep) }
                await run("document-script-inert-under-csp") { await context.contentScript(keep: &keep) }
                await run("reading-lock-blocks-edit") { await context.readingLock(keep: &keep) }
                await run("bridge-typing-exact-line-endings") { await context.typing(keep: &keep) }
                await run("no-remote-requests") { await context.remoteLoads(keep: &keep) }
                await run("asset-scheme-containment") { await context.assetContainment(keep: &keep) }
                await run("image-inspection-deadline") { await context.imageInspectionDeadline(keep: &keep) }
                await run("find-moves-selection") { await context.find(keep: &keep) }
                await run("code-copy-exact") { await context.codeCopy(keep: &keep) }
                await run("external-link-confirmation") { await context.externalLink(keep: &keep) }
                await run("pinned-open-request") { await context.pinnedOpen(keep: &keep) }
                await run("initial-gap-announces-update") { await context.initialRevisionGap(followsLatest: false, keep: &keep) }
                await run("initial-gap-follows-latest") { await context.initialRevisionGap(followsLatest: true, keep: &keep) }
                await run("position-captured-at-installation") { await context.positionAtInstallation(keep: &keep) }
                await run("interaction-during-revision-preparation") { await context.interactionDuringPreparation(keep: &keep) }
                await run("position-survives-refresh") { await context.positionAcrossRefresh(keep: &keep) }
                await run("position-survives-reopen") { await context.positionAcrossReopen(keep: &keep) }
                await run("launch-origin-per-open") { await context.launchOrigins(keep: &keep) }
                await run("webcontent-recovery") { await context.recovery(keep: &keep) }
                await run("selected-revision-exports") { await context.revisionExports(keep: &keep) }
            } else {
                checks += Self.pageCheckNames.map {
                    Check(name: $0, pass: false, detail: "Skipped: the bundled reader page did not load. \(loaded.detail)", skipped: true)
                }
            }
            await run("library-unavailable-is-not-empty") { await context.honestLibrary() }
            await run("library-continuation-and-shared-recents") { await context.libraryContinuation() }
            await run("explicit-store-selection") { await context.storeSelection() }
        } catch {
            checks.append(Check(name: "setup", pass: false, detail: String(describing: error)))
        }
        for window in keep { window.close() }
        let pass = checks.allSatisfy(\.pass)
        CheckRunner.emit([
            "pass": pass,
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "checks": checks.map(\.json),
        ], to: output)
        return pass ? 0 : 1
    }
}

/// Captures startup diagnostics before any page script runs, without a product-only test API.
@MainActor
final class CheckDiagnostics: NSObject, WKScriptMessageHandler {
    private(set) var errors: [String] = []
    private let name = "readerCheckDiagnostics"

    func install(on webView: WKWebView) {
        let controller = webView.configuration.userContentController
        controller.add(self, name: name)
        controller.addUserScript(WKUserScript(source: """
        (() => {
          const report = message => window.webkit.messageHandlers.readerCheckDiagnostics.postMessage(String(message).slice(0, 2000));
          const original = console.error.bind(console);
          console.error = (...args) => { report(args.map(String).join(' ')); original(...args); };
          addEventListener('error', event => report(event.message || 'Page resource failed: ' + (event.target?.src || event.target?.href || 'unknown')), true);
          addEventListener('unhandledrejection', event => report(event.reason));
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    }

    func remove(from webView: WKWebView) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: name)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard errors.count < 32, let text = message.body as? String else { return }
        errors.append(text)
    }
}

/// Holds a prepared revision until the verification publishes or interacts with the old page.
@MainActor
final class RevisionPreparationGate {
    private(set) var reached = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        reached = true
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        released = true
        continuation?.resume()
        continuation = nil
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
        let pointer = documentDir.appendingPathComponent("document.json")
        let pending = documentDir.appendingPathComponent("document.json.tmp")
        if FileManager.default.fileExists(atPath: pointer.path) {
            _ = try FileManager.default.replaceItemAt(pointer, withItemAt: pending)
        } else {
            try FileManager.default.moveItem(at: pending, to: pointer)
        }
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
    var progress: VerificationDeadline? = nil

    func js(_ model: ReaderModel, _ body: String, _ arguments: [String: Any] = [:]) async -> Any? {
        progress?.stage = "DOM inspection"
        return try? await model.page.callJavaScript(body, arguments: arguments, contentWorld: .page)
    }

    func wait(seconds: Double, until condition: () async -> Bool) async -> Bool {
        progress?.stage = "waiting for check condition"
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

    func open(_ reference: DocumentReference, revision: Int?, digest: String? = nil, state: ReadingStateStore? = nil, trackedScroll: Bool = false, keep: inout [NSWindow]) async -> ReaderModel {
        let model = ReaderModel(reference: reference, platform: CheckRunner.platform(), state: state ?? windows.state)
        keep.append(trackedScroll ? readerWindow(model) : CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
        progress?.stage = "opening document"
        await model.open(revision: revision, digest: digest, origin: nil)
        try? await CheckRunner.preparePageForCheck(model)
        progress?.stage = "document opened"
        return model
    }

    func readerWindow(_ model: ReaderModel) -> NSWindow {
        CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700)
    }

    static func png() -> Data {
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        image?.setColor(.red, atX: 0, y: 0)
        return image?.representation(using: .png, properties: [:]) ?? Data()
    }

    // MARK: - Checks

    func pageLoad(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "bundled-reader-page-csp"
        do {
            let url = workspace.appendingPathComponent("page-load.md")
            try Data("# Reader page\n\nThe bundled interface must load.\n".utf8).write(to: url)
            let model = ReaderModel(reference: .file(path: url.path), platform: CheckRunner.platform(), state: windows.state)
            let diagnostics = CheckDiagnostics()
            diagnostics.install(on: model.page.webView)
            defer { diagnostics.remove(from: model.page.webView) }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            let loaded = await js(model, """
            await new Promise(requestAnimationFrame);
            return location.protocol === 'reader-app:' && location.host === 'app'
              && typeof globalThis.reader?.receive === 'function'
              && !!document.querySelector('[data-role="document"] h1');
            """) as? Bool == true
            let trustedTypes = await js(model, """
            try { document.createElement('div').innerHTML = '<p>untrusted</p>'; return false; }
            catch (error) { return error instanceof TypeError; }
            """) as? Bool == true
            await Task.yield()
            let errors = diagnostics.errors + model.page.consoleErrors
            await model.close()
            return .init(name: name, pass: loaded && trustedTypes && errors.isEmpty,
                         detail: "reader-app page and document loaded: \(loaded); Trusted Types enforced: \(trustedTypes); startup errors: \(errors)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// Uses the document bridge's HTML sink, including markup the renderer must never produce.
    func installProbeHTML(_ html: String, model: ReaderModel) async throws {
        try CheckRunner.requireReady(model)
        _ = try await model.sendEnvelope([
            "v": 1, "type": "document", "generation": model.sourceGeneration,
            "meta": ["documentId": "check", "kind": "localFile", "title": "Security check", "shortId": "check",
                     "revision": NSNull(), "revisions": [], "digest": model.snapshot?.digest ?? "",
                     "provenance": "Offscreen check", "capturedSource": false] as [String: Any],
            "source": "Security check", "blocks": [["key": "check-probe", "start": 0, "end": 14, "type": "paragraph", "html": html]],
            "headings": [], "settings": ["lock": "reading", "textSize": PageSettings().textSizeMultiplier, "textSizeSteps": PageSettings.textSizeMultipliers, "codeWrap": false, "appearance": "system", "outlineWidth": 200, "outlineOpen": false] as [String: Any],
            "chrome": "pane", "live": false,
        ])
    }

    func contentScript(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "document-script-inert-under-csp"
        do {
            let source = "# Script check\n\n<script>document.documentElement.dataset.ran='source'</script>\n\n<img src='x' onerror=\"document.documentElement.dataset.ran='source-error'\">\n\n[x](javascript:alert(1))\n"
            let model = try await openFile("script.md", source, keep: &keep)
            try CheckRunner.requireReady(model)
            let sourceInert = await js(model, "return !document.documentElement.dataset.ran && !document.querySelector('[data-role=\"document\"] script, [data-role=\"document\"] [onerror]');") as? Bool == true
            try await installProbeHTML("""
            <p id="probe">probe</p>
            <script>document.documentElement.dataset.ran = 'body';</script>
            <img id="error-probe" src="reader-asset://doc/none" onerror="document.documentElement.dataset.ran = 'onerror'">
            <a id="jslink" href="javascript:document.documentElement.dataset.ran='link'">x</a>
            """, model: model)
            let exercised = await js(model, """
            const image = document.getElementById('error-probe');
            if (!image || !document.getElementById('probe') || !document.getElementById('jslink')) return false;
            if (!image.complete) await new Promise(resolve => { image.addEventListener('error', resolve, {once:true}); image.addEventListener('load', resolve, {once:true}); setTimeout(resolve, 1000); });
            image.dispatchEvent(new Event('error'));
            document.getElementById('jslink').click();
            await new Promise(resolve => setTimeout(resolve, 100));
            return true;
            """) as? Bool == true
            let ran = await js(model, "return document.documentElement.dataset.ran || ''") as? String ?? "unavailable"
            return .init(name: name, pass: sourceInert && exercised && ran.isEmpty,
                         detail: "renderer neutralised raw script: \(sourceInert); malicious HTML reached the bridge sink: \(exercised); script/onerror/javascript marker: '\(ran)'")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    func readingLock(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "reading-lock-blocks-edit"
        do {
            let source = "# Lock\n\nA paragraph stays read-only.\n"
            let model = try await openFile("lock.md", source, keep: &keep)
            try CheckRunner.requireReady(model)
            await model.sendCommand("toggleLock", args: ["lock": "reading"])
            let noEditor = await js(model, """
            const block = document.querySelector('[data-role="document"] [data-block][data-start]');
            if (!block) return false;
            block.click();
            return !document.querySelector('[data-role="block-editor"]')
              && !document.querySelector('[data-role="document"] [contenteditable="plaintext-only"]');
            """) as? Bool == true
            let exact = Data(model.source.utf8) == Data(source.utf8)
            return .init(name: name, pass: noEditor && exact, detail: "Reading has no block editor: \(noEditor); source unchanged: \(exact)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    func typing(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "bridge-typing-exact-line-endings"
        do {
            var details: [String] = []
            var pass = true
            for (index, source) in ["# Type\n\nalpha\n\nomega\n", "# Type\r\n\r\nalpha\r\n\r\nomega\r\n", "# Type\r\ralpha\r\romega\r", "# Type\r\n\r\nalpha\n\nomega\r"].enumerated() {
                let file = workspace.appendingPathComponent("typing-\(index).md")
                try Data(source.utf8).write(to: file)
                let state = ReadingStateStore(directory: nil)
                let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: state)
                let editor = EditorWorkspace(directory: workspace.appendingPathComponent("typing-\(index)-drafts"), store: nil)
                editor.add(DraftRecord(source: source))
                let owner = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
                defer { withExtendedLifetime(owner) {} }
                keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
                await model.open(origin: nil)
                try await CheckRunner.preparePageForCheck(model)
                await model.sendCommand("toggleLock", args: ["lock": "writing"])
                let inserted = await js(model, """
                const block = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.trim() === 'alpha');
                if (!block) return false;
                block.click();
                const editor = document.querySelector('[data-role="block-editor"]');
                if (!editor) return false;
                editor.focus();
                const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
                const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
                document.execCommand('insertText', false, ' 👩🏽‍💻 e\\u0301');
                return true;
                """) as? Bool == true
                let expected = source.replacingOccurrences(of: "alpha", with: "alpha 👩🏽‍💻 e\u{301}")
                let mirrored = await wait(seconds: 3) { Data(model.source.utf8) == Data(expected.utf8) }
                await model.sendCommand("undo")
                let undone = await wait(seconds: 3) { Data(model.source.utf8) == Data(source.utf8) }
                await model.sendCommand("redo")
                let redone = await wait(seconds: 3) { Data(model.source.utf8) == Data(expected.utf8) }
                let ownerExact = editor.active.map { Data($0.text.source.utf8) == Data(expected.utf8) } == true
                pass = pass && inserted && mirrored && undone && redone && ownerExact
                details.append("case \(index): typed \(inserted), mirror \(mirrored), Undo \(undone), Redo \(redone), owner \(ownerExact)")
                await editor.closeViews()
                await model.close()
            }
            return .init(name: name, pass: pass, detail: details.joined(separator: "; "))
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
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
            try await installProbeHTML(rendered + injected, model: model)
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
            let good = String(VerifyStore.digest(png).dropFirst(7))
            let linked = String(repeating: "b", count: 64)
            let id = VerifyStore.newId()
            let references: [String: Any] = ["state": "inspected", "omitted": 0, "items": [
                ["kind": "image", "reference": "good.png", "state": "retained", "file": "assets/\(good).png", "mediaType": "image/png", "bytes": png.count, "digest": "sha256:\(good)"],
                ["kind": "image", "reference": "linked.png", "state": "retained", "file": "assets/\(linked).png", "mediaType": "image/png", "bytes": png.count, "digest": "sha256:\(linked)"],
            ]]
            let dir = try store.write(id, revision: 1, source: "# Assets\n\n![good](good.png)\n\n![linked](linked.png)\n", kind: "file", references: references, assets: ["\(good).png": png])
            try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("assets/\(linked).png"), withDestinationURL: outside)
            let model = await open(store.reference(id), revision: nil, keep: &keep)
            let loaded = await wait(seconds: 3) {
                (await js(model, "const i = document.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0") as? Bool) ?? false
            }
            let displayedEvidence = await model.inspectImages().contains { $0.reference == "good.png" && $0.served && $0.displayed && $0.failure == nil }
            _ = await js(model, "return document.images.length;")
            let repeatedEvidence = await model.inspectImages()
            let repeatedDetails = Provenance.details(model.snapshot, rendered: model.rendered, latestRevision: model.latestRevision, origin: nil, imageEvidence: repeatedEvidence)
            let displayRetained = repeatedEvidence.contains { $0.reference == "good.png" && $0.displayed }
                && repeatedDetails.contains { $0.0 == "Image state" && $0.1.hasPrefix("good.png:") && $0.1.contains("displayed yes (decoded)") }
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
            // Same-size mutation after a successful serve must invalidate cached validation.
            let retained = dir.appendingPathComponent("assets/\(good).png")
            try Data(repeating: 0, count: png.count).write(to: retained)
            let beforeMutation = model.refusedAssetRequests
            _ = await js(model, "const i = document.querySelector('img[data-asset]'); i.src = 'reader-asset://doc/a0?modified'; return true;")
            let mutationRefused = await wait(seconds: 3) { model.refusedAssetRequests > beforeMutation }
            let evidence = await model.inspectImages()
            let placeholderVisible = (await js(model, "return document.body.textContent.includes('Image unavailable:')") as? Bool) ?? false
            let detailRows = Provenance.details(model.snapshot, rendered: model.rendered, latestRevision: model.latestRevision, origin: nil, imageEvidence: evidence)
            let qualified = evidence.contains { !$0.displayed && $0.failure?.contains("recorded digest") == true }
                && placeholderVisible && detailRows.contains { $0.1.contains("recorded digest") }
            // A retained file replaced by a symlink after rendering is refused when served.
            try FileManager.default.removeItem(at: retained)
            try FileManager.default.createSymbolicLink(at: retained, withDestinationURL: outside)
            let beforeSwap = model.refusedAssetRequests
            _ = await js(model, "const img = document.createElement('img'); img.src = 'reader-asset://doc/a0?again'; document.body.appendChild(img); return true;")
            let swapRefused = await wait(seconds: 3) { model.refusedAssetRequests > beforeSwap }
            let pass = loaded && displayedEvidence && displayRetained && linkedShown && refused && swapRefused && mutationRefused && qualified
            return .init(name: "asset-scheme-containment", pass: pass, detail: "retained image decoded: \(loaded), displayed evidence: \(displayedEvidence), repeated Details evidence retained: \(displayRetained); symlink escape shown as unavailable: \(linkedShown); traversal, unknown token and other host refused: \(refused); same-size mutation refused: \(mutationRefused), qualified page failure: \(qualified); file swapped for a symlink refused: \(swapRefused)")
        } catch {
            return .init(name: "asset-scheme-containment", pass: false, detail: String(describing: error))
        }
    }

    func revisionExports(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let png = Self.png()
            let name = String(VerifyStore.digest(png).dropFirst(7)) + ".png"
            let id = VerifyStore.newId()
            let references: [String: Any] = ["state": "inspected", "items": [
                ["kind": "image", "reference": "diagram.png", "state": "retained", "file": "assets/\(name)", "mediaType": "image/png", "bytes": png.count, "digest": VerifyStore.digest(png)]
            ]]
            let directory = try store.write(id, revision: 1, source: "# Selected export\n\n![Diagram](diagram.png)\n", references: references, assets: [name: png])
            try store.write(id, revision: 2, source: "# Later revision")
            let archive = workspace.appendingPathComponent("selected-archive")
            let sharing = workspace.appendingPathComponent("selected-sharing")
            let pdf = workspace.appendingPathComponent("selected-page.pdf")
            var platform = CheckRunner.platform()
            platform.exportRevision = { snapshot, form in
                let target = form == .archive ? archive : sharing
                try await Task.detached { try RevisionExporter.export(snapshot, to: target, form: form) }.value
                return target
            }
            platform.savePDF = { data, _ in try data.write(to: pdf); return pdf }
            let model = ReaderModel(reference: store.reference(id), platform: platform, state: windows.state)
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 620, height: 700))
            await model.open(revision: 1, origin: nil)
            await model.exportRevision(.archive)
            await model.exportRevision(.sharing)
            await model.exportCurrentPagePDF()
            let source = try Data(contentsOf: directory.appendingPathComponent("source.md"))
            let exact = try Data(contentsOf: archive.appendingPathComponent("source.md")) == source
                && Data(contentsOf: archive.appendingPathComponent("revision.json")) == Data(contentsOf: directory.appendingPathComponent("revision.json"))
            let shared = await open(.file(path: sharing.appendingPathComponent("document.md").path), revision: nil, keep: &keep)
            let evidence = await shared.inspectImages()
            let portable = evidence.contains { $0.served && $0.displayed && $0.failure == nil }
                && !FileManager.default.fileExists(atPath: sharing.appendingPathComponent("revision.json").path)
            let pdfBytes = try Data(contentsOf: pdf)
            let rendered = pdfBytes.starts(with: Data("%PDF".utf8))
            let unchanged = try Data(contentsOf: directory.appendingPathComponent("source.md")) == source
            return .init(name: "selected-revision-exports", pass: exact && portable && rendered && unchanged,
                         detail: "selected archival bytes exact: \(exact); derived sharing image displayed without original records: \(portable); current page PDF produced: \(rendered); original source unchanged: \(unchanged)")
        } catch { return .init(name: "selected-revision-exports", pass: false, detail: String(describing: error)) }
    }

    func storeSelection() async -> Verification.Check {
        do {
            let seed = try VerifyStore(root: workspace.appendingPathComponent("selection-seed"))
            let chosen = try VerifyStore(root: workspace.appendingPathComponent("selection-chosen"))
            let chosenRoot = FileAccess.canonicalPath(chosen.root.path)
            let id = VerifyStore.newId()
            try seed.write(VerifyStore.newId(), revision: 1, source: "# Seed")
            try chosen.write(id, revision: 1, source: "# Chosen")
            let directory = workspace.appendingPathComponent("selection-state")
            let state = ReadingStateStore(directory: directory)
            let model = LibraryModel(state: state, extraRoots: [seed.root.path])
            let scan = Task { await model.reload() }
            await Task.yield()
            await model.selectStore(chosen.root.path)
            await scan.value
            let selected = state.selectedStoreRoot == chosenRoot && model.sections.contains { $0.rows.contains { $0.record?.id == id } }
            let separate = model.sections.filter { $0.id != "recent" }.allSatisfy { $0.id.hasPrefix(chosenRoot + "|") } && state.recents.isEmpty
            _ = await state.flush(timeout: 2)
            let reopened = LibraryModel(state: ReadingStateStore(directory: directory), extraRoots: [seed.root.path])
            await reopened.reload()
            let remembered = reopened.selectedRoot == chosenRoot && reopened.availableRoots.contains(chosenRoot)
            await reopened.selectStore(workspace.appendingPathComponent("not-a-store").path)
            let refused = reopened.selectionFailure != nil && reopened.selectedRoot == chosenRoot
            return .init(name: "explicit-store-selection", pass: selected && separate && remembered && refused,
                         detail: "selected folder shown: \(selected); no merged collections or fake recent: \(separate); choice survives another reader: \(remembered); invalid folder leaves prior choice: \(refused)")
        } catch { return .init(name: "explicit-store-selection", pass: false, detail: String(describing: error)) }
    }

    func libraryContinuation() async -> Verification.Check {
        do {
            let fixture = try VerifyStore(root: workspace.appendingPathComponent("continuing-library"))
            let target = VerifyStore.newId()
            try fixture.write(target, revision: 1, source: "# Content-only-token")
            for _ in 0..<104 { try fixture.write(VerifyStore.newId(), revision: 1, source: "# Another document") }
            let stateDirectory = workspace.appendingPathComponent("library-reading-state")
            let state = ReadingStateStore(directory: stateDirectory)
            let model = LibraryModel(state: state, extraRoots: [fixture.root.path])
            await model.reload()
            let first = model.sections.first { $0.id.hasSuffix("|published") }
            let bounded = first?.rows.count == 100 && first?.hasMore == true
            if let id = first?.id { await model.loadMore(id) }
            let complete = model.sections.first { $0.id.hasSuffix("|published") }
            let reached = complete?.rows.count == 105 && complete?.hasMore == false
            model.filter = target
            model.sourceQuery = "content-only-token"
            await model.searchNextSources()
            let contentFound = model.sections.contains { section in model.visibleRows(section).contains { $0.record?.id == target } }
            let other = ReadingStateStore(directory: stateDirectory)
            other.noteOpened(fixture.reference(target), title: "Read elsewhere")
            let save = await other.flush(timeout: 2)
            await model.reload()
            let shared = save == .saved && model.sections.first?.rows.contains(where: { $0.title == "Read elsewhere" }) == true
            return .init(name: "library-continuation-and-shared-recents", pass: bounded && reached && contentFound && shared,
                         detail: "bounded first page: \(bounded); next page reached remaining documents: \(reached); separate content search: \(contentFound); another reader's saved recent refreshed: \(shared)")
        } catch {
            return .init(name: "library-continuation-and-shared-recents", pass: false, detail: String(describing: error))
        }
    }

    func honestLibrary() async -> Verification.Check {
        do {
            let fixture = try VerifyStore(root: workspace.appendingPathComponent("library-store"))
            let good = VerifyStore.newId()
            let bad = VerifyStore.newId()
            try fixture.write(good, revision: 1, source: "# Usable row")
            try fixture.write(bad, revision: 1, source: "# Broken row")
            let documents = fixture.root.appendingPathComponent("documents")
            try Data("{}".utf8).write(to: documents.appendingPathComponent("\(bad)/document.json"))
            let model = LibraryModel(state: ReadingStateStore(directory: nil), extraRoots: [fixture.root.path])
            await model.reload()
            let partial = model.sections.first { $0.id.hasSuffix("|published") }
            let kept = partial?.rows.count == 1 && partial?.note?.contains("omitted") == true
            try FileManager.default.moveItem(at: documents, to: fixture.root.appendingPathComponent("held-documents"))
            try Data().write(to: documents)
            await model.reload()
            let failed = model.sections.first { $0.id.hasSuffix("|published") }
            let honest = failed?.note?.contains("unavailable") == true && failed?.note?.contains("No published documents") == false
            return .init(name: "library-unavailable-is-not-empty", pass: kept && honest,
                         detail: "usable row kept with omission: \(kept); unavailable collection shown without false empty state: \(honest)")
        } catch {
            return .init(name: "library-unavailable-is-not-empty", pass: false, detail: String(describing: error))
        }
    }

    func imageInspectionDeadline(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let image = workspace.appendingPathComponent("deadline.png")
            try Self.png().write(to: image)
            let model = try await openFile("deadline.md", "# Bounded image inspection\n\n![image](deadline.png)\n", keep: &keep)
            _ = await js(model, """
            const original = document.querySelector('img[data-asset]');
            const replacement = original.cloneNode(true);
            replacement.decode = () => new Promise(() => {});
            original.replaceWith(replacement);
            return true;
            """)
            let start = ContinuousClock.now
            let evidence = await model.inspectImages()
            let elapsed = start.duration(to: .now)
            let unconfirmed = evidence.count == 1 && !evidence[0].displayed && evidence[0].failure == nil
            let ready = model.phase == .ready
            let bounded = elapsed < .seconds(3)
            return .init(name: "image-inspection-deadline", pass: ready && bounded && unconfirmed,
                         detail: "never-settling decode bounded: \(bounded); page ready: \(ready); display unconfirmed without false failure: \(unconfirmed)")
        } catch {
            return .init(name: "image-inspection-deadline", pass: false, detail: String(describing: error))
        }
    }

    func findState(_ model: ReaderModel, query: String) async -> ReaderBridgeFindState? {
        await model.sendCommand("find", args: ["query": query])
        guard await wait(seconds: 3, until: { model.pageState?.find?.query == query }) else { return nil }
        return model.pageState?.find
    }

    func advanceFind(_ model: ReaderModel, backwards: Bool = false) async -> ReaderBridgeFindState? {
        let previous = model.pageState?.find?.index
        await model.sendCommand(backwards ? "findPrevious" : "findNext")
        guard await wait(seconds: 3, until: { model.pageState?.find?.index != previous }) else { return nil }
        return model.pageState?.find
    }

    func find(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let model = try await openFile("find.md", "# Find\n\nalpha needle beta\n\n| a | b |\n|---|---|\n| gamma | needle |\n\ndelta needle\n", keep: &keep)
            let first = await findState(model, query: "needle")
            let second = await advanceFind(model)
            let third = await advanceFind(model)
            let back = await advanceFind(model, backwards: true)
            let missing = await findState(model, query: "absent-word")
            let pass = first?.count == 3 && second?.count == 3 && third?.count == 3
                && first?.index != second?.index && second?.index != third?.index && first?.index != third?.index
                && back?.index == second?.index && missing?.count == 0
            return .init(name: "find-moves-selection", pass: pass,
                         detail: "find state: \(String(describing: first)), \(String(describing: second)), \(String(describing: third)); previous: \(String(describing: back)); missing: \(String(describing: missing))")
        } catch { return .init(name: "find-moves-selection", pass: false, detail: String(describing: error)) }
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
                progress?.stage = "\(duringDisplay ? "display" : "preparation") overlap: opening replacement"
                await model.open(revision: 1, origin: nil)
                progress?.stage = "\(duringDisplay ? "display" : "preparation") overlap: waiting for superseded open"
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
            let first = await findState(model, query: "joined words")
            let second = await advanceFind(model)
            let back = await advanceFind(model, backwards: true)
            let pass = first?.count == 2 && second?.count == 2 && first?.index != second?.index && back?.index == first?.index
            return .init(name: "find-across-inline-formatting", pass: pass,
                         detail: "formatted and plain matches: \(first?.count ?? -1); next index: \(second?.index ?? -1); previous index: \(back?.index ?? -1)")
        } catch { return .init(name: "find-across-inline-formatting", pass: false, detail: String(describing: error)) }
    }

    func codeLineEndings(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let source = "```text\r\nfirst\r\nsecond\r\n```\r\n"
            let model = try await openFile("crlf-copy.md", source, keep: &keep)
            CheckRunner.checkPasteboard.clearContents()
            _ = await js(model, "document.querySelector('[data-role=\"code-copy\"]').click(); return true;")
            _ = await wait(seconds: 3) { CheckRunner.checkPasteboard.string(forType: .string) != nil }
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
            for width in [320.0, 600.0, 900.0] {
                let model = ReaderModel(reference: .file(path: url.path), platform: CheckRunner.platform(), state: windows.state)
                keep.append(CheckRunner.offscreenWindow(page: model.page, width: width, height: 700))
                await model.open(origin: nil)
                try await CheckRunner.preparePageForCheck(model)
                for textSize in [PageSettings.defaultTextSize, PageSettings.defaultTextSize + 2] {
                    model.settings = PageSettings(textSize: textSize, wrapCode: false)
                    try await model.sendDocument(source: model.source, generation: model.sourceGeneration)
                    let result = await js(model, """
                    const [wide, fitting] = document.querySelectorAll('table');
                    const widths = (t) => [...t.rows[1].cells].map(c => Math.round(c.getBoundingClientRect().width));
                    const em = parseFloat(getComputedStyle(wide.rows[1].cells[1]).fontSize);
                    const w = widths(wide), f = widths(fitting);
                    const code = wide.rows[1].cells[2].querySelector('code');
                    const tables = [wide, fitting];
                    const fits = tables.every(t => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= innerWidth + 1);
                    const cellsFit = tables.every(t => [...t.querySelectorAll('th,td')].every(c => c.scrollWidth <= c.clientWidth + 1));
                    const wraps = code.getClientRects().length > 1;
                    const unchanged = code.textContent === 'long_identifier_'.repeat(5) && em > 0;
                    const pageFits = document.scrollingElement.scrollWidth <= innerWidth + 1;
                    return {pass: fits && cellsFit && wraps && unchanged && pageFits, detail: JSON.stringify({viewport: innerWidth, em, wide: {client: wide.clientWidth, scroll: wide.scrollWidth, cells: w}, fitting: {client: fitting.clientWidth, scroll: fitting.scrollWidth, cells: f}, codeLines: code.getClientRects().length, fits, cellsFit, unchanged, pageFits})};
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
            _ = await js(model, "document.querySelector('[data-role=\"code-copy\"]').click(); return true;")
            let copied = await wait(seconds: 3) { CheckRunner.checkPasteboard.string(forType: .string) != nil }
            let value = CheckRunner.checkPasteboard.string(forType: .string)
            let pass = copied && value.map { Data($0.utf8) == Data(literal.utf8) } == true
            return .init(name: "code-copy-exact", pass: pass, detail: "page copy command preserved fenced-code bytes: \(pass)")
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

    func initialRevisionGap(followsLatest: Bool, keep: inout [NSWindow]) async -> Verification.Check {
        let name = followsLatest ? "initial-gap-follows-latest" : "initial-gap-announces-update"
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: Self.longDocument())
            let model = ReaderModel(reference: store.reference(id), platform: windows.platform, state: windows.state)
            keep.append(readerWindow(model))
            model.followsLatest = followsLatest
            let gate = RevisionPreparationGate()
            model.preparationGate = { revision in if revision == 1 { await gate.wait() } }
            let opening = Task { await model.open(origin: nil) }
            let reached = await wait(seconds: 5) { gate.reached }
            try store.write(id, revision: 2, source: Self.longDocument(insert: "A new introduction.\n", change: 30))
            gate.release()
            await opening.value
            let reconciled = await wait(seconds: 5) {
                followsLatest ? model.snapshot?.revision == 2 : model.update == .revision(2)
            }
            let pass = reached && reconciled && (followsLatest || model.snapshot?.revision == 1)
            let detail = "first preparation gated: \(reached); single publication reconciled: \(reconciled); shown \(model.snapshot?.revision ?? 0); update \(String(describing: model.update))"
            await model.close()
            return .init(name: name, pass: pass, detail: detail)
        } catch {
            return .init(name: name, pass: false, detail: String(describing: error))
        }
    }

    func positionAtInstallation(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: Self.longDocument())
            let model = await open(store.reference(id), revision: nil, trackedScroll: true, keep: &keep)
            model.followsLatest = true
            _ = await js(model, "window.scrollTo(0, 1200); return true;")
            let stale = await model.capturePositionForCheck()
            let gate = RevisionPreparationGate()
            model.preparationGate = { revision in if revision == 2 { await gate.wait() } }
            try store.write(id, revision: 2, source: Self.longDocument(insert: "An introduction.\n", change: 30))
            let reached = await wait(seconds: 5) { gate.reached }
            _ = await js(model, "window.scrollTo(0, 5000); return true;")
            model.scrolled()
            let moved = await model.capturePositionForCheck()
            let settled = await wait(seconds: 2) { !model.isScrollingForCheck }
            gate.release()
            let followed = await wait(seconds: 5) { model.snapshot?.revision == 2 && !model.isLoadingForCheck }
            let restored = await model.capturePositionForCheck()
            let preserved = moved?.blockKey != nil && moved?.blockKey == restored?.blockKey
                && abs((moved?.fraction ?? 0) - (restored?.fraction ?? 1)) < 0.05
                && stale?.blockKey != restored?.blockKey
            let pass = reached && settled && followed && preserved && model.lastRestore == .block
            await model.close()
            return .init(name: "position-captured-at-installation", pass: pass, detail: "preparation gated: \(reached); scroll settled before installation: \(settled); followed: \(followed); new block and fraction retained: \(preserved)")
        } catch {
            return .init(name: "position-captured-at-installation", pass: false, detail: String(describing: error))
        }
    }

    func interactionDuringPreparation(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: Self.longDocument())
            let model = await open(store.reference(id), revision: nil, trackedScroll: true, keep: &keep)
            model.followsLatest = true
            _ = await js(model, "window.scrollTo(0, 1200); return true;")
            let stale = await model.capturePositionForCheck()
            let scrollGate = RevisionPreparationGate()
            model.preparationGate = { revision in if revision == 2 { await scrollGate.wait() } }
            try store.write(id, revision: 2, source: Self.longDocument(insert: "A new introduction.\n", change: 30))
            let prepared = await wait(seconds: 5) { scrollGate.reached }
            _ = await js(model, "window.scrollTo(0, 5000); return true;")
            model.scrolled()
            let moved = await model.capturePositionForCheck()
            scrollGate.release()
            let deferred = await wait(seconds: 0.2) { !model.isLoadingForCheck }
                && model.snapshot?.revision == 1
            let followed = await wait(seconds: 5) { model.snapshot?.revision == 2 }
            let restored = await model.capturePositionForCheck()
            let preserved = moved?.blockKey != nil && moved?.blockKey == restored?.blockKey
                && abs((moved?.fraction ?? 0) - (restored?.fraction ?? 1)) < 0.05
                && stale?.blockKey != restored?.blockKey
            let selectionGate = RevisionPreparationGate()
            model.preparationGate = { revision in if revision == 3 { await selectionGate.wait() } }
            try store.write(id, revision: 3, source: Self.longDocument(insert: "Another introduction.\n", change: 31))
            let selectionPrepared = await wait(seconds: 5) { selectionGate.reached }
            _ = await js(model, "const p = document.querySelector('p'); getSelection().selectAllChildren(p); return true;")
            let selected = await model.selectedText()
            selectionGate.release()
            let finished = await wait(seconds: 3) { !model.isLoadingForCheck }
            let retainedSelection = await model.selectedText()
            let selectionKept = !selected.isEmpty && selected == retainedSelection
                && model.snapshot?.revision == 2 && model.update == .revision(3)
            let pass = prepared && deferred && followed && preserved && selectionPrepared && finished && selectionKept
            let detail = "scroll preparation gated: \(prepared); deferred while scrolling: \(deferred); followed after settling: \(followed); new position restored: \(preserved); selection preparation gated: \(selectionPrepared); selection retained with update notice: \(selectionKept)"
            await model.close()
            return .init(name: "interaction-during-revision-preparation", pass: pass, detail: detail)
        } catch {
            return .init(name: "interaction-during-revision-preparation", pass: false, detail: String(describing: error))
        }
    }

    func positionAcrossRefresh(keep: inout [NSWindow]) async -> Verification.Check {
        do {
            let id = VerifyStore.newId()
            try store.write(id, revision: 1, source: Self.longDocument())
            let model = await open(store.reference(id), revision: nil, keep: &keep)
            _ = await js(model, """
            const block = [...document.querySelectorAll('[data-block]')].find(b => b.textContent.trim().startsWith('Paragraph 120 '));
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
            let firstState = ReadingStateStore(directory: stateDirectory)
            let first = await open(store.reference(id), revision: nil, state: firstState, keep: &keep)
            _ = await js(first, "window.scrollTo(0, 3100); return true;")
            first.scrolled()
            try? await Task.sleep(for: .milliseconds(800))
            let saved = await first.capturePositionForCheck()
            await first.close()
            let flushed = await firstState.flush(timeout: 2)
            switch flushed {
            case .notSaved(let reason), .unconfirmed(let reason):
                return .init(name: "position-survives-reopen", pass: false, detail: "the state flush did not confirm a save: \(reason)")
            case .saved, .nothingToSave: break
            }
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
                (await js(model, "return document.querySelectorAll('[data-block]').length") as? Int ?? 0) > 100
            }
            let scroll = await js(model, "return window.scrollY") as? Double ?? 0
            let pass = recovered && content && scroll > 1000
            return .init(name: "webcontent-recovery", pass: pass, detail: "killed \(processes.count) content process(es); reloaded: \(recovered); content back: \(content); scroll position after reload: \(Int(scroll)) (was 2400); saved \(String(describing: model.savedPositionForCheck)); restore \(model.lastRestore.rawValue)")
        } catch {
            return .init(name: "webcontent-recovery", pass: false, detail: String(describing: error))
        }
    }
}
