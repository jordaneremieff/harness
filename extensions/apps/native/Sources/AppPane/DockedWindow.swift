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
    /// The frame that the window took after that request; it can differ from the target when the
    /// application keeps a minimum size.
    private(set) var accepted: CGRect?
    private(set) var parked = false

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

    var title: String { Self.string(element, kAXTitleAttribute) ?? "" }
    var frame: CGRect? { Self.frame(of: element) }
    var exists: Bool {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) != .invalidUIElement
    }
    var fullScreen: Bool { Self.bool(element, "AXFullScreen") }
    var minimized: Bool { Self.bool(element, kAXMinimizedAttribute) }

    /// Fills the pane, given in AppKit coordinates.
    func dock(to pane: CGRect, primaryHeight: CGFloat) {
        let wanted = Geometry.accessibilityRect(Geometry.snapped(pane), primaryHeight: primaryHeight)
        let wasParked = parked
        parked = false
        if target == wanted, !wasParked, let accepted, let current = frame, Geometry.close(current, accepted) { return }
        target = wanted
        place(wanted)
    }

    /// Puts the window back in its pane when it moved, for example after a drag of its title bar,
    /// once no mouse button is down. A window in full screen or minimised stays as it is.
    func keepDocked() {
        guard !parked, let target, let accepted, NSEvent.pressedMouseButtons == 0, !fullScreen, !minimized,
              let current = frame, !Geometry.close(current, accepted) else { return }
        place(target)
    }

    /// Moves the window out of sight while its pane is not on screen, including before the pane
    /// first appears.
    func park(primaryHeight: CGFloat) {
        guard !parked, !fullScreen, !minimized else { return }
        let place = target ?? frame ?? .zero
        let screen = (NSScreen.screens.first { Geometry.accessibilityRect($0.frame, primaryHeight: primaryHeight).intersects(place) } ?? NSScreen.main)?.frame
        guard let screen else { return }
        parked = true
        var origin = Geometry.parkingOrigin(screen: screen, primaryHeight: primaryHeight)
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) }
    }

    /// Brings the window in front of the application's other windows and makes it the main
    /// window, then makes the application active, so the keyboard reaches this window.
    func activate() {
        AXUIElementPerformAction(element, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
        NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    }

    /// Closes a window that the pane opened, or returns a window that it took to its earlier frame.
    func release() {
        guard exists else { return }
        if created {
            var button: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXCloseButtonAttribute as CFString, &button) == .success, let button {
                AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
            }
        } else if !fullScreen {
            place(original)
        }
    }

    private func place(_ rect: CGRect) {
        var origin = rect.origin
        var size = rect.size
        // Moving first lets the new size fit on the screen; moving again corrects an origin that
        // the application adjusted for its old size.
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) }
        if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, value) }
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) }
        accepted = frame ?? rect
        _ = findNumber()
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

    static func windows(of pid: pid_t) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &value) == .success else { return [] }
        return (value as? [AXUIElement]) ?? []
    }

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
