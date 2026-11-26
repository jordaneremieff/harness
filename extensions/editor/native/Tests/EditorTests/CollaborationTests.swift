import AppKit
import Testing
@testable import Editor

@MainActor
struct CollaborationTests {
    @Test func requestsUseExactRecipientIDsAndDisplayDeliveryStatus() async throws {
        let durable = "11111111-1111-4111-8111-111111111111:23"
        let ordinary = "22222222-2222-4222-8222-222222222222"
        let api = CollaborationFixture()
        api.members = [
            ["id": durable, "label": "Same label", "kind": "durable"],
            ["id": ordinary, "label": "Same label", "kind": "ordinary"],
        ]
        let collaboration = Collaboration(api: api)
        let receipts = AsyncStream<String>.makeStream()
        var statuses = receipts.stream.makeAsyncIterator()
        var calls = api.observed.stream.makeAsyncIterator()
        collaboration.onStatus = { receipts.continuation.yield($0) }
        collaboration.update(state: api.state(sequence: 1))
        try click("Open Thread", in: collaboration.view)
        try await observe("members", from: &calls)
        let popup = try #require(children(of: collaboration.view, type: NSPopUpButton.self).first)
        #expect(popup.selectedItem?.representedObject == nil)

        for target in [durable, ordinary] {
            let item = try #require(popup.itemArray.first(where: { $0.representedObject as? String == target }))
            popup.select(item)
            try trigger(popup)
            #expect(labels(in: collaboration.view).contains(target))
            try fill("Please inspect this", in: collaboration.view)
            try click("Send Request", in: collaboration.view)
            let status = await statuses.next()
            #expect(status == "Request accepted.")
            #expect(!(collaboration.hasUnpostedText))
        }

        let sends = api.calls.filter { $0.op == "send" }.map(\.fields)
        #expect(sends.compactMap { $0["to"] as? String } == [durable, ordinary])
        #expect(sends.compactMap { $0["id"] as? String } == [api.id, api.id])
        #expect(sends.compactMap { $0["message"] as? String } == ["Please inspect this", "Please inspect this"])
        #expect(!(api.calls.contains { $0.op == "reply" }))
    }

    @Test func noteUsesExactUTF16RangeAndDisplaysHistoricalQuote() async throws {
        let api = CollaborationFixture()
        let collaboration = Collaboration(api: api)
        let receipts = AsyncStream<String>.makeStream()
        var statuses = receipts.stream.makeAsyncIterator()
        var calls = api.observed.stream.makeAsyncIterator()
        collaboration.onStatus = { receipts.continuation.yield($0) }
        let quote = "👩🏽‍💻e\u{301}"
        let draft = "⚙️ \(quote) trailing"
        let selected = (draft as NSString).range(of: quote)
        let anchor: Fields = ["doc": "Sources/Example.swift", "rev": 3, "start": selected.location, "end": NSMaxRange(selected)]
        api.anchor = anchor
        api.quote = quote
        collaboration.update(state: api.state(sequence: 1))
        collaboration.compose(anchor: anchor)
        try fill("Keep this note", in: collaboration.view)
        #expect(collaboration.hasUnpostedText)
        collaboration.showInbox()
        #expect(collaboration.hasUnpostedText)
        try click("Resume Note", in: collaboration.view)
        #expect(children(of: collaboration.view, type: NSTextView.self).first?.string == "Keep this note")
        try click("Post Note", in: collaboration.view)
        let status = await statuses.next()
        #expect(status == "Note posted.")
        try await observe("thread", from: &calls)

        let note = try #require(api.calls.first { $0.op == "note" }).fields
        #expect(note["doc"] as? String == "Sources/Example.swift")
        #expect(note["rev"] as? Int == 3)
        #expect(note["start"] as? Int == 3)
        #expect(note["end"] as? Int == 3 + quote.utf16.count)
        #expect(note["text"] as? String == "Keep this note")
        #expect(!(collaboration.hasUnpostedText))
        #expect(labels(in: collaboration.view).contains(quote))
        #expect(labels(in: collaboration.view).contains { $0.contains("revision 3") })
        var opened: (String, Int?)?
        collaboration.onOpen = { opened = ($0, $1) }
        try click("Open File", in: collaboration.view)
        #expect(opened?.0 == "Sources/Example.swift")
        #expect(opened?.1 == nil)
    }

    @Test func replySurvivesThreadUpdateAndPostsToThread() async throws {
        let api = CollaborationFixture()
        let collaboration = Collaboration(api: api)
        let receipts = AsyncStream<String>.makeStream()
        var statuses = receipts.stream.makeAsyncIterator()
        var calls = api.observed.stream.makeAsyncIterator()
        collaboration.onStatus = { receipts.continuation.yield($0) }
        collaboration.update(state: api.state(sequence: 1))
        try click("Open Thread", in: collaboration.view)
        try await observe("thread", from: &calls)
        let editor = try fill("Unposted reply", in: collaboration.view)
        api.messages.append(["author": "Agent", "text": "Incoming reply"])
        collaboration.update(state: api.state(sequence: 2))
        try await observe("thread", from: &calls)
        #expect(children(of: collaboration.view, type: NSTextView.self).first === editor)
        #expect(editor.string == "Unposted reply")
        #expect(labels(in: collaboration.view).contains("Incoming reply"))
        #expect(collaboration.hasUnpostedText)
        try click("Post Reply", in: collaboration.view)
        let status = await statuses.next()
        #expect(status == "Reply posted.")
        try await observe("thread", from: &calls)
        let reply = try #require(api.calls.first { $0.op == "reply" }).fields
        #expect(reply["id"] as? String == api.id)
        #expect(reply["text"] as? String == "Unposted reply")
        #expect(labels(in: collaboration.view).contains("Unposted reply"))
        #expect(!(collaboration.hasUnpostedText))
    }

    @Test func retryAfterFailedDeliveryReusesPostedThread() async throws {
        let api = CollaborationFixture()
        api.members = [["id": "agent-id", "label": "Agent", "kind": "durable"]]
        api.failSend = true
        let collaboration = Collaboration(api: api)
        let errors = AsyncStream<String>.makeStream()
        let receipts = AsyncStream<String>.makeStream()
        var failures = errors.stream.makeAsyncIterator()
        var statuses = receipts.stream.makeAsyncIterator()
        var calls = api.observed.stream.makeAsyncIterator()
        collaboration.onStatus = { receipts.continuation.yield($0) }
        collaboration.onError = { errors.continuation.yield($0) }
        collaboration.compose(anchor: ["target": ["kind": "folder", "key": ""]])
        try await observe("members", from: &calls)
        let popup = try #require(children(of: collaboration.view, type: NSPopUpButton.self).first)
        popup.selectItem(at: 1)
        try trigger(popup)
        try fill("Inspect this folder", in: collaboration.view)
        try click("Send Request", in: collaboration.view)
        let failure = await failures.next()
        #expect(failure?.contains("The note is posted") == true)
        #expect(collaboration.hasUnpostedText)
        #expect(children(of: collaboration.view, type: NSTextView.self).first?.string == "Inspect this folder")
        let posted = try #require(api.calls.first { $0.op == "note" }).fields
        #expect(posted["target"] as? [String: String] == ["kind": "folder", "key": ""])
        #expect(posted["doc"] == nil)

        api.failSend = false
        api.sendWarning = "The request was accepted without a thread receipt."
        try click("Send Request", in: collaboration.view)
        let status = await statuses.next()
        #expect(status == api.sendWarning)
        #expect(api.calls.filter { $0.op == "note" }.count == 1)
        #expect(api.calls.filter { $0.op == "send" }.compactMap { $0.fields["id"] as? String } == [api.id, api.id])
        #expect(!(collaboration.hasUnpostedText))
    }

    @Test func stopCancelsThreadAndParticipantReads() async throws {
        let api = CollaborationFixture()
        api.heldOperations = ["thread", "members"]
        let collaboration = Collaboration(api: api)
        var started = api.started.stream.makeAsyncIterator()
        var completed = api.observed.stream.makeAsyncIterator()
        collaboration.update(state: api.state(sequence: 1))
        try click("Open Thread", in: collaboration.view)
        let first = await started.next()
        let second = await started.next()
        #expect(Set([first, second].compactMap { $0 }) == ["thread", "members"])

        collaboration.stop()
        api.release("thread")
        api.release("members")
        let firstCompletion = await completed.next()
        let secondCompletion = await completed.next()
        #expect(Set([firstCompletion, secondCompletion].compactMap { $0 }) == ["thread", "members"])
        #expect(api.cancelledOperations == ["thread", "members"])
        #expect(!labels(in: collaboration.view).contains("First message"))
    }

    @Test func closeGuardStaysActiveUntilDeliveryCompletes() async throws {
        let api = CollaborationFixture()
        api.members = [["id": "agent-id", "label": "Agent", "kind": "ordinary"]]
        api.heldOperations = ["send"]
        let collaboration = Collaboration(api: api)
        let receipts = AsyncStream<String>.makeStream()
        var statuses = receipts.stream.makeAsyncIterator()
        var started = api.started.stream.makeAsyncIterator()
        var calls = api.observed.stream.makeAsyncIterator()
        collaboration.onStatus = { receipts.continuation.yield($0) }
        collaboration.update(state: api.state(sequence: 1))
        try click("Open Thread", in: collaboration.view)
        try await observe("members", from: &calls)
        let popup = try #require(children(of: collaboration.view, type: NSPopUpButton.self).first)
        popup.selectItem(at: 1)
        try trigger(popup)
        try fill("Send this once", in: collaboration.view)
        try click("Send Request", in: collaboration.view)
        try await observe("send", from: &started)
        collaboration.showInbox()
        #expect(collaboration.hasUnpostedText)
        api.release("send")
        let status = await statuses.next()
        #expect(status == "Request accepted.")
        #expect(!collaboration.hasUnpostedText)
    }

    @Test func compositionOpensExactFileAndLineAndSkipsUnchangedVersions() async throws {
        let api = CollaborationFixture()
        let address = "Sources/Unicode-🧰.swift"
        let prose = String(repeating: "Read this literal <text> without markup before opening the example. ", count: 14)
        api.blocks = [
            ["kind": "text", "text": prose],
            ["kind": "code", "text": "let value = 4\nprint(value)"],
            ["kind": "location", "text": "See example", "doc": address, "line": 17],
        ]
        let composition = CompositionPage(api: api, id: "composed-id")
        try await composition.update(revision: 1)
        try await composition.update(revision: 1)
        #expect(api.calls.filter { $0.op == "view" }.count == 1)
        var opened: (String, Int?)?
        var note: Fields?
        composition.onOpen = { opened = ($0, $1) }
        composition.onNote = { note = $0 }
        composition.view.frame = NSRect(x: 0, y: 0, width: 350, height: 290)
        composition.view.layoutSubtreeIfNeeded()
        composition.view.layoutSubtreeIfNeeded()
        let rendered = try #require(children(of: composition.view, type: NSTextField.self).first { $0.stringValue == prose })
        #expect(rendered.frame.width <= 350)
        #expect(rendered.frame.width > 250)
        #expect(rendered.frame.height > 100)
        let scroll = try #require(composition.view as? NSScrollView)
        #expect(try #require(scroll.documentView).frame.height > scroll.bounds.height)
        try click("Open File", in: composition.view)
        #expect(opened?.0 == address)
        #expect(opened?.1 == 17)
        try click("Add Note", in: composition.view)
        #expect(note?["target"] as? [String: String] == ["kind": "view", "key": "composed-id"])

        api.viewRevision = 2
        api.blocks = [["kind": "text", "text": "New revision"]]
        try await composition.update(revision: 2)
        try await composition.update(revision: 1)
        #expect(api.calls.filter { $0.op == "view" }.count == 2)
        #expect(labels(in: composition.view).contains("New revision"))
    }

    private func observe(_ op: String, from stream: inout AsyncStream<String>.Iterator) async throws {
        while let observed = await stream.next(isolation: MainActor.shared) { if observed == op { return } }
        throw CollaborationFixtureIssue()
    }

    private func children<T: NSView>(of view: NSView, type: T.Type) -> [T] {
        (view as? T).map { [$0] } ?? view.subviews.flatMap { children(of: $0, type: type) }
    }

    private func labels(in view: NSView) -> [String] {
        children(of: view, type: NSTextField.self).map(\.stringValue)
    }

    private func click(_ title: String, in view: NSView) throws {
        let button = try #require(children(of: view, type: NSButton.self).first { $0.title == title })
        #expect(button.isEnabled)
        try trigger(button)
    }

    private func trigger(_ control: NSControl) throws {
        #expect(NSApplication.shared.sendAction(try #require(control.action), to: control.target, from: control))
    }

    @discardableResult
    private func fill(_ text: String, in view: NSView) throws -> NSTextView {
        let field = try #require(children(of: view, type: NSTextView.self).first)
        field.string = text
        return field
    }
}

@MainActor
private final class CollaborationFixture: EditorAPI {
    let id = "thread-id"
    var calls: [(op: String, fields: Fields)] = []
    let observed = AsyncStream<String>.makeStream()
    let started = AsyncStream<String>.makeStream()
    var heldOperations: Set<String> = []
    var cancelledOperations: Set<String> = []
    private var waiting: [String: CheckedContinuation<Void, Never>] = [:]
    var members: [Fields] = []
    var messages: [Fields] = [["author": "Agent", "text": "First message"]]
    var anchor: Fields = ["target": ["kind": "file", "key": "Example.swift"]]
    var quote = ""
    var failSend = false
    var sendWarning: String?
    var viewRevision = 1
    var blocks: [Fields] = []

    func state(sequence: Int) -> Fields {
        var header = anchor
        header["id"] = id
        header["quote"] = quote
        header["preview"] = messages.last?["text"]
        header["messageCount"] = messages.count
        return ["seq": sequence, "docs": [["doc": "Sources/Example.swift", "rev": 9]], "threads": [header]]
    }

    func release(_ op: String) {
        heldOperations.remove(op)
        waiting.removeValue(forKey: op)?.resume()
    }

    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        calls.append((op, fields))
        started.continuation.yield(op)
        defer { observed.continuation.yield(op) }
        if heldOperations.contains(op) {
            await withCheckedContinuation { waiting[op] = $0 }
        }
        if Task.isCancelled { cancelledOperations.insert(op) }
        switch op {
        case "members": return ["members": members]
        case "thread":
            var data = anchor
            data["id"] = id
            data["quote"] = quote
            data["messages"] = messages
            return data
        case "note", "reply":
            if op == "note" {
                anchor = fields.filter { $0.key != "text" }
                messages = []
            }
            messages.append(["author": "You", "text": fields["text"] ?? ""])
            return ["id": id]
        case "send":
            if failSend { throw CollaborationFixtureIssue() }
            if let sendWarning { return ["accepted": true, "warning": sendWarning] }
            messages.append(["author": "You", "text": "Delivery receipt"])
            return ["accepted": true]
        case "view": return ["id": "composed-id", "rev": viewRevision, "title": "Example", "blocks": blocks]
        default: throw CollaborationFixtureIssue()
        }
    }
}

private struct CollaborationFixtureIssue: Error {}
