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

    @Test func reachesALaterWindowOverSeveralRounds() {
        let tree = ModelTree()
        // The first window holds more elements than one round may visit; the marker is in the
        // second window.
        let large = tree.add("AXWindow", .zero, window: 1)
        for _ in 0 ..< 3000 { tree.add("AXGroup", .zero, parent: large) }
        let later = tree.add("AXWindow", .zero, window: 1)
        let pane = tree.add("AXTextArea", .zero, parent: later, text: marker)
        var search = AnchorSearch<ModelTree>()
        var found: AnchorSearch<ModelTree>.Found?
        var rounds = 0
        while found == nil, rounds < 4 {
            rounds += 1
            search.begin([1])
            found = run(&search, tree, allowance: 100, steps: 1000).found
        }
        #expect(found?.element == pane)
        #expect(rounds == 2)
    }

    @Test func boundsEveryStepWhileWindowListsGoUnanswered() {
        let tree = ModelTree()
        for application in 1 ... 40 { tree.lateApplications.insert(pid_t(application)) }
        let terminal = tree.add("AXWindow", .zero, window: 41)
        let pane = tree.add("AXTextArea", .zero, parent: terminal, text: marker)
        var search = AnchorSearch<ModelTree>()
        search.begin(Array(1 ... 41))
        var found: AnchorSearch<ModelTree>.Found?
        var steps = 0
        var largest = 0
        while found == nil, steps < 500 {
            steps += 1
            let start = tree.requests
            // The step's time is over before its search starts, as after slow title reads.
            found = search.run(tree, marker: marker, expired: { true })
            largest = max(largest, tree.requests - start)
        }
        #expect(found?.element == pane)
        // Only the one unit of work that keeps the search moving runs after the step's time is
        // over: one window list or one element visit of at most two requests.
        #expect(largest <= 2)
        #expect(steps < 100)
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
        #expect(screen.scan(screen.frontText, StackingReport(pane: nil, above: [])) == .covers([frame]))
        #expect(screen.scan(screen.frontText, StackingReport(pane: front, above: [CGRect(x: 0, y: 0, width: 1, height: 1)])) == .covers([frame]))
    }
}

/// Reported areas paired with the content that the window draws. The window's layout area is 1000
/// by 1000 points at (0, 0), so a fraction times 1000 is a screen position; every pane has a 36
/// point title row above its screen.
@Suite struct TerminalReportedCovers {
    struct Layout {
        let tree = ModelTree()
        var window = 0, layers = 0, text = 0
        var textFrame = CGRect.zero

        /// A window with a tiled layer whose drawn content is `tiled`, and a floating reader pane
        /// at `pane` in layout fractions inside a layer group of `layerFrame`, or of the pane's
        /// own frame.
        init(pane: CGRect, tiled: CGRect = CGRect(x: 0, y: 36, width: 1000, height: 964), layerFrame: CGRect? = nil) {
            window = tree.add("AXWindow", CGRect(x: 0, y: 0, width: 1000, height: 1000), window: 1)
            layers = tree.add("AXGroup", CGRect(x: 0, y: 0, width: 1000, height: 1000), parent: window)
            let split = tree.add("AXSplitGroup", CGRect(x: 0, y: 0, width: 1000, height: 1000), parent: layers)
            tree.add("AXGroup", tiled, parent: split)
            let paneFrame = CGRect(x: pane.minX * 1000, y: pane.minY * 1000, width: pane.width * 1000, height: pane.height * 1000)
            let layer = tree.add("AXGroup", layerFrame ?? paneFrame, parent: layers)
            let group = tree.add("AXGroup", paneFrame, parent: layer)
            textFrame = CGRect(x: paneFrame.minX, y: paneFrame.minY + 36, width: paneFrame.width, height: paneFrame.height - 36)
            text = tree.add("AXTextArea", textFrame, parent: group)
        }

        /// A floating layer above the window's other children that draws its pane at `visible`
        /// inside a margin.
        @discardableResult
        func addFloating(_ visible: CGRect) -> Int {
            let layer = tree.add("AXGroup", visible.insetBy(dx: -40, dy: -40), parent: layers)
            tree.add("AXSplitGroup", visible, parent: layer)
            return layer
        }

        func scan(_ pane: CGRect, above: [CGRect]) -> CoverScan.Result? {
            CoverScan.scan(tree, element: text, frame: textFrame, window: window, application: 1, stacking: StackingReport(pane: pane, above: above))
        }
    }

    let reader = CGRect(x: 0.7, y: 0.2, width: 0.3, height: 0.6)

    @Test func coversOnlyThePartThatTheReportedPaneDraws() {
        let layout = Layout(pane: reader)
        #expect(layout.textFrame == CGRect(x: 700, y: 236, width: 300, height: 564))
        layout.addFloating(CGRect(x: 0, y: 0, width: 800, height: 800))
        // The upper pane lies over the reader's leftmost 100 points only. The tiled content below
        // the reader also overlaps the reported area, but its edges do not match it.
        let result = layout.scan(reader, above: [CGRect(x: 0, y: 0, width: 0.8, height: 0.8)])
        #expect(result == .covers([CGRect(x: 700, y: 236, width: 100, height: 564)]))
    }

    @Test func aReportedAreaWithoutDrawnContentMakesNoHole() {
        // The report lists an area that the window does not draw, such as a minimised pane.
        let layout = Layout(pane: reader)
        #expect(layout.scan(reader, above: [CGRect(x: 0, y: 0, width: 0.8, height: 0.8)]) == .covers([]))
        // The tiled content below the reader shares three edges with this area, not the fourth.
        #expect(layout.scan(reader, above: [CGRect(x: 0, y: 0.036, width: 0.75, height: 0.964)]) == .covers([]))
        // The hit test that decides when no area pairs finds the reader's own content there.
        let text = layout.text
        layout.tree.hit[1] = { _ in text }
        #expect(layout.scan(reader, above: [CGRect(x: 0, y: 0, width: 0.8, height: 0.8)]) == .covers([]))
    }

    @Test func pairsAnAreaThatReachesPastTheLayoutEdge() {
        // Every value of the area lies between 0 and 1, but its right edge reaches 1.15.
        let layout = Layout(pane: reader)
        layout.addFloating(CGRect(x: 750, y: 200, width: 250, height: 400))
        let result = layout.scan(reader, above: [CGRect(x: 0.75, y: 0.2, width: 0.4, height: 0.4)])
        #expect(result == .covers([CGRect(x: 750, y: 236, width: 250, height: 364)]))
        // An area wholly outside the layout lies over nothing.
        #expect(layout.scan(reader, above: [CGRect(x: 1, y: 0.2, width: 0.4, height: 0.4)]) == .covers([]))
    }

    @Test func decidesByHitTestWhenNoAreaPairsWithDrawnContent() throws {
        let layout = Layout(pane: reader)
        let visible = CGRect(x: 300, y: 300, width: 500, height: 400)
        let floating = layout.addFloating(visible)
        let above = [CGRect(x: 0.3, y: 0.3, width: 0.5, height: 0.4)]
        #expect(layout.scan(reader, above: above) == .covers([CGRect(x: 700, y: 300, width: 100, height: 400)]))
        // The pane's group pads the screen by 2 points on its left, so no ancestor qualifies as the
        // container and the area reaches the screen 30 points too low to pair.
        let group = try #require(layout.tree.items[layout.text]?.parent)
        layout.tree.items[group]?.frame = CGRect(x: 698, y: 200, width: 302, height: 600)
        let text = layout.text
        layout.tree.hit[1] = { point in visible.contains(point) ? floating : text }
        #expect(layout.scan(reader, above: above) == .covers([CGRect(x: 700, y: 300, width: 100, height: 400)]))
    }

    @Test func pairsAnAreaThatTheClosestPairsWouldLeaveOut() {
        // The closest pair takes the only candidate near enough to the first area; the second
        // area has another candidate within the tolerance.
        let areas = [CGRect(x: 0, y: 0, width: 102, height: 100), CGRect(x: 0, y: 0, width: 101, height: 100)]
        let drawn = [CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: 0, y: 0, width: 95, height: 100)]
        let result = CoverScan.pairs(areas: areas, drawn: drawn, tolerance: CGSize(width: 6, height: 6))
        #expect(result.map(\.area) == [0, 1])
        #expect(result.map(\.candidate) == [0, 1])
        // An area with no candidate within the tolerance stays unpaired.
        let wide = CoverScan.pairs(areas: [CGRect(x: 0, y: 0, width: 110, height: 100)], drawn: drawn, tolerance: CGSize(width: 6, height: 6))
        #expect(wide.isEmpty)
    }

    @Test func pairsEachAreaWithOneOfNearlyEqualCandidates() {
        let pane = CGRect(x: 0.5, y: 0.5, width: 0.4, height: 0.4)
        let layout = Layout(pane: pane)
        layout.addFloating(CGRect(x: 300, y: 300, width: 400, height: 400))
        layout.addFloating(CGRect(x: 305, y: 302, width: 400, height: 400))
        let one = layout.scan(pane, above: [CGRect(x: 0.3, y: 0.3, width: 0.4, height: 0.4)])
        #expect(one == .covers([CGRect(x: 500, y: 536, width: 200, height: 164)]))
        let two = layout.scan(pane, above: [CGRect(x: 0.3, y: 0.3, width: 0.4, height: 0.4), CGRect(x: 0.305, y: 0.302, width: 0.4, height: 0.4)])
        #expect(two == .covers([CGRect(x: 500, y: 536, width: 200, height: 164), CGRect(x: 500, y: 536, width: 205, height: 166)]))
    }

    @Test func placesAreasThroughTheTitleRowOfASmallPane() {
        // A small pane: its title row is almost half its height, so the screen alone would give
        // a vertical scale far from the layout's.
        let pane = CGRect(x: 0.9, y: 0.9, width: 0.08, height: 0.08)
        let layout = Layout(pane: pane)
        layout.addFloating(CGRect(x: 850, y: 850, width: 100, height: 100))
        let result = layout.scan(pane, above: [CGRect(x: 0.85, y: 0.85, width: 0.1, height: 0.1)])
        #expect(result == .covers([CGRect(x: 900, y: 936, width: 50, height: 14)]))
    }

    @Test func takesTheContainerOnlyUpToATitleRow() {
        // The reader's layer group shares the pane's left, right and bottom edges but reaches far
        // above it; it is not the pane's container.
        let layout = Layout(pane: reader, layerFrame: CGRect(x: 700, y: 0, width: 300, height: 800))
        layout.addFloating(CGRect(x: 0, y: 0, width: 800, height: 800))
        let result = layout.scan(reader, above: [CGRect(x: 0, y: 0, width: 0.8, height: 0.8)])
        #expect(result == .covers([CGRect(x: 700, y: 236, width: 100, height: 564)]))
    }

    @Test func hidesAFrameThatSeveralCoversHideTogether() {
        let frame = CGRect(x: 0, y: 0, width: 300, height: 200)
        let left = CGRect(x: -10, y: -10, width: 160, height: 220)
        let right = CGRect(x: 140, y: 0, width: 160, height: 200)
        #expect(CoverRegion.coversEntirely(frame, holes: [left, right]))
        #expect(!CoverRegion.coversEntirely(frame, holes: [left, CGRect(x: 160, y: 0, width: 140, height: 200)]))
        #expect(CoverRegion.visible(frame, holes: [left, CGRect(x: 160, y: 0, width: 140, height: 200)]) == [CGRect(x: 150, y: 0, width: 10, height: 200)])
        let placement = TerminalAnchor.Placement(frame: frame, host: 1, window: nil, coveredBy: nil, covers: [left, right])
        #expect(placement.coveredEntirely)
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

    @Test func dropsTheWholeOfALineThatExceedsTheLimit() {
        let valid = #"{"version":1,"pane":null}"#
        var lines = StackingLines()
        #expect(lines.append(Data("a\nb".utf8)) == [Data("a".utf8)])
        #expect(lines.append(Data("c\n".utf8)) == [Data("bc".utf8)])
        // The line passes the limit in its first chunk; its tail, a valid report, arrives later.
        #expect(lines.append(Data(String(repeating: "x", count: StackingReport.lineLimit + 1).utf8)) == [])
        #expect(lines.append(Data(valid.utf8)) == [])
        #expect(lines.append(Data("\n\(valid)\n".utf8)) == [Data(valid.utf8)])
        // A line of exactly the limit is kept.
        let full = Data(String(repeating: "y", count: StackingReport.lineLimit).utf8)
        #expect(lines.append(full + Data("\n".utf8)) == [full])
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
