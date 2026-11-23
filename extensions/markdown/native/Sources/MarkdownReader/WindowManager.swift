import AppKit
import EditorFeature
import MarkdownCore
import ReaderFeature

final class ReaderWindow: NSWindow {
    var onCancel: (() -> Bool)?
    override func cancelOperation(_ sender: Any?) {
        if onCancel?() != true { super.cancelOperation(sender) }
    }
}

@MainActor
final class WindowManager: NSObject, NSWindowDelegate {
    private struct Reader {
        let window: NSWindow
        let model: ReaderModel
        var workspace: EditorWorkspace?
    }
    let state: ReadingStateStore
    let platform: ReaderPlatform
    let defaultRoots: [String]
    private var readers: [ObjectIdentifier: Reader] = [:]
    private var surfaces: [ObjectIdentifier: ReaderSurface] = [:]
    private var editorWindow: NSWindow?
    private(set) var editor: EditorWorkspace?
    private var closeAllowed: Set<ObjectIdentifier> = []
    private var preparingWindows: Set<ObjectIdentifier> = []

    init(state: ReadingStateStore, platform: ReaderPlatform, defaultRoots: [String]) {
        self.state = state; self.platform = platform; self.defaultRoots = defaultRoots
    }
    var readerWindowCount: Int { readers.count }
    var keySurface: ReaderSurface? {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { return nil }
        return surfaces[ObjectIdentifier(window)] ?? window.contentView?.subviews.compactMap { $0 as? ReaderSurface }.first
    }
    var keyEditor: EditorWorkspace? { keySurface?.workspace ?? (NSApp.keyWindow === editorWindow ? editor : nil) }
    var keyModel: ReaderModel? { keySurface?.model ?? readers.values.first { $0.window === (NSApp.keyWindow ?? NSApp.mainWindow) }?.model }
    private func displays(_ reader: Reader, reference: DocumentReference) -> Bool {
        guard reader.model.reference == reference else { return false }
        let workspace = surfaces[ObjectIdentifier(reader.window)]?.workspace
        return workspace == nil || workspace?.reading === reader.model
    }
    func model(for reference: DocumentReference) -> ReaderModel? { readers.values.first { displays($0, reference: reference) }?.model }

    func adopt(_ window: NSWindow, model: ReaderModel, workspace: EditorWorkspace? = nil) {
        readers[ObjectIdentifier(window)] = Reader(window: window, model: model, workspace: workspace)
        if let surface = window.contentView as? ReaderSurface { surfaces[ObjectIdentifier(window)] = surface }
        else if let surface = window.contentView?.subviews.compactMap({ $0 as? ReaderSurface }).first { surfaces[ObjectIdentifier(window)] = surface }
    }
    func adoptEditor(_ window: NSWindow, workspace: EditorWorkspace) {
        editorWindow = window; editor = workspace
        if let surface = window.contentView as? ReaderSurface { surfaces[ObjectIdentifier(window)] = surface }
        else if let surface = window.contentView?.subviews.compactMap({ $0 as? ReaderSurface }).first { surfaces[ObjectIdentifier(window)] = surface }
    }

    @discardableResult
    func open(_ reference: DocumentReference, revision: Int?, digest: String? = nil, origin: LaunchOrigin?) -> ReaderModel {
        if let reader = readers.values.first(where: { displays($0, reference: reference) }) {
            reader.window.orderFrontRegardless()
            Task { await reader.model.open(revision: revision, digest: digest, origin: origin) }
            return reader.model
        }
        let model = ReaderModel(reference: reference, platform: platform, state: state)
        let surface = ReaderSurface(model: model, state: state, chrome: "window")
        let window = makeWindow(surface: surface)
        readers[ObjectIdentifier(window)] = Reader(window: window, model: model, workspace: nil)
        surface.onWorkspace = { [weak self, weak window] workspace in
            guard let self, let window else { return }
            self.readers[ObjectIdentifier(window)]?.workspace = workspace
            self.surfaces[ObjectIdentifier(window)] = surface
        }
        window.orderFrontRegardless()
        Task { await model.open(revision: revision, digest: digest, origin: origin) }
        return model
    }

    private func makeWindow(surface: ReaderSurface) -> NSWindow {
        let window = ReaderWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.contentView = surface
        window.backgroundColor = ReaderSurface.paperColour
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 360, height: 320)
        window.delegate = self; window.center()
        surface.onClose = { [weak window] in window?.performClose(nil) }
        window.onCancel = { [weak surface] in surface?.sendCommand("escape"); return true }
        surfaces[ObjectIdentifier(window)] = surface
        return window
    }

    @discardableResult
    func showEditor(newScratchpad: Bool = true, record: DraftRecord? = nil, store: String? = nil, origin: LaunchOrigin? = nil) -> EditorWorkspace {
        if let editor, let editorWindow {
            if let record { editor.add(record) } else if newScratchpad { editor.newScratchpad() }
            editorWindow.orderFrontRegardless(); return editor
        }
        let workspace = EditorWorkspace(directory: AppDelegate.stateDirectory().appendingPathComponent("Drafts"), store: store ?? state.selectedStoreRoot ?? defaultRoots.first, automaticallySaves: true)
        workspace.launchOrigin = origin
        if let record { workspace.add(record) } else if newScratchpad { workspace.newScratchpad() }
        let model = ReaderModel(reference: .file(path: "draft:" + (workspace.active?.session.record.id.uuidString ?? UUID().uuidString)), platform: platform, state: state)
        let surface = ReaderSurface(model: model, state: state, chrome: "window", workspace: workspace)
        let window = makeWindow(surface: surface)
        editor = workspace; editorWindow = window
        window.orderFrontRegardless()
        if !newScratchpad, record == nil { surface.sendCommand("open") }
        return workspace
    }
    func showLibrary(openFile: @escaping () -> Void, openStore: @escaping () -> Void) {
        _ = showEditor(newScratchpad: false)
        if let editorWindow { surfaces[ObjectIdentifier(editorWindow)]?.sendCommand("showLibrary") }
    }
    func selectStore(_ root: String) async { editor?.selectedStore = root }
    private var workspaces: [EditorWorkspace] {
        var result = readers.values.compactMap(\.workspace)
        if let editor, !result.contains(where: { $0 === editor }) { result.append(editor) }
        return result
    }
    func resumeEditors() { for workspace in workspaces { workspace.resumeEdits() } }
    func refuseQuitBeforeRecovery(retained: Bool) -> Bool {
        guard !retained, !workspaces.isEmpty else { return false }
        resumeEditors(); return true
    }
    func retainEditors(saveDeadline: DispatchTime) async -> Bool {
        var result = true
        for workspace in workspaces {
            if Task.isCancelled { result = false; break }
            if !(await workspace.prepareToClose(saveDeadline: saveDeadline)) { result = false }
        }
        if !result { resumeEditors() }
        return result
    }
    func closeReaders() async {
        for workspace in workspaces { await workspace.closeViews() }
        for reader in readers.values { await reader.model.close() }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        let id = ObjectIdentifier(sender)
        guard !closeAllowed.contains(id), let workspace = surfaces[id]?.workspace else { return true }
        guard preparingWindows.insert(id).inserted else { return false }
        Task {
            defer { preparingWindows.remove(id) }
            let saved = Flag(), deadline = DispatchTime.now() + PaneHost.saveAllowance
            let finished = await PaneHost.run(until: deadline) {
                saved.value = await workspace.prepareToClose(saveDeadline: deadline)
            }
            guard finished else {
                workspace.resumeEdits()
                workspace.notice = "The reader did not confirm draft recovery in time. This window remains open."
                return
            }
            guard saved.value, workspace.closing else { return }
            closeAllowed.insert(id); sender.close()
        }
        return false
    }
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        let surface = surfaces.removeValue(forKey: ObjectIdentifier(window))
        readers = readers.filter { $0.value.window !== window }
        if window === editorWindow { editorWindow = nil; editor = nil }
        closeAllowed.remove(ObjectIdentifier(window))
        Task { await surface?.workspace?.closeViews(); await surface?.model.close() }
    }
}
