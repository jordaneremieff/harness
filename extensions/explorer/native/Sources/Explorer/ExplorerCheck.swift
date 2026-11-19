import AppKit
import Network
import WebKit

@MainActor
enum ExplorerCheck {
    private final class CheckPanel: NSPanel {
        override var isKeyWindow: Bool { true }
        override var canBecomeKey: Bool { false }
        // A transparent check window must draw while it remains invisible to the operator.
        override var occlusionState: NSWindow.OcclusionState { isVisible ? [.visible] : super.occlusionState }
    }
    static func export(_ argv: [String], resources: URL) throws {
        let raw = try options(argv, allowed: ["out", "width", "height", "appearance", "root", "path", "line", "script"])
        guard let out = raw["out"], let width = raw["width"].flatMap(Int.init), let height = raw["height"].flatMap(Int.init),
              (320...4096).contains(width), (240...4096).contains(height), (raw["appearance"].map { ["dark", "light"].contains($0) } ?? true) else {
            throw ExplorerError("arguments", "Use --export-image --out <png> --width <n> --height <n> --root <dir> [--appearance dark|light] [--path <path>] [--line <n>] [--script <file>].")
        }
        let target = try Launch(arguments: ["root", "path", "line"].flatMap { key in raw[key].map { ["--\(key)", $0] } ?? [] })
        let scratch = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: scratch) }
        try execute(target: target, resources: resources, store: scratch, width: width, height: height, appearance: raw["appearance"]) { host, window in
            if let file = raw["script"] {
                let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: file))
                let data = try handle.read(upToCount: mib + 1) ?? Data()
                guard data.count <= mib, let code = String(data: data, encoding: .utf8) else { throw ExplorerError("invalid", "The snapshot script is invalid or too large.") }
                _ = try await host.page.view.evaluateJavaScript(code)
            }
            try await paint(host.page.view)
            let image = try await host.page.view.takeSnapshot(configuration: nil)
            guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
                throw ExplorerError("snapshot", "WebKit did not return a PNG.")
            }
            try png.write(to: URL(fileURLWithPath: out), options: .atomic)
        }
    }

    static func verify(resources: URL) throws {
        let scratch = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("fixture")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let git = { (args: [String]) throws in
            let result = try command("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Explorer", "-c", "user.email=explorer@example.invalid"] + args,
                                     cwd: root, environment: ["PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"], limit: 128 * kib, seconds: 3)
            guard result.status == 0 else { throw ExplorerError("verify", "The private Git fixture could not be created.") }
        }
        try git(["init", "--quiet", "-b", "main"])
        let file = root.appendingPathComponent("example.ts")
        try Data("export const answer = 41;\n".utf8).write(to: file)
        try git(["add", "example.ts"]); try git(["commit", "--quiet", "-m", "Fixture"])
        try Data("export const answer = 42;\n".utf8).write(to: file)
        let fake = try FakeLive()
        defer { fake.stop() }
        let config = LiveConfiguration(version: 1, endpoint: URL(string: "http://127.0.0.1:\(fake.port)")!, token: FakeLive.token)
        let target = try Launch(target: ["root": root.path, "path": "example.ts"])
        try execute(target: target, resources: resources, store: scratch.appendingPathComponent("store"), width: 898, height: 800, appearance: "dark", live: config) { host, _ in
            let result = try await host.page.view.callAsyncJavaScript("""
            const bridge = globalThis.webkit.messageHandlers.explorer;
            const call = (type, fields = {}) => bridge.postMessage({ v: 1, type, ...fields });
            async function accept(type, fields) {
              const result = await call(type, fields);
              if (!result.ok) throw Error(type + ': ' + result.error?.message);
              return result;
            }
            const hello = await accept('hello');
            if (hello.root.kind !== 'git' || hello.root.branch !== 'main' || hello.launch.path !== 'example.ts') throw Error('hello location');
            const draft = {mode:'ask', text:'Unsaved question', range:{side:'head',start:1,end:1}, commit:null};
            await accept('state.save', {path:'example.ts',draft});
            if ((await accept('hello')).launch.draft?.text !== draft.text) throw Error('draft not retained');
            await accept('state.save', {path:'example.ts',draft:null});
            if ((await accept('hello')).launch.draft !== undefined) throw Error('draft not cleared');
            const files = await accept('files.list');
            if (!files.paths.includes('example.ts')) throw Error('file list');
            if ((await accept('file.read', {path:'example.ts'})).text !== 'export const answer = 42;\\n') throw Error('file content');
            if ((await call('file.read', {path:'../example.ts'})).ok) throw Error('escaped path');
            if ((await bridge.postMessage({v:2,type:'hello'})).ok || (await call('unknown')).ok) throw Error('unknown request accepted');
            const scope = {kind:'uncommitted'};
            const review = await accept('review.files', {scope});
            if (review.resolved.label !== 'Uncommitted changes' || !review.files.some(item => item.path === 'example.ts' && item.additions === 1)) throw Error('review files');
            const latest = await accept('review.files', {scope:{kind:'commit',commit:'HEAD'}});
            if (latest.resolved.label !== `${hello.root.head.slice(0,7)} Fixture`) throw Error('resolved review label');
            const diff = await accept('review.diff', {scope, path:'example.ts'});
            if (diff.hunks.length !== 1 || !diff.base.includes('41') || !diff.head.includes('42')) throw Error('review diff');
            const found = await accept('search', {query:'answer'});
            if (!found.results.some(row => row.path === 'example.ts' && row.line === 1)) throw Error('search results');
            const note = await accept('notes.write',{op:'create',note:{path:'example.ts',side:'head',start:1,end:1,commit:null,quote:'export const answer = 42;',text:'Notice',state:'open',author:'operator'}});
            if (!(await accept('notes.list')).notes.some(item => item.id === note.note.id)) throw Error('note not retained');
            const viewed = await accept('review.state', {op:'set',key:review.resolved.key,viewed:['example.ts']});
            if (viewed.viewed[0] !== 'example.ts') throw Error('review state');
            let connected = false;
            for (let i = 0; i < 180 && !connected; i++) {
              connected = (await accept('hello')).live.connected;
              if (!connected) await new Promise(requestAnimationFrame);
            }
            if (!connected) throw Error('fake Pi did not connect');
            const requestId = '00000000-0000-4000-8000-000000000001';
            const threadId = '00000000-0000-4000-8000-000000000002';
            const original = globalThis.explorer.receive;
            globalThis.explorer.receive = event => {
              if (event.type === 'promptState' && event.requestId === requestId && event.threadId === threadId && event.text === 'Verified reply' && event.status === 'answer') globalThis.__verifiedAnswer = true;
              return original(event);
            };
            const receipt = await accept('prompt', {requestId,threadId,text:'Verify Explorer'});
            if (receipt.status !== 'admitted') throw Error('prompt receipt');
            for (let i=0; i<180 && !globalThis.__verifiedAnswer; i++) await new Promise(requestAnimationFrame);
            if (!globalThis.__verifiedAnswer) throw Error('prompt answer');
            return document.visibilityState;
            """, arguments: [:], in: nil, contentWorld: .page)
            guard result as? String == "visible" else { throw ExplorerError("verify", "WebKit did not render a visible page.") }
        }
        print("Explorer verified: real page, file, Git review, search, notes, drafts, live prompt and answer.")
    }

    private static func scratchDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return url
    }

    private static func paint(_ view: WKWebView) async throws {
        _ = try await view.callAsyncJavaScript("await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return true;", arguments: [:], in: nil, contentWorld: .page)
    }

    private static func execute(target: Launch, resources: URL, store: URL, width: Int, height: Int, appearance: String?, live: LiveConfiguration? = nil,
                                body: @escaping (ExplorerHost, NSWindow) async throws -> Void) throws {
        let workspace = try prepareWorkspace(target)
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let screen = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let rect = CGRect(x: screen.minX, y: screen.minY, width: CGFloat(width), height: CGFloat(height))
        let window = CheckPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.isExcludedFromWindowsMenu = true
        if let appearance { window.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
        let host = ExplorerHost(target, workspace: workspace, store: store, resources: resources)
        window.contentView = host.page.view
        host.page.view.frame = CGRect(x: 0, y: 0, width: width, height: height)
        host.page.view.autoresizingMask = [.width, .height]
        if appearance != nil { host.page.view.appearance = window.appearance }
        if let appearance {
            host.page.view.configuration.userContentController.addUserScript(WKUserScript(source: "document.documentElement.dataset.theme = '\(appearance)';", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        defer { host.page.close(); window.orderOut(nil) }
        var result: Result<Void, Error>?
        func finish(_ outcome: Result<Void, Error>) {
            guard result == nil else { return }
            result = outcome
            app.stop(nil)
            if let event = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0,
                                              windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
                app.postEvent(event, atStart: true)
            }
        }
        host.page.onFailure = { finish(.failure($0)) }
        let job = Task {
            window.orderFrontRegardless()
            host.start(live: live)
            do {
                while !host.page.ready { try await Task.sleep(for: .milliseconds(25)) }
                let readyUntil = ProcessInfo.processInfo.systemUptime + 10
                while try await host.page.view.evaluateJavaScript("document.documentElement?.dataset.ready === 'true'") as? Bool != true {
                    guard ProcessInfo.processInfo.systemUptime < readyUntil else { throw ExplorerError("page", "The Explorer page did not finish opening its target.") }
                    try await Task.sleep(for: .milliseconds(30))
                }
                try await paint(host.page.view)
                try await body(host, window)
                finish(.success(()))
            } catch { finish(.failure(error)) }
        }
        let timeout = Task {
            do { try await Task.sleep(for: .seconds(18)) } catch { return }
            let stage = host.page.ready ? "rendering the target" : "waiting for the hello message"
            finish(.failure(ExplorerError("timeout", "The Explorer check timed out while \(stage).")))
        }
        defer { job.cancel(); timeout.cancel() }
        if result == nil { app.run() }
        guard let result else { throw ExplorerError("verify", "The Explorer check stopped unexpectedly.") }
        try result.get()
    }
}

private final class FakeLive {
    static let token = String(repeating: "a", count: 64)
    private let listener: NWListener
    private let queue = DispatchQueue(label: "explorer.verify.live")
    private var state: [String: Any] = ["sequence": 0, "status": "idle", "text": "", "truncated": false]
    private(set) var port: UInt16 = 0

    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { status in
            switch status { case .ready, .failed: ready.signal(); default: break }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.read(connection, Data())
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 3) == .success, let assigned = listener.port?.rawValue else {
            listener.cancel(); throw ExplorerError("verify", "The private live fixture did not listen.")
        }
        port = assigned
    }
    func stop() { listener.cancel() }

    private func read(_ connection: NWConnection, _ pending: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, let data, error == nil, pending.count + data.count <= mib else { connection.cancel(); return }
            let buffer = pending + data
            let delimiter = Data("\r\n\r\n".utf8)
            if let end = buffer.range(of: delimiter), let header = String(data: buffer[..<end.lowerBound], encoding: .utf8) {
                let lines = header.components(separatedBy: "\r\n")
                let length = lines.first { $0.lowercased().hasPrefix("content-length:") }?.dropFirst(15).trimmingCharacters(in: .whitespaces).flatMapInt
                if let length, length >= 0, buffer.count - end.upperBound >= length {
                    let body = buffer[end.upperBound..<(end.upperBound + length)]
                    self.respond(connection, headers: lines, body: Data(body)); return
                }
            }
            if complete { connection.cancel() } else { self.read(connection, buffer) }
        }
    }
    private func respond(_ connection: NWConnection, headers: [String], body: Data) {
        var result: [String: Any] = ["ok": true]
        guard headers.contains(where: { $0.lowercased() == "authorization: bearer \(Self.token)" }),
              let target = headers.first?.split(separator: " ").dropFirst().first,
              let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              fields["workspace"] is String, fields["document"] is String else { connection.cancel(); return }
        switch target {
        case "/connect": result["handle"] = "verify"; result["label"] = "Explorer verification"
        case "/poll": result["state"] = state; result["command"] = jsonNull
        case "/prompt":
            guard fields["text"] as? String == "Verify Explorer", let id = fields["requestId"], let thread = fields["threadId"] else { connection.cancel(); return }
            result["status"] = "admitted"
            state = ["sequence": 1, "status": "answer", "text": "Verified reply", "truncated": false, "requestId": id, "threadId": thread]
        case "/close", "/result": break
        default: connection.cancel(); return
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: result) else { connection.cancel(); return }
        let head = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n".utf8)
        connection.send(content: head + bytes, completion: .contentProcessed { _ in connection.cancel() })
    }
}

private extension String { var flatMapInt: Int? { Int(self) } }
