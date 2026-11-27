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
        requests.view.input.string = String(repeating: "🌊", count: 1_025)
        requests.view.onSend?()
        #expect(labels(requests.view).contains("Use at most 4,096 bytes."))
        #expect(api.notes.isEmpty && api.sent.isEmpty)
        requests.view.input.string = ""
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

    @Test func recipientChipClearsAndSelectsTheWorkspaceSession() async throws {
        _ = NSApplication.shared
        let api = RequestFixture()
        let editor = CodeEditor(api: api, record: api.record)
        let requests = WorkspaceRequests(api: api)
        defer { requests.stop(); editor.stop() }
        requests.bind(editor)
        requests.state(["members": [api.agent], "currentSession": api.agent], editors: [editor])
        editor.textView.setSelectedRange(editor.textView.source.range(of: "choice"))
        editor.askSelection()
        let chip = try #require(buttons(requests.view).compactMap { $0 as? NSPopUpButton }.first)
        let action = try #require(chip.action)
        #expect(chip.titleOfSelectedItem == "Source Agent")
        #expect(chip.item(at: 0)?.title == "Clear current session")
        chip.selectItem(at: 0)
        #expect(NSApp.sendAction(action, to: chip.target, from: chip))
        try await wait { requests.session == nil }
        #expect(api.sessionChanges.first?["id"] is NSNull)
        #expect(chip.titleOfSelectedItem == "Choose a session")
        chip.selectItem(at: 1)
        #expect(NSApp.sendAction(action, to: chip.target, from: chip))
        try await wait { requests.session?.id == "agent" }
        #expect(api.sessionChanges.last?["id"] as? String == "agent")
    }

    @Test func requestInputKeepsNativeTextCommandsAndSourceUndoSeparate() async throws {
        _ = NSApplication.shared
        let api = RequestFixture()
        let editor = CodeEditor(api: api, record: api.record)
        let requests = WorkspaceRequests(api: api)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 480), styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = editor.scroll
        defer { requests.stop(); editor.stop(); window.orderOut(nil) }
        requests.bind(editor)
        editor.textView.setSelectedRange(editor.textView.source.range(of: "choice"))
        editor.askSelection()
        let input = requests.view.input
        #expect(window.firstResponder === input)
        #expect(input.inlinePredictionType != .no)
        input.string = "Check this"
        input.setSelectedRange(NSRange(location: 5, length: 0))
        input.keyDown(with: try key("\u{1}", base: "a", code: 0, modifiers: .control, window: window))
        #expect(input.selectedRange() == NSRange(location: 0, length: 0))
        input.keyDown(with: try key("\u{5}", base: "e", code: 14, modifiers: .control, window: window))
        #expect(input.selectedRange() == NSRange(location: 10, length: 0))
        #expect(NSApp.sendAction(#selector(NSText.selectAll(_:)), to: input, from: nil))
        #expect(input.selectedRange() == NSRange(location: 0, length: 10))

        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        #expect(input.writeSelection(to: pasteboard, types: input.writablePasteboardTypes))
        #expect(pasteboard.string(forType: .string) == "Check this")
        pasteboard.clearContents()
        #expect(pasteboard.setString("Explain this", forType: .string))
        #expect(input.readSelection(from: pasteboard, type: .string))
        #expect(input.string == "Explain this")
        let inputUndo = try #require(input.undoManager)
        #expect(inputUndo !== editor.textView.undoManager)
        #expect(inputUndo.canUndo)
        inputUndo.undo()
        #expect(input.string == "Check this")
        #expect(inputUndo.canRedo)
        inputUndo.redo()
        #expect(input.string == "Explain this")
        #expect(editor.textView.string == api.record["text"] as? String)
    }

    private func key(_ characters: String, base: String? = nil, code: UInt16, modifiers: NSEvent.ModifierFlags = [], window: NSWindow) throws -> NSEvent {
        try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                                       windowNumber: window.windowNumber, context: nil, characters: characters,
                                       charactersIgnoringModifiers: base ?? characters, isARepeat: false, keyCode: code))
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
    var sessionChanges: [Fields] = []

    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        switch op {
        case "read": return record
        case "note":
            notes.append(fields)
            messages.append(["author": "You", "text": fields["text"] ?? ""])
            return ["id": "thread"]
        case "thread": return ["messages": messages]
        case "send": sent.append(fields); return ["accepted": true]
        case "session":
            sessionChanges.append(fields)
            return ["currentSession": fields["id"] is NSNull ? NSNull() : agent as Any]
        default: throw EditorIssue(code: "test", message: "Unexpected request: \(op)")
        }
    }
}
