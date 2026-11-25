import AppKit
import EditorFeature
import MarkdownCore
import ReaderFeature
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

    @Test func broadDirtyTracesFallBackBeforeCombinationAndKeepRecovery() async throws {
        // Interleaved unchanged anchors leave hundreds of separate changed lines. Each has
        // three independent character hunks on each side, beyond the page's edit count.
        func source(_ line: String) -> String {
            (0..<700).map { "row \($0)\n\(line)\n" }.joined()
        }
        let original = source("one two three four five six")
        let local = source("One two Three four Five six")
        let incoming = source("one Two three Four five Six")
        guard case .limited = LiveTextMerge.merge(base: original, local: local, remote: incoming) else {
            Issue.record("Broad overlapping traces exceeded the refinement budget without a safe refusal"); return
        }
        let run = try PaneRun(); defer { run.remove() }
        let base = try revision(1, source: original, in: run)
        let remote = try revision(2, source: incoming, in: run)
        let workspace = EditorWorkspace(directory: run.root.appendingPathComponent("drafts"), store: run.store)
        workspace.add(DraftRecord(title: "Paper", source: local, destination: .published(base), savedSource: original))
        let document = try #require(workspace.active)
        workspace.webReady = true
        workspace.webAgentApply = { _, _, _ in Issue.record("The limited merge reached the page"); return .refused(reason: "rejected") }
        await workspace.receiveExternalChange(document)
        #expect(document.session.record.conflict?.revision == remote.revision)
        #expect(document.session.record.conflict?.message.contains("safe merge limit") == true)
        #expect(await document.session.persist())
        let retained = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(retained.source == local && retained.destination == .published(base))
        #expect(retained.conflict == document.session.record.conflict)
        await workspace.closeViews()
    }

    @Test func aCoarseDisjointTraceStillMergesWithinTheTransportCount() {
        let anchor = String(repeating: "middle\n", count: 2100)
        let original = "head\n" + anchor + "tail"
        let local = "LONGER head\n" + anchor + "tail"
        let incoming = "head\n" + anchor + "END"
        guard case .merged(let changes) = LiveTextMerge.merge(base: original, local: local, remote: incoming) else {
            Issue.record("Disjoint coarse hunks did not merge"); return
        }
        let edits = changes.map { MarkdownSourceEdit(range: $0.range, expected: $0.expected, replacement: $0.replacement) }
        #expect(edits.count == 1)
        #expect(MirrorText.applying(edits, to: local) == "LONGER head\n" + anchor + "END")
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

    @Test func theDirtyMergeLimitIncludesEscapedBytesAndEditCount() throws {
        let count = ReaderBridgeCodec.editLimit
        let record = DraftRecord(source: String(repeating: "xy", count: count + 1))
        let edits = (0...count).map { MarkdownSourceEdit(range: NSRange(location: $0 * 2, length: 1), expected: "x", replacement: "X") }
        #expect(try EditorWorkspace.prepareMergeSource(Array(edits.dropLast()), record: record) == String(repeating: "Xy", count: count) + "xy")
        #expect(throws: (any Error).self) { try EditorWorkspace.prepareMergeSource(edits, record: record) }
        let escaped = String(repeating: "\u{0001}", count: 900_000)
        let oversized = MarkdownSourceEdit(range: NSRange(location: 0, length: 1), expected: "x", replacement: escaped)
        #expect(MirrorText.applying([oversized], to: record.source) != nil)
        #expect(throws: (any Error).self) { try EditorWorkspace.prepareMergeSource([oversized], record: record) }
    }

    @Test func dirtyMergeRetainsNewAssetsAndAcceptsTypingBeforeItsReceiptReturns() async throws {
        let run = try PaneRun(); defer { run.remove() }
        let original = "first\n\nsecond\n\n![Image](picture.png)\n"
        let local = "local\n\nsecond\n\n![Image](picture.png)\n"
        let incoming = "first\n\nremote\n\n![Image](picture.png)\n"
        let newImage = Data([4, 5, 6])
        let base = try revision(1, source: original, image: Data([1, 2, 3]), in: run)
        let remote = try revision(2, source: incoming, image: newImage, in: run)
        let workspace = EditorWorkspace(directory: run.root.appendingPathComponent("drafts"), store: run.store)
        workspace.add(DraftRecord(title: "Paper", source: local, destination: .published(base), savedSource: original))
        let document = try #require(workspace.active)
        document.onExternalChange = {}
        workspace.webReady = true
        workspace.webAgentApply = { operation, generation, edits in
            let change = WebPageChange(baseGeneration: generation, generation: generation + 1, origin: "agent", operationId: operation, edits: edits)
            do {
                let ack = try await workspace.receivePageChange(change)
                #expect(ack.recoveryRetained)
                #expect(document.session.record.destination == .published(remote))
                if case .local(let asset) = document.assetResolver.resolve("picture.png") {
                    #expect(try asset.readData() == newImage)
                } else { Issue.record("The incoming asset was not available on the first merged generation") }
                _ = try await workspace.receivePageChange(.init(baseGeneration: generation + 1, generation: generation + 2,
                    origin: "person", edits: [.init(range: NSRange(location: 0, length: 0), expected: "", replacement: "typed ")]))
                return .accepted(change)
            } catch { Issue.record("\(error)"); return .refused(reason: "stale") }
        }
        await workspace.receiveExternalChange(document)
        #expect(document.text.source == "typed local\n\nremote\n\n![Image](picture.png)\n")
        #expect(document.session.record.conflict == nil && document.session.isDirty)
        let saved = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(saved.source == document.text.source && saved.destination == .published(remote))
        await workspace.closeViews()
    }

    @Test func cleanConflictsRecoverInTheSameBufferAcrossRepeatedUpdates() async throws {
        let run = try PaneRun(); defer { run.remove() }
        let base = try revision(1, source: "first", in: run)
        let workspace = EditorWorkspace(directory: run.root.appendingPathComponent("drafts"), store: run.store)
        workspace.add(DraftRecord(title: "Paper", source: "first", destination: .published(base), savedSource: "first"))
        let document = try #require(workspace.active)
        document.onExternalChange = {}
        let handle = workspace.liveDocumentID
        var installs = 0
        workspace.webExternalSnapshot = { shown, record, _, validate, commit in
            #expect(shown === document && validate())
            #expect(record.generation == shown.text.generation + 1)
            installs += 1
            commit()
        }
        workspace.webAgentApply = { _, _, _ in Issue.record("A clean revision must not send an agent edit"); return .refused(reason: "rejected") }
        for n in 2...3 {
            document.session.setConflict(.init(message: "Old false conflict"))
            let candidate = try revision(n, source: "revision \(n)", in: run)
            await workspace.receiveExternalChange(document)
            #expect(workspace.liveDocumentID == handle && workspace.active === document)
            #expect(document.session.record.destination == .published(candidate))
            #expect(document.session.record.conflict == nil && !document.session.isDirty)
            #expect(document.text.source == "revision \(n)")
        }
        #expect(installs == 2)
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
