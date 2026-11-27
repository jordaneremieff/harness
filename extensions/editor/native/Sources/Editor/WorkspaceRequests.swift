import AppKit

struct RequestParticipant: Equatable {
    let id: String
    let label: String

    init?(_ fields: Fields) {
        guard let id = fields["id"] as? String, !id.isEmpty, let label = fields["label"] as? String,
              let kind = fields["kind"] as? String, kind == "ordinary" || kind == "durable" else { return nil }
        self.id = id
        self.label = label
    }
}

struct RequestThreadHeader: Equatable {
    let anchor: CodeThreadAnchor
    let requestState: String?
    let requestBy: String?
    let requestAt: Int?
    let count: Int
    let files: [String]

    init?(_ fields: Fields) {
        guard let anchor = CodeThreadAnchor(fields) else { return nil }
        self.anchor = anchor
        requestState = fields["requestState"] as? String
        requestBy = (fields["requestBy"] as? Fields).flatMap(RequestParticipant.init)?.id ?? fields["requestBy"] as? String
        requestAt = fields["requestAt"] as? Int
        count = fields["messageCount"] as? Int ?? 0
        files = Array((fields["changedFiles"] as? [String] ?? []).prefix(50))
    }
}

@MainActor
final class WorkspaceRequests {
    private struct Message: Equatable {
        let author: String
        let text: String
    }

    @MainActor
    private final class Card {
        weak var editor: CodeEditor?
        let span: TrackedDraftRange
        var thread: String?
        var draft = ""
        var messages: [Message] = []
        var delivery: (state: String, at: Int)?
        var failure: String?
        var writing = false
        var loading: Task<Void, Never>?
        var loadedCount: Int?

        init(editor: CodeEditor, span: TrackedDraftRange, thread: String? = nil) {
            self.editor = editor
            self.span = span
            self.thread = thread
        }
    }

    let view = RequestCardView()
    private let api: any EditorAPI
    private var members: [RequestParticipant] = []
    private(set) var session: RequestParticipant?
    private var headers: [String: RequestThreadHeader] = [:]
    private var anchorsByFile: [String: [CodeThreadAnchor]] = [:]
    private var liveFiles: [String: [String]] = [:]
    private var cards: [String: Card] = [:]
    private var newCards: [Card] = []
    private var shown: Card?
    private var choosingSession = false
    private var connected = true
    private var sequence: Int?

    var onOpen: ((String) -> Void)?
    var onResumeFile: ((String, @escaping @MainActor () -> Void) -> Void)?
    var onCompose: ((CodeEditor) -> Void)?
    var onSession: (() -> Void)?
    var onError: ((String) -> Void)?
    var onReveal: ((Fields) -> Void)?
    var currentEditor: CodeEditor? { shown?.editor }
    var hasUnpostedText: Bool { allCards.contains { hasText($0) } }
    private var allCards: [Card] { newCards + Array(cards.values) }

    init(api: any EditorAPI) {
        self.api = api
        view.onSend = { [weak self] in self?.send() }
        view.onClose = { [weak self] in self?.hide(returnFocus: true) }
        view.onRecipient = { [weak self] in self?.choose($0) }
        view.onOpenFile = { [weak self] in self?.onOpen?($0) }
    }

    func bind(_ editor: CodeEditor) {
        editor.onAsk = { [weak self, weak editor] span in
            guard let self, let editor else { return }
            compose(at: span, in: editor)
        }
        editor.textView.openThread = { [weak self, weak editor] id in
            guard let self, let editor else { return }
            open(id, in: editor)
        }
        editor.updateThreadAnchors(anchorsByFile[editor.doc] ?? [])
    }

    func state(_ fields: Fields, editors: [CodeEditor]) {
        if let rows = fields["members"] as? [Fields] { members = rows.compactMap(RequestParticipant.init) }
        if let raw = fields["currentSession"] { setSession((raw as? Fields).flatMap(RequestParticipant.init)) }
        if let rows = fields["threads"] as? [Fields], let seq = fields["seq"] as? Int,
           sequence.map({ seq >= $0 }) ?? true {
            sequence = seq
            let values = rows.compactMap(RequestThreadHeader.init)
            let next = Dictionary(values.map { ($0.anchor.id, $0) }, uniquingKeysWith: { first, _ in first })
            if next != headers {
                headers = next
                for (id, paths) in liveFiles {
                    let recorded = Set(next[id]?.files ?? [])
                    liveFiles[id] = paths.filter { !recorded.contains($0) }
                    if liveFiles[id]?.isEmpty == true { liveFiles[id] = nil }
                }
                anchorsByFile = Dictionary(grouping: values.map(\.anchor), by: \.doc)
                for editor in editors { editor.updateThreadAnchors(anchorsByFile[editor.doc] ?? []) }
            }
        }
        if let shown, let id = shown.thread, let count = headers[id]?.count, shown.loadedCount != count { load(shown) }
        paint()
    }

    func event(_ fields: Fields) {
        switch fields["type"] as? String {
        case "members":
            if let rows = fields["members"] as? [Fields] { members = rows.compactMap(RequestParticipant.init) }
            if let session, !members.contains(where: { $0.id == session.id }) { setSession(nil) }
        case "attach":
            if let participant = (fields["participant"] as? Fields).flatMap(RequestParticipant.init) {
                if !members.contains(where: { $0.id == participant.id }) { members.append(participant) }
                setSession(participant)
            }
        case "request":
            if let id = fields["thread"] as? String, let state = fields["state"] as? String, let card = cards[id],
               let at = fields["at"] as? Int, at >= (card.delivery?.at ?? 0) {
                card.delivery = (state, at)
                if state == "answered" || state == "failed" { load(card, force: true) }
            }
        case "file":
            if let id = fields["thread"] as? String, let path = fields["path"] as? String {
                var paths = liveFiles[id, default: []]
                paths.removeAll { $0 == path }
                liveFiles[id] = Array(([path] + paths).prefix(50))
                if liveFiles.count > 100, let first = liveFiles.keys.first(where: { $0 != id && cards[$0] == nil }) { liveFiles[first] = nil }
            }
        case "show": onReveal?(fields)
        default: return
        }
        paint()
    }

    func applyLook() { view.applyLook() }

    func goOffline() {
        connected = false
        setSession(nil)
        members = []
        paint()
    }

    func stop() {
        for card in allCards { card.loading?.cancel() }
        goOffline()
        hide(returnFocus: false)
    }

    func resumeDraft(in editor: CodeEditor? = nil) {
        guard let card = allCards.first(where: { card in (editor == nil || card.editor === editor) && hasText(card) }),
              let origin = card.editor else { return }
        if origin.view.window != nil { show(card, focus: true) }
        else { onResumeFile?(origin.doc) { [weak self] in self?.show(card, focus: true) } }
    }

    func hasDraft(in editor: CodeEditor) -> Bool { allCards.contains { $0.editor === editor && hasText($0) } }

    func close(_ editor: CodeEditor) {
        if shown?.editor === editor { hide() }
        newCards.removeAll { $0.editor === editor }
        cards = cards.filter { $0.value.editor !== editor }
    }

    private func hasText(_ card: Card) -> Bool {
        card.writing || !(card === shown ? view.input.string : card.draft).isEmpty
    }

    func hide(returnFocus: Bool = false) {
        guard let shown else { return }
        captureDraft()
        let editor = shown.editor
        let focused = view.window?.firstResponder === view.input
        self.shown = nil
        editor?.scroll.showRequest(nil, anchor: nil)
        if focused && returnFocus { editor?.focus() }
        prune()
    }

    private func compose(at span: TrackedDraftRange, in editor: CodeEditor) {
        let previous = newCards.first { $0.editor === editor && $0.span.intact && $0.span.range == span.range }
        let card = previous ?? Card(editor: editor, span: span)
        onCompose?(editor)
        show(card, focus: true)
    }

    private func open(_ thread: String, in editor: CodeEditor) {
        guard let span = editor.textView.threadMarks.first(where: { $0.id == thread })?.span else { return }
        let card = cards[thread] ?? Card(editor: editor, span: span, thread: thread)
        show(card, focus: false)
        load(card)
    }

    private func show(_ card: Card, focus: Bool) {
        guard let editor = card.editor else { return }
        if shown !== card {
            hide()
            if let id = card.thread { cards[id] = card }
            else if !newCards.contains(where: { $0 === card }) { newCards.append(card) }
            shown = card
            view.input.string = card.draft
            editor.scroll.showRequest(view, anchor: card.span)
        }
        paint()
        if focus { view.focusInput() }
    }

    private func captureDraft() { if let shown { shown.draft = view.input.string } }

    private func prune() {
        newCards.removeAll { $0 !== shown && !$0.writing && $0.draft.isEmpty }
        cards = cards.filter { $0.value === shown || $0.value.writing || !$0.value.draft.isEmpty }
    }

    private func setSession(_ participant: RequestParticipant?) {
        guard participant != session else { return }
        session = participant
        onSession?()
    }

    private func choose(_ id: String?) {
        guard connected, !choosingSession, id != session?.id else { return }
        choosingSession = true
        paint()
        Task { [weak self, api] in
            guard let self else { return }
            defer { choosingSession = false; paint() }
            do {
                let result = try await api.call("session", ["id": id as Any? ?? NSNull()])
                let current = (result["currentSession"] as? Fields).flatMap(RequestParticipant.init)
                setSession(current)
            } catch { onError?(error.localizedDescription) }
        }
    }

    private func paint() {
        guard let shown, let editor = shown.editor else { return }
        let span = shown.span.range
        let first = editor.textView.line(at: span.location) + 1
        let last = editor.textView.line(at: max(span.location, NSMaxRange(span) - 1)) + 1
        let title = "\(editor.title)  ·  \(last == first ? "Line \(first)" : "Lines \(first)–\(last)")"
        let header = shown.thread.flatMap { headers[$0] }
        let phase = phase(shown, header: header)
        let state = shown.failure ?? (shown.writing ? "Sending…" : nil) ?? stateName(phase)
        editor.scroll.requestHeight = shown.thread == nil ? 240 : 355
        let eventPaths = shown.thread.flatMap { liveFiles[$0] } ?? []
        let files = Array((eventPaths + (header?.files ?? []).filter { !eventPaths.contains($0) }).prefix(50))
        view.update(title: title, recipients: members.map { ($0.id, $0.label) }, selected: session?.id,
                    state: state, messages: shown.messages.map { ($0.author, $0.text) }, files: files,
                    pending: shown.writing || choosingSession || !connected || phase == "queued" || phase == "working")
        editor.scroll.needsLayout = true
    }

    private func phase(_ card: Card, header: RequestThreadHeader?) -> String? {
        card.delivery.flatMap { $0.at >= (header?.requestAt ?? 0) ? $0.state : nil } ?? header?.requestState
    }

    private func stateName(_ state: String?) -> String? {
        switch state {
        case "queued": "Queued"
        case "working": "Working"
        case "answered": "Answered"
        case "failed": "Request failed"
        default: nil
        }
    }

    private func send() {
        guard connected, !choosingSession, let recipient = session?.id, let card = shown,
              let editor = card.editor, !card.writing else { return }
        let currentPhase = phase(card, header: card.thread.flatMap { headers[$0] })
        guard currentPhase != "queued", currentPhase != "working" else { return }
        captureDraft()
        let text = card.draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard text.utf16.count <= 8192 else { card.failure = "Use at most 8,192 UTF-16 units."; paint(); return }
        card.failure = nil
        card.writing = true
        paint()
        Task { [weak self, api] in
            guard let self else { return }
            defer { card.writing = false; paint() }
            do {
                let thread: String
                if let id = card.thread { thread = id }
                else {
                    var fields = try await editor.requestAnchor(card.span)
                    fields["text"] = text
                    let result = try await api.call("note", fields)
                    guard let id = result["id"] as? String else {
                        throw EditorIssue(code: "response", message: "Editor returned no thread for this request.")
                    }
                    thread = id
                    card.thread = id
                    card.messages = [Message(author: "You", text: text)]
                    newCards.removeAll { $0 === card }
                    cards[id] = card
                }
                card.delivery = ("queued", 0)
                let result = try await api.call("send", ["id": thread, "to": recipient, "message": text])
                guard result["accepted"] as? Bool == true else {
                    throw EditorIssue(code: "rejected", message: "The session did not accept the request.")
                }
                card.failure = result["warning"] as? String
                if shown === card { captureDraft() }
                if card.draft.utf8.elementsEqual(text.utf8) {
                    card.draft = ""
                    if shown === card { view.input.string = "" }
                }
                load(card, force: true)
            } catch {
                card.delivery = nil
                card.failure = error.localizedDescription
            }
        }
    }

    private func load(_ card: Card, force: Bool = false) {
        guard connected, let id = card.thread, force || card.loading == nil else { return }
        card.loading?.cancel()
        card.loading = Task { [weak self, api] in
            do {
                let details = try await api.call("thread", ["id": id])
                guard !Task.isCancelled, let self else { return }
                card.loading = nil
                if let results = details["messages"] as? [Fields] {
                    card.loadedCount = results.count
                    card.messages = results.compactMap { row in
                        guard let author = row["author"] as? String, let text = row["text"] as? String else { return nil }
                        return Message(author: author, text: text)
                    }
                }
                if shown === card { paint() }
            } catch {
                guard !Task.isCancelled, let self else { return }
                card.loading = nil
                if shown === card { card.failure = error.localizedDescription; paint() }
            }
        }
    }
}
