import AppKit
import Testing
@testable import Editor

@MainActor
@Suite(.serialized)
struct WorkspaceScreenTests {
    private func children<T: NSView>(_ root: NSView, _ type: T.Type) -> [T] {
        ((root as? T).map { [$0] } ?? []) + root.subviews.flatMap { children($0, type) }
    }
    private func click(_ view: NSView, label: String) throws {
        let button = try #require(children(view, NSButton.self).first { $0.accessibilityLabel() == label || $0.title == label })
        #expect(button.isEnabled)
        button.performClick(nil)
    }
    private func eventually(_ predicate: () -> Bool) async throws {
        let clock = ContinuousClock(); let deadline = clock.now.advanced(by: .seconds(2))
        while !predicate(), clock.now < deadline { await Task.yield() }
        try #require(predicate())
    }
    private func window(_ screen: WorkspaceScreen, width: CGFloat) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0,y: 0,width: width,height: 520), styleMask: [.borderless],backing: .buffered,defer: false)
        window.contentView = screen.view
        screen.view.layoutSubtreeIfNeeded()
        return window
    }

    private func pointer(_ type: NSEvent.EventType, x: CGFloat, y: CGFloat = 200, in window: NSWindow, clicks: Int = 1) throws -> NSEvent {
        try #require(NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: y), modifierFlags: [], timestamp: 0,
                                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1))
    }
    private func resize(_ window: NSWindow, _ screen: WorkspaceScreen, width: CGFloat) {
        window.setContentSize(NSSize(width: width, height: 520))
        screen.view.layoutSubtreeIfNeeded()
    }

    @Test func sidebarWidthKeepsAUsableStageAndReturnsToTheChosenWidth() {
        #expect(WorkspaceLayout.sidebar(chosen: nil, pane: 900) == 288)
        #expect(WorkspaceLayout.sidebar(chosen: 438, pane: 900) == 438)
        #expect(WorkspaceLayout.sidebar(chosen: 438, pane: 600) == 320)
        #expect(WorkspaceLayout.sidebar(chosen: 120, pane: 900) == 200)
        #expect(WorkspaceLayout.sidebar(chosen: 2000, pane: 900) == 620)
        #expect(!WorkspaceLayout.fitsBeside(pane: 479))
        #expect(WorkspaceLayout.fitsBeside(pane: 480))
    }

    @Test func previewsReplaceEachOtherAndReturnOrStay() async throws {
        _ = NSApplication.shared
        let suite = "EditorTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let screen = WorkspaceScreen(api: WorkspaceFixture(), root: "/project", defaults: defaults)
        let window = window(screen, width: 900)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "a.swift")
        let view = screen.view
        // Quick moves through a list: only the last preview stays on show, and escape returns.
        screen.showTransient("b.swift", line: nil)
        screen.showTransient("sample.swift", line: 2)
        screen.endTransient(commit: false)
        try await eventually { self.tabs(view) == [["a.swift"]] && screen.currentEditor?.doc == "a.swift" }
        // A kept preview stays open and on show.
        screen.showTransient("b.swift", line: nil)
        screen.endTransient(commit: true)
        try await eventually { self.tabs(view) == [["a.swift", "b.swift"]] && screen.currentEditor?.doc == "b.swift" }
        #expect(screen.openDocuments == ["a.swift", "b.swift"])
        // A preview of a tab that was already open leaves it open.
        screen.showTransient("a.swift", line: nil)
        screen.endTransient(commit: false)
        try await eventually { self.tabs(view) == [["a.swift", "b.swift"]] && screen.currentEditor?.doc == "b.swift" }
    }

    @Test func draggedSidebarWidthSurvivesNarrowPanesHidingAndRelaunch() async throws {
        _ = NSApplication.shared
        let suite = "EditorTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project", defaults: defaults)
        let window = window(screen, width: 900)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: nil)
        try await screen.open("sample.swift")
        let view = screen.view
        view.layoutSubtreeIfNeeded()
        let edge = try #require(children(view, WorkspaceDivider.self).first { $0.accessibilityLabel() == "Sidebar width" })
        let source = try #require(children(view, CodeTextView.self).first)
        #expect(edge.position == 288)
        #expect(window.makeFirstResponder(source))
        source.setSelectedRange(NSRange(location: 4, length: 2))

        edge.mouseDown(with: try pointer(.leftMouseDown, x: 290, in: window))
        edge.mouseDragged(with: try pointer(.leftMouseDragged, x: 422, in: window))
        #expect(edge.position == 420)
        #expect(source.enclosingScrollView?.frame.width == 475)
        edge.mouseDragged(with: try pointer(.leftMouseDragged, x: 2000, in: window))
        #expect(edge.position == 620)
        edge.mouseDragged(with: try pointer(.leftMouseDragged, x: -50, in: window))
        #expect(edge.position == 200)
        edge.mouseDragged(with: try pointer(.leftMouseDragged, x: 422, in: window))
        edge.mouseUp(with: try pointer(.leftMouseUp, x: 422, in: window))
        #expect(edge.position == 420)
        #expect(window.firstResponder === source)
        #expect(source.selectedRange() == NSRange(location: 4, length: 2))

        resize(window, screen, width: 600)
        #expect(edge.position == 320)
        resize(window, screen, width: 440)
        #expect(edge.isHidden)
        #expect(source.isHiddenOrHasHiddenAncestor)
        resize(window, screen, width: 900)
        #expect(edge.position == 420)
        #expect(!source.isHiddenOrHasHiddenAncestor)

        #expect(screen.registry.run("view.sidebar"))
        #expect(edge.isHidden)
        #expect(source.enclosingScrollView?.frame.width == 900)
        #expect(screen.registry.run("view.sidebar"))
        #expect(edge.position == 420)

        let next = WorkspaceScreen(api: WorkspaceFixture(), root: "/project", defaults: defaults)
        let nextWindow = self.window(next, width: 900)
        defer { next.stop(); nextWindow.orderOut(nil) }
        try await next.start(file: nil)
        next.view.layoutSubtreeIfNeeded()
        let nextEdge = try #require(children(next.view, WorkspaceDivider.self).first { $0.accessibilityLabel() == "Sidebar width" })
        #expect(nextEdge.position == 420)

        // A double-click fits the sidebar to its longest name, within the limits.
        nextEdge.mouseDown(with: try pointer(.leftMouseDown, x: 421, in: nextWindow, clicks: 2))
        #expect(nextEdge.position == 200)
        #expect(defaults.double(forKey: "sidebarWidth") == 200)
    }

    private func tabs(_ view: NSView) -> [[String]] {
        children(view, WorkspaceGroupView.self).filter { !$0.isHiddenOrHasHiddenAncestor }.sorted { $0.frame.minX < $1.frame.minX }.map { group in
            children(group, WorkspaceTabView.self).sorted { $0.frame.minX < $1.frame.minX }.map { $0.accessibilityLabel() ?? "" }
        }
    }
    private func tab(_ label: String, in view: NSView) throws -> WorkspaceTabView {
        try #require(children(view, WorkspaceGroupView.self).flatMap { children($0, WorkspaceTabView.self) }.first { $0.accessibilityLabel() == label })
    }
    /// Presses a tab and moves the pointer to a window point. The caller releases it.
    private func drag(_ tab: WorkspaceTabView, to point: NSPoint, in window: NSWindow) throws {
        let box = tab.convert(tab.bounds, to: nil)
        tab.mouseDown(with: try pointer(.leftMouseDown, x: box.midX, y: box.midY, in: window))
        tab.mouseDragged(with: try pointer(.leftMouseDragged, x: (box.midX + point.x) / 2, y: (box.midY + point.y) / 2, in: window))
        tab.mouseDragged(with: try pointer(.leftMouseDragged, x: point.x, y: point.y, in: window))
    }

    @Test func tabsChangePlaceAndSideWithThePointerWhileAnAgentPublishes() async throws {
        _ = NSApplication.shared
        let suite = "EditorTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project", defaults: defaults)
        let window = window(screen, width: 900)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "a.swift")
        try await screen.open("b.swift")
        try await screen.open("sample.swift")
        let view = screen.view
        view.layoutSubtreeIfNeeded()
        #expect(tabs(view) == [["a.swift", "b.swift", "sample.swift"]])
        let source = try #require(children(view, CodeTextView.self).first { !$0.isHiddenOrHasHiddenAncestor })
        #expect(window.makeFirstResponder(source))
        source.setSelectedRange(NSRange(location: 4, length: 2))

        // The selected tab moves to the front. A composed tab arrives during the drag.
        let moved = try tab("sample.swift", in: view)
        let stripY = moved.convert(moved.bounds, to: nil).midY
        try drag(moved, to: NSPoint(x: 2, y: stripY), in: window)
        api.publishTab()
        try await screen.synchronise()
        moved.mouseUp(with: try pointer(.leftMouseUp, x: 2, y: stripY, in: window))
        #expect(tabs(view) == [["sample.swift", "a.swift", "b.swift", "Composed tab: Result"]])
        #expect(window.firstResponder === source)
        #expect(source.selectedRange() == NSRange(location: 4, length: 2))

        // A tab dropped on the right part of the page takes the right side of the stage. A wide
        // sidebar gives way to the second side.
        #expect(screen.registry.run("view.files"))
        let edge = try #require(children(view, WorkspaceDivider.self).first { $0.accessibilityLabel() == "Sidebar width" })
        edge.mouseDown(with: try pointer(.leftMouseDown, x: 288, in: window))
        edge.mouseDragged(with: try pointer(.leftMouseDragged, x: 500, in: window))
        edge.mouseUp(with: try pointer(.leftMouseUp, x: 500, in: window))
        #expect(edge.position == 500)
        let other = try tab("b.swift", in: view)
        try drag(other, to: NSPoint(x: 860, y: 200), in: window)
        other.mouseUp(with: try pointer(.leftMouseUp, x: 860, y: 200, in: window))
        try await eventually { self.tabs(view) == [["sample.swift", "a.swift", "Composed tab: Result"], ["b.swift"]] }
        #expect(edge.position == 446)

        // A location in a composed tab shows its file on the other side, so the tab stays on show.
        try click(view, label: "Composed tab: Result")
        try await eventually { self.children(view, NSButton.self).contains { $0.accessibilityLabel() == "Open sample.swift:2" } }
        try click(view, label: "Open sample.swift:2")
        try await eventually { self.tabs(view) == [["a.swift", "Composed tab: Result"], ["b.swift", "sample.swift"]] }
        #expect(children(view, NSButton.self).contains { $0.accessibilityLabel() == "Open sample.swift:2" && !$0.isHiddenOrHasHiddenAncestor })
        #expect(!source.isHiddenOrHasHiddenAncestor)

        // A side goes away with its last tab.
        try click(view, label: "Close sample.swift")
        try await eventually { self.tabs(view) == [["a.swift", "Composed tab: Result"], ["b.swift"]] }
        try click(view, label: "Close b.swift")
        try await eventually { self.tabs(view) == [["a.swift", "Composed tab: Result"]] }
        view.layoutSubtreeIfNeeded()
        #expect(edge.position == 500)
        #expect(await screen.prepareToClose())
    }

    @Test func textNoteReceivesReplyAndDraftWithoutOpeningTheComposedTab() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api,root: "/project")
        let window = window(screen, width: 410)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "sample.swift")
        let view = screen.view
        let source = try #require(children(view, CodeTextView.self).first)
        #expect(source.enclosingScrollView?.frame.width == 410)
        #expect(api.treeReads == 0)
        let selected = NSRange(location: 4,length: 2)
        source.insertText("👋🏽", replacementRange: selected)
        let range = (source.string as NSString).range(of: "👋🏽")
        let noteItem = try #require(source.noteTarget?(range))
        let selector = try #require(noteItem.action)
        #expect(NSApp.sendAction(selector, to: noteItem.target, from: noteItem))
        try await eventually { self.children(view, NSTextView.self).contains { $0.accessibilityLabel() == "Note" } }
        let note = try #require(children(view, NSTextView.self).first { $0.accessibilityLabel() == "Note" })
        note.insertText("Use this greeting", replacementRange: NSRange(location: 0,length: 0))
        let picker = try #require(children(view, NSPopUpButton.self).first)
        try await eventually { picker.itemArray.contains { $0.representedObject as? String == api.member } }
        picker.select(picker.itemArray.first { $0.representedObject as? String == api.member })
        let pickerAction = try #require(picker.action)
        #expect(NSApp.sendAction(pickerAction, to: picker.target, from: picker))
        try click(view, label: "Send Request")
        try await eventually { api.sent == api.member }
        #expect(api.quote == "👋🏽")
        #expect(api.anchor["rev"] as? Int == 2)
        api.agentUpdate()
        try await screen.synchronise()
        try await eventually { self.children(view,NSTextField.self).contains { $0.stringValue == "Updated the greeting." } }
        #expect(children(view,NSTextField.self).contains { $0.stringValue == "👋🏽" })
        #expect(source.string == api.text)
        #expect(screen.registry.run("view.notes"))
        #expect(window.makeFirstResponder(source))
        let responder = window.firstResponder
        try await screen.synchronise()
        #expect(window.firstResponder === responder)
        #expect(!source.isHiddenOrHasHiddenAncestor)
        try click(view, label: "Composed tab: Result")
        try await eventually { self.children(view,NSButton.self).contains { $0.accessibilityLabel() == "Open sample.swift:2" } }
        try click(view, label: "Open sample.swift:2")
        try await eventually { !source.isHiddenOrHasHiddenAncestor && source.superview?.window === window }
        #expect(source.selectedRange().location == (api.text as NSString).range(of: "return").location)
        #expect(await screen.prepareToClose())
    }

    @Test func newScratchSavesToANamedFileThroughThePathPanel() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project")
        let window = window(screen, width: 400)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: nil)
        #expect(api.treeReads == 1)
        #expect(screen.registry.run("file.newScratch"))
        try await eventually { self.children(screen.view, CodeTextView.self).first != nil }
        let text = try #require(children(screen.view, CodeTextView.self).first)
        text.insertText("A native draft",replacementRange: NSRange(location:0,length:0))
        screen.view.layoutSubtreeIfNeeded()
        let top = text.convert(text.bounds, to: screen.view).minY
        #expect(screen.registry.run("file.save"))
        let panel = try #require(children(screen.view, QuickPanel.self).first)
        #expect(panel.field.accessibilityLabel() == "Project-relative file path")
        panel.replaceInput("Notes/greeting.txt")
        panel.onAccept?(nil)
        try await eventually { api.savedPath == "Notes/greeting.txt" && self.children(screen.view, NSButton.self).contains { $0.accessibilityLabel() == "Notes/greeting.txt" } }
        #expect(api.savedText == "A native draft")
        try await eventually { panel.superview == nil }
        // The confirmation takes the status line; the source keeps its place.
        screen.view.layoutSubtreeIfNeeded()
        #expect(children(screen.view, NSTextField.self).contains { $0.stringValue == "Saved Notes/greeting.txt." })
        #expect(text.convert(text.bounds, to: screen.view).minY == top)
        #expect(await screen.prepareToClose())
    }

    @Test func editedPreviewStaysWhenAnotherPreviewOpens() async throws {
        _ = NSApplication.shared
        let screen = WorkspaceScreen(api: WorkspaceFixture(), root: "/project")
        let window = window(screen, width: 900)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "a.swift")
        screen.previewFromTree("b.swift")
        try await eventually { screen.currentEditor?.doc == "b.swift" }
        let first = try tab("b.swift", in: screen.view)
        #expect(first.item.preview)
        screen.previewFromTree("sample.swift")
        try await eventually { screen.currentEditor?.doc == "sample.swift" }
        #expect(screen.openDocuments == ["a.swift", "sample.swift"])
        let edited = try #require(screen.currentEditor)
        edited.textView.insertText("// local\n", replacementRange: NSRange(location: 0, length: 0))
        #expect(!(try tab("sample.swift", in: screen.view)).item.preview)
        screen.previewFromTree("b.swift")
        try await eventually { screen.currentEditor?.doc == "b.swift" }
        #expect(screen.openDocuments == ["a.swift", "sample.swift", "b.swift"])
    }

    @Test func selectedTabStaysClearOfTheAddButtonAfterAResize() async throws {
        _ = NSApplication.shared
        let screen = WorkspaceScreen(api: WorkspaceFixture(), root: "/project")
        let window = window(screen, width: 920)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: nil)
        for doc in ["app.swift", "palette.swift", "README.md", "workspace.ts", "settings.yml"] { try await screen.open(doc) }
        resize(window, screen, width: 590)
        let group = try #require(children(screen.view, WorkspaceGroupView.self).first)
        let add = try #require(children(group.strip, WorkspaceButton.self).first { $0.accessibilityLabel() == "New scratch (cmd+N)" })
        let tab = try tab("settings.yml", in: screen.view)
        let visible = tab.convert(tab.bounds, to: group.strip)
        #expect(visible.minX >= 0)
        #expect(visible.maxX <= add.frame.minX)
    }

    @Test func chosenGridRestoresGroupsCaretScrollAndSkipsMissingFiles() async throws {
        _ = NSApplication.shared
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: folder) }
        let files = WorkspaceFiles(layout: folder.appendingPathComponent("workspace.json"))
        let api = WorkspaceFixture()
        api.text = (0..<200).map { "let value\($0) = \($0)\n" }.joined()
        let screen = WorkspaceScreen(api: api, root: "/project", files: files)
        let firstWindow = window(screen, width: 1100)
        try await screen.start(file: "a.swift")
        try await screen.open("sample.swift")
        screen.chooseArrangement(.grid)
        #expect(screen.registry.run("layout.moveToGroup4"))
        #expect(screen.currentEditor?.doc == "sample.swift")
        #expect(Set(children(screen.view, WorkspaceGroupView.self).map(\.frame.minY)).count == 2)
        let editor = try #require(screen.currentEditor)
        screen.chrome.splitWeights = [0.35, 0.55]
        screen.view.layoutSubtreeIfNeeded()
        editor.go(line: 75)
        let selected = editor.textView.selectedRange()
        let scroll = editor.scroll.contentView.bounds.origin.y
        #expect(scroll > 0)
        #expect(await screen.prepareToClose())
        screen.stop(); firstWindow.orderOut(nil)
        let saved = try SessionLayout.read(try #require(files.layout))
        #expect(saved.arrangement == .grid)
        #expect(saved.active == saved.groups[3].id)
        #expect(saved.positions["doc:sample.swift"]?.selections.first?.location == selected.location)
        api.missing.insert("a.swift")
        let restored = WorkspaceScreen(api: api, root: "/project", files: files)
        let secondWindow = window(restored, width: 1100)
        defer { restored.stop(); secondWindow.orderOut(nil) }
        try await restored.start(file: nil)
        #expect(restored.openDocuments == ["sample.swift"])
        let source = try #require(restored.currentEditor)
        #expect(source.textView.selectedRange() == selected)
        let priorViewport = try #require(saved.positions["doc:sample.swift"]?.viewport)
        let restoredViewport = try #require(WorkspacePosition(source).viewport)
        #expect(restoredViewport.character == priorViewport.character)
        #expect(abs(restoredViewport.offset - priorViewport.offset) < 2)
        #expect(restored.chrome.splitWeights == [0.35, 0.55])
        #expect(children(restored.view, WorkspaceGroupView.self).count == 4)
    }

    @Test func closingDirtyTabOffersCancelKeepAndDiscard() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project")
        let window = window(screen, width: 850)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "sample.swift")
        let editor = try #require(screen.currentEditor)
        editor.textView.insertText("// local\n", replacementRange: NSRange(location: 0, length: 0))
        #expect(screen.registry.run("file.closeTab"))
        try await eventually { !self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        try click(screen.view, label: "Cancel")
        try await eventually { self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        #expect(screen.currentEditor === editor)
        #expect(screen.registry.run("file.closeTab"))
        try await eventually { !self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        try click(screen.view, label: "Keep as draft")
        try await eventually { screen.openDocuments.isEmpty }
        #expect(api.text.hasPrefix("// local"))
        #expect(screen.registry.run("file.reopenTab"))
        try await eventually { screen.currentEditor?.doc == "sample.swift" }
        #expect(screen.registry.run("file.closeTab"))
        try await eventually { !self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        try click(screen.view, label: "Discard changes")
        try await eventually { screen.openDocuments.isEmpty }
        #expect(api.reverted == "sample.swift")
        #expect(!api.text.hasPrefix("// local"))
    }

    @Test func closingWithSaveWritesTheRevisionBeforeRemovingTheTab() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project")
        let window = window(screen, width: 850)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "sample.swift")
        let editor = try #require(screen.currentEditor)
        editor.textView.insertText("// save\n", replacementRange: NSRange(location: 0, length: 0))
        #expect(screen.registry.run("file.closeTab"))
        try await eventually { !self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        try click(screen.view, label: "Save")
        try await eventually { screen.openDocuments.isEmpty }
        #expect(api.onDisk.hasPrefix("// save"))
        #expect(api.savedPath == "sample.swift")
    }

    @Test func diskConflictCanKeepTheDraftOrReloadTheDiskFile() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project")
        let window = window(screen, width: 850)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "sample.swift")
        let editor = try #require(screen.currentEditor)
        editor.textView.insertText("// my draft\n", replacementRange: NSRange(location: 0, length: 0))
        try await editor.flush()
        api.onDisk = "// the disk file\n"
        api.diskChanged = true
        try await screen.synchronise()
        #expect(editor.diskConflict)
        #expect(screen.registry.run("file.save"))
        try await eventually { !self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        #expect(self.children(screen.view, NSButton.self).contains { $0.title == "Save as…" })
        try click(screen.view, label: "Keep my draft")
        try await eventually { self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        #expect(editor.textView.string.hasPrefix("// my draft"))
        #expect(screen.registry.run("file.save"))
        try await eventually { !self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        try click(screen.view, label: "Reload from disk")
        try await eventually { editor.textView.string == api.onDisk }
        #expect(!editor.diskConflict)
        #expect(api.reverted == "sample.swift")
    }

    @Test func projectRenameKeepsTheDraftAndTrashNamesItBeforeTheMove() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project")
        let window = window(screen, width: 850)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "sample.swift")
        let editor = try #require(screen.currentEditor)
        editor.textView.insertText("// local\n", replacementRange: NSRange(location: 0, length: 0))
        editor.textView.setSelectedRange(NSRange(location: 4, length: 2))
        screen.fileAction(.rename("sample.swift", "new.swift"))
        try await eventually { screen.openDocuments == ["new.swift"] }
        #expect(screen.currentEditor === editor)
        #expect(editor.textView.selectedRange() == NSRange(location: 4, length: 2))
        #expect(api.text.hasPrefix("// local"))
        screen.fileAction(.remove("new.swift"))
        try await eventually { !self.children(screen.view, WorkspaceConfirmation.self).isEmpty }
        #expect(self.children(screen.view, NSTextField.self).contains { $0.stringValue.contains("unsaved drafts: new.swift") })
        #expect(api.trashed == nil)
        try click(screen.view, label: "Move to Trash")
        try await eventually { api.trashed == "new.swift" }
        #expect(screen.openDocuments == ["new.swift"])
        #expect(editor.textView.string.hasPrefix("// local"))
    }

    @Test func statusMenusChangeTheOpenFileAndShowItsPositionAndFormat() async throws {
        _ = NSApplication.shared
        let screen = WorkspaceScreen(api: WorkspaceFixture(), root: "/project")
        let window = window(screen, width: 1080)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "sample.swift")
        let editor = try #require(screen.currentEditor)
        editor.go(line: 2)
        func choose(_ title: String, in menu: NSMenu?) throws {
            let item = try #require(menu?.items.first { $0.title == title })
            #expect(NSApp.sendAction(try #require(item.action), to: item.target, from: item))
        }
        try choose("Indent with tabs", in: screen.chrome.onIndentationMenu?())
        try choose("Width: 6", in: screen.chrome.onIndentationMenu?())
        #expect(!editor.indentation.spaces && editor.indentation.width == 6)
        try choose("Python", in: screen.chrome.onLanguageMenu?())
        #expect(editor.languageID == "python")
        let labels = children(screen.view, NSTextField.self).map(\.stringValue)
        #expect(labels.contains { $0.contains("Line 2, Column 1") })
        #expect(labels.contains { $0.contains("UTF-8") && $0.contains("LF") })
    }

    @Test func disconnectedWorkspaceKeepsUnsentSourceReadable() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api, root: "/project")
        let window = window(screen, width: 800)
        defer { screen.stop(); window.orderOut(nil) }
        var pending: Bool?
        screen.onDisconnect = { [weak screen] unsent in
            pending = unsent
            screen?.showDisconnected(close: {})
        }
        try await screen.start(file: "sample.swift")
        let editor = try #require(screen.currentEditor)
        api.closed = true
        editor.textView.insertText("unsent", replacementRange: NSRange(location: 0, length: 0))
        try await eventually { pending == true }
        #expect(editor.textView.string.hasPrefix("unsent"))
        #expect(!editor.textView.isEditable)
        #expect(await screen.prepareToClose())
    }

    @Test func workspaceChromeDoesNotPaintOverSourceGlyphs() async throws {
        _ = NSApplication.shared
        let screen = WorkspaceScreen(api: WorkspaceFixture(), root: "/project")
        let window = window(screen, width: 850)
        window.appearance = NSAppearance(named: .darkAqua)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: nil)
        try await screen.open("sample.swift")
        let view = screen.view
        view.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let scale = CGFloat(bitmap.pixelsHigh) / view.bounds.height
        let source = try #require(children(view, CodeTextView.self).first)
        let sourceFrame = source.convert(source.bounds, to: view)
        let firstLines = Int(sourceFrame.minY * scale)..<Int((sourceFrame.minY + 55) * scale)
        let origin = source.convert(source.textContainerOrigin, to: view)
        let glyphs = Int((origin.x + 4) * scale)..<Int(min(view.bounds.maxX, origin.x + 32) * scale)
        let showsKeyword = firstLines.contains { y in glyphs.contains { x in
            guard let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return false }
            return c.redComponent > c.greenComponent + 0.15 && c.blueComponent > c.greenComponent + 0.15
        } }
        #expect(showsKeyword)
    }

    @Test func conflictRefusesCloseUntilBothTextsHaveASharedCopy() async throws {
        _ = NSApplication.shared
        let api = WorkspaceFixture()
        let screen = WorkspaceScreen(api: api,root: "/project")
        let window = window(screen, width: 390)
        defer { screen.stop(); window.orderOut(nil) }
        try await screen.start(file: "sample.swift")
        let source = try #require(children(screen.view,CodeTextView.self).first)
        source.insertText("local",replacementRange:NSRange(location:0,length:0))
        let local = source.string
        api.agentUpdate()
        #expect(!(await screen.prepareToClose()))
        #expect(source.string == local)
        try click(screen.view, label:"Keep both")
        try await eventually { api.scratchText == local && source.string == api.text }
        #expect(await screen.prepareToClose())
    }
}

@MainActor
private final class WorkspaceFixture: EditorAPI {
    let member = "agent:18"
    let id = "page-1"
    let scratch = "scratch:1b1d2d47-ecae-43ed-a270-7f20cf183161"
    var onDisk = "let 🌊 = 1\nreturn 3"
    var diskChanged = false
    var primary = "sample.swift"
    var text = "let 🌊 = 1\nreturn 3"
    var reverted: String?
    var trashed: String?
    var closed = false
    var missing: Set<String> = []
    var scratchText: String?
    var rev = 1
    var seq = 1
    var anchor: Fields = [:]
    var quote: String?
    var sent: String?
    var messages: [Fields] = []
    var composed = false
    var treeReads = 0
    var savedPath: String?
    var savedText: String?

    func publishTab() { composed = true; seq += 1 }
    func agentUpdate() {
        text = "let wave = 1\nreturn wave"; rev += 1; seq += 1; composed = true
        messages.append(["author":"Agent", "text":"Updated the greeting."])
    }
    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        if closed { throw URLError(.cannotConnectToHost) }
        switch op {
        case "state":
            if fields["since"] as? Int == seq { return ["seq":seq,"unchanged":true] }
            var thread = anchor; thread["id"] = "thread"; thread["messageCount"] = messages.count
            thread["preview"] = messages.last?["text"]
            return ["seq":seq,"docs":[],"threads":quote == nil ? [] : [thread],"views":composed ? [["title":"Result","id":id,"rev":1]] : []]
        case "tree":
            treeReads += 1
            return ["entries":[["path":"sample.swift","name":"sample.swift","dir":false]],"next":NSNull()]
        case "read":
            let doc = fields["doc"] as? String ?? primary
            if missing.contains(doc) { throw EditorIssue(code: "not_found", message: "File not found.") }
            guard doc == primary else {
                if fields["ifRev"] as? Int == 1 { return ["doc":doc,"unchanged":true,"rev":1,"dirty":false] }
                return ["doc":doc,"title":(doc as NSString).lastPathComponent,"rev":1,"dirty":false,"text":"// \(doc)\n"]
            }
            let diskChanged = diskChanged || trashed == doc
            if fields["ifRev"] as? Int == rev {
                return ["doc": doc, "unchanged": true, "rev": rev, "dirty": text != onDisk,
                        "diskChanged": diskChanged, "eol": "\n", "bom": false]
            }
            return ["doc": doc, "title": doc, "rev": rev, "dirty": text != onDisk, "text": text, "diskChanged": diskChanged, "eol": "\n", "bom": false]
        case "new":
            scratchText = ""; seq += 1
            return ["doc":scratch,"title":"Untitled","rev":1,"dirty":true,"text":""]
        case "patch":
            if fields["doc"] as? String == scratch {
                scratchText = fields["text"] as? String; seq += 1
                return ["doc":scratch,"rev":2,"dirty":true]
            }
            guard fields["rev"] as? Int == rev else { throw EditorIssue(code:"conflict",message:"Revision changed.") }
            let start = try #require(fields["start"] as? Int), end = try #require(fields["end"] as? Int)
            text = (text as NSString).replacingCharacters(in:NSRange(location:start,length:end-start),with:try #require(fields["text"] as? String))
            rev += 1; seq += 1
            return ["doc": primary, "rev": rev, "dirty": true]
        case "rename":
            let from = try #require(fields["from"] as? String), to = try #require(fields["to"] as? String)
            #expect(from == primary)
            primary = to
            seq += 1
            return ["from": from, "to": to, "mapping": [["from": from, "to": to]]]
        case "remove":
            let doc = try #require(fields["path"] as? String)
            trashed = doc
            return ["path": doc, "kept": text != onDisk ? [doc] : []]
        case "revert":
            let doc = try #require(fields["doc"] as? String)
            #expect(fields["rev"] as? Int == rev)
            reverted = doc
            diskChanged = false
            text = onDisk
            rev += 1
            return ["doc": doc, "title": doc, "rev": rev, "dirty": false, "text": text]
        case "git": return fields["base"] as? Bool == true ? ["tracked": false] : ["branch": "main", "files": []]
        case "save":
            if fields["doc"] as? String == primary, fields["path"] == nil {
                #expect(fields["rev"] as? Int == rev)
                onDisk = text; savedPath = primary; savedText = text
                return ["doc": primary, "rev": rev, "title": primary, "dirty": false, "text": text]
            }
            let doc = try #require(fields["path"] as? String), text = try #require(scratchText)
            savedPath = doc; savedText = text
            return ["doc":doc,"rev":2,"title":(doc as NSString).lastPathComponent,"dirty":false,"text":text]
        case "members": return ["members":[["id":member,"label":"Agent","kind":"durable"]]]
        case "note":
            guard fields["rev"] as? Int == rev else { throw EditorIssue(code:"conflict",message:"Selection changed.") }
            let start = try #require(fields["start"] as? Int), end = try #require(fields["end"] as? Int)
            quote = (text as NSString).substring(with:NSRange(location:start,length:end-start))
            anchor = fields; messages = [["author":"You","text":try #require(fields["text"] as? String)]]; seq += 1
            return ["id":"thread"]
        case "send": sent = fields["to"] as? String; return ["accepted":true]
        case "thread":
            var result = anchor; result["quote"] = quote; result["messages"] = messages
            return result
        case "view": return ["id":id,"rev":1,"title":"Result","blocks":[["kind":"location","doc":"sample.swift","line":2,"text":"Greeting"]]]
        default: throw EditorIssue(code:"invalid",message:"Unexpected operation: \(op)")
        }
    }
}
