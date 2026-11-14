import AppKit
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

    init(mode: LaunchMode) {
        self.mode = mode
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

    /// The store folder the library shows besides those seen in open requests: the `store` path
    /// that the build recorded in the bundle's `build.json`, when it holds a store.
    static func defaultRoots(_ bundle: Bundle = .main) -> [String] {
        guard let resources = bundle.resourceURL,
              let data = try? FileAccess.readRegularFile(resources.appendingPathComponent("build.json"), limit: Limits.recordBytes, missing: .notFound("build.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let store = manifest["store"] as? String, store.hasPrefix("/"),
              FileManager.default.fileExists(atPath: store + "/" + StoreFormat.manifestName)
        else { return [] }
        return [FileAccess.canonicalPath(store)]
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        let state = ReadingStateStore(directory: mode.isCheck ? nil : Self.stateDirectory())
        let platform = mode.isCheck ? CheckRunner.platform() : MacPlatform.operations()
        windows = WindowManager(state: state, platform: platform, defaultRoots: mode.isCheck ? [] : Self.defaultRoots())
        if case .pane = mode {
            NSApp.mainMenu = buildMenu(pane: true)
        } else if !mode.isAccessory {
            NSApp.mainMenu = buildMenu(pane: false)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if case .pane(let store, let document) = mode {
            startPane(store: store, document: document)
            return
        }
        if mode.isCheck {
            Task { await CheckRunner(mode: mode, windows: windows).run() }
            return
        }
        DispatchQueue.main.async { [self] in
            if !openedAtLaunch && windows.readerWindowCount == 0 { showLibrary(nil) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // A quit request to a pane reader, such as a scripted quit or a logout, ends it like its
        // close control: the position is saved and the terminal restored before the exit.
        if case .pane = mode, let paneHost {
            paneHost.end(status: 0)
            return .terminateCancel
        }
        guard case .application = mode else { return .terminateNow }
        let answered = Flag()
        let finish: (ReadingStateFlushResult) -> Void = { result in
            guard !answered.value else { return }
            answered.value = true
            result.logFailure()
            sender.reply(toApplicationShouldTerminate: true)
        }
        let deadline = DispatchTime.now() + PaneHost.saveAllowance
        Task { @MainActor in
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
            MainActor.assumeIsolated { finish(.unconfirmed(reason: "The quit deadline passed before the save settled.")) }
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if case .pane = mode { return false }
        if !flag { showLibrary(nil) }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if case .pane = mode { return }
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

    /// Pane mode: checks the store and the document before the terminal changes, so that a wrong
    /// argument ends with one error line and a nonzero status in the pane.
    private func startPane(store root: String, document: String) {
        guard let terminal = PaneTerminal() else {
            FileHandle.standardError.write(Data("Markdown Reader: --pane needs a terminal on standard input and output.\n".utf8))
            exit(2)
        }
        let reference: DocumentReference
        do {
            let store = try DirectoryStore(root: URL(fileURLWithPath: root))
            _ = try store.document(document)
            reference = .stored(root: FileAccess.canonicalPath(root), storeId: store.storeId, document: document)
        } catch {
            // The document identifier and the error text come from the command line and the
            // store; neither may control the terminal.
            FileHandle.standardError.write(Data(TerminalText.line("Markdown Reader: \(document) cannot be shown: \(error)").utf8))
            exit(1)
        }
        let model = ReaderModel(reference: reference, platform: windows.platform, state: windows.state)
        let host = PaneHost(model: model, state: windows.state, terminal: terminal)
        paneHost = host
        windows.adopt(host.start(), model: model)
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

    @objc func showLibrary(_ sender: Any?) {
        windows.showLibrary { [weak self] in self?.openDocument(nil) }
    }

    @objc func openDocument(_ sender: Any?) {
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
        Task { await action(model) }
    }

    @objc func copyMarkdown(_ sender: Any?) { withModel { $0.copyMarkdown() } }
    @objc func showFind(_ sender: Any?) { withModel { $0.showFind() } }
    @objc func findNext(_ sender: Any?) { withModel { model in model.findVisible = true; await model.find() } }
    @objc func findPrevious(_ sender: Any?) { withModel { model in model.findVisible = true; await model.find(backwards: true) } }
    @objc func toggleOutline(_ sender: Any?) { withModel { $0.outlineVisible.toggle() } }
    @objc func toggleSource(_ sender: Any?) { withModel { await $0.toggleSource() } }
    @objc func toggleWrap(_ sender: Any?) { withModel { $0.toggleWrap() } }
    @objc func biggerText(_ sender: Any?) { withModel { $0.changeTextSize(by: 1) } }
    @objc func smallerText(_ sender: Any?) { withModel { $0.changeTextSize(by: -1) } }
    @objc func actualSize(_ sender: Any?) { withModel { $0.resetTextSize() } }
    @objc func refreshDocument(_ sender: Any?) { withModel { await $0.refresh() } }
    @objc func olderRevision(_ sender: Any?) { withModel { await $0.showAdjacentRevision(newer: false) } }
    @objc func newerRevision(_ sender: Any?) { withModel { await $0.showAdjacentRevision(newer: true) } }
    @objc func showDetails(_ sender: Any?) { withModel { $0.detailsVisible.toggle() } }
    @objc func revealDocument(_ sender: Any?) { withModel { $0.revealInFinder() } }
    @objc func returnToTerminal(_ sender: Any?) { withModel { await $0.returnToTerminal() } }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let action = item.action else { return true }
        if [#selector(showLibrary(_:)), #selector(openDocument(_:)), #selector(openRecent(_:))].contains(action) { return true }
        guard let model = windows.keyModel else { return false }
        switch action {
        case #selector(toggleOutline(_:)):
            item.state = model.outlineVisible ? .on : .off
            return !(model.rendered?.outline.isEmpty ?? true)
        case #selector(toggleSource(_:)):
            item.state = model.showingSource ? .on : .off
            return model.snapshot != nil
        case #selector(toggleWrap(_:)):
            item.state = model.settings.wrapCode ? .on : .off
            return true
        case #selector(refreshDocument(_:)):
            return model.snapshot != nil
        case #selector(olderRevision(_:)):
            guard let snapshot = model.snapshot, let revision = snapshot.revision else { return false }
            return snapshot.revisions.first.map { $0 < revision } ?? false
        case #selector(newerRevision(_:)):
            guard let snapshot = model.snapshot, let revision = snapshot.revision else { return false }
            return snapshot.revisions.last.map { $0 > revision } ?? false
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
            main.addItem(submenu("File", [standard("Close", #selector(NSWindow.performClose(_:)), "w")]))
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
            item("Open…", #selector(openDocument(_:)), "o"),
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

    private func editMenu() -> NSMenuItem {
        submenu("Edit", [
            standard("Copy", #selector(NSText.copy(_:)), "c"),
            item("Copy Markdown", #selector(copyMarkdown(_:)), "c", [.command, .shift]),
            standard("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            submenu("Find", [
                item("Find…", #selector(showFind(_:)), "f"),
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
            item("Actual Size", #selector(actualSize(_:)), "0"),
        ]
        if fullScreen {
            items += [.separator(), standard("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])]
        }
        return submenu("View", items)
    }

    private func documentMenu(returnItem: Bool) -> NSMenuItem {
        var items = [
            item("Show Latest Revision", #selector(refreshDocument(_:)), "r"),
            item("Older Revision", #selector(olderRevision(_:)), "[", [.command, .option]),
            item("Newer Revision", #selector(newerRevision(_:)), "]", [.command, .option]),
            .separator(),
            item("Document Details", #selector(showDetails(_:)), "i"),
        ]
        if returnItem {
            items += [.separator(), item("Return to Terminal", #selector(returnToTerminal(_:)), "r", [.command, .shift])]
        }
        return submenu("Document", items)
    }
}
