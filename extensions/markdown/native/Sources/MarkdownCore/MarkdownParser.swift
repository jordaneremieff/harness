import Foundation
import cmark_gfm
import cmark_gfm_extensions

/// The one parser configuration of the reader and of the reference inventory: CommonMark with
/// the GFM table, strikethrough, autolink and task list extensions, and footnotes.
struct MarkdownParser {
    static let options = CMARK_OPT_FOOTNOTES
    static let extensions = ["table", "strikethrough", "autolink", "tasklist"]

    let parser: UnsafeMutablePointer<cmark_parser>
    let document: UnsafeMutablePointer<cmark_node>

    static func parse(_ bytes: [UInt8]) -> MarkdownParser? {
        cmark_gfm_core_extensions_ensure_registered()
        guard let parser = cmark_parser_new(options) else { return nil }
        for name in extensions {
            if let ext = cmark_find_syntax_extension(name) { cmark_parser_attach_syntax_extension(parser, ext) }
        }
        bytes.withUnsafeBufferPointer { buffer in
            buffer.withMemoryRebound(to: CChar.self) { chars in
                if let base = chars.baseAddress { cmark_parser_feed(parser, base, chars.count) }
            }
        }
        guard let document = cmark_parser_finish(parser) else {
            cmark_parser_free(parser)
            return nil
        }
        return MarkdownParser(parser: parser, document: document)
    }

    func free() {
        cmark_node_free(document)
        cmark_parser_free(parser)
    }
}

/// Image and link destinations exactly as the parser reports them, in document order and without
/// duplicates. Publication classifies these; the reader classifies the same destinations itself.
public struct ReferenceInventoryScan: Codable, Sendable, Equatable {
    public static let listLimit = 4096

    public var version = 1
    public var images: [String]
    public var links: [String]
    public var truncated: Bool

    public static func scan(_ source: String) -> ReferenceInventoryScan? {
        let (_, body) = MarkdownRenderer.splitFrontMatter(source)
        guard let parsed = MarkdownParser.parse(Array(body.utf8)) else { return nil }
        defer { parsed.free() }
        guard let iterator = cmark_iter_new(parsed.document) else { return nil }
        defer { cmark_iter_free(iterator) }
        var images = OrderedSet()
        var links = OrderedSet()
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iterator) else { continue }
            let type = cmark_node_get_type(node)
            if type == CMARK_NODE_IMAGE {
                images.insert(MarkdownRenderer.string(cmark_node_get_url(node)))
            } else if type == CMARK_NODE_LINK {
                links.insert(MarkdownRenderer.string(cmark_node_get_url(node)))
            }
        }
        return ReferenceInventoryScan(
            images: images.values,
            links: links.values,
            truncated: images.overflowed || links.overflowed
        )
    }

    struct OrderedSet {
        var values: [String] = []
        var seen: Set<String> = []
        var overflowed = false

        mutating func insert(_ value: String) {
            guard !seen.contains(value) else { return }
            guard values.count < ReferenceInventoryScan.listLimit else {
                overflowed = true
                return
            }
            seen.insert(value)
            values.append(value)
        }
    }
}
