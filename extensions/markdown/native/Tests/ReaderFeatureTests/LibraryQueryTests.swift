import AppKit
import CryptoKit
import Foundation
import MarkdownCore
import Testing
@testable import ReaderFeature

@MainActor
private struct LibraryQueryStore {
    let root: URL
    let storeId = "0123456789abcdef0123456789abcdef"

    init() throws {
        let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        root = native.appendingPathComponent(".build/library-query-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try write(["version": 1, "storeId": storeId], to: root.appendingPathComponent("store.json"))
    }

    func add(_ index: Int, source: String, title: String = "Ordinary title") throws -> String {
        let id = String(format: "md-%020x", index)
        let directory = root.appendingPathComponent("documents/\(id)/revisions/1", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let bytes = Data(source.utf8)
        let digest = "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let date = "2026-11-17T00:00:00Z"
        try bytes.write(to: directory.appendingPathComponent("source.md"))
        try write(["version": 1, "document": id, "revision": 1, "title": title, "createdAt": date,
                   "digest": digest, "bytes": bytes.count, "completeness": ["state": "complete"]], to: directory.appendingPathComponent("revision.json"))
        try write(["version": 1, "id": id, "kind": "published", "title": title, "createdAt": date, "updatedAt": date,
                   "revision": 1, "digest": digest, "bytes": bytes.count], to: root.appendingPathComponent("documents/\(id)/document.json"))
        return id
    }

    func reference(_ id: String) -> DocumentReference {
        .stored(root: FileAccess.canonicalPath(root.path), storeId: storeId, document: id)
    }

    private func write(_ value: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    }
}

@MainActor @Suite(.serialized)
struct LibraryQueries {
    private func state(_ store: LibraryQueryStore) -> ReadingStateStore {
        let state = ReadingStateStore(directory: nil)
        state.selectStore(root: FileAccess.canonicalPath(store.root.path))
        return state
    }

    private func reader(_ state: ReadingStateStore) -> ReaderModel {
        _ = NSApplication.shared
        return ReaderModel(reference: .file(path: "library-host"), platform: ReaderPlatform(
            copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("test"), application: .failed("test")) }
        ), state: state, webRoot: ReaderHostFixture.root)
    }

    @Test func copyPromotionDropsCommittedSnapshotButKeepsCopyMetadata() async throws {
        let store = try LibraryQueryStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let id = try store.add(1, source: "Original")
        let model = reader(state(store))
        let original = try DocumentLoader.load(store.reference(id), revision: nil, pinnedDigest: nil)
        try await model.showSnapshot(original)
        #expect(model.snapshot?.record != nil)
        let draftId = UUID()
        let copyOf: [String: Any] = ["documentId": id, "revision": 1]
        try await model.acceptSource(source: "Changed exact source\r\n", generation: 1,
                                     meta: ["documentId": draftId.uuidString, "kind": "draft", "title": "Copy", "capturedSource": false, "copyOf": copyOf], draftId: draftId)
        let snapshot = try #require(model.snapshot)
        let rendered = try #require(model.rendered)
        #expect(snapshot.record == nil)
        #expect(snapshot.document == nil)
        #expect(snapshot.revision == nil)
        #expect(snapshot.revisions.isEmpty)
        #expect(snapshot.location.path == "/")
        #expect(snapshot.source == "Changed exact source\r\n")
        let payload = model.documentPayload(snapshot: snapshot, rendered: rendered, generation: 1, lock: model.lock, position: nil)
        let metadata = try #require(payload["meta"] as? [String: Any])
        #expect(metadata["documentId"] as? String == draftId.uuidString)
        #expect((metadata["copyOf"] as? [String: Any])?["documentId"] as? String == id)
        await model.close()
    }

    @Test func draftReviewUsesPinnedBaseAndNamesTheTargetUncommitted() async throws {
        let store = try LibraryQueryStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let id = try store.add(1, source: "# Report\n\nOld text.\n")
        let base = try DocumentLoader.load(store.reference(id), revision: 1)
        let model = reader(state(store))
        let result = try await model.queryDraftReview(base: base, currentSource: "# Report\r\n\r\nNew text.\r\n", resolver: NoAssetResolver())
        let summary = try #require(result["summary"] as? [String: Any])
        let html = try #require(result["html"] as? String)
        #expect(summary["base"] as? Int == 1)
        #expect(summary["target"] is NSNull)
        #expect(summary["targetLabel"] as? String == "Uncommitted draft")
        #expect((summary["changedRegions"] as? Int ?? 0) > 0)
        #expect(html.contains("Uncommitted draft"))
        #expect(html.contains("of the uncommitted draft"))
        #expect(!html.contains("Revision 2"))
        #expect(!html.contains("from the two stored revisions"))
        #expect(model.snapshot == nil)
        #expect(try DocumentLoader.load(store.reference(id), revision: 1).source == base.source)
        await model.close()
    }

    @Test func draftReviewForwardsToTheAppAndRefusesAnUnstoredBase() async throws {
        let store = try LibraryQueryStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let id = try store.add(1, source: "Original")
        let base = try DocumentLoader.load(store.reference(id), revision: 1)
        let model = reader(state(store))
        var forwarded = false
        model.page.onMessage = { [weak model] fields in
            guard fields["type"] as? String == "query", fields["against"] as? String == "base", let model else { return [:] }
            forwarded = true
            return try await model.queryDraftReview(base: base, currentSource: "Changed", resolver: NoAssetResolver())
        }
        try await model.page.load()
        let reply = try await model.page.callJavaScript("return await window.webkit.messageHandlers.reader.postMessage({v:1,type:'query',id:'draft-review',kind:'review',against:'base'});") as? [String: Any]
        #expect(forwarded)
        #expect(reply?["ok"] as? Bool == true)
        #expect((reply?["summary"] as? [String: Any])?["target"] is NSNull)
        let unstored = DocumentSnapshot.draft(reference: .file(path: "private-draft"), title: "Draft", source: "Text", resolver: NoAssetResolver())
        do {
            _ = try await model.queryDraftReview(base: unstored, currentSource: "Changed", resolver: NoAssetResolver())
            Issue.record("A draft without a stored base received a comparison")
        } catch { #expect(error is ReviewError) }
        await model.close()
    }

    @Test func sourceMatchesUseExcerptsAndOpaqueReferencesInsteadOfTitles() async throws {
        let store = try LibraryQueryStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let id = try store.add(1, source: "The hidden NEEDLE appears only in source.")
        let model = reader(state(store))
        let title = try await model.queryLibrary(["collection": "published", "query": "needle"])
        #expect((title["rows"] as? [[String: Any]])?.isEmpty == true)
        let result = try await model.queryLibrary(["collection": "published", "query": "needle", "match": "source"])
        let rows = try #require(result["rows"] as? [[String: Any]])
        #expect(rows.count == 1)
        #expect(rows.first?["excerpt"] as? String == "The hidden NEEDLE appears only in source.")
        let token = try #require(rows.first?["ref"] as? String)
        #expect(model.resolveReference(token) == store.reference(id))
        #expect(!token.contains(store.root.path))
        #expect((result["store"] as? [String: String])?["label"] == store.root.lastPathComponent)
        let coverage = try #require(result["coverage"] as? [String: Any])
        #expect(coverage["searched"] as? Int == 1)
        #expect(coverage["total"] as? Int == 1)
        #expect(coverage["stopped"] as? Bool == false)
        await model.close()
    }

    @Test func sourceBatchesContinueAndRejectAChangedCursorQuery() async throws {
        let store = try LibraryQueryStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        for index in 1...21 { _ = try store.add(index, source: "needle") }
        let model = reader(state(store))
        let first = try await model.queryLibrary(["collection": "published", "match": "source", "query": "needle"])
        let firstRows = try #require(first["rows"] as? [[String: Any]])
        #expect(firstRows.count == 20)
        #expect((first["coverage"] as? [String: Any])?["stopped"] as? Bool == true)
        let cursor = try #require(first["cursor"] as? String)
        do {
            _ = try await model.queryLibrary(["collection": "published", "match": "source", "query": "other", "cursor": cursor])
            Issue.record("A cursor accepted a different source query")
        } catch { #expect(error is ReaderBridgeError) }
        let second = try await model.queryLibrary(["collection": "published", "match": "source", "query": "needle", "cursor": cursor])
        let secondRows = try #require(second["rows"] as? [[String: Any]])
        let tokens = firstRows.compactMap { $0["ref"] as? String } + secondRows.compactMap { $0["ref"] as? String }
        #expect(Set(tokens).count == 21)
        #expect(secondRows.count == 1)
        #expect(second["limited"] as? Bool == false)
        #expect((second["coverage"] as? [String: Any])?["searched"] as? Int == 21)
        await model.close()
    }

    @Test func failedSourcesKeepCoverageUnknownAndRecentFilesUseCurrentSource() async throws {
        let store = try LibraryQueryStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let id = try store.add(1, source: "needle")
        try Data("changed".utf8).write(to: store.root.appendingPathComponent("documents/\(id)/revisions/1/source.md"))
        let state = state(store)
        let model = reader(state)
        let failed = try await model.queryLibrary(["collection": "published", "match": "source", "query": "needle"])
        let coverage = try #require(failed["coverage"] as? [String: Any])
        #expect(coverage["searched"] as? Int == 1)
        #expect(coverage["total"] is NSNull)
        #expect(coverage["stopped"] as? Bool == true)
        #expect(coverage["reason"] as? String != nil)
        let file = store.root.appendingPathComponent("recent.md")
        try Data("Current needle text".utf8).write(to: file)
        state.noteOpened(.file(path: FileAccess.canonicalPath(file.path)), title: "Recent")
        let recent = try await model.queryLibrary(["collection": "recent", "match": "source", "query": "needle"])
        #expect((recent["rows"] as? [[String: Any]])?.first?["excerpt"] as? String == "Current needle text")
        await model.close()
    }
}
