import AppKit
import EditorFeature
import NativePane
import MacPlatform
import OSLog
import MarkdownCore
import ReaderFeature
import UniformTypeIdentifiers

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation, NSMenuDelegate {
    let mode: LaunchMode
    private(set) var windows: WindowManager!
    private var openedAtLaunch = false
    private let recentMenu = NSMenu(title: "Open Recent")
    private var paneHost: PaneHost?
    private let livePath: String?
    private var liveConfiguration: CollaborationConfiguration?
    private var startupDeadline: DispatchTime?

    init(mode: LaunchMode, livePath: String? = nil) {
        self.mode = mode; self.livePath = livePath
    }

    /// The reader's own state lives outside every document store. The `ReaderStateDirectory`
    /// default (for example `-ReaderStateDirectory <path>` as a launch argument) moves it.
    static func stateDirectory() -> URL {
        if let path = UserDefaults.standard.string(forKey: "ReaderStateDirectory"), !path.isEmpty {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Markdown Reader")
    }

    /// The installation seed used only until the operator selects a store in reading state.
    static func defaultRoots(_ bundle: Bundle = .main) -> [String] {
        guard let resources = bundle.resourceURL,
              let data = try? FileAccess.readRegularFile(resources.appendingPathComponent("build.json"), limit: Limits.recordBytes, missing: .notFound("build.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let store = manifest["store"] as? String, store.hasPrefix("/")
        else { return [] }
        return [FileAccess.canonicalPath(store)]
    }

    /// The machine's shared pane appearance file that the install recorded in build.json
    /// (docs/conventions/pane-appearance.md). A bundle without it keeps the choice in memory.
    static func paneAppearanceFile(_ bundle: Bundle = .main) -> URL? {
        guard let resources = bundle.resourceURL,
              let data = try? FileAccess.readRegularFile(resources.appendingPathComponent("build.json"), limit: Limits.recordBytes, missing: .notFound("build.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = manifest["paneAppearance"] as? String, path.hasPrefix("/"), !path.utf8.contains(0)
        else { return nil }
        return URL(fileURLWithPath: path)
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        let theme = mode.isCheck ? nil : PaneAppearance(file: Self.paneAppearanceFile())
        let state = ReadingStateStore(directory: mode.isCheck ? nil : Self.stateDirectory(), theme: theme)
        var platform = mode.isCheck ? CheckRunner.platform() : MacPlatform.operations()
        if !mode.isCheck {
            platform.exportRevision = { try await ExportPanel.revision($0, form: $1) }
            platform.savePDF = { try await ExportPanel.pdf($0, name: $1) }
        }
        windows = WindowManager(state: state, platform: platform, defaultRoots: mode.isCheck ? [] : Self.defaultRoots())
        ReaderTheme.follow(state, setsAppearance: !mode.isCheck)
        if mode.isPane {
            NSApp.mainMenu = buildMenu(pane: true)
        } else if !mode.isAccessory {
            NSApp.mainMenu = buildMenu(pane: false)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let livePath {
            Task { @MainActor in
                do {
                    let configuration = try CollaborationConfiguration.consume(livePath)
                    guard mode.isCheck || configuration.live == CollaborationConfiguration.paneProtocol else {
                        throw StoreError.unreadable("The live launch configuration does not match this reader.")
                    }
                    liveConfiguration = configuration
                    startupDeadline = try await configuration.reportStarting()
                    finishLaunch()
                } catch {
                    await failLaunch("Request a new reader launch from the original Pi conversation. \(error)")
                }
            }
        } else { finishLaunch() }
    }

    private func failLaunch(_ detail: String, status: Int32 = 1) async -> Never {
        if let liveConfiguration {
            _ = await PaneHost.run(until: .now() + .milliseconds(400)) { _ = await liveConfiguration.reportLaunchFailure(detail) }
        }
        FileHandle.standardError.write(Data(TerminalText.line("Markdown Reader: \(detail)").utf8))
        exit(status)
    }

    private func finishLaunch() {
        if case .editor(let launch) = mode { startEditor(launch); return }
        if case .pane(let target) = mode {
            startPane(target)
            return
        }
        if mode.isCheck {
            Task { await CheckRunner(mode: mode, windows: windows, live: liveConfiguration).run() }
            return
        }
        DispatchQueue.main.async { [self] in
            if !openedAtLaunch && windows.readerWindowCount == 0 { showLibrary(nil) }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        paneHost?.focusPendingEditor()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // A quit request to a pane reader, such as a scripted quit or a logout, ends it like its
        // close control: the position is saved and the terminal restored before the exit.
        if mode.isPane, let paneHost {
            paneHost.end(status: 0)
            return .terminateCancel
        }
        guard !mode.isCheck else { return .terminateNow }
        let answered = Flag()
        let editorRetained = Flag()
        let finish: (ReadingStateFlushResult) -> Void = { result in
            guard !answered.value else { return }
            answered.value = true
            result.logFailure()
            sender.reply(toApplicationShouldTerminate: true)
        }
        let deadline = DispatchTime.now() + PaneHost.saveAllowance
        let retention = Task { await windows.retainEditors(saveDeadline: deadline - .milliseconds(100)) }
        Task { @MainActor in
            let retained = await retention.value
            guard !answered.value else { windows.resumeEditors(); return }
            guard retained else {
                answered.value = true
                sender.reply(toApplicationShouldTerminate: false)
                return
            }
            editorRetained.value = true
            let captured = await PaneHost.run(until: .now() + PaneHost.captureAllowance) { await self.windows.closeReaders() }
            var result = await windows.state.flush(timeout: PaneHost.seconds(until: deadline))
            while result == .saved, windows.state.hasPendingChanges, PaneHost.seconds(until: deadline) > 0 {
                result = await windows.state.flush(timeout: PaneHost.seconds(until: deadline))
            }
            if !captured, result == .saved || result == .nothingToSave {
                result = .unconfirmed(reason: "The final reading positions were not captured in time.")
            }
            finish(result)
        }
        DispatchQueue.main.asyncAfter(deadline: deadline + PaneHost.outputAllowance) {
            MainActor.assumeIsolated {
                if !answered.value, self.windows.refuseQuitBeforeRecovery(retained: editorRetained.value) {
                    retention.cancel()
                    answered.value = true
                    sender.reply(toApplicationShouldTerminate: false)
                } else { finish(.unconfirmed(reason: "The quit deadline passed before the save settled.")) }
            }
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if mode.isPane { return false }
        if !flag { showLibrary(nil) }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if mode.isPane { return }
        guard !mode.isCheck else { return }
        openedAtLaunch = true
        for url in urls { intake(url) }
    }

    /// Accepts one file from the operating system: an open request is checked against its store
    /// and removed once accepted; a Markdown file opens in place without an origin.
    func intake(_ url: URL) {
        Task {
            let outcome = await Task.detached { () -> Result<(DocumentReference, Int?, String?, LaunchOrigin?), OpenIntakeError> in
                do {
                    let target = try OpenIntake.classify(url)
                    switch target {
                    case .stored(let store, let request, let file):
                        _ = try OpenIntake.accept(store, request, requestFile: file)
                        return .success((target.reference, request.revision, request.digest, request.launchOrigin))
                    case .plainFile:
                        return .success((target.reference, nil, nil, nil))
                    }
                } catch let error as OpenIntakeError {
                    return .failure(error)
                } catch {
                    return .failure(.invalidRequest(error.localizedDescription))
                }
            }.value
            let log = Logger(subsystem: "local.harness.markdown-reader", category: "intake")
            switch outcome {
            case .success(let (reference, revision, digest, origin)):
                log.notice("accepted \(url.lastPathComponent, privacy: .public) for \(reference.key, privacy: .public) revision=\(revision.map(String.init) ?? "latest", privacy: .public) existingWindow=\(self.windows.model(for: reference) != nil, privacy: .public)")
                windows.open(reference, revision: revision, digest: digest, origin: origin)
            case .failure(let error):
                log.error("refused \(url.lastPathComponent, privacy: .public): \(error.description, privacy: .public)")
                showError("The reader could not open \(url.lastPathComponent).", detail: error.description)
            }
        }
    }

    private func startEditor(_ launch: EditorLaunch) {
        let terminal = launch.surface == .pane ? PaneTerminal() : nil
        Task { @MainActor in
            if launch.surface == .pane, terminal == nil {
                await failLaunch("The editor pane needs terminal input and output.", status: 2)
            }
            do {
                let (record, origin) = try await Task.detached { try launch.load() }.value
                if let terminal {
                    let workspace = EditorWorkspace(directory: Self.stateDirectory().appendingPathComponent("Drafts"), store: launch.store, automaticallySaves: true)
                    workspace.launchOrigin = origin; workspace.add(record)
                    if let liveConfiguration { workspace.startCollaboration(liveConfiguration, requiresRenderedStart: true) }
                    let model = ReaderModel(reference: .file(path: "draft:" + record.id.uuidString), platform: windows.platform, state: windows.state)
                    let host = PaneHost(model: model, state: windows.state, terminal: terminal, workspace: workspace)
                    paneHost = host
                    windows.adoptEditor(host.start(startupDeadline: startupDeadline), workspace: workspace)
                } else {
                    let workspace = windows.showEditor(record: record, store: launch.store, origin: origin)
                    if let liveConfiguration { workspace.startCollaboration(liveConfiguration) }
                }
            } catch {
                if launch.surface == .pane || liveConfiguration != nil { await failLaunch("Editor not opened: \(error)") }
                showError("The editor could not open this document.", detail: String(describing: error))
            }
        }
    }

    /// Pane mode: checks the store and the document before the terminal changes, so that a wrong
    /// argument ends with one error line and a nonzero status in the pane.
    private func startPane(_ target: LaunchMode.PaneTarget) {
        let label: String
        switch target {
        case .document(_, let document, _): label = document
        case .request(let path): label = URL(fileURLWithPath: path).lastPathComponent
        }
        Task {
            guard let terminal = PaneTerminal() else {
                await failLaunch("--pane needs a terminal on standard input and output.", status: 2)
            }
            let load = Task.detached { () -> Result<(DocumentReference, Int?, String?, LaunchOrigin?), OpenIntakeError> in
                do {
                    switch target {
                    case .document(let root, let document, let pin):
                        let store = try DirectoryStore(root: URL(fileURLWithPath: root))
                        if let pin {
                            let loaded = try store.loadRevision(document, revision: pin.revision)
                            guard loaded.record.digest == pin.digest else {
                                throw OpenIntakeError.invalidRequest("revision \(pin.revision) does not match the supplied digest")
                            }
                        } else {
                            _ = try store.document(document)
                        }
                        return .success((.stored(root: FileAccess.canonicalPath(root), storeId: store.storeId, document: document), pin?.revision, pin?.digest, nil))
                    case .request(let path):
                        let target = try OpenIntake.classify(URL(fileURLWithPath: path))
                        guard case .stored(let store, let request, let file) = target else { throw OpenIntakeError.notAnOpenRequest }
                        _ = try OpenIntake.accept(store, request, requestFile: file)
                        return .success((target.reference, request.revision, request.digest, request.launchOrigin))
                    }
                } catch let error as OpenIntakeError {
                    return .failure(error)
                } catch let error as StoreError {
                    return .failure(.store(error))
                } catch {
                    return .failure(.invalidRequest(error.localizedDescription))
                }
            }
            var outcome: Result<(DocumentReference, Int?, String?, LaunchOrigin?), OpenIntakeError>?
            if let startupDeadline {
                _ = await PaneHost.run(until: startupDeadline) { outcome = await load.value }
            } else { outcome = await load.value }
            guard let outcome else { await failLaunch("The document store did not respond before the startup deadline.") }
            switch outcome {
            case .success(let (reference, revision, digest, origin)):
                let model = ReaderModel(reference: reference, platform: windows.platform, state: windows.state)
                let workspace: EditorWorkspace?
                if livePath != nil {
                    let root: String? = if case .stored(let root, _, _) = reference { root } else { windows.state.selectedStoreRoot }
                    let live = EditorWorkspace(directory: Self.stateDirectory().appendingPathComponent("Drafts"), store: root, automaticallySaves: true)
                    live.reading = model; live.launchOrigin = origin
                    if let liveConfiguration { live.startCollaboration(liveConfiguration, requiresRenderedStart: true) }
                    workspace = live
                } else { workspace = nil }
                let host = PaneHost(model: model, state: windows.state, terminal: terminal, workspace: workspace)
                host.onWorkspaceChange = { [weak self] window, workspace in self?.windows.adoptEditor(window, workspace: workspace) }
                paneHost = host
                let window = host.start(revision: revision, digest: digest, origin: origin, startupDeadline: startupDeadline)
                if let workspace { windows.adoptEditor(window, workspace: workspace) }
                else { windows.adopt(window, model: model) }
            case .failure(let error):
                await failLaunch("\(label) cannot be shown: \(error)")
            }
        }
    }

    private func showError(_ message: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.alertStyle = .warning
        NSApp.activate()
        if let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible && $0.delegate === windows }) {
            alert.beginSheetModal(for: window)
        } else {
            DispatchQueue.main.async { alert.runModal() }
        }
    }

    // MARK: - Menu actions

    @objc func newScratchpad(_ sender: Any?) {
        if let paneHost { paneHost.newScratchpad() } else { windows.showEditor() }
    }
    @objc func showDrafts(_ sender: Any?) {
        if let paneHost { paneHost.newScratchpad(showDrafts: true) } else { windows.showEditor(newScratchpad: false) }
    }
    @objc func saveEditor(_ sender: Any?) { windows.keyEditor?.save() }
    @objc func saveEditorAs(_ sender: Any?) { windows.keyEditor?.saveAs() }

    @objc func showLibrary(_ sender: Any?) {
        if let paneHost { paneHost.newScratchpad(showLibrary: true); return }
        if let surface = windows.keySurface { surface.sendCommand("showLibrary", args: ["collection": "published"]); return }
        windows.showLibrary(openFile: { [weak self] in self?.openDocument(nil) },
                            openStore: { [weak self] in self?.openStore(nil) })
    }

    @objc func openStore(_ sender: Any?) {
        let workspace = paneHost?.workspace ?? windows.keyEditor
        Task {
            do {
                let result = try await ReaderSurface.chooseStore(state: windows.state, workspace: workspace)
                if result["changed"] as? Bool == true { showLibrary(nil) }
            } catch { showError("Store not opened", detail: String(describing: error)) }
        }
    }

    @objc func openDocument(_ sender: Any?) {
        if let workspace = paneHost?.workspace ?? windows.keyEditor { workspace.openFile(); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [UTType(filenameExtension: "md"), UTType(filenameExtension: "markdown"), .plainText].compactMap { $0 }
        panel.begin { [weak self] response in
            guard response == .OK else { return }
            for url in panel.urls { self?.intake(url) }
        }
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let recent = sender.representedObject as? RecentDocument else { return }
        windows.open(recent.reference, revision: nil, origin: nil)
    }

    private func withModel(_ action: @escaping (ReaderModel) async -> Void) {
        guard let model = windows.keyModel else { return }
        let surface = windows.keySurface
        Task { await surface?.waitForPendingChanges(); await action(model) }
    }

    private func pageCommand(_ name: String, args: [String: Any] = [:]) { windows.keySurface?.sendCommand(name, args: args) }
    @objc func undoPage(_ sender: Any?) { pageCommand("undo") }
    @objc func redoPage(_ sender: Any?) { pageCommand("redo") }
    @objc func selectAllPage(_ sender: Any?) { pageCommand("selectAll") }
    @objc func toggleLock(_ sender: Any?) { pageCommand("toggleLock") }
    @objc func replacePage(_ sender: Any?) { pageCommand("replace") }
    @objc func askAboutSelection(_ sender: Any?) { pageCommand("askSelection") }
    @objc func askAboutDocument(_ sender: Any?) { pageCommand("askDocument") }
    @objc func copyMarkdown(_ sender: Any?) { pageCommand("copyMarkdown") }
    @objc func copyPassage(_ sender: Any?) { pageCommand("copyPassage") }
    @objc func formatEditor(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? MarkdownCommand else { return }
        let name: String
        switch command { case .bold: name = "bold"; case .italic: name = "italic"; case .link: name = "link"; case .indent: name = "indent"; case .outdent: name = "outdent"; default: return }
        pageCommand("format", args: ["command": name])
    }

    @objc func showFind(_ sender: Any?) { pageCommand("find") }
    @objc func findNext(_ sender: Any?) { pageCommand("findNext") }
    @objc func findPrevious(_ sender: Any?) { pageCommand("findPrevious") }
    @objc func toggleOutline(_ sender: Any?) { pageCommand("toggleOutline") }
    @objc func goBack(_ sender: Any?) { pageCommand("back") }
    @objc func goForward(_ sender: Any?) { pageCommand("forward") }
    @objc func toggleSource(_ sender: Any?) { pageCommand("showSource") }
    @objc func toggleWrap(_ sender: Any?) { withModel { $0.toggleWrap() } }
    @objc func biggerText(_ sender: Any?) { pageCommand("zoomIn") }
    @objc func smallerText(_ sender: Any?) { pageCommand("zoomOut") }
    @objc func actualSize(_ sender: Any?) { pageCommand("zoomReset") }
    @objc func actualImageSize(_ sender: Any?) { pageCommand("imageZoom", args: ["mode": "actual"]) }
    @objc func zoomToFit(_ sender: Any?) { pageCommand("imageZoom", args: ["mode": "fit"]) }
    @objc func inspectImage(_ sender: Any?) { pageCommand("inspectImage", args: ["index": 0]) }
    @objc func refreshDocument(_ sender: Any?) { withModel { await $0.refresh() } }
    @objc func olderRevision(_ sender: Any?) { withModel { await $0.showAdjacentRevision(newer: false) } }
    @objc func newerRevision(_ sender: Any?) { withModel { await $0.showAdjacentRevision(newer: true) } }
    @objc func reviewChanges(_ sender: Any?) {
        if windows.keySurface?.pageState["overlay"] as? String == "review" { pageCommand("escape") }
        else { pageCommand("showReview", args: ["against": windows.keyEditor?.active == nil ? "previous" : "base"]) }
    }
    @objc func goToRevision(_ sender: Any?) { pageCommand("showReview") }
    @objc func showDetails(_ sender: Any?) { pageCommand("showDetails") }
    @objc func revealDocument(_ sender: Any?) { withModel { $0.revealInFinder() } }
    @objc func returnToTerminal(_ sender: Any?) { withModel { await $0.returnToTerminal() } }
    @objc func exportArchive(_ sender: Any?) { withModel { await $0.exportRevision(.archive) } }
    @objc func exportSharing(_ sender: Any?) { withModel { await $0.exportRevision(.sharing) } }
    @objc func exportPDF(_ sender: Any?) { withModel { await $0.exportCurrentPagePDF() } }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let action = item.action else { return true }
        if [#selector(askAboutSelection(_:)), #selector(askAboutDocument(_:))].contains(action) {
            guard let workspace = windows.keyEditor, let client = workspace.collaboration else { return false }
            return !client.isClosed && !workspace.closing && windows.keySurface?.commandEnabled(action == #selector(askAboutSelection(_:)) ? "askSelection" : "askDocument") == true
        }
        if [#selector(newScratchpad(_:)), #selector(showDrafts(_:)), #selector(showLibrary(_:)), #selector(openDocument(_:)), #selector(openStore(_:)), #selector(openRecent(_:))].contains(action) { return true }
        if [#selector(saveEditor(_:)), #selector(saveEditorAs(_:))].contains(action) { return windows.keyEditor?.active != nil }
        if action == #selector(formatEditor(_:)) { return windows.keySurface?.commandEnabled("format") == true }
        if action == #selector(undoPage(_:)) { return windows.keySurface?.commandEnabled("undo") == true }
        if action == #selector(redoPage(_:)) { return windows.keySurface?.commandEnabled("redo") == true }
        if action == #selector(goBack(_:)) { return windows.keySurface?.commandEnabled("back") == true }
        if action == #selector(goForward(_:)) { return windows.keySurface?.commandEnabled("forward") == true }
        guard let model = windows.keyModel else { return false }
        switch action {
        case #selector(toggleOutline(_:)):
            item.state = windows.state.outlineOpen ? .on : .off
            return !(model.rendered?.outline.isEmpty ?? true)
        case #selector(exportArchive(_:)), #selector(exportSharing(_:)):
            return model.snapshot?.record != nil
        case #selector(exportPDF(_:)):
            return model.canExportPDF
        case #selector(toggleSource(_:)):
            item.state = windows.keySurface?.pageState["overlay"] as? String == "source" ? .on : .off
            return model.snapshot != nil
        case #selector(biggerText(_:)):
            item.title = "Bigger Text"
            return model.snapshot != nil
        case #selector(smallerText(_:)):
            item.title = "Smaller Text"
            return model.snapshot != nil
        case #selector(zoomToFit(_:)), #selector(actualImageSize(_:)):
            return windows.keySurface?.pageState["overlay"] as? String == "image"
        case #selector(inspectImage(_:)):
            item.title = "Inspect Image"
            return !(model.rendered?.images.isEmpty ?? true)
        case #selector(toggleWrap(_:)):
            item.state = model.settings.wrapCode ? .on : .off
            return true
        case #selector(refreshDocument(_:)):
            return model.snapshot != nil && !model.isDraft
        case #selector(olderRevision(_:)):
            guard let revision = model.snapshot?.revision else { return false }
            return revision > 1
        case #selector(newerRevision(_:)):
            guard let revision = model.snapshot?.revision else { return false }
            return revision < (model.latestRevision ?? revision)
        case #selector(reviewChanges(_:)):
            item.title = windows.keySurface?.pageState["overlay"] as? String == "review" ? "Close Comparison" : "Review Changes"
            if let workspace = windows.keyEditor, workspace.reading == nil, let document = workspace.active {
                switch document.session.record.destination { case .published, .copy: return true; default: return false }
            }
            return model.canReviewChanges
        case #selector(goToRevision(_:)):
            return model.canReviewChanges
        case #selector(returnToTerminal(_:)):
            item.title = model.returnLabel ?? "Return to Terminal"
            return model.launchOrigin != nil
        default:
            return model.snapshot != nil
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        for recent in windows.state.recents {
            let item = NSMenuItem(title: recent.title, action: #selector(openRecent(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = recent
            menu.addItem(item)
        }
        if menu.items.isEmpty {
            let empty = NSMenuItem(title: "No Recent Documents", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        }
    }

    // MARK: - Menu bar

    private func item(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target ?? self
        return item
    }

    private func standard(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        return item
    }

    private func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let menu = NSMenu(title: title)
        for item in items { menu.addItem(item) }
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        return holder
    }

    /// The menu bar. A pane reader has no visible menu bar; its menu supplies key equivalents for
    /// its one document, without opening other documents or windows.
    private func buildMenu(pane: Bool) -> NSMenu {
        let main = NSMenu()
        let name = "Markdown Reader"
        if pane {
            main.addItem(submenu(name, [standard("Close Reader", #selector(NSWindow.performClose(_:)), "q")]))
            main.addItem(submenu("File", [
                item("New Scratchpad", #selector(newScratchpad(_:)), "n"),
                item("Open…", #selector(openDocument(_:)), "o"),
                item("Save", #selector(saveEditor(_:)), "s"),
                item("Save As…", #selector(saveEditorAs(_:)), "s", [.command, .shift]),
                item("Recoverable Drafts", #selector(showDrafts(_:)), "d", [.command, .shift]),
                item("Library", #selector(showLibrary(_:)), "l", [.command, .shift]),
                standard("Close", #selector(NSWindow.performClose(_:)), "w"),
            ]))
            main.addItem(editMenu())
            main.addItem(viewMenu(fullScreen: false))
            main.addItem(documentMenu(returnItem: false))
            return main
        }
        main.addItem(submenu(name, [
            standard("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            standard("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
            standard("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            standard("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            standard("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
        ]))
        recentMenu.delegate = self
        let recentHolder = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        recentHolder.submenu = recentMenu
        main.addItem(submenu("File", [
            item("New Scratchpad", #selector(newScratchpad(_:)), "n"),
            item("Recoverable Drafts", #selector(showDrafts(_:)), "d", [.command, .shift]),
            item("Save", #selector(saveEditor(_:)), "s"),
            item("Save As…", #selector(saveEditorAs(_:)), "s", [.command, .shift]),
            .separator(),
            item("Open…", #selector(openDocument(_:)), "o"),
            item("Open Store Folder…", #selector(openStore(_:)), "o", [.command, .option]),
            recentHolder,
            item("Library", #selector(showLibrary(_:)), "l", [.command, .shift]),
            .separator(),
            standard("Close", #selector(NSWindow.performClose(_:)), "w"),
            item("Show in Finder", #selector(revealDocument(_:)), "r", [.command, .option]),
        ]))
        main.addItem(editMenu())
        main.addItem(viewMenu(fullScreen: true))
        main.addItem(documentMenu(returnItem: true))
        let windowMenu = submenu("Window", [
            standard("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            standard("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            standard("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        main.addItem(windowMenu)
        NSApp.windowsMenu = windowMenu.submenu
        return main
    }

    private func formatItem(_ title: String, _ command: MarkdownCommand, _ key: String) -> NSMenuItem {
        let result = item(title, #selector(formatEditor(_:)), key)
        result.representedObject = command
        return result
    }

    private func editMenu() -> NSMenuItem {
        submenu("Edit", [
            item("Undo", #selector(undoPage(_:)), "z"),
            item("Redo", #selector(redoPage(_:)), "z", [.command, .shift]),
            .separator(),
            standard("Cut", #selector(NSText.cut(_:)), "x"),
            standard("Paste", #selector(NSText.paste(_:)), "v"),
            standard("Copy", #selector(NSText.copy(_:)), "c"),
            item("Copy Passage with Source", #selector(copyPassage(_:)), "c", [.command, .option]),
            item("Copy Markdown", #selector(copyMarkdown(_:)), "c", [.command, .shift]),
            item("Select All", #selector(selectAllPage(_:)), "a"),
            item("Edit", #selector(toggleLock(_:)), "e"),
            .separator(),
            item("Ask about Selection…", #selector(askAboutSelection(_:)), "d"),
            item("Ask about Document…", #selector(askAboutDocument(_:)), "m", [.command, .option]),
            .separator(),
            submenu("Format", [
                formatItem("Bold", .bold, "b"),
                formatItem("Italic", .italic, "i"),
                formatItem("Link", .link, "k"),
                formatItem("Indent", .indent, "]"),
                formatItem("Outdent", .outdent, "["),
            ]),
            submenu("Find", [
                item("Find…", #selector(showFind(_:)), "f"),
                item("Find and Replace…", #selector(replacePage(_:)), "f", [.command, .option]),
                item("Find Next", #selector(findNext(_:)), "g"),
                item("Find Previous", #selector(findPrevious(_:)), "g", [.command, .shift]),
            ]),
        ])
    }

    private func viewMenu(fullScreen: Bool) -> NSMenuItem {
        var items = [
            item("Show Outline", #selector(toggleOutline(_:)), "s", [.command, .control]),
            item("Show Source", #selector(toggleSource(_:)), "u", [.command, .option]),
            item("Wrap Code Lines", #selector(toggleWrap(_:)), "l", [.command, .option]),
            .separator(),
            item("Bigger Text", #selector(biggerText(_:)), "="),
            item("Smaller Text", #selector(smallerText(_:)), "-"),
            item("Default Text Size", #selector(actualSize(_:)), "0"),
            submenu("Image", [
                item("Actual Size", #selector(actualImageSize(_:)), "0", [.command, .option]),
                item("Zoom to Fit", #selector(zoomToFit(_:)), "9"),
            ]),
            .separator(),
            item("Inspect Image", #selector(inspectImage(_:)), "i", [.command, .shift]),
        ]
        if fullScreen {
            items += [.separator(), standard("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])]
        }
        return submenu("View", items)
    }

    private func documentMenu(returnItem: Bool) -> NSMenuItem {
        var items = [
            item("Go Back", #selector(goBack(_:)), "["),
            item("Go Forward", #selector(goForward(_:)), "]"),
            .separator(),
            item("Show Latest Revision", #selector(refreshDocument(_:)), "r"),
            item("Older Revision", #selector(olderRevision(_:)), "[", [.command, .option]),
            item("Newer Revision", #selector(newerRevision(_:)), "]", [.command, .option]),
            item("Go to Revision…", #selector(goToRevision(_:)), "g", [.command, .option]),
            item("Review Changes", #selector(reviewChanges(_:)), ""),
            .separator(),
            item("Document Details", #selector(showDetails(_:)), "i"),
            .separator(),
            item("Export Revision Archive…", #selector(exportArchive(_:)), "e", [.command, .shift]),
            item("Export Sharing Copy…", #selector(exportSharing(_:)), "e", [.command, .option]),
            item("Export Current Page PDF…", #selector(exportPDF(_:)), ""),
        ]
        if returnItem {
            items += [.separator(), item("Return to Terminal", #selector(returnToTerminal(_:)), "r", [.command, .shift])]
        }
        return submenu("Document", items)
    }
}
