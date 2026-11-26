import AppKit
import Testing
@testable import Editor

@MainActor
struct CodeEditorTests {
    @Test func patchesUseExactUTF16AndDoNotSplitSurrogates() async throws {
        let accent = try #require(await CodePatch.between("e\u{301}", "é"))
        #expect(accent == CodePatch(start: 0, end: 2, text: "é"))
        let sameHigh = try #require(await CodePatch.between("a😀z", "a😁z"))
        #expect(sameHigh == CodePatch(start: 1, end: 3, text: "😁"))
        let sameLow = try #require(await CodePatch.between("a😀z", "a\u{1FA00}z"))
        #expect(sameLow == CodePatch(start: 1, end: 3, text: "\u{1FA00}"))
        #expect(await CodePatch.between("a👩🏽‍🚀z", "a👩🏽‍🚀z") == nil)
    }

    @Test func editDuringPatchDoesNotReplaceTextOrLoseRevision() async throws {
        let fixture = try Fixture(text: "let a = 0\n")
        let view = fixture.textView
        view.insertText("👩🏽‍🚀", replacementRange: NSRange(location: 4, length: 1))
        #expect(fixture.editor.hasPending)
        fixture.api.beforePatch = {
            view.insertText("1", replacementRange: NSRange(location: 14, length: 1))
        }
        try await fixture.editor.flush()
        #expect(view.string == "let 👩🏽‍🚀 = 1\n")
        #expect(fixture.api.patches.map { $0["rev"] as? Int } == [1, 2])
        #expect(fixture.api.patches.map { $0["start"] as? Int } == [4, 14])
        #expect(fixture.api.records[fixture.editor.doc]?["text"] as? String == view.string)
        #expect(fixture.editor.revision == 3)
        #expect(!fixture.editor.hasPending)
    }

    @Test func remoteRevisionLeavesLocalTextUntilExplicitDiscard() async throws {
        let fixture = try Fixture(text: "first\n")
        let doc = fixture.editor.doc
        fixture.insert("local ", at: 0)
        fixture.api.remote(doc, text: "shared\n")
        await #expect(throws: EditorIssue.self) { try await fixture.editor.flush() }
        #expect(fixture.editor.conflicted)
        #expect(fixture.textView.string == "local first\n")
        try await fixture.editor.refresh()
        await #expect(throws: EditorIssue.self) { try await fixture.editor.save(path: "next.swift") }
        #expect(fixture.api.records["next.swift"] == nil)
        let scratch = try await fixture.editor.recoverAsScratch()
        let recovered = try #require(scratch["text"] as? String)
        let scratchID = try #require(scratch["doc"] as? String)
        #expect(recovered == "local first\n")
        #expect(fixture.textView.string == recovered)
        fixture.insert("new ", at: 0)
        await #expect(throws: EditorIssue.self) {
            try await fixture.editor.discardLocalChanges(ifMatching: recovered)
        }
        fixture.api.beforeRead = { fixture.insert("later ", at: 0) }
        await #expect(throws: EditorIssue.self) { try await fixture.editor.discardLocalChanges() }
        #expect(fixture.textView.string == "later new local first\n")
        try await fixture.editor.discardLocalChanges()
        #expect(!fixture.editor.conflicted)
        #expect(!fixture.editor.hasPending)
        #expect(fixture.textView.string == "shared\n")
        #expect(fixture.api.records[scratchID]?["text"] as? String == recovered)
    }

    @Test func aFailedConflictCheckKeepsTheDraftAndNamesBothErrors() async throws {
        let fixture = try Fixture(text: "local text")
        fixture.api.records[fixture.editor.doc]?["diskChanged"] = true
        fixture.api.beforeRead = { throw EditorIssue(code: "offline", message: "Endpoint offline") }
        do {
            try await fixture.editor.save(path: nil)
            Issue.record("A changed disk file must not save")
        } catch let issue as EditorIssue {
            #expect(issue.code == "conflict")
            #expect(issue.message.contains("Disk contents changed"))
            #expect(issue.message.contains("Endpoint offline"))
        }
        #expect(fixture.textView.string == "local text")
    }

    @Test func offlineDraftRetriesAndDiskConflictAllowsSaveAs() async throws {
        let fixture = try Fixture(text: "a\n")
        fixture.api.offline = true
        fixture.insert("b", at: 0)
        await #expect(throws: EditorIssue.self) { try await fixture.editor.flush() }
        #expect(fixture.editor.hasPending)
        #expect(!fixture.editor.conflicted)
        #expect(fixture.textView.string == "ba\n")
        fixture.api.offline = false
        try await fixture.editor.refresh()
        #expect(!fixture.editor.hasPending)
        fixture.api.records[fixture.editor.doc]?["diskChanged"] = true
        await #expect(throws: EditorIssue.self) { try await fixture.editor.save(path: nil) }
        #expect(fixture.editor.diskConflict)
        #expect(!fixture.editor.conflicted)
        try await fixture.editor.save(path: "copy.swift")
        #expect(!fixture.editor.diskConflict)
        #expect(!fixture.editor.dirty)
        #expect(fixture.editor.doc == "copy.swift")
        #expect(fixture.api.records["source.swift"]?["diskChanged"] as? Bool == true)
    }

    @Test func anOpenedDraftStartsWithTheInsertionPointAtItsFirstCharacter() throws {
        let fixture = try Fixture(text: "one\ntwo\n")
        #expect(fixture.textView.selectedRange() == NSRange(location: 0, length: 0))
    }

    @Test func nativeInsertionNormalisesPastedLineEndings() async throws {
        let fixture = try Fixture(text: "A\n")
        fixture.insert("x\r\ny\rz", at: 1)
        #expect(fixture.textView.string == "Ax\ny\nz\n")
        try await fixture.editor.flush()
        #expect(fixture.api.records[fixture.editor.doc]?["text"] as? String == "Ax\ny\nz\n")
    }

    @Test func nativeUndoIsPerTabAndRemoteRefreshClearsObsoleteHistory() async throws {
        let first = try Fixture(text: "one\n")
        let second = try Fixture(text: "two\n")
        first.insert("a", at: 0)
        second.insert("b", at: 0)
        first.textView.breakUndoCoalescing()
        second.textView.breakUndoCoalescing()
        first.textView.undoManager?.undo()
        #expect(first.textView.string == "one\n")
        #expect(second.textView.string == "btwo\n")
        try await first.editor.flush()
        #expect(first.api.patches.isEmpty)
        try await second.editor.flush()
        second.api.remote(second.editor.doc, text: "agent\n")
        try await second.editor.refresh()
        #expect(second.textView.string == "agent\n")
        #expect(second.textView.undoManager?.canUndo == false)
    }

    @Test func nativeContextMenuAnchorsGraphemeAndRefusesHistoricalSelection() async throws {
        let emoji = "👩🏽‍🚀"
        let fixture = try Fixture(text: "A\(emoji)Z\n")
        fixture.insert("B", at: 0)
        let location = try fixture.point(at: 2)
        let expected = NSRange(location: 2, length: emoji.utf16.count)
        #expect(fixture.textView.noteRange(at: location, selection: NSRange(location: 0, length: 0)) == expected)
        let selected = NSRange(location: 1, length: expected.length + 2)
        #expect(fixture.textView.noteRange(at: location, selection: selected) == selected)

        let current = try await fixture.note(at: location)
        #expect(current.anchor?["rev"] == 2)
        #expect(current.anchor?["start"] == expected.location)
        #expect(current.anchor?["end"] == NSMaxRange(expected))
        #expect(!fixture.editor.hasPending)

        let historical = try await fixture.note(at: location) { fixture.insert("new ", at: 0) }
        #expect(historical.anchor == nil)
        #expect(historical.status?.contains("Select it again") == true)
    }

    @Test func theContextMenuOpensFindWithoutAShortcut() throws {
        let fixture = try Fixture(text: "one\n")
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: NSPoint(x: 400, y: 100), modifierFlags: [],
                                                    timestamp: 0, windowNumber: fixture.window.windowNumber, context: nil,
                                                    eventNumber: 0, clickCount: 1, pressure: 1))
        let find = try #require(fixture.textView.menu(for: event)?.items.first { $0.title == "Find…" })
        #expect(NSApp.sendAction(try #require(find.action), to: find.target, from: find))
        #expect(fixture.scroll.isFindBarVisible)
    }

    @Test func emptyDraftFillsViewportAndOffersNativeFind() throws {
        let fixture = try Fixture(text: "")
        #expect(fixture.textView.frame.width >= fixture.scroll.contentView.bounds.width)
        #expect(fixture.textView.frame.height >= fixture.scroll.contentView.bounds.height)
        fixture.editor.find()
        #expect(fixture.scroll.isFindBarVisible)
        fixture.editor.setWrap(true)
        #expect(!fixture.scroll.hasHorizontalScroller)
        #expect(fixture.textView.textContainer?.widthTracksTextView == true)
    }

    @Test func editsEverySelectionAndUndoesEachBatchOnce() throws {
        let fixture = try Fixture(text: "a😀\nb😀\n")
        let view = fixture.textView
        let caret: (Int) -> NSRange = { NSRange(location: $0, length: 0) }
        let insertion = NSRange(location: NSNotFound, length: 0)
        view.select([caret(1), caret(5)])
        view.insertText("x", replacementRange: insertion)
        #expect(view.string == "ax😀\nbx😀\n")
        #expect(fixture.editor.findSelections == [caret(2), caret(7)])
        view.doCommand(by: NSSelectorFromString("deleteBackward:"))
        #expect(view.string == "a😀\nb😀\n")
        view.undoManager?.undo()
        #expect(view.string == "ax😀\nbx😀\n")
        view.undoManager?.undo()
        #expect(view.string == "a😀\nb😀\n")
        let board = NSPasteboard(name: NSPasteboard.Name(rawValue: UUID().uuidString))
        defer { board.releaseGlobally() }
        board.setString("left\r\nright", forType: .string)
        view.select([caret(1), caret(5)])
        view.paste(from: board, reindent: false)
        #expect(view.string == "aleft😀\nbright😀\n")
        view.undoManager?.undo()
        #expect(view.string == "a😀\nb😀\n")
        #expect(fixture.editor.hasPending)
    }

    @Test func usesLanguageForCommentsAndAutomaticIndentation() throws {
        let fixture = try Fixture(text: "let one = 1\nlet two = 2\n")
        let view = fixture.textView
        view.select([NSRange(location: 0, length: 0), NSRange(location: 12, length: 0)])
        view.run(.lineComment)
        #expect(view.string == "// let one = 1\n// let two = 2\n")
        view.run(.lineComment)
        #expect(view.string == "let one = 1\nlet two = 2\n")
        fixture.editor.chooseLanguage("python")
        view.run(.lineComment)
        #expect(view.string == "# let one = 1\n# let two = 2\n")
        fixture.editor.chooseLanguage(nil)
        #expect(fixture.editor.languageName == "Swift")

        let brace = try Fixture(text: "if ready ")
        brace.editor.go(line: 1)
        brace.textView.select([NSRange(location: 9, length: 0)])
        brace.textView.insertText("{", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(brace.textView.string == "if ready {}")
        brace.textView.doCommand(by: NSSelectorFromString("deleteBackward:"))
        #expect(brace.textView.string == "if ready ")
        brace.textView.insertText("{", replacementRange: NSRange(location: NSNotFound, length: 0))
        brace.textView.doCommand(by: NSSelectorFromString("insertNewline:"))
        #expect(brace.textView.string == "if ready {\n    \n}")
        #expect(brace.editor.caretPosition == (line: 2, column: 5))
    }

    @Test func foldsOnlyLayoutAndCaretMovesAcrossTheFold() throws {
        let fixture = try Fixture(text: "func show() {\n    let visible = true\n    print(visible)\n}\nnext()\n")
        let view = fixture.textView
        let original = view.string
        let second = view.lineRange(1).location
        let before = try #require(view.caretRect(at: view.lineRange(3).location)).minY
        view.select([NSRange(location: second, length: 0)])
        view.toggleFold(line: 0)
        #expect(view.isFolded(line: 0))
        #expect(view.isHidden(line: 1))
        #expect(view.string == original)
        #expect(view.selectedRange().location < second)
        let after = try #require(view.caretRect(at: view.lineRange(3).location)).minY
        #expect(after < before)
        view.doCommand(by: NSSelectorFromString("moveRight:"))
        #expect(fixture.editor.caretPosition.line == 4)
        view.doCommand(by: NSSelectorFromString("moveLeft:"))
        #expect(fixture.editor.caretPosition.line == 1)
        fixture.editor.go(line: 2)
        #expect(!view.isFolded(line: 0))
        #expect(view.selectedRange().location == second)
    }

    @Test func detectsAndConvertsIndentation() throws {
        let fixture = try Fixture(text: "a\n  b\n    c\n  d\n")
        fixture.editor.apply(settings: EditorSettings(), theme: WorkspaceStyle.theme)
        #expect(fixture.editor.indentation.spaces && fixture.editor.indentation.width == 2)
        fixture.editor.convertIndentation(spaces: false)
        #expect(!fixture.editor.indentation.spaces)
        #expect(fixture.textView.string == "a\n\tb\n\t\tc\n\td\n")
        let tabs = try Fixture(text: "a\n\tb\n\t\tc\n")
        tabs.editor.apply(settings: EditorSettings(), theme: WorkspaceStyle.theme)
        #expect(!tabs.editor.indentation.spaces && tabs.editor.indentation.width == 4)
    }

    @Test func findSelectsSeveralRangesAndSaveCleanupIsUndoable() async throws {
        let fixture = try Fixture(text: "one  \none\t")
        fixture.editor.apply(settings: EditorSettings(values: ["trimTrailingWhitespaceOnSave": .flag(true),
            "ensureNewlineAtEndOnSave": .flag(true)]), theme: WorkspaceStyle.theme)
        let hits = [NSRange(location: 0, length: 3), NSRange(location: 6, length: 3)]
        fixture.editor.markFound(hits, current: hits[0])
        fixture.editor.selectFound(hits, reveal: hits[0])
        #expect(fixture.editor.findSelections == hits)
        #expect(fixture.textView.mapFindLines == [0, 1])
        try await fixture.editor.save(path: nil)
        #expect(fixture.textView.string == "one\none\n")
        fixture.textView.undoManager?.undo()
        #expect(fixture.textView.string == "one  \none\t")
    }

    @Test(.timeLimit(.minutes(1))) func changeMarksFollowTheDraftAndSupportNavigation() async throws {
        let fixture = try Fixture(text: "one\nnew\nthree\n")
        let stream = AsyncStream<[CodeChangeMark]> { continuation in
            fixture.editor.onChangeMarks = { [weak editor = fixture.editor] in
                if let editor { continuation.yield(editor.changeMarks) }
            }
        }
        defer { fixture.editor.stop() }
        var updates = stream.makeAsyncIterator()
        fixture.editor.setBaseText("one\nold\nthree\n")
        #expect(await updates.next() == [CodeChangeMark(line: 1, kind: .modified)])
        fixture.editor.run(.nextChange)
        #expect(fixture.editor.caretPosition.line == 2)
        fixture.insert("extra\n", at: fixture.textView.lineRange(2).location)
        #expect(await updates.next() == [CodeChangeMark(line: 1, kind: .modified), CodeChangeMark(line: 2, kind: .added)])
        fixture.editor.run(.nextChange)
        #expect(fixture.editor.caretPosition.line == 3)
    }

    @Test func highlightedViewportEditsAndScrollsNearTheFileLimit() throws {
        let sample = "let value: String = \"hello 👩🏽‍🚀\" // sample text for viewport measurement\n"
        let bytes = 2_000_000 / sample.utf8.count * sample.utf8.count
        let source = String(repeating: sample, count: bytes / sample.utf8.count)
        let clock = ContinuousClock()
        let start = clock.now
        let fixture = try Fixture(text: source)
        fixture.editor.apply(settings: EditorSettings(values: ["rulers": .columns([88, 120]),
            "whitespace": .text("all"), "animations": .flag(false)]), theme: WorkspaceStyle.theme)
        fixture.editor.setBaseText(source + "// base\n")
        fixture.editor.onSelectionChange = { [weak editor = fixture.editor] in _ = editor?.caretPosition }
        let opened = start.duration(to: clock.now)
        let manager = try #require(fixture.textView.layoutManager)
        let colour = manager.temporaryAttribute(.foregroundColor, atCharacterIndex: 0, effectiveRange: nil) as? NSColor
        #expect(colour == .systemPurple)
        fixture.textView.setSelectedRange(NSRange(location: 4, length: 0))
        let keyTime = clock.now
        let keys = try (0..<64).map { _ in
            try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                          windowNumber: fixture.window.windowNumber, context: nil, characters: "j",
                                          charactersIgnoringModifiers: "j", isARepeat: false, keyCode: 38))
        }
        var keyDurations = [Duration]()
        var layoutDurations = [Duration]()
        for event in keys {
            let start = clock.now
            fixture.textView.keyDown(with: event)
            let rendered = clock.now
            fixture.textView.prepareVisibleText()
            keyDurations.append(start.duration(to: rendered))
            layoutDurations.append(rendered.duration(to: clock.now))
        }
        let keyElapsed = keyTime.duration(to: clock.now)
        #expect(fixture.textView.string.hasPrefix("let " + String(repeating: "j", count: keys.count) + "value"))
        let layoutTime = clock.now
        let scroll = fixture.scroll
        var scrollDurations = [Duration]()
        for _ in 0..<32 {
            let start = clock.now
            let clip = scroll.contentView
            clip.scroll(to: NSPoint(x: 0, y: clip.bounds.minY + 180))
            scroll.reflectScrolledClipView(clip)
            fixture.textView.prepareVisibleText()
            scrollDurations.append(start.duration(to: clock.now))
        }
        let scrolled = layoutTime.duration(to: clock.now)
        #expect(scroll.contentView.bounds.minY > 0)
        #expect(manager.allowsNonContiguousLayout)
        let jump = clock.now
        fixture.editor.go(line: 20_000)
        fixture.textView.prepareVisibleText()
        #expect(fixture.textView.selectedRange().location == 19_999 * sample.utf16.count + keys.count)
        let jumped = jump.duration(to: clock.now)
        func p95(_ durations: [Duration]) -> Duration { durations.sorted()[(durations.count * 95 + 99) / 100 - 1] }
        print("AppKit fixture: \(bytes) bytes, open \(opened), \(keys.count) keys \(keyElapsed) (key p95 \(p95(keyDurations)), layout p95 \(p95(layoutDurations))), 32 clip scrolls \(scrolled) (p95 \(p95(scrollDurations))), go line \(jumped)")
    }
}

private enum FixtureError: Error { case event }

@MainActor
private final class Fixture {
    let window: NSWindow
    let editor: CodeEditor
    let api: CodeFixtureAPI
    let scroll: NSScrollView
    let textView: CodeTextView

    init(text: String) throws {
        _ = NSApplication.shared
        api = CodeFixtureAPI(record: ["doc": "source.swift", "rev": 1, "title": "source.swift", "dirty": false, "text": text])
        editor = CodeEditor(api: api, record: try #require(api.records["source.swift"]))
        scroll = try #require(editor.view as? NSScrollView)
        textView = try #require(scroll.documentView as? CodeTextView)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 560),
                          styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = scroll
        window.makeFirstResponder(textView)
        scroll.layoutSubtreeIfNeeded()
        textView.prepareVisibleText()
    }

    func insert(_ text: String, at offset: Int) {
        textView.insertText(text, replacementRange: NSRange(location: offset, length: 0))
    }

    func point(at offset: Int) throws -> NSPoint {
        let layout = try #require(textView.layoutManager)
        let container = try #require(textView.textContainer)
        let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: offset, length: 1), actualCharacterRange: nil)
        let bounds = layout.boundingRect(forGlyphRange: glyphs, in: container)
        return NSPoint(x: textView.textContainerOrigin.x + bounds.minX + 1,
                       y: textView.textContainerOrigin.y + bounds.midY)
    }

    func note(at point: NSPoint, beforeAction: () -> Void = {}) async throws -> (anchor: [String: Int]?, status: String?) {
        try await withCheckedThrowingContinuation { continuation in
            editor.onNote = { [weak self] anchor in
                self?.editor.onNote = nil
                self?.editor.onStatus = nil
                continuation.resume(returning: (anchor.compactMapValues { $0 as? Int }, nil))
            }
            editor.onStatus = { [weak self] message in
                self?.editor.onNote = nil
                self?.editor.onStatus = nil
                continuation.resume(returning: (nil, message))
            }
            textView.setSelectedRange(NSRange(location: 0, length: 0))
            guard let event = NSEvent.mouseEvent(with: .rightMouseDown, location: textView.convert(point, to: nil),
                                                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                                context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
                  let menu = textView.menu(for: event), let note = menu.items.first, note.title == "Add Note…",
                  let action = note.action else {
                editor.onNote = nil
                editor.onStatus = nil
                continuation.resume(throwing: FixtureError.event)
                return
            }
            beforeAction()
            if !NSApp.sendAction(action, to: note.target, from: note) {
                editor.onNote = nil
                editor.onStatus = nil
                continuation.resume(throwing: FixtureError.event)
            }
        }
    }
}

@MainActor
private final class CodeFixtureAPI: EditorAPI {
    var records: [String: Fields]
    var patches: [Fields] = []
    var offline = false
    var beforeRead: (() throws -> Void)?
    var beforePatch: (() -> Void)?

    init(record: Fields) { records = [record["doc"] as! String: record] }

    func remote(_ doc: String, text: String) {
        let revision = records[doc]?["rev"] as! Int
        records[doc]?["text"] = text
        records[doc]?["rev"] = revision + 1
        records[doc]?["dirty"] = true
    }

    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        if offline { throw EditorIssue(code: "offline", message: "Endpoint offline") }
        if op == "new" {
            let scratch = "scratch:" + UUID().uuidString.lowercased()
            let record: Fields = ["doc": scratch, "rev": 1, "title": "Untitled", "dirty": true, "text": ""]
            records[scratch] = record
            return record
        }
        let doc = try #require(fields["doc"] as? String)
        var record = try #require(records[doc])
        let rev = try #require(record["rev"] as? Int)
        switch op {
        case "read":
            let callback = beforeRead
            beforeRead = nil
            try callback?()
            if fields["ifRev"] as? Int == rev {
                record["unchanged"] = true
                record["text"] = nil
                record["title"] = nil
            }
            return record
        case "patch":
            let callback = beforePatch
            beforePatch = nil
            callback?()
            try requireRevision(fields, rev)
            let text = try #require(record["text"] as? String) as NSString
            let start = try #require(fields["start"] as? Int)
            let end = try #require(fields["end"] as? Int)
            let insert = try #require(fields["text"] as? String)
            let next = text.replacingCharacters(in: NSRange(location: start, length: end - start), with: CodeTextView.unixNewlines(insert))
            record["text"] = next
            record["rev"] = next.utf8.elementsEqual((text as String).utf8) ? rev : rev + 1
            record["dirty"] = true
            records[doc] = record
            patches.append(fields)
            return ["doc": doc, "rev": record["rev"]!, "dirty": true]
        case "save":
            try requireRevision(fields, rev)
            let path = fields["path"] as? String
            if path == nil && record["diskChanged"] as? Bool == true {
                throw EditorIssue(code: "conflict", message: "Disk contents changed")
            }
            if let path {
                record["doc"] = path
                record["title"] = path
                record["rev"] = doc.hasPrefix("scratch:") ? rev : 1
            }
            record["dirty"] = false
            record["diskChanged"] = nil
            records[path ?? doc] = record
            return record
        default:
            throw EditorIssue(code: "invalid", message: "Unexpected \(op)")
        }
    }

    private func requireRevision(_ fields: Fields, _ rev: Int) throws {
        if fields["rev"] as? Int != rev { throw EditorIssue(code: "conflict", message: "Stale revision") }
    }
}
