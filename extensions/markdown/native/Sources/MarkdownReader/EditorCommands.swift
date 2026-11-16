import AppKit
import MarkdownCore
import SwiftUI

extension WorkingDocument {
    var previewHasFocus: Bool {
        if mode == .rendered { return true }
        guard mode == .split, let host = text.scrollView.superview as? EditorModeSplitView,
              let responder = host.window?.firstResponder as? NSView else { return false }
        return responder === host.preview || responder.isDescendant(of: host.preview)
    }

    @discardableResult func perform(_ command: MarkdownCommand, reportRefusal: Bool = true) -> Bool {
        guard !replacing, !text.hasMarkedText, mode != .rendered else {
            if reportRefusal { session.setError("Finish text composition and select an editable mode before this command.") }
            return false
        }
        let ranges: [NSRange]
        switch command {
        case .replace, .replaceAll, .inlineCode, .fencedCode: ranges = text.protectedRanges ?? []
        default:
            guard let current = text.protectedRanges else {
                if reportRefusal { session.setError("Source analysis is pending. Try the command again after it finishes.") }
                return false
            }
            ranges = current
        }
        let snapshot = text.snapshot
        guard let edit = MarkdownCommands.apply(command: command, to: snapshot.source, selection: snapshot.selectedRange, protectedRanges: ranges) else {
            if reportRefusal { session.setError("The command has no safe edit for this selection, or exceeds its bound.") }
            return false
        }
        let applied = text.apply(range: edit.range, replacement: edit.replacement, selection: edit.selection, actionName: edit.actionName)
        if applied {
            session.setError(nil)
            if findInSelection, let scope = findScope, findScopeGeneration == snapshot.generation {
                switch command {
                case .replace, .replaceAll:
                    findScope = NSRange(location: scope.location, length: scope.length + (edit.replacement as NSString).length - edit.range.length)
                    findScopeGeneration = text.generation
                default: break
                }
            }
            text.focus()
            if findVisible { refreshFind() }
        }
        return applied
    }

    var literalQuery: MarkdownLiteralQuery? {
        if findInSelection, findScope == nil || findScopeGeneration != text.generation { return nil }
        return MarkdownLiteralQuery(text: findText, caseSensitive: findCaseSensitive, wholeWord: findWholeWord, scope: findInSelection ? findScope : nil)
    }

    func showFind() {
        guard !text.hasMarkedText else { session.setError("Finish text composition before opening Find."); return }
        if mode == .rendered { setMode(.styled) }
        findVisible = true; refreshFind()
    }

    func captureFindSelection() {
        guard text.selectedRange.length > 0 else { findScope = nil; findSummary = "Select a source range first."; return }
        findScope = text.selectedRange; findScopeGeneration = text.generation
        refreshFind()
    }

    func refreshFind() {
        findTask?.cancel()
        guard let query = literalQuery else { findSummary = "The selection changed. Select a range and use Current Selection."; return }
        guard !query.text.isEmpty else { findSummary = ""; return }
        let snapshot = text.snapshot
        findTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            let count = await Task.detached { MarkdownCommands.matches(query, in: snapshot.source, limit: MarkdownCommands.matchLimit + 1).count }.value
            guard let self, !Task.isCancelled, self.text.generation == snapshot.generation, self.literalQuery == query else { return }
            self.findSummary = count > MarkdownCommands.matchLimit ? "\(MarkdownCommands.matchLimit)+ matches" : "\(count) matches"
        }
    }

    func find(backwards: Bool = false) {
        guard !text.hasMarkedText, let query = literalQuery, !query.text.isEmpty else { refreshFind(); return }
        let source = text.source as NSString
        let scope = query.scope ?? NSRange(location: 0, length: source.length)
        let selected = text.selectedRange
        var options: NSString.CompareOptions = [.literal]
        if !query.caseSensitive { options.insert(.caseInsensitive) }
        if backwards { options.insert(.backwards) }
        let caret = min(max(backwards ? selected.location : NSMaxRange(selected), scope.location), NSMaxRange(scope))
        let first = backwards ? NSRange(location: scope.location, length: caret - scope.location) : NSRange(location: caret, length: NSMaxRange(scope) - caret)
        let second = backwards ? NSRange(location: caret, length: NSMaxRange(scope) - caret) : NSRange(location: scope.location, length: caret - scope.location)
        for region in [first, second] {
            var remaining = region
            while remaining.length > 0 {
                let range = source.range(of: query.text, options: options, range: remaining)
                guard range.location != NSNotFound else { break }
                let exact = MarkdownLiteralQuery(text: query.text, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord, scope: range)
                if !MarkdownCommands.matches(exact, in: text.source, limit: 1).isEmpty {
                    text.select(range); text.focus(); return
                }
                remaining = backwards ? NSRange(location: region.location, length: range.location - region.location) : NSRange(location: NSMaxRange(range), length: NSMaxRange(region) - NSMaxRange(range))
            }
        }
        findSummary = "No matching text."
    }

    func replace(all: Bool) {
        guard let query = literalQuery, !query.text.isEmpty else { refreshFind(); return }
        if all { _ = perform(.replaceAll(query, with: replacementText)); return }
        var exact = query; exact.scope = text.selectedRange
        if MarkdownCommands.matches(exact, in: text.source, limit: 1).first?.range != text.selectedRange {
            find(); exact.scope = text.selectedRange
        }
        if let scope = query.scope {
            guard text.selectedRange.location >= scope.location, NSMaxRange(text.selectedRange) <= NSMaxRange(scope) else { return }
        }
        guard MarkdownCommands.matches(exact, in: text.source, limit: 1).first?.range == text.selectedRange else { return }
        _ = perform(.replace(exact, with: replacementText))
    }

    func goToLine() {
        guard !text.hasMarkedText, let line = Int(goToLineText), line > 0 else { return }
        text.goToLine(line); text.focus()
    }
}

struct EditorFindBar: View {
    @FocusState private var queryFocused: Bool
    @Bindable var document: WorkingDocument
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                TextField("Find literal text", text: $document.findText).focused($queryFocused).onSubmit { document.find() }
                Button("Previous") { document.find(backwards: true) }
                Button("Next") { document.find() }
                Button("Close", systemImage: "xmark") { document.findVisible = false; document.text.focus() }.labelStyle(.iconOnly)
            }
            HStack {
                TextField("Replace with", text: $document.replacementText)
                Button("Replace") { document.replace(all: false) }
                Button("Replace All") { document.replace(all: true) }
            }
            HStack {
                Toggle("Case", isOn: $document.findCaseSensitive)
                Toggle("Whole Word", isOn: $document.findWholeWord)
                Toggle("Selection", isOn: $document.findInSelection)
                if document.findInSelection { Button("Current Selection") { document.captureFindSelection() } }
                Text(document.findSummary).font(.caption).foregroundStyle(.secondary)
            }.toggleStyle(.checkbox)
        }.padding(8)
            .onAppear { queryFocused = true }
            .onChange(of: document.findText) { _, _ in document.refreshFind() }
            .onChange(of: document.findCaseSensitive) { _, _ in document.refreshFind() }
            .onChange(of: document.findWholeWord) { _, _ in document.refreshFind() }
            .onChange(of: document.findInSelection) { _, value in
                if value { document.captureFindSelection() } else { document.refreshFind() }
            }
    }
}

struct EditorCommandMenu: View {
    let document: WorkingDocument
    var body: some View {
        Menu {
            Menu("Heading") {
                ForEach(1...6, id: \.self) { level in Button("Heading \(level)") { document.perform(.heading(level)) } }
                Button("Plain Paragraph") { document.perform(.heading(0)) }
            }
            Button("Bold") { document.perform(.bold) }
            Button("Italic") { document.perform(.italic) }
            Button("Strikethrough") { document.perform(.strikethrough) }
            Button("Inline Code") { document.perform(.inlineCode) }
            Button("Code Block") { document.perform(.fencedCode(language: nil)) }
            Button("Quote") { document.perform(.quote) }
            Button("Unordered List") { document.perform(.unorderedList) }
            Button("Ordered List") { document.perform(.orderedList) }
            Button("Task List") { document.perform(.taskList) }
            Button("Link") { document.perform(.link) }
            Button("Table") { document.perform(.insertTable) }
            Divider()
            Button("Indent") { document.perform(.indent) }
            Button("Outdent") { document.perform(.outdent) }
            Button("Move Line Up") { document.perform(.moveLineUp) }
            Button("Move Line Down") { document.perform(.moveLineDown) }
            Button("Duplicate Line") { document.perform(.duplicateLine) }
        } label: { Label("Format", systemImage: "textformat") }
            .menuStyle(.borderlessButton).fixedSize().disabled(document.mode == .rendered)
    }
}
