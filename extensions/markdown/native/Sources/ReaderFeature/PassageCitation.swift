import Foundation
import MarkdownCore

extension PageScript {
    /// The selection with what locates it. In the source view: the lines of the source that the
    /// selection covers, counted from 1. In the rendering: the positions of the first and last
    /// keyed block that hold selected text, and the number of keyed blocks. Null without a
    /// selection.
    static let selectionLocator = """
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const text = String(selection);
    const range = selection.getRangeAt(0);
    const source = document.querySelector('pre.source > code');
    if (source) {
      if (!source.contains(range.startContainer) || !source.contains(range.endContainer)) return { text: text, mode: "source" };
      const lead = document.createRange();
      lead.selectNodeContents(source);
      lead.setEnd(range.startContainer, range.startOffset);
      const before = lead.toString();
      const inside = range.toString();
      let from = 0, to = inside.length;
      while (from < to && inside.charCodeAt(from) === 10) from++;
      while (to > from && inside.charCodeAt(to - 1) === 10) to--;
      let startLine = 1;
      for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) startLine++;
      startLine += from;
      let endLine = startLine;
      for (let i = from; i < to; i++) if (inside.charCodeAt(i) === 10) endLine++;
      return { text: text, mode: "source", startLine: startLine, endLine: endLine };
    }
    const blocks = Array.from(document.querySelectorAll('.blk[data-key]'));
    const holdsText = (block) => {
      if (!range.intersectsNode(block)) return false;
      const part = range.cloneRange();
      if (!block.contains(part.startContainer)) part.setStart(block, 0);
      if (!block.contains(part.endContainer)) part.setEnd(block, block.childNodes.length);
      return part.toString().trim() !== "";
    };
    let first = -1, last = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (holdsText(blocks[i])) { if (first < 0) first = i; last = i; }
      else if (first >= 0 && !range.intersectsNode(blocks[i])) break;
    }
    return { text: text, mode: "rendered", first: first, last: last, count: blocks.length };
    """
}

/// The text that Copy Passage with Source puts on the pasteboard: the passage as selected,
/// then what identifies its document, revision and place.
enum PassageCitation {
    static func text(passage: String, snapshot: DocumentSnapshot, title: String, latestRevision: Int?, location: PassageLocation, sourceView: Bool) -> String {
        let exact = location.basis == .sourceText
        var lines = ["Passage from \"\(title)\" (\(exact ? "exact Markdown source text" : sourceView ? "text from the source view" : "rendered text")):", "", passage.trimmingCharacters(in: .newlines), "", "Reference:"]
        switch snapshot.reference {
        case .stored(_, _, let id):
            lines.append("Document: \(id)")
            if let revision = snapshot.revision {
                let latest = max(latestRevision ?? revision, revision)
                lines.append("Revision: \(revision)" + (latest > revision ? " (the newest known revision is \(latest))" : " (the newest known revision)"))
            }
        case .file(let path):
            lines.append("File: \(path)")
        }
        lines.append("Source digest: \(snapshot.digest)")
        if location.basis != .unlocated {
            lines.append("Section: \(location.headingPath.isEmpty ? "before the first heading" : location.headingPath.joined(separator: " › "))")
        }
        if let blocks = location.blocks {
            lines.append("Block: \(span(blocks)) of \(location.blockCount)")
        }
        lines.append("Source lines: \(sourceLines(location, sourceView: sourceView))")
        return lines.joined(separator: "\n") + "\n"
    }

    /// The source-line statement. It names lines only on the basis that established them.
    static func sourceLines(_ location: PassageLocation, sourceView: Bool) -> String {
        guard let lines = location.lines else {
            return "not established" + (sourceView ? "" : " (the passage is rendered text)")
        }
        switch location.basis {
        case .sourceText where sourceView:
            return "\(span(lines)) (exact: the passage is the source text on these lines)"
        case .sourceText:
            return "\(span(lines)) (exact: the passage occurs once in the Markdown of its block, on these lines)"
        case .renderedText, .unlocated:
            return "\(span(lines)) (the enclosing block\(location.blocks.map { $0.count > 1 ? "s" : "" } ?? ""); the passage is rendered text and its Markdown can differ)"
        }
    }

    /// What the notice says about the copied reference.
    static func notice(_ location: PassageLocation) -> String {
        switch (location.basis, location.lines) {
        case (.sourceText, let lines?): "Copied the passage with its reference: exact source line\(lines.count == 1 ? "" : "s") \(span(lines))."
        case (.renderedText, let lines?): "Copied the passage with its reference: rendered text within source line\(lines.count == 1 ? "" : "s") \(span(lines))."
        default: "Copied the passage with its reference. Its source lines are not established."
        }
    }

    private static func span(_ range: ClosedRange<Int>) -> String {
        range.count == 1 ? "\(range.lowerBound)" : "\(range.lowerBound)–\(range.upperBound)"
    }
}

extension ReaderModel {
    /// Copies the selected text with the document identity, the exact revision, the source
    /// digest and the best locator that the source establishes. Nothing is sent anywhere.
    public func copyPassageWithSource() async {
        guard let snapshot else { return }
        guard review.shown == nil else {
            post("Close the comparison to copy a passage of the document with its source.", kind: .info)
            return
        }
        let value = try? await page.callJavaScript(PageScript.selectionLocator, contentWorld: PageScript.world) as? [String: Any]
        guard let value, let passage = value["text"] as? String, !passage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            post("Select a passage first.", kind: .info)
            return
        }
        let sourceView = value["mode"] as? String == "source"
        let source = snapshot.source
        let location: PassageLocation
        if sourceView {
            let range = Self.range(value["startLine"], value["endLine"])
            location = await Task.detached { SourceStructure.scan(source).locate(sourceText: passage, lines: range) }.value
        } else {
            let range = Self.range(value["first"], value["last"])
            let count = (value["count"] as? Int) ?? -1
            location = await Task.detached { SourceStructure.scan(source).locate(renderedText: passage, renderedBlocks: range, renderedBlockCount: count) }.value
        }
        guard self.snapshot?.digest == snapshot.digest else {
            post("The document changed while the passage was copied. Select the passage again.", kind: .warning)
            return
        }
        platform.copyText(PassageCitation.text(passage: passage, snapshot: snapshot, title: displayTitle, latestRevision: latestRevision, location: location, sourceView: sourceView))
        post(PassageCitation.notice(location), kind: .info)
    }

    private static func range(_ lower: Any?, _ upper: Any?) -> ClosedRange<Int>? {
        guard let lower = lower as? Int, let upper = upper as? Int, lower >= 0, lower <= upper else { return nil }
        return lower...upper
    }
}
