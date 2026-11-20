import AppKit
import WebKit

struct ConfigFailure: LocalizedError {
    let errorDescription: String?
    init(_ text: String) { errorDescription = text }
}

@MainActor
final class ConfigPage: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    let address: URL
    let view: WKWebView
    var receive: ((String, [String: Any]) async throws -> [String: Any])?
    var onFailure: ((String) -> Void)?
    var onLoad: (() -> Void)?

    init(frame: CGRect, query: String? = nil, checkTheme: String? = nil, liveCheck: Bool = false) throws {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
              FileManager.default.isReadableFile(atPath: root.appendingPathComponent("index.html").path) else {
            throw ConfigFailure("The Config app is missing its interface files.")
        }
        var parts = URLComponents(string: "config-app://app/index.html")!
        if let checkTheme {
            parts.queryItems = [URLQueryItem(name: liveCheck ? "check" : "fixture", value: "1"), URLQueryItem(name: "theme", value: checkTheme)]
        } else if let query {
            parts.queryItems = [URLQueryItem(name: "query", value: query)]
        }
        address = parts.url!
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.tabFocusesLinks = true
        configuration.setURLSchemeHandler(AppSchemeHandler(resources: AppResources(root: root)), forURLScheme: AppResources.scheme)
        view = PaneWebView(frame: frame, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        super.init()
        if checkTheme == nil || liveCheck { configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "config") }
        view.navigationDelegate = self
    }

    func load() { view.load(URLRequest(url: address)) }

    @discardableResult
    func send(_ type: String, _ fields: [String: Any] = [:]) async -> Bool {
        var message = fields
        message["type"] = type
        do {
            return try await view.callAsyncJavaScript("if (!globalThis.configEvent) return false; globalThis.configEvent(event); return true;", arguments: ["event": message], in: nil, contentWorld: .page) as? Bool == true
        } catch { return false }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url == address,
              message.frameInfo.securityOrigin.protocol == AppResources.scheme,
              message.frameInfo.securityOrigin.host == "app",
              let envelope = message.body as? [String: Any], let op = envelope["op"] as? String,
              let fields = envelope["payload"] as? [String: Any], let receive else {
            return (nil, "Invalid Config message.")
        }
        do { return (try await receive(op, fields), nil) }
        catch { return (nil, error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.targetFrame?.isMainFrame == true && action.request.url == address ? .allow : .cancel
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onLoad?() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onFailure?("The Config interface stopped. Open it again from Pi to recover drafts.") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { onFailure?(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { onFailure?(error.localizedDescription) }
}

private final class PaneWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
