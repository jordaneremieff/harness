import Testing
import AppKit
import CryptoKit
import SwiftUI
import WebKit
@testable import MarkdownCore
@testable import ReaderFeature

@MainActor
private struct LifecycleStore {
    let root: URL
    private let storeId = "0123456789abcdef0123456789abcdef"
    private let id = "md-0123456789abcdef0123"

    init() throws {
        root = try ReadingStateIntake.directory()
        try write(["version": 1, "storeId": storeId], to: root.appendingPathComponent("store.json"))
    }

    var reference: DocumentReference { .stored(root: root.path, storeId: storeId, document: id) }

    private func write(_ value: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    }

    func publish(_ revision: Int) throws {
        let document = root.appendingPathComponent("documents/\(id)")
        let location = document.appendingPathComponent("revisions/\(revision)")
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true)
        let paragraphs = (0..<250).map { "Paragraph \($0) has enough text for a stable reading position in a long document." }.joined(separator: "\n\n")
        let source = Data(("# Revision \(revision)\n\n" + paragraphs).utf8)
        let digest = "sha256:" + SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        try source.write(to: location.appendingPathComponent("source.md"))
        let date = "2026-11-14T00:00:00Z"
        try write(["version": 1, "document": id, "revision": revision, "title": "Document", "createdAt": date,
                   "digest": digest, "bytes": source.count, "completeness": ["state": "complete"]],
                  to: location.appendingPathComponent("revision.json"))
        try write(["version": 1, "id": id, "kind": "published", "title": "Document", "createdAt": date,
                   "updatedAt": date, "revision": revision, "digest": digest, "bytes": source.count],
                  to: document.appendingPathComponent("document.json"))
    }

    /// Replaces a revision's source so that it no longer matches its digest.
    func corrupt(_ revision: Int) throws {
        let source = root.appendingPathComponent("documents/\(id)/revisions/\(revision)/source.md")
        try Data("# Changed after publication\n".utf8).write(to: source)
    }
}

@MainActor
private final class LifecycleGate {
    private(set) var reached = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        reached = true
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        released = true
        continuation?.resume()
        continuation = nil
    }
}

@MainActor @Suite(.serialized) struct ReaderLifecycle {
    private func model(reference: DocumentReference, state: ReadingStateStore) -> ReaderModel {
        ReaderModel(reference: reference, platform: ReaderPlatform(
            copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in
                TerminalReturnResult(pane: .unavailable("test"), application: .failed("test"))
            }
        ), state: state)
    }

    private func wait(until condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await condition()
    }

    private func window(_ model: ReaderModel) -> NSWindow {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 800, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ReaderView(model: model, chrome: .embedded(close: {}, release: {})))
        window.orderFrontRegardless()
        return window
    }

    @Test func closingDoesNotWaitForAStateWrite() async throws {
        let directory = try ReadingStateIntake.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = StateWriteGate()
        defer { gate.release() }
        let state = ReadingStateStore(directory: directory, beforeWrite: { gate.wait() })
        state.setPosition(ReadingStateIntake.position("pending", at: 0.1), for: ReadingStateIntake.reference(1))
        state.saveNow()
        var entries = gate.entries.makeAsyncIterator()
        await entries.next()
        let model = model(reference: .file(path: "/notes/test.md"), state: state)
        let start = ContinuousClock.now
        await model.close()
        #expect(start.duration(to: ContinuousClock.now) < .seconds(1))
        #expect(state.hasPendingChanges)
        #expect(state.isSaving)
        gate.release()
        #expect(await state.flush(timeout: 2) == .saved)
    }

    @Test func activeScrollDefersAutomaticReplacementUntilItSettles() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        model.followsLatest = true
        #expect(await wait { !model.isScrollingForCheck })
        let gate = LifecycleGate()
        model.preparationGate = { revision in if revision == 2 { await gate.wait() } }
        try store.publish(2)
        #expect(await wait { gate.reached })
        _ = try await model.page.callJavaScript("window.scrollTo(0, 5000); return true;", contentWorld: PageScript.world)
        model.scrolled()
        let moved = await model.capturePosition()
        gate.release()
        #expect(await wait { !model.isLoadingForCheck })
        #expect(model.isScrollingForCheck)
        #expect(model.snapshot?.revision == 1)
        #expect(await wait { model.snapshot?.revision == 2 && !model.isLoadingForCheck })
        let restored = await model.capturePosition()
        #expect(moved?.blockKey != nil)
        #expect(moved?.blockKey == restored?.blockKey)
        #expect(abs((moved?.fraction ?? 0) - (restored?.fraction ?? 1)) < 0.05)
        await model.close()
    }

    @Test func aChosenOlderRevisionStaysWhileFollowing() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        try store.publish(2)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        model.followsLatest = true
        #expect(model.snapshot?.revision == 2)
        await model.showRevision(1)
        #expect(model.snapshot?.revision == 1)
        model.scrolled()
        try await Task.sleep(for: .milliseconds(800))
        await model.checkForUpdate()
        #expect(model.snapshot?.revision == 1)
        #expect(model.update == .revision(2))
        await model.refresh()
        #expect(model.snapshot?.revision == 2)
        await model.close()
    }

    @Test func aFailedAutomaticLoadIsNotRepeated() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        model.followsLatest = true
        try store.publish(2)
        try store.corrupt(2)
        await model.checkForUpdate()
        #expect(await wait { model.failure != nil && !model.isLoadingForCheck })
        #expect(model.snapshot?.revision == 1)
        model.dismissNotice()
        model.scrolled()
        try await Task.sleep(for: .milliseconds(800))
        await model.checkForUpdate()
        #expect(model.notice == nil)
        #expect(model.snapshot?.revision == 1)
        try store.publish(3)
        await model.checkForUpdate()
        #expect(await wait { model.snapshot?.revision == 3 })
        await model.close()
    }

    @Test(arguments: [false, true])
    func firstInstallReconcilesASinglePublication(followsLatest: Bool) async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        model.followsLatest = followsLatest
        let gate = LifecycleGate()
        model.preparationGate = { revision in if revision == 1 { await gate.wait() } }
        let opening = Task { await model.open(origin: nil) }
        #expect(await wait { gate.reached })
        try store.publish(2)
        gate.release()
        #expect(await wait { followsLatest ? model.snapshot?.revision == 2 : model.update == .revision(2) })
        if !followsLatest { #expect(model.snapshot?.revision == 1) }
        opening.cancel()
        await model.close()
    }

    @Test func scrollDuringPreparationUsesThePositionAtInstallationAndSelectionStillDefers() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        model.followsLatest = true
        #expect(await wait { !model.isScrollingForCheck })
        let gate = LifecycleGate()
        model.preparationGate = { revision in if revision == 2 { await gate.wait() } }
        try store.publish(2)
        #expect(await wait { gate.reached })
        _ = try await model.page.callJavaScript("window.scrollTo(0, 5000); return true;", contentWorld: PageScript.world)
        model.scrolled()
        let moved = await model.capturePosition()
        #expect(await wait { !model.isScrollingForCheck })
        gate.release()
        #expect(await wait { model.snapshot?.revision == 2 && !model.isLoadingForCheck })
        let restored = await model.capturePosition()
        #expect(moved?.blockKey != nil)
        #expect(moved?.blockKey == restored?.blockKey)
        #expect(abs((moved?.fraction ?? 0) - (restored?.fraction ?? 1)) < 0.05)
        #expect((restored?.ratio ?? 0) > 0.1)
        let selectionGate = LifecycleGate()
        model.preparationGate = { revision in if revision == 3 { await selectionGate.wait() } }
        try store.publish(3)
        #expect(await wait { selectionGate.reached })
        _ = try await model.page.callJavaScript("getSelection().selectAllChildren(document.querySelector('p')); return true;", contentWorld: PageScript.world)
        let selected = await model.selectedText()
        #expect(!selected.isEmpty)
        selectionGate.release()
        #expect(await wait { !model.isLoadingForCheck })
        #expect(model.snapshot?.revision == 2)
        #expect(model.update == .revision(3))
        #expect(await model.selectedText() == selected)
        await model.close()
    }

    @Test func firstInstallReconcilesAFileChangedDuringPreparation() async throws {
        let directory = try ReadingStateIntake.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("document.md")
        try Data("# First\n".utf8).write(to: file)
        let model = model(reference: .file(path: file.path), state: ReadingStateStore(directory: nil))
        var prepared = false
        var release: CheckedContinuation<Void, Never>?
        model.preparationGate = { _ in
            prepared = true
            await withCheckedContinuation { release = $0 }
        }
        let opening = Task { await model.open(origin: nil) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !prepared, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(prepared)
        try Data("# Second\n".utf8).write(to: file, options: .atomic)
        release?.resume()
        let displayedDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.isLoadingForCheck, ContinuousClock.now < displayedDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(model.phase == .ready)
        #expect(model.snapshot?.source == "# First\n")
        #expect(model.update == .fileChanged)
        opening.cancel()
        await model.close()
    }

    @Test func scrollingAndFindPreventAutomaticReplacement() async {
        let model = model(reference: .file(path: "/notes/test.md"), state: ReadingStateStore(directory: nil))
        model.scrolled()
        #expect(await model.interacting())
        model.findVisible = true
        #expect(await model.interacting())
        await model.close()
    }
}
