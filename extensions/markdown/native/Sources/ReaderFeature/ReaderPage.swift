import Foundation
import MarkdownCore
import WebKit

/// Local images the current rendering may load, by token. The scheme handler serves nothing else.
final class AssetTable: @unchecked Sendable {
    private let lock = NSLock()
    private var assets: [String: ResolvedAsset] = [:]
    private var refusedCount = 0
    private var servedCount = 0

    func replace(_ assets: [String: ResolvedAsset]) {
        lock.withLock { self.assets = assets }
    }

    func asset(_ token: String) -> ResolvedAsset? {
        lock.withLock { assets[token] }
    }

    func noteRefused() { lock.withLock { refusedCount += 1 } }
    func noteServed() { lock.withLock { servedCount += 1 } }
    var refused: Int { lock.withLock { refusedCount } }
    var served: Int { lock.withLock { servedCount } }
}

/// Serves `reader-asset://app/reader.css` and `reader-asset://doc/<token>` for tokens of the
/// current rendering. Every other address fails.
struct AssetSchemeHandler: URLSchemeHandler {
    let table: AssetTable

    func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
        let table = self.table
        return AsyncThrowingStream { continuation in
            guard let url = request.url else {
                continuation.finish(throwing: URLError(.badURL))
                return
            }
            do {
                let (data, mediaType) = try Self.content(for: url, table: table)
                let headers = [
                    "Content-Type": mediaType,
                    "Content-Length": String(data.count),
                    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "no-store",
                ]
                let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)
                    ?? URLResponse(url: url, mimeType: mediaType, expectedContentLength: data.count, textEncodingName: nil)
                continuation.yield(.response(response))
                continuation.yield(.data(data))
                continuation.finish()
                table.noteServed()
            } catch {
                table.noteRefused()
                continuation.finish(throwing: error)
            }
        }
    }

    static func content(for url: URL, table: AssetTable) throws -> (Data, String) {
        let path = url.path
        switch url.host {
        case "app" where path == "/reader.css":
            return (Data(Stylesheet.css.utf8), "text/css; charset=utf-8")
        case "doc":
            let token = String(path.dropFirst())
            guard let asset = table.asset(token) else { throw URLError(.fileDoesNotExist) }
            return (try asset.readData(), asset.mediaType)
        default:
            throw URLError(.unsupportedURL)
        }
    }
}

/// The decision for a navigation the page asked for.
enum NavigationRequest {
    case documentLoad
    case sameDocument
    case copyCode(nonce: String, index: Int)
    case external(URL)
    case blocked(URL?)

    static func classify(_ url: URL?, expectingLoad: Bool) -> NavigationRequest {
        guard let url else { return .blocked(nil) }
        let scheme = url.scheme?.lowercased() ?? ""
        switch scheme {
        case "about":
            if url.fragment != nil, !expectingLoad { return .sameDocument }
            return expectingLoad ? .documentLoad : .blocked(url)
        case MarkdownRenderer.actionScheme:
            let parts = url.absoluteString.dropFirst(scheme.count + 1).split(separator: "/")
            if parts.count == 3, parts[0] == "copy-code", let index = Int(parts[2]) {
                return .copyCode(nonce: String(parts[1]), index: index)
            }
            return .blocked(url)
        case "http", "https":
            return .external(url)
        default:
            return .blocked(url)
        }
    }
}

/// Receives navigation decisions for one page.
@MainActor
protocol NavigationHandling: AnyObject {
    var expectingLoad: Bool { get }
    func handle(_ request: NavigationRequest)
}

@MainActor
final class NavigationRouter {
    weak var handler: (any NavigationHandling)?
}

/// Decides every navigation: the document load and in-page anchors are allowed; app actions,
/// web links and everything else are cancelled and handed to the reader.
struct ReaderNavigationDecider: WebPage.NavigationDeciding {
    let router: NavigationRouter

    func decidePolicy(for action: WebPage.NavigationAction, preferences: inout WebPage.NavigationPreferences) async -> WKNavigationActionPolicy {
        preferences.allowsContentJavaScript = false
        let request = NavigationRequest.classify(action.request.url, expectingLoad: router.handler?.expectingLoad ?? false)
        switch request {
        case .documentLoad, .sameDocument:
            return .allow
        default:
            router.handler?.handle(request)
            return .cancel
        }
    }

    func decidePolicy(for response: WebPage.NavigationResponse) async -> WKNavigationResponsePolicy {
        .allow
    }
}

/// App-owned DOM helpers. They run only in the reader's own content world and receive data as
/// arguments; the document's own scripts are disabled.
enum PageScript {
    @MainActor static var world: WKContentWorld { .world(name: "markdown-reader") }

    static let capturePosition = """
    const blocks = document.querySelectorAll('[data-key]');
    const root = document.scrollingElement || document.documentElement;
    const ratio = root.scrollHeight > root.clientHeight ? root.scrollTop / (root.scrollHeight - root.clientHeight) : 0;
    let lo = 0, hi = blocks.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].getBoundingClientRect().bottom > 0) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    if (found < 0) return { key: null, fraction: 0, anchor: null, ratio: ratio };
    const block = blocks[found];
    const rect = block.getBoundingClientRect();
    const fraction = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
    let anchor = null;
    const headings = document.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]');
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= 1) { anchor = heading.id; } else { break; }
    }
    return { key: block.dataset.key, fraction: fraction, anchor: anchor, ratio: ratio };
    """

    /// Returns "block", "anchor" or "ratio" for the precision it achieved.
    static let restorePosition = """
    const root = document.scrollingElement || document.documentElement;
    if (key) {
      const block = document.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (block) {
        const rect = block.getBoundingClientRect();
        window.scrollTo(0, rect.top + window.scrollY + fraction * rect.height);
        return "block";
      }
    }
    if (anchor) {
      const heading = document.getElementById(anchor);
      if (heading) { heading.scrollIntoView({ block: "start" }); return "anchor"; }
    }
    window.scrollTo(0, ratio * Math.max(0, root.scrollHeight - root.clientHeight));
    return "ratio";
    """

    static let scrollToAnchor = """
    const element = document.getElementById(anchor);
    if (!element) return false;
    element.scrollIntoView({ block: "start" });
    return true;
    """

    static let find = """
    return window.find(query, false, backwards, true, false, false, false);
    """

    static let selectionText = "return String(window.getSelection());"

    static let viewportMetrics = """
    const root = document.scrollingElement || document.documentElement;
    return {scrollY: window.scrollY, documentHeight: root.scrollHeight};
    """

    static let configureViewport = """
    document.documentElement.dataset.ts = String(textSize);
    document.documentElement.dataset.wrap = wrap ? "1" : "0";
    if (background) document.documentElement.style.setProperty('--background', background);
    else document.documentElement.style.removeProperty('--background');
    // Disable scroll animation for deterministic viewport requests.
    document.documentElement.style.scrollBehavior = 'auto';
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
    return document.documentElement.getBoundingClientRect().height;
    """

    static let applySettings = """
    document.documentElement.dataset.ts = String(textSize);
    document.documentElement.dataset.wrap = wrap ? "1" : "0";
    return true;
    """
}

@MainActor
enum ReaderPageFactory {
    static func make(router: NavigationRouter, assets: AssetTable) -> WebPage {
        var configuration = WebPage.Configuration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultNavigationPreferences.allowsContentJavaScript = false
        configuration.urlSchemeHandlers[URLScheme(MarkdownRenderer.assetScheme)!] = AssetSchemeHandler(table: assets)
        configuration.upgradeKnownHostsToHTTPS = false
        let page = WebPage(configuration: configuration, navigationDecider: ReaderNavigationDecider(router: router))
        page.isInspectable = false
        return page
    }
}
