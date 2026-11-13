import AppKit
import MarkdownCore
import ReaderFeature
import SwiftUI

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
    private var libraryWindow: NSWindow?
    private var libraryModel: LibraryModel?

    init(state: ReadingStateStore, platform: ReaderPlatform, defaultRoots: [String]) {
        self.state = state
        self.platform = platform
        self.defaultRoots = defaultRoots
    }

    var readerWindowCount: Int { readers.count }

    var keyModel: ReaderModel? {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { return nil }
        return readers.values.first { $0.window === window }?.model
    }

    func model(for reference: DocumentReference) -> ReaderModel? {
        readers[reference.key]?.model
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
        let window = NSWindow(contentViewController: host)
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
        if window === libraryWindow {
            libraryWindow = nil
            return
        }
        guard let entry = readers.first(where: { $0.value.window === window }) else { return }
        readers.removeValue(forKey: entry.key)
        let model = entry.value.model
        Task { await model.close() }
    }

    func showLibrary(openFile: @escaping () -> Void) {
        if let libraryWindow {
            libraryWindow.makeKeyAndOrderFront(nil)
            Task { await libraryModel?.reload() }
            NSApp.activate()
            return
        }
        let model = LibraryModel(state: state, extraRoots: defaultRoots)
        let view = LibraryView(model: model, open: { [weak self] reference in
            self?.open(reference, revision: nil, origin: nil)
        }, openFile: openFile)
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
