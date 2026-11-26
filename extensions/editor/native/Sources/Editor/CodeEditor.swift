import AppKit

@MainActor
final class CodeEditor: NSObject, NSTextViewDelegate {
    private let api: any EditorAPI
    private let scroll = CodeScrollView()
    private let textView = CodeTextView(usingTextLayoutManager: false)
    private let undoHistory = UndoManager()
    private var sharedText: String
    private var sharedDirty: Bool
    private var editGeneration = 0
    private var pending = false
    private var debounce: Task<Void, Never>?
    private var stopped = false
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var view: NSView { scroll }
    private(set) var doc: String
    private(set) var revision: Int
    private(set) var title: String
    var hasPending: Bool { pending || textView.hasMarkedText() }
    var dirty: Bool { sharedDirty || hasPending }
    private(set) var conflicted = false
    private(set) var diskConflict: Bool
    var onStatus: ((String) -> Void)?
    var onChange: (() -> Void)?
    var onNote: ((Fields) -> Void)?

    init(api: any EditorAPI, record: Fields) {
        self.api = api
        doc = record["doc"] as? String ?? ""
        revision = record["rev"] as? Int ?? 0
        title = record["title"] as? String ?? "Untitled"
        sharedText = record["text"] as? String ?? ""
        sharedDirty = record["dirty"] as? Bool ?? false
        diskConflict = record["diskChanged"] as? Bool ?? false
        super.init()

        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.documentView = textView
        textView.isRichText = false
        textView.isVerticallyResizable = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 12, height: 10)
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticTextCompletionEnabled = false
        textView.usesFindBar = true
        textView.setAccessibilityLabel("Source editor")
        textView.layoutManager?.allowsNonContiguousLayout = true
        textView.string = sharedText
        setWrap(false)
        textView.setSyntax(for: doc)
        textView.delegate = self
        textView.noteTarget = { [weak self] range in self?.noteItem(range) }
    }

    func focus() { textView.window?.makeFirstResponder(textView) }

    func find() {
        let item = NSMenuItem()
        item.tag = NSTextFinder.Action.showFindInterface.rawValue
        focus()
        textView.performTextFinderAction(item)
    }

    func setWrap(_ value: Bool) {
        scroll.hasHorizontalScroller = !value
        textView.isHorizontallyResizable = !value
        textView.autoresizingMask = value ? [.width] : []
        textView.textContainer?.widthTracksTextView = value
        textView.textContainer?.containerSize = NSSize(
            width: value ? max(1, scroll.contentSize.width - 2 * textView.textContainerInset.width) : .greatestFiniteMagnitude,
            height: .greatestFiniteMagnitude
        )
        if value {
            textView.setFrameSize(NSSize(width: scroll.contentSize.width, height: textView.frame.height))
            scroll.contentView.scroll(to: NSPoint(x: 0, y: scroll.contentView.bounds.minY))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
    }

    func go(line: Int) {
        guard line > 0, let source = textView.textStorage?.mutableString else { return }
        let length = source.length
        var offset = 0
        var remaining = line - 1
        while remaining > 0 && offset < length {
            let newline = source.range(of: "\n", options: .literal, range: NSRange(location: offset, length: length - offset))
            offset = newline.location == NSNotFound ? length : NSMaxRange(newline)
            remaining -= 1
        }
        let range = NSRange(location: offset, length: 0)
        textView.setSelectedRange(range)
        textView.scrollRangeToVisible(range)
    }

    func undoManager(for view: NSTextView) -> UndoManager? { undoHistory }

    func textDidChange(_ notification: Notification) {
        guard !stopped else { return }
        let firstPendingEdit = !pending
        pending = true
        editGeneration += 1
        textView.invalidateSyntax()
        if firstPendingEdit { onChange?() }
        scheduleFlush()
    }

    func stop() {
        stopped = true
        debounce?.cancel()
        debounce = nil
        onStatus = nil
        onChange = nil
        onNote = nil
    }

    func flush() async throws {
        try await exclusively { try await flushDraft() }
    }

    func save(path: String?) async throws {
        try await exclusively {
            try await flushDraft()
            if diskConflict && path == nil { throw Self.diskChangedIssue }
            var fields: Fields = ["doc": doc, "rev": revision]
            fields["path"] = path
            let result: Fields
            do {
                result = try await request("save", fields)
            } catch let error as EditorIssue where error.code == "conflict" && path == nil {
                // Save uses the same conflict code for a new revision and for a changed disk file.
                do {
                    let latest = try await readCurrent()
                    if latest["unchanged"] as? Bool == true {
                        setDiskConflict(latest["diskChanged"] as? Bool ?? true)
                    } else {
                        try adoptRead(latest)
                    }
                } catch let readError as EditorIssue where readError.code == "not_found" {
                    setDiskConflict(true)
                } catch let readError {
                    throw EditorIssue(code: error.code, message: "\(error.localizedDescription). Editor could not recheck the draft: \(readError.localizedDescription)")
                }
                throw error
            }
            let record = try CodeDraftRecord(result)
            guard record.text.utf8.elementsEqual(sharedText.utf8) else { throw Self.invalidResponse }
            let changedFile = doc != record.doc
            adoptMetadata(record)
            if changedFile { textView.setSyntax(for: doc) }
            onChange?()
        }
    }

    func refresh() async throws {
        try await exclusively {
            let latest = try await readCurrent()
            if latest["unchanged"] as? Bool == true {
                let wasDirty = dirty
                sharedDirty = latest["dirty"] as? Bool ?? sharedDirty
                let changedDisk = setDiskConflict(latest["diskChanged"] as? Bool ?? false)
                if !changedDisk && wasDirty != dirty { onChange?() }
                if pending && !conflicted && !textView.hasMarkedText() { try await flushDraft() }
                return
            }
            try adoptRead(latest)
        }
    }

    func discardLocalChanges(ifMatching expected: String? = nil) async throws {
        try await exclusively {
            try requireCommittedInput()
            if let expected, !textView.string.utf8.elementsEqual(expected.utf8) { throw Self.changedDiscardIssue }
            let generation = editGeneration
            let latest = try CodeDraftRecord(await request("read", ["doc": doc]))
            guard generation == editGeneration && !textView.hasMarkedText() else { throw Self.changedDiscardIssue }
            install(latest)
        }
    }

    func recoverAsScratch() async throws -> Fields {
        try await exclusively {
            try requireCommittedInput()
            let text = textView.string
            try Self.requireUnixNewlines(text)
            var scratch = try await request("new", [:])
            let record = try CodeDraftRecord(scratch)
            guard record.doc.hasPrefix("scratch:"), record.text.isEmpty else { throw Self.invalidResponse }
            if !text.isEmpty {
                let patch = try await request("patch", ["doc": record.doc, "rev": record.rev, "start": 0, "end": 0, "text": text])
                guard patch["doc"] as? String == record.doc, let rev = patch["rev"] as? Int, rev > record.rev else {
                    throw Self.invalidResponse
                }
                scratch["rev"] = rev
                scratch["dirty"] = patch["dirty"] as? Bool ?? true
                scratch["text"] = text
            }
            return scratch
        }
    }

    private func scheduleFlush() {
        debounce?.cancel()
        guard !conflicted else { return }
        debounce = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(260)) } catch { return }
            guard let self else { return }
            self.debounce = nil
            guard !self.textView.hasMarkedText() else { return }
            do { try await self.flush() }
            catch is CancellationError { }
            catch { self.onStatus?(error.localizedDescription) }
        }
    }

    private func exclusively<T>(_ operation: () async throws -> T) async throws -> T {
        if busy { await withCheckedContinuation { waiters.append($0) } }
        else { busy = true }
        defer {
            if waiters.isEmpty { busy = false }
            else { waiters.removeFirst().resume() }
        }
        try checkOpen()
        return try await operation()
    }

    private func checkOpen() throws {
        try Task.checkCancellation()
        if stopped { throw CancellationError() }
    }

    private func request(_ op: String, _ fields: Fields) async throws -> Fields {
        try checkOpen()
        return try await api.call(op, fields)
    }

    private func readCurrent() async throws -> Fields {
        try await request("read", ["doc": doc, "ifRev": revision])
    }

    private func requireCommittedInput() throws {
        if textView.hasMarkedText() {
            throw EditorIssue(code: "composition", message: "Finish text input before you use this action.")
        }
    }

    private func flushDraft() async throws {
        try requireCommittedInput()
        // The text view is the only mutable buffer. A patch acknowledges its snapshot,
        // never a later keystroke, and must not replace the displayed text.
        while pending {
            if conflicted { throw Self.draftChangedIssue }
            let generation = editGeneration
            let text = textView.string
            let patch = await CodePatch.between(sharedText, text)
            if let patch {
                try Self.requireUnixNewlines(patch.text)
                do {
                    let result = try await request("patch", ["doc": doc, "rev": revision, "start": patch.start,
                                                             "end": patch.end, "text": patch.text])
                    guard result["doc"] as? String == doc, let rev = result["rev"] as? Int, rev > revision else {
                        throw Self.invalidResponse
                    }
                    revision = rev
                    sharedText = text
                    sharedDirty = result["dirty"] as? Bool ?? true
                } catch let error as EditorIssue where error.code == "conflict" {
                    conflicted = true
                    onChange?()
                    throw Self.draftChangedIssue
                }
            }
            pending = generation != editGeneration
            onChange?()
            try requireCommittedInput()
        }
    }

    private func adoptMetadata(_ record: CodeDraftRecord) {
        doc = record.doc
        revision = record.rev
        title = record.title
        sharedText = record.text
        sharedDirty = record.dirty
        diskConflict = record.diskChanged
    }

    @discardableResult
    private func setDiskConflict(_ value: Bool) -> Bool {
        guard value != diskConflict else { return false }
        diskConflict = value
        onChange?()
        return true
    }

    private func adoptRead(_ fields: Fields) throws {
        let record = try CodeDraftRecord(fields)
        if hasPending {
            if textView.hasMarkedText() {
                // Query again once AppKit commits or cancels the marked segment.
                return
            }
            let local = textView.string
            if local.utf8.elementsEqual(record.text.utf8) {
                adoptMetadata(record)
                pending = false
                conflicted = false
                onChange?()
                return
            }
            if !local.utf8.elementsEqual(sharedText.utf8) {
                let notify = !conflicted || diskConflict != record.diskChanged
                conflicted = true
                diskConflict = record.diskChanged
                if notify { onChange?() }
                return
            }
        }
        install(record)
    }

    private func install(_ record: CodeDraftRecord) {
        let text = textView.string
        let replaced = !text.utf8.elementsEqual(record.text.utf8)
        let changedFile = doc != record.doc
        if replaced {
            let selection = textView.selectedRange()
            let origin = scroll.contentView.bounds.origin
            textView.string = record.text
            textView.invalidateSyntax()
            let source = record.text as NSString
            let start = Self.scalarBoundary(min(selection.location, source.length), source)
            let end = Self.scalarBoundary(min(NSMaxRange(selection), source.length), source)
            textView.setSelectedRange(NSRange(location: start, length: end - start))
            scroll.contentView.scroll(to: origin)
            scroll.reflectScrolledClipView(scroll.contentView)
            undoHistory.removeAllActions()
            editGeneration += 1
        }
        adoptMetadata(record)
        if changedFile { textView.setSyntax(for: doc) }
        pending = false
        conflicted = false
        onChange?()
    }

    private func noteItem(_ range: NSRange) -> NSMenuItem? {
        guard onNote != nil, range.length > 0, range.length <= 8192, !conflicted else { return nil }
        let item = NSMenuItem(title: "Add Note…", action: #selector(addNote(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = NoteAnchor(doc: doc, generation: editGeneration, range: range)
        return item
    }

    private struct NoteAnchor {
        let doc: String
        let generation: Int
        let range: NSRange
    }

    @objc private func addNote(_ item: NSMenuItem) {
        guard let anchor = item.representedObject as? NoteAnchor else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.exclusively {
                    try self.checkAnchor(anchor)
                    try await self.flushDraft()
                    try self.checkAnchor(anchor)
                    let source = self.sharedText as NSString
                    let start = Self.scalarBoundary(anchor.range.location, source)
                    let end = Self.scalarBoundary(NSMaxRange(anchor.range), source)
                    guard start == anchor.range.location, end == NSMaxRange(anchor.range), end <= source.length else {
                        throw Self.changedAnchorIssue
                    }
                    self.onNote?(["doc": self.doc, "rev": self.revision, "start": start, "end": end])
                }
            } catch { self.onStatus?(error.localizedDescription) }
        }
    }

    private func checkAnchor(_ anchor: NoteAnchor) throws {
        try checkOpen()
        guard anchor.doc == doc, anchor.generation == editGeneration else { throw Self.changedAnchorIssue }
    }

    private static func requireUnixNewlines(_ text: String) throws {
        if text.utf8.contains(13) {
            throw EditorIssue(code: "invalid", message: "Replace carriage returns with line breaks before you share this draft.")
        }
    }

    private static func scalarBoundary(_ offset: Int, _ source: NSString) -> Int {
        guard offset > 0, offset < source.length, (0xdc00...0xdfff).contains(source.character(at: offset)) else { return offset }
        return offset - 1
    }

    private static let changedDiscardIssue = EditorIssue(code: "changed", message: "The local text changed. Review the draft before you discard it.")
    private static let changedAnchorIssue = EditorIssue(code: "changed", message: "The text changed. Select it again to add a note.")
    private static let draftChangedIssue = EditorIssue(code: "conflict", message: "The shared draft changed. Your local text was kept.")
    private static let diskChangedIssue = EditorIssue(code: "conflict", message: "The disk file changed. Save As keeps both versions.")
    private static let invalidResponse = EditorIssue(code: "response", message: "Pi returned an invalid draft response.")
}

private struct CodeDraftRecord {
    let doc: String
    let rev: Int
    let title: String
    let dirty: Bool
    let text: String
    let diskChanged: Bool

    init(_ fields: Fields) throws {
        guard let doc = fields["doc"] as? String, let rev = fields["rev"] as? Int, let title = fields["title"] as? String,
              let dirty = fields["dirty"] as? Bool, let text = fields["text"] as? String else {
            throw EditorIssue(code: "response", message: "Pi did not return a complete draft.")
        }
        self.doc = doc
        self.rev = rev
        self.title = title
        self.dirty = dirty
        self.text = text
        diskChanged = fields["diskChanged"] as? Bool ?? false
    }
}

struct CodePatch: Equatable, Sendable {
    let start: Int
    let end: Int
    let text: String

    @concurrent
    static func between(_ previous: String, _ next: String) async -> Self? {
        let old = Array(previous.utf16)
        let new = Array(next.utf16)
        let common = min(old.count, new.count)
        var start = 0
        while start < common && old[start] == new[start] { start += 1 }
        if start == old.count && start == new.count { return nil }
        func splitsScalar(_ units: [UInt16], _ index: Int) -> Bool {
            index < units.count && (0xdc00...0xdfff).contains(units[index])
        }
        if splitsScalar(old, start) || splitsScalar(new, start) { start -= 1 }
        var oldEnd = old.count
        var newEnd = new.count
        while oldEnd > start && newEnd > start && old[oldEnd - 1] == new[newEnd - 1] {
            oldEnd -= 1
            newEnd -= 1
        }
        if splitsScalar(old, oldEnd) || splitsScalar(new, newEnd) {
            oldEnd += 1
            newEnd += 1
        }
        return Self(start: start, end: oldEnd, text: String(decoding: new[start..<newEnd], as: UTF16.self))
    }
}
