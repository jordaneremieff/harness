import Testing
import AppKit
import CryptoKit
import WebKit
@testable import MarkdownCore
@testable import ReaderFeature

/// A store in the version-1 layout with one published document.
@MainActor
private struct ObservedStore {
    let root: URL
    private let storeId = "fedcba9876543210fedcba9876543210"
    let id = "md-fedcba9876543210fedc"

    init() throws {
        root = try ReadingStateIntake.directory()
        try write(["version": 1, "storeId": storeId], to: root.appendingPathComponent("store.json"))
    }

    var reference: DocumentReference { .stored(root: root.path, storeId: storeId, document: id) }
    var documentDirectory: URL { root.appendingPathComponent("documents/\(id)") }

    private func write(_ value: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    }

    func publish(_ revision: Int) throws {
        let location = documentDirectory.appendingPathComponent("revisions/\(revision)")
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true)
        let source = Data("# Revision \(revision)\n\nText of revision \(revision).\n".utf8)
        let digest = "sha256:" + SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        try source.write(to: location.appendingPathComponent("source.md"))
        let date = "2026-11-14T00:00:00Z"
        try write(["version": 1, "document": id, "revision": revision, "title": "Document", "createdAt": date,
                   "digest": digest, "bytes": source.count, "completeness": ["state": "complete"]],
                  to: location.appendingPathComponent("revision.json"))
        try write(["version": 1, "id": id, "kind": "published", "title": "Document", "createdAt": date,
                   "updatedAt": date, "revision": revision, "digest": digest, "bytes": source.count],
                  to: documentDirectory.appendingPathComponent("document.json"))
    }

    func breakPointer() throws {
        try Data("not a record".utf8).write(to: documentDirectory.appendingPathComponent("document.json"), options: .atomic)
    }
}

@MainActor @Suite(.serialized) struct UpdateObservationHealth {
    private func model(_ reference: DocumentReference) -> ReaderModel {
        ReaderModel(reference: reference, platform: ReaderPlatform(
            copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("test"), application: .failed("test")) }
        ), state: ReadingStateStore(directory: nil), webRoot: ReaderHostFixture.root)
    }

    private func window(_ model: ReaderModel) -> NSWindow {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 800, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        model.page.webView.frame = NSRect(x: 0, y: 0, width: 800, height: 700)
        model.page.webView.autoresizingMask = [.width, .height]
        window.contentView = model.page.webView
        window.orderFrontRegardless()
        return window
    }

    private func wait(until condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await condition()
    }

    private func failed(_ state: UpdateObservation, containing text: String) -> Bool {
        if case .failed(let reason) = state { return reason.contains(text) }
        return false
    }

    @Test func unreadablePointerIsVisibleWhileThePageStays() async throws {
        let store = try ObservedStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(store.reference)
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(model.updates.state == .observed)

        try store.breakPointer()
        #expect(await wait { failed(model.updates.state, containing: "the current revision could not be read") })
        #expect(model.phase == .ready)
        #expect(model.snapshot?.revision == 1)

        try store.publish(2)
        #expect(await wait { model.updates.state == .observed })
        #expect(model.update == .revision(2))
        #expect(model.snapshot?.revision == 1)
        await model.close()
    }

    @Test func removedDocumentFolderFailsVisiblyAndRefreshWatchesAgain() async throws {
        let store = try ObservedStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(store.reference)
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(model.updates.state == .observed)

        let aside = store.root.appendingPathComponent("aside")
        try FileManager.default.moveItem(at: store.documentDirectory, to: aside)
        #expect(await wait { failed(model.updates.state, containing: "could not") })
        #expect(model.snapshot?.revision == 1)

        try FileManager.default.moveItem(at: aside, to: store.documentDirectory)
        try store.publish(2)
        await model.refresh()
        #expect(model.snapshot?.revision == 2)
        #expect(model.updates.state == .observed)

        // The watcher of the restored folder reports the next publication by itself.
        try store.publish(3)
        #expect(await wait { model.update == .revision(3) })
        await model.close()
    }

    @Test func removedPlainFileFailsVisibly() async throws {
        let directory = try ReadingStateIntake.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("notes.md")
        try Data("# Notes\n\nText.\n".utf8).write(to: file)
        let model = model(.file(path: FileAccess.canonicalPath(file.path)))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(model.updates.state == .observed)
        try FileManager.default.removeItem(at: file)
        #expect(await wait { failed(model.updates.state, containing: "the current revision could not be read") })
        #expect(model.phase == .ready)
        await model.close()
    }
}
