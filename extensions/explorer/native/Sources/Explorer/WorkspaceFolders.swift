import Darwin
import Foundation

func uptime() -> Double { ProcessInfo.processInfo.systemUptime }

func relativePath(_ path: String, to root: String) -> String? {
    if path == root { return "" }
    let prefix = root == "/" ? "/" : root + "/"
    return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
}

func childPath(_ parent: String, _ name: String) -> String { parent.isEmpty ? name : parent + "/" + name }

func jsonStringCost(_ value: String) -> Int {
    value.utf8.reduce(3) { cost, byte in cost + (byte < 32 ? 6 : byte == 34 || byte == 92 ? 2 : 1) }
}

struct RepositoryMarker: Equatable {
    let branch: String?
    let head: String?

    var fields: [String: Any] { ["branch": branch as Any? ?? jsonNull, "head": head as Any? ?? jsonNull] }

    private static func smallFile(_ path: String) -> String? {
        let fd = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { return nil }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var details = stat()
        guard fstat(fd, &details) == 0, details.st_mode & S_IFMT == S_IFREG, details.st_size <= 4096,
              let data = try? handle.read(upToCount: 4097), data.count <= 4096 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func read(_ folder: String) -> RepositoryMarker? {
        let dotGit = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent(".git")
        var details = stat()
        guard lstat(dotGit.path, &details) == 0 else { return nil }
        let headPath: String
        switch details.st_mode & S_IFMT {
        case S_IFDIR: headPath = dotGit.path + "/HEAD"
        case S_IFREG:
            guard let pointer = smallFile(dotGit.path), pointer.hasPrefix("gitdir:") else { return nil }
            let target = String(pointer.dropFirst(7)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !target.isEmpty, !target.utf8.contains(0) else { return nil }
            headPath = (target.hasPrefix("/") ? target : folder + "/" + target) + "/HEAD"
        default: return nil
        }
        let value = smallFile(headPath)?.trimmingCharacters(in: .newlines)
        if let value, value.hasPrefix("ref: refs/heads/"), value.count > 16 {
            return RepositoryMarker(branch: String(value.dropFirst(16)), head: nil)
        }
        let detached = value.flatMap { text in
            ([40, 64].contains(text.utf8.count) && text.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) ? text : nil
        }
        return value != nil || details.st_mode & S_IFMT == S_IFREG ? RepositoryMarker(branch: nil, head: detached) : nil
    }
}

struct FolderEntry: Equatable {
    let name: String
    let isDirectory: Bool
    var ignored = false
    let repo: RepositoryMarker?

    var fields: [String: Any] {
        var row: [String: Any] = ["name": name, "kind": isDirectory ? "folder" : "file"]
        if ignored { row["ignored"] = true }
        row["repo"] = repo?.fields
        return row
    }
}

// The caller supplies an open descriptor; fdopendir owns it thereafter.
func readDirectory(_ fd: Int32, visit: (String, mode_t) -> Bool) throws -> Bool {
    guard let directory = fdopendir(fd) else {
        Darwin.close(fd)
        throw ExplorerError("io", "The folder could not be listed.")
    }
    defer { closedir(directory) }
    while true {
        errno = 0
        guard let row = readdir(directory) else {
            if errno != 0 { throw ExplorerError("io", "The folder could not be listed.") }
            return true
        }
        let name = withUnsafeBytes(of: &row.pointee.d_name) { raw in
            String(bytes: raw.prefix(Int(row.pointee.d_namlen)), encoding: .utf8)
        }
        guard let name, name != ".", name != "..", name.lowercased() != ".git" else { continue }
        let kind: mode_t
        switch Int32(row.pointee.d_type) {
        case DT_DIR: kind = S_IFDIR
        case DT_REG: kind = S_IFREG
        case DT_LNK: kind = S_IFLNK
        case DT_UNKNOWN:
            var details = stat()
            guard fstatat(fd, name, &details, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
            kind = details.st_mode & S_IFMT
        default: kind = 0
        }
        if !visit(name, kind) { return false }
    }
}

extension Workspace {
    func directory(_ path: String) throws -> (Int32, URL) {
        if !path.isEmpty {
            guard let (fd, url) = try openContained(root, path) else { throw ExplorerError("not-found", "The folder no longer exists.") }
            return (fd, url)
        }
        let fd = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw ExplorerError("io", "The opened folder is no longer available.") }
        return (fd, root)
    }

    private func gitRoot(of folder: URL) -> URL? {
        var current = folder
        while current.path != root.path {
            if RepositoryMarker.read(current.path) != nil { return current }
            let parent = current.deletingLastPathComponent()
            guard parent.path != current.path else { break }
            current = parent
        }
        return containingGitRoot
    }

    static func ignored(_ names: [String], in repository: URL, seconds: Double) throws -> Set<String> {
        guard !names.isEmpty else { return [] }
        guard seconds > 0 else { throw ExplorerError("timeout", "The Git ignore check exceeded its time limit.") }
        var input = Data()
        // check-ignore does not support literal pathspec mode. A leading ./ prevents pathspec magic.
        for name in names { input.append(contentsOf: "./".utf8); input.append(contentsOf: name.utf8); input.append(0) }
        let output = try invoke(repository, ["check-ignore", "-z", "--stdin"], input: input, limit: input.count,
                                seconds: seconds, inWorkTree: true)
        guard !output.truncated, output.status == 0 || output.status == 1 else { throw ExplorerError("git", "Git could not check ignored paths.") }
        return Set(output.data.split(separator: 0).compactMap { String(bytes: $0.dropFirst(2), encoding: .utf8) })
    }

    func outsideRootRepository(_ paths: [String]) -> [String] {
        guard isGit else { return [] }
        let indexed = Set(indexCache.current()?.repositories.map(\.path) ?? [])
        var nested: [String: Bool] = [:]
        func insideNestedRepository(_ folder: String) -> Bool {
            guard !folder.isEmpty else { return false }
            if let value = nested[folder] { return value }
            let value = indexed.contains(folder) || RepositoryMarker.read(root.appendingPathComponent(folder).path) != nil ||
                insideNestedRepository(String(folder.prefix(upTo: folder.lastIndex(of: "/") ?? folder.startIndex)))
            nested[folder] = value
            return value
        }
        let inside = Set(paths.filter { path in
            guard let slash = path.lastIndex(of: "/") else { return false }
            return insideNestedRepository(String(path[..<slash]))
        })
        let candidates = paths.filter { !inside.contains($0) }
        let ignores = (try? Self.ignored(candidates, in: root, seconds: 1)) ?? []
        return paths.filter { inside.contains($0) || ignores.contains($0) }
    }

    func folder(_ path: String, showIgnored: Bool = true, maxEntries: Int = 10_000) throws -> (entries: [FolderEntry], truncated: Bool) {
        let (fd, folder) = try directory(path)
        let deadline = uptime() + 4
        var rows: [FolderEntry] = [], ignoreNames: [String] = [], bytes = 0, visited = 0
        let gitRoot = gitRoot(of: folder)
        let gitPath = gitRoot.flatMap { relativePath(folder.path, to: $0.path) } ?? ""
        let complete = try readDirectory(fd) { name, originalKind in
            visited += 1
            guard visited <= maxEntries * 4, uptime() < deadline else { return false }
            let relative = childPath(path, name)
            guard validPath(relative) else { return true }
            var kind = originalKind
            var resolved = folder.path + (folder.path == "/" ? "" : "/") + name
            if kind == S_IFLNK {
                guard let (link, url) = try? openContained(root, relative) else { return true }
                var details = stat()
                let status = fstat(link, &details)
                Darwin.close(link)
                guard status == 0 else { return true }
                kind = details.st_mode & S_IFMT
                resolved = url.path
            }
            guard kind == S_IFDIR || kind == S_IFREG else { return true }
            let repo = kind == S_IFDIR ? RepositoryMarker.read(resolved) : nil
            bytes += jsonStringCost(name) + 96 + (repo?.branch.map(jsonStringCost) ?? 0)
            guard rows.count < maxEntries, bytes < 3 * mib else { return false }
            rows.append(FolderEntry(name: name, isDirectory: kind == S_IFDIR, repo: repo))
            // Git resolves whether a path is a folder; a trailing slash would let a pattern such as dir/* match the folder itself.
            if gitRoot != nil { ignoreNames.append(childPath(gitPath, name)) }
            return true
        }
        var truncated = !complete
        if let gitRoot {
            let parent = gitPath.isEmpty ? [] : [gitPath]
            do {
                let ignored = try Self.ignored(parent + ignoreNames, in: gitRoot, seconds: min(2, deadline - uptime()))
                let wholeFolder = parent.first.map(ignored.contains) ?? false
                for i in rows.indices { rows[i].ignored = wholeFolder || ignored.contains(ignoreNames[i]) }
            } catch {
                // A failed ignore check cannot safely reveal rows in hide mode.
                if !showIgnored { throw error }
                truncated = true
            }
        }
        if !showIgnored { rows.removeAll(where: \.ignored) }
        rows.sort {
            if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.name < $1.name : order == .orderedAscending
        }
        return (rows, truncated)
    }
}
