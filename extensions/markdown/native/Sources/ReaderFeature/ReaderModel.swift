import Foundation
import MarkdownCore
import Observation
import OSLog
import WebKit

let readerLog = Logger(subsystem: "local.harness.markdown-reader", category: "reader")

/// A rendering prepared off the main thread.
struct PreparedDocument: Sendable {
    var snapshot: DocumentSnapshot
    var rendered: RenderedDocument
    var readMilliseconds: Double
    var renderMilliseconds: Double
}

public struct ReaderTimings: Sendable, Equatable {
    public var readMilliseconds: Double
    public var renderMilliseconds: Double
    public var displayMilliseconds: Double
    public var totalMilliseconds: Double
}

public enum UpdateState: Equatable, Sendable {
    case revision(Int)
    case fileChanged
}

public enum FindStatus: Equatable, Sendable {
    case idle
    case found
    case notFound
}

public enum PositionRestore: String, Sendable {
    case block
    case anchor
    case ratio
    case none
}

public struct ReaderNotice: Equatable, Identifiable, Sendable {
    public enum Kind: Sendable { case info, warning }
    public let id = UUID()
    public var text: String
    public var kind: Kind
}

/// State and actions of one reader window. Each window owns one model and one web page; models
/// share nothing but the reading-state store.
@MainActor @Observable
public final class ReaderModel {
    public enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    public let reference: DocumentReference
    public let page: WebPage
    public private(set) var snapshot: DocumentSnapshot?
    public private(set) var rendered: RenderedDocument?
    public private(set) var phase: Phase = .loading
    /// A failure while the last good revision stays on screen.
    public private(set) var failure: String?
    public private(set) var update: UpdateState?
    /// The newest revision this window knows: the pointer at the last load, or a newer one that
    /// the watcher saw.
    public private(set) var latestRevision: Int?
    public private(set) var notice: ReaderNotice?
    public private(set) var launchOrigin: LaunchOrigin?
    public private(set) var showingSource = false
    public private(set) var findStatus: FindStatus = .idle
    public private(set) var timings: ReaderTimings?
    public private(set) var lastRestore: PositionRestore = .none
    public private(set) var recoveries = 0
    public var outlineVisible = true
    public var findVisible = false
    public var findQuery = "" {
        didSet { if findQuery != oldValue { findStatus = .idle } }
    }
    public var pendingExternalURL: URL?
    public var detailsVisible = false
    public var settings: PageSettings {
        didSet {
            guard settings != oldValue else { return }
            state.settings = settings
            Task { await applySettings() }
        }
    }

    @ObservationIgnored let platform: ReaderPlatform
    @ObservationIgnored let state: ReadingStateStore
    @ObservationIgnored let assets = AssetTable()
    @ObservationIgnored private let router = NavigationRouter()
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var loadPending = false
    @ObservationIgnored private var watcher: DirectoryWatcher?
    @ObservationIgnored private var positionTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var monitorTask: Task<Void, Never>?
    @ObservationIgnored private var closed = false
    @ObservationIgnored var expectingLoad = false

    public init(reference: DocumentReference, platform: ReaderPlatform, state: ReadingStateStore) {
        self.reference = reference
        self.platform = platform
        self.state = state
        self.settings = state.settings
        self.page = ReaderPageFactory.make(router: router, assets: assets)
        router.handler = self
        monitorContentProcess()
    }

    // MARK: - Opening and updates

    /// An explicit open: it replaces the window's launch origin with the request's own, which can
    /// be none, and shows the requested or latest revision. `digest` is the digest of an accepted
    /// open request; only the load that this open starts must find it.
    public func open(revision: Int? = nil, digest: String? = nil, origin: LaunchOrigin?) async {
        launchOrigin = origin?.isUsable == true ? origin : nil
        readerLog.notice("open \(self.reference.key, privacy: .public) revision=\(revision.map(String.init) ?? "latest", privacy: .public) origin=\(self.launchOrigin.map { $0.terminal + ($0.exact == nil ? "" : "+pane") } ?? "none", privacy: .public) window=\(self.snapshot == nil ? "new" : "existing", privacy: .public)")
        if snapshot == nil {
            await load(revision: revision, pinnedDigest: digest, restore: .saved)
        } else if loadPending || (revision ?? latestRevision) != snapshot?.revision || update == .fileChanged || (digest != nil && digest != snapshot?.digest) {
            await load(revision: revision, pinnedDigest: digest, restore: .current)
        }
    }

    /// Shows the latest revision; the reader never does this by itself.
    public func refresh() async {
        await load(revision: nil, restore: .current)
    }

    public func showRevision(_ revision: Int) async {
        guard revision != snapshot?.revision else { return }
        await load(revision: revision, restore: .current)
    }

    public func showAdjacentRevision(newer: Bool) async {
        guard let snapshot, let current = snapshot.revision, let index = snapshot.revisions.firstIndex(of: current) else { return }
        let next = index + (newer ? 1 : -1)
        guard snapshot.revisions.indices.contains(next) else { return }
        await showRevision(snapshot.revisions[next])
    }

    enum RestoreMode {
        case saved
        case current
    }

    func load(revision: Int?, pinnedDigest: String? = nil, restore: RestoreMode) async {
        generation += 1
        let token = generation
        loadPending = true
        defer { if token == generation { loadPending = false } }
        let started = Date()
        var position: ReadingPosition?
        switch restore {
        case .saved: position = state.position(for: reference)
        case .current: position = await capturePosition()
        }
        let reference = self.reference
        let result = await Task.detached(priority: .userInitiated) { () -> Result<PreparedDocument, any Error> in
            Result {
                let readStart = Date()
                let snapshot = try DocumentLoader.load(reference, revision: revision, pinnedDigest: pinnedDigest)
                let renderStart = Date()
                let rendered = MarkdownRenderer.render(snapshot.source, resolver: snapshot.resolver)
                return PreparedDocument(
                    snapshot: snapshot,
                    rendered: rendered,
                    readMilliseconds: renderStart.timeIntervalSince(readStart) * 1000,
                    renderMilliseconds: Date().timeIntervalSince(renderStart) * 1000
                )
            }
        }.value
        guard token == generation, !closed else { return }
        switch result {
        case .failure(let error):
            fail(String(describing: error))
        case .success(let prepared):
            let previousRevision = snapshot?.revision
            guard await install(prepared, position: position, token: token, started: started) else { return }
            if case .current = restore, previousRevision != nil, previousRevision != prepared.snapshot.revision {
                reportRestore()
            }
        }
    }

    /// Reports a failed load. The first load of a window fails the window; a later one keeps the
    /// shown revision and says that the update failed.
    private func fail(_ text: String) {
        if snapshot == nil {
            phase = .failed(text)
        } else {
            failure = text
            post("The update failed; the previous revision stays on screen. \(text)", kind: .warning)
        }
    }

    /// Displays a prepared revision and commits it only when the page displayed. The asset table
    /// serves the prepared tokens while the page loads. After a failed display the table returns
    /// to the shown rendering's tokens, the shown revision's state stays, and its page is displayed
    /// again at the position captured before the load. Returns true when the prepared revision was
    /// committed.
    private func install(_ prepared: PreparedDocument, position: ReadingPosition?, token: Int, started: Date) async -> Bool {
        let displayStart = Date()
        assets.replace(prepared.rendered.assets)
        do {
            try await display(html: PageTemplate.page(body: prepared.rendered.body, title: prepared.snapshot.title, settings: settings))
        } catch {
            guard token == generation, !closed else { return false }
            assets.replace(rendered?.assets ?? [:])
            fail("The page could not be shown: \(error.localizedDescription)")
            if snapshot != nil {
                try? await display(html: pageHTML())
                if let position { lastRestore = await restorePosition(position) }
            }
            return false
        }
        guard token == generation, !closed else { return false }
        snapshot = prepared.snapshot
        rendered = prepared.rendered
        failure = nil
        latestRevision = max(latestRevision ?? 0, prepared.snapshot.latestRevision ?? 0)
        if let shown = prepared.snapshot.revision, let latest = latestRevision, latest > shown {
            update = .revision(latest)
        } else {
            update = nil
        }
        showingSource = false
        phase = .ready
        lastRestore = position.map { _ in .none } ?? .none
        if let position { lastRestore = await restorePosition(position) }
        timings = ReaderTimings(
            readMilliseconds: prepared.readMilliseconds,
            renderMilliseconds: prepared.renderMilliseconds,
            displayMilliseconds: Date().timeIntervalSince(displayStart) * 1000,
            totalMilliseconds: Date().timeIntervalSince(started) * 1000
        )
        state.noteOpened(reference, title: Provenance.displayTitle(prepared.snapshot, rendered: prepared.rendered))
        readerLog.notice("rendered \(self.reference.key, privacy: .public) revision=\(prepared.snapshot.revision.map(String.init) ?? "-", privacy: .public) latest=\(prepared.snapshot.latestRevision.map(String.init) ?? "-", privacy: .public) update=\(self.update == nil ? "none" : "available", privacy: .public) restore=\(self.lastRestore.rawValue, privacy: .public) totalMs=\(Int(self.timings?.totalMilliseconds ?? 0), privacy: .public)")
        startWatching()
        await savePosition()
        return true
    }

    private func reportRestore() {
        switch lastRestore {
        case .block: post("Showing revision \(snapshot?.revision ?? 0) at the same place.", kind: .info)
        case .anchor: post("The paragraph you were reading changed. Showing the start of its section.", kind: .warning)
        case .ratio, .none: post("Your position was not found in this revision. Showing the nearest place by length.", kind: .warning)
        }
    }

    func pageHTML() -> String {
        guard let snapshot, let rendered else { return "" }
        if showingSource {
            return PageTemplate.sourcePage(source: snapshot.source, title: snapshot.title, settings: settings)
        }
        return PageTemplate.page(body: rendered.body, title: snapshot.title, settings: settings)
    }

    /// Loads a page and throws when it did not display. A load that the end of the web content
    /// process interrupted is tried once more.
    func display(html: String) async throws {
        expectingLoad = true
        defer { expectingLoad = false }
        do {
            for try await _ in page.load(html: html, baseURL: URL(string: "about:blank")!) {}
        } catch WebPage.NavigationError.webContentProcessTerminated {
            recoveries += 1
            for try await _ in page.load(html: html, baseURL: URL(string: "about:blank")!) {}
        }
    }

    /// Reloads the shown revision after the page's web content process ended, then returns to the
    /// saved reading position.
    func recoverContentProcess() async {
        guard !closed, snapshot != nil else { return }
        readerLog.notice("web content process ended; reloading \(self.reference.key, privacy: .public)")
        let position = state.position(for: reference)
        do {
            try await display(html: pageHTML())
        } catch {
            post("The page could not be shown: \(error.localizedDescription)", kind: .warning)
            return
        }
        if let position { lastRestore = await restorePosition(position) }
        recoveries += 1
        post("The page stopped unexpectedly and was reloaded.", kind: .info)
    }

    private func monitorContentProcess() {
        monitorTask = Task { @MainActor [weak self] in
            while let self, !self.closed {
                do {
                    for try await _ in self.page.navigations {}
                    return
                } catch {
                    if case WebPage.NavigationError.webContentProcessTerminated = error, !self.expectingLoad {
                        await self.recoverContentProcess()
                    }
                }
            }
        }
    }

    // MARK: - Watching the pointer

    private func startWatching() {
        guard watcher == nil, let snapshot else { return }
        let directory: URL
        switch reference {
        case .stored(let root, _, let id):
            guard let location = try? DirectoryStore(root: URL(fileURLWithPath: root)).pointerLocation(id) else { return }
            directory = location
        case .file:
            directory = snapshot.location.deletingLastPathComponent()
        }
        watcher = DirectoryWatcher(directory: directory) { [weak self] in
            Task { @MainActor in await self?.checkForUpdate() }
        }
    }

    /// Notes a newer revision or a changed file without touching the page.
    public func checkForUpdate() async {
        guard let snapshot else { return }
        let reference = self.reference
        let marker = await Task.detached { DocumentLoader.currentMarker(reference) }.value
        guard let marker else { return }
        switch reference {
        case .stored:
            guard let latest = Int(marker), latest > (latestRevision ?? 0) || (latest > (snapshot.revision ?? 0) && update == nil) else { return }
            latestRevision = latest
            update = .revision(latest)
            readerLog.notice("update available \(self.reference.key, privacy: .public) revision=\(latest, privacy: .public)")
        case .file:
            if marker != snapshot.digest { update = .fileChanged }
        }
    }

    // MARK: - Reading position

    /// Called when the page scrolls; saves the position after scrolling settles.
    public func scrolled() {
        positionTask?.cancel()
        positionTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.savePosition()
        }
    }

    func savePosition() async {
        guard phase == .ready, !showingSource, let position = await capturePosition() else { return }
        state.setPosition(position, for: reference)
    }

    func capturePosition() async -> ReadingPosition? {
        guard rendered != nil, !showingSource else { return nil }
        guard let value = try? await page.callJavaScript(PageScript.capturePosition, contentWorld: PageScript.world) as? [String: Any] else {
            return nil
        }
        return ReadingPosition(
            blockKey: value["key"] as? String,
            fraction: (value["fraction"] as? Double) ?? 0,
            anchor: value["anchor"] as? String,
            ratio: (value["ratio"] as? Double) ?? 0,
            revision: snapshot?.revision
        )
    }

    func restorePosition(_ position: ReadingPosition) async -> PositionRestore {
        let arguments: [String: Any] = [
            "key": position.blockKey ?? "",
            "fraction": position.fraction,
            "anchor": position.anchor ?? "",
            "ratio": position.ratio,
        ]
        let result = try? await page.callJavaScript(PageScript.restorePosition, arguments: arguments, contentWorld: PageScript.world) as? String
        return result.flatMap(PositionRestore.init(rawValue:)) ?? .none
    }

    // MARK: - Reading actions

    public func scrollTo(anchor: String) async {
        _ = try? await page.callJavaScript(PageScript.scrollToAnchor, arguments: ["anchor": anchor], contentWorld: PageScript.world)
        scrolled()
    }

    public func find(backwards: Bool = false) async {
        let query = findQuery
        guard !query.isEmpty else {
            findStatus = .idle
            return
        }
        let found = (try? await page.callJavaScript(PageScript.find, arguments: ["query": query, "backwards": backwards], contentWorld: PageScript.world) as? Bool) ?? false
        findStatus = found ? .found : .notFound
    }

    public func selectedText() async -> String {
        (try? await page.callJavaScript(PageScript.selectionText, contentWorld: PageScript.world) as? String) ?? ""
    }

    public func showFind() {
        findVisible = true
    }

    public func hideFind() {
        findVisible = false
        findStatus = .idle
    }

    public func changeTextSize(by step: Int) {
        settings = PageSettings(textSize: settings.textSize + step, wrapCode: settings.wrapCode)
    }

    public func resetTextSize() {
        settings = PageSettings(textSize: PageSettings.defaultTextSize, wrapCode: settings.wrapCode)
    }

    public func toggleWrap() {
        settings = PageSettings(textSize: settings.textSize, wrapCode: !settings.wrapCode)
    }

    private func applySettings() async {
        let arguments: [String: Any] = ["textSize": settings.textSize, "wrap": settings.wrapCode]
        _ = try? await page.callJavaScript(PageScript.applySettings, arguments: arguments, contentWorld: PageScript.world)
    }

    public func toggleSource() async {
        guard snapshot != nil else { return }
        let position = showingSource ? state.position(for: reference) : await capturePosition()
        if !showingSource, let position { state.setPosition(position, for: reference) }
        showingSource.toggle()
        do {
            try await display(html: pageHTML())
        } catch {
            showingSource.toggle()
            post("The page could not be shown: \(error.localizedDescription)", kind: .warning)
            try? await display(html: pageHTML())
        }
        if !showingSource, let position { lastRestore = await restorePosition(position) }
    }

    public func copyMarkdown() {
        guard let snapshot else { return }
        platform.copyText(snapshot.source)
        post("Copied the Markdown source (\(ByteCountFormatter.string(fromByteCount: Int64(snapshot.bytes), countStyle: .file))).", kind: .info)
    }

    public func copyCode(_ index: Int) {
        guard let rendered, rendered.codeBlocks.indices.contains(index) else { return }
        platform.copyText(rendered.codeBlocks[index].literal)
        post("Copied the code block.", kind: .info)
    }

    public func revealInFinder() {
        guard let snapshot else { return }
        platform.reveal(snapshot.location)
    }

    public var displayTitle: String {
        snapshot.map { Provenance.displayTitle($0, rendered: rendered) } ?? "Opening…"
    }

    /// The return action exists only for a window with a launch origin.
    public var returnLabel: String? {
        launchOrigin.map { _ in "Return to \(LaunchOrigin.rexTerminal)" }
    }

    public private(set) var lastReturn: TerminalReturnResult?

    public func returnToTerminal() async {
        guard let origin = launchOrigin else { return }
        let result = await platform.returnToTerminal(origin)
        lastReturn = result
        readerLog.notice("return \(self.reference.key, privacy: .public) pane=\(String(describing: result.pane), privacy: .public) application=\(String(describing: result.application), privacy: .public)")
        let (text, kind) = Self.describe(result)
        post(text, kind: kind)
    }

    static func describe(_ result: TerminalReturnResult) -> (String, ReaderNotice.Kind) {
        let front: String
        switch result.application {
        case .activated: front = "Rex is in front."
        case .notRunning: front = "Rex is not running."
        case .failed(let reason): front = "Rex did not come to the front: \(reason)."
        }
        switch result.pane {
        case .focused:
            return (result.application == .activated ? "Rex is in front with the terminal pane selected." : "\(front) The terminal pane was selected in Rex.", result.application == .activated ? .info : .warning)
        case .stale(let detail):
            return ("\(front) The original pane no longer exists: \(detail)", .warning)
        case .unavailable(let reason):
            return ("\(front) Pane selection was not available: \(reason)", result.application == .activated ? .info : .warning)
        }
    }

    public func confirmExternal() {
        guard let url = pendingExternalURL else { return }
        pendingExternalURL = nil
        if !platform.openExternal(url) {
            post("The browser did not open \(url.absoluteString).", kind: .warning)
        }
    }

    public func dismissNotice() {
        notice = nil
    }

    func post(_ text: String, kind: ReaderNotice.Kind) {
        let notice = ReaderNotice(text: text, kind: kind)
        self.notice = notice
        noticeTask?.cancel()
        noticeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(kind == .info ? 3 : 8))
            guard !Task.isCancelled, self?.notice?.id == notice.id else { return }
            self?.notice = nil
        }
    }

    /// Ends the window's work: the watcher stops and the last position is saved.
    public func close() async {
        await savePosition()
        closed = true
        generation += 1
        watcher = nil
        positionTask?.cancel()
        monitorTask?.cancel()
        state.saveNow()
    }
}

// Hooks for the app's verification mode, which exercises the page with content that the
// renderer itself never produces.
extension ReaderModel {
    package func displayForCheck(html: String) async {
        try? await display(html: html)
    }

    package var isDisplayingForCheck: Bool { expectingLoad }
    package var refusedAssetRequests: Int { assets.refused }
    package var savedPositionForCheck: ReadingPosition? { state.position(for: reference) }
    package var servedAssetRequests: Int { assets.served }

    package func capturePositionForCheck() async -> ReadingPosition? {
        await capturePosition()
    }
}

extension ReaderModel: NavigationHandling {
    func handle(_ request: NavigationRequest) {
        switch request {
        case .copyCode(let nonce, let index):
            if nonce == rendered?.nonce { copyCode(index) }
        case .external(let url):
            pendingExternalURL = url
        case .blocked(let url):
            let scheme = url?.scheme ?? "this"
            post("The reader does not open \(scheme) links.", kind: .info)
        case .documentLoad, .sameDocument:
            break
        }
    }
}

/// Calls back on the main queue when a directory's entries change.
final class DirectoryWatcher {
    private let source: DispatchSourceFileSystemObject?

    init(directory: URL, onChange: @escaping @Sendable () -> Void) {
        let descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else {
            source = nil
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .rename, .delete, .extend, .attrib], queue: .main)
        source.setEventHandler(handler: onChange)
        source.setCancelHandler { close(descriptor) }
        source.resume()
        self.source = source
    }

    deinit {
        source?.cancel()
    }
}
