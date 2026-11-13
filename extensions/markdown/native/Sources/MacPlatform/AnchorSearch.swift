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
/// step continues the tree walk where the previous step stopped. An application with a large tree
/// or one that answers slowly therefore delays a round but never keeps the round from reaching the
/// next application. A round leaves an application after a node budget or after repeated
/// requests without an answer.
struct AnchorSearch<Tree: AccessibilityTree> {
    struct Found {
        var element: Tree.Node
        var window: Tree.Node
        var application: pid_t
    }

    /// Nodes of one application that one round visits.
    static var nodeBudget: Int { 2500 }
    /// Deepest level of an application's tree that a round visits.
    static var depthLimit: Int { 24 }
    /// Requests of one application without an answer before the round leaves that application.
    static var busyLimit: Int { 2 }
    /// Characters of a text area's visible text that a search reads.
    static var textLimit: Int { 512 }
    /// Roles whose subtrees hold documents, lists or menus rather than terminals.
    static var skippedRoles: Set<String> { ["AXWebArea", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXMenuBar", "AXMenu"] }

    private(set) var applications: [pid_t] = []
    private(set) var index = 0
    private var windows: [Tree.Node]?
    private var windowIndex = 0
    private var queue: [(node: Tree.Node, depth: Int)] = []
    private var queueIndex = 0
    private var visited = 0
    private var busy = 0

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
    /// that the step's time is over. After a found element the next call continues behind it.
    mutating func run(_ tree: Tree, marker: String, expired: () -> Bool) -> Found? {
        while index < applications.count {
            if expired() { return nil }
            let application = applications[index]
            guard let windows = loadWindows(tree, application) else { continue }
            if queueIndex >= queue.count {
                guard windowIndex < windows.count, visited < Self.nodeBudget else {
                    leaveApplication()
                    continue
                }
                queue = [(windows[windowIndex], 0)]
                queueIndex = 0
                windowIndex += 1
            }
            let (node, depth) = queue[queueIndex]
            queueIndex += 1
            visited += 1
            if let found = visit(tree, node: node, depth: depth, window: windows[windowIndex - 1], application: application, marker: marker) {
                return found
            }
        }
        return nil
    }

    /// The application's windows, read once per round; nil while the request goes unanswered.
    private mutating func loadWindows(_ tree: Tree, _ application: pid_t) -> [Tree.Node]? {
        if let windows { return windows }
        switch tree.windows(application) {
        case .value(let list):
            windows = list
            return list
        case .missing:
            leaveApplication()
            return nil
        case .busy:
            noteBusy()
            return nil
        }
    }

    private mutating func visit(_ tree: Tree, node: Tree.Node, depth: Int, window: Tree.Node, application: pid_t, marker: String) -> Found? {
        let role: String
        switch tree.role(node) {
        case .value(let value): role = value
        case .missing: return nil
        case .busy:
            noteBusy()
            return nil
        }
        if role == kAXTextAreaRole {
            switch tree.visibleText(node, limit: Self.textLimit) {
            case .value(let text) where Self.shows(marker, text):
                return Found(element: node, window: window, application: application)
            case .busy: noteBusy()
            default: break
            }
            return nil
        }
        guard !Self.skippedRoles.contains(role), depth < Self.depthLimit else { return nil }
        switch tree.children(node) {
        case .value(let children):
            for child in children where queue.count < Self.nodeBudget { queue.append((child, depth + 1)) }
        case .busy: noteBusy()
        case .missing: break
        }
        return nil
    }

    private mutating func noteBusy() {
        busy += 1
        if busy >= Self.busyLimit { leaveApplication() }
    }

    private mutating func leaveApplication() {
        index += 1
        resetApplication()
    }

    private mutating func resetApplication() {
        windows = nil
        windowIndex = 0
        queue = []
        queueIndex = 0
        visited = 0
        busy = 0
    }
}

/// Finds the parts of an element that other content of its own window covers, such as a floating
/// pane over a tiled one.
///
/// Elements of the window that overlap the element and are not among its ancestors are the
/// candidates. A candidate covers the bounds of its children, which leaves out a margin that it
/// keeps around its visible content. Which candidates lie above the element comes from a stacking
/// report when the terminal offers one: a candidate is above when its bounds, placed in the
/// report's layout coordinates, match an area that the report lists above the pane. Without a
/// report the application's own hit test decides: a candidate is above when the frontmost element
/// at a point of the overlap belongs to it. That hit test can name the wrong one of two
/// overlapping candidates.
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
    /// Smallest overlap, as intersection over union, at which a candidate matches an area of a
    /// stacking report.
    static let matchLimit = 0.5

    /// The scan's result; nil when it did not complete.
    static func scan<Tree: AccessibilityTree>(_ tree: Tree, element: Tree.Node, frame: CGRect, window: Tree.Node, application: pid_t, stacking: StackingReport? = nil) -> Result? {
        var requests = 0
        var chain: [Tree.Node] = []
        var node = element
        while true {
            requests += 1
            guard chain.count < depthLimit, case .value(let parent) = tree.parent(node) else { return nil }
            chain.append(parent)
            if tree.same(parent, window) { break }
            node = parent
        }
        var candidates: [(node: Tree.Node, frame: CGRect)] = []
        for level in stride(from: chain.count - 1, through: 0, by: -1) {
            let below = level == 0 ? element : chain[level - 1]
            requests += 1
            guard case .value(let children) = tree.children(chain[level]) else { return nil }
            guard children.contains(where: { tree.same($0, below) }) else { return .detached }
            for child in children where !tree.same(child, below) {
                requests += 1
                guard requests <= requestLimit else { return nil }
                guard case .value(let rect) = tree.frame(child), overlaps(rect, frame) else { continue }
                candidates.append((child, rect))
            }
        }
        if let stacking { return classify(tree, candidates, frame: frame, stacking: stacking, requests: &requests) }
        var covers: [CGRect] = []
        for candidate in candidates {
            let overlap = candidate.frame.intersection(frame)
            var above = false
            for point in samplePoints(overlap) {
                requests += 1
                guard requests <= requestLimit else { return nil }
                guard case .value(let hit) = tree.element(at: point, in: application) else { continue }
                if belongs(tree, hit, to: candidate.node, ours: chain + [element], requests: &requests) {
                    above = true
                    break
                }
            }
            guard above else { continue }
            let bounds = contentBounds(tree, candidate.node, frame: candidate.frame, requests: &requests).intersection(frame)
            if overlaps(bounds, frame) { covers.append(bounds) }
        }
        return .covers(covers)
    }

    /// Covers by the stacking report. A report that places the pane in no shown layout, or lists an
    /// area over the whole pane, covers the whole frame.
    static func classify<Tree: AccessibilityTree>(_ tree: Tree, _ candidates: [(node: Tree.Node, frame: CGRect)], frame: CGRect, stacking: StackingReport, requests: inout Int) -> Result {
        guard let pane = stacking.pane, pane.width > 0, pane.height > 0 else { return .covers([frame]) }
        if stacking.above.contains(where: { $0.insetBy(dx: -0.001, dy: -0.001).contains(pane) }) { return .covers([frame]) }
        var covers: [CGRect] = []
        for candidate in candidates {
            let bounds = contentBounds(tree, candidate.node, frame: candidate.frame, requests: &requests)
            let placed = layoutRect(bounds, frame: frame, pane: pane)
            guard stacking.above.contains(where: { match($0, placed) >= matchLimit }) else { continue }
            let covered = bounds.intersection(frame)
            if overlaps(covered, frame) { covers.append(covered) }
        }
        return .covers(covers)
    }

    /// A screen rectangle in the report's layout coordinates. The element's frame gives the scale:
    /// its width and its left and bottom edges are the pane's. A title row that the terminal draws
    /// above the screen makes the vertical scale slightly smaller than true, which matching by
    /// overlap tolerates.
    static func layoutRect(_ rect: CGRect, frame: CGRect, pane: CGRect) -> CGRect {
        let scaleX = frame.width / pane.width
        let scaleY = frame.height / pane.height
        let originX = frame.minX - pane.minX * scaleX
        let originY = frame.maxY - pane.maxY * scaleY
        return CGRect(x: (rect.minX - originX) / scaleX, y: (rect.minY - originY) / scaleY, width: rect.width / scaleX, height: rect.height / scaleY)
    }

    /// Intersection over union of two rectangles.
    static func match(_ first: CGRect, _ second: CGRect) -> Double {
        let common = first.intersection(second)
        guard !common.isNull else { return 0 }
        let shared = common.width * common.height
        let union = first.width * first.height + second.width * second.height - shared
        return union > 0 ? shared / union : 0
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

    /// Whether `hit` is the candidate or lies inside it. Reaching the element or one of its
    /// ancestors first means the point shows the element's own branch.
    static func belongs<Tree: AccessibilityTree>(_ tree: Tree, _ hit: Tree.Node, to candidate: Tree.Node, ours: [Tree.Node], requests: inout Int) -> Bool {
        var node = hit
        for _ in 0 ..< depthLimit {
            if tree.same(node, candidate) { return true }
            if ours.contains(where: { tree.same($0, node) }) { return false }
            requests += 1
            guard case .value(let parent) = tree.parent(node) else { return false }
            node = parent
        }
        return false
    }

    /// The union of the candidate's children's frames inside its own frame, or its frame when it
    /// has no children.
    static func contentBounds<Tree: AccessibilityTree>(_ tree: Tree, _ node: Tree.Node, frame: CGRect, requests: inout Int) -> CGRect {
        requests += 1
        guard case .value(let children) = tree.children(node), !children.isEmpty else { return frame }
        var bounds = CGRect.null
        for child in children {
            requests += 1
            if case .value(let rect) = tree.frame(child) { bounds = bounds.union(rect.intersection(frame)) }
        }
        return bounds.isNull ? frame : bounds
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
