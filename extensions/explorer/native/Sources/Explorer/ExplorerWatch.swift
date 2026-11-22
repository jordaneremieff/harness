import CoreServices
import Foundation

func affectsNotes(_ storePath: String) -> Bool {
    let parts = storePath.split(separator: "/")
    guard parts.first == "repos" else { return false }
    if parts.count == 3 { return parts[2] == "repo.json" }
    return parts.count == 4 && (parts[2] == "notes" || parts[2] == "tours") && parts[3].hasSuffix(".json")
}

final class ExplorerWatch: @unchecked Sendable {
    private final class Observer { weak var owner: ExplorerWatch? }
    private let queue = DispatchQueue(label: "local.harness.explorer.watch", qos: .utility)
    private let notify: (String, [String: Any]) -> Void
    private var changes: ExplorerChangeBatch
    private var stream: FSEventStreamRef?
    private var pending: DispatchWorkItem?

    init(workspace: Workspace, store: URL, notify: @escaping (String, [String: Any]) -> Void) {
        self.notify = notify
        let dirs = ["--absolute-git-dir", "--git-common-dir"].compactMap { option -> String? in
            guard let path = workspace.gitValue(["rev-parse", "--path-format=absolute", option]) else { return nil }
            return canonical(path)
        }
        let roots = Array(Set(dirs))
        changes = ExplorerChangeBatch(workspace: workspace, store: canonical(store.path) ?? store.standardizedFileURL.path,
                                      gitRoots: roots)
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
        changes.record(path, flags)
        guard changes.hasChanges, pending == nil else { return }
        let task = DispatchWorkItem { [weak self] in self?.flush() }
        pending = task
        queue.asyncAfter(deadline: .now() + .milliseconds(160), execute: task)
    }

    private func flush() {
        pending = nil
        for (type, fields) in changes.flush() { notify(type, fields) }
    }
}

struct ExplorerChangeBatch {
    let workspace: Workspace
    let store: String
    let gitRoots: [String]
    private var paths = Set<String>()
    private var structural = Set<String>()
    private var indexChanged = false
    private var rootChanged = false
    private var gitChanged = false
    private var notesChanged = false

    init(workspace: Workspace, store: String, gitRoots: [String]) {
        self.workspace = workspace; self.store = store; self.gitRoots = gitRoots
    }

    var hasChanges: Bool { rootChanged || gitChanged || indexChanged || notesChanged || !paths.isEmpty }

    private mutating func insert(_ path: String, structural isStructural: Bool) {
        guard validPath(path) else { return }
        guard paths.count < 512 || paths.contains(path) else { rootChanged = true; return }
        paths.insert(path)
        if isStructural { structural.insert(path) }
    }

    mutating func record(_ path: String, _ flags: FSEventStreamEventFlags) {
        func relative(_ base: String) -> String? {
            let value = relativePath(path, to: base)
            return value == "" ? nil : value
        }
        let reset = flags & FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged) != 0
        if reset { rootChanged = true; gitChanged = workspace.isGit; notesChanged = true }
        if let local = relative(store), affectsNotes(local) { notesChanged = true }
        if path == store { notesChanged = true }
        let metadata = gitRoots.compactMap(relative)
        if !metadata.isEmpty {
            if metadata.contains(where: { ["HEAD", "info/exclude", "packed-refs", "refs"].contains($0) || $0.hasPrefix("refs/") }) { gitChanged = true }
            if metadata.contains("index") { indexChanged = true }
        } else if let local = relative(workspace.root.path), relative(store) == nil, path != store {
            let components = local.split(separator: "/")
            if let dotGit = components.firstIndex(where: { $0.lowercased() == ".git" }), dotGit > 0 {
                switch components.dropFirst(dotGit + 1).joined(separator: "/") {
                case "", "HEAD": insert(components[..<dotGit].joined(separator: "/"), structural: true)
                case "index": indexChanged = true
                case "info/exclude": rootChanged = true
                default: break
                }
            } else if validPath(local) {
                let shapeFlags = kFSEventStreamEventFlagItemCreated | kFSEventStreamEventFlagItemRemoved | kFSEventStreamEventFlagItemRenamed
                insert(local, structural: flags & FSEventStreamEventFlags(shapeFlags) != 0)
                // An ignore rule can change the index and annotations without changing the affected files.
                if components.last == ".gitignore" { rootChanged = true }
            }
        }
    }

    mutating func flush() -> [(String, [String: Any])] {
        defer {
            if rootChanged || gitChanged || indexChanged || !structural.isEmpty { workspace.indexCache.invalidate() }
            paths.removeAll(keepingCapacity: true); structural.removeAll(keepingCapacity: true)
            rootChanged = false; gitChanged = false; indexChanged = false; notesChanged = false
        }
        var events: [(String, [String: Any])] = []
        if notesChanged { events.append(("notes.changed", [:])) }
        // The Git index can change without changing a folder row or a note.
        guard rootChanged || gitChanged || !paths.isEmpty else { return events }
        let local = rootChanged ? [] : paths.sorted()
        var fields: [String: Any] = ["paths": local]
        if !local.isEmpty {
            fields["structural"] = structural.sorted()
            if workspace.isGit { fields["outside"] = workspace.outsideRootRepository(local) }
        }
        if gitChanged {
            fields["head"] = ["branch": workspace.gitValue(["symbolic-ref", "--quiet", "--short", "HEAD"]) as Any? ?? jsonNull,
                              "head": workspace.gitValue(["rev-parse", "--verify", "HEAD^{commit}"]) as Any? ?? jsonNull]
        }
        events.append(("files.changed", fields))
        return events
    }
}
