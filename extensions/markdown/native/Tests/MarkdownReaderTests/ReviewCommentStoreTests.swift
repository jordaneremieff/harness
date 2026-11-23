import Darwin
import Foundation
import Testing
@testable import MarkdownReader

struct ReviewCommentStoreTests {
    private let scope = ReviewScope(conversation: "session", document: "draft")

    private func fixture(_ test: (ReviewCommentStore) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try test(ReviewCommentStore(directory: root))
    }

    private func comment(thread: String = UUID().uuidString.lowercased(), ordinal: Int = 0, kind: String = "question", text: String = "Review this") -> ReviewComment {
        ReviewComment(commentId: "\(thread):\(ordinal)", threadId: thread, kind: kind, ordinal: ordinal, text: text)
    }

    @Test func scopeIsByteExactAndAbsentReadCreatesNothing() throws {
        try fixture { store in
            #expect(try store.load(scope: scope).revision == 0)
            #expect(!FileManager.default.fileExists(atPath: store.directory.path))
            let composed = ReviewScope(conversation: "a:b", document: "é")
            try store.record(scope: composed, comments: [comment()])
            for other in [ReviewScope(conversation: "a:b", document: "e\u{301}"), ReviewScope(conversation: "a", document: "b:é")] {
                #expect(try store.load(scope: other).comments.isEmpty)
            }
            #expect(try store.load(scope: composed).comments.count == 1)
            let files = try FileManager.default.contentsOfDirectory(at: store.directory, includingPropertiesForKeys: nil)
            #expect(files.count == 2)
            for url in files + [store.directory] {
                var info = stat()
                #expect(lstat(url.path, &info) == 0)
                #expect(info.st_mode & 0o777 == (url == store.directory ? 0o700 : 0o600))
            }
        }
    }

    @Test func retryKeepsFirstCaptureAndIndependentMemberStates() throws {
        try fixture { store in
            let thread = UUID().uuidString.lowercased()
            let overall = comment(thread: thread, ordinal: 0, kind: "overall")
            var item = comment(thread: thread, ordinal: 1, kind: "annotation", text: "café")
            item.quote = "rendered"; item.sourceAnchor = "🧪e\u{301}"; item.start = 5; item.end = 9; item.madeOnRevision = 3
            try store.record(scope: scope, comments: [item, overall])
            let nextPane = ReviewCommentStore(directory: store.directory)
            #expect(try nextPane.set(scope: scope, id: item.commentId, state: "closed", expectedVersion: 1).version == 2)
            item.start = 6; item.end = 10; item.madeOnRevision = 4
            try store.record(scope: scope, comments: [overall, item])
            #expect(throws: ReviewStoreError.stale) { try store.set(scope: scope, id: item.commentId, state: "closed", expectedVersion: 1) }
            #expect(try store.set(scope: scope, id: item.commentId, state: "closed", expectedVersion: 2).version == 2)
            let snapshot = try nextPane.load(scope: scope)
            #expect(snapshot.revision == 2)
            #expect(snapshot.comments.map(\.commentState) == ["open", "closed"])
            #expect(snapshot.comments.last?.start == 5)
            #expect(snapshot.comments.last?.madeOnRevision == 3)
            let changedText = comment(thread: thread, ordinal: 1, kind: "annotation", text: "cafe\u{301}")
            #expect(throws: ReviewStoreError.invalid) { try store.record(scope: scope, comments: [overall, changedText]) }
            #expect(try nextPane.set(scope: scope, id: item.commentId, state: "open", expectedVersion: 2).version == 3)
            #expect(try store.load(scope: scope).revision == 3)
        }
    }

    @Test func malformedBatchesCannotLeavePartialRecords() throws {
        try fixture { store in
            let one = comment(ordinal: 1, kind: "annotation")
            var bad = comment(thread: one.threadId, ordinal: 2, kind: "annotation")
            bad.sourceAnchor = "🧪"; bad.start = 0; bad.end = 1
            let zero = comment(thread: one.threadId, kind: "overall")
            for input in [[one, bad], [zero], [one, one], [one, comment()], [comment(ordinal: 2, kind: "annotation")]] {
                #expect(throws: ReviewStoreError.invalid) { try store.record(scope: scope, comments: input) }
            }
            #expect(try store.load(scope: scope).comments.isEmpty)
            try store.record(scope: scope, comments: [one])
            #expect(throws: ReviewStoreError.invalid) { try store.record(scope: scope, comments: [zero, one]) }
            #expect(try store.load(scope: scope).comments.count == 1)
        }
    }

    @Test func futureOrMalformedSheetStaysUntouched() throws {
        try fixture { store in
            let one = comment()
            try store.record(scope: scope, comments: [one])
            let url = try #require(FileManager.default.contentsOfDirectory(at: store.directory, includingPropertiesForKeys: nil).first { $0.pathExtension == "json" })
            let initial = try Data(contentsOf: url)
            let sheet = try #require(JSONSerialization.jsonObject(with: initial) as? [String: Any])
            for bytes in [Data("[".utf8), try JSONSerialization.data(withJSONObject: sheet.merging(["unknown": 1]) { $1 }),
                          try JSONSerialization.data(withJSONObject: sheet.merging(["revision": 20]) { $1 })] {
                try bytes.write(to: url)
                #expect(throws: (any Error).self) { try store.load(scope: scope) }
                #expect(throws: (any Error).self) { try store.record(scope: scope, comments: [comment()]) }
                #expect(try Data(contentsOf: url) == bytes)
            }
        }
    }

    @Test func oversizedSheetRefusesWithoutEviction() throws {
        try fixture { store in
            let first = comment()
            try store.record(scope: scope, comments: [first])
            let thread = UUID().uuidString.lowercased()
            let large = String(repeating: "a", count: 100_000)
            let batch = (1...43).map { comment(thread: thread, ordinal: $0, kind: "annotation", text: large) }
            #expect(throws: ReviewStoreError.limit) { try store.record(scope: scope, comments: batch) }
            #expect(try store.load(scope: scope).comments.map(\.commentId) == [first.commentId])
        }
    }

    @Test func simultaneousPanesCannotBothApplyTheSameBase() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ReviewCommentStore(directory: root)
        let item = comment()
        try store.record(scope: scope, comments: [item])
        let results = try await withThrowingTaskGroup(of: Bool.self) { group in
            for _ in 0..<2 {
                group.addTask { [scope] in
                    do {
                        _ = try ReviewCommentStore(directory: root).set(scope: scope, id: item.commentId, state: "closed", expectedVersion: 1)
                        return true
                    } catch ReviewStoreError.stale { return false }
                }
            }
            var wins = 0
            for try await won in group where won { wins += 1 }
            return wins
        }
        #expect(results == 1)
        #expect(try store.load(scope: scope).revision == 2)
    }
}
