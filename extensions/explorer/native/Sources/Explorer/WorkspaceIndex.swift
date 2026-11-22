import Darwin
import Foundation

struct IndexedRepository {
    let path: String
    let marker: RepositoryMarker

    var fields: [String: Any] { marker.fields.merging(["path": path]) { _, path in path } }
}

struct WorkspaceIndex {
    let paths: [String]
    let plainPaths: [String]
    let repositories: [IndexedRepository]
    let source: String
    let truncated: Bool
    let repositoriesTruncated: Bool
}

final class WorkspaceIndexCache {
    private let condition = NSCondition()
    private var generation = 0
    private var built: (generation: Int, index: WorkspaceIndex)?
    private var building = false

    func current() -> WorkspaceIndex? {
        condition.lock(); defer { condition.unlock() }
        return built?.generation == generation ? built?.index : nil
    }

    func invalidate() {
        condition.lock(); defer { condition.unlock() }
        generation += 1
    }

    func get(_ build: () -> WorkspaceIndex) -> WorkspaceIndex {
        condition.lock()
        while true {
            if let built, built.generation == generation {
                condition.unlock()
                return built.index
            }
            if !building { break }
            condition.wait()
        }
        let start = generation
        building = true
        condition.unlock()
        let result = build()
        condition.lock()
        built = (start, result)
        building = false
        condition.broadcast()
        condition.unlock()
        return result
    }
}

// A bounded batch preserves input order without serialising the Git processes.
func repositoryBatch<T, R>(_ batch: ArraySlice<T>, _ work: (T) -> R) -> [R] {
    let lock = NSLock()
    var result = [R?](repeating: nil, count: batch.count)
    DispatchQueue.concurrentPerform(iterations: batch.count) { i in
        let value = work(batch[batch.startIndex + i])
        lock.lock(); result[i] = value; lock.unlock()
    }
    return result.compactMap { $0 }
}

private struct RepositoryListing {
    var paths: [String] = []
    var repositories: [IndexedRepository] = []
    var truncated = false
    var repositoriesTruncated = false
}

extension Workspace {
    func files() -> WorkspaceIndex { indexCache.get { buildIndex() } }

    func buildIndex(seconds: Double = 8, maxPaths: Int = 200_000) -> WorkspaceIndex {
        let deadline = uptime() + seconds, repositoryLimit = 2_000
        var paths: [String] = [], plainPaths: [String] = [], repositories: [IndexedRepository] = []
        var knownPaths = Set<String>(), knownRepositories = Set<String>()
        var bytes = 0, visited = 0, truncated = false, repositoriesTruncated = false
        var pendingFolders = isGit ? [] : [""], pendingGit = isGit ? [""] : []
        func append(_ path: String, plain: Bool) {
            guard !knownPaths.contains(path) else { return }
            guard paths.count < maxPaths, bytes < 26 * mib else { truncated = true; return }
            let cost = jsonStringCost(path)
            guard bytes + cost <= 26 * mib else { truncated = true; return }
            knownPaths.insert(path); paths.append(path); bytes += cost
            if plain { plainPaths.append(path) }
        }
        func remember(_ repo: IndexedRepository) {
            guard !knownRepositories.contains(repo.path) else { return }
            let cost = jsonStringCost(repo.path) + (repo.marker.branch.map(jsonStringCost) ?? 0) + 128
            guard repositories.count < repositoryLimit, bytes + cost <= 26 * mib else { repositoriesTruncated = true; return }
            bytes += cost
            knownRepositories.insert(repo.path)
            repositories.append(repo)
            pendingGit.append(repo.path)
        }
        // Discover plain directories breadth-first. Git controls enumeration inside repository boundaries.
        while !pendingFolders.isEmpty || !pendingGit.isEmpty {
            guard paths.count < maxPaths, uptime() < deadline else { truncated = true; repositoriesTruncated = true; break }
            let folders = pendingFolders, git = pendingGit
            pendingFolders.removeAll(); pendingGit.removeAll()
            for path in folders {
                guard paths.count < maxPaths, uptime() < deadline, visited < 800_000 else {
                    truncated = true; repositoriesTruncated = true; break
                }
                let fullPath = path.isEmpty ? root.path : root.appendingPathComponent(path).path
                do {
                    let (fd, resolved) = try directory(path)
                    if resolved.path != fullPath { Darwin.close(fd); continue }
                    let complete = try readDirectory(fd) { name, kind in
                        visited += 1
                        guard paths.count < maxPaths, visited <= 800_000, uptime() < deadline else { return false }
                        let relative = childPath(path, name)
                        guard validPath(relative) else { return true }
                        if kind == S_IFDIR {
                            let fullChild = resolved.path + (resolved.path == "/" ? "" : "/") + name
                            if let marker = RepositoryMarker.read(fullChild) { remember(IndexedRepository(path: relative, marker: marker)) }
                            else { pendingFolders.append(relative) }
                        } else if kind == S_IFREG || (kind == S_IFLNK && isFileLink(relative)) {
                            append(relative, plain: true)
                        }
                        return true
                    }
                    if !complete { truncated = true; repositoriesTruncated = true }
                } catch { truncated = true; repositoriesTruncated = true }
            }
            for start in stride(from: 0, to: git.count, by: 4) {
                guard paths.count < maxPaths, uptime() < deadline else { truncated = true; repositoriesTruncated = true; break }
                let batch = git[start..<min(start + 4, git.count)]
                let remaining = maxPaths - paths.count
                let results = repositoryBatch(batch) { listRepository($0, deadline: deadline, maxPaths: remaining) }
                for result in results {
                    for repo in result.repositories { remember(repo) }
                    for path in result.paths {
                        guard paths.count < maxPaths else { truncated = true; break }
                        append(path, plain: false)
                    }
                    truncated = truncated || result.truncated
                    repositoriesTruncated = repositoriesTruncated || result.repositoriesTruncated
                }
            }
            if visited >= 800_000 { pendingFolders.removeAll(); truncated = true; repositoriesTruncated = true }
        }
        // Git may report nested roots at any depth in a single listing.
        repositories.sort {
            let lhsDepth = $0.path.utf8.count(where: { $0 == 47 }), rhsDepth = $1.path.utf8.count(where: { $0 == 47 })
            return lhsDepth == rhsDepth ? $0.path < $1.path : lhsDepth < rhsDepth
        }
        return WorkspaceIndex(paths: paths.sorted(), plainPaths: plainPaths, repositories: repositories,
                              source: repositories.isEmpty ? (isGit ? "git" : "scan") : "mixed",
                              truncated: truncated || repositoriesTruncated, repositoriesTruncated: repositoriesTruncated)
    }

    private func isFileLink(_ path: String) -> Bool {
        guard let (fd, _) = try? openContained(root, path) else { return false }
        defer { Darwin.close(fd) }
        var details = stat()
        return fstat(fd, &details) == 0 && details.st_mode & S_IFMT == S_IFREG
    }

    private func listRepository(_ path: String, deadline: Double, maxPaths: Int) -> RepositoryListing {
        var result = RepositoryListing(), seen = Set<String>(), bytes = 0
        let folder = path.isEmpty ? root : root.appendingPathComponent(path)
        guard canonical(folder.path) == folder.path, path.isEmpty || RepositoryMarker.read(folder.path) != nil else {
            result.truncated = true; result.repositoriesTruncated = true; return result
        }
        let rootPrefix = root.path == "/" ? "/" : root.path + "/"
        var pending = Data(), oversize = false
        var containedParents: [String: Bool] = [:]
        do {
            let remaining = deadline - uptime()
            guard remaining > 0 else { throw ExplorerError("timeout", "The path index exceeded its time limit.") }
            let args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"]
            let output = try Self.invoke(folder, args, limit: 32 * mib, seconds: path.isEmpty ? remaining : min(2, remaining), inWorkTree: true) { [self] chunk in
                var start = chunk.startIndex
                while let end = chunk[start...].firstIndex(of: 0) {
                    guard result.paths.count < maxPaths, uptime() < deadline else { return false }
                    let part = chunk[start..<end]
                    start = end + 1
                    defer { pending.removeAll(keepingCapacity: true); oversize = false }
                    guard !oversize, pending.count + part.count <= 4097 else { continue }
                    pending.append(part)
                    guard let name = String(data: pending, encoding: .utf8) else { continue }
                    let relative = childPath(path, name.hasSuffix("/") ? String(name.dropLast()) : name)
                    guard validPath(relative) else { continue }
                    let absolute = rootPrefix + relative
                    // Cached Git paths can still name a descendant of a directory replaced by a symlink.
                    let parent = relative.lastIndex(of: "/").map { rootPrefix + relative[..<$0] } ?? root.path
                    let contained = containedParents[parent] ?? (canonical(parent) == parent)
                    containedParents[parent] = contained
                    guard contained else { continue }
                    var details = stat()
                    guard lstat(absolute, &details) == 0 else { continue }
                    let kind = details.st_mode & S_IFMT
                    if kind == S_IFDIR {
                        if result.repositories.count >= 2_000 { result.repositoriesTruncated = true; continue }
                        if let marker = RepositoryMarker.read(absolute) { result.repositories.append(IndexedRepository(path: relative, marker: marker)) }
                        continue
                    }
                    guard kind == S_IFREG || (kind == S_IFLNK && isFileLink(relative)) else { continue }
                    guard !seen.contains(relative) else { continue }
                    let cost = jsonStringCost(relative)
                    guard bytes + cost <= 26 * mib else { result.truncated = true; continue }
                    seen.insert(relative); result.paths.append(relative); bytes += cost
                }
                if !oversize {
                    if pending.count + chunk.count - start > 4097 { oversize = true }
                    else { pending.append(chunk[start...]) }
                }
                return true
            }
            if output.truncated || output.status != 0 { result.truncated = true; result.repositoriesTruncated = true }
        } catch { result.truncated = true; result.repositoriesTruncated = true }
        return result
    }
}
