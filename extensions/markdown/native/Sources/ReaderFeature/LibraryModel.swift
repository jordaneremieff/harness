import Foundation
import MarkdownCore
import Observation

/// Passive library reads use authoritative files and bounded, continuing directory scans.
@MainActor @Observable
public final class LibraryModel {
    public struct Row: Identifiable, Sendable {
        public var reference: DocumentReference
        public var title: String
        public var detail: String
        public var source = ""
        public var record: DocumentRecord? = nil
        public var id: String { reference.key }
    }

    public struct Section: Identifiable, Sendable {
        public var id: String
        public var title: String
        public var rows: [Row]
        public var note: String?
        public var hasMore = false
        var scanned = 0
        var unreadable = 0
        var metadataFailures = 0
        var issues: [ListingIssue] = []
        var failure: String?
    }

    private struct ScanContext: Sendable {
        var scan: CollectionScan
        var store: DirectoryStore
        var root: String
        var collection: StoreCollection
        var id: String { "\(root)|\(collection.rawValue)" }
    }

    public private(set) var sections: [Section] = []
    public private(set) var loading = false
    public private(set) var availableRoots: [String] = []
    public private(set) var selectionFailure: String?
    public var selectedRoot: String? { state.selectedStoreRoot ?? extraRoots.first ?? state.knownRoots.first }
    public var persistenceNote: String? {
        if state.isSaving { return "Reading state: save in progress." }
        if state.hasPendingChanges { return "Reading state: changes are not saved yet." }
        if state.lastRecovery != nil { return "Reading state: the reader kept an unreadable state file during recovery." }
        return nil
    }
    public var filter = ""
    public var kind = "all"
    public var sourceFilter = ""
    public var fromDate = ""
    public var throughDate = ""
    public var sourceQuery = ""
    public private(set) var sourceSearchNote: String?
    private var searchedQuery = ""
    private var examined: Set<String> = []
    private var matches: Set<String> = []
    private var sourceFailures = 0
    private var sourceExcerpts: [String: String] = [:]
    private var pendingRoot: String?
    @ObservationIgnored private var scans: [String: ScanContext] = [:]
    @ObservationIgnored let state: ReadingStateStore
    @ObservationIgnored let extraRoots: [String]
    @ObservationIgnored private let collections: [StoreCollection]

    public init(state: ReadingStateStore, extraRoots: [String], collections: [StoreCollection] = Array(StoreCollection.allCases)) {
        self.state = state
        self.extraRoots = extraRoots
        self.collections = collections
    }

    private var query: LibraryFilter {
        var query = LibraryFilter()
        query.text = filter
        query.kind = DocumentKind(rawValue: kind)
        query.source = sourceFilter
        query.fromDate = fromDate
        query.throughDate = throughDate
        return query
    }

    public var dateError: String? { query.dateError }

    public func reload() async {
        guard !loading else { return }
        loading = true
        state.reload()
        var roots: [String] = []
        for root in [selectedRoot].compactMap({ $0 }) + state.knownRoots + extraRoots where !roots.contains(root) { roots.append(root) }
        availableRoots = roots
        let selected = selectedRoot.map { [$0] } ?? []
        let recents = state.recents
        let collections = self.collections
        let loaded = await Task.detached { () -> ([Section], [String: ScanContext]) in
            let recentRows = recents.map { Row(reference: $0.reference, title: $0.title, detail: Self.recentDetail($0)) }
            var sections = [Section(id: "recent", title: "Recently Read", rows: recentRows, note: recentRows.isEmpty ? "Documents you open appear here." : nil)]
            var scans: [String: ScanContext] = [:]
            for root in selected where !collections.isEmpty {
                do {
                    let store = try DirectoryStore(root: URL(fileURLWithPath: root))
                    for collection in collections {
                        let title = Self.title(root, collection)
                        do {
                            let context = ScanContext(scan: try CollectionScan(store: store, collection: collection), store: store, root: root, collection: collection)
                            let empty = Section(id: context.id, title: title, rows: [], note: nil)
                            sections.append(Self.page(context, previous: empty))
                            scans[context.id] = context
                        } catch {
                            sections.append(Section(id: "\(root)|\(collection.rawValue)", title: title, rows: [], note: "Collection unavailable: \(error)", failure: String(describing: error)))
                        }
                    }
                } catch {
                    sections.append(Section(id: root, title: root, rows: [], note: "Store unavailable: \(error)", failure: String(describing: error)))
                }
            }
            return (sections, scans)
        }.value
        sections = loaded.0
        scans = loaded.1
        clearSourceSearch()
        loading = false
        await applyPendingSelection()
    }

    private func applyPendingSelection() async {
        guard let root = pendingRoot else { return }
        pendingRoot = nil
        await selectStore(root)
    }

    public func selectStore(_ root: String) async {
        guard !loading else { pendingRoot = root; return }
        loading = true
        let result = await Task.detached { () -> Result<String, any Error> in
            Result {
                let store = try DirectoryStore(root: URL(fileURLWithPath: root))
                return FileAccess.canonicalPath(store.root.path)
            }
        }.value
        loading = false
        switch result {
        case .success(let root):
            state.selectStore(root: root)
            selectionFailure = nil
            await reload()
        case .failure(let error):
            selectionFailure = "Store not selected: \(error). The previous store remains selected."
            await applyPendingSelection()
        }
    }

    public func loadMore(_ id: String) async {
        guard !loading, let context = scans[id], let previous = sections.first(where: { $0.id == id }), previous.hasMore else { return }
        loading = true
        let section = await Task.detached { Self.page(context, previous: previous) }.value
        if let index = sections.firstIndex(where: { $0.id == id }) { sections[index] = section }
        loading = false
        await applyPendingSelection()
    }

    private nonisolated static func page(_ context: ScanContext, previous: Section) -> Section {
        let listing = context.scan.next()
        var section = previous
        var rows = Dictionary(uniqueKeysWithValues: previous.rows.map { ($0.id, $0) })
        for record in listing.documents {
            let reference = DocumentReference.stored(root: FileAccess.canonicalPath(context.root), storeId: context.store.storeId, document: record.id)
            var source = ""
            var detail = storedDetail(record)
            do {
                let metadata = try context.store.revisionMetadata(record.id, revision: record.revision)
                source = [metadata.contentOrigin?.path, metadata.contentOrigin?.cwd, metadata.contentOrigin?.kind].compactMap { $0 }.joined(separator: " · ")
            } catch {
                section.metadataFailures += 1
                detail += " · source metadata unavailable"
                if section.issues.count < 8 { section.issues.append(ListingIssue(document: record.id, reason: String(describing: error))) }
            }
            rows[reference.key] = Row(reference: reference, title: record.title, detail: detail, source: source, record: record)
        }
        section.rows = rows.values.sorted {
            let left = $0.record?.updatedAt ?? "", right = $1.record?.updatedAt ?? ""
            return left == right ? $0.id < $1.id : left > right
        }
        section.scanned += listing.scanned
        section.unreadable += listing.unreadable
        section.issues += listing.issues.prefix(max(0, 8 - section.issues.count))
        section.hasMore = listing.truncated
        section.failure = listing.failure ?? section.failure
        var notes = ["\(section.scanned) directory entries scanned. Newest among scanned rows; reload for concurrent changes."]
        if section.hasMore { notes.append("More entries remain. Read the next batch to continue.") }
        if section.unreadable > 0 { notes.append("\(section.unreadable) document records omitted. This list is incomplete.") }
        if section.metadataFailures > 0 { notes.append("\(section.metadataFailures) source metadata records unavailable; those rows remain openable.") }
        for issue in section.issues { notes.append("\(issue.document): \(issue.reason)") }
        if let failure = section.failure { notes.append("Collection read failed: \(failure). This list is incomplete.") }
        if listing.absent { notes.append("This collection does not exist yet.") }
        else if section.rows.isEmpty && !section.hasMore && section.unreadable == 0 && section.failure == nil {
            notes.append(context.collection == .published ? "No published documents." : "No saved snapshots.")
        }
        section.note = notes.joined(separator: " ")
        return section
    }

    private func metadataRows(_ section: Section) -> [Row] {
        section.rows.filter {
            query.matches(title: $0.title, id: $0.id, kind: $0.record?.kind, source: $0.source, updatedAt: $0.record?.updatedAt ?? "")
        }
    }

    public func visibleRows(_ section: Section) -> [Row] {
        let rows = metadataRows(section)
        guard !searchedQuery.isEmpty, searchedQuery == sourceQuery else { return rows }
        return rows.filter { matches.contains($0.id) }
    }

    public func clearSourceSearch() {
        searchedQuery = ""
        examined = []
        matches = []
        sourceFailures = 0
        sourceExcerpts = [:]
        sourceSearchNote = nil
    }

    public struct SourceCoverage: Sendable, Equatable {
        public var searched: Int
        public var total: Int?
        public var stopped: Bool
        public var reason: String?
    }

    private func sourceRows(in sectionIDs: Set<String>?) -> [Row] {
        var seen: Set<String> = []
        return sections.filter { sectionIDs?.contains($0.id) ?? true }
            .flatMap { metadataRows($0) }.filter { seen.insert($0.id).inserted }
    }

    public func hasMoreSources(in sectionIDs: Set<String>? = nil) -> Bool {
        !sourceQuery.isEmpty && sourceRows(in: sectionIDs).contains { !examined.contains($0.id) }
    }

    public func sourceExcerpt(for row: Row) -> String? { sourceExcerpts[row.id] }

    public func sourceCoverage(in sectionIDs: Set<String>? = nil) -> SourceCoverage {
        let selected = sections.filter { sectionIDs?.contains($0.id) ?? true }
        let ids = Set(sourceRows(in: sectionIDs).map(\.id))
        let moreEntries = selected.contains(where: \.hasMore)
        let failed = sourceFailures > 0 || selected.contains { $0.unreadable > 0 || $0.failure != nil }
        let unchecked = !sourceQuery.isEmpty && !ids.subtracting(examined).isEmpty
        let reason: String? = failed ? "Some records or sources could not be read."
            : moreEntries ? "More directory entries remain."
            : unchecked ? "The source search reached its batch limit." : nil
        return SourceCoverage(searched: ids.intersection(examined).count,
                              total: moreEntries || failed ? nil : ids.count,
                              stopped: moreEntries || failed || unchecked, reason: reason)
    }

    public func searchNextSources(in sectionIDs: Set<String>? = nil) async {
        guard !loading, !sourceQuery.isEmpty, dateError == nil else { return }
        if searchedQuery != sourceQuery { clearSourceSearch(); searchedQuery = sourceQuery }
        let candidates = sourceRows(in: sectionIDs).filter { !examined.contains($0.id) }
        let query = sourceQuery
        loading = true
        let result = await Task.detached { () -> (Set<String>, Set<String>, Int, [String: String]) in
            var examined: Set<String> = [], matches: Set<String> = [], excerpts: [String: String] = [:]
            var bytes = 0, failures = 0
            for row in candidates.prefix(20) {
                // Reserve a maximum-size source even when its record is unreadable.
                guard bytes + Limits.sourceBytes <= 8 * 1024 * 1024 else { break }
                examined.insert(row.id)
                do {
                    switch row.reference {
                    case .stored(let root, let storeId, let id):
                        let store = try DirectoryStore(root: URL(fileURLWithPath: root))
                        guard store.storeId == storeId else { throw StoreError.unreadable("Store identity changed") }
                        let record = try row.record ?? store.document(id)
                        let batch = SourceContentSearch.search(store: store, records: [record], query: query, byteLimit: 8 * 1024 * 1024 - bytes)
                        if !batch.matches.isEmpty { matches.insert(row.id) }
                        if let excerpt = batch.excerpts[id] { excerpts[row.id] = excerpt }
                        bytes += batch.bytes
                        failures += batch.issues.count
                    case .file:
                        let snapshot = try DocumentLoader.load(row.reference, revision: nil, pinnedDigest: nil)
                        bytes += snapshot.bytes
                        if let excerpt = SourceContentSearch.excerpt(in: snapshot.source, query: query) {
                            matches.insert(row.id)
                            excerpts[row.id] = excerpt
                        }
                    }
                } catch {
                    bytes += Limits.sourceBytes
                    failures += 1
                }
            }
            return (examined, matches, failures, excerpts)
        }.value
        examined.formUnion(result.0)
        matches.formUnion(result.1)
        sourceFailures += result.2
        sourceExcerpts.merge(result.3) { _, new in new }
        sourceSearchNote = "Source search: \(examined.count) sources checked, \(matches.count) matched, \(sourceFailures) unavailable. Only checked sources under the metadata selection are covered. Read more directory entries to reach other documents."
        loading = false
        await applyPendingSelection()
    }

    nonisolated static func title(_ root: String, _ collection: StoreCollection) -> String {
        collection == .published ? "Published in \(abbreviated(root))" : "Saved responses and files in \(abbreviated(root))"
    }

    nonisolated static func storedDetail(_ record: DocumentRecord) -> String {
        let kind = switch record.kind { case .response: "Response"; case .published: "Published"; case .file: "File snapshot" }
        let date = Provenance.shortDate(record.updatedAt) ?? record.updatedAt
        let size = ByteCountFormatter.string(fromByteCount: Int64(record.bytes), countStyle: .file)
        return "\(kind) · \(record.id) · revision \(record.revision) · \(size) · \(date)"
    }

    nonisolated static func recentDetail(_ recent: RecentDocument) -> String {
        let opened = recent.openedAt.formatted(date: .abbreviated, time: .shortened)
        switch recent.reference {
        case .stored(_, _, let id): return "\(id) · read \(opened)"
        case .file(let path): return "\(abbreviated(path)) · read \(opened)"
        }
    }

    nonisolated static func abbreviated(_ path: String) -> String { (path as NSString).abbreviatingWithTildeInPath }
}
