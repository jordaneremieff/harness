import Darwin
import Foundation
import MarkdownCore

struct ReviewScope: Codable, Sendable {
    let conversation: String
    let document: String
}

struct ReviewComment: Codable, Sendable {
    let commentId: String
    let threadId: String
    let kind: String
    let ordinal: Int
    let text: String
    var quote: String? = nil
    var sourceAnchor: String? = nil
    var anchorDigest: String? = nil
    var passageAnchor: ReviewPassageAnchor? = nil
    var start: Int? = nil
    var end: Int? = nil
    var madeOnRevision: Int? = nil
    var commentState = "open"
    var version = 1
}

struct ReviewSheet: Codable, Sendable {
    var revision: Int
    var comments: [ReviewComment]
}

enum ReviewStoreError: LocalizedError, Equatable {
    case invalid, stale, missing, limit, busy

    var errorDescription: String? {
        switch self {
        case .invalid: "The review data is invalid or inconsistent."
        case .stale: "The comment changed. Read its current version before trying again."
        case .missing: "No such review comment exists on this document."
        case .limit: "The review store limit was reached. No comments were removed."
        case .busy: "Another reader holds the review lock. Try again."
        }
    }
}

/// Every process replaces a complete sheet under the same stable per-scope lock.
/// Readers open the published sheet, never the incomplete replacement.
struct ReviewCommentStore: Sendable {
    let directory: URL
    private static let byteLimit = 4 * 1024 * 1024
    private static let countLimit = 16_384
    // The page and live client compare sheet and comment versions as JavaScript numbers.
    private static let lastVersion = 9_007_199_254_740_991

    func load(scope: ReviewScope) throws -> ReviewSheet {
        let file = try ReviewRecordFile(directory: directory, scope: scope, suffix: ".json")
        return try read(file)
    }

    func record(scope: ReviewScope, comments: [ReviewComment]) throws {
        guard (1...51).contains(comments.count), comments.allSatisfy({ $0.version == 1 && $0.commentState == "open" }) else {
            throw ReviewStoreError.invalid
        }
        try Self.validateGroup(comments)
        let file = try ReviewRecordFile(directory: directory, scope: scope, suffix: ".json")
        try file.withWriter {
            var sheet = try read(file)
            let members = comments.sorted { $0.ordinal < $1.ordinal }
            let prior = sheet.comments.filter { $0.threadId == members[0].threadId }.sorted { $0.ordinal < $1.ordinal }
            if !prior.isEmpty {
                guard prior.count == members.count, zip(prior, members).allSatisfy({ old, new in
                    old.commentId == new.commentId && old.kind == new.kind && old.text.utf8.elementsEqual(new.text.utf8)
                }) else { throw ReviewStoreError.invalid }
                return
            }
            guard sheet.comments.count + members.count <= Self.countLimit else { throw ReviewStoreError.limit }
            let contentBytes = members.reduce(0) { total, item in
                total + item.text.utf8.count + (item.quote?.utf8.count ?? 0) + (item.sourceAnchor?.utf8.count ?? 0)
            }
            guard contentBytes <= Self.byteLimit else { throw ReviewStoreError.limit }
            sheet.comments.append(contentsOf: members)
            try publish(&sheet, to: file)
        }
    }

    func set(scope: ReviewScope, id: String, state: String, expectedVersion: Int) throws -> ReviewComment {
        guard ["open", "closed"].contains(state), expectedVersion > 0, Self.validId(id) else { throw ReviewStoreError.invalid }
        let file = try ReviewRecordFile(directory: directory, scope: scope, suffix: ".json")
        return try file.withWriter {
            var sheet = try read(file)
            guard let index = sheet.comments.firstIndex(where: { $0.commentId == id }) else { throw ReviewStoreError.missing }
            guard sheet.comments[index].version == expectedVersion else { throw ReviewStoreError.stale }
            if sheet.comments[index].commentState != state {
                guard expectedVersion < Self.lastVersion else { throw ReviewStoreError.limit }
                sheet.comments[index].commentState = state
                sheet.comments[index].version += 1
                try publish(&sheet, to: file)
            }
            return sheet.comments[index]
        }
    }

    private static func validId(_ id: String) -> Bool {
        let parts = id.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let uuid = UUID(uuidString: String(parts[0])), let ordinal = Int(parts[1]), (0...50).contains(ordinal) else { return false }
        return id == "\(uuid.uuidString.lowercased()):\(ordinal)"
    }

    private static func validateGroup(_ items: [ReviewComment]) throws {
        guard let first = items.first, items.count <= 51 else { throw ReviewStoreError.invalid }
        let ordinals = Set(items.map(\.ordinal))
        let annotations = items.filter { $0.kind == "annotation" }
        guard ordinals.count == items.count,
              (items.count == 1 && first.kind == "question" || !annotations.isEmpty && !items.contains(where: { $0.kind == "question" })) else {
            throw ReviewStoreError.invalid
        }
        guard annotations.allSatisfy({ (1...annotations.count).contains($0.ordinal) }) else { throw ReviewStoreError.invalid }
        for item in items {
            guard item.threadId == first.threadId, validId(item.commentId), item.commentId == "\(item.threadId):\(item.ordinal)",
                  item.ordinal == 0 ? ["overall", "question"].contains(item.kind) : item.kind == "annotation",
                  (item.madeOnRevision ?? 1) > 0, (1...Self.lastVersion).contains(item.version),
                  item.commentState == (item.version.isMultiple(of: 2) ? "closed" : "open"),
                  !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  item.text.utf8.count <= 131_072 else { throw ReviewStoreError.invalid }
            if let quote = item.quote, quote.isEmpty || quote.utf8.count > 8192 { throw ReviewStoreError.invalid }
            if let digest = item.anchorDigest, item.sourceAnchor == nil || digest.utf8.count != 71 || !digest.hasPrefix("sha256:") ||
                !digest.utf8.dropFirst(7).allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) { throw ReviewStoreError.invalid }
            if let passageAnchor = item.passageAnchor, !passageAnchor.valid(raw: item.sourceAnchor, quote: item.quote) { throw ReviewStoreError.invalid }
            if item.kind == "overall", item.quote != nil || item.sourceAnchor != nil || item.passageAnchor != nil { throw ReviewStoreError.invalid }
            switch (item.sourceAnchor, item.start, item.end) {
            case (nil, nil, nil): break
            case let (anchor?, start?, end?):
                guard start >= 0, end > start, end <= Limits.sourceBytes,
                      anchor.utf8.count <= Limits.sourceBytes, end - start == anchor.utf16.count else { throw ReviewStoreError.invalid }
            default: throw ReviewStoreError.invalid
            }
        }
    }

    private func read(_ file: ReviewRecordFile) throws -> ReviewSheet {
        guard let data = try file.read(limit: Self.byteLimit) else { return ReviewSheet(revision: 0, comments: []) }
        // Codable ignores extra fields. Refuse to rewrite a sheet with a shape this reader does not know.
        let allowed: Set<String> = ["commentId", "threadId", "kind", "ordinal", "text", "quote", "sourceAnchor", "anchorDigest", "passageAnchor", "start", "end", "madeOnRevision", "commentState", "version"]
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(obj.keys) == ["revision", "comments"],
              let entries = obj["comments"] as? [[String: Any]], entries.count <= Self.countLimit,
              entries.allSatisfy({ allowed.isSuperset(of: $0.keys) && !$0.values.contains(where: { $0 is NSNull }) }) else { throw ReviewStoreError.invalid }
        let sheet = try JSONDecoder().decode(ReviewSheet.self, from: data)
        let groups = Dictionary(grouping: sheet.comments, by: \.threadId)
        var revision = groups.count
        for items in groups.values {
            try Self.validateGroup(items)
            for item in items {
                let (next, overflow) = revision.addingReportingOverflow(item.version - 1)
                guard !overflow else { throw ReviewStoreError.invalid }
                revision = next
            }
        }
        guard (1...Self.lastVersion).contains(revision), revision == sheet.revision else { throw ReviewStoreError.invalid }
        return sheet
    }

    private func publish(_ sheet: inout ReviewSheet, to file: ReviewRecordFile) throws {
        guard sheet.revision < Self.lastVersion else { throw ReviewStoreError.limit }
        sheet.revision += 1
        let bytes = try JSONEncoder().encode(sheet)
        // Reserve space on admission so a full sheet still permits closing and reopening its comments.
        let digits = String(Int.max).count
        let growth = sheet.comments.reduce(digits - String(sheet.revision).count) { sum, item in
            sum + digits - String(item.version).count + (item.commentState == "open" ? 2 : 0)
        }
        guard bytes.count <= Self.byteLimit - growth else { throw ReviewStoreError.limit }
        try file.replace(bytes)
    }
}

/// Both review stores use private files and atomic replacement. Their suffixes select independent records and locks.
struct ReviewRecordFile: Sendable {
    private let url: URL
    private var directory: URL { url.deletingLastPathComponent() }

    init(directory: URL, scope: ReviewScope, suffix: String) throws {
        let parts = [scope.conversation, scope.document]
        guard parts.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= 16_384 }) else {
            throw ReviewStoreError.invalid
        }
        // Length framing preserves the exact UTF-8 bytes, including separators in identifiers.
        var key = Data()
        for part in parts {
            key.append(contentsOf: "\(part.utf8.count):".utf8)
            key.append(contentsOf: part.utf8)
        }
        self.url = directory.appendingPathComponent(String(Digest.sha256(key).dropFirst("sha256:".count)) + suffix)
    }

    private func privateDirectoryExists() throws -> Bool {
        var info = stat()
        guard lstat(directory.path, &info) == 0 else {
            if errno == ENOENT { return false }
            throw Self.ioError()
        }
        guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else {
            throw ReviewStoreError.invalid
        }
        return true
    }

    func read(limit: Int) throws -> Data? {
        guard try privateDirectoryExists() else { return nil }
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            if errno == ENOENT { return nil }
            throw Self.ioError()
        }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else { throw ReviewStoreError.invalid }
        return try FileAccess.readRegularFile(url, limit: limit, missing: .notFound("review data"))
    }

    func withWriter<T>(_ body: () throws -> T) throws -> T {
        if try !privateDirectoryExists() {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            guard try privateDirectoryExists() else { throw ReviewStoreError.invalid }
        }
        let fd = open(url.deletingPathExtension().appendingPathExtension("lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw Self.ioError() }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else {
            throw ReviewStoreError.invalid
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK || errno == EINTR else { throw Self.ioError() }
            guard ContinuousClock.now < deadline else { throw ReviewStoreError.busy }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return try body()
    }

    func replace(_ bytes: Data) throws {
        // A crash can leave one unfinished write. The next writer holds the same lock.
        let tmp = url.appendingPathExtension("pending")
        guard unlink(tmp.path) == 0 || errno == ENOENT else { throw Self.ioError() }
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Self.ioError() }
        defer { unlink(tmp.path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: bytes)
        try handle.close()
        guard rename(tmp.path, url.path) == 0 else { throw Self.ioError() }
    }

    private static func ioError() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
}
