import Testing
import AppKit
import EditorFeature
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct NativeEditorImages {
    private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=")!

    private func directory() throws -> URL {
        let parent = ProcessInfo.processInfo.environment["TMPDIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let root = parent.appendingPathComponent("native-images-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func attach(_ document: WorkingDocument) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 700, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = document.text.scrollView
        window.makeFirstResponder(document.text.textView)
        return window
    }

    private func staged(_ document: WorkingDocument) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        while document.stagingImages, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(!document.stagingImages)
        try #require(document.session.record.stagedAssets?.count == 1)
    }

    @Test func changedBufferRetainsPastedImageThroughRecoveryAndFileExport() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let drafts = root.appendingPathComponent("drafts")
        let workspace = EditorWorkspace(directory: drafts, store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        let window = attach(document)
        defer { window.close() }
        document.text.textView.insertText("Draft ", replacementRange: NSRange(location: 0, length: 0))
        document.text.onImageData?(png, "image/png")
        document.text.textView.insertText("later", replacementRange: NSRange(location: NSNotFound, length: 0))
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
        window.contentView = resumed.text.scrollView
        window.makeFirstResponder(resumed.text.textView)
        await restored.insertImages(resumed)
        let inserted = "Draft later![Image](\(reference))"
        #expect(resumed.text.source == inserted)
        #expect(resumed.session.record.pendingImageReferences?.isEmpty == true)
        resumed.text.textView.undoManager?.undo()
        #expect(resumed.text.source == "Draft later")
        resumed.text.textView.undoManager?.redo()
        #expect(resumed.text.source == inserted)
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
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active), window = attach(document)
        defer { window.close() }
        document.text.onImageData?(png, "image/png")
        document.text.textView.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: 0, length: 0))
        try await staged(document)
        let source = document.text.source
        #expect(document.text.hasMarkedText)
        await workspace.insertImages(document)
        #expect(document.text.source == source)
        #expect(document.session.record.pendingImageReferences?.count == 1)
        document.text.textView.unmarkText()
        await workspace.insertImages(document)
        #expect(document.text.source.contains("![Image](assets/"))
        #expect(document.session.record.pendingImageReferences?.isEmpty == true)
        await workspace.closeViews()
    }

    @Test func duplicateKeepsFileImagesAndSaveAsRefusesAnUncapturedDestination() async throws {
        _ = NSApplication.shared
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
}
