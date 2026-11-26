import AppKit
import Testing
@testable import Editor

@MainActor
@Suite(.serialized)
struct ProjectNavigatorTests {
    private func descendant<T: NSView>(_ root: NSView, _ type: T.Type, where accept: (T) -> Bool = { _ in true }) -> T? {
        if let found = root as? T, accept(found) { return found }
        for child in root.subviews { if let found = descendant(child,type,where:accept) { return found } }
        return nil
    }
    private func pressKey(_ table: NSTableView, row: Int, code: UInt16 = 36, text: String = "\r") throws {
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, characters: text, charactersIgnoringModifiers: text, isARepeat: false, keyCode: code))
        table.keyDown(with: event)
    }
    private func awaitRow(_ title: String, index: Int = 0, in table: NSTableView) async throws {
        let clock = ContinuousClock(), until = clock.now.advanced(by:.seconds(2))
        func shown() -> Bool {
            guard table.numberOfRows > index,
                  let row = table.view(atColumn:0,row:index,makeIfNecessary:true) else { return false }
            return descendant(row,NSTextField.self,where: { $0.stringValue == title }) != nil
        }
        while !shown(), clock.now < until { await Task.yield() }
        try #require(shown())
    }
    @Test func foldersOpenInPlaceAndSearchAndGitUseTheSelectedProjectPath() async throws {
        _ = NSApplication.shared
        let api = NavigatorFixture(), nav = ProjectNavigator(api:api)
        let window = NSWindow(contentRect:.init(x:0,y:0,width:340,height:470),styleMask:.borderless,backing:.buffered,defer:false)
        window.contentView = nav.view
        defer { nav.stop(); window.orderOut(nil) }
        var opened: (String,Int?)?; nav.onOpen = { opened = ($0,$1) }
        var expanded: [Bool] = []; nav.onExpand = { expanded.append($0) }
        try await nav.start(); nav.view.layoutSubtreeIfNeeded()
        let table = try #require(descendant(nav.view,NSTableView.self))
        try await awaitRow("FOLDERS", in: table)
        try await awaitRow("Sources", index: 1, in: table)
        try await awaitRow("More files…", index: 2, in: table)
        try pressKey(table, row: 2)
        try await awaitRow("z.txt", index: 2, in: table)
        try pressKey(table, row: 1)
        try await awaitRow("main.swift", index: 2, in: table)
        try await awaitRow("z.txt", index: 3, in: table)
        #expect(nav.fittingWidth.map { $0 > 60 } == true)
        var parent: String?; nav.onNewFile = { parent = $0 }
        let place = table.rect(ofRow: 1)
        let press = try #require(NSEvent.mouseEvent(with:.rightMouseDown,location:table.convert(NSPoint(x:place.midX,y:place.midY),to:nil),modifierFlags:[],timestamp:0,windowNumber:window.windowNumber,context:nil,eventNumber:0,clickCount:1,pressure:1))
        let create = try #require(table.menu(for:press)?.items.first { $0.title == "New file in this folder…" })
        #expect(NSApp.sendAction(try #require(create.action),to:create.target,from:create))
        #expect(parent == "Sources")
        try pressKey(table, row: 2)
        #expect(opened?.0 == "Sources/main.swift")
        #expect(opened?.1 == nil)
        nav.showSearch(contents:true)
        let query = try #require(descendant(nav.view,NSSearchField.self))
        query.stringValue = "call()"; nav.controlTextDidChange(Notification(name:NSControl.textDidChangeNotification,object:query))
        try await awaitRow("Sources/main.swift:4",in:table)
        try pressKey(table, row: 0)
        #expect(opened?.0 == "Sources/main.swift"); #expect(opened?.1 == 4)
        #expect(api.searchKind == "text")
        nav.showGit(doc:"Sources/main.swift")
        try await awaitRow("Sources/main.swift",in:table)
        try pressKey(table, row: 0)
        let display = try #require(descendant(nav.view,NSTextView.self,where:{ $0.accessibilityLabel() == "Git diff" }))
        let clock = ContinuousClock(), until = clock.now.advanced(by:.seconds(2))
        while display.string.isEmpty, clock.now < until { await Task.yield() }
        #expect(display.string == "+call()\n-old()\n"); #expect(expanded == [true])
        #expect(api.gitPaths.filter { !$0.isEmpty } == ["Sources/main.swift", "Sources/main.swift"])
        let back = try #require(descendant(nav.view,NSButton.self,where:{ $0.accessibilityLabel() == "Go back" }))
        back.performClick(nil)
        try await awaitRow("Sources/main.swift",in:table)
        #expect(expanded == [true,false])
    }

    @Test func restoresFoldersBeforeStartAndRevealsPathsBeyondTheFirstPage() async throws {
        _ = NSApplication.shared
        let api = NavigatorFixture(); api.lateFolder = true
        let nav = ProjectNavigator(api: api)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 340, height: 470), styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = nav.view
        defer { nav.stop(); window.orderOut(nil) }
        nav.restoreFolders(["Late"])
        #expect(nav.expandedFolders == ["Late"])
        try await nav.start()
        nav.view.layoutSubtreeIfNeeded()
        let table = try #require(descendant(nav.view, NSOutlineView.self))
        try await awaitRow("inside.md", index: 2, in: table)
        #expect(api.treePaths.contains("Late"))
        var changes = 0; nav.onLayoutChange = { changes += 1 }
        nav.revealFile("Sources/main.swift")
        try await awaitRow("main.swift", index: 4, in: table)
        #expect(table.selectedRow == 4)
        #expect(changes == 1)
        #expect(nav.expandedFolders == ["Late", "Sources"])
    }

    @Test func openFilesRetainTheTreeAndFileActionsUseProjectRelativePaths() async throws {
        _ = NSApplication.shared
        let api = NavigatorFixture(), nav = ProjectNavigator(api: api)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 340, height: 470), styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = nav.view
        defer { nav.stop(); window.orderOut(nil) }
        var actions: [NavigatorFileAction] = []; nav.onFileAction = { actions.append($0) }
        var chosen: String?; nav.onSelectTab = { chosen = $0 }
        var closed: String?; nav.onCloseTab = { closed = $0 }
        var branch: String?; nav.onBranch = { branch = $0 }
        let doc = "Sources/main.swift", key = "doc:" + doc
        let icon = WorkspaceFileIcon.forPath(doc)
        nav.showOpenTabs([WorkspaceTab(key: key, label: "main.swift", detail: doc, symbol: icon.symbol,
            unsaved: true, preview: true, colourRole: icon.role)], selected: key)
        nav.restoreFolders(["Sources"])
        try await nav.start()
        nav.view.layoutSubtreeIfNeeded()
        let table = try #require(descendant(nav.view, NSOutlineView.self))
        try await awaitRow("OPEN FILES", in: table)
        try await awaitRow("FOLDERS", index: 2, in: table)
        try await awaitRow("main.swift", index: 4, in: table)
        try pressKey(table, row: 1)
        #expect(chosen == key)
        let tab = try #require(table.view(atColumn: 0, row: 1, makeIfNecessary: true))
        let close = try #require(descendant(tab, NSButton.self, where: { $0.accessibilityLabel() == "Close main.swift" }))
        close.performClick(nil)
        #expect(closed == key)
        let node = try #require(table.item(atRow: 4))
        let item = try #require(nav.outlineView(table, pasteboardWriterForItem: node) as? NSPasteboardItem)
        #expect(item.string(forType: .init("app.pi.editor.path")) == doc)
        try pressKey(table, row: 4, code: 120, text: "\u{F705}")
        let rename = try #require(descendant(nav.view, NSTextField.self, where: { $0.accessibilityLabel() == "Rename main.swift" }))
        if let editor = rename.currentEditor() { editor.string = "Updated.swift" }
        else { rename.stringValue = "Updated.swift" }
        #expect(nav.control(rename, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:))))
        #expect(actions == [.rename(doc, "Sources/Updated.swift")])
        nav.showOpenTabs([], selected: nil)
        try await awaitRow("main.swift", index: 2, in: table)
        #expect(nav.expandedFolders == ["Sources"])
        let treeReads = api.treePaths
        nav.showSearch()
        branch = nil
        nav.refreshGitStatus()
        let clock = ContinuousClock(), until = clock.now.advanced(by: .seconds(2))
        while branch == nil, clock.now < until { await Task.yield() }
        #expect(branch == "main")
        #expect(api.treePaths == treeReads)
        #expect(descendant(nav.view, NSSearchField.self)?.isHidden == false)
    }

    @Test func statusMarksAndFileIconsRepresentDifferentKinds() {
        #expect(NavigatorGitMark(status: " M") == .modified)
        #expect(NavigatorGitMark(status: "AM") == .added)
        #expect(NavigatorGitMark(status: "??") == .untracked)
        #expect(NavigatorGitMark(status: "  ") == nil)
        #expect(WorkspaceFileIcon.forPath("Sources/MAIN.SWIFT").role == "peach")
        #expect(WorkspaceFileIcon.forPath("docs/readme.md").symbol != WorkspaceFileIcon.forPath("image.png").symbol)
        #expect(WorkspaceFileIcon.forPath("unknown").role == nil)
    }
}

@MainActor
private final class NavigatorFixture: EditorAPI {
    var searchKind: String?
    var gitPaths: [String] = []
    var treePaths: [String] = []
    var lateFolder = false
    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        switch op {
        case "tree":
            let path = fields["path"] as? String ?? ""
            treePaths.append(path)
            if path == "Sources" { return ["entries": [["path": "Sources/main.swift", "name": "main.swift", "dir": false]]] }
            if path == "Late" { return ["entries": [["path": "Late/inside.md", "name": "inside.md", "dir": false]]] }
            if fields["offset"] as? Int == 160 {
                var entries: [Fields] = [["path": "z.txt", "name": "z.txt", "dir": false]]
                if lateFolder { entries.append(["path": "Late", "name": "Late", "dir": true]) }
                return ["entries": entries]
            }
            return ["entries": [["path": "Sources", "name": "Sources", "dir": true]], "next": 160]
        case "search":
            searchKind = fields["kind"] as? String
            return ["hits":[["path":"Sources/main.swift","line":4,"preview":"call()"]],"limited":true]
        case "git":
            gitPaths.append(fields["doc"] as? String ?? "")
            return ["repo":true,"branch":"main","files":[["path":"Sources/main.swift","status":" M"]],"diff":"+call()\n-old()\n","limited":false]
        default: throw EditorIssue(code:"invalid",message:"Unexpected operation.")
        }
    }
}
