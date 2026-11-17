import Foundation

/// Metadata selection never reads document source. Dates use the record's update date in UTC.
public struct LibraryFilter: Sendable {
    public var text = ""
    public var kind: DocumentKind?
    public var source = ""
    public var fromDate = ""
    public var throughDate = ""

    public init() {}

    public var dateError: String? {
        if !fromDate.isEmpty && !Self.validDate(fromDate) { return "From date must be YYYY-MM-DD." }
        if !throughDate.isEmpty && !Self.validDate(throughDate) { return "Through date must be YYYY-MM-DD." }
        if !fromDate.isEmpty && !throughDate.isEmpty && fromDate > throughDate { return "From date is after the through date." }
        return nil
    }

    public func matches(title: String, id: String, kind: DocumentKind?, source: String, updatedAt: String) -> Bool {
        guard dateError == nil else { return false }
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !query.isEmpty && !title.localizedCaseInsensitiveContains(query) && !id.localizedCaseInsensitiveContains(query) { return false }
        if let selected = self.kind, selected != kind { return false }
        if !self.source.isEmpty && !source.localizedCaseInsensitiveContains(self.source) { return false }
        let date = String(updatedAt.prefix(10))
        if !fromDate.isEmpty && date < fromDate { return false }
        if !throughDate.isEmpty && date > throughDate { return false }
        return true
    }

    private static func validDate(_ value: String) -> Bool {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(secondsFromGMT: 0)
        parser.dateFormat = "yyyy-MM-dd"
        parser.isLenient = false
        guard value.utf8.count == 10, let date = parser.date(from: value) else { return false }
        return parser.string(from: date) == value
    }
}

public struct SourceSearchBatch: Sendable {
    public var examined: [String] = []
    public var matches: [String] = []
    public var excerpts: [String: String] = [:]
    public var issues: [ListingIssue] = []
    public var bytes = 0
}

/// A literal, case-insensitive source search over an explicitly supplied set of revision rows.
/// Each batch opens at most 20 sources and reads at most 8 MiB. It has no persistent index.
public enum SourceContentSearch {
    public static func excerpt(in source: String, query: String) -> String? {
        guard !query.isEmpty, let match = source.range(of: query, options: [.caseInsensitive], locale: .current) else { return nil }
        let start = source.index(match.lowerBound, offsetBy: -60, limitedBy: source.startIndex) ?? source.startIndex
        var excerpt = "", bytes = 0
        for character in source[start...].prefix(180) {
            let text = String(character), count = text.utf8.count
            guard bytes + count <= 2048 else { break }
            excerpt += text; bytes += count
        }
        return excerpt
    }

    public static func search(store: DirectoryStore, records: [DocumentRecord], query: String,
                              limit: Int = 20, byteLimit: Int = 8 * 1024 * 1024) -> SourceSearchBatch {
        var result = SourceSearchBatch()
        guard !query.isEmpty else { return result }
        for record in records.prefix(max(0, min(limit, 20))) {
            // Reserve the largest accepted source before opening; a corrupt pointer's byte count
            // must not defeat the read bound.
            guard result.bytes + Limits.sourceBytes <= min(byteLimit, 8 * 1024 * 1024) else { break }
            result.examined.append(record.id)
            do {
                let loaded = try store.loadRevision(record.id, revision: record.revision)
                guard loaded.record.digest == record.digest else { throw StoreError.digestMismatch }
                result.bytes += loaded.record.bytes
                if let excerpt = excerpt(in: loaded.source, query: query) {
                    result.matches.append(record.id)
                    result.excerpts[record.id] = excerpt
                }
            } catch {
                result.bytes += Limits.sourceBytes
                result.issues.append(ListingIssue(document: record.id, reason: String(describing: error)))
            }
        }
        return result
    }
}
