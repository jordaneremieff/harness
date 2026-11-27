import Darwin
import Foundation

@MainActor
final class EditorServiceLog {
    let url: URL
    private var attempted = false
    private var handle: FileHandle?

    init(workspace: URL, paneId: String) {
        url = workspace.appendingPathComponent("panes", isDirectory: true).appendingPathComponent("\(paneId).stderr.log")
    }

    func append(_ bytes: ArraySlice<UInt8>) {
        guard let file = openOnce() else { return }
        do { try file.write(contentsOf: Data(bytes)) }
        catch {
            try? file.close()
            handle = nil
        }
    }

    func location() -> String {
        if openOnce() != nil { return "Service log: \(url.path)" }
        return "Editor could not write the service log at \(url.path)"
    }

    private func openOnce() -> FileHandle? {
        guard !attempted else { return handle }
        attempted = true
        let directory = url.deletingLastPathComponent().path
        guard mkdir(directory, 0o700) == 0 || errno == EEXIST else { return nil }
        let parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { return nil }
        defer { close(parent) }
        var info = stat()
        guard fstat(parent, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { return nil }
        let fd = openat(parent, url.lastPathComponent, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        guard fchmod(fd, 0o600) == 0 else { close(fd); return nil }
        handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        return handle
    }
}
