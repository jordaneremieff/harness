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
        "published-writing-undo-matches-source", "escape-layers-notices-and-focus", "agent-hold-change-panel-find-and-code", "ask-card-keeps-newest-exchange-in-view", "ask-from-open-block-and-let-it", "narrow-writing-bar-keeps-save-icon", "agent-change-keeps-reading-position", "context-menu-ask-floats-beside-selection", "page-context-menu-replaces-system-menu", "real-keys-and-clicks-reach-find-and-menu", "find-close-clears-highlights",
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
                await run("published-writing-undo-matches-source") { await context.publishedWritingUndo(keep: &keep) }
                await run("escape-layers-notices-and-focus") { await context.escapeLayers(keep: &keep) }
                await run("agent-hold-change-panel-find-and-code") { await context.agentPanels(keep: &keep) }
                await run("ask-card-keeps-newest-exchange-in-view") { await context.askCardLatest(keep: &keep) }
                await run("ask-from-open-block-and-let-it") { await context.askFromOpenBlock(keep: &keep) }
                await run("narrow-writing-bar-keeps-save-icon") { await context.narrowWritingBar(keep: &keep) }
                await run("agent-change-keeps-reading-position") { await context.agentChangeKeepsPlace(keep: &keep) }
                await run("context-menu-ask-floats-beside-selection") { await context.contextMenuAsk(keep: &keep) }
                await run("page-context-menu-replaces-system-menu") { await context.pageContextMenu(keep: &keep) }
                await run("real-keys-and-clicks-reach-find-and-menu") { await context.realInput(keep: &keep) }
                await run("find-close-clears-highlights") { await context.findCloseClears(keep: &keep) }
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

    static func sameSourcePosition(_ first: ReadingPosition?, _ second: ReadingPosition?) -> Bool {
        guard let first, let second, let start = first.blockStart, let otherStart = second.blockStart,
              let offset = first.offsetY, let otherOffset = second.offsetY else { return false }
        return start == otherStart && abs(offset - otherOffset) < 1
    }

    func scroll(_ model: ReaderModel, to y: Double) async -> ReadingPosition? {
        let previous = model.pageState?.scroll
        guard await js(model, "document.querySelector('[data-role=\"scroller\"]').scrollTo(0, y); return true;", ["y": y]) as? Bool == true,
              await wait(seconds: 3, until: { model.pageState?.scroll != previous }) else { return nil }
        return await model.capturePositionForCheck()
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
            await Promise.race([new Promise(r => requestAnimationFrame(r)), new Promise(r => setTimeout(r, 60))]);
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

    /// Writing on a published document in a pane surface: rapid edits, then the bar's Undo.
    /// The rendered block must show the source the mirror and store hold, with no failure notice.
    func publishedWritingUndo(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "published-writing-undo-matches-source"
        do {
            let id = VerifyStore.newId()
            let original = "# Published review of the Markdown extension with a long working title\n\nThe status waits for evidence from real use.\n\nA closing paragraph.\n"
            try store.write(id, revision: 1, source: original)
            let state = ReadingStateStore(directory: nil)
            let model = ReaderModel(reference: store.reference(id), platform: CheckRunner.platform(), state: state)
            let surface = ReaderSurface(model: model, state: state, chrome: "pane",
                                        draftDirectory: workspace.appendingPathComponent("published-undo-drafts"))
            defer { withExtendedLifetime(surface) {} }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            let lockPlace = "const r = document.getElementById('b-edit').getBoundingClientRect(); return [r.left, r.top, r.width];"
            let readingPlace = await js(model, lockPlace) as? [Double] ?? []
            await model.sendCommand("toggleLock", args: ["lock": "writing"])
            let typed = await js(model, """
            const block = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.includes('evidence'));
            if (!block) return false;
            const rect = block.getBoundingClientRect();
            const point = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 4, clientY: rect.top + rect.height / 2 };
            block.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerType: 'mouse', isPrimary: true }));
            block.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
            block.dispatchEvent(new MouseEvent('click', point));
            await new Promise(resolve => setTimeout(resolve, 0));
            const editor = document.querySelector('[data-role="block-editor"]');
            if (!editor) return false;
            editor.focus();
            const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            for (const text of ['Z', 'Z', 'Q']) {
              document.execCommand('insertText', false, text);
              await new Promise(resolve => setTimeout(resolve, 5));
            }
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return true;
            """) as? Bool == true
            let edited = original.replacingOccurrences(of: "from real use.", with: "from real use.ZZQ")
            let mirrored = await wait(seconds: 5) { Data(model.source.utf8) == Data(edited.utf8) }
            let writingPlace = await js(model, lockPlace) as? [Double] ?? []
            let lockFixed = readingPlace.count == 3 && readingPlace == writingPlace
            let undoReady = await wait(seconds: 3) {
                await js(model, "const b = document.getElementById('b-undo'); return !!b && !b.disabled;") as? Bool == true
            }
            let undoState = await js(model, "const b = document.getElementById('b-undo'); return b ? `disabled ${b.disabled}, label ${b.getAttribute('aria-label')}, editor ${!!document.querySelector('[data-role=\"block-editor\"]')}` : 'missing';") as? String ?? "unavailable"
            var undone = false
            if undoReady { undone = await js(model, "document.getElementById('b-undo').click(); return true;") as? Bool == true }
            let restored = await wait(seconds: 5) { Data(model.source.utf8) == Data(original.utf8) }
            let shown = await wait(seconds: 5) {
                await js(model, "const b = [...document.querySelectorAll('[data-role=\"document\"] [data-block]')].find(b => b.textContent.includes('evidence')); return b ? b.textContent.trim() : '';") as? String
                    == "The status waits for evidence from real use."
            }
            let notices = await js(model, "return [...document.querySelectorAll('[data-role=\"notice\"], .notice')].map(n => n.textContent.trim()).filter(Boolean).join(' | ');") as? String ?? "unavailable"
            let failureNotice = notices.contains("did not complete") || notices.contains("ReaderBridgeError")
            let pass = typed && mirrored && lockFixed && undone && restored && shown && !failureNotice
            await surface.waitForPendingChanges()
            await model.close()
            return .init(name: name, pass: pass, detail: "typed \(typed); mirror after edits \(mirrored); edit control fixed \(lockFixed) (\(readingPlace) -> \(writingPlace)); bar Undo \(undone) (\(undoState)); mirror restored \(restored); rendered block matches restored source \(shown); notices '\(notices)'")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// Escape closes the topmost layer first (a menu, then the open block) and only then gives
    /// the keyboard back; repeated notices collapse into one with a count, and at most three show.
    func escapeLayers(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "escape-layers-notices-and-focus"
        do {
            let file = workspace.appendingPathComponent("escape.md")
            try Data("# Escape\n\nA paragraph to open.\n".utf8).write(to: file)
            let state = ReadingStateStore(directory: nil)
            let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: state)
            let surface = ReaderSurface(model: model, state: state, chrome: "pane",
                                        draftDirectory: workspace.appendingPathComponent("escape-drafts"))
            var returned = 0
            surface.onReturnFocus = { returned += 1 }
            defer { withExtendedLifetime(surface) {} }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            await model.sendCommand("toggleLock", args: ["lock": "writing"])
            let layered = await js(model, """
            const block = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.includes('A paragraph'));
            if (!block) return false;
            const rect = block.getBoundingClientRect();
            const point = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 4, clientY: rect.top + rect.height / 2 };
            block.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerType: 'mouse', isPrimary: true }));
            block.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
            block.dispatchEvent(new MouseEvent('click', point));
            await new Promise(resolve => setTimeout(resolve, 0));
            document.getElementById('activity').showPopover();
            return !!document.querySelector('[data-role="block-editor"]') && document.getElementById('activity').matches(':popover-open');
            """) as? Bool == true
            let escape = "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 0)); return { menu: document.getElementById('activity').matches(':popover-open'), block: !!document.querySelector('[data-role=\"block-editor\"]') };"
            let first = await js(model, escape) as? [String: Any]
            let second = await js(model, escape) as? [String: Any]
            _ = await js(model, escape)
            let returnedOnce = await wait(seconds: 3) { returned == 1 }
            let order = first?["menu"] as? Bool == false && first?["block"] as? Bool == true && second?["block"] as? Bool == false
            for _ in 0..<3 { _ = try await model.sendEnvelope(["v": 1, "type": "notice", "tone": "warn", "text": "Repeated notice", "actions": []]) }
            let repeated = await js(model, "return [...document.querySelectorAll('[data-role=\"notice\"]')].map(n => n.textContent.trim());") as? [String] ?? []
            for index in 1...4 { _ = try await model.sendEnvelope(["v": 1, "type": "notice", "tone": "info", "text": "Notice \(index)", "actions": []]) }
            _ = try await model.sendEnvelope(["v": 1, "type": "notice", "tone": "warn", "text": "Repeated notice", "actions": []])
            let notices = await js(model, "return [...document.querySelectorAll('[data-role=\"notice\"]')].map(n => n.textContent.trim());") as? [String] ?? []
            let collapsed = repeated.count == 1 && repeated.first?.contains("×3") == true
                && notices.count == 3 && notices.filter { $0.contains("Repeated notice") }.count == 1
                && notices.last?.contains("Repeated notice") == true
            await model.close()
            return .init(name: name, pass: layered && order && returnedOnce && collapsed,
                         detail: "menu and block open \(layered); first Escape closed the menu only, second the block \(order); keyboard returned once after the third \(returnedOnce) (\(returned)); repeats \(repeated); notices \(notices)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// A draft in a pane surface with the native live route: an agent edit refused by the
    /// person's hold shows the hold notice; an applied agent edit's change panel survives a press
    /// and release on its Undo, which restores the source; typing a find query reveals a match below
    /// the view; a code block has one copy control.
    func agentPanels(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "agent-hold-change-panel-find-and-code"
        do {
            let filler = (1...60).map { "Filler paragraph \($0) keeps the target below the view." }.joined(separator: "\n\n")
            let source = "# Panels\n\nHuman passage stays.\n\nAgent passage changes.\n\n```swift\nlet value = 1\n```\n\n" + filler + "\n\nDistant needle here.\n"
            let state = ReadingStateStore(directory: nil)
            let file = workspace.appendingPathComponent("panels.md")
            try Data(source.utf8).write(to: file)
            let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: state)
            let editor = EditorWorkspace(directory: workspace.appendingPathComponent("panels-drafts"), store: nil)
            editor.add(DraftRecord(source: source))
            let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
            defer { withExtendedLifetime(surface) {} }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            _ = await wait(seconds: 5) { editor.webReady && model.source == source }
            guard let document = editor.active else { return .init(name: name, pass: false, detail: "the draft did not open") }
            let code = await js(model, "const f = document.querySelector('figure.code'); return f ? [f.querySelectorAll('[data-role=\"code-copy\"]').length, f.querySelectorAll('a.copy').length, f.querySelector('figcaption').textContent.trim()] : [];") as? [Any] ?? []
            let closedLayersInert = await js(model, "return [...document.querySelectorAll('[popover]:not(:popover-open)')].every(p => getComputedStyle(p).display === 'none');") as? Bool == true
            let oneCopy = code.count == 3 && code[0] as? Int == 1 && code[1] as? Int == 0 && code[2] as? String == "swift"
            func apply(_ old: String, _ new: String) async -> LiveResult {
                let text = document.text.source as NSString, range = text.range(of: old)
                return await editor.handleLive(LiveCommand(requestId: UUID().uuidString, workspace: editor.id.uuidString,
                    document: editor.liveDocumentID.uuidString, op: "apply", operationId: UUID().uuidString,
                    baseGeneration: document.text.generation, baseDigest: Digest.sha256(Data(document.text.source.utf8)),
                    edits: [LiveTextEdit(start: range.location, end: NSMaxRange(range), expected: old, replacement: new)]))
            }
            editor.pageHeld = (document.text.source as NSString).range(of: "Human passage stays.")
            let held = await apply("Human passage stays.", "Agent rewrote it.")
            let holdNotice = await wait(seconds: 3) {
                (await js(model, "return [...document.querySelectorAll('[data-role=\"notice\"]')].some(n => n.textContent.includes('The agent wants to change this passage') && n.textContent.includes('Let it'));") as? Bool) == true
            }
            editor.pageHeld = nil
            let cardOpen = await js(model, """
            document.getElementById('b-ask').click();
            await new Promise(r => setTimeout(r, 30));
            const item = [...document.querySelectorAll('#activity button')].find(b => b.textContent.includes('Ask about this document'));
            if (!item) return false;
            item.click();
            await new Promise(r => setTimeout(r, 30));
            return document.querySelector('[data-role="ask-card"]').hasAttribute('data-open');
            """) as? Bool == true
            let applied = await apply("Agent passage changes.", "Agent passage changed by the agent.")
            let afterAgent = document.text.source
            let panel = await js(model, """
            const notice = [...document.querySelectorAll('[data-role="notice"]')].find(n => n.textContent.includes('The agent changed'));
            const show = notice && [...notice.querySelectorAll('button')].find(b => b.textContent.trim() === 'Show changes');
            if (!show) return 'no show';
            show.click();
            await new Promise(r => setTimeout(r, 50));
            const diff = document.querySelector('.inline-diff');
            const undo = diff && [...diff.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo');
            if (!undo) return 'no undo';
            await new Promise(r => setTimeout(r, 100));
            const r = undo.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            // A quick physical click: whatever the pointer lands on receives the whole sequence.
            const target = document.elementFromPoint(x, y);
            if (!target || !undo.contains(target)) return 'covered by ' + (target?.closest('[class]')?.className || target?.nodeName || 'nothing') + ' in ' + (target?.closest('[id]')?.id || '-') + ' at ' + Math.round(x) + ',' + Math.round(y);
            const point = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
            target.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerType: 'mouse', isPrimary: true }));
            target.dispatchEvent(new MouseEvent('mousedown', { ...point, buttons: 1 }));
            target.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
            target.dispatchEvent(new MouseEvent('mouseup', point));
            target.dispatchEvent(new MouseEvent('click', point));
            return 'clicked';
            """) as? String ?? "unavailable"
            let undone = await wait(seconds: 5) { document.text.source == source }
            _ = await js(model, "document.getElementById('page').scrollTop = 0; return true;")
            await model.sendCommand("find")
            let find = await js(model, """
            await new Promise(r => setTimeout(r, 50));
            const field = document.querySelector('[data-role="find-field"] input, input[data-role="find-field"]');
            if (!field) return 'no field';
            field.value = 'Distant needle';
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Distant needle' }));
            await new Promise(r => setTimeout(r, 100));
            const view = document.getElementById('page').getBoundingClientRect();
            const hit = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.includes('Distant needle'));
            const rect = hit.getBoundingClientRect();
            return rect.top >= view.top && rect.bottom <= view.bottom ? 'revealed' : 'hidden at ' + Math.round(rect.top);
            """) as? String ?? "unavailable"
            let pass = oneCopy && closedLayersInert && cardOpen && held.reason == "held" && holdNotice && applied.status == "applied" && afterAgent != source && panel == "clicked" && undone && find == "revealed"
            await editor.closeViews()
            await model.close()
            return .init(name: name, pass: pass, detail: "code \(code); closed menus inert \(closedLayersInert); hold \(held.status)/\(held.reason ?? "") notice \(holdNotice); ask card open \(cardOpen); agent edit \(applied.status); change panel \(panel); panel Undo restored \(undone); find \(find)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// Sends a question and a follow-up through the page's prompt route and answers both through
    /// the native prompt-state messages; the newest answer must be fully visible above the
    /// card's actions and composer.
    func askCardLatest(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "ask-card-keeps-newest-exchange-in-view"
        do {
            let file = workspace.appendingPathComponent("ask.md")
            try Data("# Ask\n\nA paragraph about the work.\n".utf8).write(to: file)
            let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: ReadingStateStore(directory: nil))
            var prompts: [(request: String, thread: String)] = []
            model.page.onMessage = { message in
                if message["type"] as? String == "prompt", let request = message["requestId"] as? String, let thread = message["threadId"] as? String {
                    prompts.append((request, thread))
                    return ["accepted": true]
                }
                return [:]
            }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            func send(_ text: String) async -> Bool {
                await js(model, """
                const field = document.querySelector('[data-role="ask-card"] textarea');
                if (!field) return false;
                field.value = text;
                field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                const send = document.querySelector('[data-role="ask-card"] .send');
                if (!send || send.disabled) return false;
                send.click();
                return true;
                """, ["text": text]) as? Bool == true
            }
            func answer(_ index: Int, _ text: String) async throws {
                let prompt = prompts[index]
                for state in ["sent", "working"] {
                    _ = try await model.sendEnvelope(["v": 1, "type": "promptState", "requestId": prompt.request, "threadId": prompt.thread, "state": state])
                }
                _ = try await model.sendEnvelope(["v": 1, "type": "promptState", "requestId": prompt.request, "threadId": prompt.thread, "state": "answered", "detail": text])
            }
            let opened = await js(model, """
            document.getElementById('b-ask').click();
            await new Promise(r => setTimeout(r, 30));
            const item = [...document.querySelectorAll('#activity button')].find(b => b.textContent.includes('Ask about this document'));
            if (!item) return false;
            item.click();
            await new Promise(r => setTimeout(r, 30));
            return document.querySelector('[data-role="ask-card"]').hasAttribute('data-open');
            """) as? Bool == true
            let long = (1...8).map { "Sentence \($0) of a long first answer that fills several lines in the card." }.joined(separator: " ")
            let first = await send("Summarise the document.")
            _ = await wait(seconds: 3) { prompts.count == 1 }
            if prompts.count == 1 { try await answer(0, long) }
            let second = await send("Shorter, please.")
            _ = await wait(seconds: 3) { prompts.count == 2 }
            if prompts.count == 2 { try await answer(1, "Follow-up answer: two lines at most.") }
            let geometry = await js(model, """
            await new Promise(r => setTimeout(r, 50));
            const card = document.querySelector('[data-role="ask-card"]');
            const replies = [...card.querySelectorAll('.reply')];
            const latest = replies.at(-1);
            if (!latest || !latest.textContent.includes('Follow-up answer')) return 'latest answer missing: ' + replies.map(r => r.textContent.slice(0, 20)).join(' | ');
            const r = latest.getBoundingClientRect();
            const limit = Math.min(...[...card.querySelectorAll('.composer, .ask-actions')].map(e => e.getBoundingClientRect().top));
            const scroller = latest.closest('.ask-messages') ?? card;
            const view = scroller.getBoundingClientRect();
            const top = Math.max(view.top, card.getBoundingClientRect().top);
            return r.top >= top - 0.5 && r.bottom <= Math.min(limit, view.bottom) + 0.5 ? 'visible' : `answer ${Math.round(r.top)}-${Math.round(r.bottom)}, visible area ${Math.round(top)}-${Math.round(Math.min(limit, view.bottom))}`;
            """) as? String ?? "unavailable"
            await model.close()
            return .init(name: name, pass: opened && first && second && prompts.count == 2 && geometry == "visible",
                         detail: "card open \(opened); question sent \(first); follow-up sent \(second); prompts \(prompts.count); newest answer \(geometry)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// The person's own request from the ask card never waits on his open block, and Let it after
    /// a held refusal of a request that has ended asks the agent again in the same thread.
    func askFromOpenBlock(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "ask-from-open-block-and-let-it"
        do {
            let source = "# Ask\n\nAgent passage before.\n\nOther passage.\n"
            let state = ReadingStateStore(directory: nil)
            let file = workspace.appendingPathComponent("ask-open.md")
            try Data(source.utf8).write(to: file)
            let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: state)
            let editor = EditorWorkspace(directory: workspace.appendingPathComponent("ask-open-drafts"), store: nil)
            editor.add(DraftRecord(source: source))
            let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
            defer { withExtendedLifetime(surface) {} }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            _ = await wait(seconds: 5) { editor.webReady && model.source == source }
            guard let document = editor.active else { return .init(name: name, pass: false, detail: "the draft did not open") }
            let forward = model.page.onMessage
            var prompts: [(request: String, thread: String, text: String)] = []
            model.page.onMessage = { message in
                if message["type"] as? String == "prompt", let request = message["requestId"] as? String,
                   let thread = message["threadId"] as? String, let text = message["text"] as? String {
                    prompts.append((request, thread, text)); return ["accepted": true]
                }
                // The page bridge hands each message to one handler; forwarding passes it on unchanged.
                nonisolated(unsafe) let body = message
                return try await forward?(body) ?? [:]
            }
            await model.sendCommand("toggleLock", args: ["lock": "writing"])
            func openAndType(_ passage: String) async -> Bool {
                await js(model, """
                const block = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.includes(passage));
                if (!block) return false;
                const rect = block.getBoundingClientRect();
                // Left edge of the passage: the open ask card can lie over its right part.
                const point = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 4, clientY: rect.top + rect.height / 2 };
                block.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerType: 'mouse', isPrimary: true }));
                block.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
                block.dispatchEvent(new MouseEvent('click', point));
                await new Promise(r => setTimeout(r, 0));
                const editor = document.querySelector('[data-role="block-editor"]');
                if (!editor) { lastOpenFailure = `no editor: lock ${document.getElementById('app').dataset.mode}, target ${document.elementFromPoint(point.clientX, point.clientY)?.className}`; return false; }
                editor.focus();
                const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
                getSelection().removeAllRanges(); getSelection().addRange(range);
                document.execCommand('insertText', false, ' Note');
                return true;
                """, ["passage": passage]) as? Bool == true
            }
            func apply(_ old: String, _ new: String) async -> LiveResult {
                let text = document.text.source as NSString, range = text.range(of: old)
                guard range.location != NSNotFound else { return LiveResult(status: "error", message: "missing text") }
                return await editor.handleLive(LiveCommand(requestId: UUID().uuidString, workspace: editor.id.uuidString,
                    document: editor.liveDocumentID.uuidString, op: "apply", operationId: UUID().uuidString,
                    baseGeneration: document.text.generation, baseDigest: Digest.sha256(Data(document.text.source.utf8)),
                    edits: [LiveTextEdit(start: range.location, end: NSMaxRange(range), expected: old, replacement: new)]))
            }
            let askScript = """
            document.getElementById('b-ask').click();
            await new Promise(r => setTimeout(r, 30));
            const item = [...document.querySelectorAll('#activity button')].find(b => b.textContent.includes('Ask about this document'));
            if (!item) return false;
            item.click();
            await new Promise(r => setTimeout(r, 30));
            const field = document.querySelector('[data-role="ask-card"] textarea');
            field.value = text;
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            const send = document.querySelector('[data-role="ask-card"] .send');
            if (send.disabled) return false;
            send.click();
            return true;
            """
            // (a) A request sent from the card while a block is open.
            let typedA = await openAndType("Agent passage before.")
            _ = await wait(seconds: 3) { editor.pageHeld != nil }
            let heldBefore = editor.pageHeld != nil
            let sentA = await js(model, askScript, ["text": "Replace the agent passage."]) as? Bool == true
            let releasedA = await wait(seconds: 3) { prompts.count == 1 && editor.pageHeld == nil }
            let appliedA = await apply("Agent passage before. Note", "Agent passage after.")
            let landedA = await wait(seconds: 3) { (await js(model, "return [...document.querySelectorAll('[data-role=\"notice\"]')].some(n => n.textContent.includes('The agent changed') && n.textContent.includes('Show changes') && n.textContent.includes('Undo'));") as? Bool) == true }
            // (b) A held refusal while the request works, then the request ends, then Let it.
            if let first = prompts.first {
                _ = try await model.sendEnvelope(["v": 1, "type": "promptState", "requestId": first.request, "threadId": first.thread, "state": "working"])
            }
            let typedB = await openAndType("Other passage.")
            _ = await wait(seconds: 3) { editor.pageHeld != nil && document.text.source.contains("Other passage. Note") }
            let heldB = await apply("Other passage. Note", "Other passage changed.")
            let noticeB = await wait(seconds: 3) { (await js(model, "return [...document.querySelectorAll('[data-role=\"notice\"]')].some(n => n.textContent.includes('The agent wants to change this passage'));") as? Bool) == true }
            if let first = prompts.first {
                _ = try await model.sendEnvelope(["v": 1, "type": "promptState", "requestId": first.request, "threadId": first.thread, "state": "answered", "detail": "No change applied: the passage is open."])
            }
            let pressed = await js(model, """
            const notice = [...document.querySelectorAll('[data-role="notice"]')].find(n => n.textContent.includes('The agent wants to change this passage'));
            const button = notice && [...notice.querySelectorAll('button')].find(b => b.textContent.trim() === 'Let it');
            if (!button) return false;
            button.click();
            return true;
            """) as? Bool == true
            let retried = await wait(seconds: 3) { prompts.count == 2 && editor.pageHeld == nil }
            let sameThread = prompts.count == 2 && prompts[1].thread == prompts[0].thread && prompts[1].request != prompts[0].request
            let appliedB = await apply("Other passage. Note", "Other passage changed.")
            let pass = typedA && heldBefore && sentA && releasedA && appliedA.status == "applied" && landedA
                && typedB && heldB.reason == "held" && noticeB && pressed && retried && sameThread && appliedB.status == "applied"
            await editor.closeViews()
            await model.close()
            let openFailure = await js(model, "return globalThis.lastOpenFailure ?? ''") as? String ?? ""
            return .init(name: name, pass: pass, detail: "typed \(typedA)/\(typedB) \(openFailure); (a) block held \(heldBefore), sent \(sentA), hold released \(releasedA), agent edit \(appliedA.status), notice with Show changes and Undo \(landedA); (b) held \(heldB.status)/\(heldB.reason ?? ""), notice \(noticeB), Let it \(pressed), retry in the same thread \(retried && sameThread) (\(prompts.last?.text ?? "")), agent edit \(appliedB.status)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// At a narrow pane width in Writing, the save state keeps its whole icon in the bar.
    func narrowWritingBar(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "narrow-writing-bar-keeps-save-icon"
        do {
            let file = workspace.appendingPathComponent("narrow.md")
            try Data("# A long title for a narrow pane that must truncate\n\nText.\n".utf8).write(to: file)
            let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: ReadingStateStore(directory: nil))
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 452, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            await model.sendCommand("toggleLock", args: ["lock": "writing"])
            let size = await js(model, """
            await new Promise(r => setTimeout(r, 50));
            const status = document.querySelector('[data-role="status"]');
            const icon = status && status.querySelector('svg');
            if (!icon) return [];
            const s = status.getBoundingClientRect(), i = icon.getBoundingClientRect();
            // The status must not shrink below its icon when the bar runs short of room.
            return [s.width, i.width, i.left >= s.left - 0.5 && i.right <= s.right + 0.5 ? 1 : 0, innerWidth, getComputedStyle(status).flexShrink === '0' ? 1 : 0];
            """) as? [Double] ?? []
            await model.close()
            let whole = size.count == 5 && size[1] >= 12 && size[2] == 1 && size[0] >= size[1] && size[4] == 1
            return .init(name: name, pass: whole, detail: "status width, icon width, icon inside, page width, cannot shrink: \(size)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// An agent change inside the visible area keeps the first visible line and everything above
    /// the change in place: at a narrow width with the bottom-sheet card open, at a wide width with
    /// the side card, near the end of the document, and after a card Send that closed an open block.
    func agentChangeKeepsPlace(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "agent-change-keeps-reading-position"
        var results: [String] = []
        var pass = true
        let long = "Target passage: " + String(repeating: "this sentence makes the paragraph wrap over several lines in a narrow pane. ", count: 2)
        for (index, scenario) in [(452.0, "card", false), (800.0, "card", false), (452.0, "card", true), (452.0, "send", false)].enumerated() {
            do {
                let before = (1...24).map { "Paragraph \($0) above the target." }.joined(separator: "\n\n")
                let after = (1...(scenario.2 ? 6 : 24)).map { "Paragraph \($0) below the target." }.joined(separator: "\n\n")
                let source = "# Place\n\n\(before)\n\n## Section above\n\n\(long)\n\n\(after)\n"
                let state = ReadingStateStore(directory: nil)
                let file = workspace.appendingPathComponent("place-\(index).md")
                try Data(source.utf8).write(to: file)
                let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: state)
                let editor = EditorWorkspace(directory: workspace.appendingPathComponent("place-\(index)-drafts"), store: nil)
                editor.add(DraftRecord(source: source))
                let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
                defer { withExtendedLifetime(surface) {} }
                keep.append(CheckRunner.offscreenWindow(page: model.page, width: scenario.0, height: 760))
                await model.open(origin: nil)
                try await CheckRunner.preparePageForCheck(model)
                _ = await wait(seconds: 5) { editor.webReady && model.source == source }
                guard let document = editor.active else { results.append("\(index): no draft"); pass = false; continue }
                let forward = model.page.onMessage
                model.page.onMessage = { message in
                    if message["type"] as? String == "prompt" { return ["accepted": true] }
                    nonisolated(unsafe) let body = message
                    return try await forward?(body) ?? [:]
                }
                await model.sendCommand("toggleLock", args: ["lock": "writing"])
                let placed = await js(model, """
                const page = document.querySelector('[data-role="scroller"]');
                const target = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.trim().startsWith('Target passage'));
                if (!target) return false;
                await new Promise(r => setTimeout(r, 300));
                const wanted = nearEnd ? page.scrollHeight - page.clientHeight - 260
                  : target.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - 260;
                page.scrollTop = wanted;
                await new Promise(r => setTimeout(r, 100));
                if (mode === 'send') {
                  const rect = target.getBoundingClientRect();
                  const point = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 4, clientY: rect.top + 8 };
                  target.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerType: 'mouse', isPrimary: true }));
                  target.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
                  target.dispatchEvent(new MouseEvent('click', point));
                  await new Promise(r => setTimeout(r, 0));
                }
                if (mode === 'card') {
                  // Ask on the passage itself: the card keeps that passage as its thread range.
                  const text = target.querySelector('p') ?? target;
                  const range = document.createRange(); range.selectNodeContents(text);
                  getSelection().removeAllRanges(); getSelection().addRange(range);
                  document.dispatchEvent(new Event('selectionchange'));
                  text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  await new Promise(r => setTimeout(r, 60));
                  const ask = [...document.querySelectorAll('[data-role="selection-strip"] button')].find(b => b.textContent.trim() === 'Ask');
                  if (!ask) return false;
                  ask.click();
                } else {
                  document.getElementById('b-ask').click();
                  await new Promise(r => setTimeout(r, 30));
                  [...document.querySelectorAll('#activity button')].find(b => b.textContent.includes('Ask about this document')).click();
                }
                await new Promise(r => setTimeout(r, 60));
                if (mode === 'send') {
                  const field = document.querySelector('[data-role="ask-card"] textarea');
                  field.value = 'Shorten the target passage.';
                  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
                  document.querySelector('[data-role="ask-card"] .send').click();
                  await new Promise(r => setTimeout(r, 100));
                }
                return true;
                """, ["nearEnd": scenario.2, "mode": scenario.1]) as? Bool == true
                // The person scrolls on: the passage's top now sits just under the bar, above the
                // place where the card first revealed it.
                var personPlaced: Double? = nil
                if !scenario.2 {
                    personPlaced = await js(model, """
                    const page = document.querySelector('[data-role="scroller"]');
                    const target = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.trim().startsWith('Target passage'));
                    page.scrollTop += target.getBoundingClientRect().top - page.getBoundingClientRect().top - 20;
                    return target.getBoundingClientRect().top;
                    """) as? Double
                    try? await Task.sleep(for: .milliseconds(150))
                }
                _ = await wait(seconds: 3) { editor.pageHeld == nil }
                let measure = """
                const page = document.querySelector('[data-role="scroller"]');
                const top = page.getBoundingClientRect().top;
                const blocks = [...document.querySelectorAll('[data-role="document"] [data-block]')];
                const first = blocks.find(b => b.getBoundingClientRect().bottom > top);
                const heading = blocks.find(b => b.textContent.trim() === 'Section above');
                const target = blocks.find(b => b.textContent.trim().startsWith('Target passage'));
                return [first ? first.dataset.block : '', first ? first.getBoundingClientRect().top : 0, heading ? heading.getBoundingClientRect().top : 0, target ? target.getBoundingClientRect().top : -1, page.clientHeight];
                """
                let start = await js(model, measure) as? [Any] ?? []
                let text = document.text.source as NSString, range = text.range(of: long)
                let applied = await editor.handleLive(LiveCommand(requestId: UUID().uuidString, workspace: editor.id.uuidString,
                    document: editor.liveDocumentID.uuidString, op: "apply", operationId: UUID().uuidString,
                    baseGeneration: document.text.generation, baseDigest: Digest.sha256(Data(document.text.source.utf8)),
                    edits: [LiveTextEdit(start: range.location, end: NSMaxRange(range), expected: long, replacement: "Target passage: short.")]))
                _ = await wait(seconds: 3) { (await js(model, "return [...document.querySelectorAll('[data-role=\"document\"] [data-block]')].some(b => b.textContent.trim() === 'Target passage: short.');") as? Bool) == true }
                try? await Task.sleep(for: .milliseconds(150))
                let end = await js(model, measure) as? [Any] ?? []
                await editor.closeViews()
                await model.close()
                let visible = (start[safe: 3] as? Double).map { $0 >= 0 && $0 < (start[safe: 4] as? Double ?? 0) } ?? false
                let firstKept = start.count == 5 && end.count == 5 && start[0] as? String == end[0] as? String
                    && abs((start[1] as? Double ?? 0) - (end[1] as? Double ?? 1000)) <= 1
                let aboveKept = abs((start[2] as? Double ?? 0) - (end[2] as? Double ?? 1000)) <= 1
                // Card redraws and the agent's change leave the page where the person scrolled it.
                let personKept = personPlaced.map { abs($0 - (end[safe: 3] as? Double ?? 1000)) <= 1 } ?? true
                let ok = placed && visible && applied.status == "applied" && firstKept && aboveKept && personKept
                pass = pass && ok
                results.append("\(Int(scenario.0)) \(scenario.1)\(scenario.2 ? " near end" : ""): placed \(placed), \(applied.status), target visible \(visible), first line \(start[safe: 1] ?? "?")→\(end[safe: 1] ?? "?"), heading above \(start[safe: 2] ?? "?")→\(end[safe: 2] ?? "?"), passage where the person scrolled it \(personPlaced.map { String($0) } ?? "-")→\(end[safe: 3] ?? "?")")
            } catch { pass = false; results.append("\(index): \(error)") }
        }
        return .init(name: name, pass: pass, detail: results.joined(separator: "; "))
    }

    /// The page's context menu for selected text starts with "Ask about this"; the item opens the
    /// ask card for that selection, floating beside it inside the pane, off the
    /// selected text, with the composer focused and the page unscrolled. Covers 452 and 800 pt, in
    /// Reading and Writing, and a selection near the bottom of the view, where the card flips above.
    func contextMenuAsk(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "context-menu-ask-floats-beside-selection"
        var results: [String] = []
        var pass = true
        for (index, scenario) in [(452.0, "reading", false), (800.0, "reading", false), (452.0, "writing", false), (452.0, "reading", true), (800.0, "writing", true)].enumerated() {
            do {
                let paragraphs = (1...40).map { "Paragraph \($0) with enough words to wrap in a narrow pane and give the selection real lines." }.joined(separator: "\n\n")
                let file = workspace.appendingPathComponent("menu-\(index).md")
                try Data("# Menu\n\n\(paragraphs)\n".utf8).write(to: file)
                let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: ReadingStateStore(directory: nil))
                keep.append(CheckRunner.offscreenWindow(page: model.page, width: scenario.0, height: 760))
                await model.open(origin: nil)
                try await CheckRunner.preparePageForCheck(model)
                if scenario.1 == "writing" { await model.sendCommand("toggleLock", args: ["lock": "writing"]) }
                let selected = await js(model, """
                const page = document.querySelector('[data-role="scroller"]');
                page.scrollTop = 900;
                await new Promise(r => setTimeout(r, 50));
                const view = page.getBoundingClientRect();
                const blocks = [...document.querySelectorAll('[data-role="document"] [data-block]')];
                const target = nearBottom
                  ? blocks.filter(b => b.getBoundingClientRect().bottom < view.bottom - 10).at(-1)
                  : blocks.find(b => b.getBoundingClientRect().top > view.top + 160);
                const text = target.querySelector('p') ?? target;
                const range = document.createRange(); range.selectNodeContents(text);
                getSelection().removeAllRanges(); getSelection().addRange(range);
                document.dispatchEvent(new Event('selectionchange'));
                await new Promise(r => setTimeout(r, 150));
                const r = range.getBoundingClientRect();
                return [r.top, r.bottom, r.left, r.right, page.scrollTop, text.textContent.trim()];
                """, ["nearBottom": scenario.2]) as? [Any] ?? []
                // A secondary click on the selection opens the page's menu; Ask about this comes first.
                let menuOK = await js(model, """
                const range = getSelection().getRangeAt(0), r = range.getBoundingClientRect();
                const target = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
                const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + r.height / 2 });
                target.dispatchEvent(event);
                const first = document.querySelector('[data-role="context-menu"]:not([hidden]) .item');
                if (!event.defaultPrevented || !first || first.dataset.id !== 'ask') return false;
                first.click();
                return true;
                """) as? Bool == true
                let card = await js(model, """
                await new Promise(r => setTimeout(r, 200));
                const card = document.querySelector('[data-role="ask-card"]');
                if (!card.hasAttribute('data-open')) return [];
                const c = card.getBoundingClientRect(), app = document.getElementById('app').getBoundingClientRect();
                const quote = card.querySelector('.quote')?.textContent.trim() ?? '';
                const focused = document.activeElement === card.querySelector('textarea');
                return [c.top, c.bottom, c.left, c.right, app.left, app.right, app.bottom, document.querySelector('[data-role="scroller"]').scrollTop, quote, focused ? 1 : 0, card.dataset.side ?? ''];
                """) as? [Any] ?? []
                await model.close()
                guard selected.count == 6, card.count == 11 else { pass = false; results.append("\(Int(scenario.0)) \(scenario.1): menu \(menuOK), card not open"); continue }
                let n = { (a: [Any], i: Int) in a[i] as? Double ?? .nan }
                let selTop = n(selected, 0), selBottom = n(selected, 1), selLeft = n(selected, 2)
                let cardTop = n(card, 0), cardBottom = n(card, 1), cardLeft = n(card, 2), cardRight = n(card, 3)
                let inside = cardLeft >= n(card, 4) - 0.5 && cardRight <= n(card, 5) + 0.5 && cardBottom <= n(card, 6) + 0.5
                let off = cardBottom <= selTop + 0.5 || cardTop >= selBottom - 0.5
                let gap = min(abs(cardTop - selBottom), abs(selTop - cardBottom))
                let beside = gap <= 16 && abs(cardLeft - max(selLeft, 12)) <= 24
                let unscrolled = abs(n(selected, 4) - n(card, 7)) <= 0.5
                let sameQuote = (card[8] as? String) == (selected[5] as? String)
                let focused = card[9] as? Int == 1
                let flipped = !scenario.2 || card[10] as? String == "above"
                let ok = menuOK && inside && off && beside && unscrolled && sameQuote && focused && flipped
                pass = pass && ok
                results.append("\(Int(scenario.0)) \(scenario.1)\(scenario.2 ? " near bottom" : ""): menu \(menuOK), side \(card[10]), inside \(inside), off selection \(off), gap \(Int(gap)), unscrolled \(unscrolled), quote \(sameQuote), composer focused \(focused)")
            } catch { pass = false; results.append("\(index): \(error)") }
        }
        return .init(name: name, pass: pass, detail: results.joined(separator: "; "))
    }

    /// Closing find with Escape in Reading removes the find highlights from the registry and repaints
    /// the block that held the current match, so nothing stale stays painted until a re-render.
    /// The pixel sample uses WebKit's snapshot, which paints afresh; a stale on-screen paint shows
    /// only in a visible window.
    func findCloseClears(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "find-close-clears-highlights"
        do {
            let file = workspace.appendingPathComponent("find-close.md")
            try Data("# Find\n\nHuman passage stays here.\n\nAnother human passage below.\n".utf8).write(to: file)
            let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: ReadingStateStore(directory: nil))
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            let sizes = "return ['find', 'find-current'].map(n => CSS.highlights.get(n)?.size ?? 0);"
            await model.sendCommand("find", args: ["query": "Human passage"])
            _ = await js(model, "await new Promise(r => setTimeout(r, 80)); return true;")
            let open = await js(model, sizes) as? [Int] ?? []
            // The current match's rectangle in the page, for a pixel sample of what is painted.
            let rect = await js(model, """
            const p = [...document.querySelectorAll('[data-role="document"] p')].find(p => p.textContent.startsWith('Human passage'));
            const range = document.createRange(); range.setStart(p.firstChild, 0); range.setEnd(p.firstChild, 13);
            const r = range.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
            """) as? [Double] ?? []
            let before = await matchTint(model, rect)
            let repainted = await js(model, """
            const block = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.trim().startsWith('Human passage'));
            if (!block) return false;
            const seen = [];
            const watcher = new MutationObserver(list => { for (const m of list) if (m.target === block && block.hasAttribute('data-repaint')) seen.push(1); });
            watcher.observe(block, { attributes: true, attributeFilter: ['data-repaint'] });
            const field = document.querySelector('input[data-role="find-field"]');
            field.focus();
            field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 120));
            watcher.disconnect();
            return seen.length > 0 && !block.hasAttribute('data-repaint');
            """) as? Bool == true
            let removed = await js(model, "return !CSS.highlights.has('find') && !CSS.highlights.has('find-current');") as? Bool == true
            let closed = await js(model, sizes) as? [Int] ?? []
            let after = await matchTint(model, rect)
            let findOpen = await js(model, "return document.getElementById('app').hasAttribute('data-find');") as? Bool ?? true
            await model.close()
            let pass = open.count == 2 && open[0] > 0 && open[1] > 0 && closed == [0, 0] && removed && repainted && !findOpen && before > 0.08 && after < 0.03
            return .init(name: name, pass: pass, detail: "highlight ranges (find, current) open \(open), after Escape \(closed); highlights removed \(removed); highlighted block repainted once \(repainted); find bar open \(findOpen); painted warm tint of the current match before \(String(format: "%.3f", before)), after \(String(format: "%.3f", after))")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }

    /// The mean amount by which red exceeds blue in a rectangle of the page as WebKit paints it;
    /// the find highlights are amber, the page and text are neutral.
    func matchTint(_ model: ReaderModel, _ rect: [Double]) async -> Double {
        guard rect.count == 4, rect[2] > 0, rect[3] > 0 else { return -1 }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3])
        guard let image = try? await model.page.webView.takeSnapshot(configuration: configuration),
              let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return -1 }
        var sum = 0.0, count = 0.0
        for x in stride(from: 0, to: bitmap.pixelsWide, by: 2) {
            for y in stride(from: 0, to: bitmap.pixelsHigh, by: 2) {
                guard let colour = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                sum += max(0, colour.redComponent - colour.blueComponent); count += 1
            }
        }
        return count > 0 ? sum / count : -1
    }

    /// A secondary click never shows WebKit's menu: native empties any menu WebKit builds, and the
    /// page cancels the event and opens its own menu with the actions for the target, or nothing.
    /// Covers contents per state and target, keyboard use, clipboard round trips through the host,
    /// the hidden selection strip, and placement inside the pane at 452 and 800 pt.
    func pageContextMenu(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "page-context-menu-replaces-system-menu"
        var results: [String] = []
        var pass = true
        let source = "# Menu\n\nAlpha beta gamma words to select.\n\nA [web link](https://example.org/x) and an [anchor](#menu).\n\n![Tiny picture](data:image/png;base64,\(Self.menuImage))\n\n```swift\nlet value = 1\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nLast paragraph here.\n"
        for width in [452.0, 800.0] {
            do {
                let state = ReadingStateStore(directory: nil)
                let file = workspace.appendingPathComponent("page-menu-\(Int(width)).md")
                try Data(source.utf8).write(to: file)
                let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: state)
                let editor = EditorWorkspace(directory: workspace.appendingPathComponent("page-menu-\(Int(width))-drafts"), store: nil)
                editor.add(DraftRecord(source: source))
                let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
                defer { withExtendedLifetime(surface) {} }
                keep.append(CheckRunner.offscreenWindow(page: model.page, width: width, height: 760))
                await model.open(origin: nil)
                try await CheckRunner.preparePageForCheck(model)
                _ = await wait(seconds: 5) { editor.webReady && model.source == source }
                guard let document = editor.active else { pass = false; results.append("\(Int(width)): no draft"); continue }
                // Native: whatever WebKit would show is emptied.
                let menu = NSMenu()
                for identifier in ["WKMenuItemIdentifierCopy", "WKMenuItemIdentifierLookUp", "WKMenuItemIdentifierPaste"] {
                    let item = NSMenuItem(title: identifier, action: nil, keyEquivalent: ""); item.identifier = NSUserInterfaceItemIdentifier(identifier); menu.addItem(item)
                }
                let event = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: model.page.webView.window?.windowNumber ?? 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
                model.page.webView.willOpenMenu(menu, with: event)
                let nativeEmpty = menu.items.isEmpty
                CheckRunner.checkPasteboard.clearContents()
                await model.sendCommand("toggleLock", args: ["lock": "reading"])
                let probe = """
                globalThis.menuProbe = (selector, text, at) => {
                  const scope = document.querySelector(selector);
                  let target = scope, x, y;
                  if (text) {
                    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
                    let node; while ((node = walker.nextNode()) && !node.data.includes(text));
                    const range = document.createRange(); const i = node.data.indexOf(text);
                    range.setStart(node, i); range.setEnd(node, i + text.length);
                    const r = range.getBoundingClientRect(); x = r.left + 2; y = r.top + r.height / 2; target = node.parentElement;
                  } else { const r = scope.getBoundingClientRect(); x = at ? r.left + at[0] : r.left + 8; y = at ? r.top + at[1] : r.top + 8; }
                  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
                  target.dispatchEvent(event);
                  const menu = document.querySelector('[data-role="context-menu"]');
                  const open = !menu.hidden;
                  const items = open ? [...menu.querySelectorAll('.item')].map(i => (i.getAttribute('aria-disabled') === 'true' ? '(' + i.dataset.id + ')' : i.dataset.id)) : [];
                  const m = menu.getBoundingClientRect(), app = document.getElementById('app').getBoundingClientRect();
                  const inside = !open || (m.left >= app.left - 0.5 && m.right <= app.right + 0.5 && m.top >= app.top - 0.5 && m.bottom <= app.bottom + 0.5);
                  const atPointer = !open || (Math.abs(m.left - (x + 2)) <= 1 || Math.abs(m.right - (x - 2)) <= 1);
                  const strip = document.querySelector('[data-role="selection-strip"]').hasAttribute('data-open');
                  return { prevented: event.defaultPrevented, items, inside, atPointer, strip, keys: open ? [...menu.querySelectorAll('.key')].map(k => k.textContent) : [] };
                };
                globalThis.selectText = (text) => {
                  const walker = document.createTreeWalker(document.querySelector('[data-role="document"]'), NodeFilter.SHOW_TEXT);
                  let node; while ((node = walker.nextNode()) && !node.data.includes(text));
                  const range = document.createRange(); const i = node.data.indexOf(text);
                  range.setStart(node, i); range.setEnd(node, i + text.length);
                  getSelection().removeAllRanges(); getSelection().addRange(range);
                  document.dispatchEvent(new Event('selectionchange'));
                };
                return true;
                """
                _ = await js(model, probe)
                func probeAt(_ selector: String, text: String? = nil, at: [Double]? = nil) async -> [String: Any] {
                    let args: [String: Any] = ["selector": selector, "text": text ?? NSNull(), "at": at ?? NSNull()]
                    return await js(model, "await new Promise(r => setTimeout(r, 30)); return menuProbe(selector, text, at);", args) as? [String: Any] ?? [:]
                }
                func items(_ value: [String: Any]) -> [String] { value["items"] as? [String] ?? [] }
                func close() async { _ = await js(model, "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true;") }
                let scrollTop = "return document.querySelector('[data-role=\"scroller\"]').scrollTop;"
                let scrollBefore = await js(model, scrollTop) as? Double ?? -1
                // Reading with a selection.
                _ = await js(model, "selectText('beta gamma'); await new Promise(r => setTimeout(r, 120)); return true;")
                let readingSelection = await probeAt("[data-role=\"document\"]", text: "beta gamma")
                let readingOK = items(readingSelection).first == "ask" && items(readingSelection).contains("copy") && items(readingSelection).contains("copyPassage") && items(readingSelection).contains("editSelection") && readingSelection["strip"] as? Bool == false
                // Keyboard: Down to Ask, Down to Copy, Return copies the selection through the host.
                _ = await js(model, "for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 80)); return true;")
                let copied = await wait(seconds: 2) { CheckRunner.checkPasteboard.string(forType: .string) == "beta gamma" }
                let closedAfterRun = await js(model, "return document.querySelector('[data-role=\"context-menu\"]').hidden;") as? Bool == true
                _ = await probeAt("[data-role=\"document\"]", text: "beta gamma")
                await close()
                let escapeClosed = await js(model, "return document.querySelector('[data-role=\"context-menu\"]').hidden && !getSelection().isCollapsed;") as? Bool == true
                _ = await js(model, "getSelection().removeAllRanges(); return true;")
                // Targets in Reading.
                let link = await probeAt("[data-role=\"document\"]", text: "web link")
                await close()
                let anchor = await probeAt("[data-role=\"document\"]", text: "anchor")
                await close()
                let image = await probeAt("[data-role=\"document\"] [data-image]")
                await close()
                let code = await probeAt("[data-role=\"document\"] pre", text: "value")
                await close()
                let table = await probeAt("[data-role=\"document\"] table", text: "1")
                await close()
                let bar = await probeAt(".bar", at: [200, 20])
                let targetsOK = items(link).contains("openLink") && items(link).contains("copyLink")
                    && items(anchor).contains("openLink") && !items(anchor).contains("copyLink")
                    && items(image).contains("inspectImage") && items(image).contains("copyImageText")
                    && items(code).contains("copyCode") && items(table).contains("copyTable")
                    && bar["prevented"] as? Bool == true && items(bar).isEmpty
                let preventedAll = [readingSelection, link, anchor, image, code, table].allSatisfy { $0["prevented"] as? Bool == true }
                let placed = [readingSelection, link, image, code, table].allSatisfy { $0["inside"] as? Bool == true && $0["atPointer"] as? Bool == true }
                // Writing: an open block, Cut then Paste through the host clipboard.
                await model.sendCommand("toggleLock", args: ["lock": "writing"])
                let opened = await js(model, """
                const block = [...document.querySelectorAll('[data-role="document"] [data-block]')].find(b => b.textContent.includes('Alpha beta'));
                const r = block.getBoundingClientRect();
                const point = { bubbles: true, cancelable: true, button: 0, clientX: r.left + 4, clientY: r.top + r.height / 2 };
                block.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerType: 'mouse', isPrimary: true }));
                block.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
                block.dispatchEvent(new MouseEvent('click', point));
                await new Promise(r => setTimeout(r, 30));
                const editor = document.querySelector('[data-role="block-editor"]');
                if (!editor) return false;
                editor.focus();
                selectText('beta ');
                await new Promise(r => setTimeout(r, 120));
                return true;
                """) as? Bool == true
                let writingSelection = await probeAt("[data-role=\"block-editor\"]", text: "beta")
                let writingOK = items(writingSelection).first == "ask" && ["cut", "copy", "paste", "bold", "italic", "code", "link", "heading", "bulletList"].allSatisfy(items(writingSelection).contains)
                    && (writingSelection["keys"] as? [String] ?? []).contains("⌘X")
                _ = await js(model, "document.querySelector('[data-role=\"context-menu\"] .item[data-id=\"cut\"]').click(); return true;")
                let cut = await wait(seconds: 3) { document.text.source.contains("Alpha gamma") && CheckRunner.checkPasteboard.string(forType: .string) == "beta " }
                _ = await js(model, """
                const editor = document.querySelector('[data-role="block-editor"]');
                const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
                let node, last; while ((node = walker.nextNode())) last = node;
                const range = document.createRange(); range.setStart(last, last.data.length); range.collapse(true);
                getSelection().removeAllRanges(); getSelection().addRange(range);
                document.dispatchEvent(new Event('selectionchange'));
                await new Promise(r => setTimeout(r, 80));
                return true;
                """)
                let caretMenu = await probeAt("[data-role=\"block-editor\"]", text: "select")
                let caretOK = items(caretMenu).contains("(cut)") && items(caretMenu).contains("(copy)") && items(caretMenu).contains("paste")
                _ = await js(model, "document.querySelector('[data-role=\"context-menu\"] .item[data-id=\"paste\"]').click(); return true;")
                let pasted = await wait(seconds: 3) { document.text.source.contains("to select.beta ") }
                let scrollAfter = await js(model, scrollTop) as? Double ?? -2
                await editor.closeViews()
                await model.close()
                let ok = nativeEmpty && readingOK && copied && closedAfterRun && escapeClosed && targetsOK && preventedAll && placed && opened && writingOK && cut && caretOK && pasted && abs(scrollBefore - scrollAfter) < 0.5
                pass = pass && ok
                results.append("\(Int(width)): native menu empty \(nativeEmpty); reading selection \(items(readingSelection)); keyboard copy \(copied), closed \(closedAfterRun), Escape \(escapeClosed); link \(items(link)); anchor \(items(anchor)); image \(items(image)); code \(items(code)); table \(items(table)); bar \(items(bar)) prevented \(bar["prevented"] ?? "?"); all prevented \(preventedAll); placed \(placed); writing selection \(items(writingSelection)); cut \(cut); caret \(items(caretMenu)); paste \(pasted); unscrolled \(abs(scrollBefore - scrollAfter) < 0.5)")
            } catch { pass = false; results.append("\(Int(width)): \(error)") }
        }
        return .init(name: name, pass: pass, detail: results.joined(separator: "; "))
    }

    /// Real AppKit events, not page events, sent through NSApplication's dispatch to a key panel:
    /// key presses take AppKit's key-equivalent and command paths (cancelOperation:, moveDown:)
    /// into WebKit, and right-clicks, double-clicks and Control-clicks take the window's hit test
    /// and WebKit's own context-menu path. Covers Escape closing find, the arrow keys and Escape
    /// in the open page menu, and the menu inside an open block after a double-click.
    func realInput(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "real-keys-and-clicks-reach-find-and-menu"
        let source = "# Real input\n\nHuman passage with words to select and edit.\n\nSecond paragraph for the menu.\n"
        do {
            let state = ReadingStateStore(directory: nil)
            let file = workspace.appendingPathComponent("real-input.md")
            try Data(source.utf8).write(to: file)
            let model = ReaderModel(reference: .file(path: file.path), platform: CheckRunner.platform(), state: state)
            let editor = EditorWorkspace(directory: workspace.appendingPathComponent("real-input-drafts"), store: nil)
            editor.add(DraftRecord(source: source))
            let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
            defer { withExtendedLifetime(surface) {} }
            let window = CheckRunner.offscreenWindow(page: model.page, width: 700, height: 760, key: true)
            keep.append(window)
            await model.open(origin: nil)
            try await CheckRunner.preparePageForCheck(model)
            _ = await wait(seconds: 5) { editor.webReady && model.source == source }
            await model.sendCommand("toggleLock", args: ["lock": "reading"])
            window.makeFirstResponder(model.page.webView)
            let view = model.page.webView
            window.makeKey()
            func key(_ code: UInt16, _ characters: String, flags: NSEvent.ModifierFlags = []) async {
                // Through NSApplication's dispatch, as the system delivers a key press: key
                // equivalents first, then the key window's first responder.
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { continue }
                    NSApp.sendEvent(event)
                }
                _ = await js(model, "await new Promise(r => setTimeout(r, 120)); return true;")
            }
            func escape() async { await key(53, "\u{1b}") }
            func down() async { await key(125, String(UnicodeScalar(NSDownArrowFunctionKey)!), flags: [.function, .numericPad]) }
            func up() async { await key(126, String(UnicodeScalar(NSUpArrowFunctionKey)!), flags: [.function, .numericPad]) }
            func windowPoint(_ x: Double, _ y: Double) -> NSPoint {
                view.convert(NSPoint(x: x, y: view.isFlipped ? y : view.bounds.height - y), to: nil)
            }
            func click(_ x: Double, _ y: Double, down: NSEvent.EventType, up: NSEvent.EventType, flags: NSEvent.ModifierFlags = [], count: Int = 1) async {
                let point = windowPoint(x, y)
                for type in [down, up] {
                    guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: type == down ? 1 : 0) else { continue }
                    NSApp.sendEvent(event)
                    _ = await js(model, "await new Promise(r => setTimeout(r, 70)); return true;")
                }
                _ = await js(model, "await new Promise(r => setTimeout(r, 150)); return true;")
            }
            func point(of text: String, in selector: String) async -> (Double, Double) {
                let value = await js(model, """
                const scope = document.querySelector(selector); if (!scope) return [];
                const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
                let node; while ((node = walker.nextNode()) && !node.data.includes(text));
                if (!node) return [];
                const range = document.createRange(); const i = node.data.indexOf(text);
                range.setStart(node, i); range.setEnd(node, i + text.length);
                const r = range.getBoundingClientRect(); return [r.left + 3, r.top + r.height / 2];
                """, ["selector": selector, "text": text]) as? [Double] ?? []
                return value.count == 2 ? (value[0], value[1]) : (-1, -1)
            }
            let menuState = "const m = document.querySelector('[data-role=\"context-menu\"]'); return [m.hidden ? 'hidden' : 'open', m.querySelector('[data-active]')?.dataset.id ?? '', [...m.querySelectorAll('.item')].map(i => i.dataset.id).join(' ')];"
            func menu() async -> [String] { await js(model, menuState) as? [String] ?? [] }
            let findOpen = "return !!document.querySelector('input[data-role=\"find-field\"]') && document.getElementById('app').hasAttribute('data-find');"
            // Find: a real Escape closes it.
            await model.sendCommand("find", args: ["query": "passage"])
            _ = await wait(seconds: 2) { await js(model, findOpen) as? Bool == true }
            let findWasOpen = await js(model, findOpen) as? Bool == true
            await escape()
            let findClosed = await wait(seconds: 2) { await js(model, findOpen) as? Bool == false }
            // Page menu in Reading: a real right-click opens it; Down, Down, Up move; Escape closes.
            let reading = await point(of: "Second paragraph", in: "[data-role=\"document\"]")
            await click(reading.0, reading.1, down: .rightMouseDown, up: .rightMouseUp)
            let opened = await menu()
            await down()
            let first = await menu()
            await down()
            let second = await menu()
            await up()
            let back = await menu()
            await escape()
            let closed = await menu()
            let readingOK = opened.first == "open" && first.count == 3 && first[1].isEmpty == false && second[1] != first[1] && back[1] == first[1] && closed.first == "hidden"
            // Writing: open the block with a real click, then a real right-click and a Control-click inside it.
            await model.sendCommand("toggleLock", args: ["lock": "writing"])
            _ = await js(model, "await new Promise(r => setTimeout(r, 200)); return true;")
            let passage = await point(of: "words to", in: "[data-role=\"document\"]")
            await click(passage.0, passage.1, down: .leftMouseDown, up: .leftMouseUp)
            let blockOpen = await wait(seconds: 2) { await js(model, "return !!document.querySelector('[data-role=\"block-editor\"]');") as? Bool == true }
            let inBlock = await point(of: "select", in: "[data-role=\"block-editor\"]")
            // As a person does: a double-click selects a word in the open block, then a right-click on it.
            await click(inBlock.0, inBlock.1, down: .leftMouseDown, up: .leftMouseUp, count: 1)
            await click(inBlock.0, inBlock.1, down: .leftMouseDown, up: .leftMouseUp, count: 2)
            let selectedWord = await js(model, "return getSelection().toString();") as? String ?? ""
            await click(inBlock.0, inBlock.1, down: .rightMouseDown, up: .rightMouseUp)
            let blockMenu = await menu()
            await escape()
            let blockMenuClosed = await menu()
            let stillOpen = await js(model, "return !!document.querySelector('[data-role=\"block-editor\"]');") as? Bool == true
            await click(inBlock.0, inBlock.1, down: .leftMouseDown, up: .leftMouseUp, flags: [.control])
            let controlMenu = await menu()
            await escape()
            let blockItems = blockMenu.count == 3 ? blockMenu[2].split(separator: " ").map(String.init) : []
            let controlItems = controlMenu.count == 3 ? controlMenu[2].split(separator: " ").map(String.init) : []
            let blockOK = blockOpen && blockMenu.first == "open" && ["cut", "copy", "paste", "bold"].allSatisfy(blockItems.contains) && blockMenuClosed.first == "hidden" && stillOpen
            let controlOK = controlMenu.first == "open" && controlItems.contains("paste") && controlItems.contains("bold")
            await editor.closeViews()
            await model.close()
            let pass = findWasOpen && findClosed && readingOK && blockOK && controlOK
            return .init(name: name, pass: pass, detail: "find open \(findWasOpen), closed by Escape \(findClosed); reading menu \(opened), Down \(first), Down \(second), Up \(back), Escape \(closed); block open \(blockOpen), double-click selected '\(selectedWord)', right-click in block \(blockMenu), Escape \(blockMenuClosed), block still open \(stillOpen); Control-click in block \(controlMenu)")
        } catch { return .init(name: name, pass: false, detail: "\(error)") }
    }

    static let menuImage = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8CAgonnAwEBAP9fC/V+u2SvAAAAAElFTkSuQmCC"

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
                const rect = block.getBoundingClientRect();
                const point = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 4, clientY: rect.top + rect.height / 2 };
                block.dispatchEvent(new PointerEvent('pointerdown', { ...point, buttons: 1, pointerType: 'mouse', isPrimary: true }));
                block.dispatchEvent(new PointerEvent('pointerup', { ...point, pointerType: 'mouse', isPrimary: true }));
                block.dispatchEvent(new MouseEvent('click', point));
                await new Promise(resolve => setTimeout(resolve, 0));
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
            let detailRows = Provenance.details(model.snapshot, rendered: model.rendered, latestRevision: model.latestRevision, origin: nil, imageEvidence: evidence)
            let qualified = evidence.contains { !$0.displayed && $0.failure?.contains("recorded digest") == true }
                && detailRows.contains { $0.1.contains("recorded digest") }
            // A retained file replaced by a symlink after rendering is refused when served.
            try FileManager.default.removeItem(at: retained)
            try FileManager.default.createSymbolicLink(at: retained, withDestinationURL: outside)
            let beforeSwap = model.refusedAssetRequests
            _ = await js(model, "const img = document.createElement('img'); img.src = 'reader-asset://doc/a0?again'; document.body.appendChild(img); return true;")
            let swapRefused = await wait(seconds: 3) { model.refusedAssetRequests > beforeSwap }
            let pass = loaded && displayedEvidence && displayRetained && linkedShown && refused && swapRefused && mutationRefused && qualified
            return .init(name: "asset-scheme-containment", pass: pass, detail: "retained image decoded: \(loaded), displayed evidence: \(displayedEvidence), repeated Details evidence retained: \(displayRetained); symlink escape shown as unavailable: \(linkedShown); traversal, unknown token and other host refused: \(refused); same-size mutation refused: \(mutationRefused), qualified asset failure: \(qualified); file swapped for a symlink refused: \(swapRefused)")
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
            let stale = await scroll(model, to: 1200)
            let gate = RevisionPreparationGate()
            model.preparationGate = { revision in if revision == 2 { await gate.wait() } }
            try store.write(id, revision: 2, source: Self.longDocument(insert: "An introduction.\n", change: 30))
            let reached = await wait(seconds: 5) { gate.reached }
            let moved = await scroll(model, to: 5000)
            let settled = await wait(seconds: 2) { !model.isScrollingForCheck }
            gate.release()
            let followed = await wait(seconds: 5) { model.snapshot?.revision == 2 && !model.isLoadingForCheck }
            _ = await wait(seconds: 3) { model.lastRestore == .block }
            let restored = await model.capturePositionForCheck()
            let preserved = Self.sameSourcePosition(moved, restored) && stale?.blockStart != restored?.blockStart
            let pass = reached && settled && followed && preserved && model.lastRestore == .block
            await model.close()
            return .init(name: "position-captured-at-installation", pass: pass, detail: "preparation gated: \(reached); scroll settled before installation: \(settled); followed: \(followed); requested source point retained: \(preserved)")
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
            let stale = await scroll(model, to: 1200)
            let scrollGate = RevisionPreparationGate()
            model.preparationGate = { revision in if revision == 2 { await scrollGate.wait() } }
            try store.write(id, revision: 2, source: Self.longDocument(insert: "A new introduction.\n", change: 30))
            let prepared = await wait(seconds: 5) { scrollGate.reached }
            let moved = await scroll(model, to: 5000)
            scrollGate.release()
            let deferred = await wait(seconds: 0.2) { !model.isLoadingForCheck }
                && model.snapshot?.revision == 1
            let followed = await wait(seconds: 5) { model.snapshot?.revision == 2 }
            _ = await wait(seconds: 3) { model.lastRestore == .block }
            let restored = await model.capturePositionForCheck()
            let preserved = Self.sameSourcePosition(moved, restored) && stale?.blockStart != restored?.blockStart
            let selectionGate = RevisionPreparationGate()
            model.preparationGate = { revision in if revision == 3 { await selectionGate.wait() } }
            try store.write(id, revision: 3, source: Self.longDocument(insert: "Another introduction.\n", change: 31))
            let selectionPrepared = await wait(seconds: 5) { selectionGate.reached }
            _ = await js(model, "const p = document.querySelector('p'); getSelection().selectAllChildren(p); return true;")
            let selected = await model.selectedText()
            _ = await wait(seconds: 3) { model.pageState?.hasSelection == true }
            selectionGate.release()
            let finished = await wait(seconds: 3) { !model.isLoadingForCheck }
            let retainedSelection = await model.selectedText()
            let selectionKept = !selected.isEmpty && selected == retainedSelection
                && model.snapshot?.revision == 2 && model.update == .revision(3)
            let pass = prepared && deferred && followed && preserved && selectionPrepared && finished && selectionKept
            let detail = "scroll preparation gated: \(prepared); deferred while scrolling: \(deferred); followed after settling: \(followed); new position restored: \(preserved) (\(moved?.blockStart ?? -1):\(moved?.offsetY ?? -1) -> \(restored?.blockStart ?? -1):\(restored?.offsetY ?? -1), restore \(model.lastRestore.rawValue)); selection preparation gated: \(selectionPrepared); selection retained with update notice: \(selectionKept) (selected \(selected.utf16.count) units, retained equal \(selected == retainedSelection), page selection \(model.pageState?.hasSelection == true), shown revision \(model.snapshot?.revision ?? 0), update \(String(describing: model.update)))"
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
            let previous = model.pageState?.scroll
            _ = await js(model, """
            const block = [...document.querySelectorAll('[data-block]')].find(b => b.textContent.trim().startsWith('Paragraph 120 '));
            const rect = block.getBoundingClientRect();
            const scroller = document.querySelector('[data-role="scroller"]');
            scroller.scrollTo(0, rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop + 0.4 * rect.height);
            document.body.dataset.marker = "kept";
            return true;
            """)
            _ = await wait(seconds: 3) { model.pageState?.scroll != previous }
            let before = await model.capturePositionForCheck()
            let scrollBefore = await js(model, "return document.querySelector('[data-role=\"scroller\"]').scrollTop") as? Double ?? -1
            _ = await js(model, "const p = [...document.querySelectorAll('p')].find(p => p.textContent.startsWith('Paragraph 121 ')); getSelection().selectAllChildren(p); return true;")
            try store.write(id, revision: 2, source: Self.longDocument(insert: "An inserted paragraph.\n\nAnother inserted paragraph.\n", change: 30))
            let watched = await wait(seconds: 3) { model.update == .revision(2) }
            let marker = await js(model, "return document.body.dataset.marker || ''") as? String
            let scrollDuring = await js(model, "return document.querySelector('[data-role=\"scroller\"]').scrollTop") as? Double ?? -2
            let selection = await model.selectedText()
            await model.refresh()
            _ = await wait(seconds: 3) { model.lastRestore == .block }
            let after = await model.capturePositionForCheck()
            let shown = model.snapshot?.revision
            // Text above the reading place changed, so source offsets differ between revisions;
            // the same place is the same paragraph at the same distance from the top.
            let afterText = await js(model, "const b = document.querySelector(`[data-block][data-start=\"${start}\"]`); return b ? b.textContent.trim() : '';", ["start": after?.blockStart ?? -1]) as? String ?? ""
            let samePlace = afterText.hasPrefix("Paragraph 120 ") && abs((before?.offsetY ?? 0) - (after?.offsetY ?? 1000)) < 1
            let pass = watched && model.update == nil && marker == "kept" && scrollDuring == scrollBefore && selection.hasPrefix("Paragraph 121") && shown == 2 && model.lastRestore == .block && samePlace
            return .init(name: "position-survives-refresh", pass: pass, detail: "update noticed by the watcher: \(watched); page untouched until refresh (marker \(marker ?? "?"), scroll \(scrollBefore) -> \(scrollDuring), selection kept: \(selection.hasPrefix("Paragraph 121"))); after refresh revision \(shown ?? 0), restore \(model.lastRestore.rawValue), source point \(before?.blockStart ?? -1):\(before?.offsetY ?? -1) -> \(after?.blockStart ?? -1):\(after?.offsetY ?? -1)")
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
            let saved = await scroll(first, to: 3100)
            await first.close()
            let flushed = await firstState.flush(timeout: 2)
            switch flushed {
            case .notSaved(let reason), .unconfirmed(let reason):
                return .init(name: "position-survives-reopen", pass: false, detail: "the state flush did not confirm a save: \(reason)")
            case .saved, .nothingToSave: break
            }
            let second = await open(store.reference(id), revision: nil, state: ReadingStateStore(directory: stateDirectory), keep: &keep)
            let restored = await second.capturePositionForCheck()
            let scroll = await js(second, "return document.querySelector('[data-role=\"scroller\"]').scrollTop") as? Double ?? 0
            let pass = second.lastRestore == .block && Self.sameSourcePosition(saved, restored) && abs(scroll - 3100) < 40
            return .init(name: "position-survives-reopen", pass: pass, detail: "closed at scroll 3100 (source point \(saved?.blockStart ?? -1):\(saved?.offsetY ?? -1)); reopened at \(Int(scroll)) (source point \(restored?.blockStart ?? -1):\(restored?.offsetY ?? -1), restore \(second.lastRestore.rawValue))")
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
            let saved = await scroll(model, to: 2400)
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
            let scroll = await js(model, "return document.querySelector('[data-role=\"scroller\"]').scrollTop") as? Double ?? 0
            let restored = await model.capturePositionForCheck()
            let pass = recovered && content && scroll > 1000 && Self.sameSourcePosition(saved, restored)
            return .init(name: "webcontent-recovery", pass: pass, detail: "killed \(processes.count) content process(es); reloaded: \(recovered); content back: \(content); scroll position after reload: \(Int(scroll)) (was 2400); saved \(String(describing: model.savedPositionForCheck)); restore \(model.lastRestore.rawValue)")
        } catch {
            return .init(name: "webcontent-recovery", pass: false, detail: String(describing: error))
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
