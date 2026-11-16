import AppKit
import SwiftUI
import MarkdownCore

public struct MarkdownEditorSnapshot: Sendable, Equatable {
    public let source: String
    public let generation: UInt64
    public let selectedRange: NSRange
    public let hasMarkedText: Bool
}

/// Owns the native buffer and its undo history for the lifetime of an edit session.
@MainActor public final class MarkdownEditorTextController: NSObject, NSTextViewDelegate {
    public let textView: MarkdownSourceTextView
    public let scrollView: NSScrollView
    public private(set) var generation: UInt64
    public var onChange: ((MarkdownEditorSnapshot) -> Void)?
    public var onError: ((String) -> Void)?
    public var onAnalysis: (() -> Void)?
    public var onCommand: ((Selector) -> Bool)?
    public var onImageFiles: (([URL]) -> Void)? {
        didSet { textView.onImageFiles = onImageFiles }
    }
    public var onImageData: ((Data, String) -> Void)? {
        didSet { textView.onImageData = onImageData }
    }
    private var replacingDocument = false
    private var sourceBytes: Int
    private var pendingSourceBytes: Int?
    private var styling: MarkdownEditorStyling!
    public private(set) var presentation = MarkdownEditorPresentation()
    private var pendingPresentation: MarkdownEditorPresentation?

    /// Nil means analysis is stale; formatting must wait rather than ignore code context.
    public var protectedRanges: [NSRange]? { styling.protectedRanges }
    public var sourcePosition: (line: Int, column: Int)? { styling.sourcePosition }
    public var counts: (words: Int, characters: Int)? { styling.counts }

    public var source: String { textView.string }
    public var selectedRange: NSRange { textView.selectedRange() }
    public var hasMarkedText: Bool { textView.hasMarkedText() }
    public var snapshot: MarkdownEditorSnapshot {
        MarkdownEditorSnapshot(source: source, generation: generation, selectedRange: selectedRange, hasMarkedText: hasMarkedText)
    }

    public init(source: String = "", initialGeneration: UInt64 = 0) {
        generation = initialGeneration
        sourceBytes = source.utf8.count
        textView = MarkdownSourceTextView(usingTextLayoutManager: true)
        scrollView = NSScrollView()
        super.init()
        precondition(textView.textLayoutManager != nil, "The editor requires TextKit 2")
        textView.registerForDraggedTypes(textView.registeredDraggedTypes + [.fileURL])
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticDataDetectionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.usesFindBar = true
        textView.isIncrementalSearchingEnabled = true
        textView.textContainerInset = NSSize(width: 24, height: 20)
        textView.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude)
        textView.string = source
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.documentView = textView
        textView.delegate = self
        styling = MarkdownEditorStyling(controller: self)
        textView.compositionDidChange = { [weak self] in
            guard let self else { return }
            if !self.hasMarkedText, let pending = self.pendingPresentation { self.setPresentation(pending) }
            self.styling.changed()
            self.notify()
        }
        textView.appearanceDidChange = { [weak self] in self?.refreshColours() }
        setPresentation(presentation)
        styling.changed()
    }

    public func textDidChange(_ notification: Notification) {
        guard !replacingDocument else { return }
        sourceBytes = pendingSourceBytes ?? source.utf8.count
        pendingSourceBytes = nil
        generation &+= 1
        styling.changed()
        notify()
    }

    public func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
        guard let replacementString else { return true }
        guard let range = Range(affectedCharRange, in: source) else { return false }
        let bytes = sourceBytes - source[range].utf8.count + replacementString.utf8.count
        guard bytes <= Limits.sourceBytes else {
            onError?("This edit exceeds the 2 MiB source limit. The existing text stays unchanged.")
            return false
        }
        pendingSourceBytes = bytes
        return true
    }

    public func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard !hasMarkedText else { return false }
        return onCommand?(commandSelector) ?? false
    }

    public func textViewDidChangeSelection(_ notification: Notification) {
        guard !replacingDocument else { return }
        textView.needsDisplay = true
        notify()
    }

    private func notify() { onChange?(snapshot) }

    /// One explicit command, one native undo unit. Input methods retain their own transactions.
    @discardableResult public func apply(range: NSRange, replacement: String, selection: NSRange, actionName: String) -> Bool {
        guard !hasMarkedText, Self.validSelection(range, in: source) else { return false }
        let result = (source as NSString).replacingCharacters(in: range, with: replacement)
        guard Self.validSelection(selection, in: result),
              textView.shouldChangeText(in: range, replacementString: replacement) else { return false }
        let undo = textView.undoManager
        textView.breakUndoCoalescing()
        undo?.beginUndoGrouping()
        textView.textStorage?.replaceCharacters(in: range, with: replacement)
        textView.didChangeText()
        textView.setSelectedRange(selection)
        undo?.setActionName(actionName)
        undo?.endUndoGrouping()
        textView.breakUndoCoalescing()
        return true
    }

    /// Only deliberate document replacement clears history. Mode changes never call this.
    @discardableResult public func replaceDocument(source: String, selectedRange: NSRange = NSRange(location: 0, length: 0)) -> Bool {
        guard !hasMarkedText, Self.validSelection(selectedRange, in: source) else { return false }
        guard source.utf8.count <= Limits.sourceBytes else {
            onError?("This document exceeds the 2 MiB source limit.")
            return false
        }
        replacingDocument = true
        sourceBytes = source.utf8.count
        pendingSourceBytes = nil
        textView.string = source
        textView.setSelectedRange(selectedRange)
        textView.undoManager?.removeAllActions()
        generation &+= 1
        replacingDocument = false
        styling.changed()
        notify()
        return true
    }

    public func select(_ range: NSRange) {
        guard Self.validSelection(range, in: source) else { return }
        textView.setSelectedRange(range)
        textView.scrollRangeToVisible(range)
    }

    @discardableResult public func goToLine(_ line: Int) -> Bool {
        guard line > 0 else { return false }
        let text = source as NSString
        var current = 1, offset = 0
        while current < line, offset < text.length {
            let next = NSMaxRange(text.lineRange(for: NSRange(location: offset, length: 0)))
            guard next > offset else { break }
            offset = next
            current += 1
        }
        guard current == line else { return false }
        select(NSRange(location: offset, length: 0))
        focus()
        return true
    }

    static func validSelection(_ range: NSRange, in source: String) -> Bool {
        let text = source as NSString
        guard range.location >= 0, range.length >= 0, range.location <= text.length,
              range.length <= text.length - range.location else { return false }
        if range.length == 0 {
            return range.location == text.length || text.rangeOfComposedCharacterSequence(at: range.location).location == range.location
        }
        return text.rangeOfComposedCharacterSequences(for: range) == range
    }

    public func focus() { textView.requestFocus() }

    public func setPresentation(_ value: MarkdownEditorPresentation) {
        guard !hasMarkedText else { pendingPresentation = value; return }
        pendingPresentation = nil
        presentation = value
        styling.presentation = value
        switch value.appearance {
        case .system: scrollView.appearance = nil
        case .light: scrollView.appearance = NSAppearance(named: .aqua)
        case .dark: scrollView.appearance = NSAppearance(named: .darkAqua)
        }
        let font = MarkdownEditorTheme.font(value)
        textView.typingAttributes = [.font: font]
        textView.isHorizontallyResizable = !value.wrapsLines
        textView.autoresizingMask = value.wrapsLines ? [.width] : []
        textView.textContainer?.widthTracksTextView = value.wrapsLines
        textView.textContainer?.containerSize = NSSize(
            width: value.wrapsLines ? max(1, scrollView.contentSize.width - 48) : CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude)
        scrollView.hasHorizontalScroller = !value.wrapsLines
        refreshColours()
        styling.changed()
    }

    private func refreshColours() {
        guard !hasMarkedText else { return }
        let palette = MarkdownEditorTheme.palette(for: textView)
        textView.backgroundColor = MarkdownEditorTheme.colour(palette.background)
        scrollView.backgroundColor = textView.backgroundColor
        textView.insertionPointColor = MarkdownEditorTheme.colour(palette.link)
        textView.selectedTextAttributes = [.backgroundColor: MarkdownEditorTheme.colour(palette.selection),
                                           .foregroundColor: MarkdownEditorTheme.colour(palette.selectionText)]
        textView.currentLineColour = MarkdownEditorTheme.colour(palette.currentLine)
        textView.typingAttributes = [.font: MarkdownEditorTheme.font(presentation),
                                     .foregroundColor: MarkdownEditorTheme.colour(palette.text)]
        styling?.invalidate()
    }
}

/// The controller, not SwiftUI value updates, determines the native view's lifetime.
public struct MarkdownEditorTextSurface: NSViewRepresentable {
    public let controller: MarkdownEditorTextController
    public init(controller: MarkdownEditorTextController) { self.controller = controller }
    public func makeNSView(context: Context) -> NSView {
        let host = NSView()
        install(in: host)
        return host
    }
    public func updateNSView(_ view: NSView, context: Context) { install(in: view) }
    private func install(in host: NSView) {
        guard host.subviews.first !== controller.scrollView else { return }
        for previous in host.subviews { previous.removeFromSuperview() }
        controller.scrollView.removeFromSuperview()
        controller.scrollView.frame = host.bounds
        controller.scrollView.autoresizingMask = [.width, .height]
        host.addSubview(controller.scrollView)
    }
}
