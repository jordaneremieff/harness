import Testing
import AppKit
import EditorFeature
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct EditorRevisionBases {
    @Test func draftReviewLoadsTheExactPinnedBaseAndPreservesCurrentSource() async throws {
        _ = NSApplication.shared
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
        var stored = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: pointer)) as? [String: Any])
        stored["revision"] = 2; stored["digest"] = digest; stored["bytes"] = bytes.count
        try JSONSerialization.data(withJSONObject: stored).write(to: pointer, options: .atomic)

        for destination in [EditDestination.published(base), .copy(base)] {
            let current = "My unsaved draft\r\ncafe\u{301} 🌱\r"
            let workspace = EditorWorkspace(directory: fixture.root.appendingPathComponent(UUID().uuidString), store: fixture.store)
            workspace.add(DraftRecord(source: current, destination: destination, savedSource: original.source))
            let document = try #require(workspace.active)
            document.text.select(NSRange(location: 3, length: 7))
            let selection = document.text.selectedRange, generation = document.text.generation
            let pinned = try await workspace.draftReviewBase()
            #expect(pinned.revision == 1 && pinned.digest == original.digest)
            #expect(pinned.source.utf8.elementsEqual(original.source.utf8))
            #expect(!pinned.source.utf8.elementsEqual(source.utf8))
            #expect(document.text.source.utf8.elementsEqual(current.utf8))
            #expect(document.text.generation == generation && document.text.selectedRange == selection)
            #expect(document.session.record.destination == destination)
            await workspace.closeViews()
        }
    }

    @Test func scratchpadAndLocalFileRefuseStoredBaseReviewWithoutChangingText() async throws {
        _ = NSApplication.shared
        let fixture = try PaneRun()
        defer { fixture.remove() }
        let file = fixture.root.appendingPathComponent("local.md")
        try Data("local source".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        for destination in [EditDestination.scratchpad, .file(opened.base)] {
            let workspace = EditorWorkspace(directory: fixture.root.appendingPathComponent(UUID().uuidString), store: fixture.store)
            let current = "Exact unsaved\r\nsource 🌱"
            workspace.add(DraftRecord(source: current, destination: destination))
            let document = try #require(workspace.active)
            do {
                _ = try await workspace.draftReviewBase()
                Issue.record("A document without a stored base allowed stored-base review")
            } catch { }
            #expect(document.text.source.utf8.elementsEqual(current.utf8))
            #expect(document.text.generation == 0 && document.session.record.destination == destination)
            await workspace.closeViews()
        }
        #expect(try Data(contentsOf: file) == Data("local source".utf8))
    }

    @Test func alteredPinnedDigestRefusesReviewAndPreservesTheDraft() async throws {
        _ = NSApplication.shared
        let fixture = try PaneRun()
        defer { fixture.remove() }
        let root = URL(fileURLWithPath: fixture.store)
        let identity = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("store.json"))) as? [String: Any])
        let storeId = try #require(identity["storeId"] as? String)
        let base = StoredEditBase(root: fixture.store, storeId: storeId, document: fixture.document, revision: 1,
            digest: Digest.sha256(Data("not the stored source".utf8)))
        let workspace = EditorWorkspace(directory: fixture.root.appendingPathComponent("drafts"), store: fixture.store)
        workspace.add(DraftRecord(source: "Keep this draft", destination: .copy(base)))
        let document = try #require(workspace.active)
        do {
            _ = try await workspace.draftReviewBase()
            Issue.record("A mismatched pinned digest allowed review")
        } catch { }
        #expect(document.text.source == "Keep this draft" && document.text.generation == 0)
        #expect(document.session.record.destination == .copy(base))
        await workspace.closeViews()
    }
}
