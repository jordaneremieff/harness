import CoreGraphics
import Testing
@testable import MarkdownCore
@testable import MacPlatform

/// A screen of applications, windows and elements that answers like the accessibility interface,
/// counts requests and can make elements answer late.
final class ModelTree: AccessibilityTree {
    struct Item {
        var role: String
        var frame: CGRect
        var parent: Int?
        var children: [Int] = []
        var text: String?
    }

    var items: [Int: Item] = [:]
    var windowsOf: [pid_t: [Int]] = [:]
    /// Elements whose every request goes unanswered.
    var late: Set<Int> = []
    /// Applications whose window list goes unanswered.
    var lateApplications: Set<pid_t> = []
    /// The frontmost element at a point, per application.
    var hit: [pid_t: (CGPoint) -> Int?] = [:]
    private(set) var requests = 0
    private(set) var longestTextRead = 0
    private var next = 1

    @discardableResult
    func add(_ role: String, _ frame: CGRect, parent: Int? = nil, text: String? = nil, window application: pid_t? = nil) -> Int {
        let node = next
        next += 1
        items[node] = Item(role: role, frame: frame, parent: parent, text: text)
        if let parent { items[parent]?.children.append(node) }
        if let application { windowsOf[application, default: []].append(node) }
        return node
    }

    private func answer<Value>(_ node: Int, _ value: Value?) -> Reply<Value> {
        requests += 1
        if late.contains(node) { return .busy }
        return value.map(Reply.value) ?? .missing
    }

    func windows(_ application: pid_t) -> Reply<[Int]> {
        requests += 1
        if lateApplications.contains(application) { return .busy }
        return windowsOf[application].map(Reply.value) ?? .missing
    }

    func role(_ node: Int) -> Reply<String> { answer(node, items[node]?.role) }
    func children(_ node: Int) -> Reply<[Int]> { answer(node, items[node]?.children) }
    func parent(_ node: Int) -> Reply<Int> { answer(node, items[node]?.parent) }
    func frame(_ node: Int) -> Reply<CGRect> { answer(node, items[node]?.frame) }

    func visibleText(_ node: Int, limit: Int) -> Reply<String> {
        longestTextRead = max(longestTextRead, limit)
        return answer(node, items[node]?.text.map { String($0.prefix(limit)) })
    }

    func element(at point: CGPoint, in application: pid_t) -> Reply<Int> {
        requests += 1
        return hit[application]?(point).map(Reply.value) ?? .missing
    }

    func same(_ first: Int, _ second: Int) -> Bool { first == second }
}

@Suite struct TerminalSearch {
    let marker = "reader-0123456789ab"

    /// Runs search steps that each allow `allowance` requests, until the search finds an element
    /// or `steps` steps ran.
    func run(_ search: inout AnchorSearch<ModelTree>, _ tree: ModelTree, allowance: Int, steps: Int) -> (found: AnchorSearch<ModelTree>.Found?, steps: Int) {
        for step in 1 ... steps {
            let start = tree.requests
            if let found = search.run(tree, marker: marker, expired: { tree.requests - start >= allowance }) { return (found, step) }
            if search.roundComplete { return (nil, step) }
        }
        return (nil, steps)
    }

    @Test func reachesTheHostBehindASlowApplicationAndALargeTree() {
        let tree = ModelTree()
        // The frontmost application answers nothing in time.
        let slowWindow = tree.add("AXWindow", .zero, window: 1)
        for _ in 0 ..< 50 { tree.late.insert(tree.add("AXGroup", .zero, parent: slowWindow)) }
        tree.late.insert(slowWindow)
        // The next application has a large tree without the marker.
        let large = tree.add("AXWindow", .zero, window: 2)
        for _ in 0 ..< 4000 { tree.add("AXGroup", .zero, parent: large) }
        // The terminal shows the marker.
        let terminal = tree.add("AXWindow", .zero, window: 3)
        let pane = tree.add("AXTextArea", CGRect(x: 0, y: 0, width: 100, height: 100), parent: terminal, text: "\(marker)\n\n  Title")
        var search = AnchorSearch<ModelTree>()
        search.begin([1, 2, 3])
        let result = run(&search, tree, allowance: 40, steps: 400)
        #expect(result.found?.element == pane)
        #expect(result.found?.application == 3)
        #expect(result.found?.window == terminal)
        // Every step continued where the previous one stopped: no step started the round again.
        #expect(result.steps < 400)
    }

    @Test func leavesAnApplicationWhoseWindowListGoesUnanswered() {
        let tree = ModelTree()
        tree.lateApplications.insert(1)
        let terminal = tree.add("AXWindow", .zero, window: 2)
        let pane = tree.add("AXTextArea", .zero, parent: terminal, text: marker)
        var search = AnchorSearch<ModelTree>()
        search.begin([1, 2])
        #expect(run(&search, tree, allowance: 10, steps: 10).found?.element == pane)
    }

    @Test func readsOnlyTheStartOfVisibleText() {
        let tree = ModelTree()
        let window = tree.add("AXWindow", .zero, window: 1)
        // A long document whose text contains the marker far from its start.
        tree.add("AXTextArea", .zero, parent: window, text: String(repeating: "x", count: 10_000) + marker)
        var search = AnchorSearch<ModelTree>()
        search.begin([1])
        #expect(run(&search, tree, allowance: 100, steps: 5).found == nil)
        #expect(tree.longestTextRead == AnchorSearch<ModelTree>.textLimit)
    }

    @Test func findsTheMarkerOnlyAtTheStartOfTheFirstRow() {
        #expect(AnchorSearch<ModelTree>.shows(marker, "\(marker)\n\n  Title"))
        #expect(AnchorSearch<ModelTree>.shows(marker, "  \(marker)   \r\nmore"))
        #expect(!AnchorSearch<ModelTree>.shows(marker, "captured: \(marker)"))
        #expect(!AnchorSearch<ModelTree>.shows(marker, "$ rex capture\n\(marker)"))
        #expect(!AnchorSearch<ModelTree>.shows(marker, "reader-0123"))
    }

    @Test func continuesBehindAFoundCopyOfTheMarker() {
        let tree = ModelTree()
        let window = tree.add("AXWindow", .zero, window: 1)
        // Another pane that scrolled a copy of the marker to its first row.
        let copy = tree.add("AXTextArea", .zero, parent: window, text: "\(marker)\n$ ")
        tree.add("AXTextArea", .zero, parent: window, text: "$ cat capture.txt\n\(marker)")
        let pane = tree.add("AXTextArea", .zero, parent: window, text: marker)
        var search = AnchorSearch<ModelTree>()
        search.begin([1])
        #expect(run(&search, tree, allowance: 100, steps: 5).found?.element == copy)
        #expect(run(&search, tree, allowance: 100, steps: 5).found?.element == pane)
    }

    @Test func visitsAtLeastOneNodePerStepWhenTheStepTimeIsAlreadyOver() {
        let tree = ModelTree()
        let window = tree.add("AXWindow", .zero, window: 1)
        let group = tree.add("AXGroup", .zero, parent: window)
        let pane = tree.add("AXTextArea", .zero, parent: group, text: marker)
        var search = AnchorSearch<ModelTree>()
        search.begin([1])
        var found: AnchorSearch<ModelTree>.Found?
        for _ in 0 ..< 10 where found == nil { found = search.run(tree, marker: marker, expired: { true }) }
        #expect(found?.element == pane)
    }

    @Test func countsTheNodeBudgetPerApplication() {
        let tree = ModelTree()
        for _ in 0 ..< 2 {
            let window = tree.add("AXWindow", .zero, window: 1)
            for _ in 0 ..< 2000 { tree.add("AXGroup", .zero, parent: window) }
        }
        let last = tree.windowsOf[1]!.last!
        tree.add("AXTextArea", .zero, parent: last, text: marker)
        var search = AnchorSearch<ModelTree>()
        search.begin([1])
        #expect(run(&search, tree, allowance: 10_000, steps: 5).found == nil)
        #expect(tree.requests < 2 * AnchorSearch<ModelTree>.nodeBudget + 10)
    }

    @Test func prefersAnApplicationOnlyWithinARound() {
        var search = AnchorSearch<ModelTree>()
        search.prefer(9)
        #expect(search.roundComplete)
        search.begin([1, 2, 3, 4])
        search.prefer(4)
        #expect(search.applications == [1, 4, 2, 3])
        search.prefer(1)
        #expect(search.applications == [1, 4, 2, 3])
        search.prefer(7)
        #expect(search.applications == [1, 7, 4, 2, 3])
    }
}

@Suite struct TerminalCovers {
    /// A window with a tiled layer of two panes and a floating layer whose container keeps a
    /// margin around its visible pane, as some terminal applications build it.
    struct Screen {
        let tree = ModelTree()
        var window = 0, layers = 0, tiled = 0, left = 0, right = 0, floating = 0, floatPane = 0, floatText = 0
        let rightFrame = CGRect(x: 890, y: 75, width: 630, height: 1116)
        let floatVisible = CGRect(x: 950, y: 384, width: 382, height: 345)

        init(floatAbove: Bool) {
            window = tree.add("AXWindow", CGRect(x: 0, y: 31, width: 1531, height: 1168), window: 1)
            layers = tree.add("AXGroup", CGRect(x: 250, y: 39, width: 1281, height: 1160), parent: window)
            floating = tree.add("AXGroup", floatVisible.insetBy(dx: -90, dy: -90), parent: layers)
            floatPane = tree.add("AXGroup", floatVisible, parent: floating)
            floatText = tree.add("AXTextArea", floatVisible.insetBy(dx: 0, dy: 18).offsetBy(dx: 0, dy: 18), parent: floatPane)
            tiled = tree.add("AXSplitGroup", CGRect(x: 250, y: 39, width: 1273, height: 1152), parent: layers)
            left = tree.add("AXTextArea", CGRect(x: 250, y: 75, width: 632, height: 1116), parent: tiled)
            right = tree.add("AXTextArea", rightFrame, parent: tiled)
            let (floatingNode, floatPaneNode, layersNode, rightNode) = (floating, floatPane, layers, right)
            let outer = floatVisible.insetBy(dx: -90, dy: -90)
            let rightRect = rightFrame
            tree.hit[1] = { point in
                if floatAbove, outer.contains(point) { return floatingNode }
                if !floatAbove, rightRect.contains(point) { return rightNode }
                if outer.contains(point) { return floatPaneNode }
                return layersNode
            }
        }
    }

    @Test func coversTheVisiblePartOfAFloatingPaneAbove() {
        let screen = Screen(floatAbove: true)
        let result = CoverScan.scan(screen.tree, element: screen.right, frame: screen.rightFrame, window: screen.window, application: 1)
        #expect(result == .covers([screen.floatVisible]))
    }

    @Test func ignoresContentBelowTheElement() {
        let screen = Screen(floatAbove: false)
        let result = CoverScan.scan(screen.tree, element: screen.right, frame: screen.rightFrame, window: screen.window, application: 1)
        #expect(result == .covers([]))
    }

    @Test func aFloatingPaneIsNotCoveredByTheTiledLayerBelowIt() {
        let screen = Screen(floatAbove: true)
        let frame = screen.tree.items[screen.floatText]!.frame
        let result = CoverScan.scan(screen.tree, element: screen.floatText, frame: frame, window: screen.window, application: 1)
        #expect(result == .covers([]))
    }

    @Test func givesNoResultWhenTheTreeDoesNotAnswer() {
        let screen = Screen(floatAbove: true)
        screen.tree.late.insert(screen.tiled)
        #expect(CoverScan.scan(screen.tree, element: screen.right, frame: screen.rightFrame, window: screen.window, application: 1) == nil)
    }

    @Test func givesNoResultWhenACandidateExceedsTheRequestBudget() {
        let screen = Screen(floatAbove: true)
        for _ in 0 ..< CoverScan.requestLimit { screen.tree.add("AXGroup", screen.floatVisible, parent: screen.floating) }
        #expect(CoverScan.scan(screen.tree, element: screen.right, frame: screen.rightFrame, window: screen.window, application: 1) == nil)
        let small = Screen(floatAbove: true)
        #expect(CoverScan.scan(small.tree, element: small.right, frame: small.rightFrame, window: small.window, application: 1, expired: { true }) == nil)
    }

    @Test func overlappingHolesStayOpen() throws {
        let bounds = CGRect(x: 0, y: 0, width: 100, height: 100)
        let path = try #require(TerminalAnchor.maskPath(bounds: bounds, holes: [CGRect(x: 10, y: 10, width: 40, height: 40), CGRect(x: 30, y: 30, width: 40, height: 40)]))
        #expect(!path.contains(CGPoint(x: 40, y: 40)))
        #expect(!path.contains(CGPoint(x: 15, y: 15)))
        #expect(!path.contains(CGPoint(x: 65, y: 65)))
        #expect(path.contains(CGPoint(x: 90, y: 10)))
        #expect(TerminalAnchor.maskPath(bounds: bounds, holes: []) == nil)
    }

    @Test func reportsAnElementThatItsWindowNoLongerShows() {
        let screen = Screen(floatAbove: true)
        // The application keeps the element but drops it from its parent's children, as when
        // another pane fills the window.
        screen.tree.items[screen.tiled]?.children.removeAll { $0 == screen.right }
        #expect(CoverScan.scan(screen.tree, element: screen.right, frame: screen.rightFrame, window: screen.window, application: 1) == .detached)
    }

    /// Two overlapping floating panes over a tiled layer. The application's hit test returns the
    /// earlier floating pane wherever both lie, although the later one is drawn in front.
    struct TwoFloats {
        let tree = ModelTree()
        var window = 0, layers = 0, back = 0, backText = 0, front = 0, frontText = 0
        // In the report's layout coordinates the window's layout area is 1000 by 1000 points at
        // (0, 0); each pane has a 36 point title row above its screen.
        let backVisible = CGRect(x: 100, y: 100, width: 500, height: 500)
        let frontVisible = CGRect(x: 400, y: 400, width: 400, height: 400)

        init() {
            window = tree.add("AXWindow", CGRect(x: 0, y: 0, width: 1000, height: 1000), window: 1)
            layers = tree.add("AXGroup", CGRect(x: 0, y: 0, width: 1000, height: 1000), parent: window)
            back = tree.add("AXGroup", backVisible.insetBy(dx: -90, dy: -90), parent: layers)
            let backPane = tree.add("AXGroup", backVisible, parent: back)
            backText = tree.add("AXTextArea", CGRect(x: 100, y: 136, width: 500, height: 464), parent: backPane)
            front = tree.add("AXGroup", frontVisible.insetBy(dx: -90, dy: -90), parent: layers)
            let frontPane = tree.add("AXGroup", frontVisible, parent: front)
            frontText = tree.add("AXTextArea", CGRect(x: 400, y: 436, width: 400, height: 364), parent: frontPane)
            let tiled = tree.add("AXSplitGroup", CGRect(x: 0, y: 0, width: 1000, height: 1000), parent: layers)
            tree.add("AXTextArea", CGRect(x: 0, y: 36, width: 1000, height: 964), parent: tiled)
            let (backNode, frontNode, layersNode) = (back, front, layers)
            let backOuter = backVisible.insetBy(dx: -90, dy: -90), frontOuter = frontVisible.insetBy(dx: -90, dy: -90)
            tree.hit[1] = { point in
                if backOuter.contains(point) { return backNode }
                if frontOuter.contains(point) { return frontNode }
                return layersNode
            }
        }

        func scan(_ element: Int, _ stacking: StackingReport?) -> CoverScan.Result? {
            CoverScan.scan(tree, element: element, frame: tree.items[element]!.frame, window: window, application: 1, stacking: stacking)
        }
    }

    @Test func takesTheOrderOfOverlappingFloatingPanesFromTheStackingReport() {
        let screen = TwoFloats()
        let back = CGRect(x: 0.1, y: 0.1, width: 0.5, height: 0.5)
        let front = CGRect(x: 0.4, y: 0.4, width: 0.4, height: 0.4)
        // The back pane is covered where the front pane lies, although the hit test says otherwise.
        #expect(screen.scan(screen.backText, nil) == .covers([]))
        let backCovers = screen.scan(screen.backText, StackingReport(pane: back, above: [front]))
        #expect(backCovers == .covers([screen.frontVisible.intersection(screen.tree.items[screen.backText]!.frame)]))
        // The front pane is not covered by the back pane, although the hit test says otherwise.
        #expect(screen.scan(screen.frontText, nil) != .covers([]))
        #expect(screen.scan(screen.frontText, StackingReport(pane: front, above: [])) == .covers([]))
    }

    @Test func aReportOverTheWholePaneCoversTheWholeFrame() {
        let screen = TwoFloats()
        let frame = screen.tree.items[screen.frontText]!.frame
        let front = CGRect(x: 0.4, y: 0.4, width: 0.4, height: 0.4)
        #expect(screen.scan(screen.frontText, StackingReport(pane: front, above: [CGRect(x: 0, y: 0, width: 1, height: 1)])) == .covers([frame]))
        #expect(screen.scan(screen.frontText, StackingReport(pane: nil, above: [])) == .covers([frame]))
    }
}

@Suite struct TerminalStacking {
    @Test func readsValidReportsAndIgnoresTheRest() {
        func parse(_ text: String) -> StackingReport? { StackingReport.parse(Data(text.utf8)) }
        #expect(parse(#"{"version":1,"pane":[0.5,0,0.5,1],"above":[[0.55,0.3,0.3,0.3]]}"#)
            == StackingReport(pane: CGRect(x: 0.5, y: 0, width: 0.5, height: 1), above: [CGRect(x: 0.55, y: 0.3, width: 0.3, height: 0.3)]))
        #expect(parse(#"{"version":1,"pane":null}"#) == StackingReport(pane: nil, above: []))
        #expect(parse(#"{"version":2,"pane":null}"#) == nil)
        #expect(parse(#"{"version":true,"pane":null}"#) == nil)
        #expect(parse(#"{"version":1,"pane":[0.5,0,0.5,1.2],"above":[]}"#) == nil)
        #expect(parse(#"{"version":1,"pane":[0.5,0,0.5,1],"above":[[0,0,1]]}"#) == nil)
        #expect(parse(#"{"version":1,"pane":[0.5,0,0.5,1]}"#) == nil)
        let many = Array(repeating: "[0,0,0.1,0.1]", count: 65).joined(separator: ",")
        #expect(parse(#"{"version":1,"pane":[0,0,1,1],"above":[\#(many)]}"#) == nil)
        #expect(parse("not json") == nil)
    }

    @Test func acceptsOnlyAnAbsoluteCommandOfAtMostSixteenWords() {
        #expect(StackingReport.command(["PI_PANE_STACKING": #"["/usr/bin/node","/x/helper.mts"]"#]) == ["/usr/bin/node", "/x/helper.mts"])
        #expect(StackingReport.command([:]) == nil)
        #expect(StackingReport.command(["PI_PANE_STACKING": #"["node","helper.mts"]"#]) == nil)
        #expect(StackingReport.command(["PI_PANE_STACKING": "[]"]) == nil)
        #expect(StackingReport.command(["PI_PANE_STACKING": #""/bin/sh""#]) == nil)
        let long = "[" + Array(repeating: #""/bin/x""#, count: 17).joined(separator: ",") + "]"
        #expect(StackingReport.command(["PI_PANE_STACKING": long]) == nil)
    }

    @Test func followsTheCommandsReportsAndEndsIt() async throws {
        let script = #"printf '{"version":1,"pane":[0,0,1,1],"above":[]}\n{"version":1,"pane":[0,0,1,1],"above":[[0.2,0.2,0.3,0.3]]}\n'; cat >/dev/null; echo ended > "$1""#
        let marker = FileManager.default.temporaryDirectory.appendingPathComponent("stacking-\(UUID().uuidString)")
        let environment = ["PI_PANE_STACKING": String(data: try JSONSerialization.data(withJSONObject: ["/bin/sh", "-c", script, "sh", marker.path]), encoding: .utf8)!]
        let feed = try #require(StackingFeed.start(environment: environment))
        let expected = StackingReport(pane: CGRect(x: 0, y: 0, width: 1, height: 1), above: [CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3)])
        for _ in 0 ..< 200 where feed.latest.report != expected { try await Task.sleep(for: .milliseconds(10)) }
        #expect(feed.latest.report == expected)
        #expect(feed.latest.generation == 1 || feed.latest.generation == 2)
        feed.stop()
        for _ in 0 ..< 200 where !FileManager.default.fileExists(atPath: marker.path) { try await Task.sleep(for: .milliseconds(10)) }
        #expect(FileManager.default.fileExists(atPath: marker.path))
        try? FileManager.default.removeItem(at: marker)
    }

    @Test func forgetsTheReportWhenTheCommandEnds() async throws {
        let script = #"printf '{"version":1,"pane":[0,0,1,1],"above":[]}\n'; sleep 0.5"#
        let environment = ["PI_PANE_STACKING": String(data: try JSONSerialization.data(withJSONObject: ["/bin/sh", "-c", script]), encoding: .utf8)!]
        let feed = try #require(StackingFeed.start(environment: environment))
        for _ in 0 ..< 200 where feed.latest.report == nil { try await Task.sleep(for: .milliseconds(10)) }
        #expect(feed.latest.report == StackingReport(pane: CGRect(x: 0, y: 0, width: 1, height: 1), above: []))
        // The command ends half a second after its report.
        for _ in 0 ..< 300 where feed.latest.report != nil { try await Task.sleep(for: .milliseconds(10)) }
        #expect(feed.latest.report == nil)
        #expect(feed.latest.generation == 2)
    }
}
