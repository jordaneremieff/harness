import AppKit
import Testing
@testable import Editor

@MainActor
struct TextSyntaxWarmupTests {
    @Test(.timeLimit(.minutes(1))) func opensAColdFarViewportWithoutScanningThePrefixSynchronously() async throws {
        let line = "let midpoint = 42 // Swift\n"
        let storage = NSTextStorage(string: String(repeating: line, count: 6_000))
        let engine = SyntaxEngine(path: "fixture.swift", storage: storage)
        let range = NSRange(location: line.utf16.count * 5_999, length: line.utf16.count)
        #expect(engine.viewTokens(in: range) == nil)
        #expect(engine.visitedLineCount == 0)
        await withCheckedContinuation { continuation in
            engine.onViewportSyntax = { continuation.resume() }
        }
        engine.onViewportSyntax = nil
        let painted = try #require(engine.viewTokens(in: range))
        #expect(painted.first == SyntaxToken(range: NSRange(location: range.location, length: 3), role: .storage))
    }
}
