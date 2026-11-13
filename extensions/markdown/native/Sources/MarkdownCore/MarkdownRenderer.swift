import Foundation
import cmark_gfm
import cmark_gfm_extensions

public struct OutlineEntry: Sendable, Equatable, Identifiable, Hashable {
    /// Anchor of the heading element; unique within one rendering.
    public var id: String
    public var level: Int
    public var title: String
}

public struct CodeBlock: Sendable, Equatable {
    public var info: String
    /// Parsed code without the final line break; uniformly CRLF sources retain CRLF internally.
    public var literal: String
}

/// HTML derived from one Markdown source. The source stays the record; this is presentation.
public struct RenderedDocument: Sendable {
    public var body: String
    public var outline: [OutlineEntry]
    public var codeBlocks: [CodeBlock]
    /// Local images by the token used in their `reader-asset://doc/<token>` address.
    public var assets: [String: ResolvedAsset]
    public var externalImages: [URL]
    public var embeddedImages: Int
    /// Links to relative paths or `file:` addresses, which only exist on the producing machine.
    public var localOnlyLinks: Int
    public var unavailableImages: [(reference: String, reason: String)]
    public var rawHTMLFragments: Int
    /// Number of top-level blocks that carry a position key.
    public var blockCount: Int
    /// Text of the first block: a heading's text, or the first line of any other block.
    public var leadingText: String?
    public var startsWithHeading: Bool
    /// Per-rendering secret that app-owned action links carry.
    public var nonce: String

    /// A title taken from the content: the heading that opens the document, else the first text
    /// line of the first block, shortened to 80 characters.
    public var contentTitle: String? {
        guard let text = leadingText?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        return text.count > 80 ? String(text.prefix(79)) + "…" : text
    }

    /// True when every image is retained or embedded and no link points at a local path.
    public var selfContained: Bool {
        externalImages.isEmpty && unavailableImages.isEmpty && localOnlyLinks == 0
    }
}

/// Renders Markdown through cmark-gfm (CommonMark plus tables, strikethrough, autolinks and task
/// lists) with its safe HTML output, after substituting the nodes the reader presents itself:
/// raw HTML becomes escaped literal text, links outside the web become inert text, images resolve
/// through an `AssetResolving` or become a visible placeholder, code blocks gain a label and a copy
/// action, headings gain unique anchors and every top-level block gains a position key.
public enum MarkdownRenderer {
    typealias Node = UnsafeMutablePointer<cmark_node>

    public static let actionScheme = "reader-action"
    public static let assetScheme = "reader-asset"

    public static func render(_ source: String, resolver: AssetResolving, nonce: String = newNonce()) -> RenderedDocument {
        let withoutCRLF = source.replacingOccurrences(of: "\r\n", with: "")
        let codeLineEnding = source.contains("\r\n") && !withoutCRLF.contains("\r") && !withoutCRLF.contains("\n") ? "\r\n" : "\n"
        var context = Context(resolver: resolver, nonce: nonce, codeLineEnding: codeLineEnding)
        let (frontMatter, body) = splitFrontMatter(source)
        var html = ""
        if let frontMatter {
            context.codeBlocks.append(CodeBlock(info: "front matter", literal: frontMatter.replacingOccurrences(of: "\n", with: codeLineEnding)))
            html += "<div class=\"blk\" data-key=\"front-matter\">"
                + codeFigure(index: 0, label: "Front matter", literal: frontMatter, nonce: nonce)
                + "</div>\n"
        }
        html += renderBody(body, context: &context)
        return RenderedDocument(
            body: html,
            outline: context.outline,
            codeBlocks: context.codeBlocks,
            assets: context.assets,
            externalImages: context.externalImages,
            embeddedImages: context.embeddedImages,
            localOnlyLinks: context.localOnlyLinks,
            unavailableImages: context.unavailableImages,
            rawHTMLFragments: context.rawHTML,
            blockCount: context.blockCount,
            leadingText: context.leadingBlock?.text,
            startsWithHeading: context.leadingBlock?.isHeading ?? false,
            nonce: nonce
        )
    }

    public static func newNonce() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    // MARK: - Parsing and substitution

    struct Context {
        let resolver: AssetResolving
        let nonce: String
        let codeLineEnding: String
        var outline: [OutlineEntry] = []
        var usedAnchors: Set<String> = []
        /// The next numeric suffix to try for each anchor base.
        var nextSuffix: [String: Int] = [:]
        var codeBlocks: [CodeBlock] = []
        var assets: [String: ResolvedAsset] = [:]
        var externalImages: [URL] = []
        var embeddedImages = 0
        var localOnlyLinks = 0
        var unavailableImages: [(reference: String, reason: String)] = []
        var rawHTML = 0
        var blockCount = 0
        var leadingBlock: (text: String, isHeading: Bool)?

        init(resolver: AssetResolving, nonce: String, codeLineEnding: String) {
            self.resolver = resolver
            self.nonce = nonce
            self.codeLineEnding = codeLineEnding
        }
    }

    enum Work {
        case heading(Node, level: Int, anchor: String)
        case code(Node, index: Int)
        case htmlBlock(Node)
        case htmlInline(Node)
        case link(Node)
        case image(Node, html: String)
        /// A table cell that holds a sentence.
        case proseCell(Node)
    }

    /// A table cell with at least this many characters of text holds a sentence and keeps a
    /// minimum width. A shorter cell stays as narrow as its words allow.
    static let proseCellCharacters = 40

    static func renderBody(_ body: String, context: inout Context) -> String {
        let bytes = Array(body.utf8)
        guard let parsed = MarkdownParser.parse(bytes) else { return escapedFallback(body) }
        defer { parsed.free() }
        wrapTopLevelBlocks(parsed.document, bytes: bytes, context: &context)
        let work = collect(parsed.document, context: &context)
        for item in work.reversed() {
            apply(item, context: &context)
        }
        guard let rendered = cmark_render_html(parsed.document, MarkdownParser.options, cmark_parser_get_syntax_extensions(parsed.parser)) else {
            return escapedFallback(body)
        }
        defer { free(rendered) }
        return String(cString: rendered)
    }

    /// Wraps each top-level block in an element with a key derived from its source text and its
    /// occurrence, so that a later revision can find the same block again.
    static func wrapTopLevelBlocks(_ document: Node, bytes: [UInt8], context: inout Context) {
        var lineStarts = [0]
        for (offset, byte) in bytes.enumerated() where byte == 0x0A {
            lineStarts.append(offset + 1)
        }
        var occurrences: [UInt64: Int] = [:]
        var node = cmark_node_first_child(document)
        while let current = node {
            node = cmark_node_next(current)
            if cmark_node_get_type(current) == CMARK_NODE_FOOTNOTE_DEFINITION { continue }
            if context.leadingBlock == nil { context.leadingBlock = leadingText(current) }
            let start = max(1, Int(cmark_node_get_start_line(current)))
            let end = max(start, Int(cmark_node_get_end_line(current)))
            let from = lineStarts[min(start - 1, lineStarts.count - 1)]
            let to = end < lineStarts.count ? lineStarts[end] : bytes.count
            let hash = fnv1a(bytes[from..<max(from, to)])
            let occurrence = occurrences[hash, default: 0]
            occurrences[hash] = occurrence + 1
            let key = String(format: "b%016llx-%d", hash, occurrence)
            guard let wrapper = cmark_node_new(CMARK_NODE_CUSTOM_BLOCK) else { continue }
            cmark_node_set_on_enter(wrapper, "<div class=\"blk\" data-key=\"\(key)\">")
            cmark_node_set_on_exit(wrapper, "</div>")
            cmark_node_insert_before(current, wrapper)
            cmark_node_unlink(current)
            cmark_node_append_child(wrapper, current)
            context.blockCount += 1
        }
    }

    /// Hash of a block's text with surrounding whitespace removed.
    static func fnv1a(_ slice: ArraySlice<UInt8>) -> UInt64 {
        var lower = slice.startIndex
        var upper = slice.endIndex
        while lower < upper, [0x20, 0x09, 0x0A, 0x0D].contains(slice[lower]) { lower += 1 }
        while upper > lower, [0x20, 0x09, 0x0A, 0x0D].contains(slice[upper - 1]) { upper -= 1 }
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in slice[lower..<upper] {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return hash
    }

    /// Collects the nodes to substitute in document order. Content inside an image is its
    /// alternative text and is not substituted separately.
    static func collect(_ document: Node, context: inout Context) -> [Work] {
        var work: [Work] = []
        guard let iterator = cmark_iter_new(document) else { return work }
        defer { cmark_iter_free(iterator) }
        var imageDepth = 0
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard let node = cmark_iter_get_node(iterator) else { continue }
            let type = cmark_node_get_type(node)
            if type == CMARK_NODE_IMAGE {
                if event == CMARK_EVENT_ENTER {
                    if imageDepth == 0 {
                        let html = imageHTML(reference: string(cmark_node_get_url(node)), alt: plainText(node), title: string(cmark_node_get_title(node)), context: &context)
                        work.append(.image(node, html: html))
                    }
                    imageDepth += 1
                } else {
                    imageDepth -= 1
                }
                continue
            }
            guard event == CMARK_EVENT_ENTER, imageDepth == 0 else { continue }
            if strcmp(cmark_node_get_type_string(node), "table_cell") == 0, plainText(node).count >= proseCellCharacters {
                work.append(.proseCell(node))
            }
            switch type {
            case CMARK_NODE_HEADING:
                let title = plainText(node)
                let anchor = uniqueAnchor(for: title, context: &context)
                let level = Int(cmark_node_get_heading_level(node))
                context.outline.append(OutlineEntry(id: anchor, level: level, title: title.isEmpty ? "Untitled section" : title))
                work.append(.heading(node, level: level, anchor: anchor))
            case CMARK_NODE_CODE_BLOCK:
                var literal = string(cmark_node_get_literal(node))
                if literal.hasSuffix("\n") { literal.removeLast() }
                literal = literal.replacingOccurrences(of: "\n", with: context.codeLineEnding)
                context.codeBlocks.append(CodeBlock(info: string(cmark_node_get_fence_info(node)), literal: literal))
                work.append(.code(node, index: context.codeBlocks.count - 1))
            case CMARK_NODE_HTML_BLOCK:
                work.append(.htmlBlock(node))
            case CMARK_NODE_HTML_INLINE:
                work.append(.htmlInline(node))
            case CMARK_NODE_LINK:
                work.append(.link(node))
            default:
                break
            }
        }
        return work
    }

    static func apply(_ item: Work, context: inout Context) {
        switch item {
        case .heading(let node, let level, let anchor):
            replace(node, block: true, enter: "<h\(level) id=\"\(anchor)\">", exit: "</h\(level)>", keepChildren: true)
        case .code(let node, let index):
            let block = context.codeBlocks[index]
            let label = block.info.split(whereSeparator: { $0 == " " || $0 == "\t" }).first.map(String.init) ?? ""
            replace(node, block: true, enter: codeFigure(index: index, label: label.isEmpty ? "code" : label, literal: block.literal, nonce: context.nonce), exit: "", keepChildren: false)
        case .htmlBlock(let node):
            context.rawHTML += 1
            var literal = string(cmark_node_get_literal(node))
            while literal.hasSuffix("\n") { literal.removeLast() }
            let html = "<div class=\"raw-html\" role=\"note\"><div class=\"raw-label\">HTML shown as text</div><pre><code>\(escape(literal))</code></pre></div>"
            replace(node, block: true, enter: html, exit: "", keepChildren: false)
        case .htmlInline(let node):
            context.rawHTML += 1
            let html = "<code class=\"raw-inline\" title=\"HTML shown as text\">\(escape(string(cmark_node_get_literal(node))))</code>"
            replace(node, block: false, enter: html, exit: "", keepChildren: false)
        case .link(let node):
            let url = string(cmark_node_get_url(node))
            let title = string(cmark_node_get_title(node))
            if url.hasPrefix("#") {
                let fragment = String(url.dropFirst())
                replace(node, block: false, enter: "<a class=\"anchor-link\" href=\"#\(escape(fragment))\"\(titleAttribute(title))>", exit: "</a>", keepChildren: true)
            } else if let web = References.webURL(url) {
                let hint = title.isEmpty ? web.absoluteString : title
                replace(node, block: false, enter: "<a class=\"ext\" href=\"\(escape(web.absoluteString))\" title=\"\(escape(hint))\">", exit: "</a>", keepChildren: true)
            } else {
                if !url.isEmpty, !url.lowercased().hasPrefix("mailto:"), !References.hasScheme(url) || url.lowercased().hasPrefix("file:") {
                    context.localOnlyLinks += 1
                }
                let hint = url.isEmpty ? "Empty link" : "Not opened by the reader: \(url)"
                replace(node, block: false, enter: "<span class=\"inert-link\" title=\"\(escape(hint))\">", exit: "</span>", keepChildren: true)
            }
        case .image(let node, let html):
            replace(node, block: false, enter: html, exit: "", keepChildren: false)
        case .proseCell(let node):
            // A cell admits an attribute node, which renders its children; the span carries the width.
            guard let wrapper = cmark_node_new(CMARK_NODE_ATTRIBUTE) else { return }
            guard let content = cmark_node_new(CMARK_NODE_CUSTOM_INLINE) else {
                cmark_node_free(wrapper)
                return
            }
            cmark_node_set_on_enter(content, "<span class=\"cell-prose\">")
            cmark_node_set_on_exit(content, "</span>")
            cmark_node_append_child(wrapper, content)
            guard cmark_node_append_child(node, wrapper) == 1 else {
                cmark_node_free(wrapper)
                return
            }
            while let child = cmark_node_first_child(node), child != wrapper {
                cmark_node_unlink(child)
                cmark_node_append_child(content, child)
            }
        }
    }

    static func imageHTML(reference: String, alt: String, title: String, context: inout Context) -> String {
        let shownAlt = alt.isEmpty ? "" : "<span class=\"ph-alt\">\(escape(alt))</span>"
        switch context.resolver.resolve(reference) {
        case .local(let asset):
            let token = "a\(context.assets.count)"
            context.assets[token] = asset
            return "<img src=\"\(assetScheme)://doc/\(token)\" alt=\"\(escape(alt))\"\(titleAttribute(title)) decoding=\"async\">"
        case .embedded(let address):
            context.embeddedImages += 1
            return "<img src=\"\(escape(address))\" alt=\"\(escape(alt))\"\(titleAttribute(title))>"
        case .external(let url):
            context.externalImages.append(url)
            let host = url.host ?? url.absoluteString
            return "<span class=\"img-ph remote\" role=\"img\" aria-label=\"Remote image not loaded: \(escape(alt.isEmpty ? host : alt))\">"
                + "<span class=\"ph-kind\">Remote image not loaded</span>"
                + "<a class=\"ext\" href=\"\(escape(url.absoluteString))\" title=\"\(escape(url.absoluteString))\">\(escape(host))</a>"
                + shownAlt + "</span>"
        case .unavailable(let reason):
            context.unavailableImages.append((reference, reason))
            return "<span class=\"img-ph unavailable\" role=\"img\" aria-label=\"Image unavailable: \(escape(alt.isEmpty ? reference : alt))\">"
                + "<span class=\"ph-kind\">Image unavailable (\(escape(reasonLabel(reason))))</span>"
                + shownAlt + "<code>\(escape(reference))</code></span>"
        }
    }

    public static func reasonLabel(_ reason: String) -> String {
        switch reason {
        case "outside-root": "outside the document folder"
        case "missing": "file missing"
        case "too-large": "too large"
        case "unsupported-type": "unsupported type"
        case "unsupported-scheme": "unsupported address"
        case "no-base": "no folder to resolve it against"
        case "not-captured": "not retained with the document"
        case "limit": "asset limit reached"
        default: reason
        }
    }

    static func codeFigure(index: Int, label: String, literal: String, nonce: String) -> String {
        "<figure class=\"code\" data-code=\"\(index)\"><figcaption><span class=\"lang\">\(escape(label))</span>"
            + "<a class=\"copy\" href=\"\(actionScheme):copy-code/\(nonce)/\(index)\" title=\"Copy code\" aria-label=\"Copy code\">Copy</a>"
            + "</figcaption><pre><code>\(escape(literal))</code></pre></figure>"
    }

    /// Replaces a node with custom HTML. With `keepChildren`, the node's children move into the
    /// replacement and are rendered between `enter` and `exit`.
    static func replace(_ node: Node, block: Bool, enter: String, exit: String, keepChildren: Bool) {
        guard let custom = cmark_node_new(block ? CMARK_NODE_CUSTOM_BLOCK : CMARK_NODE_CUSTOM_INLINE) else { return }
        cmark_node_set_on_enter(custom, enter)
        cmark_node_set_on_exit(custom, exit)
        // Table cells reject custom inlines but admit attribute nodes, which render their children.
        // Insert before moving children so that a refused replacement leaves the original intact.
        if cmark_node_insert_before(node, custom) == 0 {
            guard !block, let wrapper = cmark_node_new(CMARK_NODE_ATTRIBUTE) else {
                cmark_node_free(custom)
                return
            }
            guard cmark_node_append_child(wrapper, custom) == 1 else {
                cmark_node_free(wrapper)
                cmark_node_free(custom)
                return
            }
            guard cmark_node_insert_before(node, wrapper) == 1 else {
                cmark_node_free(wrapper)
                return
            }
        }
        if keepChildren {
            while let child = cmark_node_first_child(node) {
                cmark_node_unlink(child)
                cmark_node_append_child(custom, child)
            }
        }
        cmark_node_unlink(node)
        cmark_node_free(node)
    }

    /// The first line of a block's text; a heading keeps its whole text.
    static func leadingText(_ node: Node) -> (text: String, isHeading: Bool)? {
        let type = cmark_node_get_type(node)
        let text: String
        if type == CMARK_NODE_CODE_BLOCK || type == CMARK_NODE_HTML_BLOCK {
            text = string(cmark_node_get_literal(node))
        } else if type == CMARK_NODE_THEMATIC_BREAK {
            return nil
        } else {
            text = blockLines(node)
        }
        guard let line = text.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) else { return nil }
        return (line, type == CMARK_NODE_HEADING)
    }

    /// Plain text with line breaks kept at soft and hard breaks and between blocks.
    static func blockLines(_ node: Node) -> String {
        var text = ""
        guard let iterator = cmark_iter_new(node) else { return text }
        defer { cmark_iter_free(iterator) }
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard let child = cmark_iter_get_node(iterator) else { continue }
            let type = cmark_node_get_type(child)
            if event == CMARK_EVENT_ENTER, type == CMARK_NODE_TEXT || type == CMARK_NODE_CODE || type == CMARK_NODE_HTML_INLINE {
                text += string(cmark_node_get_literal(child))
            } else if event == CMARK_EVENT_ENTER, type == CMARK_NODE_SOFTBREAK || type == CMARK_NODE_LINEBREAK {
                text += "\n"
            } else if event == CMARK_EVENT_EXIT, type == CMARK_NODE_PARAGRAPH || type == CMARK_NODE_HEADING {
                text += "\n"
            }
        }
        return text
    }

    static func plainText(_ node: Node) -> String {
        var text = ""
        guard let iterator = cmark_iter_new(node) else { return text }
        defer { cmark_iter_free(iterator) }
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let child = cmark_iter_get_node(iterator) else { continue }
            let type = cmark_node_get_type(child)
            if type == CMARK_NODE_TEXT || type == CMARK_NODE_CODE || type == CMARK_NODE_HTML_INLINE {
                text += string(cmark_node_get_literal(child))
            } else if type == CMARK_NODE_SOFTBREAK || type == CMARK_NODE_LINEBREAK {
                text += " "
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A GitHub-style anchor: lowercase letters, digits, hyphens and underscores; repeats get a
    /// numeric suffix. Anchors that footnotes use are never produced. Each base keeps its next
    /// suffix, so a suffix is tried at most once per base and the work stays linear.
    static func uniqueAnchor(for title: String, context: inout Context) -> String {
        var slug = ""
        for character in title.lowercased() {
            if character.isLetter || character.isNumber || character == "_" || character == "-" {
                slug.append(character)
            } else if character == " " {
                slug.append("-")
            }
        }
        if slug.isEmpty { slug = "section" }
        if slug.hasPrefix("fn-") || slug.hasPrefix("fnref-") { slug = "h-" + slug }
        var candidate = slug
        if context.usedAnchors.contains(candidate) {
            var suffix = context.nextSuffix[slug, default: 1]
            repeat {
                candidate = "\(slug)-\(suffix)"
                suffix += 1
            } while context.usedAnchors.contains(candidate)
            context.nextSuffix[slug] = suffix
        }
        context.usedAnchors.insert(candidate)
        return candidate
    }

    /// A leading YAML front matter block, shown as a labelled code block instead of being parsed
    /// as a rule and a heading.
    static func splitFrontMatter(_ source: String) -> (String?, String) {
        guard source.hasPrefix("---\n") || source.hasPrefix("---\r\n") else { return (nil, source) }
        var lines = source.split(maxSplits: 400, omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" })
        guard lines.count > 2 else { return (nil, source) }
        lines.removeFirst()
        var front: [Substring] = []
        for (index, line) in lines.enumerated() where index < 399 {
            let trimmed = line.hasSuffix("\r") ? line.dropLast() : line
            if trimmed == "---" || trimmed == "..." {
                guard !front.isEmpty else { return (nil, source) }
                let rest = lines.dropFirst(index + 1).joined(separator: "\n")
                return (front.map { $0.hasSuffix("\r") ? String($0.dropLast()) : String($0) }.joined(separator: "\n"), rest)
            }
            front.append(line)
        }
        return (nil, source)
    }

    static func escapedFallback(_ source: String) -> String {
        "<pre class=\"source\">\(escape(source))</pre>"
    }

    static func titleAttribute(_ title: String) -> String {
        title.isEmpty ? "" : " title=\"\(escape(title))\""
    }

    static func string(_ pointer: UnsafePointer<CChar>?) -> String {
        pointer.map { String(cString: $0) } ?? ""
    }

    public static func escape(_ text: String) -> String {
        var result = ""
        result.reserveCapacity(text.utf8.count)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "&": result += "&amp;"
            case "<": result += "&lt;"
            case ">": result += "&gt;"
            case "\"": result += "&quot;"
            case "'": result += "&#39;"
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result
    }
}
