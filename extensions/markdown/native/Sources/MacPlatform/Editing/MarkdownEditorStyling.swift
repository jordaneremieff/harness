import AppKit
import MarkdownCore

/// Immutable interval index; paragraph validation visits only overlapping semantic spans.
struct MarkdownSpanIndex: Sendable {
    let spans: [EditorSemanticSpan]
    let ordered: [Int]
    let maximumEnds: [Int]

    init(_ spans: [EditorSemanticSpan]) {
        self.spans = spans
        ordered = spans.indices.sorted {
            spans[$0].range.location == spans[$1].range.location ? $0 < $1 : spans[$0].range.location < spans[$1].range.location
        }
        var end = 0
        maximumEnds = ordered.map { index in
            end = max(end, NSMaxRange(spans[index].range))
            return end
        }
    }

    func overlapping(_ range: NSRange) -> [EditorSemanticSpan] {
        var low = 0, high = ordered.count
        while low < high {
            let middle = (low + high) / 2
            if spans[ordered[middle]].range.location < NSMaxRange(range) { low = middle + 1 } else { high = middle }
        }
        var found: [Int] = []
        var index = low - 1
        while index >= 0, maximumEnds[index] > range.location {
            let item = ordered[index]
            if NSIntersectionRange(spans[item].range, range).length > 0 { found.append(item) }
            index -= 1
        }
        return found.sorted().map { spans[$0] }
    }
}

/// Finds the changed source and semantic envelope after a background analysis.
/// An unchanged suffix moves by the document's length delta; it needs no layout refresh.
struct MarkdownPresentationInvalidation {
    static func range(previousSource: String?, previousSpans: [EditorSemanticSpan],
                      source: String, spans: [EditorSemanticSpan]) -> NSRange? {
        guard let previousSource else { return NSRange(location: 0, length: source.utf16.count) }
        let old = Array(previousSource.utf16), new = Array(source.utf16)
        // Undo can restore the same bytes after intermediate edits replaced cached paragraphs.
        guard old != new else { return NSRange(location: 0, length: new.count) }
        var start = 0
        while start < min(old.count, new.count), old[start] == new[start] { start += 1 }
        var oldEnd = old.count, end = new.count
        while oldEnd > start, end > start, old[oldEnd - 1] == new[end - 1] { oldEnd -= 1; end -= 1 }
        let delta = new.count - old.count
        var prefix = 0
        while prefix < min(previousSpans.count, spans.count), previousSpans[prefix] == spans[prefix] { prefix += 1 }
        var oldLast = previousSpans.count, newLast = spans.count
        while oldLast > prefix, newLast > prefix {
            let before = previousSpans[oldLast - 1], after = spans[newLast - 1]
            guard before.role == after.role, before.range.length == after.range.length,
                  before.range.location + delta == after.range.location else { break }
            oldLast -= 1; newLast -= 1
        }
        if prefix < oldLast {
            start = min(start, previousSpans[prefix].range.location)
            for span in previousSpans[prefix..<oldLast] { end = max(end, NSMaxRange(span.range) + delta) }
        }
        if prefix < newLast {
            start = min(start, spans[prefix].range.location)
            for span in spans[prefix..<newLast] { end = max(end, NSMaxRange(span.range)) }
        }
        start = min(start, new.count)
        end = min(max(end, start), new.count)
        if start == end, start > 0 { start -= 1 }
        return (source as NSString).rangeOfComposedCharacterSequences(for: NSRange(location: start, length: end - start))
    }
}

@MainActor final class MarkdownEditorStyling: NSObject, @MainActor NSTextContentStorageDelegate {
    weak var controller: MarkdownEditorTextController?
    var presentation = MarkdownEditorPresentation()
    private var index = MarkdownSpanIndex([])
    private var analysedGeneration: UInt64?
    private var analysedSource: String?
    private var running = false
    private var waiting: MarkdownEditorSnapshot?
    private var debounce: Task<Void, Never>?
    private(set) var completedAnalyses = 0
    private var coordinates: EditorSourceCoordinates?
    private var measuredCounts: (words: Int, characters: Int)?
    private var codeRanges: [NSRange] = []
    var sourcePosition: (line: Int, column: Int)? {
        guard let controller, analysedGeneration == controller.generation else { return nil }
        return coordinates?.position(atUTF16: controller.selectedRange.location)
    }
    var counts: (words: Int, characters: Int)? {
        guard let controller, analysedGeneration == controller.generation else { return nil }
        return measuredCounts
    }
    var protectedRanges: [NSRange]? {
        guard let controller, analysedGeneration == controller.generation else { return nil }
        return codeRanges
    }

    func listMarkerEnd(in line: NSRange) -> Int? {
        guard let controller, analysedGeneration == controller.generation,
              !codeRanges.contains(where: { NSIntersectionRange($0, line).length > 0 }) else { return nil }
        let spans = index.overlapping(line)
        guard spans.contains(where: { $0.role == .listMarker }) else { return nil }
        return spans.filter { $0.role == .listMarker || $0.role == .taskMarker }.map { NSMaxRange($0.range) }.max()
    }

    init(controller: MarkdownEditorTextController) {
        self.controller = controller
        super.init()
        controller.textView.textContentStorage?.delegate = self
    }

    func changed() {
        guard let controller, analysedGeneration != controller.generation else { return }
        waiting = controller.snapshot
        guard !controller.hasMarkedText else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            self?.startNext()
        }
    }

    private func startNext() {
        guard !running, let snapshot = waiting, let controller, !controller.hasMarkedText else { return }
        waiting = nil
        guard analysedGeneration != snapshot.generation else { return }
        running = true
        let previousSource = analysedSource
        let previousSpans = index.spans
        Task { [weak self] in
            let result = await Task.detached(priority: .utility) {
                var words = 0
                snapshot.source.enumerateSubstrings(in: snapshot.source.startIndex..<snapshot.source.endIndex,
                    options: [.byWords, .substringNotRequired]) { _, _, _, _ in words += 1 }
                let analysis = EditorSourceAnalysis.scan(snapshot.source)
                let changedRange = MarkdownPresentationInvalidation.range(previousSource: previousSource, previousSpans: previousSpans,
                    source: snapshot.source, spans: analysis.spans)
                return (MarkdownSpanIndex(analysis.spans),
                        EditorSourceCoordinates(snapshot.source), words, snapshot.source.count, analysis.protectedRanges, changedRange)
            }.value
            guard let self else { return }
            self.running = false
            self.completedAnalyses += 1
            if let controller = self.controller, controller.generation == snapshot.generation, !controller.hasMarkedText {
                self.index = result.0
                self.coordinates = result.1
                self.measuredCounts = (result.2, result.3)
                self.codeRanges = result.4
                self.analysedGeneration = snapshot.generation
                self.analysedSource = snapshot.source
                if let range = result.5 { self.invalidate(range: range) }
                controller.onAnalysis?()
            }
            self.startNext()
        }
    }

    func invalidate(range: NSRange? = nil) {
        guard let view = controller?.textView, !view.hasMarkedText() else { return }
        // Paragraph attributes are derived, so invalidate cached elements without rewriting storage.
        if let storage = view.textStorage {
            storage.edited(.editedAttributes, range: range ?? NSRange(location: 0, length: storage.length), changeInLength: 0)
        }
        view.needsDisplay = true
    }

    func textContentStorage(_ textContentStorage: NSTextContentStorage, textParagraphWith range: NSRange) -> NSTextParagraph? {
        guard let controller, !controller.hasMarkedText, let storage = controller.textView.textStorage,
              range.location >= 0, NSMaxRange(range) <= storage.length else { return nil }
        let text = NSMutableAttributedString(attributedString: storage.attributedSubstring(from: range))
        let palette = MarkdownEditorTheme.palette(for: controller.textView)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = presentation.mode == .raw ? 3 : 5
        text.addAttributes([.font: MarkdownEditorTheme.font(presentation),
            .foregroundColor: MarkdownEditorTheme.colour(palette.text), .paragraphStyle: paragraph],
            range: NSRange(location: 0, length: text.length))
        if presentation.mode == .styled, analysedGeneration == controller.generation {
            for span in index.overlapping(range) {
                let intersection = NSIntersectionRange(span.range, range)
                let local = NSRange(location: intersection.location - range.location, length: intersection.length)
                if span.role == .strong || span.role == .emphasis {
                    let trait: NSFontTraitMask = span.role == .strong ? .boldFontMask : .italicFontMask
                    text.enumerateAttribute(.font, in: local) { value, run, _ in
                        let font = value as? NSFont ?? MarkdownEditorTheme.font(presentation)
                        text.addAttribute(.font, value: NSFontManager.shared.convert(font, toHaveTrait: trait), range: run)
                    }
                } else {
                    text.addAttributes(MarkdownEditorTheme.attributes(for: span.role, presentation: presentation, palette: palette), range: local)
                }
            }
        }
        return NSTextParagraph(attributedString: text)
    }
}
