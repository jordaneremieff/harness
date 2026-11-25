import Darwin
import Foundation
import Observation

/// The machine's shared pane appearance, defined by docs/conventions/pane-appearance.md: the
/// appearance (system, light or dark) and the Catppuccin flavour of the dark appearance. With a
/// file the store reads it, watches its folder and takes in each change that another process
/// writes; without one the choice stays in memory, as check modes need.
@MainActor @Observable
public final class PaneAppearance {
    nonisolated public static let appearances = ["system", "light", "dark"]
    nonisolated public static let darkThemes = ["frappe", "macchiato", "mocha"]
    nonisolated static let fileLimit = 64 * 1024

    public private(set) var appearance = "system"
    public private(set) var darkTheme = "frappe"
    @ObservationIgnored public let file: URL?
    @ObservationIgnored nonisolated(unsafe) private var watcher: DispatchSourceFileSystemObject?

    public init(file: URL?, appearance: String? = nil, darkTheme: String? = nil) {
        self.file = file
        if let file { (self.appearance, self.darkTheme) = Self.read(file) }
        if let appearance, Self.appearances.contains(appearance) { self.appearance = appearance }
        if let darkTheme, Self.darkThemes.contains(darkTheme) { self.darkTheme = darkTheme }
        watch()
    }

    deinit { watcher?.cancel() }

    /// The choice in a file's bytes; anything unreadable is the default choice.
    nonisolated static func decode(_ data: Data?) -> (appearance: String, darkTheme: String) {
        guard let data, data.count <= fileLimit,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1
        else { return ("system", "frappe") }
        let appearance = (object["appearance"] as? String).flatMap { appearances.contains($0) ? $0 : nil } ?? "system"
        let darkTheme = (object["darkTheme"] as? String).flatMap { darkThemes.contains($0) ? $0 : nil } ?? "frappe"
        return (appearance, darkTheme)
    }

    nonisolated public static func read(_ file: URL) -> (appearance: String, darkTheme: String) {
        decode(try? Data(contentsOf: file, options: .mappedIfSafe))
    }

    /// Applies a choice now and replaces the file with it. Unknown values change nothing.
    public func set(appearance: String? = nil, darkTheme: String? = nil) throws {
        let nextAppearance = appearance.flatMap { Self.appearances.contains($0) ? $0 : nil } ?? self.appearance
        let nextTheme = darkTheme.flatMap { Self.darkThemes.contains($0) ? $0 : nil } ?? self.darkTheme
        guard nextAppearance != self.appearance || nextTheme != self.darkTheme else { return }
        self.appearance = nextAppearance; self.darkTheme = nextTheme
        guard let file else { return }
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "appearance": nextAppearance, "darkTheme": nextTheme],
                                              options: [.sortedKeys])
        let folder = file.deletingLastPathComponent()
        let temporary = folder.appendingPathComponent(".\(file.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        close(fd)
        guard written == data.count, rename(temporary.path, file.path) == 0 else {
            let code = POSIXErrorCode(rawValue: errno) ?? .EIO
            unlink(temporary.path)
            throw POSIXError(code)
        }
    }

    /// Reads the file again and takes in a choice that differs from the one in force.
    public func reload() {
        guard let file else { return }
        let (appearance, darkTheme) = Self.read(file)
        if appearance != self.appearance { self.appearance = appearance }
        if darkTheme != self.darkTheme { self.darkTheme = darkTheme }
    }

    /// Writers replace the file by a rename in its folder, so a change to the folder's entries
    /// announces every new choice.
    private func watch() {
        guard let folder = file?.deletingLastPathComponent() else { return }
        let fd = open(folder.path, O_EVTONLY | O_CLOEXEC)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.reload() } }
        source.setCancelHandler { close(fd) }
        watcher = source
        source.resume()
    }
}
