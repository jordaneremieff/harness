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
    private func keyOpen(_ table: NSTableView, row: Int) throws {
        table.selectRowIndexes(IndexSet(integer:row), byExtendingSelection:false)
        let event = try #require(NSEvent.keyEvent(with: .keyDown,location:.zero,modifierFlags:[],timestamp:0,windowNumber:0,context:nil,characters:"\r",charactersIgnoringModifiers:"\r",isARepeat:false,keyCode:36))
        table.keyDown(with:event)
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
    @Test func directoryPagesSearchAndGitUseTheSelectedProjectPath() async throws {
        _ = NSApplication.shared
        let api = NavigatorFixture(), nav = ProjectNavigator(api:api)
        let window = NSWindow(contentRect:.init(x:0,y:0,width:340,height:470),styleMask:.borderless,backing:.buffered,defer:false)
        window.contentView = nav.view
        defer { nav.stop(); window.orderOut(nil) }
        var opened: (String,Int?)?; nav.onOpen = { opened = ($0,$1) }
        var expanded: [Bool] = []; nav.onExpand = { expanded.append($0) }
        try await nav.start(); nav.view.layoutSubtreeIfNeeded()
        let table = try #require(descendant(nav.view,NSTableView.self))
        try await awaitRow("Sources",in:table)
        let more = try #require(descendant(nav.view,NSButton.self,where:{ $0.title == "More files…" }))
        more.performClick(nil)
        try await awaitRow("z.txt",index:1,in:table)
        try keyOpen(table,row:0)
        try await awaitRow("main.swift",in:table)
        try keyOpen(table,row:0)
        #expect(opened?.0 == "Sources/main.swift")
        #expect(opened?.1 == nil)
        nav.showSearch(contents:true)
        let query = try #require(descendant(nav.view,NSSearchField.self))
        query.stringValue = "call()"; nav.controlTextDidChange(Notification(name:NSControl.textDidChangeNotification,object:query))
        try await awaitRow("Sources/main.swift:4",in:table)
        try keyOpen(table,row:0)
        #expect(opened?.0 == "Sources/main.swift"); #expect(opened?.1 == 4)
        #expect(api.searchKind == "text")
        nav.showGit(doc:"Sources/main.swift")
        try await awaitRow("Sources/main.swift",in:table)
        try keyOpen(table,row:0)
        let display = try #require(descendant(nav.view,NSTextView.self,where:{ $0.accessibilityLabel() == "Git diff" }))
        let clock = ContinuousClock(), until = clock.now.advanced(by:.seconds(2))
        while display.string.isEmpty, clock.now < until { await Task.yield() }
        #expect(display.string == "+call()\n-old()\n"); #expect(expanded == [true])
        #expect(api.gitPaths == ["Sources/main.swift", "Sources/main.swift"])
        let back = try #require(descendant(nav.view,NSButton.self,where:{ $0.accessibilityLabel() == "Go back" }))
        back.performClick(nil)
        try await awaitRow("Sources/main.swift",in:table)
        #expect(expanded == [true,false])
    }
}

@MainActor
private final class NavigatorFixture: EditorAPI {
    var searchKind: String?
    var gitPaths: [String] = []
    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        switch op {
        case "tree":
            if fields["path"] as? String == "Sources" { return ["entries":[["path":"Sources/main.swift","name":"main.swift","dir":false]],"next":NSNull()] }
            if fields["offset"] as? Int == 160 { return ["entries":[["path":"z.txt","name":"z.txt","dir":false]],"next":NSNull()] }
            return ["entries":[["path":"Sources","name":"Sources","dir":true]],"next":160]
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
