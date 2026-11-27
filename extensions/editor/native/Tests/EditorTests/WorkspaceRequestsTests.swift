import AppKit
import Testing
@testable import Editor

@MainActor
@Suite(.serialized)
struct WorkspaceRequestsTests {
    @Test func requestCardKeepsTextOnEscapeAndUsesItsThreadForFollowUps() async throws {
        _ = NSApplication.shared
        let api = RequestFixture()
        let editor = CodeEditor(api: api, record: api.record)
        let requests = WorkspaceRequests(api: api)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 480), styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = editor.scroll
        defer { requests.stop(); editor.stop(); window.orderOut(nil) }
        requests.bind(editor)
        requests.state(["seq": 1, "threads": [], "currentSession": api.agent, "members": [api.agent]], editors: [editor])
        #expect(requests.session?.label == "Source Agent")
        let selected = editor.textView.source.range(of: "choice")
        editor.textView.setSelectedRange(selected)
        editor.askSelection()
        editor.scroll.layoutSubtreeIfNeeded()
        let avoided = try #require(editor.textView.collaborationBounds(for: selected, in: editor.textView.visibleRect))
        let cardInSource = editor.textView.convert(requests.view.bounds, from: requests.view)
        #expect(!cardInSource.intersects(avoided))
        #expect(window.firstResponder === requests.view.input)
        requests.view.input.insertText("Check this choice", replacementRange: NSRange(location: 0, length: 0))
        requests.view.input.keyDown(with: try key("\r", code: 36, window: window))
        requests.view.input.insertText("Keep the explanation short.", replacementRange: requests.view.input.selectedRange())
        #expect(requests.view.input.string == "Check this choice\nKeep the explanation short.")
        requests.view.input.keyDown(with: try key("\u{1b}", code: 53, window: window))
        #expect(requests.hasUnpostedText)
        #expect(window.firstResponder === editor.textView)
        editor.askSelection()
        #expect(requests.view.input.string.contains("Keep the explanation short."))
        requests.view.input.keyDown(with: try key("\r", code: 36, modifiers: .command, window: window))
        try await wait { api.sent.count == 1 && !requests.hasUnpostedText }
        let note = try #require(api.notes.first)
        #expect(note["rev"] as? Int == 1)
        #expect(note["start"] as? Int == selected.location)
        #expect(note["end"] as? Int == NSMaxRange(selected))

        api.messages.append(["author": "Source Agent", "text": "The choice is sound."])
        requests.state(["seq": 2, "threads": [api.header], "members": [api.agent], "currentSession": api.agent], editors: [editor])
        requests.event(["type": "request", "thread": "thread", "state": "answered", "at": 20, "by": api.agent])
        try await wait { labels(requests.view).contains("The choice is sound.") }
        #expect(labels(requests.view).contains("Answered"))
        #expect(editor.textView.threadMarks.first?.span.range == selected)
        var opened: String?
        requests.onOpen = { opened = $0 }
        try #require(buttons(requests.view).first { $0.title == "support.swift" }).performClick(nil)
        #expect(opened == "support.swift")

        requests.view.onClose?()
        editor.textView.openThread?("thread")
        requests.view.input.string = "One more question"
        requests.view.onSend?()
        try await wait { api.sent.count == 2 && !requests.hasUnpostedText }
        #expect(api.notes.count == 1)
        #expect(api.sent.map { $0["id"] as? String } == ["thread", "thread"])
        #expect(api.sent.map { $0["to"] as? String } == ["agent", "agent"])
    }

    private func key(_ characters: String, code: UInt16, modifiers: NSEvent.ModifierFlags = [], window: NSWindow) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                                       windowNumber: window.windowNumber, context: nil, characters: characters,
                                       charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
    }

    private func wait(_ predicate: () -> Bool) async throws {
        let clock = ContinuousClock(), end = ContinuousClock.now.advanced(by: .seconds(2))
        while !predicate(), clock.now < end { await Task.yield() }
        try #require(predicate())
    }

    private func labels(_ view: NSView) -> [String] {
        (view as? NSTextField).map { [$0.stringValue] } ?? view.subviews.flatMap(labels)
    }
    private func buttons(_ view: NSView) -> [NSButton] {
        (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
    }
}

@MainActor
private class RequestFixture: EditorAPI {
    let record: Fields = ["doc": "main.swift", "rev": 1, "title": "main.swift", "text": "let choice = 1\nlet fallback = 0\n", "dirty": false]
    let agent: Fields = ["id": "agent", "label": "Source Agent", "kind": "ordinary"]
    let header: Fields = ["doc": "main.swift", "rev": 1, "id": "thread", "start": 4, "end": 10, "quote": "choice",
                          "requestState": "answered", "requestAt": 20, "messageCount": 2, "changedFiles": ["support.swift"]]
    var notes: [Fields] = []
    var sent: [Fields] = []
    var messages: [Fields] = []

    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        switch op {
        case "read": return record
        case "note":
            notes.append(fields)
            messages.append(["author": "You", "text": fields["text"] ?? ""])
            return ["id": "thread"]
        case "thread": return ["messages": messages]
        case "send": sent.append(fields); return ["accepted": true]
        default: throw EditorIssue(code: "test", message: "Unexpected request: \(op)")
        }
    }
}
