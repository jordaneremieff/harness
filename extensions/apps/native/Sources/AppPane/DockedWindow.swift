import AppKit
import ApplicationServices
import AppPaneCore

/// Reads and moves one window of another application through Accessibility. Frames use the
/// Accessibility coordinates: origin at the top left of the primary screen, y downwards.
@MainActor
final class DockedWindow {
    let pid: pid_t
    let element: AXUIElement
    /// The pane opened this window, so closing the pane closes it.
    let created: Bool
    /// Where the window was before the pane took it; it returns there when the pane closes.
    let original: CGRect
    private(set) var number: CGWindowID?
    /// The pane's frame that the window was last asked to fill.
    private(set) var target: CGRect?
    /// The frame that the window confirmed for the target: the target itself, or a frame of its
    /// own at the target's place when the application keeps a minimum size. Nil until the window
    /// confirms a request.
    private(set) var accepted: CGRect?
    /// Whether `accepted` is the target or a confirmed size limit, rather than the frame that the
    /// window kept after the application stopped taking requests.
    private var settled = false
    /// The window's frame when the target changed. A window that keeps that size is not showing
    /// a size limit of its own; the request did not reach it.
    private var before: CGRect?
    /// Requests for the current target that the window answered without taking it.
    private var attempts = 0
    /// Ticks since the requests reached `attemptLimit`.
    private var waits = 0
    /// The point where a parked window waits.
    private var parking: CGPoint?
    private(set) var parked = false
    /// Requests after which the pane shows the window where it is and asks only every
    /// `slowInterval` ticks.
    static let attemptLimit = 8
    static let slowInterval = 8

    init(pid: pid_t, element: AXUIElement, created: Bool) {
        self.pid = pid
        self.element = element
        self.created = created
        original = Self.frame(of: element) ?? .zero
    }

    /// Finds the window-server number once the window fills its pane, a frame that no other
    /// window of the application has. The window server can report the new frame a moment after
    /// the move, so a caller tries again later when this returns false.
    func findNumber() -> Bool {
        guard number == nil, !parked, let accepted else { return number != nil }
        number = Self.windowNumber(pid: pid, frame: accepted)
        return number != nil
    }

    /// One read of the window's frame.
    enum Reading: Equatable {
        case frame(CGRect)
        /// The application did not answer in time; ask again later.
        case busy
        /// The window no longer exists.
        case gone
    }

    func read() -> Reading {
        var position: CFTypeRef?
        switch AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position) {
        case .success: break
        case .invalidUIElement: return .gone
        default: return .busy
        }
        var size: CFTypeRef?
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
              let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID(),
              AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &extent)
        else { return .busy }
        return .frame(CGRect(origin: origin, size: extent))
    }

    var title: String { Self.string(element, kAXTitleAttribute) ?? "" }
    var frame: CGRect? { Self.frame(of: element) }
    var fullScreen: Bool { Self.bool(element, "AXFullScreen") }
    var minimized: Bool { Self.bool(element, kAXMinimizedAttribute) }

    /// Fills the pane, given in AppKit coordinates. A window in full screen or minimised keeps
    /// the target until it returns.
    func dock(to pane: CGRect, primaryHeight: CGFloat) {
        let wanted = Geometry.accessibilityRect(Geometry.snapped(pane), primaryHeight: primaryHeight)
        let wasParked = parked
        parked = false
        parking = nil
        guard wanted != target || wasParked else { return }
        before = frame
        target = wanted
        accepted = nil
        settled = false
        attempts = 0
        waits = 0
        guard !fullScreen, !minimized else { return }
        place(wanted)
    }

    /// Keeps the window on its pane, given its `current` frame: a window that moved, for example
    /// after a drag of its title bar, goes back once no mouse button is down, and a request that
    /// the application did not carry out is made again. A size limit counts once two requests
    /// end at the pane's place with a size larger than the pane and other than the window's size
    /// before. After `attemptLimit` requests the pane shows the window where it is and asks
    /// again every `slowInterval` ticks. Returns whether the frame that the pane shows changed.
    func keepDocked(_ current: CGRect) -> Bool {
        guard !parked, let target, NSEvent.pressedMouseButtons == 0 else { return false }
        if settled, let accepted, Geometry.close(current, accepted) { return false }
        let changed = accepted.map { !Geometry.close($0, current) } ?? true
        switch Docking.check(current, target: target) {
        case .filled:
            accepted = current
            settled = true
            attempts = 0
            return changed
        case .limited where Docking.limitConfirmed(current, target: target, before: before, requests: attempts):
            accepted = current
            settled = true
            return changed
        case .limited, .missed:
            break
        }
        if attempts >= Self.attemptLimit {
            if changed {
                paneLog.notice("The window keeps \(Int(current.width), privacy: .public)x\(Int(current.height), privacy: .public) instead of \(Int(target.width), privacy: .public)x\(Int(target.height), privacy: .public).")
                accepted = current
            }
            waits += 1
            guard waits % Self.slowInterval == 0 else { return changed }
        }
        guard !fullScreen, !minimized else { return changed }
        place(target)
        return true
    }


    /// Moves the window out of sight while its pane is not on screen, including before the pane
    /// first appears.
    func park(primaryHeight: CGFloat) {
        guard !parked, !fullScreen, !minimized else { return }
        let current = frame
        // The window can be larger than its pane, so the corner must fit its own size.
        let size = current?.size ?? target?.size ?? CGSize(width: 800, height: 600)
        let screens = NSScreen.screens.map { Geometry.accessibilityRect($0.frame, primaryHeight: primaryHeight) }
        let near = target ?? current ?? .zero
        guard let origin = Geometry.parkingOrigin(size: size, near: near, screens: screens)
            ?? screens.first.map({ CGPoint(x: $0.maxX - 1, y: $0.maxY - 1) }) else { return }
        parked = true
        parking = origin
        move(to: origin)
    }

    /// Sends a parked window back to its parking point when it moved, for example because the
    /// application restored its own position, once no mouse button is down.
    func keepParked(_ current: CGRect) {
        guard parked, let parking, NSEvent.pressedMouseButtons == 0,
              abs(current.minX - parking.x) > 1 || abs(current.minY - parking.y) > 1, !fullScreen, !minimized else { return }
        move(to: parking)
    }

    /// Brings the window in front of the application's other windows and makes it the main
    /// window, then makes the application active, so the keyboard reaches this window.
    func activate() {
        AXUIElementPerformAction(element, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
        NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    }

    /// Returns a borrowed window to its earlier frame. The pane releases an owned browser
    /// window by scripting ID, independently of which Accessibility window it found.
    func restore() {
        guard !created, read() != .gone, !fullScreen else { return }
        place(original)
    }

    /// Asks the application to give the window `rect`, and records the frame when the window
    /// takes it at once. An application that applies the request later, or not at all, leaves
    /// the confirmation to `keepDocked`.
    private func place(_ rect: CGRect) {
        attempts += 1
        var origin = rect.origin
        var size = rect.size
        // Moving first lets the new size fit on the screen; moving again corrects an origin that
        // the application adjusted for its old size.
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) }
        if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, value) }
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) }
        if case .frame(let frame) = read(), Docking.check(frame, target: rect) == .filled {
            accepted = frame
            settled = true
            attempts = 0
        }
        _ = findNumber()
    }

    private func move(to point: CGPoint) {
        var origin = point
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) }
    }

    // MARK: - Accessibility values

    static func frame(of element: AXUIElement) -> CGRect? {
        var position: CFTypeRef?
        var size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
              let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        return CGRect(origin: origin, size: extent)
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    static func bool(_ element: AXUIElement, _ attribute: String) -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return false }
        return (value as? Bool) ?? false
    }

    static func windowList(of pid: pid_t) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &value) == .success else { return nil }
        return value as? [AXUIElement]
    }

    static func windows(of pid: pid_t) -> [AXUIElement] { windowList(of: pid) ?? [] }

    static func element(_ application: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, attribute as CFString, &value) == .success, let value,
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    /// The window-server number of the application's only window at this frame; nil when several
    /// windows share it, as a new browser window does when it opens over another one. Titles do
    /// not decide, because pages change them at any moment. A docked window has its pane's frame,
    /// which no other window of the application shares. Window-server bounds use the
    /// Accessibility coordinates.
    static func windowNumber(pid: pid_t, frame: CGRect) -> CGWindowID? {
        let records = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let matches = records.filter { record in
            guard (record[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
                  (record[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = record[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
            return Geometry.close(rect, frame)
        }
        guard matches.count == 1 else { return nil }
        return (matches[0][kCGWindowNumber as String] as? Int).map(CGWindowID.init)
    }
}
