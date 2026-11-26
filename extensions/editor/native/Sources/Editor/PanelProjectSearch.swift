import AppKit

struct ProjectSearchRequest: Equatable {
    let query: String
    let whereText: String
    let regex: Bool
    let caseSensitive: Bool
    let wholeWord: Bool

    private var filters: Fields {
        // The backend interprets the full list, including entries with a leading minus.
        ["query": query, "include": whereText, "regex": regex, "caseSensitive": caseSensitive, "wholeWord": wholeWord]
    }

    var searchFields: Fields {
        filters.merging(["kind": "text", "contextLines": 1]) { _, new in new }
    }

    func replaceFields(with replacement: String) -> Fields {
        filters.merging(["replacement": replacement]) { _, new in new }
    }
}

struct ProjectSearchHit: Equatable {
    let path: String
    let line: Int
    let column: Int
    let length: Int
    let text: String
    let preview: String
    let draft: Bool
    let before: [String]
    let after: [String]

    init(_ fields: Fields) throws {
        guard let path = fields["path"] as? String, !path.isEmpty,
              let line = fields["line"] as? Int, (1..<Int.max - 3).contains(line),
              let column = fields["column"] as? Int, (0..<Int.max).contains(column),
              let length = fields["length"] as? Int, length >= 0,
              let text = fields["text"] as? String, let preview = fields["preview"] as? String,
              let draft = fields["draft"] as? Bool,
              let before = fields["before"] as? [String], before.count <= min(line - 1, 3),
              let after = fields["after"] as? [String], after.count <= 3 else {
            throw EditorIssue(code: "response", message: "Editor received an invalid search result.")
        }
        self.path = path; self.line = line; self.column = column; self.length = length
        self.text = text; self.preview = preview; self.draft = draft; self.before = before; self.after = after
    }

    var location: String { "\(line):\(column + 1)" }

    /// Keeps the match near the left of the viewport, in the coordinates of the displayed text.
    var snippet: (text: String, highlight: NSRange?) {
        let prefix = text as NSString
        if column < prefix.length || (length == 0 && column == prefix.length && prefix.length < 1023) {
            let start = Self.scalarBoundary(max(0, column - 36), in: prefix)
            let cut = start == 0 ? "" : "…"
            let shown = cut + prefix.substring(from: start)
            return (shown, NSRange(location: cut.utf16.count + column - start, length: min(length, prefix.length - column)))
        }
        // For a line beyond the full-text limit, the backend preview starts 40 UTF-16 units before
        // the match. It backs up one more unit if that would split a surrogate pair. A leading
        // surrogate pair makes the exact origin ambiguous, so do not highlight the wrong text.
        let sample = preview as NSString
        let shown = "…" + preview
        guard sample.length >= 40, !(0xD800...0xDBFF).contains(sample.character(at: 0)) else { return (shown, nil) }
        return (shown, NSRange(location: 41, length: min(length, sample.length - 40)))
    }

    /// Positions are relative to the searched snapshot. Clamp to the live text when it changed
    /// before the result was opened, without leaving the cursor inside a surrogate pair.
    func selection(in source: NSString) -> NSRange {
        var start = 0
        for _ in 1..<line {
            let newline = source.range(of: "\n", options: .literal, range: NSRange(location: start, length: source.length - start))
            guard newline.location != NSNotFound else { return NSRange(location: source.length, length: 0) }
            start = NSMaxRange(newline)
        }
        let newline = source.range(of: "\n", options: .literal, range: NSRange(location: start, length: source.length - start))
        let end = newline.location == NSNotFound ? source.length : newline.location
        guard column <= end - start else { return NSRange(location: end, length: 0) }
        let position = Self.scalarBoundary(start + column, in: source)
        let finish = Self.scalarBoundary(position + min(length, source.length - position), in: source)
        return NSRange(location: position, length: finish - position)
    }

    private static func scalarBoundary(_ offset: Int, in text: NSString) -> Int {
        if offset > 0, offset < text.length, (0xDC00...0xDFFF).contains(text.character(at: offset)) { return offset - 1 }
        return offset
    }
}

private struct ProjectReplaceReport {
    let occurrences: Int
    let documents: [String]
    let changed: [ProjectSearchRow]
    let skipped: [ProjectSearchRow]
    let limited: Bool

    init(_ fields: Fields) throws {
        let invalid = EditorIssue(code: "response", message: "Editor received an invalid replacement report.")
        guard let changed = fields["changed"] as? [Fields], let skipped = fields["skipped"] as? [Fields],
              let limited = fields["limited"] as? Bool else { throw invalid }
        var total = 0
        var documents: [String] = []
        self.changed = try changed.map { file in
            guard let doc = file["doc"] as? String, let count = file["count"] as? Int, count > 0,
                  count <= Int.max - total else { throw invalid }
            total += count
            documents.append(doc)
            return .changed(path: doc, replacements: count)
        }
        self.documents = documents
        self.occurrences = total
        self.limited = limited
        self.skipped = try skipped.map {
            guard let path = $0["path"] as? String, let reason = $0["reason"] as? String else { throw invalid }
            return .skipped(path: path, reason: reason)
        }
    }

    var summary: String {
        let changed = occurrences == 1 ? "1 replacement" : "\(occurrences.formatted()) replacements"
        let drafts = documents.count == 1 ? "1 draft" : "\(documents.count.formatted()) drafts"
        return "\(changed) in \(drafts) · \(skipped.count.formatted()) skipped" + (limited ? " · Limit reached" : "")
    }
}

enum ProjectSearchRow: Equatable {
    case file(path: String, matches: Int, draft: Bool)
    case context(line: Int, text: String)
    case match(ProjectSearchHit)
    case changed(path: String, replacements: Int)
    case skipped(path: String, reason: String)

    var hit: ProjectSearchHit? {
        if case .match(let hit) = self { return hit }
        return nil
    }

    static func grouped(_ hits: [ProjectSearchHit]) -> [Self] {
        var paths: [String] = []
        var byPath: [String: [ProjectSearchHit]] = [:]
        for hit in hits {
            if byPath[hit.path] == nil { paths.append(hit.path) }
            byPath[hit.path, default: []].append(hit)
        }
        return paths.flatMap { path -> [Self] in
            let matches = byPath[path] ?? []
            let byLine = Dictionary(grouping: matches, by: \.line)
            var context: [Int: String] = [:]
            for hit in matches {
                for (index, text) in hit.before.enumerated() { context[hit.line - hit.before.count + index] = text }
                for (index, text) in hit.after.enumerated() { context[hit.line + index + 1] = text }
            }
            let lines = Set(byLine.keys).union(context.keys).sorted()
            let rows: [Self] = lines.flatMap { line in
                if let hits = byLine[line] { return hits.map(Self.match) }
                return context[line].map { [.context(line: line, text: $0)] } ?? []
            }
            return [.file(path: path, matches: matches.count, draft: matches.contains(where: \.draft))] + rows
        }
    }
}

@MainActor
final class PanelProjectSearch {
    private let panel = ProjectSearchSurface()
    private var searchTask: Task<Void, Never>?
    private var openTask: Task<Void, Never>?
    private var generation = 0
    private var confirmation: (request: ProjectSearchRequest, replacement: String)?
    private var replacing = false
    private var seeded = false
    private let ready = "Enter a query, then press return."

    var hasResults: Bool { panel.hasResults }

    func show(in screen: WorkspaceScreen) {
        panel.onFind = { [weak self, weak screen] in
            guard let self, let screen else { return }
            search(in: screen)
        }
        panel.onReplace = { [weak self, weak screen] in
            guard let self, let screen else { return }
            if confirmation != nil { replace(in: screen) }
            else { confirmReplacement() }
        }
        panel.onCancelConfirmation = { [weak self] in self?.cancelConfirmation() }
        panel.onQueryChange = { [weak self] in self?.invalidateSearch() }
        panel.onReplacementChange = { [weak self] in self?.cancelConfirmation() }
        panel.onOpen = { [weak self, weak screen] hit in
            guard let self, let screen else { return }
            open(hit, in: screen)
        }
        panel.onClose = { [weak self, weak screen] in
            guard let self, let screen else { return }
            screen.chrome.dismissOverlay(panel)
            if screen.chrome.window?.isKeyWindow == true { screen.currentEditor?.focus() }
        }
        panel.onCancel = { [weak self] in
            guard let self else { return }
            if confirmation != nil { cancelConfirmation() }
            else { panel.onClose?() }
        }
        panel.onDetach = { [weak self] in self?.detached() }
        if !seeded {
            seeded = true
            if let editor = screen.currentEditor, let range = editor.findSelections.first, range.length > 0, range.length <= 512 {
                let text = editor.findText.substring(with: range)
                if text.utf8.count <= 512, !text.contains(where: \.isNewline) { panel.query.stringValue = text }
            }
        }
        panel.updateControls()
        screen.chrome.presentOverlay(panel, placement: .bottom) { pane in
            NSSize(width: pane.width, height: min(350, max(236, (pane.height * 0.42).rounded())))
        }
        panel.focus(panel.query)
    }

    func move(in screen: WorkspaceScreen, backwards: Bool) {
        if let hit = panel.step(backwards: backwards) { open(hit, in: screen) }
    }

    private func invalidateSearch() {
        guard !replacing else { return }
        generation += 1
        searchTask?.cancel()
        searchTask = nil
        cancelConfirmation()
        panel.load(rows: [])
        panel.status(panel.request.query.isEmpty ? ready : "Press return to search.")
    }

    private func detached() {
        cancelConfirmation()
        guard searchTask != nil, !replacing else { return }
        generation += 1
        searchTask?.cancel()
        searchTask = nil
        panel.status("Search stopped.")
    }

    private func search(in screen: WorkspaceScreen) {
        guard !replacing, confirmation == nil, !panel.hasMarkedInput else { return }
        let request = panel.request
        guard !request.query.isEmpty else { return }
        generation += 1
        let token = generation
        searchTask?.cancel()
        panel.load(rows: [])
        panel.status("Searching project…")
        searchTask = Task { [weak self, weak screen] in
            guard let screen else { return }
            do {
                let result = try await screen.api.call("search", request.searchFields)
                guard let self, !Task.isCancelled, token == generation else { return }
                guard let raw = result["hits"] as? [Fields], let limited = result["limited"] as? Bool else {
                    throw EditorIssue(code: "response", message: "Editor received an invalid search report.")
                }
                let hits = try raw.map(ProjectSearchHit.init)
                let rows = ProjectSearchRow.grouped(hits)
                let files = Set(hits.map(\.path)).count
                panel.load(rows: rows)
                let count = hits.count == 1 ? "1 match" : "\(hits.count.formatted()) matches"
                let scope = files == 1 ? "1 file" : "\(files.formatted()) files"
                panel.status((hits.isEmpty ? "No matches" : "\(count) in \(scope)") + (limited ? " · Limit reached" : ""), warning: limited)
                searchTask = nil
            } catch {
                guard let self, !Task.isCancelled, token == generation else { return }
                panel.status(error.localizedDescription, warning: true)
                searchTask = nil
            }
        }
    }

    private func confirmReplacement() {
        guard !replacing, !panel.hasMarkedInput else { return }
        let request = panel.request
        guard !request.query.isEmpty else { return }
        generation += 1
        if let searchTask {
            searchTask.cancel()
            self.searchTask = nil
            panel.status("Search stopped.")
        }
        confirmation = (request, panel.replacementText)
        panel.setConfirmation(true)
    }

    private func cancelConfirmation() {
        guard confirmation != nil else { return }
        confirmation = nil
        panel.setConfirmation(false)
    }

    private func replace(in screen: WorkspaceScreen) {
        guard let confirmation, !replacing else { return }
        guard !panel.hasMarkedInput, panel.request == confirmation.request, panel.replacementText == confirmation.replacement else {
            cancelConfirmation()
            return
        }
        cancelConfirmation()
        replacing = true
        panel.isReplacing = true
        panel.load(rows: [])
        panel.status("Replacing in drafts…")
        // A completed request can have changed drafts even if the person closed the panel. Let it
        // finish and report the outcome; closing a view is not a rollback of a confirmed edit.
        Task { [self, screen] in
            defer { replacing = false; panel.isReplacing = false }
            do {
                try await screen.flushOpenProjectDrafts()
            } catch {
                showReplacementOutcome("No replacement: \(error.localizedDescription)", warning: true, in: screen)
                return
            }
            do {
                let result = try await screen.api.call("replace", confirmation.request.replaceFields(with: confirmation.replacement))
                let report = try ProjectReplaceReport(result)
                panel.load(rows: report.changed + report.skipped)
                showReplacementOutcome(report.summary, warning: report.limited || !report.skipped.isEmpty, in: screen)
                do { try await screen.refreshProjectDrafts(report.documents) }
                catch { screen.chrome.setMessage("Replacements are in drafts. Editor could not refresh: \(error.localizedDescription)") }
            } catch {
                showReplacementOutcome("Replacement did not return a complete report: \(error.localizedDescription)", warning: true, in: screen)
                try? await screen.synchronise()
            }
        }
    }

    private func showReplacementOutcome(_ message: String, warning: Bool, in screen: WorkspaceScreen) {
        panel.status(message, warning: warning)
        if panel.superview == nil { screen.chrome.notify(message) }
    }

    private func open(_ hit: ProjectSearchHit, in screen: WorkspaceScreen) {
        let hadFocus = screen.chrome.window?.isKeyWindow == true
        openTask?.cancel()
        openTask = Task { [weak screen] in
            guard let screen, !Task.isCancelled else { return }
            do {
                try await screen.open(hit.path, focus: false)
                guard !Task.isCancelled, let editor = screen.currentEditor, editor.doc == hit.path else { return }
                let range = hit.selection(in: editor.findText)
                editor.textView.unfold(intersecting: range)
                editor.selectFound([range], reveal: range)
                if hadFocus, screen.chrome.window?.isKeyWindow == true { editor.focus() }
            } catch {
                if !Task.isCancelled { screen.chrome.setMessage(error.localizedDescription) }
            }
        }
    }
}

@MainActor
private final class ProjectSearchSurface: QuickSurface, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let query = NSTextField()
    private let scope = NSTextField()
    private let replacement = NSTextField()
    private let heading = QuickSurface.label("Find in Files")
    private let resultStatus = QuickSurface.label("Enter a query, then press return.")
    private let help = QuickSurface.label("F4 / shift+F4  Next / previous match")
    private let labels = [QuickSurface.label("Find"), QuickSurface.label("Where"), QuickSurface.label("Replace")]
    private let find = WorkspaceButton("Find", help: "Find in Files (return)")
    private let replace = WorkspaceButton("Replace All…", help: "Replace all matches in project drafts")
    private let cancel = WorkspaceButton("Cancel", help: "Cancel replacement")
    private let confirm = WorkspaceButton("Replace Drafts", help: "Confirm replacement in project drafts")
    private let close = WorkspaceButton("", symbol: "xmark", help: "Close Find in Files (esc)")
    private let regex = WorkspaceButton("Regex", help: "Use regular expression")
    private let matchCase = WorkspaceButton("Case", help: "Match case")
    private let word = WorkspaceButton("Word", help: "Match whole words")
    private let wrap = WorkspaceButton("Wrap", help: "Wrap next and previous results")
    private let highlight = WorkspaceButton("Highlight", help: "Highlight matches in results")
    private let scroll = NSScrollView()
    private let table = ProjectSearchTable()
    private let column = NSTableColumn(identifier: .init("project.result"))
    private let backings = (0..<3).map { _ in NSView() }
    private var rows: [ProjectSearchRow] = []
    private var hitRows: [Int] = []
    private var confirming = false
    private var statusWarning = false
    private var statusText = "Enter a query, then press return."
    private var fields: [NSTextField] { [query, scope, replacement] }
    private var flags: [WorkspaceButton] { [regex, matchCase, word] }
    private var displayFlags: [WorkspaceButton] { [wrap, highlight] }

    var onFind: (() -> Void)?
    var onReplace: (() -> Void)?
    var onCancelConfirmation: (() -> Void)?
    var onQueryChange: (() -> Void)?
    var onReplacementChange: (() -> Void)?
    var onOpen: ((ProjectSearchHit) -> Void)?
    var onClose: (() -> Void)?
    var onCancel: (() -> Void)?
    var isReplacing = false { didSet { updateControls() } }
    var hasResults: Bool { !hitRows.isEmpty }
    var request: ProjectSearchRequest {
        ProjectSearchRequest(query: value(query), whereText: value(scope), regex: regex.isOn,
                             caseSensitive: matchCase.isOn, wholeWord: word.isOn)
    }
    var replacementText: String { value(replacement) }
    var hasMarkedInput: Bool { fields.contains { ($0.currentEditor() as? NSTextView)?.hasMarkedText() == true } }

    init() {
        super.init(frame: .zero)
        layer?.cornerRadius = 0
        layer?.borderWidth = 0
        shadow = nil
        resultStatus.lineBreakMode = .byTruncatingTail
        help.alignment = .right
        scope.placeholderString = "Entire project, or e.g. src/, *.swift, -Tests/"
        scope.toolTip = "Use comma-separated folders or globs. Prefix a pattern with - to exclude it."
        query.placeholderString = "Text to find"
        replacement.placeholderString = "Leave empty to remove the matches"
        for (index, backing) in backings.enumerated() {
            let field = fields[index]
            field.setAccessibilityLabel(labels[index].stringValue)
            field.delegate = self
            field.isBordered = false
            field.isBezeled = false
            field.drawsBackground = false
            field.focusRingType = .none
            (field.cell as? NSTextFieldCell)?.sendsActionOnEndEditing = false
            backing.wantsLayer = true
            backing.layer?.borderWidth = 1
            backing.layer?.cornerRadius = 5
            backing.addSubview(field)
        }
        query.nextKeyView = scope
        scope.nextKeyView = replacement
        replacement.nextKeyView = query
        matchCase.isOn = false
        for button in flags {
            button.setAccessibilityValue("Off")
            button.run = { [weak self, weak button] in
                guard let self, let button, !isReplacing else { return }
                button.isOn.toggle()
                button.setAccessibilityValue(button.isOn ? "On" : "Off")
                applyButtonStyle(button)
                onQueryChange?()
            }
        }
        for button in displayFlags {
            button.isOn = true
            button.setAccessibilityValue("On")
            button.run = { [weak self, weak button] in
                guard let self, let button else { return }
                button.isOn.toggle()
                button.setAccessibilityValue(button.isOn ? "On" : "Off")
                applyButtonStyle(button)
                table.enumerateAvailableRowViews { view, _ in
                    for case let cell as ProjectSearchCell in view.subviews { cell.highlightMatches = highlight.isOn }
                }
            }
        }
        find.run = { [weak self] in self?.onFind?() }
        replace.run = { [weak self] in self?.onReplace?() }
        cancel.run = { [weak self] in self?.onCancelConfirmation?() }
        confirm.run = { [weak self] in self?.onReplace?() }
        close.run = { [weak self] in self?.onClose?() }
        table.style = .plain
        table.headerView = nil
        table.rowHeight = 23
        table.intercellSpacing = .zero
        table.backgroundColor = .clear
        table.allowsMultipleSelection = false
        table.selectionHighlightStyle = .regular
        table.setAccessibilityLabel("Project search results")
        column.minWidth = 0
        table.addTableColumn(column)
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.delegate = self
        table.dataSource = self
        table.target = self
        table.action = #selector(openClickedRow)
        table.onReturn = { [weak self] in self?.openSelectedRow() }
        table.onEscape = { [weak self] in self?.onCancel?() }
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 5
        scroll.layer?.borderWidth = 1
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        [heading, resultStatus, help, scroll, find, replace, cancel, confirm, close].forEach { addSubview($0) }
        labels.forEach { addSubview($0) }; (flags + displayFlags).forEach { addSubview($0) }; backings.forEach { addSubview($0) }
        updateControls()
        applyPanelStyle()
    }

    required init?(coder: NSCoder) { fatalError("Unsupported archive") }

    private func value(_ field: NSTextField) -> String { field.currentEditor()?.string ?? field.stringValue }

    func updateControls() {
        find.isEnabled = !request.query.isEmpty && !hasMarkedInput && !isReplacing
        replace.isEnabled = find.isEnabled
        find.isHidden = confirming
        replace.isHidden = confirming
        cancel.isHidden = !confirming
        confirm.isHidden = !confirming
        fields.forEach { $0.isEditable = !isReplacing }
        flags.forEach { $0.isEnabled = !isReplacing }
        [find, replace, cancel, confirm, close].forEach(applyButtonStyle)
        (flags + displayFlags).forEach(applyButtonStyle)
    }

    func setConfirmation(_ value: Bool) {
        confirming = value
        updateControls()
        paintStatus()
    }

    func status(_ message: String, warning: Bool = false) {
        statusText = message
        statusWarning = warning
        paintStatus()
    }

    private func paintStatus() {
        let message = confirming ? "Replace every match in this scope? Disk files stay unchanged." : statusText
        resultStatus.stringValue = message
        resultStatus.toolTip = message
        resultStatus.textColor = confirming || statusWarning ? WorkspaceStyle.theme.warning : WorkspaceStyle.theme.secondaryText
        help.isHidden = confirming || !hasResults
        needsLayout = true
    }

    func load(rows: [ProjectSearchRow]) {
        self.rows = rows
        hitRows = rows.indices.filter { rows[$0].hit != nil }
        table.deselectAll(nil)
        table.reloadData()
        if !rows.isEmpty { table.scrollRowToVisible(0) }
        paintStatus()
    }

    func step(backwards: Bool) -> ProjectSearchHit? {
        guard !hitRows.isEmpty, !confirming, !isReplacing else { return nil }
        let index = hitRows.firstIndex(of: table.selectedRow)
        let count = hitRows.count
        var chosen = index.map { $0 + (backwards ? -1 : 1) } ?? (backwards ? count - 1 : 0)
        if !hitRows.indices.contains(chosen) {
            guard wrap.isOn else { return nil }
            chosen = (chosen + count) % count
        }
        let row = hitRows[chosen]
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        table.scrollRowToVisible(row)
        return rows[row].hit
    }

    override func layout() {
        super.layout()
        let width = bounds.width, height = bounds.height
        let inset: CGFloat = 14
        let actionWidth: CGFloat = 122
        let flagWidth: CGFloat = 56
        let controlsX = max(inset, width - inset - actionWidth)
        heading.frame = NSRect(x: inset, y: 8, width: 112, height: 20)
        close.frame = NSRect(x: max(0, width - 35), y: 5, width: 25, height: 25)
        let helpWidth: CGFloat = help.isHidden ? 0 : max(190, help.intrinsicContentSize.width + 8)
        help.frame = NSRect(x: close.frame.minX - helpWidth - 7, y: 8, width: helpWidth, height: 20)
        resultStatus.frame = NSRect(x: 135, y: 8, width: max(0, close.frame.minX - 142 - helpWidth), height: 20)
        let formY = max(32, height - 102)
        scroll.frame = NSRect(x: inset, y: 34, width: max(0, width - 2 * inset), height: max(0, formY - 42))
        scroll.isHidden = scroll.frame.height < 15
        column.width = scroll.contentSize.width
        let labelWidth: CGFloat = max(67, (labels.map { $0.intrinsicContentSize.width }.max() ?? 0) + 9)
        let fieldX = inset + labelWidth
        let buttonX = controlsX - flagWidth * 3 - 12
        for index in fields.indices {
            let y = formY + CGFloat(index) * 31
            labels[index].frame = NSRect(x: inset, y: y + 6, width: labelWidth - 5, height: 18)
            let right = index < 2 ? buttonX - 5 : controlsX - 8
            backings[index].frame = NSRect(x: fieldX, y: y, width: max(0, right - fieldX), height: 27)
            let h = min(25, max(17, fields[index].intrinsicContentSize.height))
            fields[index].frame = NSRect(x: 7, y: ((27 - h) / 2).rounded(), width: max(0, right - fieldX - 14), height: h)
        }
        for (index, button) in flags.enumerated() {
            button.frame = NSRect(x: buttonX + CGFloat(index) * flagWidth, y: formY, width: flagWidth, height: 27)
        }
        wrap.frame = NSRect(x: buttonX, y: formY + 31, width: flagWidth, height: 27)
        highlight.frame = NSRect(x: buttonX + flagWidth, y: formY + 31, width: flagWidth * 2, height: 27)
        find.frame = NSRect(x: controlsX, y: formY, width: actionWidth, height: 27)
        cancel.frame = find.frame
        replace.frame = NSRect(x: controlsX, y: formY + 62, width: actionWidth, height: 27)
        confirm.frame = replace.frame
    }

    override func applyPanelStyle() {
        super.applyPanelStyle()
        let theme = WorkspaceStyle.theme
        heading.font = WorkspaceStyle.interfaceFont(0, weight: .semibold)
        heading.textColor = theme.text
        resultStatus.font = WorkspaceStyle.interfaceFont(-1)
        help.font = WorkspaceStyle.interfaceFont(-2)
        help.textColor = theme.mutedText
        for label in labels {
            label.font = WorkspaceStyle.interfaceFont(-1)
            label.textColor = theme.secondaryText
        }
        for (index, field) in fields.enumerated() {
            field.font = WorkspaceStyle.interfaceFont()
            field.textColor = theme.text
            backings[index].layer?.backgroundColor = theme.editor.cgColor
        }
        scroll.layer?.backgroundColor = theme.editor.cgColor
        scroll.layer?.borderColor = theme.panelBorder.cgColor
        paintFields()
        updateControls()
        table.enumerateAvailableRowViews { view, _ in
            view.needsDisplay = true
            view.subviews.forEach { $0.needsDisplay = true }
        }
        paintStatus()
    }

    private func applyButtonStyle(_ button: WorkspaceButton) {
        let theme = WorkspaceStyle.theme
        let primary = button === find || button === confirm
        button.font = WorkspaceStyle.interfaceFont(-1, weight: primary ? .semibold : .medium)
        button.wantsLayer = true
        button.layer?.cornerRadius = 5
        button.layer?.borderWidth = button === close ? 0 : 1
        button.layer?.borderColor = (button.isEnabled && (primary || button.isOn) ? theme.accent.withAlphaComponent(0.65) : theme.panelBorder).cgColor
        button.layer?.backgroundColor = (button === close ? NSColor.clear : primary || button.isOn ? theme.engaged : theme.panel).cgColor
        button.contentTintColor = !button.isEnabled ? theme.mutedText : primary || button.isOn ? theme.accent : theme.text
    }

    private func paintFields() {
        let theme = WorkspaceStyle.theme
        for (index, field) in fields.enumerated() {
            let editor = field.currentEditor() as? NSTextView
            backings[index].layer?.borderColor = (editor == nil ? theme.panelBorder : theme.accent).cgColor
            editor?.textColor = theme.text
            editor?.insertionPointColor = theme.caret
            editor?.selectedTextAttributes = [.backgroundColor: theme.selection, .foregroundColor: theme.text]
        }
    }

    func controlTextDidBeginEditing(_ notification: Notification) { paintFields() }
    func controlTextDidEndEditing(_ notification: Notification) { paintFields() }
    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField else { return }
        if field === replacement { onReplacementChange?() }
        else { onQueryChange?() }
        updateControls()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard !textView.hasMarkedText() else { return false }
        switch selector {
        case #selector(NSResponder.insertNewline(_:)): onFind?()
        case #selector(NSResponder.cancelOperation(_:)): onCancel?()
        default: return false
        }
        return true
    }

    override func cancelOperation(_ sender: Any?) { onCancel?() }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { !confirming && rows[row].hit != nil }
    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        ProjectSearchRowBackground()
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("project.result.cell")
        let cell = tableView.makeView(withIdentifier: id, owner: self) as? ProjectSearchCell ?? ProjectSearchCell()
        cell.identifier = id
        cell.row = rows[row]
        cell.highlightMatches = highlight.isOn
        return cell
    }

    @objc private func openClickedRow() {
        let row = table.clickedRow
        if !confirming, rows.indices.contains(row), let hit = rows[row].hit { onOpen?(hit) }
    }
    private func openSelectedRow() {
        let row = table.selectedRow
        if !confirming, rows.indices.contains(row), let hit = rows[row].hit { onOpen?(hit) }
    }
}

@MainActor
private final class ProjectSearchTable: NSTableView {
    var onReturn: (() -> Void)?
    var onEscape: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 { onReturn?() }
        else { super.keyDown(with: event) }
    }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

@MainActor
private final class ProjectSearchRowBackground: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        WorkspaceStyle.theme.chosen.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 3, dy: 1), xRadius: 4, yRadius: 4).fill()
    }
}

@MainActor
private final class ProjectSearchCell: NSView {
    var row: ProjectSearchRow? { didSet { needsDisplay = true } }
    var highlightMatches = true { didSet { if highlightMatches != oldValue { needsDisplay = true } } }

    override func accessibilityLabel() -> String? {
        switch row {
        case .file(let path, let count, let draft): "\(path), \(count) matches" + (draft ? ", draft" : "")
        case .context(let line, let text): "Line \(line): \(text)"
        case .match(let hit): "\(hit.path), line \(hit.line), column \(hit.column + 1): \(hit.snippet.text)"
        case .changed(let path, let replacements): "\(path): \(replacements) replacements in draft"
        case .skipped(let path, let reason): "Skipped \(path): \(reason)"
        case nil: nil
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let theme = WorkspaceStyle.theme
        guard let row else { return }
        let font = WorkspaceStyle.interfaceFont(-1)
        let code = NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular)
        switch row {
        case .file(let path, let matches, let draft):
            theme.chrome.setFill()
            bounds.fill()
            let count = matches == 1 ? "1 match" : "\(matches.formatted()) matches"
            let detail = draft ? count + " · Draft" : count
            let detailWidth = ceil((detail as NSString).size(withAttributes: [.font: font]).width)
            draw(path, from: 12, through: bounds.width - detailWidth - 24,
                 font: WorkspaceStyle.interfaceFont(-1, weight: .semibold), colour: theme.text, truncating: .byTruncatingMiddle)
            draw(detail, from: bounds.width - detailWidth - 12, through: bounds.width - 8, font: font, colour: theme.secondaryText)
        case .context(let line, let text):
            draw(String(line), from: 13, through: 100, font: code, colour: theme.mutedText)
            draw(text, from: 110, through: bounds.width - 12, font: code, colour: theme.secondaryText)
        case .match(let hit):
            let snippet = hit.snippet
            draw(hit.location, from: 13, through: 100, font: code, colour: theme.accent)
            draw(snippet.text, from: 110, through: bounds.width - 12, font: code, colour: theme.text, highlight: highlightMatches ? snippet.highlight : nil)
        case .changed(let path, let replacements):
            let summary = replacements == 1 ? "1 replacement in draft" : "\(replacements.formatted()) replacements in draft"
            let divider = max(0, bounds.width * 0.66)
            draw(path, from: 12, through: divider - 12, font: font, colour: theme.text, truncating: .byTruncatingMiddle)
            draw(summary, from: divider, through: bounds.width - 12, font: font, colour: theme.secondaryText)
        case .skipped(let path, let reason):
            let divider = max(0, bounds.width * 0.38)
            draw(path, from: 12, through: divider - 12, font: font, colour: theme.text, truncating: .byTruncatingMiddle)
            draw(reason, from: divider, through: bounds.width - 12, font: font, colour: theme.warning)
        }
    }

    private func draw(_ string: String, from x: CGFloat, through end: CGFloat, font: NSFont, colour: NSColor,
                      truncating: NSLineBreakMode = .byTruncatingTail, highlight: NSRange? = nil) {
        guard end > x else { return }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = truncating
        paragraph.defaultTabInterval = ("    " as NSString).size(withAttributes: [.font: font]).width
        paragraph.tabStops = []
        let text = NSMutableAttributedString(string: string, attributes: [.font: font, .foregroundColor: colour, .paragraphStyle: paragraph])
        if let highlight, highlight.length > 0, NSMaxRange(highlight) <= text.length {
            text.addAttribute(.foregroundColor, value: WorkspaceStyle.theme.matchText, range: highlight)
            text.addAttribute(.backgroundColor, value: WorkspaceStyle.theme.findMatch, range: highlight)
        }
        let height = ceil(font.ascender - font.descender + font.leading)
        text.draw(with: NSRect(x: x, y: ((bounds.height - height) / 2).rounded(), width: end - x, height: height + 2),
                  options: [.truncatesLastVisibleLine])
    }
}
