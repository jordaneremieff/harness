import AppKit
import WebKit

@MainActor
final class ExplorerPage: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    static let entry = URL(string: "explorer-app://app/index.html")!
    let view: WKWebView
    private let scheme: ExplorerScheme
    private(set) var ready = false
    var receive: ((String, [String: Any]) async throws -> [String: Any])?
    var onReady: (() -> Void)?
    var onFailure: ((Error) -> Void)?
    /// Zoom key equivalents and trackpad pinches; the host owns the level.
    var onZoom: ((ExplorerZoom.Step) -> Void)?

    init(resources: URL, workspace: Workspace) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        scheme = ExplorerScheme(web: resources.appendingPathComponent("web"), workspace: workspace)
        configuration.setURLSchemeHandler(scheme, forURLScheme: "explorer-app")
        configuration.setURLSchemeHandler(scheme, forURLScheme: "explorer-asset")
        let web = ExplorerWebView(frame: .zero, configuration: configuration)
        view = web
        super.init()
        web.onZoom = { [weak self] step in self?.onZoom?(step) }
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "explorer")
        view.navigationDelegate = self
        view.setValue(false, forKey: "drawsBackground")
        view.allowsMagnification = false
    }

    func load() { view.load(URLRequest(url: Self.entry)) }
    func replaceWorkspace(_ workspace: Workspace) { scheme.workspace = workspace }
    func close() { view.configuration.userContentController.removeScriptMessageHandler(forName: "explorer", contentWorld: .page) }

    func flushDraft() async {
        guard ready else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var resumed = false
            func finish() {
                guard !resumed else { return }
                resumed = true
                continuation.resume()
            }
            let deadline = DispatchWorkItem(block: finish)
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(750), execute: deadline)
            view.callAsyncJavaScript("await globalThis.explorer?.flushDraft?.(); return true;",
                                     arguments: [:], in: nil, in: .page) { _ in
                deadline.cancel()
                finish()
            }
        }
    }

    @discardableResult func send(_ type: String, _ fields: [String: Any] = [:]) async -> Bool {
        guard ready else { return false }
        var event = fields
        event["type"] = type; event["v"] = 1
        let delivered = try? await view.callAsyncJavaScript("if (typeof globalThis.explorer?.receive !== 'function') return false; globalThis.explorer.receive(event); return true;",
                                                              arguments: ["event": event], in: nil, contentWorld: .page)
        return delivered as? Bool == true
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard navigationAction.targetFrame?.isMainFrame == true, navigationAction.request.url == Self.entry else { return .cancel }
        return .allow
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { onFailure?(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { onFailure?(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        onFailure?(ExplorerError("page", "WebKit stopped unexpectedly."))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        func failure(_ error: Error) {
            let problem = error as? ExplorerError ?? ExplorerError("io", error.localizedDescription)
            var detail: [String: Any] = ["code": problem.code, "message": problem.message]
            detail["retryable"] = problem.retryable
            replyHandler(["ok": false, "error": detail], nil)
        }
        let largeMessages = ["file.write", "edit.draft", "clipboard.write"]
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url == Self.entry,
              var fields = message.body as? [String: Any], let version = fields.removeValue(forKey: "v") as? Int, version == 1,
              let type = fields.removeValue(forKey: "type") as? String, let data = try? JSONSerialization.data(withJSONObject: fields),
              data.count <= (largeMessages.contains(type) ? 13 * mib : (type == "prompt" ? 160 : 256) * kib) else {
            failure(ExplorerError("invalid-message", "The page message or version is invalid or too large.")); return
        }
        Task {
            do {
                guard let receive else { throw ExplorerError("unavailable", "The Explorer host is closed.") }
                var result = try await receive(type, fields)
                result["ok"] = true
                let cap = switch type {
                case "files.list": 64 * mib
                case "files.folder": 4 * mib
                case "file.read", "markdown.render", "review.diff", "edit.draft", "clipboard.read": 32 * mib
                default: 256 * kib
                }
                guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.withoutEscapingSlashes]), data.count <= cap else {
                    throw ExplorerError("too-large", "The result exceeds the bridge limit.")
                }
                replyHandler(result, nil)
                if type == "hello", !ready { ready = true; onReady?() }
            } catch { failure(error) }
        }
    }
}

private final class ExplorerWebView: WKWebView {
    var onZoom: ((ExplorerZoom.Step) -> Void)?
    private var pinch = ExplorerZoom.Pinch()

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) { menu.removeAllItems() }

    // The pane app has no menu bar, so the zoom key equivalents stop here before the page sees them.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let step = ExplorerZoom.step(for: event), let onZoom {
            onZoom(step)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    // A pinch changes the page zoom level, which reflows the page, instead of magnifying a snapshot of it.
    override func magnify(with event: NSEvent) {
        guard let onZoom else { return }
        for step in pinch.steps(Double(event.magnification), phase: event.phase) { onZoom(step) }
    }
}

@MainActor
private final class ExplorerScheme: NSObject, WKURLSchemeHandler {
    let web: URL
    var workspace: Workspace
    private var active: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(web: URL, workspace: Workspace) {
        self.web = URL(fileURLWithPath: canonical(web.path) ?? web.path, isDirectory: true)
        self.workspace = workspace
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task as AnyObject)
        guard let url = task.request.url, task.request.httpMethod == "GET", url.query == nil, url.user == nil, url.port == nil else {
            task.didFailWithError(ExplorerError("scheme", "Invalid Explorer resource.")); return
        }
        let workspace = self.workspace, web = self.web
        active[id] = Task { [weak self] in
            let output = await Task.detached(priority: .userInitiated) { Result { try Self.read(url, web: web, workspace: workspace) } }.value
            guard let self, active.removeValue(forKey: id) != nil, !Task.isCancelled else { return }
            switch output {
            case .failure(let error): task.didFailWithError(error)
            case .success(let (data, headers)):
                guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
                    task.didFailWithError(ExplorerError("scheme", "Invalid Explorer response.")); return
                }
                task.didReceive(response); task.didReceive(data); task.didFinish()
            }
        }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.removeValue(forKey: ObjectIdentifier(task as AnyObject))?.cancel()
    }

    nonisolated private static func read(_ url: URL, web: URL, workspace: Workspace) throws -> (Data, [String: String]) {
        let policy = "default-src 'none'; script-src explorer-app:; style-src explorer-app:; img-src explorer-app: explorer-asset: data:; font-src explorer-app:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        let path = String(url.path.dropFirst())
        var headers = ["X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"]
        if url.scheme == "explorer-asset", url.host == "image", UUID(uuidString: path) != nil {
            let (data, mime) = try workspace.asset(path)
            headers["Content-Type"] = mime
            headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
            return (data, headers)
        }
        guard url.scheme == "explorer-app", url.host == "app", validPath(path),
              path == "index.html" || path.hasPrefix("app/") || path.hasPrefix("styles/"),
              let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                          "svg": "image/svg+xml", "png": "image/png", "woff2": "font/woff2", "json": "application/json"][url.pathExtension],
              let (fd, _) = try openContained(web, path) else { throw ExplorerError("scheme", "Explorer resource not found.") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let data = try handle.read(upToCount: 4 * mib + 1) ?? Data()
        guard data.count <= 4 * mib else { throw ExplorerError("scheme", "Explorer resource is too large.") }
        headers["Content-Type"] = mime
        headers["Content-Security-Policy"] = policy
        return (data, headers)
    }
}
