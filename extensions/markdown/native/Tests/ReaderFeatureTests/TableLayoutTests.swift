import Testing
import AppKit
import WebKit
@testable import MarkdownCore
@testable import ReaderFeature

private final class TableStyles: NSObject, WKURLSchemeHandler {
    private let assets = AssetTable()

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        do {
            guard let url = task.request.url else { throw URLError(.badURL) }
            let (data, type) = try AssetSchemeHandler.content(for: url, table: assets)
            task.didReceive(URLResponse(url: url, mimeType: type, expectedContentLength: data.count, textEncodingName: "utf-8"))
            task.didReceive(data)
            task.didFinish()
        } catch { task.didFailWithError(error) }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

@MainActor
private final class TableLoad: NSObject, WKNavigationDelegate {
    private var pending: CheckedContinuation<Void, any Error>?
    private var deadline: DispatchWorkItem?

    func load(_ html: String, in view: WKWebView) async throws {
        try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            let timeout = DispatchWorkItem { [weak self] in self?.finish(.failure(URLError(.timedOut))) }
            deadline = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
            view.loadHTMLString(html, baseURL: nil)
        }
    }

    private func finish(_ result: Result<Void, any Error>) {
        deadline?.cancel()
        deadline = nil
        let continuation = pending
        pending = nil
        continuation?.resume(with: result)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
}

@MainActor @Suite(.serialized) struct ResponsiveTables {
    @Test func cellsWrapAtTheExistingTextSizeWithoutHorizontalScrolling() async throws {
        let token = String(repeating: "long_identifier_", count: 8)
        let address = "https://example.org/" + String(repeating: "abcdefghij", count: 12)
        let source = """
        | Label | Description | Code | Reference | Unicode | Last |
        |:--|:--|:--|:--|:--|--:|
        | One | Several ordinary words describe the item and explain its complete purpose. | `\(token)` | \(address) | 日本語 é 🧭 | 123.45 |

        | A | B | C | D | E | F | G | H |
        |---|---|---|---|---|---|---|---|
        | first | second | third | fourth | fifth | sixth | seventh | final |
        """
        let rendered = MarkdownRenderer.render(source, resolver: NoAssetResolver(), nonce: "table-layout")
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.setURLSchemeHandler(TableStyles(), forURLScheme: MarkdownRenderer.assetScheme)
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 700), configuration: config)
        let load = TableLoad()
        view.navigationDelegate = load
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 600, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        defer { view.stopLoading(); window.close() }

        for size in [PageSettings.defaultTextSize, PageSettings.defaultTextSize + 2] {
            try await load.load(PageTemplate.page(body: rendered.body, title: "Tables", settings: PageSettings(textSize: size)), in: view)
            for width in [320.0, 600.0, 900.0, 320.0] {
                window.setContentSize(NSSize(width: width, height: 700))
                view.setFrameSize(NSSize(width: width, height: 700))
                view.layoutSubtreeIfNeeded()
                let measured = try #require(try await view.callAsyncJavaScript("""
                const tables = [...document.querySelectorAll('table')];
                const cells = tables.flatMap(t => [...t.querySelectorAll('th,td')]);
                const code = tables[0].querySelector('td code');
                const link = tables[0].querySelector('td a');
                const font = parseFloat(getComputedStyle(cells[0]).fontSize);
                const expectedFont = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.93;
                const fits = tables.every(t => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= innerWidth + 1);
                const cellsFit = cells.every(c => c.scrollWidth <= c.clientWidth + 1);
                const semantic = tables[0].rows[0].cells.length === 6 && tables[0].rows[1].cells.length === 6 && tables[1].rows[0].cells.length === 8 && tables[1].rows[1].cells.length === 8;
                const unchanged = code.textContent === token && link.textContent === address && tables[1].rows[1].cells[7].textContent.trim() === 'final';
                const wraps = code.getClientRects().length > 1 && getComputedStyle(code).whiteSpace === 'normal';
                const pageFits = document.scrollingElement.scrollWidth <= innerWidth + 1;
                const readable = Math.abs(font - expectedFont) < 0.1;
                return { pass: fits && cellsFit && semantic && unchanged && wraps && pageFits && readable && Math.abs(innerWidth - width) <= 1, detail: JSON.stringify({ width, viewport: innerWidth, font, fits, cellsFit, semantic, unchanged, wraps, pageFits, readable }) };
                """, arguments: ["token": token, "address": address, "width": width], in: nil, contentWorld: .defaultClient) as? [String: Any])
                #expect(measured["pass"] as? Bool == true, Comment(rawValue: "text \(size): \(measured["detail"] as? String ?? "no layout")"))
            }
        }
    }
}
