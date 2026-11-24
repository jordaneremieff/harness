import AppKit
import AppPaneCore

/// The applications of this Mac that a pane can show: running applications with a Dock presence
/// and the application bundles at the top level of the standard application folders.
@MainActor
enum Catalogue {
    static var folders: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) } + [home.appendingPathComponent("Applications", isDirectory: true)]
    }

    static func entries() -> [AppEntry] {
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        let runningPaths = Set(running.compactMap { $0.bundleURL?.standardizedFileURL.path })
        var result = running.compactMap { application -> AppEntry? in
            guard let url = application.bundleURL?.standardizedFileURL else { return nil }
            let name = application.localizedName ?? url.deletingPathExtension().lastPathComponent
            return AppEntry(name: name, path: url.path, bundleIdentifier: application.bundleIdentifier, running: true)
        }
        for folder in folders {
            let items = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
            for url in items where url.pathExtension == "app" {
                let path = url.standardizedFileURL.path
                guard !runningPaths.contains(path) else { continue }
                result.append(AppEntry(name: url.deletingPathExtension().lastPathComponent, path: path,
                                       bundleIdentifier: Bundle(url: url)?.bundleIdentifier, running: false))
            }
        }
        return Applications.merged(result)
    }

    /// The application that `text` names: an absolute bundle path, a bundle identifier or a name.
    static func resolve(_ text: String) -> AppMatch {
        if text.hasPrefix("/") {
            let url = URL(fileURLWithPath: text).standardizedFileURL
            var directory: ObjCBool = false
            guard url.pathExtension == "app", FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), directory.boolValue,
                  let bundle = Bundle(url: url) else { return .missing }
            let running = NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.standardizedFileURL == url }
            return .found(AppEntry(name: url.deletingPathExtension().lastPathComponent, path: url.path,
                                   bundleIdentifier: bundle.bundleIdentifier, running: running))
        }
        var entries = self.entries()
        if Applications.isBundleIdentifier(text), !entries.contains(where: { $0.bundleIdentifier?.lowercased() == text.lowercased() }),
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: text) {
            entries.append(AppEntry(name: url.deletingPathExtension().lastPathComponent, path: url.standardizedFileURL.path,
                                    bundleIdentifier: Bundle(url: url)?.bundleIdentifier, running: false))
        }
        return Applications.match(text, in: entries)
    }
}
