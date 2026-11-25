import AppKit
import Darwin
import EditorFeature
import NativePane
import OSLog
import MarkdownCore
import ReaderFeature
import WebKit

let paneLog = Logger(subsystem: "local.harness.markdown-reader", category: "pane")

/// Pane mode: the reader runs as the program of a terminal pane and shows its window exactly over
/// that pane. The terminal keeps a short placeholder with a marker that lets the process find
/// its own pane on screen; the document itself is shown and read only in the reader window.
///
/// The process belongs to its pane. Closing the pane ends the reader; closing the reader ends the
/// program with status zero, so a pane that closes on success closes with it. The document, its
/// revisions and the reading position live outside the process and survive it.
///
/// `:open <document ID>` typed into the pane shows another document of the same store in the same
/// window: the reader saves the shown document's position, then opens the other one at its saved
/// position. The pane, its placement and its ownership stay as they are.
@MainActor
final class PaneHost {
    private(set) var model: ReaderModel
    private(set) var workspace: EditorWorkspace?
    var onWorkspaceChange: ((NSWindow, EditorWorkspace) -> Void)?
    private var retaining = false
    private var lostTerminal = false
    private var editorFocusPending = false
    let state: ReadingStateStore
    private let terminal: PaneTerminal
    /// Runs after the pane shows another document, so that menu actions reach its model.
    private var commandLine: String?
    private var message: String?
    private var opening = false
    private var observation = 0
    private let build = PaneHost.buildIdentity()
    private let overlay = PaneOverlay(background: { ReaderSurface.paperColour }, logger: paneLog)
    private var anchor: TerminalAnchor { overlay.anchor }
    private var window: PaneWindow { overlay.window }
    private var content: PaneContentView { overlay.content }
    private var surface: ReaderSurface?
    private var ending = false
    private var initialConnectionDeadline: Task<Void, Never>?
    private var bootFailure: String?

    init(model: ReaderModel, state: ReadingStateStore, terminal: PaneTerminal, workspace: EditorWorkspace? = nil) {
        self.model = model
        self.state = state
        self.terminal = terminal
        self.workspace = workspace
        editorFocusPending = workspace?.active != nil
    }

    func start(revision: Int? = nil, digest: String? = nil, origin: LaunchOrigin? = nil,
               startupDeadline: DispatchTime? = nil) -> NSWindow {
        model.followsLatest = revision == nil
        installSurface(model)
        window.onClose = { [weak self] in self?.end(status: 0) }
        window.onCancel = { [weak self] in self?.surface?.sendCommand("escape") }
        terminal.enter()
        terminal.onInput = { [weak self] events in self?.input(events) }
        terminal.onResize = { [weak self] in
            self?.draw()
            self?.anchor.refresh()
        }
        terminal.onHangUp = { [weak self] in self?.end(status: 0, terminalGone: true) }
        terminal.onTerminate = { [weak self] in self?.end(status: 0) }
        terminal.start()
        draw()
        overlay.onChange = { [weak self] in self?.draw() }
        overlay.start()
        if let startupDeadline {
            initialConnectionDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(Self.seconds(until: startupDeadline))) } catch { return }
                self?.checkInitialView(deadline: true)
            }
        }
        observePhase()
        if let workspace { connect(workspace) }
        if workspace == nil || workspace?.reading === model {
            Task { await model.open(revision: revision, digest: digest, origin: origin) }
        }
        return window
    }

    // MARK: - Window

    private func installSurface(_ model: ReaderModel) {
        surface?.removeFromSuperview()
        let next = ReaderSurface(model: model, state: state, chrome: "pane", workspace: workspace)
        next.frame = content.bounds
        next.autoresizingMask = [.width, .height]
        next.onClose = { [weak self] in self?.end(status: 0) }
        next.onReturnFocus = { [weak self] in self?.releaseFocus() }
        next.onWorkspace = { [weak self] workspace in
            guard let self else { return }
            self.workspace = workspace
            self.connect(workspace)
            self.onWorkspaceChange?(self.window, workspace)
        }
        content.addSubview(next)
        surface = next
    }

    private func connect(_ workspace: EditorWorkspace) {
        workspace.onClose = { [weak self] in self?.end(status: 0) }
        workspace.onRelease = { [weak self] in self?.releaseFocus() }
        workspace.onEditorFocus = { [weak self] in
            guard let self else { return }
            self.editorFocusPending = true
            self.focusPendingEditor()
        }
    }

    func newScratchpad(showDrafts: Bool = false, showLibrary: Bool = false) {
        guard let workspace = workspace ?? surface?.ensureWorkspace() else { return }
        if showLibrary || showDrafts {
            surface?.sendCommand("showLibrary", args: ["collection": showDrafts ? "drafts" : "published"])
        } else { workspace.newScratchpad() }
        observePhase(); draw()
    }

    /// Loading a document never claims keyboard focus from its terminal.
    func focusPendingEditor() { editorFocusPending = false }

    @discardableResult static func focusEditor(_ workspace: EditorWorkspace, in window: NSWindow) -> Bool {
        guard let surface = (window.contentView as? ReaderSurface) ?? window.contentView?.subviews.compactMap({ $0 as? ReaderSurface }).first else { return false }
        return window.makeFirstResponder(surface.model.page.webView)
    }

    private func releaseFocus() { overlay.releaseFocus() }

    // MARK: - Terminal

    private func input(_ events: [PaneInput.Event]) {
        for event in events {
            switch event {
            case .quit:
                end(status: 0)
                return
            case .focus:
                message = nil
                if window.isVisible { window.makeKeyAndOrderFront(nil) }
            case .line(let line):
                commandLine = line
                if line != nil { message = nil }
            case .command(let text):
                run(PaneCommand(text))
            }
        }
        draw()
    }

    private func run(_ command: PaneCommand) {
        switch command {
        case .open(let document):
            open(document)
        case .unknown(let text):
            message = "Unknown command \"\(text)\". Use :open <document ID>."
        }
    }

    /// Shows another document of this store in the pane. The shown document's position is saved
    /// before the other one opens at its saved position; a document that cannot be read leaves the
    /// shown one in place. Opening the shown document again shows its latest revision.
    private func open(_ document: String) {
        guard !ending, !opening else { return }
        guard initialConnectionDeadline == nil else { message = "Wait for the initial reader connection before opening another document."; return }
        guard PaneCommand.isDocumentIdentity(document) else {
            message = "\(document) is not a document ID (md- and 20 hexadecimal digits)."
            return
        }
        guard let workspace = workspace ?? surface?.ensureWorkspace() else { return }
        opening = true; message = "Opening \(document)…"
        Task { @MainActor in
            let result = await workspace.readStored(document, followsLatest: true)
            opening = false
            guard !ending else { return }
            switch result {
            case .shown: message = nil
            case .failed(let reason), .busy(let reason): message = "\(document) cannot be shown: \(reason)"
            }
            observePhase(); draw()
        }
    }

    private var displayedDraft: WorkingDocument? {
        guard let workspace, workspace.reading == nil, !workspace.libraryVisible, workspace.publishedLibrary == nil else { return nil }
        return workspace.active
    }

    private var displayedReader: ReaderModel? {
        guard let workspace else { return model }
        guard !workspace.libraryVisible, workspace.publishedLibrary == nil else { return nil }
        return workspace.reading ?? displayedDraft?.preview
    }

    /// Redraws the placeholder whenever the shown model's phase or revision changes. A model that
    /// the pane no longer shows ends its observation.
    private func checkInitialView(deadline: Bool = false) {
        guard initialConnectionDeadline != nil, !ending, bootFailure == nil else { return }
        let client = workspace?.collaboration
        if client?.connectedOnce == true {
            initialConnectionDeadline?.cancel(); initialConnectionDeadline = nil
            return
        }
        let failure: String?
        if case .failed(let reason) = displayedReader?.phase { failure = "The document could not be opened: \(reason)" }
        else if let reason = client?.initialConnectionFailure { failure = reason }
        else if deadline { failure = "The reader did not confirm a rendered document before the startup deadline." }
        else { failure = nil }
        if let failure {
            bootFailure = failure
            end(status: 1)
        }
    }

    private func observePhase() {
        checkInitialView()
        observation += 1
        let current = observation
        withObservationTracking {
            _ = displayedDraft?.session.record.generation
            _ = displayedDraft?.session.record.title
            _ = workspace?.notice
            _ = workspace?.collaboration?.connectedOnce
            _ = workspace?.collaboration?.connectionStatus
            _ = workspace?.collaboration?.initialConnectionFailure
            _ = displayedReader?.phase
            _ = displayedReader?.snapshot?.revision
            _ = displayedReader?.latestRevision
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.observation == current else { return }
                self.draw()
                self.observePhase()
            }
        }
    }

    private func draw() {
        let shown = displayedReader
        let title = displayedDraft?.session.record.displayTitle ?? shown?.displayTitle ?? (workspace != nil ? "Markdown Workspace" : "Opening the document")
        var status: String
        switch anchor.status {
        case .placed(let shown) where !shown.coveredEntirely: status = "Shown in the reader window over this pane."
        case .placed, .concealed: status = "The reader window is hidden while this pane is covered or not on screen."
        case .searching: status = "Looking for this pane on screen."
        case .untrusted: status = "This terminal cannot place the reader over its pane: the program has no accessibility access."
        }
        if let client = workspace?.collaboration { status = client.connectionStatus + ". " + status }
        if case .failed(let reason) = shown?.phase { status = "The document could not be opened: \(reason)" }
        if let notice = workspace?.notice { status = notice + " " + status }
        if let message { status = message + " " + status }
        terminal.draw(title: title, identity: identity(), status: status, keys: "q closes the reader. :open <document ID> shows another document here. Another key moves the keyboard to the reader.", command: commandLine, marker: anchor.marker)
    }

    /// The shown document, revision and reader build, so that an inspection of the pane names
    /// what it shows.
    private func identity() -> String {
        var parts: [String] = []
        if let document = displayedDraft {
            parts.append("draft \(document.session.record.id.uuidString)")
            parts.append("generation \(document.session.record.generation)")
        } else if let shown = displayedReader {
            if case .stored(_, _, let document) = shown.reference { parts.append(document) }
            if let revision = shown.snapshot?.revision {
                let latest = shown.latestRevision ?? revision
                parts.append(latest > revision ? "revision \(revision); revision \(latest) is available" : "revision \(revision) of \(latest)")
            }
        }
        if let build { parts.append("reader build \(build)") }
        return parts.joined(separator: " · ")
    }

    /// The first twelve hexadecimal digits of the bundle's source digest, when the bundle has one.
    private static func buildIdentity() -> String? {
        guard let url = Bundle.main.url(forResource: "build", withExtension: "json"),
              let data = try? Data(contentsOf: url), data.count <= 16384,
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let digest = record["sourceDigest"] as? String, digest.hasPrefix("sha256:") else { return nil }
        return String(digest.dropFirst(7).prefix(12))
    }

    // MARK: - Ending

    /// Captures the reading position, saves the pending reading state, restores the terminal and
    /// ends the process. Closing the reader ends only this pane's program; the document and other
    /// readers are not affected. Every wait has a bound on the monotonic clock: the capture half a
    /// second, capture and save together one second, and each write to the terminal a fifth of a
    /// second, so a stalled lock, file system, terminal or error pipe never keeps the process
    /// alive. The exit status is the caller's when the state was saved or had nothing to save, and
    /// at least 1 otherwise, with one line on standard error that says whether the position was
    /// not saved or may not have been saved. A terminal that hung up is not written to.
    func end(status: Int32, terminalGone: Bool = false) {
        lostTerminal = lostTerminal || terminalGone
        guard !ending, !retaining else { return }
        guard let workspace else { finishEnd(status: status, terminalGone: lostTerminal); return }
        retaining = true
        Task { @MainActor in
            let saved = Flag()
            let deadline = DispatchTime.now() + Self.saveAllowance
            let completed = await Self.run(until: deadline) {
                saved.value = await workspace.prepareToClose(saveDeadline: deadline - .milliseconds(100))
            }
            retaining = false
            guard completed, saved.value else {
                workspace.resumeEdits()
                if !completed {
                    workspace.notice = "Draft recovery failed or timed out. The workspace remains open; retry Close after recovery succeeds."
                }
                if lostTerminal { finishEnd(status: max(status, 1), terminalGone: true) }
                return
            }
            finishEnd(status: status, terminalGone: lostTerminal)
        }
    }

    private func finishEnd(status: Int32, terminalGone: Bool) {
        guard !ending else { return }
        ending = true
        initialConnectionDeadline?.cancel(); initialConnectionDeadline = nil
        overlay.stop()
        let gone = Flag(terminalGone)
        terminal.onHangUp = { gone.value = true }
        let finished = Flag()
        let finish: (ReadingStateFlushResult) -> Void = { [self] result in
            guard !finished.value else { return }
            finished.value = true
            result.logFailure()
            let message: String?
            switch result {
            case .saved, .nothingToSave: message = nil
            case .notSaved: message = "Markdown Reader: the reading position was not saved."
            case .unconfirmed: message = "Markdown Reader: the reading position may not have been saved."
            }
            if !gone.value {
                terminal.leave(before: .now() + Self.outputAllowance)
                if let bootFailure { terminal.report("Markdown Reader: \(bootFailure)", before: .now() + Self.outputAllowance) }
                if let message { terminal.report(message, before: .now() + Self.outputAllowance) }
            }
            // Output that the terminal did not take must not hold the exit, so no exit handler
            // runs that could wait for it.
            _exit(message == nil ? status : max(status, 1))
        }
        let deadline = DispatchTime.now() + Self.saveAllowance
        Task { @MainActor in
            let captured = await Self.run(until: .now() + Self.captureAllowance) {
                await self.workspace?.closeViews(bootFailure: self.bootFailure)
                await self.model.close()
            }
            var result = await state.flush(timeout: Self.seconds(until: deadline))
            while result == .saved, state.hasPendingChanges, Self.seconds(until: deadline) > 0 {
                result = await state.flush(timeout: Self.seconds(until: deadline))
            }
            if !captured, result == .saved || result == .nothingToSave {
                result = .unconfirmed(reason: "The final reading position was not captured in time.")
            }
            finish(result)
        }
        DispatchQueue.main.asyncAfter(deadline: deadline + Self.outputAllowance) {
            MainActor.assumeIsolated { finish(.unconfirmed(reason: "The shutdown deadline passed before the save settled.")) }
        }
    }

    /// Time for the final position capture.
    static let captureAllowance = 0.5
    /// Time for the capture and the save together.
    static let saveAllowance = 1.0
    /// Time for each write to the terminal at the end.
    static let outputAllowance = 0.2

    static func seconds(until deadline: DispatchTime) -> TimeInterval {
        let now = DispatchTime.now().uptimeNanoseconds
        let end = deadline.uptimeNanoseconds
        return end > now ? Double(end - now) / 1_000_000_000 : 0
    }

    /// Runs `work` and reports whether it finished before `deadline`; after the deadline the
    /// caller goes on and the work continues on its own.
    static func run(until deadline: DispatchTime, _ work: @escaping @MainActor () async -> Void) async -> Bool {
        await withCheckedContinuation { continuation in
            let resumed = Flag()
            Task { @MainActor in
                await work()
                guard !resumed.value else { return }
                resumed.value = true
                continuation.resume(returning: true)
            }
            DispatchQueue.main.asyncAfter(deadline: deadline) {
                MainActor.assumeIsolated {
                    guard !resumed.value else { return }
                    resumed.value = true
                    continuation.resume(returning: false)
                }
            }
        }
    }
}

/// A value that main-actor closures share.
@MainActor
final class Flag {
    var value: Bool

    init(_ value: Bool = false) {
        self.value = value
    }
}
