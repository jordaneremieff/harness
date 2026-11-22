import Darwin
import Foundation

extension Workspace {
    func search(_ query: String, regex: Bool, caseSensitive: Bool, limit: Int) throws -> [String: Any] {
        guard !query.isEmpty, query.utf8.count <= 1024, !query.utf8.contains(where: { $0 == 0 || $0 == 10 || $0 == 13 }) else {
            throw ExplorerError("invalid", "Search text must be a single line of at most 1024 bytes.")
        }
        let maxRows = min(2000, max(1, limit)), deadline = ProcessInfo.processInfo.systemUptime + 4
        let matcher = try SearchMatcher(query, regex: regex, sensitive: caseSensitive)
        var index = indexCache.current()
        var results: [[String: Any]] = [], bytes = 0, truncated = false
        func append(_ path: String, _ line: Int, _ column: Int, _ text: String) -> Bool {
            let preview = String(text.prefix(240))
            let cost = path.utf8.count * 2 + preview.utf8.count * 2 + 96
            guard results.count < maxRows, bytes + cost <= 225 * kib else { truncated = true; return false }
            results.append(["path": path, "line": line, "column": column, "preview": preview]); bytes += cost
            return true
        }
        func grep(_ relative: String, threads: Int, seconds: Double) throws -> SearchGrepOutput {
            let folder = relative.isEmpty ? root : root.appendingPathComponent(relative)
            guard canonical(folder.path) == folder.path, relative.isEmpty || RepositoryMarker.read(folder.path) != nil else {
                throw ExplorerError("git", "The repository is not available for search.")
            }
            let remaining = deadline - uptime()
            guard remaining > 0 else { throw ExplorerError("timeout", "The search exceeded its time limit.") }
            var args = ["grep", "--untracked", "--no-textconv", "--no-recurse-submodules", "--threads=\(threads)",
                        "-z", "-n", "--column", "-I", "-m", String(maxRows + 1), regex ? "-E" : "-F"]
            if !caseSensitive { args.append("-i") }
            args += ["-e", query, "--"]
            return try SearchGrepOutput.collect { receive in
                try Self.invoke(folder, args, limit: 4 * mib, seconds: min(seconds, remaining), inWorkTree: true, onChunk: receive)
            }
        }
        var capped = false
        func consume(_ result: Result<SearchGrepOutput, Error>, in repository: String) {
            guard case .success(let output) = result else { truncated = true; return }
            truncated = truncated || output.truncated
            output.eachRecord { name, line, col, rawText in
                let path = childPath(repository, name)
                guard validPath(path) else { return true }
                // Git reports byte columns. Convert to JavaScript's UTF-16 positions.
                let column = String(decoding: rawText.prefix(col - 1), as: UTF8.self).utf16.count + 1
                if append(path, line, column, previewText(rawText, byteColumn: col)) { return true }
                capped = true
                return false
            }
        }
        if isGit { consume(Result { try grep("", threads: 4, seconds: 2.5) }, in: "") }
        if !capped, index == nil {
            let remaining = deadline - uptime()
            if remaining > 0 { index = buildIndex(seconds: min(1.25, remaining), maxPaths: 20_000) }
            else { truncated = true }
        }
        let repositories = index?.repositories.map(\.path) ?? []
        for start in stride(from: 0, to: repositories.count, by: 4) {
            guard !capped else { break }
            guard uptime() < deadline else { truncated = true; break }
            let batch = repositories[start..<min(start + 4, repositories.count)]
            let outputs = repositoryBatch(batch) { relative in Result { try grep(relative, threads: 1, seconds: 1.5) } }
            for (relative, result) in zip(batch, outputs) {
                consume(result, in: relative)
                if capped { break }
            }
        }
        if !capped {
            var scannedBytes = 0
            scan: for path in index?.plainPaths ?? [] {
                guard ProcessInfo.processInfo.systemUptime < deadline, scannedBytes < 32 * mib else { truncated = true; break }
                guard let (fd, _) = try? openContained(root, path) else { continue }
                let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                var details = stat()
                guard fstat(fd, &details) == 0, details.st_mode & S_IFMT == S_IFREG else { continue }
                let cap = min(mib, 32 * mib - scannedBytes)
                if details.st_size > cap { truncated = true }
                guard let data = try? handle.read(upToCount: cap), !data.contains(0), String(data: data, encoding: .utf8) != nil else { continue }
                scannedBytes += data.count
                for (i, line) in data.split(separator: 10, omittingEmptySubsequences: false).enumerated() {
                    guard ProcessInfo.processInfo.systemUptime < deadline else { truncated = true; break scan }
                    if line.count > 32 * kib { truncated = true; continue }
                    guard let index = matcher.match(line) else { continue }
                    let column = String(decoding: line.prefix(index), as: UTF8.self).utf16.count + 1
                    if !append(path, i + 1, column, previewText(line, byteColumn: index + 1)) { break scan }
                }
            }
        }
        return ["results": results, "truncated": truncated || index?.truncated == true, "source": index?.source ?? (isGit ? "git" : "scan")]
    }
}

struct SearchGrepOutput {
    let data: Data
    let truncated: Bool

    static func collect(_ run: (_ receive: @escaping (Data) -> Bool) throws -> CommandResult) throws -> SearchGrepOutput {
        var data = Data()
        do {
            let output = try run { data.append($0); return true }
            guard output.truncated || output.status == 0 || output.status == 1 else {
                throw ExplorerError("git", "Git could not search the repository.")
            }
            return SearchGrepOutput(data: data, truncated: output.truncated)
        } catch let error as ExplorerError where error.code == "timeout" {
            return SearchGrepOutput(data: data, truncated: true)
        }
    }

    func eachRecord(_ visit: (String, Int, Int, Data.SubSequence) -> Bool) {
        var i = data.startIndex
        func next(_ delimiter: UInt8) -> Data.SubSequence? {
            guard i < data.endIndex, let end = data[i...].firstIndex(of: delimiter) else { return nil }
            let field = data[i..<end]; i = end + 1; return field
        }
        while let rawPath = next(0), let rawLine = next(0), let rawColumn = next(0), let rawText = next(10) {
            guard let path = String(bytes: rawPath, encoding: .utf8), validPath(path),
                  let line = Int(String(decoding: rawLine, as: UTF8.self)), line > 0,
                  let column = Int(String(decoding: rawColumn, as: UTF8.self)), column > 0 else { continue }
            if !visit(path, line, column, rawText) { break }
        }
    }
}

private func previewText(_ bytes: Data.SubSequence, byteColumn: Int) -> String {
    let prefix = max(0, byteColumn - 100)
    return (prefix == 0 ? "" : "…") + String(decoding: bytes.dropFirst(prefix).prefix(512), as: UTF8.self)
}

private final class SearchMatcher {
    private var pattern = regex_t()
    init(_ query: String, regex: Bool, sensitive: Bool) throws {
        let flags = (regex ? REG_EXTENDED : REG_NOSPEC) | (sensitive ? 0 : REG_ICASE)
        if regex, query.range(of: #"\\[1-9]"#, options: .regularExpression) != nil {
            throw ExplorerError("invalid", "Search does not support regular-expression backreferences.")
        }
        guard regcomp(&pattern, query, flags) == 0 else { throw ExplorerError("invalid", "The regular expression is invalid.") }
    }
    deinit { regfree(&pattern) }
    func match(_ line: Data.SubSequence) -> Int? {
        var matched = regmatch_t()
        var c = [UInt8](line); c.append(0)
        let status = c.withUnsafeBytes { regexec(&pattern, $0.baseAddress!.assumingMemoryBound(to: CChar.self), 1, &matched, 0) }
        return status == 0 && matched.rm_so >= 0 ? Int(matched.rm_so) : nil
    }
}
