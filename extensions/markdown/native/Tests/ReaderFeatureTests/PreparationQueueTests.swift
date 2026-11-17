import Testing
import AppKit
import CryptoKit
import WebKit
@testable import MarkdownCore
@testable import ReaderFeature

/// A store in the version-1 layout with one published document.
@MainActor
private struct PreparedStore {
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
}

@MainActor @Suite(.serialized) struct BurstPreparation {
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

    @Test func refreshBurstShowsTheNewestRevision() async throws {
        let store = try PreparedStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(store.reference)
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        var tasks: [Task<Void, Never>] = []
        for revision in 2...6 {
            try store.publish(revision)
            tasks.append(Task { await model.refresh() })
        }
        for task in tasks { await task.value }
        #expect(await wait { model.snapshot?.revision == 6 && !model.isLoadingForCheck })
        #expect(model.update == nil)
        await model.close()
    }
}

@MainActor @Suite struct PreparationQueueBounds {
    /// Work for request 1 blocks until released; other requests return their own value.
    final class Hold: @unchecked Sendable {
        let semaphore = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var ran: [Int] = []
        var order: [Int] { lock.withLock { ran } }
        func work(_ request: Int) -> Int {
            lock.withLock { ran.append(request) }
            if request == 1 { _ = semaphore.wait(timeout: .now() + 5) }
            return request * 10
        }
    }

    private func wait(until condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    @Test func runsOneAtATimeAndKeepsOnlyTheNewestWaitingRequest() async {
        let hold = Hold()
        let queue = PreparationQueue<Int, Int>(work: { hold.work($0) })
        let first = Task { await queue.run(1) }
        #expect(await wait { queue.started == 1 })
        let second = Task { await queue.run(2) }
        #expect(await wait { queue.hasWaiting })
        let third = Task { await queue.run(3) }
        #expect(await wait { queue.replaced == 1 })
        let fourth = Task { await queue.run(4) }
        #expect(await wait { queue.replaced == 2 })
        hold.semaphore.signal()
        #expect(await first.value == 10)
        #expect(await second.value == nil)
        #expect(await third.value == nil)
        #expect(await fourth.value == 40)
        #expect(queue.started == 2)
        #expect(hold.order == [1, 4])
        #expect(await queue.run(5) == 50)
    }

    @Test func discardingReleasesTheWaitingRequest() async {
        let hold = Hold()
        let queue = PreparationQueue<Int, Int>(work: { hold.work($0) })
        let first = Task { await queue.run(1) }
        #expect(await wait { queue.started == 1 })
        let second = Task { await queue.run(2) }
        #expect(await wait { queue.hasWaiting })
        queue.discardWaiting()
        #expect(queue.replaced == 1)
        hold.semaphore.signal()
        #expect(await first.value == 10)
        #expect(await second.value == nil)
        #expect(hold.order == [1])
    }
}
