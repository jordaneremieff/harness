import Darwin
import Foundation
import UniformTypeIdentifiers

func validPath(_ path: String) -> Bool {
    !path.isEmpty && path.utf8.count <= 4096 && !path.utf8.contains(0) &&
        path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".." && $0.lowercased() != ".git"
        }
}

func canonical(_ path: String) -> String? {
    guard !path.utf8.contains(0), let raw = Darwin.realpath(path, nil) else { return nil }
    defer { free(raw) }
    return String(validatingUTF8: raw)
}

func openContained(_ root: URL, _ path: String) throws -> (fd: Int32, resolved: URL)? {
    guard validPath(path) else { throw ExplorerError("invalid-path", "Use a relative path inside the opened folder.") }
    let prefix = root.path == "/" ? "/" : root.path + "/"
    guard let real = canonical(prefix + path) else {
        if errno == ENOENT || errno == ENOTDIR { return nil }
        throw ExplorerError("io", "The path could not be resolved.")
    }
    guard real.hasPrefix(prefix), validPath(String(real.dropFirst(prefix.count))) else {
        throw ExplorerError("invalid-path", "The path leaves the opened folder or enters Git metadata.")
    }
    var fd = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard fd >= 0 else { throw ExplorerError("io", "The opened folder is no longer available.") }
    let parts = real.dropFirst(prefix.count).split(separator: "/")
    for (index, part) in parts.enumerated() {
        let flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (index + 1 < parts.count ? O_DIRECTORY : 0)
        let next = openat(fd, String(part), flags)
        _ = Darwin.close(fd)
        guard next >= 0 else { throw ExplorerError("io", "The file changed or became unavailable.") }
        fd = next
    }
    return (fd, URL(fileURLWithPath: real))
}

let imageMedia: [String: String] = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml"]

final class Workspace: @unchecked Sendable {
    let root: URL
    let isGit: Bool
    private let assetLock = NSLock()
    private var assets: [String: (path: String, at: String?)] = [:]
    private var assetOrder: [String] = []
    private static let gitEnvironment: [String: String] = {
        var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("GIT_") }
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        env["GIT_OPTIONAL_LOCKS"] = "0"
        env["GIT_NO_REPLACE_OBJECTS"] = "1"
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GIT_LITERAL_PATHSPECS"] = "1"
        env["GIT_CONFIG_GLOBAL"] = "/dev/null"
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["LC_ALL"] = "C"
        return env
    }()

    init(_ path: String) throws {
        var details = stat()
        guard path.hasPrefix("/"), let real = canonical(path), stat(real, &details) == 0,
              details.st_mode & S_IFMT == S_IFDIR else { throw ExplorerError("invalid-root", "The root must be an existing absolute folder.") }
        root = URL(fileURLWithPath: real, isDirectory: true)
        let output = try? Self.invoke(root, ["rev-parse", "--show-toplevel"], limit: 8192, seconds: 2)
        isGit = output.map { $0.status == 0 && !$0.truncated && canonical(String($0.string.dropLast())) == real } ?? false
    }

    private static func invoke(_ root: URL, _ args: [String], limit: Int, seconds: Double,
                               onChunk: ((Data) -> Bool)? = nil) throws -> CommandResult {
        let safe = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat",
                    "-c", "core.precomposeUnicode=false", "-c", "core.quotePath=false", "-c", "diff.external=", "-c", "protocol.allow=never",
                    "-c", "submodule.recurse=false", "-c", "core.attributesFile=/dev/null"]
        var filters: [String] = []
        if ["diff", "status", "grep", "diff-files", "diff-index"].contains(args.first ?? "") {
            // Work-tree comparisons can otherwise run a clean/process converter from the repository's config.
            let configured = try command("/usr/bin/git", safe + ["config", "-z", "--name-only", "--get-regexp", #"^filter\..+\.(clean|smudge|process|required)$"#],
                                         cwd: root, environment: gitEnvironment, limit: 16 * kib, seconds: 1)
            guard !configured.truncated, configured.status == 0 || configured.status == 1 else {
                throw ExplorerError("git", "The Git filter configuration could not be checked.")
            }
            for key in Set(configured.data.split(separator: 0)) {
                guard let key = String(bytes: key, encoding: .utf8), !key.contains("=") else {
                    throw ExplorerError("git", "The Git filter configuration is invalid.")
                }
                filters += ["-c", key + (key.hasSuffix(".required") ? "=false" : "=")]
            }
        }
        return try command("/usr/bin/git", safe + filters + args, cwd: root, environment: gitEnvironment, limit: limit, seconds: seconds, onChunk: onChunk)
    }

    func git(_ args: [String], limit: Int = 32 * mib, seconds: Double = 6) throws -> CommandResult {
        guard isGit else { throw ExplorerError("not-git", "The opened folder is not a Git work tree.") }
        return try Self.invoke(root, args, limit: limit, seconds: seconds)
    }

    func gitValue(_ args: [String]) -> String? {
        guard let output = try? git(args, limit: 8192, seconds: 2), output.status == 0, !output.truncated else { return nil }
        let value = output.string.trimmingCharacters(in: .newlines)
        return value.isEmpty ? nil : value
    }

    func info() -> [String: Any] {
        let branch = gitValue(["symbolic-ref", "--quiet", "--short", "HEAD"])
        let head = gitValue(["rev-parse", "--verify", "HEAD^{commit}"])
        let remoteDefault = gitValue(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        let localDefault = remoteDefault.map { String($0.split(separator: "/", maxSplits: 1).last ?? "") }
        let defaultBranch = localDefault ?? ["main", "master", "trunk"].first { gitValue(["rev-parse", "--verify", "refs/heads/\($0)"]) != nil }
        return ["path": root.path, "name": root.lastPathComponent.isEmpty ? root.path : root.lastPathComponent,
                "kind": isGit ? "git" : "folder", "branch": branch as Any? ?? jsonNull, "head": head as Any? ?? jsonNull,
                "defaultBranch": defaultBranch as Any? ?? jsonNull, "onDefaultBranch": branch != nil && branch == defaultBranch]
    }

    func files(maxPaths: Int = 200_000) throws -> (paths: [String], truncated: Bool) {
        if isGit {
            var names = Set<String>(), jsonBytes = 0
            var pending = Data(), skipOversize = false
            let output = try Self.invoke(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"], limit: 31 * mib, seconds: 6) { chunk in
                var start = chunk.startIndex
                while let end = chunk[start...].firstIndex(of: 0) {
                    let part = chunk[start..<end]
                    start = end + 1
                    defer { pending.removeAll(keepingCapacity: true); skipOversize = false }
                    guard !skipOversize, pending.count + part.count <= 4096 else { continue }
                    let record: Data
                    if pending.isEmpty { record = part } else { pending.append(part); record = pending }
                    guard let path = String(data: record, encoding: .utf8), validPath(path), !names.contains(path) else { continue }
                    let escaped = record.reduce(3) { count, byte in count + (byte < 32 ? 6 : byte == 34 || byte == 92 ? 2 : 1) }
                    guard names.count < maxPaths, jsonBytes + escaped < 31 * mib else { return false }
                    jsonBytes += escaped
                    names.insert(path)
                }
                if !skipOversize {
                    if pending.count + chunk.count - start > 4096 { skipOversize = true }
                    else { pending.append(chunk[start...]) }
                }
                return true
            }
            guard output.status == 0 || output.truncated else { throw ExplorerError("git", "Git could not list files.") }
            return (names.sorted(), output.truncated)
        }
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        guard let scan = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else {
            throw ExplorerError("io", "The folder could not be listed.")
        }
        let prefix = root.path == "/" ? 1 : root.path.count + 1
        var names: [String] = [], visited = 0, bytes = 0
        let deadline = ProcessInfo.processInfo.systemUptime + 4
        for case let url as URL in scan {
            if url.lastPathComponent.lowercased() == ".git" { scan.skipDescendants(); continue }
            visited += 1
            if visited > maxPaths * 4 || ProcessInfo.processInfo.systemUptime > deadline { return (names.sorted(), true) }
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true || values.isSymbolicLink == true else { continue }
            let path = String(url.path.dropFirst(prefix))
            guard validPath(path) else { continue }
            bytes += path.utf8.count
            if names.count == maxPaths || bytes > 26 * mib { return (names.sorted(), true) }
            names.append(path)
        }
        return (names.sorted(), false)
    }

    func checkedCommit(_ ref: String) -> String? {
        guard ref.utf8.count <= 255, !ref.hasPrefix("-"),
              ref.range(of: #"^[A-Za-z0-9_./-]+$"#, options: .regularExpression) != nil,
              !ref.contains("..") else { return nil }
        return gitValue(["rev-parse", "--verify", "--end-of-options", "\(ref)^{commit}"])
    }

    private func blob(_ path: String, at: String) throws -> (String, Int)? {
        guard validPath(path), let commit = checkedCommit(at) else { throw ExplorerError("invalid", "The Git revision or path is invalid.") }
        let spec = "\(commit):\(path)"
        guard let kind = gitValue(["cat-file", "-t", spec]) else { return nil }
        if kind == "tree" { return (kind, 0) }
        guard kind == "blob", let size = gitValue(["cat-file", "-s", spec]).flatMap(Int.init) else { return nil }
        return (spec, size)
    }

    func readFile(_ path: String, at commit: String? = nil) throws -> [String: Any] {
        var result: [String: Any] = ["path": path, "kind": "missing", "size": 0]
        let kind = imageMedia[URL(fileURLWithPath: path).pathExtension.lowercased()]
        var data = Data(), size = 0
        if let commit {
            guard let (spec, length) = try blob(path, at: commit) else { return result }
            if spec == "tree" { result["kind"] = "directory"; return result }
            size = length
            if kind == nil {
                let content = try git(["cat-file", "blob", spec], limit: 4 * mib)
                guard content.status == 0 || content.truncated else { throw ExplorerError("git", "Git could not read this file.") }
                data = content.data
            }
        } else {
            guard let (fd, _) = try openContained(root, path) else { return result }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            var details = stat()
            guard fstat(fd, &details) == 0 else { throw ExplorerError("io", "The file could not be read.") }
            switch details.st_mode & S_IFMT {
            case S_IFDIR: result["kind"] = "directory"; return result
            case S_IFREG:
                size = Int(details.st_size)
                if kind == nil { data = try handle.read(upToCount: 4 * mib) ?? Data() }
            default: result["kind"] = "binary"; return result
            }
        }
        result["size"] = size
        if let kind, size <= 32 * mib {
            result["kind"] = "image"
            result["mediaType"] = kind
            result["url"] = assetURL(path, at: commit)
        } else {
            let truncated = size > data.count && kind == nil
            var text: String?
            if kind == nil, !data.contains(0) {
                text = String(data: data, encoding: .utf8)
                if text == nil, truncated {
                    for drop in 1...min(3, max(1, data.count)) {
                        if let valid = String(bytes: data.dropLast(drop), encoding: .utf8) { text = valid; break }
                    }
                }
            }
            if let text {
                result["kind"] = "text"; result["text"] = text
                if truncated { result["truncated"] = true }
            } else {
                result["kind"] = "binary"
                result["mediaType"] = kind ?? UTType(filenameExtension: URL(fileURLWithPath: path).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            }
        }
        if isGit {
            let rev = commit.flatMap(checkedCommit).map { [$0] } ?? []
            if let metadata = gitValue(["log", "-1", "--format=%H%x00%s%x00%aI"] + rev + ["--", path]) {
                let fields = metadata.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
                if fields.count == 3 { result["lastCommit"] = ["commit": fields[0], "subject": fields[1], "date": fields[2]] }
            }
        }
        return result
    }

    private func assetURL(_ path: String, at: String?) -> String {
        let id = UUID().uuidString.lowercased()
        assetLock.lock(); defer { assetLock.unlock() }
        assets[id] = (path, at); assetOrder.append(id)
        if assetOrder.count > 256 { assets.removeValue(forKey: assetOrder.removeFirst()) }
        return "explorer-asset://image/\(id)"
    }

    func asset(_ id: String) throws -> (Data, String) {
        assetLock.lock(); let entry = assets[id]; assetLock.unlock()
        guard let (path, at) = entry, let mime = imageMedia[URL(fileURLWithPath: path).pathExtension.lowercased()] else {
            throw ExplorerError("not-found", "The image is not available.")
        }
        if let at {
            guard let (spec, size) = try blob(path, at: at), spec != "tree", size <= 32 * mib else { throw ExplorerError("not-found", "The image is not available.") }
            let output = try git(["cat-file", "blob", spec])
            guard output.status == 0, !output.truncated else { throw ExplorerError("io", "The image could not be read.") }
            return (output.data, mime)
        }
        guard let (fd, _) = try openContained(root, path) else { throw ExplorerError("not-found", "The image is not available.") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var details = stat()
        guard fstat(fd, &details) == 0, details.st_mode & S_IFMT == S_IFREG, details.st_size <= 32 * mib else {
            throw ExplorerError("invalid", "The image is not a regular file within the size limit.")
        }
        let data = try handle.read(upToCount: 32 * mib + 1) ?? Data()
        guard data.count <= 32 * mib else { throw ExplorerError("invalid", "The image exceeds its size limit.") }
        return (data, mime)
    }
}
