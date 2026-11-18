import AppKit
import WebKit

@MainActor
final class ComposerPage: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    static let address = URL(string: "composer-app://app/composer.html")!
    let view: WKWebView
    var receive: ((String, [String: Any]) async throws -> [String: Any])?
    var onDroppedFiles: (([URL]) -> Void)?
    var onFailure: (() -> Void)?

    init(frame: CGRect) throws {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
              FileManager.default.isReadableFile(atPath: root.appendingPathComponent("composer.html").path) else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(ComposerAppSchemeHandler(resources: ComposerAppResources(root: root)), forURLScheme: "composer-app")
        view = ComposerWebView(frame: frame, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.autoresizingMask = [.maxYMargin]
        super.init()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "composer")
        view.navigationDelegate = self
        (view as? ComposerWebView)?.onDroppedFiles = { [weak self] in self?.onDroppedFiles?($0) }
    }

    struct Viewport: Equatable {
        let pane: CGFloat
        var growth: CGFloat = 0
        var menu: CGFloat = 0
    }

    func mount(in content: NSView) {
        content.wantsLayer = true
        content.layer?.masksToBounds = true
        content.addSubview(view)
    }

    /// The window clips the page; changes to the clip must not reflow the page.
    func setViewportLimit(_ size: CGSize) {
        guard view.frame.size != size else { return }
        view.frame = CGRect(origin: .zero, size: size)
    }

    func sendViewport(_ viewport: Viewport) async -> Bool {
        await send("viewport", ["pane": viewport.pane, "growth": viewport.growth, "menu": viewport.menu])
    }

    func load() { view.load(URLRequest(url: Self.address)) }

    @discardableResult
    func send(_ type: String, _ fields: [String: Any] = [:]) async -> Bool {
        var envelope = fields
        envelope["v"] = 1
        envelope["type"] = type
        do {
            let reply = try await view.callAsyncJavaScript(
                "return globalThis.composer.receive(message);", arguments: ["message": envelope], in: nil, contentWorld: .page
            )
            return reply as? Bool == true
        } catch { return false }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "composer-app",
              message.frameInfo.securityOrigin.host == "app", message.frameInfo.request.url == Self.address,
              let fields = message.body as? [String: Any], fields["v"] as? Int == 1,
              let type = fields["type"] as? String, let receive else { return (nil, "Invalid composer message.") }
        do {
            var reply = try await receive(type, fields)
            reply["v"] = 1; reply["ok"] = true
            return (reply, nil)
        } catch {
            return (["v": 1, "ok": false, "error": error.localizedDescription], nil)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.url == Self.address ? .allow : .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onFailure?(); load() }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { onFailure?() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { onFailure?() }
}

private final class ComposerWebView: WKWebView {
    var onDroppedFiles: (([URL]) -> Void)?
    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        if let onDroppedFiles,
           let files = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !files.isEmpty {
            onDroppedFiles(files)
            return true
        }
        return super.performDragOperation(sender)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
