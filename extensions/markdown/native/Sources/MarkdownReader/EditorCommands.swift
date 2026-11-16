import AppKit
import MarkdownCore
import SwiftUI

private enum PreparedReplacement: Sendable {
    case edit(MarkdownEdit, MarkdownCommand)
    case noMatch
    case refused
}

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
        return applyPrepared(edit, command: command, generation: snapshot.generation)
    }

    private func applyPrepared(_ edit: MarkdownEdit, command: MarkdownCommand, generation: UInt64) -> Bool {
        let applied = text.apply(range: edit.range, replacement: edit.replacement, selection: edit.selection, actionName: edit.actionName)
        if applied {
            session.setError(nil)
            if findInSelection, let scope = findScope, findScopeGeneration == generation {
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
        guard !closed else { return }
        if let query = literalQuery { findSummary = query.text.isEmpty ? "" : "Match count pending" }
        else { findSummary = "The selection changed. Select a range and use Current Selection." }
        findRequested = true
        guard findTask == nil else { return }
        findTask = Task { [weak self] in
            guard let self else { return }
            defer { findTask = nil }
            while findRequested, !Task.isCancelled {
                findRequested = false
                do { try await Task.sleep(for: .milliseconds(120)) } catch { break }
                if findRequested { continue }
                guard let query = literalQuery else { findSummary = "The selection changed. Select a range and use Current Selection."; continue }
                guard !query.text.isEmpty else { findSummary = ""; continue }
                let snapshot = text.snapshot
                let count = await Task.detached { MarkdownCommands.matches(query, in: snapshot.source, limit: MarkdownCommands.matchLimit + 1).count }.value
                guard !Task.isCancelled else { break }
                guard text.generation == snapshot.generation, literalQuery == query else { continue }
                findSummary = count > MarkdownCommands.matchLimit ? "\(MarkdownCommands.matchLimit)+ matches" : "\(count) matches"
            }
        }
    }

    @discardableResult func find(backwards: Bool = false) async -> Bool {
        guard !closed, !replacing, !searchBusy, !text.hasMarkedText, let query = literalQuery, !query.text.isEmpty else { refreshFind(); return false }
        searchBusy = true
        defer { searchBusy = false }
        let snapshot = text.snapshot, findWasVisible = findVisible
        let range = await Task.detached {
            Self.findRange(query, source: snapshot.source, selected: snapshot.selectedRange, backwards: backwards)
        }.value
        guard !Task.isCancelled, !closed, !replacing, visible, !text.hasMarkedText, mode != .rendered,
              text.generation == snapshot.generation, text.selectedRange == snapshot.selectedRange,
              findVisible == findWasVisible, literalQuery == query else { return false }
        guard let range else { findSummary = "No matching text."; return false }
        text.select(range); text.focus(); return true
    }

    nonisolated private static func findRange(_ query: MarkdownLiteralQuery, source value: String, selected: NSRange, backwards: Bool) -> NSRange? {
        let source = value as NSString
        let scope = query.scope ?? NSRange(location: 0, length: source.length)
        var options: NSString.CompareOptions = [.literal]
        if !query.caseSensitive { options.insert(.caseInsensitive) }
        if backwards { options.insert(.backwards) }
        let caret = min(max(backwards ? selected.location : NSMaxRange(selected), scope.location), NSMaxRange(scope))
        let first = backwards ? NSRange(location: scope.location, length: caret - scope.location) : NSRange(location: caret, length: NSMaxRange(scope) - caret)
        let second = backwards ? NSRange(location: caret, length: NSMaxRange(scope) - caret) : NSRange(location: scope.location, length: caret - scope.location)
        for region in [first, second] {
            if !backwards {
                var scoped = query; scoped.scope = region
                if let match = MarkdownCommands.matches(scoped, in: value, limit: 1).first { return match.range }
                continue
            }
            var remaining = region
            while remaining.length > 0 {
                let range = source.range(of: query.text, options: options, range: remaining)
                guard range.location != NSNotFound else { break }
                let exact = MarkdownLiteralQuery(text: query.text, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord, scope: range)
                if !MarkdownCommands.matches(exact, in: value, limit: 1).isEmpty {
                    return range
                }
                remaining = backwards ? NSRange(location: region.location, length: range.location - region.location) : NSRange(location: NSMaxRange(range), length: NSMaxRange(region) - NSMaxRange(range))
            }
        }
        return nil
    }

    func replace(all: Bool) async {
        guard !closed, !searchBusy, !replacing, !text.hasMarkedText, mode != .rendered,
              let query = literalQuery, !query.text.isEmpty else { refreshFind(); return }
        let replacement = replacementText, findWasVisible = findVisible
        searchBusy = true
        defer { searchBusy = false }
        let snapshot = text.snapshot
        let prepared = await Task.detached { () -> PreparedReplacement in
            var exact = query; exact.scope = snapshot.selectedRange
            if !all {
                if MarkdownCommands.matches(exact, in: snapshot.source, limit: 1).first?.range != snapshot.selectedRange {
                    guard let match = Self.findRange(query, source: snapshot.source, selected: snapshot.selectedRange, backwards: false) else { return .noMatch }
                    exact.scope = match
                }
                if let scope = query.scope, let selected = exact.scope {
                    guard selected.location >= scope.location, NSMaxRange(selected) <= NSMaxRange(scope) else { return .noMatch }
                }
            }
            let command: MarkdownCommand = all ? .replaceAll(query, with: replacement) : .replace(exact, with: replacement)
            guard let edit = MarkdownCommands.apply(command: command, to: snapshot.source, selection: snapshot.selectedRange, protectedRanges: []) else { return .refused }
            return .edit(edit, command)
        }.value
        guard !Task.isCancelled, !closed, visible, !replacing, !text.hasMarkedText, mode != .rendered,
              text.generation == snapshot.generation, text.selectedRange == snapshot.selectedRange,
              literalQuery == query, replacementText == replacement, findVisible == findWasVisible else { return }
        switch prepared {
        case .noMatch: findSummary = "No matching text."
        case .refused: session.setError("The replacement has no safe edit, or exceeds its bound.")
        case .edit(let edit, let command): _ = applyPrepared(edit, command: command, generation: snapshot.generation)
        }
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
                TextField("Find literal text", text: $document.findText).focused($queryFocused).onSubmit { Task { await document.find() } }
                Button("Previous") { Task { await document.find(backwards: true) } }.disabled(document.searchBusy)
                Button("Next") { Task { await document.find() } }.disabled(document.searchBusy)
                Button("Close", systemImage: "xmark") { document.findVisible = false; document.text.focus() }.labelStyle(.iconOnly)
            }
            HStack {
                TextField("Replace with", text: $document.replacementText)
                Button("Replace") { Task { await document.replace(all: false) } }.disabled(document.searchBusy)
                Button("Replace All") { Task { await document.replace(all: true) } }.disabled(document.searchBusy)
            }
            HStack {
                Toggle("Case", isOn: $document.findCaseSensitive)
                Toggle("Whole Word", isOn: $document.findWholeWord)
                Toggle("Selection", isOn: $document.findInSelection)
                if document.findInSelection { Button("Current Selection") { document.captureFindSelection() } }
                Text(document.searchBusy ? "Search or replacement in progress" : document.findSummary).font(.caption).foregroundStyle(.secondary)
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
