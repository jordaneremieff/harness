import Testing
import AppKit
@testable import MarkdownCore
@testable import MacPlatform

@Suite(.serialized) @MainActor struct MarkdownVisualInputTests {
    @Test func nativeVisualInputUsesExactSourceAndCrossModeUndo() {
        _ = NSApplication.shared
        let editor = MarkdownEditorTextController(source: "# Heading\n\n**bold** [label](https://example.com)\n")
        editor.setPresentation(.init(mode: .visual))
        let view = editor.activeTextView
        #expect(view !== editor.textView)
        #expect(view.string == "Heading\n\nbold label\n")
        view.setSelectedRange((view.string as NSString).range(of: "bold"))
        view.insertText("strong", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.source == "# Heading\n\n**strong** [label](https://example.com)\n")
        #expect(view.string == "Heading\n\nstrong label\n")
        #expect(editor.generation == 1)
        view.undo(nil)
        #expect(editor.source == "# Heading\n\n**bold** [label](https://example.com)\n")
        #expect(view.string == "Heading\n\nbold label\n")
        editor.setPresentation(.init(mode: .raw))
        editor.textView.undoManager?.redo()
        editor.setPresentation(.init(mode: .visual))
        #expect(view.string == "Heading\n\nstrong label\n")
        #expect(editor.generation == 3)
        #expect(view.textLayoutManager != nil)
    }

    @Test func nativeMarkedTextKeepsProjectionAndOneUndoGroup() {
        _ = NSApplication.shared
        let editor = MarkdownEditorTextController(source: "# Title\n\n**word**\n")
        editor.setPresentation(.init(mode: .visual))
        let view = editor.activeTextView
        view.setSelectedRange((view.string as NSString).range(of: "word"))
        view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.hasMarkedText)
        #expect(editor.source == "# Title\n\n**に**\n")
        editor.setPresentation(.init(mode: .raw))
        #expect(editor.presentation.mode == .visual)
        view.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        view.unmarkText()
        #expect(!editor.hasMarkedText)
        #expect(editor.presentation.mode == .raw)
        #expect(editor.source == "# Title\n\n**日本**\n")
        editor.textView.undoManager?.undo()
        #expect(editor.source == "# Title\n\n**word**\n")
        editor.setPresentation(.init(mode: .visual))
        #expect(view.string == "Title\n\nword\n")
    }

    @Test func mixedInlineCodeEditsAndCompositionPreserveExactSource() {
        _ = NSApplication.shared
        let source = "Comfortable text has a clear hierarchy. **Strong words**, *emphasis*, and `code` have distinct purposes.\r\n"
        let editor = MarkdownEditorTextController(source: source)
        editor.setPresentation(.init(mode: .visual))
        let view = editor.activeTextView
        #expect(view.string == "Comfortable text has a clear hierarchy. Strong words, emphasis, and code have distinct purposes.\r\n")
        let code = (view.string as NSString).range(of: "code")
        let font = view.textStorage?.attribute(.font, at: code.location, effectiveRange: nil) as? NSFont
        #expect(font?.isFixedPitch == true)
        let proseFont = view.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        #expect(proseFont?.isFixedPitch == false)
        for (text, trait) in [("Strong words", NSFontTraitMask.boldFontMask), ("emphasis", .italicFontMask)] {
            let range = (view.string as NSString).range(of: text)
            let font = view.textStorage?.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont
            #expect(font.map { NSFontManager.shared.traits(of: $0).contains(trait) } == true)
        }
        view.setSelectedRange(code)
        view.insertText("value", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.source == source.replacingOccurrences(of: "`code`", with: "`value`"))
        view.undo(nil)
        #expect(editor.source.utf8.elementsEqual(source.utf8))
        view.redo(nil)
        #expect(editor.source == source.replacingOccurrences(of: "`code`", with: "`value`"))
        view.setSelectedRange((view.string as NSString).range(of: "value"))
        view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.hasMarkedText)
        #expect(editor.source == source.replacingOccurrences(of: "`code`", with: "`に`"))
        view.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        view.unmarkText()
        #expect(editor.source == source.replacingOccurrences(of: "`code`", with: "`日本`"))
        view.undo(nil)
        #expect(editor.source == source.replacingOccurrences(of: "`code`", with: "`value`"))
        #expect(view.string.contains("and value have distinct purposes."))
    }

    @Test func exactAgentPatchSetIsAtomicAndUsesOneUndoUnit() {
        let editor = MarkdownEditorTextController(source: "one **two** three")
        editor.setPresentation(.init(mode: .visual))
        let patches = [MarkdownSourceEdit(range: NSRange(location: 0, length: 3), expected: "one", replacement: "first"),
                       MarkdownSourceEdit(range: NSRange(location: 12, length: 5), expected: "three", replacement: "last")]
        #expect(!editor.apply(edits: patches, expectedGeneration: 7, actionName: "Agent Edit"))
        #expect(editor.apply(edits: patches, expectedGeneration: 0, actionName: "Agent Edit"))
        #expect(editor.source == "first **two** last")
        #expect(editor.activeTextView.string == "first two last")
        editor.textView.undoManager?.undo()
        #expect(editor.source == "one **two** three")
        #expect(editor.activeTextView.string == "one two three")
    }

    @Test(arguments: ["menu", "keyDown", "keyEquivalent"], [MarkdownSourceMode.raw, .visual])
    func nativeUndoRoutesRetainVisualHumanAndAgentEdits(route: String, mode: MarkdownSourceMode) throws {
        _ = NSApplication.shared
        let original = "# Heading\n\nHuman passage.\n\nAgent passage.\n"
        let editor = MarkdownEditorTextController(source: original)
        // Human input and the later agent reply are separate native event transactions.
        editor.textView.undoManager?.groupsByEvent = false
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = editor.scrollView
        editor.setPresentation(.init(mode: .visual))
        window.makeFirstResponder(editor.activeTextView)
        editor.activeTextView.setSelectedRange(NSRange(location: 0, length: 0))
        editor.activeTextView.insertText("Ω ", replacementRange: NSRange(location: NSNotFound, length: 0))
        let human = "# Ω Heading\n\nHuman passage.\n\nAgent passage.\n"
        #expect(editor.source == human)
        let patch = MarkdownSourceEdit(range: (human as NSString).range(of: "Agent passage."),
                                       expected: "Agent passage.", replacement: "Improved distant passage.")
        #expect(editor.apply(edits: [patch], expectedGeneration: 1, actionName: "Agent Edit"))
        let manager = try #require(editor.textView.undoManager)
        #expect(manager.canUndo)
        #expect(manager.undoActionName == "Agent Edit")
        editor.setPresentation(.init(mode: mode))
        let view = editor.activeTextView
        #expect(window.firstResponder === view)
        #expect((view.commandUndoManager ?? view.undoManager) === manager)
        #expect(manager.isUndoRegistrationEnabled)
        #expect(manager.canUndo)
        func send(redo: Bool = false) throws {
            let modifiers: NSEvent.ModifierFlags = redo ? [.command, .shift] : .command
            let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: redo ? "Z" : "z",
                charactersIgnoringModifiers: redo ? "Z" : "z", isARepeat: false, keyCode: 6))
            switch route {
            case "keyDown": view.keyDown(with: event)
            case "keyEquivalent": #expect(view.performKeyEquivalent(with: event))
            default:
                let menu = NSMenu()
                let action = redo ? #selector(MarkdownSourceTextView.redo(_:)) : #selector(MarkdownSourceTextView.undo(_:))
                let item = NSMenuItem(title: redo ? "Redo" : "Undo", action: action, keyEquivalent: "z")
                item.keyEquivalentModifierMask = modifiers
                item.target = view
                menu.addItem(item)
                #expect(view.validateUserInterfaceItem(item))
                menu.performActionForItem(at: 0)
            }
        }
        try send()
        #expect(editor.source == human)
        #expect(editor.generation == 3)
        try send()
        #expect(editor.source == original)
        try send(redo: true)
        #expect(editor.source == human)
        try send(redo: true)
        #expect(editor.source == human.replacingOccurrences(of: "Agent passage.", with: "Improved distant passage."))
    }

    @Test(arguments: [MarkdownSourceMode.raw, .visual])
    func undoKeysPreserveNativeComposition(mode: MarkdownSourceMode) throws {
        _ = NSApplication.shared
        let editor = MarkdownEditorTextController(source: "**word**")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = editor.scrollView
        editor.setPresentation(.init(mode: mode))
        editor.select(NSRange(location: 2, length: 4))
        let view = editor.activeTextView
        window.makeFirstResponder(view)
        view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0),
                           replacementRange: NSRange(location: NSNotFound, length: 0))
        let snapshot = editor.snapshot
        #expect(snapshot.hasMarkedText)
        for modifiers: NSEvent.ModifierFlags in [.command, [.command, .shift]] {
            let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                timestamp: 0, windowNumber: 0, context: nil, characters: "z", charactersIgnoringModifiers: "z",
                isARepeat: false, keyCode: 6))
            view.keyDown(with: event)
            #expect(view.performKeyEquivalent(with: event))
            #expect(editor.snapshot == snapshot)
            #expect(view.hasMarkedText())
        }
        view.unmarkText()
    }

    @Test(arguments: [MarkdownSourceMode.raw, .visual])
    func undoKeysLeaveTheDocumentWhileAnotherFieldHasFocus(mode: MarkdownSourceMode) throws {
        _ = NSApplication.shared
        let original = "# Heading\n\nAgent passage.\n"
        let editor = MarkdownEditorTextController(source: original)
        let field = NSTextView(frame: NSRect(x: 0, y: 360, width: 200, height: 30))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        editor.scrollView.frame = NSRect(x: 0, y: 0, width: 600, height: 350)
        content.addSubview(editor.scrollView)
        content.addSubview(field)
        let window = NSWindow(contentRect: content.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = content
        editor.setPresentation(.init(mode: mode))
        let patch = MarkdownSourceEdit(range: (original as NSString).range(of: "Agent passage."),
                                       expected: "Agent passage.", replacement: "Agent edit.")
        #expect(editor.apply(edits: [patch], expectedGeneration: 0, actionName: "Agent Edit"))
        let edited = editor.source
        #expect(window.makeFirstResponder(field))
        for modifiers: NSEvent.ModifierFlags in [.command, [.command, .shift]] {
            let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "z",
                charactersIgnoringModifiers: "z", isARepeat: false, keyCode: 6))
            #expect(!editor.activeTextView.performKeyEquivalent(with: event))
            #expect(editor.source == edited)
        }
        #expect(editor.textView.undoManager?.canUndo == true)
    }

    @Test func zoomDoesNotEnterSourceOrUndo() {
        let editor = MarkdownEditorTextController(source: "# Text\n")
        editor.scrollView.frame = NSRect(x: 0, y: 0, width: 600, height: 400)
        editor.setPresentation(.init(mode: .visual))
        editor.select(NSRange(location: 4, length: 0))
        for zoom: CGFloat in [0.7, 1.5, 1] {
            editor.setZoom(zoom)
            #expect(abs(editor.zoom - zoom) < 0.01)
            #expect(editor.source == "# Text\n")
            #expect(editor.generation == 0)
            #expect(editor.selectedRange == NSRange(location: 4, length: 0))
            #expect(editor.textView.undoManager?.canUndo == false)
        }
    }
}
