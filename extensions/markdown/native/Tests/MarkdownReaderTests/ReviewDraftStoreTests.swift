import Foundation
import Testing
@testable import MarkdownReader

struct ReviewDraftStoreTests {
    private let scope = ReviewScope(conversation: "launcher", document: "store/document")
    private let body = Data(#" { "overall": "Cafe\u0301 🧪", "comments": [] } "#.utf8)

    @Test func onlyAnUnconsumedDraftIsRecoverable() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ReviewDraftStore(directory: root)
        let otherPane = ReviewDraftStore(directory: root)
        #expect(try store.load(scope: scope) == ReviewDraftSnapshot(version: 0, draft: nil))
        #expect(!FileManager.default.fileExists(atPath: root.path))
        // A consume before the first coalesced save also fences that save out.
        #expect(try store.set(scope: scope, expectedVersion: 0, draft: nil).version == 1)
        #expect(throws: ReviewStoreError.stale) { try otherPane.set(scope: scope, expectedVersion: 0, draft: body) }
        #expect(try store.set(scope: scope, expectedVersion: 1, draft: body).version == 2)
        #expect(try otherPane.load(scope: scope).draft == body)
        #expect(try otherPane.load(scope: ReviewScope(conversation: "other", document: scope.document)).version == 0)
        #expect(try ReviewCommentStore(directory: root).load(scope: scope).comments.isEmpty)
        #expect(try otherPane.set(scope: scope, expectedVersion: 2, draft: nil) == ReviewDraftSnapshot(version: 3, draft: nil))
        #expect(throws: ReviewStoreError.stale) { try store.set(scope: scope, expectedVersion: 2, draft: body) }
        #expect(try store.load(scope: scope) == ReviewDraftSnapshot(version: 3, draft: nil))
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        #expect(files.count == 2)
        for file in files {
            #expect(try Data(contentsOf: file) == (file.pathExtension == "lock" ? Data() : Data("[3,null]".utf8)))
        }
    }

    @Test func invalidOrOversizedDataCannotReplaceAPrivateDraft() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ReviewDraftStore(directory: root)
        let limit = ReviewDraftStore.byteLimit
        var largest = Data("{\"text\":\"".utf8)
        largest.append(Data(repeating: 0x61, count: limit - largest.count - 2))
        largest.append(contentsOf: "\"}".utf8)
        #expect(try store.set(scope: scope, expectedVersion: 0, draft: largest).version == 1)
        #expect(try store.load(scope: scope).draft == largest)
        #expect(throws: ReviewStoreError.limit) { try store.set(scope: scope, expectedVersion: 1, draft: largest + Data([0x20])) }
        for invalid in [Data("[]".utf8), Data("{}oops".utf8), Data([0x7b, 0xff, 0x7d]), Data([0x7b, 0, 0x7d, 0])] {
            #expect(throws: ReviewStoreError.invalid) { try store.set(scope: scope, expectedVersion: 1, draft: invalid) }
        }
        #expect(try store.load(scope: scope).draft == largest)
        let file = try #require(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first { $0.pathExtension == "json" })
        for malformed in ["[1,", "[01,null]", "[9007199254740992,null]", "[1,[],false]"] {
            let bytes = Data(malformed.utf8)
            try bytes.write(to: file)
            #expect(throws: ReviewStoreError.invalid) { try store.set(scope: scope, expectedVersion: 1, draft: nil) }
            #expect(try Data(contentsOf: file) == bytes)
        }
    }

    @Test func concurrentPanesPreserveTheSuccessfulWrite() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ReviewDraftStore(directory: root)
        _ = try store.set(scope: scope, expectedVersion: 0, draft: body)
        let winners = try await withThrowingTaskGroup(of: ReviewDraftSnapshot?.self) { group in
            for draft in [nil, Data("{}".utf8)] {
                group.addTask { [scope] in
                    do { return try ReviewDraftStore(directory: root).set(scope: scope, expectedVersion: 1, draft: draft) }
                    catch ReviewStoreError.stale { return nil }
                }
            }
            var results: [ReviewDraftSnapshot] = []
            for try await result in group { if let result { results.append(result) } }
            return results
        }
        #expect(winners.count == 1)
        #expect(try store.load(scope: scope) == winners.first)
    }
}
