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

@MainActor final class MarkdownEditorStyling: NSObject, @MainActor NSTextContentStorageDelegate {
    weak var controller: MarkdownEditorTextController?
    var presentation = MarkdownEditorPresentation()
    private var index = MarkdownSpanIndex([])
    private var analysedGeneration: UInt64?
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
        Task { [weak self] in
            let result = await Task.detached(priority: .utility) {
                var words = 0
                snapshot.source.enumerateSubstrings(in: snapshot.source.startIndex..<snapshot.source.endIndex,
                    options: [.byWords, .substringNotRequired]) { _, _, _, _ in words += 1 }
                let analysis = EditorSourceAnalysis.scan(snapshot.source)
                return (MarkdownSpanIndex(analysis.spans),
                        EditorSourceCoordinates(snapshot.source), words, snapshot.source.count, analysis.protectedRanges)
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
                self.invalidate()
                controller.onAnalysis?()
            }
            self.startNext()
        }
    }

    func invalidate() {
        guard let view = controller?.textView, !view.hasMarkedText() else { return }
        // Paragraph attributes are derived, so invalidate cached elements without rewriting storage.
        if let storage = view.textStorage {
            storage.edited(.editedAttributes, range: NSRange(location: 0, length: storage.length), changeInLength: 0)
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
