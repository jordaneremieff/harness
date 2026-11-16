import AppKit
import EditorFeature
import MarkdownCore
import ReaderFeature
import SwiftUI

/// A reader's window. Escape that no view handles ends what lies over the document: an image
/// inspection or a comparison.
final class ReaderWindow: NSWindow {
    /// Returns true when it handled the cancel.
    var onCancel: (() -> Bool)?

    override func cancelOperation(_ sender: Any?) {
        if onCancel?() != true { super.cancelOperation(sender) }
    }
}

/// One window per document. A repeated open of a document brings its window forward and passes
/// the open's launch origin to it.
@MainActor
final class WindowManager: NSObject, NSWindowDelegate {
    private struct Reader {
        let window: NSWindow
        let model: ReaderModel
    }

    let state: ReadingStateStore
    let platform: ReaderPlatform
    let defaultRoots: [String]
    private var readers: [String: Reader] = [:]
    private var closing: [UUID: Task<Void, Never>] = [:]
    private var libraryWindow: NSWindow?
    private var libraryModel: LibraryModel?
    private var editorWindow: NSWindow?
    private(set) var editor: EditorWorkspace?
    private var editorCloseAllowed = false

    var keyEditor: EditorWorkspace? {
        guard let window = NSApp.keyWindow, window === editorWindow else { return nil }
        return editor
    }

    @discardableResult func showEditor(newScratchpad: Bool = true, record: DraftRecord? = nil, store: String? = nil, origin: LaunchOrigin? = nil) -> EditorWorkspace {
        if let editorWindow, let editor {
            if let store { editor.selectedStore = store }
            if let origin { editor.launchOrigin = origin }
            if let record { editor.add(record) }
            else if newScratchpad { editor.newScratchpad() }
            else { Task { await editor.library() } }
            editorWindow.makeKeyAndOrderFront(nil)
            NSApp.activate()
            return editor
        }
        let workspace = EditorWorkspace(directory: AppDelegate.stateDirectory().appendingPathComponent("Drafts"), store: store ?? state.selectedStoreRoot ?? defaultRoots.first)
        let host = NSHostingController(rootView: EditorWorkspaceView(workspace: workspace))
        host.sizingOptions = []
        let window = ReaderWindow(contentViewController: host)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .unifiedTitleAndToolbar]
        window.title = "Markdown Workspace"
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 360, height: 320)
        window.setContentSize(NSSize(width: 960, height: 800))
        window.center(); window.delegate = self
        editor = workspace; editorWindow = window
        workspace.launchOrigin = origin
        if let record { workspace.add(record) }
        else if newScratchpad { workspace.newScratchpad() }
        else { Task { await workspace.library() } }
        window.makeKeyAndOrderFront(nil); NSApp.activate()
        return workspace
    }

    func adoptEditor(_ window: NSWindow, workspace: EditorWorkspace) {
        readers = readers.filter { $0.value.window !== window }
        editorWindow = window; editor = workspace
    }

    func retainEditors() async -> Bool { await editor?.prepareToClose() ?? true }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === editorWindow, !editorCloseAllowed, let editor else { return true }
        Task {
            guard await editor.prepareToClose() else {
                if !editor.documents.contains(where: { $0.text.hasMarkedText }) { editor.notice = "Recovery failed. The workspace stays open to protect your text." }
                return
            }
            editorCloseAllowed = true
            sender.close()
        }
        return false
    }

    init(state: ReadingStateStore, platform: ReaderPlatform, defaultRoots: [String]) {
        self.state = state
        self.platform = platform
        self.defaultRoots = defaultRoots
    }

    var readerWindowCount: Int { readers.count }

    func selectStore(_ root: String) async {
        editor?.selectedStore = root
        await libraryModel?.selectStore(root)
        await editor?.publishedLibrary?.selectStore(root)
    }

    func closeReaders() async {
        await editor?.closeViews()
        let models = readers.values.map(\.model)
        for model in models { await model.close() }
        for task in Array(closing.values) { await task.value }
    }

    var keyModel: ReaderModel? {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { return nil }
        return readers.values.first { $0.window === window }?.model
    }

    func model(for reference: DocumentReference) -> ReaderModel? {
        readers[reference.key]?.model
    }

    /// Lists a window that another owner created and closes, such as the pane reader's window, so
    /// that menu actions reach its model.
    func adopt(_ window: NSWindow, model: ReaderModel) {
        readers[model.reference.key] = Reader(window: window, model: model)
    }

    /// Moves an adopted window to another model, as when a pane reader shows another document.
    func replace(_ previous: ReaderModel, with next: ReaderModel) {
        guard let reader = readers[previous.reference.key], reader.model === previous else { return }
        readers[previous.reference.key] = nil
        readers[next.reference.key] = Reader(window: reader.window, model: next)
    }

    /// `digest` is the digest of an accepted open request, which the open's load must find.
    @discardableResult
    func open(_ reference: DocumentReference, revision: Int?, digest: String? = nil, origin: LaunchOrigin?) -> ReaderModel {
        if let reader = readers[reference.key] {
            reader.window.makeKeyAndOrderFront(nil)
            NSApp.activate()
            Task { await reader.model.open(revision: revision, digest: digest, origin: origin) }
            return reader.model
        }
        let model = ReaderModel(reference: reference, platform: platform, state: state)
        let window = makeWindow(model: model)
        readers[reference.key] = Reader(window: window, model: model)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        Task { await model.open(revision: revision, digest: digest, origin: origin) }
        return model
    }

    private func makeWindow(model: ReaderModel) -> NSWindow {
        let host = NSHostingController(rootView: ReaderView(model: model))
        host.sizingOptions = []
        host.sceneBridgingOptions = [.toolbars]
        let window = ReaderWindow(contentViewController: host)
        window.onCancel = { [weak model] in model?.dismissOverlay() ?? false }
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .unifiedTitleAndToolbar]
        window.toolbarStyle = .unified
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 360, height: 320)
        window.tabbingIdentifier = "reader"
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(960, visible.width - 80), height: min(1040, visible.height - 40))
        window.setContentSize(size)
        if let key = NSApp.keyWindow, readers.values.contains(where: { $0.window === key }) {
            window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: key.frame.minX, y: key.frame.maxY)))
        } else {
            window.center()
        }
        window.title = "Opening…"
        window.delegate = self
        trackTitle(window: window, model: model)
        return window
    }

    private func trackTitle(window: NSWindow, model: ReaderModel) {
        withObservationTracking {
            if let snapshot = model.snapshot {
                window.title = model.displayTitle
                let stored = snapshot.document?.kind == .response ? snapshot.title : Provenance.kindLabel(snapshot)
                window.subtitle = model.showingSource ? "Source · \(stored)" : stored
                if case .file(let path) = model.reference {
                    window.representedURL = URL(fileURLWithPath: path)
                }
            } else if case .failed = model.phase {
                window.title = "Not opened"
            }
        } onChange: { [weak self, weak window, weak model] in
            Task { @MainActor in
                guard let self, let window, let model else { return }
                self.trackTitle(window: window, model: model)
            }
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if window === editorWindow {
            if let editor { Task { await editor.closeViews() } }
            editorWindow = nil; editor = nil; editorCloseAllowed = false
            return
        }
        if window === libraryWindow {
            libraryWindow = nil
            return
        }
        guard let entry = readers.first(where: { $0.value.window === window }) else { return }
        readers.removeValue(forKey: entry.key)
        let model = entry.value.model
        let id = UUID()
        closing[id] = Task { [weak self] in
            await model.close()
            self?.closing.removeValue(forKey: id)
        }
    }

    func showLibrary(openFile: @escaping () -> Void, openStore: @escaping () -> Void) {
        if let libraryWindow {
            libraryWindow.makeKeyAndOrderFront(nil)
            Task { await libraryModel?.reload() }
            NSApp.activate()
            return
        }
        let model = LibraryModel(state: state, extraRoots: defaultRoots)
        let view = LibraryView(model: model, open: { [weak self] reference in
            self?.open(reference, revision: nil, origin: nil)
        }, openFile: openFile, openStore: openStore)
        let host = NSHostingController(rootView: view)
        host.sizingOptions = []
        host.sceneBridgingOptions = [.toolbars]
        let window = NSWindow(contentViewController: host)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .unifiedTitleAndToolbar]
        window.title = "Markdown Library"
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 620, height: 640))
        window.contentMinSize = NSSize(width: 360, height: 300)
        window.setFrameAutosaveName("Library")
        window.delegate = self
        libraryWindow = window
        libraryModel = model
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }
}
