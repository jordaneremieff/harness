import Darwin
import Foundation

extension Workspace {
    func search(_ query: String, regex: Bool, caseSensitive: Bool, limit: Int) throws -> [String: Any] {
        guard !query.isEmpty, query.utf8.count <= 1024, !query.utf8.contains(where: { $0 == 0 || $0 == 10 || $0 == 13 }) else {
            throw ExplorerError("invalid", "Search text must be a single line of at most 1024 bytes.")
        }
        let maxRows = min(2000, max(1, limit)), deadline = ProcessInfo.processInfo.systemUptime + 4
        var results: [[String: Any]] = [], bytes = 0, truncated = false
        func append(_ path: String, _ line: Int, _ column: Int, _ text: String) -> Bool {
            let preview = String(text.prefix(240))
            let cost = path.utf8.count * 2 + preview.utf8.count * 2 + 96
            guard results.count < maxRows, bytes + cost <= 225 * kib else { truncated = true; return false }
            results.append(["path": path, "line": line, "column": column, "preview": preview]); bytes += cost
            return true
        }
        if isGit {
            var args = ["grep", "--no-textconv", "--no-recurse-submodules", "--threads=4", "-z", "-n", "--column", "-I", "-m", String(maxRows + 1)]
            args.append(regex ? "-E" : "-F")
            if !caseSensitive { args.append("-i") }
            args += ["-e", query, "--"]
            let output = try git(args, limit: 4 * mib, seconds: 2.5)
            guard output.truncated || output.status == 0 || output.status == 1 else {
                throw ExplorerError("invalid", regex ? "Git did not accept the regular expression." : "Git could not search the repository.")
            }
            var i = output.data.startIndex
            func next(_ delimiter: UInt8) -> Data.SubSequence? {
                guard i < output.data.endIndex, let end = output.data[i...].firstIndex(of: delimiter) else { return nil }
                let field = output.data[i..<end]; i = end + 1; return field
            }
            while let rawPath = next(0), let rawLine = next(0), let rawColumn = next(0), let rawText = next(10) {
                guard let path = String(bytes: rawPath, encoding: .utf8), validPath(path),
                      let line = Int(String(decoding: rawLine, as: UTF8.self)), let col = Int(String(decoding: rawColumn, as: UTF8.self)) else { continue }
                // Git reports byte columns. Convert to JavaScript's UTF-16 positions.
                let column = String(decoding: rawText.prefix(max(0, col - 1)), as: UTF8.self).utf16.count + 1
                let text = previewText(rawText, byteColumn: col)
                if !append(path, line, column, text) { break }
            }
            truncated = truncated || output.truncated
        }
        if !truncated {
            let candidates: (paths: [String], truncated: Bool)
            if isGit {
                let output = try git(["ls-files", "-z", "--others", "--exclude-standard"], limit: 2 * mib, seconds: 1)
                let complete = output.data.last == 0 || output.data.isEmpty ? output.data : output.data.prefix(through: output.data.lastIndex(of: 0) ?? output.data.startIndex)
                let names = complete.split(separator: 0).compactMap { String(bytes: $0, encoding: .utf8) }.filter(validPath)
                candidates = (Array(names.prefix(10_000)), output.truncated || names.count > 10_000)
            } else {
                candidates = try files(maxPaths: 20_000)
            }
            let matcher = try SearchMatcher(query, regex: regex, sensitive: caseSensitive)
            truncated = candidates.truncated
            var scannedBytes = 0
            scan: for path in candidates.paths {
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
        return ["results": results, "truncated": truncated, "source": isGit ? "git" : "scan"]
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
