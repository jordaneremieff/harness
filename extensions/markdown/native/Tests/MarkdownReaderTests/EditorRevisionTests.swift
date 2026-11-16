import Testing
import EditorFeature
@testable import MarkdownCore
@testable import MarkdownReader

@Suite struct EditorRevisionBases {
    @Test func storedReviewKeepsThePinnedBaseSeparateFromTheLatestRevision() throws {
        let fixture = try PaneRun()
        defer { fixture.remove() }
        let root = URL(fileURLWithPath: fixture.store)
        let identity = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("store.json"))) as? [String: Any])
        let storeId = try #require(identity["storeId"] as? String)
        let reference = DocumentReference.stored(root: fixture.store, storeId: storeId, document: fixture.document)
        let original = try DocumentLoader.load(reference)
        let base = StoredEditBase(root: fixture.store, storeId: storeId, document: fixture.document, revision: 1, digest: original.digest)
        let folder = root.appendingPathComponent("documents/\(fixture.document)")
        let next = folder.appendingPathComponent("revisions/2")
        try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true)
        let source = "# Current source\n\nA new publication.\n", bytes = Data(source.utf8)
        let digest = Digest.sha256(bytes)
        try bytes.write(to: next.appendingPathComponent("source.md"))
        var revision = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("revisions/1/revision.json"))) as? [String: Any])
        revision["revision"] = 2; revision["digest"] = digest; revision["bytes"] = bytes.count
        try JSONSerialization.data(withJSONObject: revision).write(to: next.appendingPathComponent("revision.json"))
        let pointer = folder.appendingPathComponent("document.json")
        var document = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: pointer)) as? [String: Any])
        document["revision"] = 2; document["digest"] = digest; document["bytes"] = bytes.count
        try JSONSerialization.data(withJSONObject: document).write(to: pointer, options: .atomic)

        var record = DraftRecord(source: "My unsaved draft", destination: .published(base), savedSource: original.source)
        let candidate = try EditorRevisionCandidate.load(record)
        #expect(candidate.baseSource == original.source)
        #expect(candidate.source == source)
        #expect(candidate.baseLabel == "Edit base · pinned revision 1")
        #expect(candidate.storedComparison != nil)
        #expect(record.source == "My unsaved draft")
        #expect(record.destination == .published(base))

        record.destination = .copy(base)
        let copy = try EditorRevisionCandidate.load(record)
        #expect(copy.source == original.source)
        #expect(copy.baseSource == original.source)
        #expect(copy.destination == .copy(base))
        #expect(copy.label == "Copy source · pinned revision 1")
    }
}
