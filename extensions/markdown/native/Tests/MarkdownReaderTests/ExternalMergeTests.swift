import AppKit
import EditorFeature
import MarkdownCore
import Testing
@testable import MarkdownReader

@Suite(.serialized) @MainActor struct ExternalMergeTests {
    private func revision(_ n: Int, source: String, image: Data? = nil, in run: PaneRun) throws -> StoredEditBase {
        let store = try DirectoryStore(root: URL(fileURLWithPath: run.store))
        let folder = store.root.appendingPathComponent("documents/\(run.document)")
        let revision = folder.appendingPathComponent("revisions/\(n)")
        try FileManager.default.createDirectory(at: revision.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let bytes = Data(source.utf8), digest = Digest.sha256(bytes), date = "2026-01-01T00:00:00Z"
        var items = [[String: Any]]()
        if let image {
            let hash = Digest.sha256(image), file = "assets/\(hash.dropFirst(7)).png"
            try image.write(to: revision.appendingPathComponent(file))
            items.append(["reference": "picture.png", "kind": "image", "state": "retained", "digest": hash, "bytes": image.count,
                          "file": file, "mediaType": "image/png"])
        }
        try bytes.write(to: revision.appendingPathComponent("source.md"))
        try JSONSerialization.data(withJSONObject: ["version": 1, "revision": n, "document": run.document, "title": "Paper", "createdAt": date,
            "bytes": bytes.count, "digest": digest, "completeness": ["state": "complete"], "references": ["state": "inspected", "truncated": false, "omitted": 0, "items": items]])
            .write(to: revision.appendingPathComponent("revision.json"))
        try JSONSerialization.data(withJSONObject: ["version": 1, "revision": n, "id": run.document, "kind": "published", "title": "Paper",
            "createdAt": date, "updatedAt": date, "bytes": bytes.count, "digest": digest]).write(to: folder.appendingPathComponent("document.json"), options: .atomic)
        return StoredEditBase(root: store.root.path, storeId: store.storeId, document: run.document, revision: n, digest: digest)
    }

    @Test func boundedConflictSurvivesRecoveryAndDoesNotSave() async throws {
        let run = try PaneRun(); defer { run.remove() }
        let lines = String(repeating: "middle\n", count: 2049)
        let base = try revision(1, source: "A\n" + lines + "Z", in: run)
        let local = "L\n" + lines + "X"
        let remote = try revision(2, source: "A\nR\n" + lines + "Z", in: run)
        let workspace = EditorWorkspace(directory: run.root.appendingPathComponent("drafts"), store: run.store, automaticallySaves: true)
        workspace.add(DraftRecord(title: "Paper", source: local, destination: .published(base), savedSource: "A\n" + lines + "Z"))
        let document = try #require(workspace.active)
        await workspace.receiveExternalChange(document)
        let conflict = try #require(document.session.record.conflict)
        #expect(conflict.message.contains("safe merge limit") && conflict.revision == 2 && conflict.digest == remote.digest)
        workspace.schedulePersistence(document)
        await document.persistenceTask?.value
        #expect(document.session.destinationSaveError == nil && document.session.record.pendingPublication == nil)
        #expect(await document.session.persist())
        let draft = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(draft.conflict == conflict && draft.destination == .published(base) && draft.source == local)
        await workspace.closeViews()
    }

    @Test func remoteAssetWithdrawalDoesNotReviveAnOldPrivateAdmission() async throws {
        let run = try PaneRun(); defer { run.remove() }
        let source = "![Image](picture.png)\n", bytes = Data([1, 2, 3])
        let base = try revision(1, source: source, image: bytes, in: run)
        let workspace = EditorWorkspace(directory: run.root.appendingPathComponent("drafts"), store: run.store)
        var draft = DraftRecord(title: "Paper", source: source, destination: .published(base), savedSource: source)
        let root = try workspace.imageRoot(for: draft)
        var staged = try EditorAssetStore(root: root).stage(data: bytes, extension: "png"); staged.reference = "picture.png"
        draft.assetRoot = root.path; draft.stagedAssets = [staged]
        let remote = try revision(2, source: source, in: run)
        workspace.add(draft)
        let document = try #require(workspace.active)
        document.onExternalChange = {}
        await workspace.receiveExternalChange(document)
        #expect(document.session.record.destination == .published(remote))
        #expect(document.session.record.stagedAssets?.isEmpty == true && !document.session.isDirty)
        #expect(try DraftAssets.stageReferenced(in: document.session.record, root: root).isEmpty)
        await workspace.closeViews()
    }

    @Test func normalisationAndBoundaryEditsKeepTheirExactBytes() throws {
        let local = "Aé\r\n", base = "é\r\n", remote = "e\u{301}\r\n"
        guard case .merged(let edits) = LiveTextMerge.merge(base: base, local: local, remote: remote) else {
            Issue.record("Adjacent insertion and replacement did not merge"); return
        }
        let text = NSMutableString(string: local)
        for edit in edits.reversed() { text.replaceCharacters(in: edit.range, with: edit.replacement) }
        #expect((text as String).utf8.elementsEqual("Ae\u{301}\r\n".utf8))
    }
}
