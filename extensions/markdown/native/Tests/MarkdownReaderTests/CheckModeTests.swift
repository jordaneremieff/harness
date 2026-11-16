import Testing
import ReaderFeature
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite struct CheckModeBounds {
    @Test(arguments: [false, true])
    func checkOpenRetainsTheRequestDigestWithoutConsumingTheRequest(_ mismatched: Bool) async throws {
        let run = try PaneRun()
        defer { run.remove() }
        let store = try DirectoryStore(root: URL(fileURLWithPath: run.store))
        let revision = try store.loadRevision(run.document, revision: 1)
        let digest = mismatched ? "sha256:" + String(repeating: "0", count: 64) : revision.record.digest
        let request = OpenRequest(storeId: store.storeId, document: run.document, revision: 1, digest: digest)
        let path = store.root.appendingPathComponent("opens/check.json")
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(request).write(to: path)
        let (reference, number, pinnedDigest) = try CheckRunner.reference(for: path.path)
        #expect(number == 1)
        #expect(pinnedDigest == digest)
        let model = ReaderModel(reference: reference, platform: CheckRunner.platform(), state: ReadingStateStore(directory: nil))
        await model.open(revision: number, digest: pinnedDigest, origin: nil)
        if mismatched {
            if case .failed = model.phase {} else { Issue.record("A mismatched pinned digest reached the reader") }
            #expect(model.snapshot == nil)
        } else {
            #expect(model.phase == .ready)
            #expect(model.snapshot?.digest == digest)
        }
        #expect(FileManager.default.fileExists(atPath: path.path))
        await model.close()
    }

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
