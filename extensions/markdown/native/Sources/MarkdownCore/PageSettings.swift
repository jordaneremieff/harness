import Foundation

/// Reading settings that the page applies without replacing the document or its history.
public struct PageSettings: Sendable, Equatable, Codable {
    public static let textSizes = [13, 14, 15, 16, 17, 18, 20, 22, 24, 27]
    public static let defaultTextSize = 4

    /// The page uses a multiplier of its 16-pixel base; durable settings keep the selected index.
    public static var textSizeMultipliers: [Double] { textSizes.map { Double($0) / 16 } }
    public var textSizeMultiplier: Double { Double(Self.textSizes[min(max(textSize, 0), Self.textSizes.count - 1)]) / 16 }

    /// A midpoint selects the smaller step. Non-finite input leaves the default step selected.
    public static func nearestTextSize(to multiplier: Double) -> Int {
        guard multiplier.isFinite else { return defaultTextSize }
        let steps = textSizeMultipliers
        if multiplier <= steps[0] { return 0 }
        if multiplier >= steps[steps.count - 1] { return steps.count - 1 }
        var nearest = 0
        for index in steps.indices.dropFirst() where abs(steps[index] - multiplier) < abs(steps[nearest] - multiplier) {
            nearest = index
        }
        return nearest
    }

    public var textSize: Int
    public var wrapCode: Bool

    public init(textSize: Int = PageSettings.defaultTextSize, wrapCode: Bool = false) {
        self.textSize = min(max(textSize, 0), PageSettings.textSizes.count - 1)
        self.wrapCode = wrapCode
    }
}
