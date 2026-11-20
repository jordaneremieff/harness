import CoreServices
import Foundation

final class ExplorerWatch: @unchecked Sendable {
    private final class Observer { weak var owner: ExplorerWatch? }
    private let workspace: Workspace
    private let queue = DispatchQueue(label: "local.harness.explorer.watch", qos: .utility)
    private let store: String
    private let notify: (String, [String: Any]) -> Void
    private let roots: [String]
    private var stream: FSEventStreamRef?
    private var pending: DispatchWorkItem?
    private var paths = Set<String>()
    private var rootChanged = false
    private var gitChanged = false
    private var notesChanged = false

    init(workspace: Workspace, store: URL, notify: @escaping (String, [String: Any]) -> Void) {
        self.workspace = workspace
        self.store = canonical(store.path) ?? store.standardizedFileURL.path
        self.notify = notify
        let dirs = ["--absolute-git-dir", "--git-common-dir"].compactMap { option -> String? in
            guard let path = workspace.gitValue(["rev-parse", "--path-format=absolute", option]) else { return nil }
            return canonical(path)
        }
        roots = Array(Set(dirs))
        var existingStore = store
        while canonical(existingStore.path) == nil, existingStore.path != "/" { existingStore.deleteLastPathComponent() }
        let sources = Array(Set([workspace.root.path, canonical(existingStore.path) ?? existingStore.path] + roots))
        let observer = Observer()
        observer.owner = self
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(observer).toOpaque(), retain: { info in
            guard let info else { return nil }
            return UnsafeRawPointer(Unmanaged<Observer>.fromOpaque(info).retain().toOpaque())
        }, release: { info in
            if let info { Unmanaged<Observer>.fromOpaque(info).release() }
        }, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, eventPaths, flags, _ in
            guard let info, let watch = Unmanaged<Observer>.fromOpaque(info).takeUnretainedValue().owner else { return }
            let decoded = Unmanaged<NSArray>.fromOpaque(eventPaths).takeUnretainedValue() as? [String] ?? []
            for (i, path) in decoded.prefix(count).enumerated() { watch.record(path, flags[i]) }
        }
        stream = FSEventStreamCreate(nil, callback, &context, sources as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.12,
                                     FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagNoDefer))
        if let stream { FSEventStreamSetDispatchQueue(stream, queue); FSEventStreamStart(stream) }
    }

    deinit { stop() }

    func stop() {
        if let stream {
            FSEventStreamStop(stream); FSEventStreamInvalidate(stream); FSEventStreamRelease(stream)
            self.stream = nil
        }
    }

    private func record(_ path: String, _ flags: FSEventStreamEventFlags) {
        func relative(_ base: String) -> String? {
            let prefix = base == "/" ? "/" : base + "/"
            return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
        }
        let reset = flags & FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged) != 0
        if reset { rootChanged = true; gitChanged = workspace.isGit; notesChanged = true }
        if let local = relative(store), local.hasPrefix("repos/"), local.hasSuffix(".json") { notesChanged = true }
        if path == store { notesChanged = true }
        let metadata = roots.compactMap(relative)
        if !metadata.isEmpty {
            if metadata.contains(where: { ["HEAD", "info/exclude", "packed-refs", "refs"].contains($0) || $0.hasPrefix("refs/") }) { gitChanged = true }
        } else if let local = relative(workspace.root.path), validPath(local), relative(store) == nil, path != store {
            if paths.count < 512 || paths.contains(local) { paths.insert(local) } else { rootChanged = true }
        }
        guard rootChanged || gitChanged || notesChanged || !paths.isEmpty, pending == nil else { return }
        let task = DispatchWorkItem { [weak self] in self?.flush() }
        pending = task
        queue.asyncAfter(deadline: .now() + .milliseconds(160), execute: task)
    }

    private func flush() {
        pending = nil
        if notesChanged { notesChanged = false; notify("notes.changed", [:]) }
        if rootChanged || gitChanged || !paths.isEmpty {
            var fields: [String: Any] = ["paths": rootChanged ? [] : paths.sorted()]
            if gitChanged {
                fields["head"] = ["branch": workspace.gitValue(["symbolic-ref", "--quiet", "--short", "HEAD"]) as Any? ?? jsonNull,
                                  "head": workspace.gitValue(["rev-parse", "--verify", "HEAD^{commit}"]) as Any? ?? jsonNull]
            }
            paths.removeAll(keepingCapacity: true); rootChanged = false; gitChanged = false
            notify("files.changed", fields)
        }
    }
}
