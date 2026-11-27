import AppKit
import Darwin

struct WorkspaceSaveTarget: Equatable {
    let path: String
    let replacement: String?

    static func resolve(_ url: URL, in root: URL) throws -> Self {
        let folder = root.standardizedFileURL
        let target = url.standardizedFileURL
        let components = target.pathComponents.dropFirst(folder.pathComponents.count)
        guard url.isFileURL, target.pathComponents.starts(with: folder.pathComponents), !components.isEmpty else {
            throw EditorIssue(code: "invalid", message: "Choose a file inside the workspace folder.")
        }
        let path = components.joined(separator: "/")
        let reserved = [".git", ".hg", ".svn", ".bzr", "_darcs"]
        guard path.utf8.count <= 4096, !path.hasPrefix("scratch:"), !path.contains("\\"),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !components.contains(where: { reserved.contains($0.lowercased()) }) else {
            throw EditorIssue(code: "invalid", message: "Choose a workspace file outside version-control internals.")
        }
        var location = folder
        for component in components.dropLast() {
            location.appendPathComponent(component, isDirectory: true)
            var info = stat()
            guard lstat(location.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
                throw EditorIssue(code: "invalid", message: "Choose an existing workspace folder without symbolic links.")
            }
        }
        var info = stat()
        if lstat(target.path, &info) != 0 {
            guard errno == ENOENT else {
                throw EditorIssue(code: "invalid", message: "Editor could not check the selected file.")
            }
            return Self(path: path, replacement: nil)
        }
        guard info.st_mode & S_IFMT == S_IFREG else {
            throw EditorIssue(code: "invalid", message: "Choose a regular file without symbolic links.")
        }
        guard let resolved = realpath(target.path, nil) else {
            throw EditorIssue(code: "conflict", message: "The selected file changed during the save dialog.")
        }
        defer { free(resolved) }
        let canonical = URL(fileURLWithPath: String(cString: resolved)).standardizedFileURL.pathComponents
        guard canonical.starts(with: folder.pathComponents) else {
            throw EditorIssue(code: "invalid", message: "Choose a file inside the workspace folder.")
        }
        let canonicalPath = canonical.dropFirst(folder.pathComponents.count).joined(separator: "/")
        let modified = Int64(info.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(info.st_mtimespec.tv_nsec)
        let changed = Int64(info.st_ctimespec.tv_sec) * 1_000_000_000 + Int64(info.st_ctimespec.tv_nsec)
        // Match the store's identity and nanosecond timestamps for the approved destination.
        let stamp = "\(UInt32(bitPattern: info.st_dev)):\(info.st_ino):\(info.st_size):\(modified):\(changed)"
        return Self(path: canonicalPath, replacement: stamp)
    }
}

@MainActor
protocol WorkspaceSaveChoosing: AnyObject {
    func choose(in window: NSWindow) async throws -> WorkspaceSaveTarget?
    func cancel()
}

@MainActor
final class WorkspaceSavePanel: NSObject, NSOpenSavePanelDelegate, WorkspaceSaveChoosing {
    private let panel = NSSavePanel()
    private let root: URL
    private var validated: WorkspaceSaveTarget?

    init(root: String, doc: String, title: String) {
        self.root = URL(fileURLWithPath: root, isDirectory: true)
        super.init()
        panel.delegate = self
        panel.canCreateDirectories = false
        panel.treatsFilePackagesAsDirectories = true
        panel.isExtensionHidden = false
        panel.directoryURL = doc.hasPrefix("scratch:") ? self.root : self.root.appendingPathComponent(doc).deletingLastPathComponent()
        panel.nameFieldStringValue = doc.hasPrefix("scratch:") ? title : (doc as NSString).lastPathComponent
    }

    func choose(in window: NSWindow) async throws -> WorkspaceSaveTarget? {
        let answer = await panel.beginSheetModal(for: window)
        guard answer == .OK else { return nil }
        guard let url = panel.url, let validated, try WorkspaceSaveTarget.resolve(url, in: root) == validated else {
            throw EditorIssue(code: "conflict", message: "The selected file changed during the save dialog. Your draft is intact.")
        }
        return validated
    }

    func cancel() { panel.cancel(nil) }

    func panel(_ sender: Any, validate url: URL) throws {
        validated = nil
        do { validated = try WorkspaceSaveTarget.resolve(url, in: root) }
        catch { throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteInvalidFileNameError,
                              userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]) }
    }
}
