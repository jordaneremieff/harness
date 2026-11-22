import AppKit

/// Page zoom for the Explorer pane. The host applies a level through `WKWebView.pageZoom`, which scales and
/// reflows the whole page as browser zoom does, and stores it with the page settings.
enum ExplorerZoom {
    static let levels: [Double] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
    static let range = 0.5...3.0
    /// Accumulated trackpad magnification that moves one level.
    static let pinchStep = 0.18

    enum Step: String, Sendable { case zoomIn = "in", zoomOut = "out", reset }

    static func next(_ current: Double, _ step: Step) -> Double {
        switch step {
        case .reset: return 1
        case .zoomIn: return levels.first { $0 > current + 0.001 } ?? levels[levels.count - 1]
        case .zoomOut: return levels.last { $0 < current - 0.001 } ?? levels[0]
        }
    }

    /// Command-= and Command-+ zoom in, Command-- zooms out, and Command-0 restores the actual size.
    /// Shift is allowed because many layouts type + with it; Option and Control are not.
    static func step(for event: NSEvent) -> Step? {
        guard event.type == .keyDown else { return nil }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.shift, .numericPad, .function, .capsLock])
        guard flags == .command, let key = event.charactersIgnoringModifiers else { return nil }
        switch key {
        case "=", "+": return .zoomIn
        case "-", "_": return .zoomOut
        case "0": return .reset
        default: return nil
        }
    }

    /// Turns trackpad magnification into whole level steps. A gesture keeps its remainder until it ends.
    struct Pinch {
        private var pending = 0.0

        mutating func steps(_ magnification: Double, phase: NSEvent.Phase) -> [Step] {
            if phase.contains(.began) { pending = 0 }
            pending += magnification
            var result: [Step] = []
            while pending >= ExplorerZoom.pinchStep { result.append(.zoomIn); pending -= ExplorerZoom.pinchStep }
            while pending <= -ExplorerZoom.pinchStep { result.append(.zoomOut); pending += ExplorerZoom.pinchStep }
            if !phase.isDisjoint(with: [.ended, .cancelled]) { pending = 0 }
            return result
        }
    }
}
