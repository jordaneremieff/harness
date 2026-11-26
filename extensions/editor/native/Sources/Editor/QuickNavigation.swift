import AppKit

struct QuickLocation: Equatable, Sendable {
    enum Scope: Equatable, Sendable {
        case files, line(String), symbol(String), text(String)
    }
    let path: String
    let scope: Scope

    init(_ input: String) {
        for i in input.indices where input[i] == "@" || input[i] == "#" || input[i] == ":" {
            let suffix = input[input.index(after: i)...]
            switch input[i] {
            case "@": path = String(input[..<i]); scope = .symbol(String(suffix)); return
            case "#": path = String(input[..<i]); scope = .text(String(suffix)); return
            case ":" where i == input.startIndex || suffix.allSatisfy({ $0.isASCII && $0.isNumber }):
                path = String(input[..<i]); scope = .line(String(suffix)); return
            default: continue
            }
        }
        path = input
        scope = .files
    }
}

@MainActor
struct QuickEditorPosition {
    weak var editor: CodeEditor?
    let selection: [NSRange]
    let origin: NSPoint

    init(_ editor: CodeEditor) {
        self.editor = editor
        selection = editor.findSelections
        origin = editor.scroll.contentView.bounds.origin
    }

    func restore() {
        guard let editor else { return }
        let length = editor.findText.length
        if selection.allSatisfy({ NSMaxRange($0) <= length }) { editor.selectFound(selection, reveal: nil) }
        editor.scroll.contentView.scroll(to: origin)
        editor.scroll.reflectScrolledClipView(editor.scroll.contentView)
    }
}

@MainActor
final class QuickNavigation {
    private var cachedFiles: [QuickItem] = []
    private var refresh: Task<Void, Never>?
    private var limited = false
    private var fetchProblem: String?
    private var session: QuickNavigationSession?

    func fetch(in screen: WorkspaceScreen) {
        refresh?.cancel()
        let api = screen.api
        refresh = Task { [weak self] in
            do {
                let data = try await api.call("files")
                try Task.checkCancellation()
                let paths = data["files"] as? [String] ?? []
                let entries = await Task.detached(priority: .userInitiated) {
                    paths.map { QuickItem($0, title: $0, icon: "doc") }
                }.value
                guard !Task.isCancelled, let self else { return }
                cachedFiles = entries
                limited = data["limited"] as? Bool ?? false
                fetchProblem = nil
                session?.filesChanged()
            } catch {
                guard !Task.isCancelled, let self else { return }
                fetchProblem = error.localizedDescription
                session?.filesChanged()
            }
        }
    }

    func candidates(open: [String], recent: [String], current: String?) -> [QuickItem] {
        let seen = Set(cachedFiles.map(\.id))
        let extras = Array(Set(open + recent)).filter { !seen.contains($0) && !$0.hasPrefix("scratch:") }
        let ranks = Dictionary(recent.enumerated().map { ($0.element, 100 - $0.offset) }, uniquingKeysWith: max)
        let opened = Set(open)
        return (cachedFiles + extras.map { QuickItem($0, title: $0, icon: "doc") }).map { file in
            let isOpen = opened.contains(file.id)
            let priority = (file.id == current ? 300 : isOpen ? 200 : 0) + (ranks[file.id] ?? 0)
            return QuickItem(file.id, title: file.title, detail: isOpen ? "Open" : "", icon: file.icon, priority: priority, search: file.search)
        }
    }

    func show(in screen: WorkspaceScreen, mode: QuickNavigationSession.Mode) {
        let panel: QuickPanel
        switch mode {
        case .anything:
            panel = QuickPanel(title: "Go to Anything", placeholder: "Search project files", assistance: "Append :line, @symbol or #text to the file name.",
                               keyboardHelp: ":  Line    @  Symbol    #  Text    ↑ ↓  Move    esc  Close")
        case .line:
            panel = QuickPanel(title: "Go to Line", placeholder: "Line number", keyboardHelp: "return  Go to line    esc  Restore position")
        case .symbols:
            panel = QuickPanel(title: "Go to Symbol", placeholder: "Search symbols in this file")
        }
        let run = QuickNavigationSession(screen: screen, panel: panel, mode: mode)
        run.items = candidates(open: screen.openDocuments, recent: screen.recentDocuments, current: screen.currentEditor?.doc)
        run.onFilesChanged = { [weak self, weak screen, weak run] in
            guard let self, let screen, let run else { return }
            run.items = candidates(open: screen.openDocuments, recent: screen.recentDocuments, current: run.origin?.editor?.doc)
            run.fileMessage = fetchProblem ?? (limited ? "Partial file list" : nil)
            run.update(keep: true)
        }
        run.onFinish = { [weak self, weak run] in
            if self?.session === run { self?.session = nil }
        }
        let prior = session
        session = run
        screen.chrome.presentOverlay(panel, placement: .top) { pane in
            NSSize(width: min(mode == .line ? 480 : 682, max(0, pane.width - 24)), height: mode == .line ? 151 : 422)
        }
        withExtendedLifetime(prior) {}
        run.start(fileMessage: fetchProblem ?? (limited ? "Partial file list" : nil))
        if mode == .anything { fetch(in: screen) }
    }
}

@MainActor
final class QuickNavigationSession {
    enum Mode { case anything, line, symbols }
    private weak var screen: WorkspaceScreen?
    private weak var panel: QuickPanel?
    private let mode: Mode
    let origin: QuickEditorPosition?
    private var positions: [ObjectIdentifier: QuickEditorPosition] = [:]
    private var previewDoc: String?
    private weak var previewEditor: CodeEditor?
    private var hasTransient = false
    private var finished = false
    private var request = 0
    private var filter: Task<Void, Never>?
    private var work: Task<[QuickItem.Hit], Never>?
    private var destinations: [String: NSRange] = [:]
    private var lineToCommit: Int?
    private var symbols: (editor: ObjectIdentifier, revision: UInt64, scan: Task<[CodeSymbol], Never>, list: Task<QuickSymbolList, Never>)?
    private var textSnapshot: (editor: ObjectIdentifier, revision: UInt64, text: String)?
    var items: [QuickItem] = []
    var fileMessage: String?
    var onFilesChanged: (() -> Void)?
    var onFinish: (() -> Void)?

    init(screen: WorkspaceScreen, panel: QuickPanel, mode: Mode) {
        self.screen = screen; self.panel = panel; self.mode = mode
        origin = screen.currentEditor.map(QuickEditorPosition.init)
        panel.selectsHoveredRows = mode != .line
        panel.onInput = { [weak self] _ in self?.update() }
        panel.onMove = { [weak self] in self?.preview($0) }
        panel.onAccept = { [weak self] in self?.accept($0) }
        panel.onCancel = { [weak self] in self?.finish(commit: false, detached: false) }
        panel.onDetach = { [weak self] in self?.finish(commit: false, detached: true) }
    }

    func start(fileMessage: String?) {
        self.fileMessage = fileMessage
        panel?.start()
    }

    func filesChanged() { if mode == .anything { onFilesChanged?() } }

    private var location: QuickLocation {
        let text = panel?.text ?? ""
        switch mode {
        case .anything: return QuickLocation(text)
        case .line: return QuickLocation(":" + text)
        case .symbols: return QuickLocation("@" + text)
        }
    }

    func update(keep: Bool = false) {
        guard !finished, let panel else { return }
        filter?.cancel(); work?.cancel(); request += 1
        let generation = request
        let location = location
        destinations.removeAll()
        lineToCommit = nil
        switch location.scope {
        case .files:
            find(items, by: location.path, keep: keep, message: fileMessage)
        case .line, .text, .symbol:
            if location.path.isEmpty {
                guard let editor = origin?.editor else { panel.show([], status: "Open a file first"); return }
                if hasTransient && previewDoc != editor.doc {
                    load(editor.doc, request: generation) { [weak self] editor in self?.present(location.scope, for: editor) }
                } else { present(location.scope, for: editor) }
                return
            }
            if let exact = items.first(where: { $0.id == location.path }) {
                load(exact.id, request: generation) { [weak self] editor in self?.present(location.scope, for: editor) }
                return
            }
            panel.busy()
            let files = items
            let query = location.path
            let worker = Task.detached(priority: .userInitiated) { QuickItem.filter(files, query: query) }
            work = worker
            filter = Task { [weak self] in
                let hit = await worker.value.first
                guard !Task.isCancelled, let self, request == generation else { return }
                guard let hit else { panel.show([], status: "No matching file"); return }
                load(hit.item.id, request: generation) { [weak self] editor in self?.present(location.scope, for: editor) }
            }
        }
    }

    private func find(_ rows: [QuickItem], by query: String, keep: Bool = false, message: String? = nil) {
        guard let panel else { return }
        let generation = request
        if rows.count <= 60 {
            panel.show(QuickItem.filter(rows, query: query), status: message, keepSelection: keep)
            return
        }
        panel.busy()
        let worker = Task.detached(priority: .userInitiated) { QuickItem.filter(rows, query: query) }
        work = worker
        filter = Task { [weak self, weak panel] in
            let hits = await worker.value
            guard !Task.isCancelled, self?.request == generation else { return }
            panel?.show(hits, status: message, keepSelection: keep)
        }
    }

    private func present(_ scope: QuickLocation.Scope, for editor: CodeEditor) {
        guard let panel else { return }
        remember(editor)
        switch scope {
        case .line(let input):
            guard let line = Int(input.trimmingCharacters(in: .whitespaces)), line > 0 else {
                positions[ObjectIdentifier(editor)]?.restore()
                panel.show([], status: input.isEmpty ? editor.doc : "Enter a positive line number")
                return
            }
            let clamped = min(line, editor.textView.lineCount)
            lineToCommit = clamped
            editor.go(line: clamped)
            panel.show([], status: "Line \(clamped) · \(editor.doc)")
        case .symbol(let query):
            let engine = editor.textView.syntax.engine
            if let storage = editor.textView.textStorage { engine.attach(to: storage) }
            let key = ObjectIdentifier(editor)
            if symbols?.editor != key || symbols?.revision != engine.revision {
                symbols?.scan.cancel(); symbols?.list.cancel()
                let task = engine.symbolSnapshot()
                symbols = (key, engine.revision, task, Task.detached(priority: .userInitiated) { QuickSymbolList(await task.value) })
            }
            guard let symbols else { return }
            let generation = request
            previewEditor = editor
            panel.busy("Finding symbols…")
            filter = Task { [weak self, weak editor] in
                let list = await symbols.list.value
                guard !Task.isCancelled, let self, let editor, request == generation else { return }
                if editor.textView.syntax.engine.revision != symbols.revision { update(); return }
                destinations = list.locations
                find(list.items, by: query, message: list.items.isEmpty ? "No symbols in this file" : nil)
            }
        case .text(let query):
            guard !query.isEmpty else { panel.show([], status: "Enter text to find in \(editor.doc)"); return }
            panel.busy()
            let engine = editor.textView.syntax.engine
            if let storage = editor.textView.textStorage { engine.attach(to: storage) }
            let key = ObjectIdentifier(editor)
            if textSnapshot?.editor != key || textSnapshot?.revision != engine.revision {
                textSnapshot = (key, engine.revision, String(editor.findText))
            }
            guard let snapshot = textSnapshot else { return }
            let source = snapshot.text
            let generation = request
            previewEditor = editor
            let worker = Task.detached(priority: .userInitiated) { QuickTextMatches.search(query, in: source) }
            filter = Task { [weak self, weak panel, weak editor] in
                let result = await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
                guard !Task.isCancelled, let self, let editor, request == generation else { return }
                if editor.textView.syntax.engine.revision != snapshot.revision { update(); return }
                destinations = result.locations
                panel?.show(result.hits, status: result.limited ? "First \(result.hits.count) matches" : nil)
            }
        case .files: break
        }
    }

    private func preview(_ item: QuickItem?) {
        guard !finished, let item else { return }
        switch location.scope {
        case .files:
            load(item.id, request: request) { _ in }
        case .line: break
        case .text, .symbol:
            guard let editor = previewEditor, let range = destinations[item.id], NSMaxRange(range) <= editor.findText.length else { return }
            editor.textView.unfold(intersecting: range)
            editor.selectFound([range], reveal: range)
        }
    }

    private func load(_ doc: String, request generation: Int, onReady: @escaping (CodeEditor) -> Void) {
        guard let screen else { return }
        if previewDoc == doc, let editor = previewEditor, screen.currentEditor === editor { onReady(editor); return }
        hasTransient = true
        previewDoc = doc
        previewEditor = nil
        screen.showTransient(doc, line: nil) { [weak self] result in
            guard let self, !finished, previewDoc == doc else { return }
            switch result {
            case .success(let editor):
                previewEditor = editor
                remember(editor)
                if request == generation { onReady(editor) }
            case .failure(let error):
                previewDoc = nil
                if request == generation { panel?.show([], status: error.localizedDescription) }
            }
        }
    }

    private func remember(_ editor: CodeEditor) {
        let key = ObjectIdentifier(editor)
        if positions[key] == nil { positions[key] = QuickEditorPosition(editor) }
    }

    private func accept(_ item: QuickItem?) {
        switch location.scope {
        case .line: guard lineToCommit != nil else { return }
        default: guard item?.enabled == true else { return }
        }
        finish(commit: true, detached: false)
    }

    private func finish(commit: Bool, detached: Bool) {
        guard !finished, let screen else { return }
        finished = true; filter?.cancel(); work?.cancel()
        symbols?.scan.cancel(); symbols?.list.cancel()
        for position in positions.values where !commit || position.editor !== (previewEditor ?? origin?.editor) { position.restore() }
        if !detached, let panel { screen.chrome.dismissOverlay(panel) }
        if hasTransient { screen.endTransient(commit: commit, focus: !detached) }
        else if !detached, screen.chrome.window?.isKeyWindow == true { screen.currentEditor?.focus() }
        onFinish?()
    }

}

private struct QuickSymbolList: Sendable {
    var items: [QuickItem] = []
    var locations: [String: NSRange] = [:]

    init(_ symbols: [CodeSymbol]) {
        for symbol in symbols {
            if Task.isCancelled { return }
            let id = String(symbol.range.location)
            locations[id] = symbol.range
            items.append(QuickItem(id, title: symbol.name, detail: ":\(symbol.line)", icon: Self.icon(symbol.kind)))
        }
    }

    private static func icon(_ kind: CodeSymbol.Kind) -> String {
        switch kind {
        case .heading: "number"
        case .function, .method: "function"
        case .class, .struct, .enum, .interface, .protocol, .type, .extension: "cube"
        case .variable, .constant: "x.squareroot"
        case .module: "shippingbox"
        }
    }
}

struct QuickTextMatches: Sendable {
    var hits: [QuickItem.Hit] = []
    var locations: [String: NSRange] = [:]
    var limited = false

    static func search(_ query: String, in text: String, limit: Int = 1_000) -> Self {
        var result = Self()
        guard !query.isEmpty, limit > 0 else { return result }
        let source = text as NSString
        let length = source.length
        var offset = 0
        var line = 1
        var lineRange = source.lineRange(for: NSRange(location: 0, length: 0))
        while offset < length, !Task.isCancelled {
            let range = source.range(of: query, options: .caseInsensitive, range: NSRange(location: offset, length: length - offset))
            if range.location == NSNotFound || range.length == 0 { break }
            if result.hits.count >= limit { result.limited = true; break }
            while range.location >= NSMaxRange(lineRange), lineRange.length > 0 {
                lineRange = source.lineRange(for: NSRange(location: NSMaxRange(lineRange), length: 0))
                line += 1
            }
            let start = max(lineRange.location, range.location - 45)
            let end = min(NSMaxRange(lineRange), NSMaxRange(range) + 100)
            let clip = source.rangeOfComposedCharacterSequences(for: NSRange(location: start, length: end - start))
            let prefix = clip.location > lineRange.location ? "…" : ""
            let sample = prefix + source.substring(with: clip).trimmingCharacters(in: .newlines)
                + (NSMaxRange(clip) < NSMaxRange(lineRange) ? "…" : "")
            let id = String(range.location)
            let mark = NSRange(location: range.location - clip.location + prefix.utf16.count, length: range.length)
            let item = QuickItem(id, title: sample, detail: ":\(line)", icon: "text.line.first.and.arrowtriangle.forward")
            result.hits.append(.init(item: item, match: .init(score: 0, ranges: [mark])))
            result.locations[id] = range
            offset = NSMaxRange(range)
        }
        return result
    }
}
