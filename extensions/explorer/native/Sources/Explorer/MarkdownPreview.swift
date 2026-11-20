import Foundation
import cmark_gfm
import cmark_gfm_extensions

func isMarkdownPath(_ path: String) -> Bool {
    ["md", "markdown"].contains(URL(fileURLWithPath: path).pathExtension.lowercased())
}

func relativeMarkdownImage(_ destination: String, from path: String) -> String? {
    let reference = destination.prefix { $0 != "#" && $0 != "?" }
    guard let decoded = String(reference).removingPercentEncoding, !decoded.isEmpty,
          !decoded.hasPrefix("/"), !decoded.contains(":"), !decoded.contains("\\"),
          !decoded.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
    var parts = Array(path.split(separator: "/").dropLast())
    for part in decoded.split(separator: "/") {
        if part == "." { continue }
        if part == ".." {
            guard !parts.isEmpty else { return nil }
            parts.removeLast()
        } else {
            guard part.lowercased() != ".git" else { return nil }
            parts.append(part)
        }
    }
    let resolved = parts.joined(separator: "/")
    return validPath(resolved) ? resolved : nil
}

enum MarkdownPreview {
    private static let registered: Void = cmark_gfm_core_extensions_ensure_registered()

    static func html(_ text: String, image: (String) -> String?) -> String? {
        _ = registered
        let options = CMARK_OPT_SOURCEPOS
        guard let parser = cmark_parser_new(options) else { return nil }
        defer { cmark_parser_free(parser) }
        for name in ["table", "strikethrough", "autolink", "tagfilter", "tasklist"] {
            if let ext = cmark_find_syntax_extension(name) { cmark_parser_attach_syntax_extension(parser, ext) }
        }
        text.withCString { cmark_parser_feed(parser, $0, text.utf8.count) }
        guard let document = cmark_parser_finish(parser) else { return nil }
        defer { cmark_node_free(document) }
        guard let iterator = cmark_iter_new(document) else { return nil }
        defer { cmark_iter_free(iterator) }
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iterator),
                  cmark_node_get_type(node) == CMARK_NODE_IMAGE, let url = cmark_node_get_url(node) else { continue }
            cmark_node_set_url(node, image(String(cString: url)) ?? "")
        }
        guard let html = cmark_render_html(document, options, cmark_parser_get_syntax_extensions(parser)) else { return nil }
        defer { free(html) }
        guard strlen(html) <= 16 * mib else { return nil }
        return String(cString: html)
    }
}

extension Workspace {
    func renderMarkdown(_ path: String, at revision: String?) throws -> [String: Any] {
        guard isMarkdownPath(path) else { throw ExplorerError("invalid", "This file does not use Markdown preview.") }
        let at = revision.flatMap(checkedCommit)
        if revision != nil, at == nil { throw ExplorerError("invalid", "The revision is invalid.") }
        let file = try readFile(path, at: at)
        var result: [String: Any] = ["file": file]
        guard let text = file["text"] as? String else { return result }
        var assets: [String: String] = [:]
        result["html"] = MarkdownPreview.html(text) { reference in
            guard let relative = relativeMarkdownImage(reference, from: path) else { return nil }
            if let registered = assets[relative] { return registered }
            guard assets.count < 256 else { return nil }
            let registered = markdownImageURL(relative, at: at)
            assets[relative] = registered ?? ""
            return registered
        }
        return result
    }
}
