import AppKit
import Foundation
import MarkdownCore
import WebKit

/// The native host of the reader page. The interface and its document history live in the page.
@MainActor
public final class ReaderWebPage: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    public let webView: WKWebView
    public private(set) var isReady = false
    public private(set) var documentReady = false
    public var onDocumentReady: ((Bool) -> Void)?
    private var documentDelivery = 0
    public private(set) var consoleErrors: [String] = []
    public var onMessage: (([String: Any]) async throws -> [String: Any])?
    var receiveMessage: ((ReaderBridgeMessage) async throws -> [String: Any]?)?
    var contentProcessTerminated: (() -> Void)?
    private var readyWaiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    private var loading = false
    private var navigated = false
    private var loadFailure: (any Error)?
    private var closed = false

    public var isInspectable: Bool {
        get { webView.isInspectable }
        set { webView.isInspectable = newValue }
    }

    init(root: URL, assets: AssetTable) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(ReaderAppSchemeHandler(resources: ReaderAppResources(root: root)), forURLScheme: "reader-app")
        configuration.setURLSchemeHandler(AssetSchemeHandler(table: assets), forURLScheme: MarkdownRenderer.assetScheme)
        let view = FirstMouseWebView(frame: .zero, configuration: configuration)
        webView = view
        super.init()
        view.page = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        webView.configuration.userContentController.addScriptMessageHandler(WeakReaderScriptHandler(page: self), contentWorld: .page, name: "reader")
    }

    public convenience init(webRoot: URL) {
        self.init(root: webRoot, assets: AssetTable())
    }

    /// Loads only the application shell and waits for its ready message. No document HTML is loaded.
    public func load() async throws {
        guard !closed else { throw CancellationError() }
        if isReady { return }
        if let loadFailure { throw loadFailure }
        if !loading {
            loading = true
            navigated = false
            webView.load(URLRequest(url: URL(string: "reader-app://app/index.html")!))
        }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if isReady { continuation.resume(); return }
                readyWaiters[id] = continuation
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(15))
                    self?.readyWaiters.removeValue(forKey: id)?.resume(throwing: URLError(.timedOut))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.readyWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
            }
        }
    }

    public func close() {
        guard !closed else { return }
        closed = true
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "reader", contentWorld: .page)
        isReady = false
        fail(CancellationError())
    }

    public func reload() async throws {
        invalidateDocument()
        isReady = false
        loading = false
        loadFailure = nil
        try await load()
    }

    public func callJavaScript(_ body: String, arguments: [String: Any] = [:], contentWorld: WKContentWorld = .page) async throws -> Any? {
        try await webView.callAsyncJavaScript(body, arguments: arguments, in: nil, contentWorld: contentWorld)
    }

    @discardableResult
    public func send(_ envelope: [String: Any]) async throws -> Any? {
        let document = envelope["type"] as? String == "document"
        if document { invalidateDocument() }
        let delivery = documentDelivery
        try ReaderBridgeCodec.validateNativeEnvelope(envelope)
        try await load()
        let result = try await callJavaScript("return reader.receive(m)", arguments: ["m": envelope])
        if document {
            guard result as? Bool == true else { throw ReaderBridgeError.invalid("The page refused the document") }
            if delivery == documentDelivery, !closed, isReady { setDocumentReady(true) }
        }
        return result
    }

    private func setDocumentReady(_ ready: Bool) {
        guard documentReady != ready else { return }
        documentReady = ready
        onDocumentReady?(ready)
    }

    private func invalidateDocument() {
        documentDelivery += 1
        setDocumentReady(false)
    }

    public func snapshot(_ configuration: WKSnapshotConfiguration? = nil) async throws -> NSImage {
        try await webView.takeSnapshot(configuration: configuration)
    }

    @MainActor public struct ExportFormat {
        let configuration: WKPDFConfiguration
        public static func pdf() -> Self { Self(configuration: WKPDFConfiguration()) }
    }

    public func exported(as format: ExportFormat) async throws -> Data {
        try await webView.pdf(configuration: format.configuration)
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                                      replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        Task { @MainActor in
            var request: ReaderBridgeMessage?
            do {
                guard !closed else { throw CancellationError() }
                guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "reader-app",
                      message.frameInfo.securityOrigin.host == "app" else { throw URLError(.noPermissionsToReadFile) }
                let decoded = try ReaderBridgeCodec.decode(body: message.body)
                request = decoded
                if decoded.type == .ready {
                    isReady = true
                    loading = false
                    let waiters = Array(readyWaiters.values)
                    readyWaiters.removeAll()
                    for waiter in waiters { waiter.resume() }
                }
                if decoded.type == .log, decoded.fields["level"] as? String == "error", let text = decoded.fields["message"] as? String {
                    if consoleErrors.count < 100 { consoleErrors.append(String(text.prefix(4096))) }
                }
                let owned = try await receiveMessage?(decoded)
                let result: [String: Any]
                if let owned { result = owned }
                else if let onMessage, let fields = message.body as? [String: Any] { result = try await onMessage(fields) }
                else { result = [:] }
                var reply = result
                reply["v"] = 1; reply["type"] = "reply"; reply["ok"] = true
                if let id = decoded.id { reply["id"] = id }
                try ReaderBridgeCodec.validateReply(reply, request: decoded)
                replyHandler(reply, nil)
            } catch {
                let detail = String(decoding: error.localizedDescription.utf8.prefix(4096), as: UTF8.self)
                var reply: [String: Any] = ["v": 1, "type": "reply", "ok": false, "error": detail]
                if let id = request?.id { reply["id"] = id }
                if let request {
                    do { try ReaderBridgeCodec.validateReply(reply, request: request) }
                    catch { replyHandler(nil, "The reader could not encode a bounded reply."); return }
                }
                replyHandler(reply, nil)
            }
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if loading, !navigated, navigationAction.targetFrame?.isMainFrame == true,
           url?.absoluteString == "reader-app://app/index.html" {
            navigated = true
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { fail(error) }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { fail(error) }
    private func fail(_ error: any Error) {
        invalidateDocument()
        isReady = false
        loadFailure = error
        loading = false
        let waiters = Array(readyWaiters.values)
        readyWaiters.removeAll()
        for waiter in waiters { waiter.resume(throwing: error) }
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        isReady = false
        loading = false
        loadFailure = nil
        fail(URLError(.networkConnectionLost))
        loadFailure = nil
        contentProcessTerminated?()
    }
}

@MainActor
private final class WeakReaderScriptHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var page: ReaderWebPage?
    init(page: ReaderWebPage) { self.page = page }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard let page else { replyHandler(nil, "The reader closed."); return }
        page.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}

@MainActor
private final class FirstMouseWebView: WKWebView {
    weak var page: ReaderWebPage?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// WebKit builds the context menu, with its system items, before it opens; the reader adds
    /// its ask command at the top when the menu is for selected text.
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        ReaderContextMenu.addAsk(to: menu, target: self, action: #selector(askAboutSelection(_:)))
    }

    @objc func askAboutSelection(_ sender: Any?) {
        guard let page else { return }
        Task { @MainActor in _ = try? await page.send(["v": 1, "type": "command", "name": "askSelection"]) }
    }
}

/// The reader's addition to WebKit's context menu. The page owns the ask command; the menu item
/// only sends it, so every standard item (Copy, Look Up, Translate, Share, Services) stays.
public enum ReaderContextMenu {
    public static let askIdentifier = NSUserInterfaceItemIdentifier("ReaderAskAboutSelection")
    public static let askTitle = "Ask about this"
    /// WebKit's item identifiers that appear only for selected text. Copy counts only while enabled,
    /// because an editable area can list a disabled Copy without a selection.
    static let selectionItems: Set<String> = ["WKMenuItemIdentifierLookUp", "WKMenuItemIdentifierTranslate",
                                                "WKMenuItemIdentifierSearchWeb", "WKMenuItemIdentifierShareMenu"]
    static let copyItem = "WKMenuItemIdentifierCopy"

    public static func isSelectionMenu(_ menu: NSMenu) -> Bool {
        menu.items.contains { item in
            guard let identifier = item.identifier?.rawValue else { return false }
            return selectionItems.contains(identifier) || (identifier == copyItem && item.isEnabled)
        }
    }

    @MainActor public static func addAsk(to menu: NSMenu, target: AnyObject, action: Selector) {
        guard isSelectionMenu(menu), !menu.items.contains(where: { $0.identifier == askIdentifier }) else { return }
        let item = NSMenuItem(title: askTitle, action: action, keyEquivalent: "")
        item.identifier = askIdentifier
        item.target = target
        menu.insertItem(item, at: 0)
        menu.insertItem(.separator(), at: 1)
    }
}
