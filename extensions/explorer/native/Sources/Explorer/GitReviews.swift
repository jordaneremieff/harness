import CryptoKit
import Darwin
import Foundation

private let reviewDiffOptions = ["--no-ext-diff", "--no-textconv", "--no-color"]
private let reviewTextLimit = 4 * mib

private struct ReviewRange {
    let scope: [String: Any]
    let base: String?
    let head: String
    let label: String

    var worktree: Bool { head == "worktree" }
    var kind: String { scope["kind"] as? String ?? "" }
    var revisions: [String] { [head] + (kind == "commit" ? [] : base.map { ["^\($0)"] } ?? []) }

    func json(label: String) -> [String: Any] {
        let baseKey = base ?? "empty"
        return ["scope": scope, "base": base as Any? ?? jsonNull, "head": head, "label": label,
                "key": worktree ? "worktree@\(baseKey)" : "\(baseKey)..\(head)"]
    }
}

private struct ReviewChange {
    let path: String
    var oldPath: String? = nil
    var status: String
    var baseMode: String
    var headMode: String
    var baseObject: String
    let headObject: String
    var additions = 0
    var deletions = 0
    var binary = false

    var json: [String: Any] {
        var value: [String: Any] = ["path": path, "status": status, "binary": binary,
                                    "additions": additions, "deletions": deletions]
        if let oldPath { value["oldPath"] = oldPath }
        return value
    }
}

private struct ReviewContent {
    let bytes: Data
    let truncated: Bool

    var text: String? {
        guard !bytes.contains(0) else { return nil }
        if let text = String(data: bytes, encoding: .utf8) { return text }
        guard truncated else { return nil }
        for count in 1...3 {
            if let text = String(bytes: bytes.dropLast(count), encoding: .utf8) { return text }
        }
        return nil
    }

    var lines: Int {
        bytes.reduce(0) { $1 == 10 ? $0 + 1 : $0 } + (bytes.last.map { $0 != 10 } == true ? 1 : 0)
    }

    var fingerprint: SHA256.Digest? { truncated ? nil : SHA256.hash(data: bytes) }
}

private struct ReviewHunk {
    let baseStart: Int
    let baseCount: Int
    let headStart: Int
    let headCount: Int
    var json: [String: Int] {
        ["baseStart": baseStart, "baseCount": baseCount, "headStart": headStart, "headCount": headCount]
    }
}

extension Workspace {
    func reviewScopes(marker: String?) throws -> [String: Any] {
        let rootInfo = info()
        let head = rootInfo["head"] as? String
        let onDefault = rootInfo["onDefaultBranch"] as? Bool == true
        func option(_ kind: String, _ label: String, scope: [String: Any]? = nil, reason: String? = nil) -> [String: Any] {
            var item: [String: Any] = ["id": kind, "label": label, "scope": scope ?? ["kind": kind], "available": reason == nil]
            if let reason { item["reason"] = reason }
            return item
        }
        let noGit = isGit ? nil : "Reviews require a Git work tree."
        let noHead = noGit ?? (head == nil ? "The Git work tree has no commits yet." : nil)
        let branchScope = ["kind": "branch"]
        let branch = try? resolveReview(branchScope, marker: nil, rootInfo: rootInfo)
        let branchReason = noHead ?? (branch == nil ? "There is no common ancestor with the default branch." : nil)
        let parent = head.flatMap(reviewParent)
        let options = [
            option("uncommitted", "Uncommitted changes", reason: noGit),
            option("since-review", "Since your last review", reason: noHead ?? (onDefault ? nil : "Open the default branch to review since your last review.")),
            option("branch", branch?.label ?? "Branch against default", scope: branchScope, reason: branchReason),
            option("commit", "Latest commit", scope: head.map { ["kind": "commit", "commit": $0] }, reason: noHead),
            option("range", "Commit range", scope: ["kind": "range", "base": parent ?? head ?? "HEAD", "head": head ?? "HEAD"],
                   reason: noHead ?? (parent == nil ? "There is no earlier commit for a range." : nil)),
        ]
        var defaultId = "uncommitted"
        if let head, !(try reviewHasChanges(head)) {
            defaultId = onDefault ? "since-review" : branch != nil ? "branch" : "commit"
        }
        return ["scopes": options, "defaultId": defaultId]
    }

    func reviewFiles(_ scope: [String: Any], marker: String?) throws -> [String: Any] {
        let range = try resolveReview(scope, marker: marker)
        let deadline = ProcessInfo.processInfo.systemUptime + 12
        var changes = try reviewChanges(range, deadline: deadline)
        if range.worktree {
            var measured: [ReviewChange] = []
            for var change in changes {
                try checkReviewDeadline(deadline)
                let (base, head) = try reviewContents(change, worktree: true)
                if change.status == "modified", change.baseMode == change.headMode,
                   let base, let head, !base.truncated, !head.truncated, base.bytes == head.bytes { continue }
                change.binary = reviewBinary(change, base, head)
                if !change.binary {
                    let result = try reviewHunks(base, head, seconds: max(0.01, deadline - ProcessInfo.processInfo.systemUptime))
                    change.additions = result.hunks.reduce(0) { $0 + $1.headCount }
                    change.deletions = result.hunks.reduce(0) { $0 + $1.baseCount }
                }
                measured.append(change)
            }
            changes = measured
        }
        let files = changes.map(\.json)
        let commits = try reviewCommits(range)
        let label = try reviewLabel(range, commits: commits)
        return ["resolved": range.json(label: label), "commits": commits, "files": files]
    }

    func reviewDiff(_ scope: [String: Any], path: String, marker: String?) throws -> [String: Any] {
        guard validPath(path) else { throw ExplorerError("invalid-path", "Use a relative path inside the opened folder.") }
        let range = try resolveReview(scope, marker: marker)
        let deadline = ProcessInfo.processInfo.systemUptime + 12
        let changes = try reviewChanges(range, deadline: deadline)
        guard let change = changes.first(where: { $0.path.utf8.elementsEqual(path.utf8) }) else {
            throw ExplorerError("not-found", "The path is not a change in this review.")
        }
        let (base, head) = try reviewContents(change, worktree: range.worktree)
        let binary = reviewBinary(change, base, head)
        let result = binary ? (hunks: [ReviewHunk](), truncated: false) : try reviewHunks(base, head, seconds: 6)
        var reply: [String: Any] = ["path": change.path, "status": change.status, "binary": binary,
                                    "hunks": result.hunks.map(\.json),
                                    "base": (binary ? nil : base?.text) as Any? ?? jsonNull,
                                    "head": (binary ? nil : head?.text) as Any? ?? jsonNull]
        if let old = change.oldPath { reply["oldPath"] = old }
        if base?.truncated == true || head?.truncated == true || result.truncated { reply["truncated"] = true }
        return reply
    }

    private func reviewParent(_ head: String) -> String? {
        gitValue(["rev-parse", "--verify", "--end-of-options", "\(head)^1"])
    }

    private func resolveReview(_ raw: [String: Any], marker: String?, rootInfo: [String: Any]? = nil) throws -> ReviewRange {
        guard isGit else { throw ExplorerError("not-git", "Reviews require a Git work tree.") }
        let scope = try scopeShape(raw)
        let kind = scope["kind"] as? String
        let rootInfo = rootInfo ?? info()
        let currentHead = rootInfo["head"] as? String
        func resolve(_ ref: Any?) throws -> String {
            guard let ref = ref as? String, let commit = checkedCommit(ref) else {
                throw ExplorerError("invalid", "The Git revision is not a commit in this work tree.")
            }
            return commit
        }
        switch kind {
        case "uncommitted":
            return ReviewRange(scope: scope, base: currentHead, head: "worktree", label: "Uncommitted changes")
        case "range":
            let base = try resolve(scope["base"]), head = try resolve(scope["head"])
            return ReviewRange(scope: scope, base: base, head: head, label: "Commit range")
        case "commit":
            let head = try resolve(scope["commit"])
            return ReviewRange(scope: scope, base: reviewParent(head), head: head, label: "Commit \(head.prefix(7))")
        default:
            guard let head = currentHead else { throw ExplorerError("not-found", "The Git work tree has no commits yet.") }
            if kind == "branch" {
                let branch = rootInfo["branch"] as? String ?? String(head.prefix(7))
                let name: String, target: String
                if let explicit = scope["base"] as? String {
                    name = explicit; target = try resolve(explicit)
                } else {
                    guard let defaultBranch = rootInfo["defaultBranch"] as? String else {
                        throw ExplorerError("not-found", "The default branch is unavailable.")
                    }
                    name = defaultBranch
                    if let remote = gitValue(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]), remote == "refs/remotes/origin/\(name)" {
                        target = try resolve(remote)
                    } else { target = try resolve("refs/heads/\(name)") }
                }
                guard let base = gitValue(["merge-base", "--", target, head]) else {
                    throw ExplorerError("not-found", "The branch and review base have no common ancestor.")
                }
                return ReviewRange(scope: scope, base: base, head: head, label: "Branch \(branch) against \(name)")
            }
            let retained = marker.flatMap { value in
                value.range(of: #"^(?:[0-9a-f]{40}|[0-9a-f]{64})$"#, options: .regularExpression) != nil ? checkedCommit(value) : nil
            }
            return ReviewRange(scope: scope, base: retained ?? reviewParent(head), head: head, label: "Since your last review")
        }
    }

    private func reviewLabel(_ range: ReviewRange, commits: [[String: String]]) throws -> String {
        if range.worktree { return range.label }
        let head = range.head.prefix(7)
        if range.kind == "commit" {
            guard let subject = commits.first?["subject"], !subject.isEmpty else { return String(head) }
            return "\(head) \(subject)"
        }
        let output = try reviewGit(["rev-list", "--count"] + range.revisions + ["--"], limit: 128)
        guard let count = Int(output.string.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw ExplorerError("git", "Git did not return the review's commit count.")
        }
        let total = "\(count) \(count == 1 ? "commit" : "commits")"
        if range.kind == "branch" { return "\(range.label): \(total)" }
        let start = range.base.map { String($0.prefix(7)) } ?? "empty tree"
        let span = "\(total), \(start) to \(head)"
        return range.kind == "since-review" ? "\(range.label): \(span)" : span
    }

    private func reviewCommits(_ range: ReviewRange) throws -> [[String: String]] {
        if range.worktree { return [] }
        let output = try reviewGit(["log", "-z", "--encoding=UTF-8", "--format=%H%x00%s%x00%an%x00%aI",
                                    range.kind == "commit" ? "-1" : "-500"] + range.revisions + ["--"], limit: mib)
        let fields = output.data.split(separator: 0, omittingEmptySubsequences: false)
        return stride(from: 0, to: max(0, fields.count - 4), by: 4).map { i in
            let commit = String(decoding: fields[i], as: UTF8.self)
            return ["commit": commit, "short": String(commit.prefix(8)), "subject": String(decoding: fields[i + 1], as: UTF8.self),
                    "author": String(decoding: fields[i + 2], as: UTF8.self), "date": String(decoding: fields[i + 3], as: UTF8.self)]
        }
    }

    private func reviewGit(_ args: [String], limit: Int = 4 * mib) throws -> CommandResult {
        let output = try git(args, limit: limit)
        guard !output.truncated else { throw ExplorerError("limit", "The Git review exceeds its size limit.") }
        guard output.status == 0 else { throw ExplorerError("git", "Git could not read the review.") }
        return output
    }

    private func checkReviewDeadline(_ deadline: Double) throws {
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw ExplorerError("timeout", "The Git review exceeded its time limit.") }
    }

    private func reviewEmptyTree() throws -> String {
        // Without -w, hash-object does not change the repository. Git knows the empty tree for its object format.
        try reviewGit(["hash-object", "-t", "tree", "/dev/null"], limit: 128).string.trimmingCharacters(in: .newlines)
    }

    private func reviewIndexArgs(_ base: String) -> [String] {
        // Worktree diff with patch or rename detection may apply clean filters. Only inspect raw index metadata here.
        ["-c", "diff.autoRefreshIndex=false", "diff-index", "--raw", "--no-abbrev", "-z", "--no-renames", "--ignore-submodules=all", "-O/dev/null"]
            + reviewDiffOptions + [base, "--"]
    }

    private var reviewUntrackedArgs: [String] { ["ls-files", "-z", "--others", "--exclude-standard", "--"] }

    private func reviewHasChanges(_ head: String) throws -> Bool {
        for args in [reviewIndexArgs(head), reviewUntrackedArgs] {
            let result = try git(args, limit: 1)
            if result.truncated || !result.data.isEmpty { return true }
            if result.status != 0 { throw ExplorerError("git", "Git could not check the work tree for changes.") }
        }
        return false
    }

    private func reviewChanges(_ range: ReviewRange, deadline: Double) throws -> [ReviewChange] {
        let base = try range.base ?? reviewEmptyTree()
        let stats = ["--no-commit-id", "--raw", "--no-abbrev", "--numstat", "-r", "-z", "-M", "-C", "-l1000", "-O/dev/null"] + reviewDiffOptions
        if !range.worktree {
            return parseReviewChanges(try reviewGit(["diff-tree"] + stats + [base, range.head, "--"]).data)
        }
        var changes = parseReviewChanges(try reviewGit(reviewIndexArgs(base)).data)
        let untracked = try reviewGit(reviewUntrackedArgs).data.split(separator: 0)
        let indexed = Set(changes.map { Data($0.path.utf8) })
        for raw in untracked where !indexed.contains(Data(raw)) {
            guard let path = String(bytes: raw, encoding: .utf8), validPath(path) else { continue }
            changes.append(ReviewChange(path: path, status: "added", baseMode: "000000", headMode: "100644", baseObject: "", headObject: ""))
        }
        changes = try changes.compactMap { entry in
            try checkReviewDeadline(deadline)
            var entry = entry
            entry.headMode = try reviewWorktree(entry.path, read: false)?.mode ?? "000000"
            if entry.baseMode == "000000" {
                guard entry.headMode != "000000" else { return nil }
                entry.status = "added"
            } else if entry.headMode == "000000" { entry.status = "deleted" }
            else { entry.status = entry.baseMode.prefix(2) == entry.headMode.prefix(2) ? "modified" : "typechange" }
            return entry
        }
        let additions = changes.indices.filter { changes[$0].status == "added" }
        let deletions = changes.indices.filter { changes[$0].status == "deleted" }
        guard !additions.isEmpty, !deletions.isEmpty else { return changes }
        let byPath = Dictionary(uniqueKeysWithValues: changes.indices.map { (Data(changes[$0].path.utf8), $0) })
        var paired = Set<Int>()
        func rename(_ old: Int, _ new: Int) {
            changes[new].status = "renamed"
            changes[new].oldPath = changes[old].path
            changes[new].baseMode = changes[old].baseMode
            changes[new].baseObject = changes[old].baseObject
            paired.insert(old)
        }
        // Similarity detection is safe between HEAD and the index because Git uses only object data.
        let staged = try reviewGit(["-c", "diff.autoRefreshIndex=false", "diff", "--cached", "--raw", "-z", "-M", "-l1000", "--ignore-submodules=all", "-O/dev/null"]
                                   + reviewDiffOptions + [base, "--"])
        for entry in parseReviewChanges(staged.data) where entry.status == "renamed" {
            if let oldPath = entry.oldPath, let old = byPath[Data(oldPath.utf8)], let new = byPath[Data(entry.path.utf8)],
               changes[old].status == "deleted", changes[new].status == "added" { rename(old, new) }
        }
        // An unstaged move has no new object in the index. Match only exact, complete contents.
        var sources: [SHA256.Digest: [Int]] = [:]
        for old in deletions.reversed() where !paired.contains(old) {
            try checkReviewDeadline(deadline)
            let entry = changes[old]
            if let hash = try reviewBlob(entry.baseObject, mode: entry.baseMode)?.fingerprint { sources[hash, default: []].append(old) }
        }
        for new in additions where changes[new].status == "added" && !sources.isEmpty {
            try checkReviewDeadline(deadline)
            guard let hash = try reviewWorktree(changes[new].path)?.content?.fingerprint, var matches = sources[hash],
                  let i = matches.lastIndex(where: { changes[$0].baseMode.prefix(2) == changes[new].headMode.prefix(2) }) else { continue }
            let old = matches.remove(at: i)
            sources[hash] = matches.isEmpty ? nil : matches
            rename(old, new)
        }
        return changes.enumerated().compactMap { paired.contains($0.offset) ? nil : $0.element }
    }

    private func reviewBlob(_ object: String, mode: String) throws -> ReviewContent? {
        guard mode != "000000", mode != "160000", !object.isEmpty else { return nil }
        let output = try git(["cat-file", "blob", object], limit: reviewTextLimit)
        guard output.status == 0 || output.truncated else { throw ExplorerError("git", "Git could not read a file in the review.") }
        return ReviewContent(bytes: output.data, truncated: output.truncated)
    }

    private func reviewContents(_ entry: ReviewChange, worktree: Bool) throws -> (ReviewContent?, ReviewContent?) {
        let base = try reviewBlob(entry.baseObject, mode: entry.baseMode)
        let head = try worktree ? reviewWorktree(entry.path)?.content : reviewBlob(entry.headObject, mode: entry.headMode)
        return (base, head)
    }

    private func reviewWorktree(_ path: String, read: Bool = true) throws -> (mode: String, content: ReviewContent?)? {
        // Open each component without following links. For a leaf symlink, compare the link itself, as Git does.
        var dir = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard dir >= 0 else { throw ExplorerError("io", "The opened folder is no longer available.") }
        defer { _ = Darwin.close(dir) }
        let parts = path.split(separator: "/")
        for part in parts.dropLast() {
            let next = openat(dir, String(part), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
            guard next >= 0 else { return nil }
            _ = Darwin.close(dir)
            dir = next
        }
        guard let leaf = parts.last.map(String.init) else { return nil }
        var stat = Darwin.stat()
        guard fstatat(dir, leaf, &stat, AT_SYMLINK_NOFOLLOW) == 0 else { return nil }
        switch stat.st_mode & S_IFMT {
        case S_IFLNK:
            if !read { return ("120000", nil) }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = bytes.withUnsafeMutableBytes { readlinkat(dir, leaf, $0.baseAddress!, $0.count) }
            guard count >= 0 else { return nil }
            return ("120000", ReviewContent(bytes: Data(bytes.prefix(count)), truncated: count == bytes.count))
        case S_IFREG:
            let mode = stat.st_mode & S_IXUSR == 0 ? "100644" : "100755"
            if !read { return (mode, nil) }
            let fd = openat(dir, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
            guard fd >= 0 else { return nil }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            guard fstat(fd, &stat) == 0, stat.st_mode & S_IFMT == S_IFREG else { return nil }
            let bytes = try handle.read(upToCount: reviewTextLimit + 1) ?? Data()
            return (mode, ReviewContent(bytes: Data(bytes.prefix(reviewTextLimit)), truncated: bytes.count > reviewTextLimit))
        default: return nil
        }
    }
}

private func parseReviewChanges(_ bytes: Data) -> [ReviewChange] {
    let fields = bytes.split(separator: 0, omittingEmptySubsequences: false)
    var changes: [ReviewChange] = []
    var i = 0
    let statuses = ["A": "added", "M": "modified", "D": "deleted", "R": "renamed", "C": "copied", "T": "typechange", "U": "modified"]
    while i + 1 < fields.count, fields[i].first == 58 {
        let header = String(decoding: fields[i].dropFirst(), as: UTF8.self).split(separator: " ")
        guard header.count == 5, let code = header[4].first else { break }
        let paired = code == "R" || code == "C"
        let end = i + (paired ? 2 : 1)
        guard end < fields.count else { break }
        defer { i = end + 1 }
        guard let path = String(bytes: fields[end], encoding: .utf8), validPath(path), let status = statuses[String(code)] else { continue }
        let old = paired ? String(bytes: fields[i + 1], encoding: .utf8) : nil
        if paired && old.map(validPath) != true { continue }
        changes.append(ReviewChange(path: path, oldPath: old, status: status, baseMode: String(header[0]), headMode: String(header[1]),
                                    baseObject: String(header[2]), headObject: String(header[3])))
    }
    var stats: [Data: (Int, Int, Bool)] = [:]
    while i < fields.count, !fields[i].isEmpty {
        let row = fields[i].split(separator: 9, maxSplits: 2, omittingEmptySubsequences: false)
        guard row.count == 3 else { break }
        let added = Int(String(decoding: row[0], as: UTF8.self)), deleted = Int(String(decoding: row[1], as: UTF8.self))
        if row[2].isEmpty {
            guard i + 2 < fields.count else { break }
            i += 2
            stats[Data(fields[i])] = (added ?? 0, deleted ?? 0, added == nil || deleted == nil)
        } else { stats[Data(row[2])] = (added ?? 0, deleted ?? 0, added == nil || deleted == nil) }
        i += 1
    }
    for i in changes.indices {
        if let (added, deleted, binary) = stats[Data(changes[i].path.utf8)] {
            changes[i].additions = added; changes[i].deletions = deleted; changes[i].binary = binary
        }
        if changes[i].baseMode == "160000" || changes[i].headMode == "160000" {
            changes[i].binary = true; changes[i].additions = 0; changes[i].deletions = 0
        }
    }
    return changes
}

private func reviewBinary(_ entry: ReviewChange, _ base: ReviewContent?, _ head: ReviewContent?) -> Bool {
    entry.binary || base.map { $0.text == nil } == true || head.map { $0.text == nil } == true
}

private func reviewHunks(_ base: ReviewContent?, _ head: ReviewContent?, seconds: Double) throws -> (hunks: [ReviewHunk], truncated: Bool) {
    let truncated = base?.truncated == true || head?.truncated == true
    guard !truncated else { return ([], true) }
    if base?.bytes ?? Data() == head?.bytes ?? Data() { return ([], false) }
    if base == nil, let head { return ([ReviewHunk(baseStart: 0, baseCount: 0, headStart: 1, headCount: head.lines)], false) }
    if head == nil, let base { return ([ReviewHunk(baseStart: 1, baseCount: base.lines, headStart: 0, headCount: 0)], false) }
    guard let base, let head else { return ([], false) }
    let folder = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                             appropriateFor: FileManager.default.temporaryDirectory, create: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
    try base.bytes.write(to: folder.appendingPathComponent("base"))
    try head.bytes.write(to: folder.appendingPathComponent("head"))
    // Isolate the raw byte comparison from repository configuration and attributes.
    let output = try command("/usr/bin/git", ["--no-pager", "-c", "core.attributesFile=/dev/null", "diff", "--no-index",
                                              "--text", "--unified=0", "--inter-hunk-context=0"] + reviewDiffOptions + ["--", "base", "head"],
                             cwd: folder, environment: ["PATH": "/usr/bin:/bin", "LC_ALL": "C", "GIT_CONFIG_GLOBAL": "/dev/null",
                                                        "GIT_CONFIG_NOSYSTEM": "1", "GIT_ATTR_NOSYSTEM": "1", "GIT_CEILING_DIRECTORIES": folder.deletingLastPathComponent().path],
                             limit: 12 * mib, seconds: min(6, seconds))
    guard !output.truncated else { return ([], true) }
    guard output.status == 0 || output.status == 1 else { throw ExplorerError("git", "Git could not compare the review files.") }
    var hunks: [ReviewHunk] = []
    for line in output.data.split(separator: 10) where line.starts(with: [64, 64, 32]) {
        let parts = line.split(separator: 32)
        guard parts.count >= 4 else { continue }
        func span(_ field: Data.SubSequence) -> (Int, Int)? {
            let numbers = field.dropFirst().split(separator: 44)
            guard let first = numbers.first, let start = Int(String(decoding: first, as: UTF8.self)) else { return nil }
            let count = numbers.count == 2 ? Int(String(decoding: numbers[1], as: UTF8.self)) : 1
            return count.map { (start, $0) }
        }
        guard let (baseStart, baseCount) = span(parts[1]), let (headStart, headCount) = span(parts[2]) else { continue }
        if hunks.count == 100_000 { return (hunks, true) }
        hunks.append(ReviewHunk(baseStart: baseStart, baseCount: baseCount, headStart: headStart, headCount: headCount))
    }
    return (hunks, false)
}
