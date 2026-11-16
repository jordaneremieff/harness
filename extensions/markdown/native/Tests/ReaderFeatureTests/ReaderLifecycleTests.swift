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
        let old = Task { await model.displayForCheck(html: "old"); firstReturned = true }
        #expect(await wait { first.reached })
        model.displayNavigationForCheck = { await second.wait() }
        let newer = Task { await model.displayForCheck(html: "new") }
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

    @Test func supersedingOpenDoesNotWaitForImageInspection() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        try store.publish(1)
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        let gate = LifecycleGate()
        defer { gate.release() }
        model.imageInspectionGate = { await gate.wait() }
        let first = Task { await model.open(revision: 1, origin: nil) }
        #expect(await wait { gate.reached })
        #expect(model.phase == .ready)
        #expect(!model.isLoadingForCheck)
        let origin = LaunchOrigin(terminal: "Rex", bundleId: LaunchOrigin.rexBundleId)
        let superseding = Task { await model.open(revision: 1, origin: origin) }
        #expect(await wait { model.launchOrigin == origin })
        #expect(model.phase == .ready && model.snapshot?.revision == 1)
        gate.release()
        await first.value
        await superseding.value
        await model.close()
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

    @Test func outlineNavigationTracksSectionsFiltersAndBoundedReturns() async throws {
        let store = try LifecycleStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let paragraphs = String(repeating: "A paragraph with enough text for a useful section.\n\n", count: 40)
        try store.publish(1, source: "# First\n\nA reference[^note].\n\n" + paragraphs + "## Second\n\n" + paragraphs + "## Third\n\n" + paragraphs + "[^note]: A footnote.\n")
        let model = model(reference: store.reference, state: ReadingStateStore(directory: nil))
        let window = window(model)
        defer { window.close() }
        await model.open(origin: nil)
        #expect(model.activeSection == "first")
        model.outlineQuery = "SECOND"
        #expect(model.filteredOutline.map(\.id) == ["second"])
        model.outlineCompact = true
        model.toggleOutline()
        #expect(model.outlineIsPresented)
        let before = await model.capturePosition()
        await model.scrollTo(anchor: "second")
        #expect(!model.outlinePopoverVisible)
        #expect(model.activeSection == "second")
        #expect(model.canGoBack)
        await model.goBack()
        let returned = await model.capturePosition()
        #expect(returned?.blockKey == before?.blockKey)
        #expect(model.activeSection == "first")
        #expect(!model.canGoBack)
        let footnote = try await model.page.callJavaScript("const link = document.querySelector('.footnote-ref a, a.footnote-ref'); const href = link.getAttribute('href'); link.click(); return href;", contentWorld: PageScript.world) as? String
        #expect(footnote?.hasPrefix("reader-action:jump/") == true)
        #expect(await wait { model.canGoBack || model.notice != nil })
        #expect(model.canGoBack, "Footnote: \(footnote ?? "nil"); notice: \(model.notice?.text ?? "none")")
        await model.goBack()
        #expect(model.activeSection == "first")
        for index in 0..<24 { await model.scrollTo(anchor: index.isMultiple(of: 2) ? "second" : "third") }
        #expect(model.jumpHistory.count == 20)
        await model.scrollTo(anchor: "absent")
        #expect(model.jumpHistory.count == 20)
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
