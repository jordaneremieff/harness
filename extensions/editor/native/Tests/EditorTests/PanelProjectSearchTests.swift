import Foundation
import Testing
@testable import Editor

struct PanelProjectSearchTests {
    @Test func searchAndReplaceUseTheSameScopeAndOptions() {
        let request = ProjectSearchRequest(query: "keep ", whereText: "src/, *.swift, -Tests/", regex: true,
                                           caseSensitive: false, wholeWord: true)
        let search = request.searchFields
        let replace = request.replaceFields(with: "")
        for fields in [search, replace] {
            #expect(fields["query"] as? String == "keep ")
            #expect(fields["include"] as? String == "src/, *.swift, -Tests/")
            #expect(fields["regex"] as? Bool == true)
            #expect(fields["caseSensitive"] as? Bool == false)
            #expect(fields["wholeWord"] as? Bool == true)
        }
        #expect(search["kind"] as? String == "text")
        #expect(search["contextLines"] as? Int == 1)
        #expect(replace["replacement"] as? String == "")
        #expect(replace["paths"] == nil)
    }

    @Test func resultsGroupByFileAndDoNotRepeatContextAcrossNearbyHits() throws {
        let first = try hit(path: "Docs/Start.md", line: 2, before: ["head"], after: ["second match"], draft: true)
        let again = try hit(path: first.path, line: 2, column: 2, before: ["head"], after: ["second match"], draft: true)
        let adjacent = try hit(path: first.path, line: 3, before: ["first match"], after: ["tail"], draft: true)
        let other = try hit(path: "src/main.swift", line: 1)
        #expect(ProjectSearchRow.grouped([first, again, adjacent, other]) == [
            .file(path: first.path, matches: 3, draft: true), .context(line: 1, text: "head"),
            .match(first), .match(again), .match(adjacent), .context(line: 4, text: "tail"),
            .file(path: other.path, matches: 1, draft: false), .match(other),
        ])
    }

    @Test func resultExcerptAndSourceSelectionUseUTF16() throws {
        let line = String(repeating: "🧪", count: 21) + "keep"
        let item = try hit(line: 2, column: 42, length: 4, text: line)
        let snippet = item.snippet
        let highlight = try #require(snippet.highlight)
        #expect(item.location == "2:43")
        #expect(snippet.text.hasPrefix("…"))
        #expect((snippet.text as NSString).substring(with: highlight) == "keep")
        #expect(item.selection(in: "é\n\(line)\nother" as NSString) == NSRange(location: 44, length: 4))
        #expect(item.selection(in: "é\nx\nother") == NSRange(location: 3, length: 0))
    }

    @Test func clippedLineHighlightsItsPreviewOnlyWithAnUnambiguousOrigin() throws {
        let prefix = String(repeating: "a", count: 1024)
        let window = String(repeating: "a", count: 40) + "keep next"
        let item = try hit(column: 1200, length: 4, text: prefix, preview: window)
        let snippet = item.snippet
        #expect((snippet.text as NSString).substring(with: try #require(snippet.highlight)) == "keep")
        let ambiguous = try hit(column: 1200, length: 4, text: prefix, preview: "🧪" + window)
        #expect(ambiguous.snippet.highlight == nil)
        #expect(ambiguous.snippet.text.hasSuffix("keep next"))
    }

    @Test func zeroLengthAndMultilineHitsKeepTheirSourcePosition() throws {
        let marker = try hit(line: 2, column: 0, length: 0, text: "foo")
        let multiline = try hit(line: 2, column: 2, length: 4, text: "foo")
        let source = "one\nfoo\n🧪\ntail" as NSString
        #expect(marker.selection(in: source) == NSRange(location: 4, length: 0))
        #expect(multiline.selection(in: source) == NSRange(location: 6, length: 4))
        #expect(multiline.snippet.highlight == NSRange(location: 2, length: 1))
    }

    private func hit(path: String = "note.md", line: Int = 1, column: Int = 0, length: Int = 1, text: String = "match",
                     preview: String? = nil, before: [String] = [], after: [String] = [], draft: Bool = false) throws -> ProjectSearchHit {
        try ProjectSearchHit(["path": path, "line": line, "column": column, "length": length, "text": text,
                              "preview": preview ?? text, "before": before, "after": after, "draft": draft])
    }
}
