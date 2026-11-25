import AppKit
import Darwin

/// The machine's shared pane appearance, defined by docs/conventions/pane-appearance.md: the
/// appearance (system, light or dark) and the Catppuccin flavour of the dark appearance. With a
/// file Explorer reads it, watches its folder and announces each change; without one the choice
/// stays in memory, as checks need.
@MainActor
final class ExplorerAppearance {
    nonisolated static let appearances = ["system", "light", "dark"]
    nonisolated static let darkThemes = ["frappe", "macchiato", "mocha"]
    nonisolated static let fileLimit = 64 * 1024

    private(set) var appearance = "system"
    /// Changed only on the main actor; the paper colour reads it wherever AppKit resolves it.
    nonisolated(unsafe) private(set) var darkTheme = "frappe"
    let file: URL?
    /// Runs after each change of the choice, whichever writer made it.
    var onChange: (() -> Void)?
    nonisolated(unsafe) private var watcher: DispatchSourceFileSystemObject?

    init(file: URL?, appearance: String? = nil, darkTheme: String? = nil) {
        self.file = file
        if let file { (self.appearance, self.darkTheme) = Self.read(file) }
        if let appearance, Self.appearances.contains(appearance) { self.appearance = appearance }
        if let darkTheme, Self.darkThemes.contains(darkTheme) { self.darkTheme = darkTheme }
        watch()
    }

    deinit { watcher?.cancel() }

    /// The file that the install recorded as `paneAppearance` in build.json.
    static func file(resources: URL) -> URL? {
        guard let path = buildRecord(resources)["paneAppearance"] as? String, path.hasPrefix("/"), !path.utf8.contains(0) else { return nil }
        return URL(fileURLWithPath: path)
    }

    var fields: [String: Any] { ["appearance": appearance, "darkTheme": darkTheme] }

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

    nonisolated static func read(_ file: URL) -> (appearance: String, darkTheme: String) {
        decode(try? Data(contentsOf: file, options: .mappedIfSafe))
    }

    /// Applies a choice now and replaces the file with it, keeping the value that the patch leaves out.
    func set(_ fields: [String: Any]) throws {
        guard Set(fields.keys).isSubset(of: ["appearance", "darkTheme"]) else { throw ExplorerError("invalid", "Unknown appearance field.") }
        let nextAppearance = try Self.choice(fields["appearance"], Self.appearances) ?? appearance
        let nextTheme = try Self.choice(fields["darkTheme"], Self.darkThemes) ?? darkTheme
        guard nextAppearance != appearance || nextTheme != darkTheme else { return }
        appearance = nextAppearance; darkTheme = nextTheme
        onChange?()
        guard let file else { return }
        try Self.replace(file, with: ["version": 1, "appearance": nextAppearance, "darkTheme": nextTheme])
    }

    private static func choice(_ value: Any?, _ allowed: [String]) throws -> String? {
        guard let value, !(value is NSNull) else { return nil }
        guard let text = value as? String, allowed.contains(text) else { throw ExplorerError("invalid", "The appearance choice is invalid.") }
        return text
    }

    /// Writes a private temporary file beside the target and renames it over the target.
    private static func replace(_ file: URL, with object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ExplorerError("io", "The appearance could not be saved: \(String(cString: strerror(errno))).") }
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        close(fd)
        guard written == data.count, rename(temporary.path, file.path) == 0 else {
            let reason = String(cString: strerror(errno))
            unlink(temporary.path)
            throw ExplorerError("io", "The appearance could not be saved: \(reason).")
        }
    }

    /// Reads the file again and announces a choice that differs from the one in force.
    func reload() {
        guard let file else { return }
        let next = Self.read(file)
        guard next.appearance != appearance || next.darkTheme != darkTheme else { return }
        (appearance, darkTheme) = next
        onChange?()
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

    /// The application appearance for the choice; `system` follows the system.
    var applicationAppearance: NSAppearance? {
        switch appearance {
        case "light": NSAppearance(named: .aqua)
        case "dark": NSAppearance(named: .darkAqua)
        default: nil
        }
    }

    typealias Components = (red: Int, green: Int, blue: Int)

    /// The base colour of each Catppuccin flavour from the shared palette that the build copies to
    /// themes/catppuccin.json in the bundle's resources.
    nonisolated static let bundledBases: [String: Components] =
        (try? Data(contentsOf: resourcesURL().appendingPathComponent("themes/catppuccin.json"))).map(bases) ?? [:]

    /// The `base` map of the palette's JSON: flavour names to `#rrggbb` colours.
    nonisolated static func bases(_ data: Data) -> [String: Components] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let base = object["base"] as? [String: String] else { return [:] }
        return base.compactMapValues { text in
            guard text.count == 7, text.hasPrefix("#"), let value = Int(text.dropFirst(), radix: 16) else { return nil }
            return (value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff)
        }
    }

    /// The base colour as 8-bit sRGB components: Latte in light, the chosen flavour in dark.
    nonisolated static func base(light: Bool, darkTheme: String, from bases: [String: Components] = bundledBases) -> Components? {
        bases[light ? "latte" : darkTheme] ?? (light ? nil : bases["frappe"])
    }

    /// The native paper behind the page, resolved for each drawing appearance with the flavour in force.
    var paper: NSColor {
        NSColor(name: nil) { [weak self] appearance in
            let light = appearance.bestMatch(from: [.aqua, .darkAqua]) != .darkAqua
            guard let base = ExplorerAppearance.base(light: light, darkTheme: self?.darkTheme ?? "frappe") else { return .windowBackgroundColor }
            return NSColor(srgbRed: CGFloat(base.red) / 255, green: CGFloat(base.green) / 255, blue: CGFloat(base.blue) / 255, alpha: 1)
        }
    }
}
