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
    let containingGitRoot: URL?
    let indexCache = WorkspaceIndexCache()
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
        let gitRoot = output.flatMap { result -> String? in
            guard result.status == 0, !result.truncated else { return nil }
            return canonical(String(result.string.dropLast()))
        }
        containingGitRoot = gitRoot.map { URL(fileURLWithPath: $0, isDirectory: true) }
        isGit = gitRoot == real
    }

    static func invoke(_ root: URL, _ args: [String], input: Data? = nil, limit: Int, seconds: Double,
                       inWorkTree: Bool = false, onChunk: ((Data) -> Bool)? = nil) throws -> CommandResult {
        let safe = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat",
                    "-c", "core.precomposeUnicode=false", "-c", "core.quotePath=false", "-c", "diff.external=", "-c", "protocol.allow=never",
                    "-c", "submodule.recurse=false", "-c", "core.attributesFile=/dev/null"]
        let deadline = uptime() + seconds
        var environment = gitEnvironment
        if inWorkTree { environment["GIT_WORK_TREE"] = root.path }
        if args.first == "check-ignore" { environment.removeValue(forKey: "GIT_LITERAL_PATHSPECS") }
        var filters: [String] = []
        if ["diff", "status", "grep", "diff-files", "diff-index"].contains(args.first ?? "") {
            // Work-tree comparisons can otherwise run a clean/process converter from the repository's config.
            let configured = try command("/usr/bin/git", safe + ["config", "-z", "--name-only", "--get-regexp", #"^filter\..+\.(clean|smudge|process|required)$"#],
                                         cwd: root, environment: environment, limit: 16 * kib, seconds: min(1, seconds))
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
        let remaining = deadline - uptime()
        guard remaining > 0 else { throw ExplorerError("timeout", "The Git operation exceeded its time limit.") }
        return try command("/usr/bin/git", safe + filters + args, cwd: root, environment: environment,
                           input: input, limit: limit, seconds: remaining, onChunk: onChunk)
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

    private func gitFiles(_ args: [String], maxPaths: Int, includeDirectories: Bool = false) throws -> (paths: [String], truncated: Bool) {
        var names = Set<String>(), jsonBytes = 0
        let nameLimit = includeDirectories ? 4097 : 4096
        var pending = Data(), skipOversize = false
        let output = try Self.invoke(root, ["ls-files", "-z"] + args, limit: 31 * mib, seconds: 6) { chunk in
            var start = chunk.startIndex
            while let end = chunk[start...].firstIndex(of: 0) {
                let part = chunk[start..<end]
                start = end + 1
                defer { pending.removeAll(keepingCapacity: true); skipOversize = false }
                guard !skipOversize, pending.count + part.count <= nameLimit else { continue }
                let record: Data
                if pending.isEmpty { record = part } else { pending.append(part); record = pending }
                guard let path = String(data: record, encoding: .utf8), !names.contains(path) else { continue }
                guard validPath(includeDirectories && path.hasSuffix("/") ? String(path.dropLast()) : path) else { continue }
                let escaped = record.reduce(3) { count, byte in count + (byte < 32 ? 6 : byte == 34 || byte == 92 ? 2 : 1) }
                guard names.count < maxPaths, jsonBytes + escaped < 31 * mib else { return false }
                jsonBytes += escaped
                names.insert(path)
            }
            if !skipOversize {
                if pending.count + chunk.count - start > nameLimit { skipOversize = true }
                else { pending.append(chunk[start...]) }
            }
            return true
        }
        guard output.status == 0 || output.truncated else { throw ExplorerError("git", "Git could not list files.") }
        return (names.sorted(), output.truncated)
    }

    func ignoredFiles(maxPaths: Int = 200_000) throws -> (paths: [String], truncated: Bool) {
        guard isGit else { return ([], false) }
        let output = try gitFiles(["--others", "--ignored", "--exclude-standard", "--directory"], maxPaths: maxPaths, includeDirectories: true)
        // Git may emit a summary for an unignored folder alongside its ignored descendants.
        let paths = output.paths
        return (paths.indices.compactMap { i in
            let path = paths[i]
            if path.hasSuffix("/"), i + 1 < paths.count, paths[i + 1].hasPrefix(path) { return nil }
            return path
        }, output.truncated)
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
            guard let (fd, resolved) = try openContained(root, path) else { return result }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            var details = stat()
            guard fstat(fd, &details) == 0 else { throw ExplorerError("io", "The file could not be read.") }
            switch details.st_mode & S_IFMT {
            case S_IFDIR: result["kind"] = "directory"; return result
            case S_IFREG:
                size = Int(details.st_size)
                if kind == nil {
                    data = try handle.read(upToCount: 4 * mib) ?? Data()
                    if size == data.count, String(validating: data, as: UTF8.self) != nil {
                        result["editBase"] = editBase(path: path, resolved: resolved, bytes: data)
                    }
                }
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
                text = String(validating: data, as: UTF8.self)
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

    func markdownImageURL(_ path: String, at: String?) -> String? {
        guard validPath(path), imageMedia[URL(fileURLWithPath: path).pathExtension.lowercased()] != nil else { return nil }
        if at == nil {
            guard let (fd, _) = try? openContained(root, path) else { return nil }
            defer { Darwin.close(fd) }
            var details = stat()
            guard fstat(fd, &details) == 0, details.st_mode & S_IFMT == S_IFREG, details.st_size <= 32 * mib else { return nil }
        }
        return assetURL(path, at: at)
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
