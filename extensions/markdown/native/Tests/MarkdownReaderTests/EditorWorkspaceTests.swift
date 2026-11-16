import Testing
import AppKit
import SwiftUI
import EditorFeature
import ReaderFeature
@testable import MarkdownReader

private extension DraftStore {
    func holdWrites(_ started: AsyncStream<Void>.Continuation, until release: DispatchSemaphore) {
        started.yield(())
        release.wait()
    }
}

@MainActor @Suite(.serialized) struct EditorWorkspaceLifecycle {
    private func directory() throws -> URL {
        let temporary = ProcessInfo.processInfo.environment["TMPDIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory
        let root = temporary.appendingPathComponent("editor-workspace-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    @Test func quitDeadlineKeepsAConvertedReaderOpenWhileRecoveryIsHeld() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: "Retain this text"))
        let document = try #require(workspace.active)
        let manager = WindowManager(state: ReadingStateStore(directory: nil), platform: CheckRunner.platform(), defaultRoots: [])
        let model = ReaderModel(reference: .file(path: root.appendingPathComponent("reader.md").path), platform: CheckRunner.platform(), state: manager.state)
        let window = NSWindow()
        window.isReleasedWhenClosed = false
        defer { window.close() }
        manager.adopt(window, model: model, workspace: workspace)
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let (started, continuation) = AsyncStream<Void>.makeStream()
        let drafts = workspace.drafts
        let held = Task.detached { await drafts.holdWrites(continuation, until: release) }
        for await _ in started { break }
        continuation.finish()
        let retaining = Task { await manager.retainEditors() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !workspace.closing, ContinuousClock.now < deadline { await Task.yield() }
        #expect(workspace.closing)
        #expect(!document.text.activeTextView.isEditable)
        #expect(manager.editor == nil)
        #expect(manager.refuseQuitBeforeRecovery(retained: false))
        retaining.cancel()
        #expect(!workspace.closing)
        #expect(document.text.activeTextView.isEditable)
        release.signal()
        await held.value
        #expect(!(await retaining.value))
        #expect(!workspace.closing)
        #expect(document.text.activeTextView.isEditable)
        let saved = try await drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(saved.source == "Retain this text")
        await workspace.closeViews()
    }

    @Test func quitDeadlineResumesConvertedReaderWorkspacesWithoutADedicatedEditor() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = WindowManager(state: ReadingStateStore(directory: nil), platform: CheckRunner.platform(), defaultRoots: [])
        var workspaces: [EditorWorkspace] = []
        var windows: [NSWindow] = []
        for index in 0..<2 {
            let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts-\(index)"), store: nil)
            workspace.newScratchpad()
            let document = try #require(workspace.active)
            workspace.closing = true
            document.text.textView.isEditable = false
            document.text.activeTextView.isEditable = false
            let window = NSWindow()
            window.isReleasedWhenClosed = false
            let model = ReaderModel(reference: .file(path: root.appendingPathComponent("reader-\(index).md").path), platform: CheckRunner.platform(), state: manager.state)
            manager.adopt(window, model: model, workspace: workspace)
            workspaces.append(workspace); windows.append(window)
        }
        defer { for window in windows { window.close() } }
        #expect(manager.editor == nil)
        #expect(!manager.refuseQuitBeforeRecovery(retained: true))
        #expect(workspaces.allSatisfy { $0.closing })
        #expect(manager.refuseQuitBeforeRecovery(retained: false))
        for workspace in workspaces {
            #expect(!workspace.closing)
            #expect(workspace.active?.text.activeTextView.isEditable == true)
            #expect(workspace.active?.text.textView.isEditable == true)
            #expect(workspace.notice?.contains("quit deadline") == true)
            await workspace.closeViews()
        }
    }

    @Test func nativeInputUndoAndRecoveryKeepOneBuffer() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 700, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = document.text.scrollView
        window.makeFirstResponder(document.text.textView)
        defer { window.close() }
        let view = document.text.textView
        #expect(view.textLayoutManager != nil)
        view.insertText("# Scratchpad\n\nNative 日本語 👨‍👩‍👧‍👦", replacementRange: NSRange(location: 0, length: 0))
        view.breakUndoCoalescing()
        let typed = document.text.source
        #expect(document.session.record.source == typed)
        view.undoManager?.undo()
        #expect(document.text.source.isEmpty)
        #expect(document.session.record.source.isEmpty)
        view.undoManager?.redo()
        #expect(document.text.source == typed)
        #expect(await workspace.retainAll())
        let saved = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(saved.source == typed)
        await workspace.closeActive()
        #expect(workspace.documents.isEmpty)
        workspace.add(saved.resumed())
        #expect(workspace.active?.text.source == typed)
        #expect(workspace.active?.session.record.branch != saved.branch)
        #expect(await workspace.prepareToClose())
        #expect(workspace.active?.text.textView.isEditable == false)
        workspace.resumeEdits()
        #expect(workspace.active?.text.textView.isEditable == true)
    }

    @Test func presentationModesKeepNativeSourceSelectionAndComposition() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        let source = "# Exact\r\n\r\n日本語 **strong** and `code`.\n"
        workspace.add(DraftRecord(source: source))
        let document = try #require(workspace.active)
        let view = document.text.textView
        let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1000, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: EditorWorkspaceView(workspace: workspace))
        window.orderFrontRegardless()
        defer { window.close() }
        document.text.select(NSRange(location: 2, length: 3))
        let selection = document.text.selectedRange
        for mode in [EditorMode.raw, .styled, .split, .rendered, .styled] {
            document.setMode(mode)
            #expect(document.text.source == source)
            #expect(document.text.generation == 0)
            #expect(document.text.selectedRange == selection)
            #expect(document.text.textView === view)
            #expect(view.textLayoutManager != nil)
        }
        document.text.select(NSRange(location: (source as NSString).length, length: 0))
        view.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(view.hasMarkedText())
        document.setMode(.rendered)
        #expect(document.mode == .styled)
        #expect(document.pendingMode == .rendered)
        view.unmarkText()
        #expect(document.mode == .rendered)
        #expect(document.pendingMode == nil)
        #expect(document.text.source == source + "にほん")
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while document.preview.draftGeneration != document.text.generation, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(document.preview.snapshot?.source == document.text.source)
        #expect(document.preview.snapshot?.revision == nil)
        #expect(document.preview.draftGeneration == document.text.generation)
        await document.close()
    }

    @Test func paneFocusRefusesAnUnattachedSourceWithoutActivating() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        let window = PaneWindow(contentRect: NSRect(x: -20000, y: -20000, width: 900, height: 600), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let active = NSApp.isActive
        #expect(!PaneHost.focusEditor(workspace, in: window))
        #expect(NSApp.isActive == active)
        #expect(!window.isVisible)
        #expect(document.text.textView.window == nil)
        await workspace.closeViews()
    }

    @Test func paneFocusAfterAttachmentPreservesTheFirstNativeCharacter() async throws {
        let app = NSApplication.shared
        let previousPolicy = app.activationPolicy()
        try #require(app.setActivationPolicy(.accessory))
        defer { _ = app.setActivationPolicy(previousPolicy) }
        if !NSRunningApplication.current.isFinishedLaunching { app.finishLaunching() }
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        let window = PaneWindow(contentRect: NSRect(x: -20000, y: -20000, width: 900, height: 600), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: EditorWorkspaceView(workspace: workspace))
        defer { window.close() }
        // Observe before requesting activation so a fast activation cannot be missed.
        let (activations, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let observer = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: NSApp, queue: .main) { _ in
            continuation.yield(())
        }
        defer { NotificationCenter.default.removeObserver(observer); continuation.finish() }
        let deadline = Task {
            try? await Task.sleep(for: .seconds(2))
            continuation.finish()
        }
        defer { deadline.cancel() }
        var focused = PaneHost.focusEditor(workspace, in: window)
        if !focused {
            for await _ in activations {
                focused = PaneHost.focusEditor(workspace, in: window)
                if focused { break }
            }
        }
        guard NSApp.isActive else {
            withKnownIssue("The test host could not become the active app; native focus requires app activation.") {
                #expect(NSApp.isActive)
            }
            await workspace.closeViews()
            return
        }
        #expect(focused)
        #expect(NSApp.isActive)
        #expect(NSApp.keyWindow === window)
        #expect(window.isKeyWindow)
        #expect(window.isMainWindow)
        #expect(document.text.activeTextView.window === window)
        #expect(window.firstResponder === document.text.activeTextView)
        (window.firstResponder as? NSTextView)?.insertText("a", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(document.text.source == "a")
        document.text.textView.insertText("q", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(document.text.source == "aq")
        #expect(window.isVisible)
        await workspace.closeViews()
    }

    @Test func compositionRefusesWorkspaceTransitionsAndSaves() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.newScratchpad()
        let previous = try #require(workspace.active)
        workspace.newScratchpad()
        let active = try #require(workspace.active)
        active.text.textView.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        workspace.select(previous)
        #expect(workspace.active === active)
        workspace.newScratchpad()
        #expect(workspace.documents.count == 2)
        await workspace.library()
        #expect(!workspace.libraryVisible)
        await workspace.showPublishedLibrary()
        #expect(workspace.publishedLibrary == nil)
        await workspace.openReading(.file(path: root.appendingPathComponent("missing.md").path))
        #expect(workspace.reading == nil)
        let target = root.appendingPathComponent("not-saved.md")
        await workspace.saveFile(active, to: target)
        #expect(!FileManager.default.fileExists(atPath: target.path))
        await workspace.savePublished(active)
        #expect(active.session.record.pendingPublication == nil)
        #expect(!(await workspace.prepareToClose()))
        #expect(active.text.textView.hasMarkedText())
        #expect(active.text.textView.isEditable)
        #expect(workspace.notice?.contains("composing") == true)
        active.text.textView.unmarkText()
        #expect(await workspace.prepareToClose())
    }

    @Test func externalFileChangeKeepsTheBaseUntilReviewedRevert() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("external.md")
        try Data("saved source".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        document.text.textView.insertText("my draft", replacementRange: NSRange(location: 0, length: (opened.source as NSString).length))
        try Data("external revision".utf8).write(to: file, options: .atomic)
        document.checkForUpdates()
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while document.session.record.conflict == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(document.session.record.conflict != nil)
        #expect(document.session.record.destination == .file(opened.base))
        #expect(document.text.source == "my draft")
        await workspace.reviewSavedVersion(document)
        let review = try #require(workspace.revisionReview)
        #expect(review.candidate.baseSource == "saved source")
        #expect(review.base.source == "saved source")
        #expect(review.draft.source == "my draft")
        #expect(review.candidate.source == "external revision")
        await workspace.acceptRevision(review)
        #expect(document.text.source == "external revision")
        #expect(!document.session.isDirty)
        #expect(document.session.record.conflict == nil)
        #expect(document.text.textView.undoManager?.canUndo == false)
        let retained = try await workspace.drafts.list()
        #expect(retained.records.contains { $0.source == "my draft" && $0.parentBranch == document.session.record.branch })
        #expect(try String(contentsOf: file, encoding: .utf8) == "external revision")
        await workspace.closeViews()
    }

    @Test func failedRevertRecoveryPreservesTheLiveDraftAndUndo() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("external.md"), blocked = root.appendingPathComponent("blocked")
        try Data("saved".utf8).write(to: file)
        try Data("not a directory".utf8).write(to: blocked)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: blocked, store: nil)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        document.text.textView.insertText("draft", replacementRange: NSRange(location: 0, length: 5))
        await workspace.reviewSavedVersion(document)
        await workspace.acceptRevision(try #require(workspace.revisionReview))
        #expect(document.text.source == "draft")
        #expect(document.text.textView.undoManager?.canUndo == true)
        #expect(document.text.textView.isEditable)
        #expect(workspace.notice?.contains("Replacement did not start") == true)
        await workspace.closeViews()
    }

    @Test func failedRecoveryKeepsTheEditableDocumentOpen() async throws {
        _ = NSApplication.shared
        let root = try directory()
        defer { try? FileManager.default.removeItem(at: root) }
        let blocked = root.appendingPathComponent("not-a-directory")
        try Data("occupied".utf8).write(to: blocked)
        let workspace = EditorWorkspace(directory: blocked, store: nil)
        workspace.newScratchpad()
        let document = try #require(workspace.active)
        document.text.textView.insertText("Retain this draft", replacementRange: NSRange(location: 0, length: 0))
        #expect(!(await workspace.prepareToClose()))
        #expect(document.text.textView.isEditable)
        #expect(!workspace.closing)
        await workspace.closeActive()
        #expect(workspace.active === document)
        #expect(document.session.record.source == "Retain this draft")
        #expect(workspace.notice != nil)
    }
}
