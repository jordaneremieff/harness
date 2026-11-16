import Foundation

/// The preferred proportion survives compact layouts and temporary width constraints.
public struct OutlineLayout: Equatable, Sendable {
    public static let compactWidth: CGFloat = 640
    public static let dividerWidth: CGFloat = 8
    public static let minimumOutlineWidth: CGFloat = 160
    public static let minimumDocumentWidth: CGFloat = 360
    public private(set) var fraction: CGFloat = 0.24

    public init() {}

    public func isCompact(in width: CGFloat) -> Bool { width < Self.compactWidth }

    public func outlineWidth(in width: CGFloat) -> CGFloat {
        let available = max(0, width - Self.minimumDocumentWidth - Self.dividerWidth)
        return min(available, max(Self.minimumOutlineWidth, width * fraction))
    }

    public mutating func resize(to requestedWidth: CGFloat, in width: CGFloat) {
        guard width.isFinite, width >= Self.compactWidth, requestedWidth.isFinite else { return }
        let available = width - Self.minimumDocumentWidth - Self.dividerWidth
        fraction = min(available, max(Self.minimumOutlineWidth, requestedWidth)) / width
    }

    public mutating func reset() { fraction = 0.24 }
}
