import Foundation
import ApplicationServices
import CoreGraphics

/// One answer of the accessibility interface: a value, no value, or no answer within the
/// messaging timeout because the application is busy.
enum Reply<Value> {
    case value(Value)
    case missing
    case busy

    var value: Value? {
        if case .value(let value) = self { value } else { nil }
    }
}

/// The accessibility requests that a search and a cover scan make. `LiveTree` asks the running
/// applications; tests use a model of a screen.
protocol AccessibilityTree {
    associatedtype Node
    func windows(_ application: pid_t) -> Reply<[Node]>
    func role(_ node: Node) -> Reply<String>
    func children(_ node: Node) -> Reply<[Node]>
    func parent(_ node: Node) -> Reply<Node>
    /// The element's frame in accessibility coordinates: origin at the top left of the primary
    /// screen, y downwards.
    func frame(_ node: Node) -> Reply<CGRect>
    /// At most `limit` characters from the start of the text that the element shows on screen.
    func visibleText(_ node: Node, limit: Int) -> Reply<String>
    /// The frontmost element of `application` at a point in accessibility coordinates.
    func element(at point: CGPoint, in application: pid_t) -> Reply<Node>
    func same(_ first: Node, _ second: Node) -> Bool
}

/// A search for the text area whose visible text shows the marker.
///
/// A search runs in rounds over a list of applications and keeps its place between steps: each
/// step continues the tree walk where the previous step stopped. A round leaves an application
/// after a node budget or after repeated requests without an answer. When the node budget ends
/// the walk of an application before its last window, the next round continues that walk where it
/// stopped instead of at the first window, so every window of a large application is reached in
/// turn. An application with a large tree or one that answers slowly therefore delays a round but
/// never keeps the search from reaching the other applications or its own later windows.
struct AnchorSearch<Tree: AccessibilityTree> {
    struct Found {
        var element: Tree.Node
        var window: Tree.Node
        var application: pid_t
    }

    /// The work of one step, in units: reading one application's window list, or visiting one
    /// element with at most two requests. Once the step's time is over no unit starts, except the
    /// step's first, so every step moves the search forward and at most two requests run after
    /// the time is over.
    struct Step {
        private(set) var units = 0
        let expired: () -> Bool

        mutating func begin() -> Bool {
            if units > 0, expired() { return false }
            units += 1
            return true
        }
    }

    /// Where the walk of one application stands: its windows, the next window to enter, and the
    /// elements still to visit in the current window.
    struct Walk {
        var windows: [Tree.Node]
        var windowIndex = 0
        var queue: [(node: Tree.Node, depth: Int)] = []
        var queueIndex = 0

        var finished: Bool { queueIndex >= queue.count && windowIndex >= windows.count }

        /// Drops the visited part of the queue.
        mutating func compact() {
            queue.removeFirst(queueIndex)
            queueIndex = 0
        }
    }

    /// Nodes of one application that one round visits.
    static var nodeBudget: Int { 2500 }
    /// Deepest level of an application's tree that a round visits.
    static var depthLimit: Int { 24 }
    /// Requests of one application without an answer before the round leaves that application.
    static var busyLimit: Int { 2 }
    /// Characters of a text area's visible text that a search reads.
    static var textLimit: Int { 512 }
    /// Applications whose unfinished walk the search keeps for the next round.
    static var keptWalkLimit: Int { 8 }
    /// Roles whose subtrees hold documents, lists or menus rather than terminals.
    static var skippedRoles: Set<String> { ["AXWebArea", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXMenuBar", "AXMenu"] }

    private(set) var applications: [pid_t] = []
    private(set) var index = 0
    private var walk: Walk?
    private var visited = 0
    private var busy = 0
    private var kept: [(application: pid_t, walk: Walk)] = []

    /// Whether the current round has visited every application.
    var roundComplete: Bool { index >= applications.count }

    /// Whether visible text shows the marker where the terminal prints it: at the start of its
    /// first row. The marker inside other text, such as output that quotes it, does not count.
    static func shows(_ marker: String, _ text: String) -> Bool {
        let first = text.prefix { $0 != "\n" && $0 != "\r" }
        return first.trimmingCharacters(in: .whitespaces).hasPrefix(marker)
    }

    /// Starts a round over these applications, in this order.
    mutating func begin(_ applications: [pid_t]) {
        self.applications = applications
        index = 0
        resetApplication()
    }

    /// Visits `application` next in the current round, unless the round visited it already or
    /// visits it now. A finished round stays finished.
    mutating func prefer(_ application: pid_t) {
        guard !roundComplete else { return }
        if let position = applications.firstIndex(of: application) {
            guard position > index else { return }
            applications.remove(at: position)
        }
        applications.insert(application, at: min(index + 1, applications.count))
    }

    /// Continues the round until a text area shows `marker`, the round ends, or `expired` says
    /// that the step's time is over. Every call makes at least one request. After a found
    /// element the next call continues behind it.
    mutating func run(_ tree: Tree, marker: String, expired: @escaping () -> Bool) -> Found? {
        var step = Step(expired: expired)
        while index < applications.count {
            let application = applications[index]
            if walk == nil {
                switch startWalk(tree, application, step: &step) {
                case .started(let started): walk = started
                case .paused: return nil
                case .left: continue
                }
            }
            guard visited < Self.nodeBudget else {
                leaveApplication(keeping: true)
                continue
            }
            guard var current = walk else {
                leaveApplication(keeping: false)
                continue
            }
            if current.queueIndex >= current.queue.count {
                guard current.windowIndex < current.windows.count else {
                    leaveApplication(keeping: false)
                    continue
                }
                current.queue = [(current.windows[current.windowIndex], 0)]
                current.queueIndex = 0
                current.windowIndex += 1
            }
            let (node, depth) = current.queue[current.queueIndex]
            let window = current.windows[current.windowIndex - 1]
            current.queueIndex += 1
            walk = current
            visited += 1
            switch visit(tree, node: node, depth: depth, window: window, application: application, marker: marker, step: &step) {
            case .found(let found): return found
            case .paused:
                // The step's time ended between two requests for this node: visit it again first.
                walk?.queueIndex -= 1
                visited -= 1
                return nil
            case .done: break
            }
        }
        return nil
    }

    private enum Visit {
        case found(Found)
        case done
        case paused
    }

    private enum Start {
        case started(Walk)
        /// The step's time ended before the window list was read.
        case paused
        /// The request found no windows or went unanswered; the search moved on or asks again.
        case left
    }

    /// The walk where the previous round stopped in this application, or a new walk over its
    /// windows.
    private mutating func startWalk(_ tree: Tree, _ application: pid_t, step: inout Step) -> Start {
        if let position = kept.firstIndex(where: { $0.application == application }) {
            return .started(kept.remove(at: position).walk)
        }
        guard step.begin() else { return .paused }
        switch tree.windows(application) {
        case .value(let list):
            return .started(Walk(windows: list))
        case .missing:
            leaveApplication(keeping: false)
            return .left
        case .busy:
            noteBusy()
            return .left
        }
    }

    private mutating func visit(_ tree: Tree, node: Tree.Node, depth: Int, window: Tree.Node, application: pid_t, marker: String, step: inout Step) -> Visit {
        guard step.begin() else { return .paused }
        let role: String
        switch tree.role(node) {
        case .value(let value): role = value
        case .missing: return .done
        case .busy:
            noteBusy()
            return .done
        }
        let textArea = role == kAXTextAreaRole
        guard textArea || (!Self.skippedRoles.contains(role) && depth < Self.depthLimit) else { return .done }
        if textArea {
            switch tree.visibleText(node, limit: Self.textLimit) {
            case .value(let text) where Self.shows(marker, text):
                return .found(Found(element: node, window: window, application: application))
            case .busy: noteBusy()
            default: break
            }
            return .done
        }
        switch tree.children(node) {
        case .value(let children):
            guard var current = walk else { return .done }
            for child in children where current.queue.count - current.queueIndex < Self.nodeBudget {
                current.queue.append((child, depth + 1))
            }
            if current.queueIndex > Self.nodeBudget { current.compact() }
            walk = current
        case .busy: noteBusy()
        case .missing: break
        }
        return .done
    }

    private mutating func noteBusy() {
        busy += 1
        if busy >= Self.busyLimit { leaveApplication(keeping: true) }
    }

    /// Moves to the next application. With `keeping`, an unfinished walk of this application is
    /// kept for the next round.
    private mutating func leaveApplication(keeping: Bool) {
        if keeping, var current = walk, !current.finished, index < applications.count {
            current.compact()
            kept.removeAll { $0.application == applications[index] }
            kept.append((applications[index], current))
            if kept.count > Self.keptWalkLimit { kept.removeFirst(kept.count - Self.keptWalkLimit) }
        }
        index += 1
        resetApplication()
    }

    private mutating func resetApplication() {
        walk = nil
        visited = 0
        busy = 0
    }
}

/// Finds the parts of an element that other content of its own window covers, such as a floating
/// pane over a tiled one.
///
/// Elements of the window that overlap the element and lie outside the element's own ancestors
/// are the candidates. A candidate is drawn at the bounds of its children, which leaves out a
/// margin that it can keep around its visible content.
///
/// With a stacking report, the report decides which content lies above the pane and the
/// accessibility tree decides where that content is drawn. The report's areas reach the screen
/// through the pane's own container: the highest ancestor of the element, below its window, with
/// the element's left, right and bottom edges, which takes in a title row that the terminal draws
/// above the screen. Each area is clipped to the window's layout area and then paired with at
/// most one candidate, and each candidate with at most one area, when all four edges agree within
/// a tolerance; the closest pairs win, and an area left over still pairs when another area can
/// move to a different candidate. An area without a drawn candidate, such as content that is not
/// drawn, makes no hole, and a candidate that no area explains, such as the content below the
/// pane, makes none either. When no area pairs although drawn content overlaps the element, the
/// container does not place the areas where the window draws them, and the hit test decides.
///
/// Without a report the application's own hit test decides: a candidate is above when the
/// frontmost element at one of a few points of the overlap belongs to it. That hit test can name
/// the wrong one of two overlapping candidates.
enum CoverScan {
    enum Result: Equatable {
        /// The covered parts, in accessibility coordinates and inside the element's frame.
        case covers([CGRect])
        /// The element is no longer among its ancestors' children: the application keeps the
        /// element but does not show it, for example while another element fills the window.
        case detached
    }

    /// Requests that one scan makes at most; a larger tree gives no result.
    static let requestLimit = 400
    static let depthLimit = 24
    /// Tallest title row above a terminal screen that the pane's container can add.
    static let titleRowLimit: CGFloat = 64
    /// Smallest tolerance in points for an edge of reported content, and the share of the
    /// window's layout size that the tolerance grows to on large windows.
    static let edgeTolerance: CGFloat = 6
    static let edgeShare: CGFloat = 0.015

    /// The requests that one scan may still make: at most `requestLimit`, and none after the
    /// caller's time is over.
    struct Budget {
        private(set) var requests = 0
        let expired: () -> Bool

        /// Counts one request; false when the scan must stop without a result.
        mutating func spend() -> Bool {
            requests += 1
            return requests <= CoverScan.requestLimit && !expired()
        }
    }

    /// Places fractions of a window's layout area on the screen, from the fractions and the
    /// screen rectangle of one pane.
    struct LayoutMapping {
        let origin: CGPoint
        /// The layout area's size in points.
        let size: CGSize

        init(pane: CGRect, screen: CGRect) {
            size = CGSize(width: screen.width / pane.width, height: screen.height / pane.height)
            origin = CGPoint(x: screen.minX - pane.minX * size.width, y: screen.minY - pane.minY * size.height)
        }

        func screenRect(_ area: CGRect) -> CGRect {
            CGRect(x: origin.x + area.minX * size.width, y: origin.y + area.minY * size.height, width: area.width * size.width, height: area.height * size.height)
        }

        var layoutArea: CGRect { screenRect(CGRect(x: 0, y: 0, width: 1, height: 1)) }

        var tolerance: CGSize {
            CGSize(width: max(CoverScan.edgeTolerance, CoverScan.edgeShare * size.width), height: max(CoverScan.edgeTolerance, CoverScan.edgeShare * size.height))
        }
    }

    /// The scan's result; nil when it did not complete within its budget.
    static func scan<Tree: AccessibilityTree>(_ tree: Tree, element: Tree.Node, frame: CGRect, window: Tree.Node, application: pid_t, stacking: StackingReport? = nil, expired: @escaping () -> Bool = { false }) -> Result? {
        var budget = Budget(expired: expired)
        var chain: [Tree.Node] = []
        var node = element
        while true {
            guard budget.spend(), chain.count < depthLimit, case .value(let parent) = tree.parent(node) else { return nil }
            chain.append(parent)
            if tree.same(parent, window) { break }
            node = parent
        }
        var candidates: [(node: Tree.Node, frame: CGRect)] = []
        for level in stride(from: chain.count - 1, through: 0, by: -1) {
            let below = level == 0 ? element : chain[level - 1]
            guard budget.spend(), case .value(let children) = tree.children(chain[level]) else { return nil }
            guard children.contains(where: { tree.same($0, below) }) else { return .detached }
            for child in children where !tree.same(child, below) {
                guard budget.spend() else { return nil }
                guard case .value(let rect) = tree.frame(child), overlaps(rect, frame) else { continue }
                candidates.append((child, rect))
            }
        }
        if let stacking {
            switch reported(tree, candidates, element: frame, ancestors: chain.dropLast(), stacking: stacking, budget: &budget) {
            case .decided(let result): return result
            case .unmapped: break
            }
        }
        return hitTested(tree, candidates, element: element, frame: frame, ancestors: chain, application: application, budget: &budget)
    }

    /// Covers by the application's hit test: a candidate is above when the frontmost element at
    /// one of its sample points belongs to it.
    static func hitTested<Tree: AccessibilityTree>(_ tree: Tree, _ candidates: [(node: Tree.Node, frame: CGRect)], element: Tree.Node, frame: CGRect, ancestors chain: [Tree.Node], application: pid_t, budget: inout Budget) -> Result? {
        var covers: [CGRect] = []
        for candidate in candidates {
            let overlap = candidate.frame.intersection(frame)
            var above = false
            for point in samplePoints(overlap) {
                guard budget.spend() else { return nil }
                guard case .value(let hit) = tree.element(at: point, in: application) else { continue }
                guard let inside = belongs(tree, hit, to: candidate.node, ours: chain + [element], budget: &budget) else { return nil }
                if inside {
                    above = true
                    break
                }
            }
            guard above else { continue }
            guard let bounds = contentBounds(tree, candidate.node, frame: candidate.frame, budget: &budget) else { return nil }
            let covered = bounds.intersection(frame)
            if overlaps(covered, frame) { covers.append(covered) }
        }
        return .covers(covers)
    }

    /// What the stacking report establishes.
    enum Reported {
        /// The scan's result, or nil when the budget ran out.
        case decided(Result?)
        /// No area pairs although drawn content overlaps the element: the pane's container does
        /// not place the areas where the window draws them.
        case unmapped
    }

    /// Covers by the stacking report. A report that places the pane in no layout, or lists an area
    /// over the whole pane, covers the whole frame.
    static func reported<Tree: AccessibilityTree>(_ tree: Tree, _ candidates: [(node: Tree.Node, frame: CGRect)], element frame: CGRect, ancestors: ArraySlice<Tree.Node>, stacking: StackingReport, budget: inout Budget) -> Reported {
        guard let pane = stacking.pane, pane.width > 0, pane.height > 0 else { return .decided(.covers([frame])) }
        if stacking.above.contains(where: { $0.insetBy(dx: -0.001, dy: -0.001).contains(pane) }) { return .decided(.covers([frame])) }
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        let inside = stacking.above.map { $0.intersection(whole) }.filter { !$0.isNull && $0.width > 0 && $0.height > 0 }
        guard !inside.isEmpty, !candidates.isEmpty else { return .decided(.covers([])) }
        guard let container = paneContainer(tree, element: frame, ancestors: ancestors, budget: &budget) else { return .decided(nil) }
        let mapping = LayoutMapping(pane: pane, screen: container)
        var bounds: [CGRect] = []
        for candidate in candidates {
            guard let content = contentBounds(tree, candidate.node, frame: candidate.frame, budget: &budget) else { return .decided(nil) }
            bounds.append(content)
        }
        let drawn = bounds.map { $0.intersection(mapping.layoutArea) }
        let paired = pairs(areas: inside.map(mapping.screenRect), drawn: drawn, tolerance: mapping.tolerance)
        if paired.isEmpty, bounds.contains(where: { overlaps($0, frame) }) { return .unmapped }
        let covers = paired.compactMap { pair -> CGRect? in
            let covered = drawn[pair.candidate].intersection(frame)
            return overlaps(covered, frame) ? covered : nil
        }
        return .decided(.covers(covers))
    }

    /// The pane's own container: the highest ancestor that keeps the element's left, right and
    /// bottom edges and adds at most a title row above it; the element's frame when no ancestor
    /// does. `ancestors` runs from the parent upwards and leaves out the window.
    static func paneContainer<Tree: AccessibilityTree>(_ tree: Tree, element frame: CGRect, ancestors: ArraySlice<Tree.Node>, budget: inout Budget) -> CGRect? {
        var container = frame
        for ancestor in ancestors {
            guard budget.spend() else { return nil }
            guard case .value(let rect) = tree.frame(ancestor),
                  abs(rect.minX - frame.minX) <= 1, abs(rect.maxX - frame.maxX) <= 1, abs(rect.maxY - frame.maxY) <= 1,
                  rect.minY <= frame.minY + 1, frame.minY - rect.minY <= titleRowLimit
            else { break }
            container = rect
        }
        return container
    }

    /// Pairs reported areas with drawn candidates, both in screen coordinates: each area with at
    /// most one candidate and each candidate with at most one area, when every edge agrees within
    /// the tolerance. Closer pairs win; ties keep the report's order. An area that the closest
    /// pairs leave without a candidate then takes a free candidate, or one whose area can move to
    /// another valid candidate, so no area loses a pairing that a one-to-one choice allows.
    /// The result runs in the report's order.
    static func pairs(areas: [CGRect], drawn: [CGRect], tolerance: CGSize) -> [(area: Int, candidate: Int)] {
        var choices: [[(distance: CGFloat, candidate: Int)]] = Array(repeating: [], count: areas.count)
        var options: [(distance: CGFloat, area: Int, candidate: Int)] = []
        for (areaIndex, area) in areas.enumerated() {
            for (candidateIndex, bounds) in drawn.enumerated() where !bounds.isNull {
                let horizontal = [abs(area.minX - bounds.minX), abs(area.maxX - bounds.maxX)]
                let vertical = [abs(area.minY - bounds.minY), abs(area.maxY - bounds.maxY)]
                guard horizontal.allSatisfy({ $0 <= tolerance.width }), vertical.allSatisfy({ $0 <= tolerance.height }) else { continue }
                let distance = (horizontal + vertical).reduce(0, +)
                options.append((distance, areaIndex, candidateIndex))
                choices[areaIndex].append((distance, candidateIndex))
            }
        }
        options.sort { ($0.distance, $0.area, $0.candidate) < ($1.distance, $1.area, $1.candidate) }
        for index in choices.indices { choices[index].sort { ($0.distance, $0.candidate) < ($1.distance, $1.candidate) } }
        var candidateOf: [Int: Int] = [:]
        var areaOf: [Int: Int] = [:]
        for option in options where candidateOf[option.area] == nil && areaOf[option.candidate] == nil {
            candidateOf[option.area] = option.candidate
            areaOf[option.candidate] = option.area
        }
        // Gives `area` a candidate, moving paired areas to other candidates where needed.
        func place(_ area: Int, visited: inout Set<Int>) -> Bool {
            for choice in choices[area] where !visited.contains(choice.candidate) {
                visited.insert(choice.candidate)
                if let holder = areaOf[choice.candidate], !place(holder, visited: &visited) { continue }
                candidateOf[area] = choice.candidate
                areaOf[choice.candidate] = area
                return true
            }
            return false
        }
        let unpaired = areas.indices.filter { candidateOf[$0] == nil && !choices[$0].isEmpty }
            .sorted { (choices[$0][0].distance, $0) < (choices[$1][0].distance, $1) }
        for area in unpaired {
            var visited = Set<Int>()
            _ = place(area, visited: &visited)
        }
        return candidateOf.sorted { $0.key < $1.key }.map { (area: $0.key, candidate: $0.value) }
    }

    static func overlaps(_ rect: CGRect, _ frame: CGRect) -> Bool {
        let overlap = rect.intersection(frame)
        return !overlap.isNull && overlap.width >= 1 && overlap.height >= 1
    }

    /// The centre of the overlap and the centres of its quarters, so that a candidate partly
    /// under another candidate is still tested where it shows.
    static func samplePoints(_ rect: CGRect) -> [CGPoint] {
        let quarter = CGSize(width: rect.width / 4, height: rect.height / 4)
        return [
            CGPoint(x: rect.midX, y: rect.midY),
            CGPoint(x: rect.minX + quarter.width, y: rect.minY + quarter.height),
            CGPoint(x: rect.maxX - quarter.width, y: rect.minY + quarter.height),
            CGPoint(x: rect.minX + quarter.width, y: rect.maxY - quarter.height),
            CGPoint(x: rect.maxX - quarter.width, y: rect.maxY - quarter.height),
        ]
    }

    /// Whether `hit` is the candidate or lies inside it; nil when the budget ran out. Reaching
    /// the element or one of its ancestors first means the point shows the element's own branch.
    static func belongs<Tree: AccessibilityTree>(_ tree: Tree, _ hit: Tree.Node, to candidate: Tree.Node, ours: [Tree.Node], budget: inout Budget) -> Bool? {
        var node = hit
        for _ in 0 ..< depthLimit {
            if tree.same(node, candidate) { return true }
            if ours.contains(where: { tree.same($0, node) }) { return false }
            guard budget.spend() else { return nil }
            guard case .value(let parent) = tree.parent(node) else { return false }
            node = parent
        }
        return false
    }

    /// The union of the candidate's children's frames inside its own frame, or its frame when it
    /// has no children; nil when the budget ran out.
    static func contentBounds<Tree: AccessibilityTree>(_ tree: Tree, _ node: Tree.Node, frame: CGRect, budget: inout Budget) -> CGRect? {
        guard budget.spend() else { return nil }
        guard case .value(let children) = tree.children(node), !children.isEmpty else { return frame }
        var bounds = CGRect.null
        for child in children {
            guard budget.spend() else { return nil }
            if case .value(let rect) = tree.frame(child) { bounds = bounds.union(rect.intersection(frame)) }
        }
        return bounds.isNull ? frame : bounds
    }
}

/// The part of a rectangle that holes leave visible. The reader window's mask and the decision to
/// hide a fully covered window both use it, so they never disagree.
public enum CoverRegion {
    /// Rectangles that do not overlap and together form `frame` without the holes, which can
    /// overlap one another.
    public static func visible(_ frame: CGRect, holes: [CGRect]) -> [CGRect] {
        let clipped = holes.map { $0.intersection(frame) }.filter { !$0.isNull && $0.width > 0 && $0.height > 0 }
        guard !clipped.isEmpty else { return frame.isEmpty ? [] : [frame] }
        let xs = Set([frame.minX, frame.maxX] + clipped.flatMap { [$0.minX, $0.maxX] }).sorted()
        let ys = Set([frame.minY, frame.maxY] + clipped.flatMap { [$0.minY, $0.maxY] }).sorted()
        var result: [CGRect] = []
        for row in 0 ..< ys.count - 1 {
            let top = ys[row], bottom = ys[row + 1]
            var start: CGFloat?
            for column in 0 ..< xs.count - 1 {
                let centre = CGPoint(x: (xs[column] + xs[column + 1]) / 2, y: (top + bottom) / 2)
                let covered = clipped.contains { $0.contains(centre) }
                if !covered, start == nil { start = xs[column] }
                if covered, let left = start {
                    result.append(CGRect(x: left, y: top, width: xs[column] - left, height: bottom - top))
                    start = nil
                }
            }
            if let left = start { result.append(CGRect(x: left, y: top, width: xs[xs.count - 1] - left, height: bottom - top)) }
        }
        return result.filter { $0.width > 0 && $0.height > 0 }
    }

    /// Whether the holes leave nothing of `frame` visible but strips thinner than a point.
    public static func coversEntirely(_ frame: CGRect, holes: [CGRect]) -> Bool {
        visible(frame, holes: holes).allSatisfy { $0.width < 1 || $0.height < 1 }
    }
}

/// The accessibility interface of the running applications. Each request waits at most for the
/// messaging timeout that `TerminalAnchor.start` sets.
struct LiveTree: AccessibilityTree {
    func windows(_ application: pid_t) -> Reply<[AXUIElement]> {
        array(AXUIElementCreateApplication(application), kAXWindowsAttribute)
    }

    func role(_ node: AXUIElement) -> Reply<String> {
        map(read(node, kAXRoleAttribute)) { $0 as? String }
    }

    func children(_ node: AXUIElement) -> Reply<[AXUIElement]> {
        array(node, kAXChildrenAttribute)
    }

    func parent(_ node: AXUIElement) -> Reply<AXUIElement> {
        map(read(node, kAXParentAttribute)) { Self.element($0) }
    }

    func frame(_ node: AXUIElement) -> Reply<CGRect> {
        map(read(node, "AXFrame")) { Self.rect($0) }
    }

    func visibleText(_ node: AXUIElement, limit: Int) -> Reply<String> {
        var range = CFRange()
        switch read(node, kAXVisibleCharacterRangeAttribute) {
        case .value(let value):
            guard CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetValue(value as! AXValue, .cfRange, &range) else { return .missing }
        case .missing: return .missing
        case .busy: return .busy
        }
        var bounded = CFRange(location: range.location, length: min(range.length, limit))
        guard bounded.length > 0, let parameter = AXValueCreate(.cfRange, &bounded) else { return .missing }
        var result: CFTypeRef?
        switch AXUIElementCopyParameterizedAttributeValue(node, kAXStringForRangeParameterizedAttribute as CFString, parameter, &result) {
        case .success: return (result as? String).map(Reply.value) ?? .missing
        case .cannotComplete: return .busy
        default: return .missing
        }
    }

    func element(at point: CGPoint, in application: pid_t) -> Reply<AXUIElement> {
        var result: AXUIElement?
        let error = AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(application), Float(point.x), Float(point.y), &result)
        switch error {
        case .success: return result.map(Reply.value) ?? .missing
        case .cannotComplete: return .busy
        default: return .missing
        }
    }

    func same(_ first: AXUIElement, _ second: AXUIElement) -> Bool {
        CFEqual(first, second)
    }

    func read(_ node: AXUIElement, _ name: String) -> Reply<CFTypeRef> {
        var result: CFTypeRef?
        return Self.reply(AXUIElementCopyAttributeValue(node, name as CFString, &result), result)
    }

    static func reply(_ error: AXError, _ result: CFTypeRef?) -> Reply<CFTypeRef> {
        switch error {
        case .success: result.map(Reply.value) ?? .missing
        case .cannotComplete: .busy
        default: .missing
        }
    }

    private func array(_ node: AXUIElement, _ name: String) -> Reply<[AXUIElement]> {
        map(read(node, name)) { $0 as? [AXUIElement] }
    }

    private func map<Value>(_ reply: Reply<CFTypeRef>, _ transform: (CFTypeRef) -> Value?) -> Reply<Value> {
        switch reply {
        case .value(let value): transform(value).map(Reply.value) ?? .missing
        case .missing: .missing
        case .busy: .busy
        }
    }

    static func element(_ value: CFTypeRef) -> AXUIElement? {
        CFGetTypeID(value) == AXUIElementGetTypeID() ? (value as! AXUIElement) : nil
    }

    static func rect(_ value: CFTypeRef) -> CGRect? {
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        return AXValueGetValue(value as! AXValue, .cgRect, &rect) ? rect : nil
    }
}
