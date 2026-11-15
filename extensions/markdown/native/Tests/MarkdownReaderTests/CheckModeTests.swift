import Testing
@testable import MarkdownReader

@MainActor @Suite struct CheckModeBounds {
    @Test func deadlineReportsTheLastStageWithoutWaitingForWork() async {
        let deadline = VerificationDeadline()
        let stage = await withCheckedContinuation { continuation in
            deadline.start(seconds: 0.01) { continuation.resume(returning: $0) }
            deadline.stage = "display overlap: waiting for superseded open"
        }
        #expect(stage == "display overlap: waiting for superseded open")
    }

    @Test func aCompletedCheckDisarmsItsDeadline() async {
        let first = VerificationDeadline()
        let second = VerificationDeadline()
        var expired = false
        first.start(seconds: 0.01) { _ in expired = true }
        first.stop()
        await withCheckedContinuation { continuation in
            second.start(seconds: 0.03) { _ in continuation.resume() }
        }
        #expect(!expired)
    }
}
