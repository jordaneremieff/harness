import AppKit
import Darwin

/// Calls `changed` on the main queue when a file changes: when it is written in place, or when
/// a writer replaces, creates or removes it in its folder.
@MainActor
final class FileWatch {
    private let file: URL
    private let changed: () -> Void
    private var folder: DispatchSourceFileSystemObject?
    private var target: DispatchSourceFileSystemObject?

    init(_ file: URL, changed: @escaping () -> Void) {
        self.file = file
        self.changed = changed
        folder = Self.source(file.deletingLastPathComponent().path, [.write]) { [weak self] in self?.folderChanged() }
        watchTarget()
    }

    deinit {
        folder?.cancel()
        target?.cancel()
    }

    private func folderChanged() {
        watchTarget()
        changed()
    }

    private func watchTarget() {
        target?.cancel()
        target = Self.source(file.path, [.write, .extend, .delete, .rename]) { [weak self] in
            guard let self else { return }
            changed()
            // A replaced or removed file leaves this descriptor on the old inode.
            if let target, !target.data.isDisjoint(with: [.delete, .rename]) { watchTarget() }
        }
    }

    private static func source(_ path: String, _ mask: DispatchSource.FileSystemEvent,
                               _ handler: @escaping @MainActor () -> Void) -> DispatchSourceFileSystemObject? {
        let fd = open(path, O_EVTONLY | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: mask, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { handler() } }
        source.setCancelHandler { close(fd) }
        source.resume()
        return source
    }
}

/// Writes a whole file through a temporary file in the same folder and a rename, so a reader never
/// sees part of a write.
func replaceFileAtomically(_ url: URL, with data: Data) throws {
    let folder = url.deletingLastPathComponent()
    let temporary = folder.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
    let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: temporary.path]) }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    do {
        try handle.write(contentsOf: data)
        try handle.synchronize()
        try handle.close()
        guard rename(temporary.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path]) }
    } catch {
        unlink(temporary.path)
        throw error
    }
}

/// The machine's shared pane appearance (docs/conventions/pane-appearance.md): System, Light or
/// Dark, and the Catppuccin flavour of the dark appearance. A choice made here reaches the other
/// pane apps that follow the convention, and their choices reach this one.
@MainActor
final class PaneAppearance {
    enum Mode: String, CaseIterable { case system, light, dark }
    enum Flavour: String, CaseIterable { case frappe, macchiato, mocha }

    private(set) var mode = Mode.system
    private(set) var flavour = Flavour.frappe
    /// Runs after the choice changes, here or in another app.
    var onChange: (() -> Void)?
    private let file: URL?
    private var watch: FileWatch?
    private var systemObservation: NSKeyValueObservation?

    /// Without a file the choice stays in memory, as for a bundle built without the record.
    init(file: URL?) {
        self.file = file
        read()
        if let file { watch = FileWatch(file) { [weak self] in self?.reload() } }
        reported = shownFlavour
        systemObservation = NSApp?.observe(\.effectiveAppearance) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.systemChanged() }
        }
    }

    /// The flavour on show at the last report, so that a change of the system appearance reports
    /// once, and setting the application appearance in response reports nothing.
    private var reported = ""

    private func systemChanged() {
        guard mode == .system, shownFlavour != reported else { return }
        reported = shownFlavour
        onChange?()
    }

    /// The Catppuccin flavour on show: Latte in the light appearance.
    var shownFlavour: String {
        let dark: Bool
        switch mode {
        case .dark: dark = true
        case .light: dark = false
        case .system: dark = NSApp?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) != .aqua
        }
        return dark ? flavour.rawValue : "latte"
    }

    /// The application appearance that system controls such as scrollers and menus follow.
    var applicationAppearance: NSAppearance? {
        switch mode {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }

    func choose(mode: Mode? = nil, flavour: Flavour? = nil) {
        let next = (mode ?? self.mode, flavour ?? self.flavour)
        guard next != (self.mode, self.flavour) else { return }
        (self.mode, self.flavour) = next
        reported = shownFlavour
        if let file {
            let record: [String: Any] = ["version": 1, "appearance": next.0.rawValue, "darkTheme": next.1.rawValue]
            if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
                try? replaceFileAtomically(file, with: data + Data("\n".utf8))
            }
        }
        onChange?()
    }

    private func reload() {
        let before = (mode, flavour)
        read()
        reported = shownFlavour
        if before != (mode, flavour) { onChange?() }
    }

    /// A file with another version, or one that does not parse, counts as absent.
    private func read() {
        var record: [String: Any] = [:]
        if let file, let data = try? Data(contentsOf: file), data.count <= 65_536,
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           (object["version"] as? NSNumber)?.intValue == 1 {
            record = object
        }
        mode = (record["appearance"] as? String).flatMap(Mode.init(rawValue:)) ?? .system
        flavour = (record["darkTheme"] as? String).flatMap(Flavour.init(rawValue:)) ?? .frappe
    }
}
