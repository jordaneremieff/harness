import Testing
import AppKit
import CryptoKit
import WebKit
@testable import MarkdownCore
@testable import ReaderFeature

@MainActor
private struct LifecycleStore {
    let root: URL
    private let storeId = "0123456789abcdef0123456789abcdef"
    private let id = "md-0123456789abcdef0123"

    init() throws {
        let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        root = native.appendingPathComponent(".build/reader-lifecycle-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try write(["version": 1, "storeId": storeId], to: root.appendingPathComponent("store.json"))
    }

    var reference: DocumentReference { .stored(root: root.path, storeId: storeId, document: id) }

    private func write(_ value: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
    }

    func publish(_ revision: Int, source customSource: String? = nil) throws {
        let document = root.appendingPathComponent("documents/\(id)")
        let location = document.appendingPathComponent("revisions/\(revision)")
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true)
        let paragraphs = (0..<250).map { "Paragraph \($0) has enough text for a stable reading position in a long document." }.joined(separator: "\n\n")
        let source = Data((customSource ?? ("# Revision \(revision)\n\n" + paragraphs)).utf8)
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
        ), state: state, webRoot: ReaderHostFixture.root)
    }

    private func reportState(_ model: ReaderModel, blockStart: Int = 0, offsetY: Double = 0, selection: String? = nil) async throws {
        var fields: [String: Any] = ["v": 1, "type": "state", "lock": model.lock.rawValue, "overlay": NSNull(),
                                     "canUndo": false, "canRedo": false, "canBack": false, "canForward": false,
                                     "hasSelection": selection != nil, "findOpen": false,
                                     "scroll": ["blockStart": blockStart, "offsetY": offsetY]]
        if let selection { fields["selection"] = ["text": selection, "start": 0, "end": min(model.source.utf16.count, selection.utf16.count)] }
        _ = try await model.receive(ReaderBridgeCodec.decode(body: fields))
    }

    private func wait(until condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await condition()
    }

    @Test func textSizeBridgeUsesMultipliersAndStoresTheNearestStep() async throws {
        _ = NSApplication.shared
        let state = ReadingStateStore(directory: nil)
        state.settings = PageSettings(textSize: 3)
        let reader = model(reference: .file(path: "draft-host"), state: state)
        try await reader.page.load()
        _ = try await reader.page.callJavaScript("const receive = reader.receive; reader.receive = m => { if (m.type === 'document') window.initialSettings = m.settings; if (m.type === 'command' && m.name === 'applySettings') window.settingsPatch = m.args; return receive(m); };")
        try await reader.sendDocument(source: "Text", generation: 0)
        #expect(try await reader.page.callJavaScript("return window.initialSettings.textSize;") as? Double == 1)
        #expect(try await reader.page.callJavaScript("return window.initialSettings.textSizeSteps;") as? [Double] == PageSettings.textSizeMultipliers)
        reader.settings = PageSettings(textSize: 6)
        #expect(await wait { (try? await reader.page.callJavaScript("return window.settingsPatch?.textSize;")) as? Double == PageSettings(textSize: 6).textSizeMultiplier })
        let reply = try await reader.page.callJavaScript("return await window.webkit.messageHandlers.reader.postMessage({v:1,type:'command',id:'text-size',name:'saveSettings',args:{patch:{textSize:1.11}}});") as? [String: Any]
        #expect(reply?["ok"] as? Bool == true)
        #expect(reader.settings.textSize == 5)
        #expect(state.settings.textSize == 5)
        await reader.close()
    }

    @Test func aShellReloadStaysBusyUntilTheDocumentIsAccepted() async throws {
        _ = NSApplication.shared
        let reader = model(reference: .file(path: "draft-host"), state: ReadingStateStore(directory: nil))
        var transitions: [Bool] = []
        reader.page.onDocumentReady = { transitions.append($0) }
        try await reader.sendDocument(source: "Text", generation: 0)
        #expect(reader.page.documentReady)
        try await reader.page.reload()
        #expect(reader.page.isReady)
        #expect(!reader.page.documentReady)
        try await reader.sendDocument(source: "Text", generation: 0)
        #expect(reader.page.documentReady)
        await reader.close()
        #expect(!reader.page.documentReady)
        #expect(transitions == [true, false, true, false])
    }

    @Test func oversizedSnapshotSwitchKeepsTheSharedReaderOnItsAcceptedDocument() async throws {
        _ = NSApplication.shared
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1, source: "# Kept\n\nThe current document.\n")
        let accepted = try DocumentLoader.load(store.reference)
        let rejectedURL = store.root.appendingPathComponent("oversized-render.md")
        // Repeated paragraphs stay under the source limit but their escaped HTML, keys and
        // source maps exceed the separate rendered block budget.
        let paragraph = String(repeating: "&", count: 31) + "\n\n"
        let largeSource = String(repeating: paragraph, count: 60_000)
        try Data(largeSource.utf8).write(to: rejectedURL)
        let rejected = try DocumentLoader.load(.file(path: rejectedURL.path))
        try #require(rejected.bytes < Limits.sourceBytes)

        let state = ReadingStateStore(directory: nil)
        let reader = model(reference: accepted.reference, state: state)
        reader.live = true
        state.setPosition(ReadingPosition(blockStart: 0, offsetY: 14, revision: 1), for: accepted.reference)
        try await reader.showSnapshot(accepted)
        try #require(reader.page.documentReady)
        let oldPageState = try #require(reader.pageState)
        let oldBlocks = try #require(reader.rendered?.blocks)
        _ = try await reader.page.callJavaScript("window.deliveries = 0; const receive = reader.receive; reader.receive = m => { if (m.type === 'document') window.deliveries++; return receive(m); };")

        do {
            try await reader.showSnapshot(rejected)
            Issue.record("The bridge accepted an oversized rendering")
        } catch let error as ReaderBridgeError {
            #expect(error == .oversized)
        }
        #expect(reader.reference == accepted.reference)
        #expect(reader.snapshot?.digest == accepted.digest)
        #expect(reader.source == accepted.source)
        #expect(reader.rendered?.blocks == oldBlocks)
        #expect(reader.pageState == oldPageState)
        #expect(reader.lastRestore == .block)
        #expect(reader.page.documentReady)
        #expect(try await reader.page.callJavaScript("return window.deliveries;") as? Int == 0)
        #expect(state.recents.map(\.reference) == [accepted.reference])
        #expect(state.position(for: rejected.reference) == nil)

        try store.publish(2)
        #expect(await wait { reader.update == .revision(2) })
        let nextURL = store.root.appendingPathComponent("next.md")
        try Data("# Next\n".utf8).write(to: nextURL)
        let next = try DocumentLoader.load(.file(path: nextURL.path))
        try await reader.showSnapshot(next)
        #expect(reader.reference == next.reference)
        #expect(reader.source == next.source)
        #expect(reader.page.documentReady)
        #expect(try await reader.page.callJavaScript("return window.deliveries;") as? Int == 1)
        #expect(state.position(for: accepted.reference)?.offsetY == 14)
        await reader.close()
    }

    @Test func draftMirrorUpdatesKeepExactBytesWithoutAReplacementDocument() async throws {
        _ = NSApplication.shared
        let state = ReadingStateStore(directory: nil)
        let id = UUID()
        state.setDraftLock(.reading, for: id.uuidString)
        let reader = model(reference: .file(path: "draft-host"), state: state)
        try await reader.sendDocument(source: "# Draft\n\nCafé\n", generation: 7,
                                      meta: ["documentId": id.uuidString, "kind": "draft", "capturedSource": false], draftId: id)
        #expect(reader.phase == .ready)
        #expect(reader.isDraft)
        #expect(reader.draftGeneration == 7)
        #expect(reader.lock == .reading)
        _ = try await reader.page.callJavaScript("window.replacements = 0; const receive = reader.receive; reader.receive = m => { if (m.type === 'document') window.replacements++; return receive(m); };")
        let exact = "# Draft\r\n\r\nCafe\u{301}\r\n"
        try await reader.acceptSource(source: exact, generation: 8)
        #expect(reader.source.utf8.elementsEqual(exact.utf8))
        #expect(reader.sourceGeneration == 8)
        #expect(reader.draftGeneration == 8)
        #expect(try await reader.page.callJavaScript("return window.replacements;") as? Int == 0)
        await reader.close()
    }

    @Test func editIntentOverridesDraftLockButCapturedSourcesStayReading() async throws {
        _ = NSApplication.shared
        let state = ReadingStateStore(directory: nil)
        let id = UUID()
        state.setDraftLock(.reading, for: id.uuidString)
        let draft = model(reference: .file(path: "draft-host"), state: state)
        try await draft.sendDocument(source: "Text", generation: 0,
                                     meta: ["documentId": id.uuidString, "kind": "published", "capturedSource": false], initialLock: .writing, draftId: id)
        #expect(draft.lock == .writing)
        await draft.close()
        let captured = model(reference: .file(path: "capture-host"), state: state)
        try await captured.sendDocument(source: "Text", generation: 0,
                                        meta: ["documentId": "capture", "kind": "file", "capturedSource": true], initialLock: .writing)
        #expect(captured.lock == .reading)
        await captured.close()
    }

    @Test func annotationReadsBoundedPageSelectionWithoutAWindow() async throws {
        _ = NSApplication.shared
        let reader = model(reference: .file(path: "annotation-draft"), state: ReadingStateStore(directory: nil))
        await reader.openDraft(source: "# Title\n\nExact **bold** 日本語\n", generation: 1, title: "Annotation", resolver: NoAssetResolver())
        #expect(reader.phase == .ready)
        try await reportState(reader, selection: "Exact bold 日本語")
        #expect(await reader.annotationSelection() == "Exact bold 日本語")
        try await reportState(reader, selection: String(repeating: "x", count: 8193))
        #expect(await reader.annotationSelection() == nil)
        await reader.close()
    }

    private func window(_ model: ReaderModel) -> NSWindow {
        _ = NSApplication.shared
        let size = NSSize(width: 800, height: 700)
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -20000, y: -20000), size: size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let webView = model.page.webView
        webView.frame = NSRect(origin: .zero, size: size)
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.orderFrontRegardless()
        return window
    }

    @Test func privateDraftPreviewKeepsLastGoodSourceAndNoReadingCacheIdentity() async {
        let state = ReadingStateStore(directory: nil)
        let model = model(reference: .file(path: "/draft-preview-not-a-file"), state: state)
        let window = window(model)
        defer { window.close() }
        await model.openDraft(source: "", generation: 0, title: "Scratchpad", resolver: NoAssetResolver())
        #expect(model.phase == .ready)
        #expect(model.snapshot?.source == "")
        #expect(model.snapshot?.revision == nil)
        #expect(model.draftGeneration == 0)
        #expect(state.recents.isEmpty)
        await model.openDraft(source: "# Draft\n\nExact **source**.\n", generation: 1, title: "Scratchpad", resolver: NoAssetResolver())
        #expect(model.snapshot?.source == "# Draft\n\nExact **source**.\n")
        #expect(model.draftGeneration == 1)
        await model.openDraft(source: String(repeating: "x", count: Limits.sourceBytes + 1), generation: 2, title: "Too large", resolver: NoAssetResolver())
        #expect(model.snapshot?.source == "# Draft\n\nExact **source**.\n")
        #expect(model.draftGeneration == 1)
        #expect(model.failure != nil)
        await model.refresh()
        #expect(model.snapshot?.source == "# Draft\n\nExact **source**.\n")
        #expect(state.recents.isEmpty)
        await model.close()
    }

    @Test func appContentWorldStaysAliveBetweenDOMCalls() {
        weak var observed: WKContentWorld?
        autoreleasepool { observed = PageScript.world }
        #expect(observed != nil)
        #expect(observed === PageScript.world)
    }

    @Test func aNewLoadReleasesASupersededDisplayEvenWhenNavigationStaysOpen() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        try store.publish(2)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(revision: 1, origin: nil)
        let held = LifecycleGate()
        defer { held.release() }
        model.displayNavigationForCheck = { await held.wait() }
        var returned = false
        let obsolete = Task { await model.open(revision: 2, origin: nil); returned = true }
        #expect(await wait { held.reached })
        #expect(model.isDisplayingForCheck)
        model.displayNavigationForCheck = nil
        await model.open(revision: 1, origin: nil)
        #expect(await wait { returned })
        #expect(model.snapshot?.revision == 1)
        #expect(model.failure == nil)
        #expect(!model.isDisplayingForCheck)
        // The old navigation has not ended; the model's caller has already returned.
        await obsolete.value
        held.release()
        await model.close()
    }

    @Test func aNewDisplayOwnsExpectingLoadUntilItsOwnNavigationEnds() async throws {
        let model = model(reference: .file(path: "/notes/test.md"), state: ReadingStateStore(directory: nil))
        let first = LifecycleGate()
        let second = LifecycleGate()
        defer { first.release(); second.release() }
        model.displayNavigationForCheck = { await first.wait() }
        var firstReturned = false
        let old = Task { await model.waitForDisplayForCheck(); firstReturned = true }
        #expect(await wait { first.reached })
        model.displayNavigationForCheck = { await second.wait() }
        let newer = Task { await model.waitForDisplayForCheck() }
        #expect(await wait { second.reached && firstReturned })
        #expect(model.isDisplayingForCheck)
        second.release()
        await newer.value
        #expect(!model.isDisplayingForCheck)
        await old.value
        await model.close()
    }

    @Test func decodedImageEvidenceSurvivesSeparateDOMCalls() async throws {
        let directory = try ReadingStateIntake.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let svg = Data("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"30\"><rect width=\"40\" height=\"30\" fill=\"green\"/></svg>".utf8)
        try svg.write(to: directory.appendingPathComponent("diagram.svg"))
        let source = directory.appendingPathComponent("document.md")
        try Data("![Diagram](diagram.svg)".utf8).write(to: source)
        let model = model(reference: .file(path: source.path), state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(revision: nil, origin: nil)
        let first = await model.inspectImages()
        _ = try? await model.page.callJavaScript("return [...document.images].map(i => i.complete && i.naturalWidth > 0);", contentWorld: PageScript.world)
        let second = await model.inspectImages()
        #expect(first.count == 1 && first.first?.displayed == true)
        #expect(second.count == 1 && second.first?.displayed == true)
        #expect(second.first?.served == true && second.first?.failure == nil)
        await model.close()
    }

    @Test func closingSavesTheLatestReportedScrollWithoutAReadyWebPage() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let state = ReadingStateStore(directory: nil)
        let model = model(reference: store.reference, state: state)
        model.displayNavigationForCheck = {}
        await model.open(origin: nil)
        let start = try #require(model.rendered?.blocks.dropFirst(2).first?.start)
        try await reportState(model, blockStart: start, offsetY: -27.25)
        #expect(!model.page.isReady)
        let closing = ContinuousClock.now
        await model.close()
        #expect(closing.duration(to: ContinuousClock.now) < .seconds(1))
        #expect(state.position(for: store.reference)?.blockStart == start)
        #expect(state.position(for: store.reference)?.offsetY == -27.25)
        #expect(state.position(for: store.reference)?.revision == 1)
    }

    @Test func openingDeliversTheSavedSourcePositionThroughTheDocument() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let source = "# Title\n\nParagraph.\n\nAnother.\n"
        try store.publish(1, source: source)
        let state = ReadingStateStore(directory: nil)
        let start = (source as NSString).range(of: "Another.").location
        state.setPosition(ReadingPosition(blockStart: start, offsetY: 7.125, revision: 1), for: store.reference)
        let model = model(reference: store.reference, state: state)
        try await model.page.load()
        _ = try await model.page.callJavaScript("const receive = reader.receive; reader.receive = m => { if (m.type === 'document') window.deliveredPosition = m.position; return receive(m); };")
        await model.open(origin: nil)
        let position = try await model.page.callJavaScript("return window.deliveredPosition;") as? [String: Any]
        #expect(position?["blockStart"] as? Int == start)
        #expect(position?["offsetY"] as? Double == 7.125)
        #expect(model.cachedReadingPosition?.blockStart == start)
        #expect(model.cachedReadingPosition?.offsetY == 7.125)
        await model.close()
    }

    @Test func draftRecoveryRestoresReportedPositionWithoutAReadingCacheEntry() async throws {
        _ = NSApplication.shared
        let state = ReadingStateStore(directory: nil)
        let model = model(reference: .file(path: "draft-position"), state: state)
        let source = "# Draft\n\nAnother paragraph.\n"
        let id = UUID()
        try await model.sendDocument(source: source, generation: 0,
            meta: ["kind": "draft", "title": "Draft", "capturedSource": false], initialLock: .writing, draftId: id)
        let start = (source as NSString).range(of: "Another paragraph.").location
        try await reportState(model, blockStart: start, offsetY: -11.5)
        await model.recoverContentProcess()
        #expect(model.recoveries == 1)
        #expect(model.cachedReadingPosition?.blockStart == start)
        #expect(model.cachedReadingPosition?.offsetY == -11.5)
        #expect(state.position(for: model.reference) == nil)
        try await model.sendDocument(source: source, generation: 0,
            meta: ["kind": "draft", "title": "Another draft", "capturedSource": false], initialLock: .writing, draftId: UUID())
        #expect(model.cachedReadingPosition?.blockStart == 0)
        #expect(model.cachedReadingPosition?.offsetY == 0)
        await model.close()
        #expect(state.position(for: model.reference) == nil)
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
        let start = try #require(model.rendered?.blocks.dropFirst(120).first?.start)
        try await reportState(model, blockStart: start, offsetY: -18.5)
        let moved = model.cachedReadingPosition
        gate.release()
        #expect(await wait { !model.isLoadingForCheck })
        #expect(model.isScrollingForCheck)
        #expect(model.snapshot?.revision == 1)
        #expect(await wait { model.snapshot?.revision == 2 && !model.isLoadingForCheck })
        let restored = model.cachedReadingPosition
        #expect(moved?.blockStart == start)
        #expect(restored?.blockStart == start)
        #expect(restored?.offsetY == -18.5)
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

    @Test func aNewRevisionFollowsAfterAnEarlierAutomaticAttemptFails() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(await wait { !model.isScrollingForCheck })
        model.followsLatest = true
        let gate = LifecycleGate()
        defer { gate.release() }
        var targets: [Int?] = []
        model.preparationGate = { revision in
            targets.append(revision)
            if revision == 2 { await gate.wait() }
        }
        try store.publish(2)
        try store.corrupt(2)
        #expect(await wait { gate.reached })
        try store.publish(3)
        await model.checkForUpdate()
        #expect(model.latestRevision == 3)
        gate.release()
        #expect(await wait { model.snapshot?.revision == 3 && !model.isLoadingForCheck })
        #expect(targets == [2, 3])
        await model.close()
    }

    @Test func showLatestFromAPageThatTheModelHostsOpensTheNewestRevision() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(model.snapshot?.revision == 1)
        try store.publish(2)
        let message = try ReaderBridgeCodec.decode(body: ["v": 1, "type": "command", "id": "latest", "name": "showLatest"])
        _ = try await model.receive(message)
        #expect(await wait { model.snapshot?.revision == 2 })
        await model.close()
    }

    @Test(arguments: [false, true])
    func manualRefreshReconcilesAPublicationDuringPreparation(followsLatest: Bool) async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(await wait { !model.isScrollingForCheck })
        let gate = LifecycleGate()
        defer { gate.release() }
        model.preparationGate = { revision in if revision == 2 { await gate.wait() } }
        try store.publish(2)
        let refreshing = Task { await model.refresh() }
        #expect(await wait { gate.reached })
        model.followsLatest = followsLatest
        try store.publish(3)
        await model.checkForUpdate()
        gate.release()
        await refreshing.value
        #expect(await wait { followsLatest ? model.snapshot?.revision == 3 : model.update == .revision(3) })
        if !followsLatest { #expect(model.snapshot?.revision == 2) }
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
        let start = try #require(model.rendered?.blocks.dropFirst(120).first?.start)
        try await reportState(model, blockStart: start, offsetY: 18.5)
        let moved = model.cachedReadingPosition
        #expect(await wait { !model.isScrollingForCheck })
        gate.release()
        #expect(await wait { model.snapshot?.revision == 2 && !model.isLoadingForCheck })
        let restored = model.cachedReadingPosition
        #expect(moved?.blockStart == start)
        #expect(restored?.blockStart == start)
        #expect(restored?.offsetY == 18.5)
        let selectionGate = LifecycleGate()
        model.preparationGate = { revision in if revision == 3 { await selectionGate.wait() } }
        try store.publish(3)
        #expect(await wait { selectionGate.reached })
        _ = try await model.page.callJavaScript("getSelection().selectAllChildren(document.querySelector('p')); return true;", contentWorld: PageScript.world)
        let selected = await model.selectedText()
        #expect(!selected.isEmpty)
        #expect(await wait { model.pageState?.hasSelection == true })
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
        await opening.value
        #expect(model.phase == .ready)
        #expect(model.snapshot?.source == "# First\n")
        #expect(model.update == .fileChanged)
        await model.close()
    }

    @Test func visitingAnOlderRevisionDoesNotPinAReopenedReader() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        try store.publish(2)
        let state = ReadingStateStore(directory: nil)
        let first = model(reference: store.reference, state: state)
        let window = window(first)
        defer { window.close() }
        await first.open(origin: nil)
        first.followsLatest = true
        await first.showRevision(1)
        #expect(first.readingStatus.contains("selected"))
        await first.close()
        let reopened = model(reference: store.reference, state: state)
        await reopened.open(origin: nil)
        #expect(reopened.snapshot?.revision == 2)
        await reopened.close()
    }

    @Test func sourceDefersFollowingAndManualRefreshKeepsSource() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let state = ReadingStateStore(directory: nil)
        let model = model(reference: store.reference, state: state)
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        model.followsLatest = true
        await model.toggleSource()
        #expect(model.showingSource)
        #expect(await model.interacting())
        _ = try await model.page.callJavaScript("getSelection().selectAllChildren(document.querySelector('.source')); return true;", contentWorld: PageScript.world)
        let selection = await model.selectedText()
        try store.publish(2)
        await model.checkForUpdate()
        #expect(model.snapshot?.revision == 1)
        #expect(model.update == .revision(2))
        #expect(await model.selectedText() == selection)
        #expect(model.readingStatus.contains("deferred"))
        await model.refresh()
        #expect(model.snapshot?.revision == 2)
        #expect(model.showingSource)
        #expect(try await model.page.callJavaScript("return document.querySelector('.source').textContent;", contentWorld: PageScript.world) as? String == model.snapshot?.source)
        await model.toggleSource()
        #expect(!model.showingSource)
        #expect(model.readingStatus.contains("Following latest"))
        await model.close()
    }

    @Test func sourceChoiceDuringAutomaticPreparationDefersInstallation() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(await wait { !model.isScrollingForCheck })
        model.followsLatest = true
        let gate = LifecycleGate()
        defer { gate.release() }
        model.preparationGate = { revision in if revision == 2 { await gate.wait() } }
        try store.publish(2)
        #expect(await wait { gate.reached })
        await model.toggleSource()
        gate.release()
        #expect(await wait { !model.isLoadingForCheck })
        #expect(model.snapshot?.revision == 1)
        #expect(model.showingSource)
        #expect(model.update == .revision(2))
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
