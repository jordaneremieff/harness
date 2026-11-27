import AppKit

@MainActor
final class CodeEditor: NSObject, NSTextViewDelegate {
    private let api: any EditorAPI
    let scroll = CodeScrollView()
    let textView = CodeTextView(usingTextLayoutManager: false)
    private let undoHistory = UndoManager()
    private var sharedText: String
    private var sharedDirty: Bool
    private var editGeneration = 0
    private var pending = false
    private var refreshAfterComposition = false
    private var debounce: Task<Void, Never>?
    private var stopped = false
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var gitBase: String?
    private var decorationTimer: Timer?
    private var decorationTask: Task<Void, Never>?
    private var decorationRevision = 0
    private var chosenIndentation: (spaces: Bool, width: Int)?
    private var detectedIndentation: (spaces: Bool, width: Int)?

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
    var onAsk: ((TrackedDraftRange) -> Void)?
    var onReviewChange: (() -> Void)?
    let revisionMap = DraftRevisionMap()
    private var visibleThreadAnchors: [CodeThreadAnchor] = []
    private(set) var reviews: [DraftChangeReview] = []
    /// Runs after the selection or the insertion point moves.
    var onSelectionChange: (() -> Void)?
    /// The indentation that typing uses in this file: spaces or tabs, and the width of one level.
    var indentation: (spaces: Bool, width: Int) { textView.indentation }
    private(set) var changeMarks: [CodeChangeMark] = []
    var onChangeMarks: (() -> Void)?

    init(api: any EditorAPI, record: Fields) {
        self.api = api
        doc = record["doc"] as? String ?? ""
        revision = record["rev"] as? Int ?? 0
        title = record["title"] as? String ?? "Untitled"
        sharedText = record["text"] as? String ?? ""
        sharedDirty = record["dirty"] as? Bool ?? false
        diskConflict = record["diskChanged"] as? Bool ?? false
        super.init()
        undoHistory.groupsByEvent = false

        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.contentView = CodeClipView()
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
        // Assigning the text leaves the insertion point at its end, outside the first screen.
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        setWrap(false)
        textView.syntax.colours = { role in WorkspaceStyle.theme.syntax("\(role)") }
        textView.setSyntax(for: doc)
        textView.attachSource()
        textView.delegate = self
        textView.selectionChanged = { [weak self] in self?.onSelectionChange?() }
        textView.selectionCharacters.onReady = { [weak self] in self?.onSelectionChange?() }
        textView.noteTarget = { [weak self] range in self?.noteItem(range, asking: false) }
        textView.askTarget = { [weak self] range in self?.noteItem(range, asking: true) }
        textView.onCompositionEnd = { [weak self] in self?.resumeDeferredRefresh() }
        textView.onCoordinateEdit = { [weak self] edit in
            guard let self else { return }
            revisionMap.edit(edit)
            if !textView.threadMarks.isEmpty { scroll.gutter.needsDisplay = true }
        }
        scroll.bindSourceMargins(to: textView)
        scheduleDecorations(immediate: true)
    }

    /// The language of the file, such as `markdown`, for per-language settings; nil for plain text.
    var languageID: String? {
        let id = textView.syntax.engine.language.id
        return id == "plain" ? nil : id
    }

    var languageName: String { textView.syntax.engine.language.displayName }
    var selectionCount: Int { textView.selections.count }
    var selectedCharacterCount: Int? {
        guard let storage = textView.textStorage else { return 0 }
        return textView.selectionCharacters.count(in: storage, ranges: textView.sourceSelections)
    }

    /// The 1-based line and display column of the primary insertion point.
    var caretPosition: (line: Int, column: Int) {
        let caret = min(textView.selections.last?.head ?? 0, findText.length)
        return (textView.line(at: caret) + 1, textView.displayColumn(at: caret) + 1)
    }

    func chooseLanguage(_ id: String?) {
        textView.syntax.engine.chooseLanguage(id)
        textView.invalidateSyntax()
        scheduleDecorations(immediate: true)
        onSelectionChange?()
    }

    func chooseIndentation(spaces: Bool, width: Int) {
        chosenIndentation = (spaces, min(16, max(1, width)))
        applyIndentation()
        scheduleDecorations(immediate: true)
        onSelectionChange?()
    }

    func convertIndentation(spaces: Bool) {
        let changes = textView.indentationEdits(spaces: spaces)
        if changes.isEmpty || textView.edit(changes, reveal: false) { chooseIndentation(spaces: spaces, width: indentation.width) }
    }

    func relocate(to path: String) {
        doc = path
        title = (path as NSString).lastPathComponent
        textView.setSyntax(for: path)
        setBaseText(nil)
        onSelectionChange?()
        onChange?()
    }

    /// The text of the file in the last Git commit, for change marks; nil when it has none.
    func setBaseText(_ text: String?) {
        guard gitBase != text else { return }
        gitBase = text
        publishChangeMarks([])
        scheduleDecorations(immediate: true)
    }

    func moveToChange(direction: Int) {
        let line = caretPosition.line - 1
        let target = direction > 0 ? changeMarks.first { $0.line > line } ?? changeMarks.first
            : changeMarks.last { $0.line < line } ?? changeMarks.last
        if let target { go(line: target.line + 1) }
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        if !textView.settingSelections { onSelectionChange?() }
    }

    /// Applies the font, colours and view settings of this file's language.
    func apply(settings: EditorSettings, theme: EditorTheme) {
        let previous = textView.sourceSettings
        textView.sourceSettings = settings
        textView.sourceTheme = theme
        let font = settings.sourceFont
        if textView.font != font { textView.font = font }
        textView.spaceWidth = (" " as NSString).size(withAttributes: [.font: font]).width
        scroll.backgroundColor = theme.editor
        textView.backgroundColor = theme.editor
        if textView.textColor != theme.text { textView.textColor = theme.text }
        textView.insertionPointColor = theme.caret
        textView.selectedTextAttributes = [.backgroundColor: theme.selection]
        applyIndentation()
        textView.typingAttributes[.font] = font
        textView.typingAttributes[.foregroundColor] = theme.text
        if textView.layoutSpacing != settings.lineSpacing {
            textView.layoutSpacing = settings.lineSpacing
            let all = NSRange(location: 0, length: findText.length)
            if all.length > 0 { textView.layoutManager?.invalidateLayout(forCharacterRange: all, actualCharacterRange: nil) }
        }
        setWrap(settings.wordWrap)
        scroll.tile()
        textView.invalidateAdornment()
        textView.invalidateSyntax()
        if previous.minimap != settings.minimap || previous.tabSize != settings.tabSize { scheduleDecorations(immediate: true) }
    }

    private func applyIndentation() {
        let settings = textView.sourceSettings
        let defaults = (spaces: settings.indentWithSpaces, width: settings.tabSize)
        if settings.detectIndentation, detectedIndentation == nil {
            detectedIndentation = textView.detectedIndentation(fallback: defaults)
        }
        textView.indentation = chosenIndentation ?? (settings.detectIndentation ? detectedIndentation : nil) ?? defaults
        let style = NSMutableParagraphStyle()
        style.defaultTabInterval = CGFloat(indentation.width) * textView.spaceWidth
        style.tabStops = []
        if textView.defaultParagraphStyle != style {
            textView.defaultParagraphStyle = style
            textView.typingAttributes[.paragraphStyle] = style
            if let storage = textView.textStorage, storage.length > 0 {
                storage.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: storage.length))
            }
        }
        textView.invalidateAdornment()
    }

    func focus() { textView.window?.makeFirstResponder(textView) }
    var hasFocus: Bool { textView.window?.firstResponder === textView }

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
        guard line > 0 else { return }
        let offset = line > textView.lineCount ? findText.length : textView.lineRange(line - 1).location
        let range = NSRange(location: offset, length: 0)
        textView.unfold(intersecting: range)
        textView.select([range], reveal: range)
    }

    private func publishChangeMarks(_ marks: [CodeChangeMark]) {
        guard changeMarks != marks else { return }
        changeMarks = marks
        let entries = Dictionary(marks.map { ($0.line, $0.kind) }, uniquingKeysWith: { first, _ in first })
        scroll.setChanges(entries)
        onChangeMarks?()
    }

    private func scheduleDecorations(immediate: Bool = false) {
        decorationRevision += 1
        decorationTask?.cancel()
        decorationTask = nil
        if immediate || stopped || (gitBase == nil && !textView.sourceSettings.minimap) {
            decorationTimer?.invalidate()
            decorationTimer = nil
        }
        guard !stopped, gitBase != nil || textView.sourceSettings.minimap else { return }
        if immediate { refreshDecorations(); return }
        if let decorationTimer { decorationTimer.fireDate = Date(timeIntervalSinceNow: 0.16); return }
        let timer = Timer(timeInterval: 0.16, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshDecorations() }
        }
        RunLoop.main.add(timer, forMode: .common)
        decorationTimer = timer
    }

    private func refreshDecorations() {
        decorationTimer = nil
        let generation = decorationRevision
        let snapshot = textView.string
        let base = gitBase
        let drawMap = textView.sourceSettings.minimap
        let language = textView.syntax.engine.language.id
        let tabWidth = indentation.width
        decorationTask = Task { [weak self] in
            let compute = Task.detached(priority: .utility) {
                let marks = base.map { CodeChangeDiff.between(base: $0, current: snapshot) } ?? []
                let map = drawMap ? CodeMapRow.overview(snapshot, language: language, tabWidth: tabWidth) : []
                return (marks, map)
            }
            let (marks, map) = await withTaskCancellationHandler(operation: { await compute.value }, onCancel: { compute.cancel() })
            guard !Task.isCancelled, let self, decorationRevision == generation else { return }
            publishChangeMarks(marks)
            scroll.minimap.rows = map
            scroll.minimap.needsDisplay = true
        }
    }

    func undoManager(for view: NSTextView) -> UndoManager? { undoHistory }

    func textDidChange(_ notification: Notification) {
        guard !stopped else { return }
        let firstPendingEdit = !pending
        pending = true
        editGeneration += 1
        textView.invalidateSyntax()
        textView.caretOverlay?.synchronize(restart: true)
        scheduleDecorations()
        if firstPendingEdit { onChange?() }
        resumeDeferredRefresh()
        scheduleFlush()
    }

    func stop() {
        stopped = true
        debounce?.cancel()
        debounce = nil
        decorationTimer?.invalidate()
        decorationTimer = nil
        decorationTask?.cancel()
        decorationTask = nil
        onStatus = nil
        onChange = nil
        onNote = nil
        onAsk = nil
        onReviewChange = nil
        onChangeMarks = nil
        onSelectionChange = nil
        textView.selectionCharacters.invalidate()
    }

    func flush() async throws {
        try await exclusively { try await flushDraft() }
    }

    func save(path: String?, replacement: String? = nil) async throws {
        try await exclusively {
            try requireCommittedInput()
            if conflicted { throw Self.draftChangedIssue }
            if diskConflict && path == nil {
                try await flushDraft()
                throw Self.diskChangedIssue
            }
            let settings = textView.sourceSettings
            let cleanup = textView.cleanupEdits(trim: settings.trimTrailingWhitespaceOnSave, newline: settings.ensureNewlineAtEndOnSave)
            if !cleanup.isEmpty && !textView.edit(cleanup, reveal: false) {
                throw EditorIssue(code: "edit", message: "The source refused the save cleanup.")
            }
            try await flushDraft()
            var fields: Fields = ["doc": doc, "rev": revision]
            fields["path"] = path
            fields["replace"] = replacement
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
                        try await adoptRead(latest)
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
            if changedFile {
                textView.setSyntax(for: doc)
                setBaseText(nil)
                scheduleDecorations(immediate: true)
            }
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
            try await adoptRead(latest)
        }
    }

    func discardLocalChanges(ifMatching expected: String? = nil) async throws {
        try await exclusively {
            try requireCommittedInput()
            if let expected, !textView.string.utf8.elementsEqual(expected.utf8) { throw Self.changedDiscardIssue }
            let generation = editGeneration
            let latest = try CodeDraftRecord(await request("read", ["doc": doc]))
            guard generation == editGeneration && !textView.hasMarkedText() else { throw Self.changedDiscardIssue }
            try await install(latest, discardGeneration: generation)
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
            let count = revisionMap.pending.count
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
                    revisionMap.commit(from: revision, to: rev, count: count)
                    revision = rev
                    sharedText = text
                    sharedDirty = result["dirty"] as? Bool ?? true
                } catch let error as EditorIssue where error.code == "conflict" {
                    conflicted = true
                    onChange?()
                    throw Self.draftChangedIssue
                }
            } else {
                revisionMap.commit(from: revision, to: revision, count: count)
            }
            pending = generation != editGeneration
            onChange?()
            try requireCommittedInput()
        }
    }

    private func adoptMetadata(_ record: CodeDraftRecord) {
        if doc != record.doc { revisionMap.abandon() }
        else { revisionMap.commit(from: revision, to: record.rev) }
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

    private func adoptRead(_ fields: Fields) async throws {
        let record = try CodeDraftRecord(fields)
        if hasPending {
            if textView.hasMarkedText() {
                refreshAfterComposition = true
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
        try await install(record)
    }

    private func resumeDeferredRefresh() {
        guard refreshAfterComposition, !textView.hasMarkedText(), !stopped else { return }
        refreshAfterComposition = false
        Task { [weak self] in
            guard let self else { return }
            do { try await refresh() }
            catch { onStatus?(error.localizedDescription) }
        }
    }

    private func install(_ record: CodeDraftRecord, discardGeneration: Int? = nil) async throws {
        let before = textView.string
        let generation = editGeneration
        let changes: [DraftTextChange]
        if max(before.utf8.count, record.text.utf8.count) < 32_768 {
            changes = DraftTextChange.between(before, record.text)
        } else {
            let after = record.text
            changes = await Task.detached(priority: .userInitiated) { DraftTextChange.between(before, after) }.value
        }
        try checkOpen()
        if let discardGeneration, discardGeneration != editGeneration || textView.hasMarkedText() { throw Self.changedDiscardIssue }
        if discardGeneration == nil, generation != editGeneration || textView.hasMarkedText() {
            if textView.hasMarkedText() { refreshAfterComposition = true; return }
            if textView.string.utf8.elementsEqual(record.text.utf8) {
                adoptMetadata(record)
                pending = false
                conflicted = false
            } else {
                conflicted = true
                diskConflict = record.diskChanged
            }
            onChange?()
            return
        }
        let changedFile = doc != record.doc
        if !changes.isEmpty {
            textView.breakUndoCoalescing()
            textView.applyDraftChanges(changes)
            let review = DraftChangeReview(author: record.author ?? "External edit", changes: changes, before: before,
                                           after: record.text, track: revisionMap.track)
            reviews.insert(review, at: 0)
            while reviews.count > 12 || (reviews.count > 1 && reviews.reduce(0, { $0 + $1.byteCount }) > 4 * 1024 * 1024) {
                reviews.removeLast()
            }
            registerUndo(inverse(of: changes), name: "External Change", removeReview: review.id)
            updateReviewMarks()
            textView.invalidateSyntax()
            detectedIndentation = nil
            applyIndentation()
            editGeneration += 1
        }
        adoptMetadata(record)
        if changedFile { textView.setSyntax(for: doc); setBaseText(nil) }
        if !changes.isEmpty || changedFile { scheduleDecorations(immediate: true) }
        pending = false
        conflicted = false
        onChange?()
    }

    func undoReview(_ review: DraftChangeReview) {
        guard !textView.hasMarkedText(), !conflicted,
              reviews.contains(where: { $0 === review }), let changes = review.inverse(in: textView.source) else {
            onStatus?("This change overlaps later edits. Review the text before you reverse it.")
            return
        }
        applyUndo(changes, name: "Reverse External Change", removeReview: review.id)
    }

    func dismissReview(_ review: DraftChangeReview) {
        reviews.removeAll { $0 === review }
        updateReviewMarks()
    }

    private func updateReviewMarks() {
        textView.reviewMarks = reviews.flatMap { $0.hunks.map(\.span) }
        textView.setNeedsDisplay(textView.visibleRect)
        onReviewChange?()
    }

    private func inverse(of changes: [DraftTextChange]) -> [DraftTextChange] {
        var shift = 0
        return changes.map { change in
            let range = NSRange(location: change.range.location + shift, length: change.newText.utf16.count)
            shift += change.delta
            return DraftTextChange(range: range, oldText: change.newText, newText: change.oldText)
        }
    }

    private func registerUndo(_ changes: [DraftTextChange], name: String, removeReview: UUID? = nil) {
        let manager = undoHistory
        let group = !manager.isUndoing && !manager.isRedoing
        if group {
            textView.finishInputUndo()
            textView.breakUndoCoalescing()
            manager.beginUndoGrouping()
        }
        manager.registerUndo(withTarget: self) { target in
            MainActor.assumeIsolated { target.applyUndo(changes, name: name, removeReview: removeReview) }
        }
        manager.setActionName(name)
        if group { manager.endUndoGrouping() }
    }

    private func applyUndo(_ changes: [DraftTextChange], name: String, removeReview: UUID?) {
        guard !textView.hasMarkedText(), !conflicted,
              changes.allSatisfy({ NSMaxRange($0.range) <= textView.source.length &&
                  textView.source.substring(with: $0.range).utf8.elementsEqual($0.oldText.utf8) }) else {
            onStatus?("The text changed. This edit was not reversed.")
            return
        }
        registerUndo(inverse(of: changes), name: name)
        textView.applyDraftChanges(changes)
        if let removeReview {
            reviews.removeAll { $0.id == removeReview }
            updateReviewMarks()
        }
        textView.didChangeText()
    }

    func updateThreadAnchors(_ anchors: [CodeThreadAnchor]) {
        guard anchors != visibleThreadAnchors else { return }
        visibleThreadAnchors = anchors
        textView.threadMarks = anchors.compactMap { anchor in
            anchor.locate(in: textView.source, revision: revision, map: revisionMap).map { (anchor.id, revisionMap.track($0)) }
        }
        textView.setNeedsDisplay(textView.visibleRect)
        scroll.gutter.needsDisplay = true
    }

    func track(_ range: NSRange) -> TrackedDraftRange { revisionMap.track(range) }

    func askSelection() {
        guard let range = textView.selections.last?.range else { return }
        ask(range)
    }

    private func ask(_ range: NSRange) {
        guard !conflicted, !textView.hasMarkedText(), range.length > 0, range.length <= 8192 else {
            onStatus?("Select up to 8,192 UTF-16 units of source to ask about.")
            return
        }
        onAsk?(track(range))
    }

    func requestAnchor(_ span: TrackedDraftRange) async throws -> Fields {
        try await exclusively {
            try await flushDraft()
            let range = span.range
            let source = sharedText as NSString
            guard span.intact, range.length > 0, range.length <= 8192, NSMaxRange(range) <= source.length,
                  Self.scalarBoundary(range.location, source) == range.location,
                  Self.scalarBoundary(NSMaxRange(range), source) == NSMaxRange(range) else { throw Self.changedAnchorIssue }
            return ["doc": doc, "rev": revision, "start": range.location, "end": NSMaxRange(range)]
        }
    }

    func revealAgentRange(start: Int?, end: Int?, line: Int?) {
        let source = textView.source
        let range: NSRange
        if let start, start >= 0, start <= source.length {
            let end = min(source.length, max(start, end ?? start))
            let first = Self.scalarBoundary(start, source), last = Self.scalarBoundary(end, source)
            range = NSRange(location: first, length: last - first)
        } else {
            range = textView.contents(of: min(textView.lineCount - 1, max(1, line ?? 1) - 1))
        }
        textView.revealMark = track(range)
        textView.revealSourceRange(range)
        textView.setNeedsDisplay(textView.visibleRect)
    }

    private func noteItem(_ range: NSRange, asking: Bool) -> NSMenuItem? {
        guard (asking ? onAsk != nil : onNote != nil), range.length > 0, range.length <= 8192, !conflicted else { return nil }
        let item = NSMenuItem(title: asking ? "Ask…" : "Add Note…", action: #selector(addNote(_:)), keyEquivalent: "")
        item.tag = asking ? 1 : 0
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
        guard let anchor = item.representedObject as? NoteAnchor, anchor.doc == doc,
              anchor.generation == editGeneration else { onStatus?(Self.changedAnchorIssue.message); return }
        if item.tag == 1 { ask(anchor.range); return }
        let span = track(anchor.range)
        Task { [weak self] in
            guard let self else { return }
            do { onNote?(try await requestAnchor(span)) }
            catch { onStatus?(error.localizedDescription) }
        }
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
    let author: String?

    init(_ fields: Fields) throws {
        guard let doc = fields["doc"] as? String, let rev = fields["rev"] as? Int, let title = fields["title"] as? String,
              let dirty = fields["dirty"] as? Bool, let text = fields["text"] as? String else {
            throw EditorIssue(code: "response", message: "Pi did not return a complete draft.")
        }
        self.doc = doc
        self.rev = rev
        self.title = title
        author = fields["author"] as? String
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
