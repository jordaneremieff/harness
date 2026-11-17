import AppKit
import Foundation
import MarkdownCore
import WebKit

/// Local images the current rendering may load, by token. The scheme handler serves nothing else.
final class AssetTable: @unchecked Sendable {
    private let lock = NSLock()
    private var assets: [String: ResolvedAsset] = [:]
    private var refusedCount = 0
    private var servedCount = 0
    private var servedTokens: Set<String> = []
    private var failures: [String: String] = [:]

    func replace(_ assets: [String: ResolvedAsset]) {
        lock.withLock {
            self.assets = assets
            servedTokens = []
            failures = [:]
        }
    }

    func update(_ assets: [String: ResolvedAsset]) {
        lock.withLock {
            let unchanged = Set(assets.keys.filter { self.assets[$0] == assets[$0] })
            servedTokens.formIntersection(unchanged)
            failures = failures.filter { unchanged.contains($0.key) }
            self.assets = assets
        }
    }

    func asset(_ token: String) -> ResolvedAsset? {
        lock.withLock { assets[token] }
    }

    func noteRefused() { lock.withLock { refusedCount += 1 } }
    func noteServed(_ token: String) { lock.withLock { _ = servedTokens.insert(token); failures[token] = nil } }
    func noteFailure(_ token: String, _ reason: String) { lock.withLock { failures[token] = reason } }
    func evidence(_ token: String) -> (served: Bool, failure: String?) {
        lock.withLock { (servedTokens.contains(token), failures[token]) }
    }
    func noteServed() { lock.withLock { servedCount += 1 } }
    var refused: Int { lock.withLock { refusedCount } }
    var served: Int { lock.withLock { servedCount } }
}

/// Serves only the assets of the current document and its overlays.
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    let table: AssetTable

    init(table: AssetTable) { self.table = table }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        do {
            guard let url = urlSchemeTask.request.url else { throw URLError(.badURL) }
            let (data, mediaType) = try Self.content(for: url, table: table)
            let response = URLResponse(url: url, mimeType: mediaType, expectedContentLength: data.count, textEncodingName: nil)
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
            table.noteServed()
        } catch {
            table.noteRefused()
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

    static func content(for url: URL, table: AssetTable) throws -> (Data, String) {
        let path = url.path
        switch url.host {
        case "doc":
            let token = String(path.dropFirst())
            guard let asset = table.asset(token) else { throw URLError(.fileDoesNotExist) }
            do {
                let data = try asset.readData()
                table.noteServed(token)
                return (data, asset.mediaType)
            } catch {
                table.noteFailure(token, String(describing: error))
                throw error
            }
        default:
            throw URLError(.unsupportedURL)
        }
    }
}

/// The decision for a navigation the page asked for.
enum NavigationRequest {
    case documentLoad
    case sameDocument(anchor: String)
    case copyCode(nonce: String, index: Int)
    case inspectImage(nonce: String, index: Int)
    case external(URL)
    case blocked(URL?)

    static func classify(_ url: URL?, expectingLoad: Bool) -> NavigationRequest {
        guard let url else { return .blocked(nil) }
        let scheme = url.scheme?.lowercased() ?? ""
        switch scheme {
        case "reader-app":
            return expectingLoad && url.host == "app" && url.path == "/index.html" ? .documentLoad : .blocked(url)
        case MarkdownRenderer.actionScheme:
            let action = url.absoluteString.dropFirst(scheme.count + 1)
            if action.hasPrefix("jump/") {
                let anchor = String(action.dropFirst(5))
                return .sameDocument(anchor: anchor.removingPercentEncoding ?? anchor)
            }
            let parts = action.split(separator: "/")
            if parts.count == 3, parts[0] == "copy-code", let index = Int(parts[2]) {
                return .copyCode(nonce: String(parts[1]), index: index)
            }
            if parts.count == 3, parts[0] == "inspect-image", let index = Int(parts[2]) {
                return .inspectImage(nonce: String(parts[1]), index: index)
            }
            return .blocked(url)
        case "http", "https":
            return .external(url)
        default:
            return .blocked(url)
        }
    }
}


/// Native DOM queries use the same page world as the reader interface.
enum PageScript {
    @MainActor static let world = WKContentWorld.page

    static let capturePosition = """
    const blocks = document.querySelectorAll('[data-block]');
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
    return { key: block.dataset.block, blockStart: Number(block.dataset.start), offsetY: -rect.top, fraction: fraction, anchor: anchor, ratio: ratio };
    """

    /// Returns "block", "anchor" or "ratio" for the precision it achieved.
    static let restorePosition = """
    const root = document.scrollingElement || document.documentElement;
    if (key) {
      const block = document.querySelector('[data-block="' + CSS.escape(key) + '"]');
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

    static let activeSection = """
    const headings = document.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]');
    let active = headings.length ? headings[0].id : null;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= 32) { active = heading.id; } else { break; }
    }
    return active;
    """

    static let selectionText = "return String(window.getSelection());"

}

@MainActor
enum ReaderPageFactory {
    static func make(assets: AssetTable, root: URL? = nil) -> ReaderWebPage {
        ReaderWebPage(root: root ?? Bundle.main.resourceURL!.appendingPathComponent("web"), assets: assets)
    }
}
