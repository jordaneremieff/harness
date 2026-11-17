import Testing
import AppKit
import EditorFeature
import ReaderFeature
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct NativeEditorImages {
    private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=")!

    private func directory() throws -> URL {
        _ = NSApplication.shared
        let parent = ProcessInfo.processInfo.environment["TMPDIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let root = parent.appendingPathComponent("native-images-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func connectPage(_ workspace: EditorWorkspace) {
        workspace.webReady = true
        workspace.webAgentApply = { [weak workspace] operation, generation, edits in
            guard let workspace else { return .refused(reason: "closed") }
            let change = WebPageChange(baseGeneration: generation, generation: generation + 1, origin: "agent", operationId: operation, edits: edits)
            do { _ = try await workspace.receivePageChange(change); return .accepted(change) }
            catch { return .refused(reason: "stale") }
        }
    }

    private func staged(_ document: WorkingDocument) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        while document.stagingImages, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(!document.stagingImages)
        try #require(document.session.record.stagedAssets?.count == 1)
    }

    @Test func changedBufferRetainsPastedImageThroughRecoveryAndFileExport() async throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let drafts = root.appendingPathComponent("drafts")
        let workspace = EditorWorkspace(directory: drafts, store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        _ = document.text.apply(range: NSRange(location: 0, length: 0), replacement: "Draft ", selection: NSRange(location: 6, length: 0), actionName: "")
        workspace.stageImages(document, data: png, extension: "png")
        _ = document.text.apply(range: document.text.selectedRange, replacement: "later", selection: NSRange(location: 11, length: 0), actionName: "")
        try await staged(document)
        #expect(document.text.source == "Draft later")
        let reference = try #require(document.session.record.pendingImageReferences?.first)
        let record = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(record.pendingImageReferences == [reference])
        #expect(record.source == "Draft later")
        await workspace.closeViews()

        let restored = EditorWorkspace(directory: drafts, store: nil)
        restored.add(record.resumed())
        let resumed = try #require(restored.active)
        connectPage(restored)
        resumed.text.select(NSRange(location: resumed.text.source.utf16.count, length: 0))
        await restored.insertImages(resumed)
        let inserted = "Draft later![Image](\(reference))"
        #expect(resumed.text.source == inserted)
        #expect(resumed.session.record.pendingImageReferences?.isEmpty == true)
        let destination = root.appendingPathComponent("export")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let file = destination.appendingPathComponent("saved.md")
        await restored.saveFile(resumed, to: file)
        #expect(resumed.session.error == nil)
        #expect(try String(contentsOf: file, encoding: .utf8) == inserted)
        #expect(try Data(contentsOf: destination.appendingPathComponent(reference)) == png)
        let assetRoot = try #require(resumed.session.record.assetRoot)
        try FileManager.default.removeItem(atPath: assetRoot)
        let rendered = MarkdownRenderer.render(inserted, resolver: DirectoryAssetResolver(directory: destination))
        let image = try #require(rendered.images.first)
        guard case .local(let token) = image.source else { Issue.record("Exported image did not resolve locally"); return }
        #expect(try rendered.assets[token]?.readData() == png)
        await restored.closeViews()
    }

    @Test func compositionKeepsAnAsyncImagePending() async throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        connectPage(workspace)
        workspace.stageImages(document, data: png, extension: "png")
        document.text.hasMarkedText = true
        try await staged(document)
        let source = document.text.source
        #expect(document.text.hasMarkedText)
        await workspace.insertImages(document)
        #expect(document.text.source == source)
        #expect(document.session.record.pendingImageReferences?.count == 1)
        document.text.hasMarkedText = false
        await workspace.insertImages(document)
        #expect(document.text.source.contains("![Image](assets/"))
        #expect(document.session.record.pendingImageReferences?.isEmpty == true)
        await workspace.closeViews()
    }

    @Test func duplicateKeepsFileImagesAndSaveAsRefusesAnUncapturedDestination() async throws {
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8)
        let image = root.appendingPathComponent("picture.svg"), file = root.appendingPathComponent("original.md")
        let source = "![Picture](picture.svg)\r\n"
        try bytes.write(to: image)
        try Data(source.utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: source, destination: .file(opened.base), savedSource: source))
        let original = try #require(workspace.active)
        await workspace.duplicate(original)
        let copy = try #require(workspace.active)
        #expect(copy.id != original.id)
        #expect(copy.text.source == source)
        try FileManager.default.removeItem(at: image)
        let rendered = MarkdownRenderer.render(source, resolver: try DraftAssets.resolver(for: copy.session.record))
        guard case .local(let token) = try #require(rendered.images.first).source else { Issue.record("Copied image did not resolve locally"); return }
        #expect(try rendered.assets[token]?.readData() == bytes)
        let occupied = root.appendingPathComponent("occupied.md")
        try Data("Unrelated content".utf8).write(to: occupied)
        await workspace.saveFile(copy, to: occupied)
        #expect(copy.session.error != nil)
        #expect(try String(contentsOf: occupied, encoding: .utf8) == "Unrelated content")
        #expect(copy.text.source == source)
        #expect(try String(contentsOf: file, encoding: .utf8) == source)
        await workspace.closeViews()
    }
    @Test func pickedImageReturnsUnappliedEditsAndAdoptsAssetsOnPersonChange() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("picture.png")
        try png.write(to: file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: "Draft "))
        let document = try #require(workspace.active)
        var agentCalls = 0
        workspace.webAgentApply = { _, _, _ in agentCalls += 1; return .refused(reason: "unexpected") }
        let reply = try await workspace.preparePickedImages(files: [file], generation: 0,
            range: NSRange(location: 6, length: 0), source: "Draft ")
        #expect(!reply.cancelled && reply.generation == 0 && reply.edits.count == 1)
        #expect(document.text.source == "Draft " && document.text.generation == 0)
        #expect(document.session.record.stagedAssets == nil && agentCalls == 0)
        #expect(reply.edits[0].replacement.hasPrefix("![Image](assets/"))
        let ack = try await workspace.receivePageChange(.init(baseGeneration: 0, generation: 1, origin: "person", edits: reply.edits))
        #expect(ack.recoveryRetained && agentCalls == 0)
        let image = try #require(document.session.record.stagedAssets?.first)
        #expect(document.session.record.pendingImageReferences?.isEmpty == true)
        #expect(document.session.record.liveReceipts == nil)
        #expect(workspace.preparedPickedImages.isEmpty)
        let saved = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(saved.source == "Draft " + reply.edits[0].replacement)
        guard case .local(let asset) = document.assetResolver.resolve(image.reference) else { Issue.record("Prepared image was not adopted"); return }
        #expect(try asset.readData() == png)
        await workspace.closeViews()
    }

    @Test func capturedImagePreparationCreatesNoCopyUntilPersonCommits() async throws {
        let fixture = try PaneRun(); defer { fixture.remove() }
        let root = URL(fileURLWithPath: fixture.store)
        let pointer = root.appendingPathComponent("documents/\(fixture.document)/document.json")
        var record = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: pointer)) as? [String: Any])
        record["kind"] = "response"
        try JSONSerialization.data(withJSONObject: record).write(to: pointer)
        let snapshots = root.appendingPathComponent("snapshots")
        try FileManager.default.createDirectory(at: snapshots, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: pointer.deletingLastPathComponent(),
            to: snapshots.appendingPathComponent(fixture.document))
        let identity = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("store.json"))) as? [String: Any])
        let storeID = try #require(identity["storeId"] as? String)
        let reference = DocumentReference.stored(root: fixture.store, storeId: storeID, document: fixture.document)
        let original = try DocumentLoader.load(reference)
        let file = fixture.root.appendingPathComponent("image.png")
        try png.write(to: file)
        _ = NSApplication.shared
        let application = try PaneTestApplication(sourceBinary: PaneRun.binary)
        defer { application.remove() }
        let platform = ReaderPlatform(copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("test"), application: .failed("test")) })
        let host = ReaderModel(reference: reference, platform: platform, state: ReadingStateStore(directory: nil),
            webRoot: application.web)
        let workspace = EditorWorkspace(directory: fixture.root.appendingPathComponent("drafts"), store: fixture.store)
        workspace.webHostModel = host
        await workspace.openReading(reference)
        try #require(workspace.reading === host)
        let reply = try await workspace.preparePickedImages(files: [file], generation: 0,
            range: NSRange(location: original.source.utf16.count, length: 0), source: original.source)
        #expect(workspace.active == nil && workspace.documents.isEmpty)
        #expect(workspace.reading === host)
        #expect(try await workspace.drafts.list().records.isEmpty)
        let ack = try await workspace.receivePageChange(.init(baseGeneration: 0, generation: 1, origin: "person", edits: reply.edits))
        #expect(ack.copied && ack.recoveryRetained)
        let copy = try #require(workspace.active)
        guard case .copy = copy.session.record.destination else { Issue.record("Captured source was not copied"); return }
        #expect(copy.session.record.stagedAssets?.count == 1)
        #expect(try DocumentLoader.load(reference).source.utf8.elementsEqual(original.source.utf8))
        await workspace.closeViews()
        await host.close()
    }

    @Test func cancelledAndStaleImagePreparationDoNotChangeTheDocument() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: "source"))
        let empty = try await workspace.preparePickedImages(files: [], generation: 0, range: NSRange(location: 0, length: 0), source: "source")
        #expect(empty.cancelled && empty.edits.isEmpty && workspace.preparedPickedImages.isEmpty)
        do {
            _ = try await workspace.preparePickedImages(files: [], generation: 1, range: NSRange(location: 0, length: 0), source: "source")
            Issue.record("Stale image preparation was accepted")
        } catch { }
        #expect(workspace.active?.text.source == "source")
        await workspace.closeViews()
    }
}
