import Foundation

/// An exact patch against one immutable source generation. Offsets count UTF-16 code units.
public struct MarkdownSourceEdit: Sendable {
    public let range: NSRange
    public let expected: String
    public let replacement: String
    public init(range: NSRange, expected: String, replacement: String) {
        self.range = range; self.expected = expected; self.replacement = replacement
    }
}
