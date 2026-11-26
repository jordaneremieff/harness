import AppKit

private struct CollaborationAnchor: Hashable {
    enum Location: Hashable {
        case range(doc: String, rev: Int, start: Int, end: Int)
        case target(kind: String, key: String)
    }

    let location: Location

    init?(_ fields: Fields) {
        if let target = fields["target"] as? Fields,
           let kind = target["kind"] as? String, let key = target["key"] as? String {
            location = .target(kind: kind, key: key)
        } else if let doc = fields["doc"] as? String, !doc.isEmpty,
                  let rev = fields["rev"] as? Int, let start = fields["start"] as? Int,
                  let end = fields["end"] as? Int, start >= 0, end >= start {
            location = .range(doc: doc, rev: rev, start: start, end: end)
        } else {
            return nil
        }
    }

    var fields: Fields {
        switch location {
        case let .range(doc, rev, start, end): ["doc": doc, "rev": rev, "start": start, "end": end]
        case let .target(kind, key): ["target": ["kind": kind, "key": key]]
        }
    }

    var label: String {
        switch location {
        case let .range(doc, rev, start, end):
            start == end ? "\(doc) · revision \(rev), UTF-16 position \(start)" :
                "\(doc) · revision \(rev), UTF-16 range \(start)..<\(end)"
        case let .target(kind, key):
            "\(kind.capitalized): \(kind == "folder" && key.isEmpty ? "Workspace" : key)"
        }
    }

    var file: String? {
        switch location {
        case let .range(doc, _, _, _): doc
        case let .target(kind, key) where kind == "file" || kind == "tab": key
        default: nil
        }
    }
}

private struct CollaborationThread: Equatable {
    let id: String
    let anchor: CollaborationAnchor
    let count: Int
    let preview: String
    let shortened: Bool

    init?(_ fields: Fields) {
        guard let id = fields["id"] as? String, let anchor = CollaborationAnchor(fields),
              let count = fields["messageCount"] as? Int, let preview = fields["preview"] as? String else { return nil }
        self.id = id
        self.anchor = anchor
        self.count = count
        self.preview = preview
        shortened = fields["previewShortened"] as? Bool == true
    }
}

private struct CollaborationMember {
    let id: String
    let label: String
    let kind: String

    init?(_ fields: Fields) {
        guard let id = fields["id"] as? String, !id.isEmpty, let label = fields["label"] as? String,
              let kind = fields["kind"] as? String, kind == "ordinary" || kind == "durable" else { return nil }
        self.id = id
        self.label = label
        self.kind = kind
    }

    var title: String { "\(label) · \(kind == "durable" ? "Durable" : "Ordinary")" }
}

@MainActor
final class Collaboration: NSObject, NSTextViewDelegate {
    var onOpen: ((String, Int?) -> Void)?
    var onError: ((String) -> Void)?
    var onStatus: ((String) -> Void)?
    var view: NSView { page.view }
    var hasUnpostedText: Bool { writing || !drafts.isEmpty || !input.string.isEmpty }

    private enum Mode: Hashable {
        case inbox, note(CollaborationAnchor), thread(String)
    }

    private let api: any EditorAPI
    private let page = CollaborationLayout()
    private let detail = CollaborationLayout.column()
    private let inboxButton = collaborationButton("Threads", symbol: "chevron.backward")
    private let audience = NSPopUpButton(frame: .zero, pullsDown: false)
    private let audienceID = CollaborationLabel("", style: .secondary)
    private let reloadMembers = collaborationButton("", symbol: "arrow.clockwise")
    private let post = collaborationButton("Post Note", symbol: "bubble.left")
    private let send = collaborationButton("Send Request", symbol: "paperplane")
    private let input = NSTextView()
    private lazy var editor = textEditor()

    private var drafts: [Mode: String] = [:]
    private var mode: Mode = .inbox
    private var threads: [CollaborationThread] = []
    private var threadsLimited = false
    private var sequence: Int?
    private var threadTask: Task<Void, Never>?
    private var memberTask: Task<Void, Never>?
    private var writing = false
    private var stopped = false
    private var offline = false

    init(api: any EditorAPI) {
        self.api = api
        super.init()
        input.delegate = self
        inboxButton.run = { [weak self] in self?.showInbox() }
        reloadMembers.run = { [weak self] in self?.refreshMembers() }
        post.run = { [weak self] in self?.submit(deliver: false) }
        send.run = { [weak self] in self?.submit(deliver: true) }
        audience.target = self
        audience.action = #selector(audienceChanged)
        audience.isBordered = false
        audience.bezelStyle = .accessoryBarAction
        reloadMembers.toolTip = "Refresh recipients"
        reloadMembers.setAccessibilityLabel("Refresh recipients")
        reloadMembers.widthAnchor.constraint(equalToConstant: 29).isActive = true
        send.isOn = true
        page.onLook = { [weak self] in self?.applyLook() }
        applyLook()
        audience.setAccessibilityLabel("Exact recipient")
        audience.setContentHuggingPriority(.defaultLow, for: .horizontal)
        audience.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setMembers([], placeholder: "Choose a recipient")
        renderMode()
    }

    func stop() {
        stopped = true
        goOffline()
    }

    func goOffline() {
        offline = true
        threadTask?.cancel()
        threadTask = nil
        memberTask?.cancel()
        memberTask = nil
        updateControls()
    }

    func update(state: Fields) {
        guard !stopped, let newSequence = state["seq"] as? Int, sequence.map({ $0 < newSequence }) ?? true,
              let rows = state["threads"] as? [Fields] else { return }
        sequence = newSequence
        let previous = threads
        let limited = state["threadsLimited"] as? Bool == true
        let limitedChanged = limited != threadsLimited
        threadsLimited = limited
        threads = rows.compactMap(CollaborationThread.init)
        switch mode {
        case .inbox:
            if previous != threads || limitedChanged { renderInbox() }
        case .thread(let id):
            if let header = threads.first(where: { $0.id == id }),
               header != previous.first(where: { $0.id == id }) { loadThread(id) }
        case .note:
            break
        }
    }

    func compose(anchor: Fields) {
        guard let anchor = CollaborationAnchor(anchor) else {
            onError?("The note has no valid selection or target.")
            return
        }
        select(.note(anchor))
    }

    func showInbox() { select(.inbox) }

    private func select(_ next: Mode, draft: String? = nil) {
        guard !stopped, mode != next || draft != nil else { return }
        saveDraft()
        threadTask?.cancel()
        mode = next
        if let draft { drafts[next] = draft.isEmpty ? nil : draft }
        else {
            audience.selectItem(at: 0)
            audienceChanged()
        }
        input.string = next == .inbox ? "" : drafts[next, default: ""]
        renderMode()
        page.scrollToTop()
        if next != .inbox { refreshMembers() }
        else { memberTask?.cancel() }
    }

    func textDidChange(_ notification: Notification) { saveDraft() }

    private func saveDraft() {
        guard mode != .inbox else { return }
        drafts[mode] = input.string.isEmpty ? nil : input.string
    }

    private func renderMode() {
        page.clear()
        switch mode {
        case .inbox:
            page.add(CollaborationLabel("Threads", style: .heading))
            page.add(detail)
            renderInbox()
        case .note(let anchor):
            page.add(page.row([inboxButton, CollaborationLabel("New Note", style: .heading)]))
            page.add(detail)
            renderAnchor(anchor)
            renderComposer(reply: false)
        case .thread(let id):
            let reply = collaborationButton("", symbol: "square.and.pencil") { [weak self] in
                guard let self else { return }
                self.page.reveal(self.editor)
                self.input.window?.makeFirstResponder(self.input)
            }
            reply.setAccessibilityLabel("Write reply")
            reply.toolTip = "Write reply"
            reply.widthAnchor.constraint(equalToConstant: 27).isActive = true
            page.add(page.row([inboxButton, CollaborationLabel("Thread", style: .heading), CollaborationLayout.spacer(), reply]))
            page.add(detail)
            renderLoadingThread(id)
            renderComposer(reply: true)
            loadThread(id)
        }
        updateControls()
    }

    private func renderInbox() {
        page.clear(detail)
        for draft in drafts.keys.sorted(by: { draftTitle($0) < draftTitle($1) }) {
            switch draft {
            case .note:
                addInboxItem("Resume Note", draftTitle(draft), to: draft)
            case .thread(let id) where !threads.contains(where: { $0.id == id }):
                addInboxItem("Resume Reply", "Unposted reply", to: draft)
            default: break
            }
        }
        for thread in threads {
            let destination = Mode.thread(thread.id)
            let count = thread.count == 1 ? "1 message" : "\(thread.count) messages"
            let preview = thread.preview + (thread.shortened && !thread.preview.hasSuffix("…") ? "…" : "")
            let suffix = drafts[destination] == nil ? "" : " · Unposted reply"
            addInboxItem("Open Thread", "\(thread.anchor.label)\n\(preview)\n\(count)\(suffix)", to: destination)
        }
        if threads.isEmpty && drafts.isEmpty {
            page.add(CollaborationLabel("No threads yet. Add a note from a selection or workspace item.", style: .secondary), to: detail)
        } else if threadsLimited {
            page.add(CollaborationLabel("Only the most recent threads are shown.", style: .secondary), to: detail)
        }
    }

    private func draftTitle(_ draft: Mode) -> String {
        if case .note(let anchor) = draft { return anchor.label }
        if case .thread(let id) = draft { return id }
        return ""
    }

    private func addInboxItem(_ title: String, _ description: String, to destination: Mode) {
        let open = collaborationButton(title, symbol: "chevron.right") { [weak self] in self?.select(destination) }
        open.setAccessibilityLabel("\(title): \(description)")
        let item = CollaborationLayout.column()
        item.spacing = 3
        page.add(CollaborationLabel(description), to: item)
        page.add(page.row([open, CollaborationLayout.spacer()]), to: item)
        page.add(page.card(item), to: detail)
    }

    private func renderComposer(reply: Bool) {
        post.title = reply ? "Post Reply" : "Post Note"
        let label = CollaborationLabel(reply ? "Reply" : "Note", style: .heading)
        input.setAccessibilityLabel(label.stringValue)
        page.add(label)
        page.add(editor)
        page.add(CollaborationLabel("Send to a workspace participant", style: .secondary))
        page.add(page.row([audience, reloadMembers]))
        page.add(audienceID)
        page.add(post)
        page.add(send)
    }

    private func renderAnchor(_ anchor: CollaborationAnchor, quote: String? = nil) {
        page.clear(detail)
        page.add(CollaborationLabel(anchor.label, style: .secondary), to: detail)
        if let quote, !quote.isEmpty {
            page.add(CollaborationLabel("Original selection", style: .secondary), to: detail)
            page.add(page.card(CollaborationLabel(quote, style: .code, selectable: true)), to: detail)
        }
        if let file = anchor.file {
            let open = collaborationButton("Open File") { [weak self] in self?.onOpen?(file, nil) }
            page.add(page.row([open, CollaborationLayout.spacer()]), to: detail)
        }
    }

    private func renderLoadingThread(_ id: String) {
        if let header = threads.first(where: { $0.id == id }) { renderAnchor(header.anchor) }
        else { page.clear(detail) }
        page.add(CollaborationLabel("Loading thread…", style: .secondary), to: detail)
    }

    private func loadThread(_ id: String) {
        guard !stopped, !offline else { return }
        threadTask?.cancel()
        threadTask = Task { [weak self, api] in
            do {
                let thread = try await api.call("thread", ["id": id])
                guard !Task.isCancelled, let self, self.mode == .thread(id) else { return }
                guard let anchor = CollaborationAnchor(thread), let messages = thread["messages"] as? [Fields] else {
                    throw CollaborationIssue("Editor returned an invalid thread.")
                }
                self.renderAnchor(anchor, quote: thread["quote"] as? String)
                for message in messages {
                    guard let author = message["author"] as? String, let text = message["text"] as? String else { continue }
                    let item = CollaborationLayout.column()
                    item.spacing = 3
                    self.page.add(CollaborationLabel(author, style: .heading), to: item)
                    self.page.add(CollaborationLabel(text, selectable: true), to: item)
                    self.page.add(self.page.card(item), to: self.detail)
                }
            } catch {
                guard !Task.isCancelled, let self, self.mode == .thread(id) else { return }
                let retry = collaborationButton("Reload Thread") { [weak self] in self?.loadThread(id) }
                self.page.clear(self.detail)
                self.page.add(self.page.row([retry, CollaborationLayout.spacer()]), to: self.detail)
                self.onError?(error.localizedDescription)
            }
        }
    }

    private func refreshMembers() {
        guard !stopped, !offline, mode != .inbox else { return }
        memberTask?.cancel()
        memberTask = Task { [weak self, api] in
            do {
                let result = try await api.call("members", [:])
                guard !Task.isCancelled, let self, self.mode != .inbox else { return }
                guard let rows = result["members"] as? [Fields] else {
                    throw CollaborationIssue("Editor returned an invalid list of recipients.")
                }
                let list = rows.compactMap(CollaborationMember.init)
                self.setMembers(list, placeholder: list.isEmpty ? "No recipients connected" : "Choose a recipient")
            } catch {
                guard !Task.isCancelled, let self, self.mode != .inbox else { return }
                self.onError?(error.localizedDescription)
            }
        }
    }

    private var recipientID: String? { audience.selectedItem?.representedObject as? String }

    private func setMembers(_ members: [CollaborationMember], placeholder: String) {
        let previous = recipientID
        audience.removeAllItems()
        audience.addItem(withTitle: placeholder)
        for member in members {
            let item = NSMenuItem(title: member.title, action: nil, keyEquivalent: "")
            item.representedObject = member.id
            item.toolTip = member.id
            item.setAccessibilityLabel("\(member.title), \(member.id)")
            if members.contains(where: { $0.title == member.title && $0.id != member.id }) {
                item.title += " · \(member.id)"
            }
            audience.menu?.addItem(item)
        }
        if let previous, let item = audience.itemArray.first(where: { $0.representedObject as? String == previous }) {
            audience.select(item)
        } else {
            audience.selectItem(at: 0)
        }
        audienceChanged()
    }

    @objc private func audienceChanged() {
        audienceID.stringValue = recipientID ?? ""
        audienceID.isHidden = recipientID == nil
        updateControls()
    }

    private func updateControls() {
        let active = !writing && !stopped && !offline
        inboxButton.isEnabled = !writing && !stopped
        reloadMembers.isEnabled = active
        audience.isEnabled = active && audience.numberOfItems > 1
        input.isEditable = active
        post.isEnabled = active
        send.isEnabled = active && recipientID != nil
    }

    private func submit(deliver: Bool) {
        let origin = mode
        let text = input.string
        let recipient = deliver ? recipientID : nil
        guard !stopped, !offline, !writing, origin != .inbox, !deliver || recipient != nil else { return }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            onError?("Enter a message first.")
            return
        }
        writing = true
        updateControls()
        Task { [weak self] in
            guard let self else { return }
            defer {
                self.writing = false
                self.updateControls()
            }
            var created: String?
            do {
                let id: String
                switch origin {
                case .note(let anchor):
                    var fields = anchor.fields
                    fields["text"] = text
                    let result = try await self.api.call("note", fields)
                    guard let newID = result["id"] as? String else {
                        throw CollaborationIssue("Editor returned no thread ID for the note.")
                    }
                    id = newID
                    created = id
                case .thread(let threadID):
                    id = threadID
                    if recipient == nil { _ = try await self.api.call("reply", ["id": id, "text": text]) }
                case .inbox:
                    return
                }
                let status: String
                if let recipient {
                    let receipt = try await self.api.call("send", ["id": id, "to": recipient, "message": text])
                    guard receipt["accepted"] as? Bool == true else {
                        throw CollaborationIssue("The recipient did not accept the request.")
                    }
                    status = receipt["warning"] as? String ?? "Request accepted."
                } else {
                    status = created == nil ? "Reply posted." : "Note posted."
                }
                self.clearDraft(origin)
                if self.mode == origin {
                    if created != nil { self.select(.thread(id)) }
                    else { self.loadThread(id) }
                }
                if !self.stopped { self.onStatus?(status) }
            } catch {
                guard !self.stopped else { return }
                if let id = created {
                    self.clearDraft(origin)
                    if self.mode == origin { self.select(.thread(id), draft: text) }
                    else {
                        self.drafts[.thread(id)] = text
                        if self.mode == .inbox { self.renderInbox() }
                    }
                    self.onError?("The note is posted, but the request did not complete. \(error.localizedDescription)")
                } else {
                    self.onError?(error.localizedDescription)
                }
            }
        }
    }

    private func clearDraft(_ origin: Mode) {
        drafts.removeValue(forKey: origin)
        if mode == origin { input.string = "" }
        else if mode == .inbox { renderInbox() }
    }

    private func applyLook() {
        let theme = WorkspaceStyle.theme
        audience.font = WorkspaceStyle.interfaceFont(-1)
        audience.contentTintColor = theme.text
        let ranges = input.selectedRanges
        input.font = WorkspaceStyle.interfaceFont()
        input.textColor = theme.text
        input.insertionPointColor = theme.caret
        input.selectedTextAttributes = [.backgroundColor: theme.selection]
        input.backgroundColor = theme.editor
        if input.selectedRanges != ranges { input.selectedRanges = ranges }
        editor.backgroundColor = theme.editor
        editor.layer?.borderColor = theme.panelBorder.cgColor
    }

    private func textEditor() -> NSScrollView {
        let scroll = NSScrollView()
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 7
        scroll.layer?.borderWidth = 1
        scroll.layer?.masksToBounds = true
        input.isRichText = false
        input.importsGraphics = false
        input.isVerticallyResizable = true
        input.isHorizontallyResizable = false
        input.autoresizingMask = [.width]
        input.textContainerInset = NSSize(width: 9, height: 8)
        input.textContainer?.widthTracksTextView = true
        scroll.documentView = input
        scroll.heightAnchor.constraint(equalToConstant: 104).isActive = true
        return scroll
    }
}

@MainActor
final class CompositionPage {
    var onOpen: ((String, Int?) -> Void)?
    var onNote: ((Fields) -> Void)?
    var view: NSView { page.view }

    private let api: any EditorAPI
    private let id: String
    private let page = CollaborationLayout()
    private var displayedRevision: Int?
    private var request: UInt = 0
    private var pendingRevision: Int?

    init(api: any EditorAPI, id: String) {
        self.api = api
        self.id = id
        page.add(CollaborationLabel("Loading view…", style: .secondary))
    }

    func update(revision: Int) async throws {
        guard [displayedRevision, pendingRevision].compactMap({ $0 }).allSatisfy({ $0 < revision }) else { return }
        try await read(revision: revision)
    }

    func refresh() async throws { try await read(revision: nil) }

    private func read(revision: Int?) async throws {
        request &+= 1
        let current = request
        pendingRevision = revision
        defer { if current == request { pendingRevision = nil } }
        let result = try await api.call("view", ["id": id])
        try Task.checkCancellation()
        guard current == request else { return }
        guard let revision = result["rev"] as? Int, let title = result["title"] as? String,
              let blocks = result["blocks"] as? [Fields] else {
            throw CollaborationIssue("Editor returned an invalid composed view.")
        }
        guard displayedRevision.map({ $0 < revision }) ?? true else { return }
        let content = try blocks.map(makeBlock)
        displayedRevision = revision
        page.clear()
        page.add(CollaborationLabel(title, style: .heading, selectable: true))
        let note = collaborationButton("Add Note", symbol: "bubble.left") { [weak self] in
            guard let self else { return }
            self.onNote?(["target": ["kind": "view", "key": self.id]])
        }
        page.add(page.row([note, CollaborationLayout.spacer()]))
        for block in content { page.add(block) }
    }

    private func makeBlock(_ block: Fields) throws -> NSView {
        guard let kind = block["kind"] as? String, let text = block["text"] as? String else {
            throw CollaborationIssue("Editor returned an invalid view block.")
        }
        switch kind {
        case "text": return CollaborationLabel(text, selectable: true)
        case "code": return page.card(CollaborationLabel(text, style: .code, selectable: true))
        case "location":
            guard let file = block["doc"] as? String, let line = block["line"] as? Int, line > 0 else {
                throw CollaborationIssue("Editor returned an invalid file location.")
            }
            let location = CollaborationLayout.column()
            location.spacing = 3
            if !text.isEmpty { page.add(CollaborationLabel(text, selectable: true), to: location) }
            let address = "\(file):\(line)"
            page.add(CollaborationLabel(address, style: .secondary, selectable: true), to: location)
            let open = collaborationButton("Open File", symbol: "arrow.up.right") { [weak self] in self?.onOpen?(file, line) }
            open.setAccessibilityLabel("Open \(address)")
            page.add(page.row([open, CollaborationLayout.spacer()]), to: location)
            return page.card(location)
        default:
            throw CollaborationIssue("Editor returned an unknown view block.")
        }
    }
}

private struct CollaborationIssue: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
