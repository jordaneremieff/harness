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
        editor.textView.undoManager?.redo()
        #expect(editor.source == original + "**文**")
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
        let editor = MarkdownEditorTextController(source: "# Heading\nText with **strong** and `code`.\n")
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
