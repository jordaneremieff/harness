import Testing
import AppKit
@testable import MarkdownCore
@testable import MacPlatform

@Suite(.serialized) @MainActor struct MarkdownEditorInputTests {
    @Test func commandPreservesUnicodeAndUsesNativeUndo() {
        _ = NSApplication.shared
        let editor = MarkdownEditorTextController(source: "👩🏽‍💻 e\u{301} العربية\r\n", initialGeneration: 10)
        let original = editor.source
        let length = (original as NSString).length
        #expect(editor.apply(range: NSRange(location: length, length: 0), replacement: "**文**", selection: NSRange(location: length + 5, length: 0), actionName: "Bold"))
        #expect(editor.source == original + "**文**")
        #expect(editor.generation == 11)
        #expect(editor.textView.textLayoutManager != nil)
        editor.textView.undoManager?.undo()
        #expect(editor.source == original)
        #expect(editor.generation == 12)
        editor.textView.undoManager?.redo()
        #expect(editor.source == original + "**文**")
        #expect(editor.generation == 13)
        #expect(editor.textView.textLayoutManager != nil)
    }

    @Test func nativeCompositionKeepsMarkedTextAndRejectsCommands() {
        _ = NSApplication.shared
        let editor = MarkdownEditorTextController(source: "prefix ")
        editor.textView.setSelectedRange(NSRange(location: 7, length: 0))
        editor.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.hasMarkedText)
        #expect(!editor.apply(range: NSRange(location: 0, length: 0), replacement: "# ", selection: NSRange(location: 2, length: 0), actionName: "Heading"))
        editor.textView.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.textView.unmarkText()
        #expect(!editor.hasMarkedText)
        #expect(editor.source == "prefix 日本")
        #expect(editor.textView.textLayoutManager != nil)
    }

    @Test func selectionDoesNotAdvanceGenerationAndInvalidRangesRefuse() {
        let editor = MarkdownEditorTextController(source: "😀abc")
        editor.select(NSRange(location: 2, length: 2))
        #expect(editor.generation == 0)
        #expect(editor.selectedRange == NSRange(location: 2, length: 2))
        #expect(!editor.apply(range: NSRange(location: 1, length: 1), replacement: "x", selection: NSRange(location: 0, length: 0), actionName: "Edit"))
        #expect(editor.source == "😀abc")
    }

    @Test func presentationNeverChangesSourceUndoSelectionOrComposition() {
        let editor = MarkdownEditorTextController(source: "# Café 👩🏽‍💻\n**text**")
        #expect(editor.apply(range: NSRange(location: 0, length: 0), replacement: "q:", selection: NSRange(location: 2, length: 0), actionName: "Insert"))
        let source = editor.source
        let generation = editor.generation
        let selection = editor.selectedRange
        for mode in MarkdownSourceMode.allCases {
            for appearance in MarkdownCore.MarkdownThemeAppearance.allCases {
                editor.setPresentation(.init(mode: mode, appearance: appearance, font: .serif, fontSize: 19, wrapsLines: false))
                #expect(editor.source == source)
                #expect(editor.generation == generation)
                #expect(editor.selectedRange == selection)
                #expect(editor.textView.textLayoutManager != nil)
            }
        }
        editor.textView.undoManager?.undo()
        #expect(editor.source == "# Café 👩🏽‍💻\n**text**")
        editor.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        let prior = editor.presentation
        editor.setPresentation(.init(mode: .styled, appearance: .light))
        #expect(editor.presentation == prior)
        #expect(editor.hasMarkedText)
        editor.textView.unmarkText()
        #expect(editor.presentation.appearance == .light)
        #expect(editor.textView.textLayoutManager != nil)
    }

    @Test func semanticRenderingDoesNotEnterTheBufferOrUndo() async {
        let editor = MarkdownEditorTextController(source: "# Heading **bold *inner***\nText with **strong** and `code`.\n")
        let window = NSWindow(contentRect: NSRect(x: -2000, y: 0, width: 640, height: 480),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = editor.scrollView
        window.layoutIfNeeded()
        let original = editor.source
        let ready = await withCheckedContinuation { continuation in
            var resumed = false
            editor.onAnalysis = {
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: true)
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(5))
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: false)
            }
        }
        #expect(ready)
        if let manager = editor.textView.textLayoutManager, let content = manager.textContentManager {
            manager.ensureLayout(for: content.documentRange)
            if let bitmap = editor.scrollView.bitmapImageRepForCachingDisplay(in: editor.scrollView.bounds) {
                editor.scrollView.cacheDisplay(in: editor.scrollView.bounds, to: bitmap)
            }
            var headingSize: CGFloat = 0
            manager.enumerateTextLayoutFragments(from: content.documentRange.location, options: [.ensuresLayout]) { fragment in
                if let paragraph = fragment.textElement as? NSTextParagraph,
                   let font = paragraph.attributedString.attribute(.font, at: 0, effectiveRange: nil) as? NSFont {
                    headingSize = font.pointSize
                    let inner = (paragraph.attributedString.string as NSString).range(of: "inner")
                    if inner.location != NSNotFound,
                       let nested = paragraph.attributedString.attribute(.font, at: inner.location, effectiveRange: nil) as? NSFont {
                        #expect(nested.pointSize == headingSize)
                        #expect(NSFontManager.shared.traits(of: nested).contains([.boldFontMask, .italicFontMask]))
                    } else {
                        Issue.record("The heading's nested emphasis is missing")
                    }
                }
                return false
            }
            #expect(headingSize > editor.presentation.fontSize)
            let storedFont = editor.textView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
            #expect(storedFont?.pointSize != headingSize)
        }
        #expect(editor.source == original)
        #expect(editor.generation == 0)
        #expect(editor.textView.undoManager?.canUndo == false)
        #expect(editor.protectedRanges?.isEmpty == false)
        #expect(editor.textView.textLayoutManager != nil)
        window.contentView = nil
    }

    @Test func viewportSurvivesAnalysisBetweenDistantEdits() async {
        let source = String(repeating: "## Heading 文\nText with **strong** and `code`.\n\n", count: 30)
        let editor = MarkdownEditorTextController(source: source)
        let window = NSWindow(contentRect: NSRect(x: -2000, y: 0, width: 640, height: 480),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = editor.scrollView
        window.makeFirstResponder(editor.textView)
        for position in [0, source.utf16.count / 2, source.utf16.count] {
            let ready = await withCheckedContinuation { continuation in
                var resumed = false
                editor.onAnalysis = {
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(returning: true)
                }
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(5))
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(returning: false)
                }
            }
            #expect(ready)
            let text = editor.source as NSString
            let offset = position == source.utf16.count ? text.length : text.rangeOfComposedCharacterSequence(at: position).location
            editor.select(NSRange(location: offset, length: 0))
            window.layoutIfNeeded()
            editor.textView.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
            window.layoutIfNeeded()
        }
        #expect(editor.source.utf16.count == source.utf16.count + 3)
        #expect(editor.textView.textLayoutManager != nil)
        window.contentView = nil
    }

    @Test func analysisInvalidationKeepsUnchangedShiftedParagraphs() throws {
        let suffix = String(repeating: "## Heading\nText with **strong** and `code`.\n\n", count: 200)
        let old = "plain text\n\n" + suffix
        let new = "new plain text\n\n" + suffix
        let range = try #require(MarkdownPresentationInvalidation.range(previousSource: old,
            previousSpans: EditorSourceAnalysis.scan(old).spans, source: new, spans: EditorSourceAnalysis.scan(new).spans))
        #expect(range.location == 0)
        #expect(NSMaxRange(range) < 20)
        let removedHeading = "plain text\n\n" + suffix.dropFirst(3)
        let changed = try #require(MarkdownPresentationInvalidation.range(previousSource: old,
            previousSpans: EditorSourceAnalysis.scan(old).spans, source: String(removedHeading),
            spans: EditorSourceAnalysis.scan(String(removedHeading)).spans))
        #expect(changed.location <= 12)
        #expect(NSMaxRange(changed) < 40)
    }

    @Test func analysisInvalidationCoversMultilineContextAndUnicodeDeletion() throws {
        let old = "intro\n\n```swift\n# code\n```\n\n## End\n"
        let new = "intro\n\n```swift\n# code\n\n## End\n"
        let range = try #require(MarkdownPresentationInvalidation.range(previousSource: old,
            previousSpans: EditorSourceAnalysis.scan(old).spans, source: new, spans: EditorSourceAnalysis.scan(new).spans))
        #expect(NSMaxRange(range) >= (new as NSString).range(of: "## End").upperBound)
        let empty = MarkdownPresentationInvalidation.range(previousSource: "👩🏽‍💻", previousSpans: [], source: "", spans: [])
        #expect(empty == NSRange(location: 0, length: 0))
        #expect(MarkdownPresentationInvalidation.range(previousSource: "same", previousSpans: [], source: "same", spans: []) == NSRange(location: 0, length: 4))
        let decomposed = "e\u{301}\nunchanged"
        let normalised = try #require(MarkdownPresentationInvalidation.range(previousSource: "é\nunchanged",
            previousSpans: [], source: decomposed, spans: []))
        #expect(normalised == NSRange(location: 0, length: 2))
    }

    @Test func trailingEmptyLineHighlightFollowsNativeInput() async throws {
        let source = "# First draft\n\nCafé e\u{301} 👩🏽‍💻 שלום.\n\nA **bold** and *italic* sentence.\n"
        let editor = MarkdownEditorTextController(source: "")
        let window = NSWindow(contentRect: NSRect(x: -2000, y: 0, width: 640, height: 480),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = editor.scrollView
        window.makeFirstResponder(editor.textView)
        editor.textView.insertText(source, replacementRange: NSRange(location: NSNotFound, length: 0))
        await withCheckedContinuation { continuation in
            editor.onAnalysis = { editor.onAnalysis = nil; continuation.resume() }
        }
        let manager = try #require(editor.textView.textLayoutManager)
        let content = try #require(manager.textContentManager)
        func frame(at offset: Int) throws -> NSRect {
            let location = try #require(content.location(content.documentRange.location, offsetBy: offset))
            let range = try #require(NSTextRange(location: location, end: location))
            var result: NSRect?
            manager.enumerateTextSegments(in: range, type: .standard, options: []) { _, frame, _, _ in
                result = frame
                return false
            }
            return try #require(result)
        }
        for mode in [MarkdownSourceMode.styled, .raw] {
            editor.setPresentation(MarkdownEditorPresentation(mode: mode))
            window.layoutIfNeeded()
            let previous = try frame(at: source.utf16.count - 2)
            let empty = try frame(at: source.utf16.count)
            #expect(empty.minY >= previous.maxY)
        }
        #expect(editor.sourcePosition?.line == 6)
        #expect(editor.sourcePosition?.column == 1)
        window.contentView = nil
    }

    private func waitForAnalysis(_ editor: MarkdownEditorTextController) async -> Bool {
        if editor.counts != nil { return true }
        return await withCheckedContinuation { continuation in
            var resumed = false
            editor.onAnalysis = {
                guard !resumed else { return }
                resumed = true
                editor.onAnalysis = nil
                continuation.resume(returning: true)
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(5))
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: false)
            }
        }
    }

    @Test func listContinuationSurvivesImmediateTypingAndRepeatedReturn() async {
        let editor = MarkdownEditorTextController(source: "- item")
        #expect(await waitForAnalysis(editor))
        editor.select(NSRange(location: editor.source.utf16.count, length: 0))
        editor.textView.insertText(" 👩🏽‍💻 e\u{301}", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.protectedRanges == nil)
        #expect(editor.continueList())
        #expect(editor.source == "- item 👩🏽‍💻 e\u{301}\n- ")
        editor.textView.insertText("next", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.continueList())
        #expect(editor.source.hasSuffix("\n- next\n- "))
        #expect(editor.continueList())
        #expect(editor.source.hasSuffix("\n- next\n"))
        #expect(editor.textView.textLayoutManager != nil)
    }

    @Test func listContinuationRefusesChangedCodeContextAndPrefix() async {
        for inserted in ["`", "~", "\\", "\n"] {
            let editor = MarkdownEditorTextController(source: "- item")
            #expect(await waitForAnalysis(editor))
            editor.select(NSRange(location: editor.source.utf16.count, length: 0))
            editor.textView.insertText(inserted, replacementRange: NSRange(location: NSNotFound, length: 0))
            let before = editor.snapshot
            #expect(!editor.continueList())
            #expect(editor.snapshot == before)
        }
        let editor = MarkdownEditorTextController(source: "- item")
        #expect(await waitForAnalysis(editor))
        editor.select(NSRange(location: 0, length: 0))
        editor.textView.insertText(" ", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.select(NSRange(location: editor.source.utf16.count, length: 0))
        #expect(!editor.continueList())
        for source in ["```\n- item\n```", "    - item", "- `code`"] {
            let code = MarkdownEditorTextController(source: source)
            #expect(await waitForAnalysis(code))
            let end = (source as NSString).range(of: "item").location
            code.select(NSRange(location: end == NSNotFound ? source.utf16.count : end + 4, length: 0))
            #expect(!code.continueList())
        }
    }

    @Test func listContinuationClearsOnUndoRedoCompositionAndReplacement() async {
        let editor = MarkdownEditorTextController(source: "1. item")
        #expect(await waitForAnalysis(editor))
        editor.select(NSRange(location: editor.source.utf16.count, length: 0))
        let undo = editor.textView.undoManager!
        undo.groupsByEvent = false
        undo.beginUndoGrouping()
        editor.textView.insertText(" more", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.textView.breakUndoCoalescing()
        undo.endUndoGrouping()
        let before = editor.source
        #expect(editor.continueList())
        #expect(editor.source == before + "\n2. ")
        let generation = editor.generation
        editor.textView.undoManager?.undo()
        #expect(editor.source == before)
        #expect(editor.generation > generation)
        #expect(!editor.continueList())
        let undoGeneration = editor.generation
        editor.textView.undoManager?.redo()
        #expect(editor.source == before + "\n2. ")
        #expect(editor.generation > undoGeneration)
        #expect(!editor.continueList())
        undo.groupsByEvent = true
        #expect(editor.replaceDocument(source: "- item", selectedRange: NSRange(location: 6, length: 0)))
        #expect(!editor.continueList())
        #expect(await waitForAnalysis(editor))
        editor.textView.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(!editor.continueList())
        editor.textView.unmarkText()
        #expect(!editor.continueList())
    }

    @Test func listContinuationPreservesTaskMarkersAndCRLF() async {
        let editor = MarkdownEditorTextController(source: "- [x] done\r\nnext")
        #expect(await waitForAnalysis(editor))
        editor.select(NSRange(location: 10, length: 0))
        editor.textView.insertText("!", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.continueList())
        #expect(editor.source == "- [x] done!\r\n- [ ] \r\nnext")
        #expect(editor.selectedRange == NSRange(location: 19, length: 0))
        let long = MarkdownEditorTextController(source: "- " + String(repeating: "x", count: 4096))
        #expect(await waitForAnalysis(long))
        long.select(NSRange(location: long.source.utf16.count, length: 0))
        #expect(!long.continueList())
    }

    @Test func listContinuationRefusesUnknownAndCrossLineEdits() async {
        let unknown = MarkdownEditorTextController(source: "- item")
        unknown.select(NSRange(location: 6, length: 0))
        #expect(!unknown.continueList())
        let editor = MarkdownEditorTextController(source: "prose\n- item")
        #expect(await waitForAnalysis(editor))
        editor.select(NSRange(location: editor.source.utf16.count, length: 0))
        editor.textView.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.select(NSRange(location: 0, length: 0))
        editor.textView.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.select(NSRange(location: editor.source.utf16.count, length: 0))
        #expect(!editor.continueList())
    }

    @Test func snapshotsStayImmutableAfterLaterNativeInput() {
        let editor = MarkdownEditorTextController(source: "first")
        let snapshot = editor.snapshot
        editor.textView.insertText(" second", replacementRange: NSRange(location: 5, length: 0))
        #expect(snapshot.source == "first")
        #expect(editor.source == "first second")
        #expect(editor.generation > snapshot.generation)
    }

    @Test func oversizedNativePasteRefusesWithoutChangingText() {
        let editor = MarkdownEditorTextController(source: "keep")
        var error: String?
        editor.onError = { error = $0 }
        let before = editor.generation
        editor.textView.insertText(String(repeating: "a", count: 2_097_153), replacementRange: NSRange(location: 0, length: 4))
        #expect(editor.source == "keep")
        #expect(editor.generation == before)
        #expect(error != nil)
    }

    @Test func largeNativeBufferEditsAndUndoesWithoutLayoutDowngrade() {
        let source = String(repeating: "## Heading 文\nA paragraph with **bold** and `code`.\n\n", count: 30_000)
        let editor = MarkdownEditorTextController(source: source)
        #expect(editor.apply(range: NSRange(location: 0, length: 0), replacement: "q:", selection: NSRange(location: 2, length: 0), actionName: "Insert"))
        editor.textView.undoManager?.undo()
        #expect(editor.source == source)
        #expect(editor.textView.textLayoutManager != nil)
    }
}
