import Foundation

/// Reading settings that the page applies through attributes on its root element, so that a
/// change needs no new rendering.
public struct PageSettings: Sendable, Equatable, Codable {
    public static let textSizes = [13, 14, 15, 16, 17, 18, 20, 22, 24, 27]
    public static let defaultTextSize = 4

    public var textSize: Int
    public var wrapCode: Bool

    public init(textSize: Int = PageSettings.defaultTextSize, wrapCode: Bool = false) {
        self.textSize = min(max(textSize, 0), PageSettings.textSizes.count - 1)
        self.wrapCode = wrapCode
    }
}

/// The HTML page around a rendered body: a strict content policy, the bundled stylesheet and no
/// script. Content JavaScript is also disabled in the web view; the policy is a second layer.
public enum PageTemplate {
    public static let stylesheetAddress = "\(MarkdownRenderer.assetScheme)://app/reader.css"
    public static let contentSecurityPolicy =
        "default-src 'none'; style-src \(MarkdownRenderer.assetScheme):; img-src \(MarkdownRenderer.assetScheme): data:; "
        + "font-src \(MarkdownRenderer.assetScheme):; base-uri 'none'; form-action 'none'"

    public static func page(body: String, title: String, settings: PageSettings, extraHead: String = "") -> String {
        """
        <!doctype html>
        <html data-ts="\(settings.textSize)" data-wrap="\(settings.wrapCode ? 1 : 0)">
        <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy)">
        <meta name="color-scheme" content="light dark">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(MarkdownRenderer.escape(title))</title>
        <link rel="stylesheet" href="\(stylesheetAddress)">
        \(extraHead)
        </head>
        <body><main class="doc">
        \(body)
        </main></body>
        </html>
        """
    }

    /// The exact source as escaped text, for Show Source.
    public static func sourcePage(source: String, title: String, settings: PageSettings) -> String {
        page(body: "<pre class=\"source\" aria-label=\"Markdown source\"><code>\(MarkdownRenderer.escape(source))</code></pre>", title: title, settings: settings)
    }
}
