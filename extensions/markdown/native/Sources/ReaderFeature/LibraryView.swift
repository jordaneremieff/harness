import Foundation
import MarkdownCore
import Observation
import SwiftUI

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
    @ObservationIgnored private var scans: [String: ScanContext] = [:]
    @ObservationIgnored let state: ReadingStateStore
    @ObservationIgnored let extraRoots: [String]

    public init(state: ReadingStateStore, extraRoots: [String]) {
        self.state = state
        self.extraRoots = extraRoots
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
        for root in state.knownRoots + extraRoots where !roots.contains(root) { roots.append(root) }
        let recents = state.recents
        let loaded = await Task.detached { () -> ([Section], [String: ScanContext]) in
            let recentRows = recents.map { Row(reference: $0.reference, title: $0.title, detail: Self.recentDetail($0)) }
            var sections = [Section(id: "recent", title: "Recently Read", rows: recentRows, note: recentRows.isEmpty ? "Documents you open appear here." : nil)]
            var scans: [String: ScanContext] = [:]
            for root in roots {
                do {
                    let store = try DirectoryStore(root: URL(fileURLWithPath: root))
                    for collection in StoreCollection.allCases {
                        let title = Self.title(root, collection)
                        do {
                            let context = ScanContext(scan: try CollectionScan(store: store, collection: collection), store: store, root: root, collection: collection)
                            let empty = Section(id: context.id, title: title, rows: [], note: nil)
                            sections.append(Self.page(context, previous: empty))
                            scans[context.id] = context
                        } catch {
                            sections.append(Section(id: "\(root)|\(collection.rawValue)", title: title, rows: [], note: "Collection unavailable: \(error)"))
                        }
                    }
                } catch {
                    sections.append(Section(id: root, title: root, rows: [], note: "Store unavailable: \(error)"))
                }
            }
            return (sections, scans)
        }.value
        sections = loaded.0
        scans = loaded.1
        clearSourceSearch()
        loading = false
    }

    public func loadMore(_ id: String) async {
        guard !loading, let context = scans[id], let previous = sections.first(where: { $0.id == id }), previous.hasMore else { return }
        loading = true
        let section = await Task.detached { Self.page(context, previous: previous) }.value
        if let index = sections.firstIndex(where: { $0.id == id }) { sections[index] = section }
        loading = false
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
        sourceSearchNote = nil
    }

    public func searchNextSources() async {
        guard !loading, !sourceQuery.isEmpty, dateError == nil else { return }
        if searchedQuery != sourceQuery { clearSourceSearch(); searchedQuery = sourceQuery }
        let candidates = sections.flatMap { section -> [(ScanContext, Row)] in
            guard let context = scans[section.id] else { return [] }
            return metadataRows(section).filter { !examined.contains($0.id) }.map { (context, $0) }
        }
        let query = sourceQuery
        loading = true
        let result = await Task.detached { () -> (Set<String>, Set<String>, Int) in
            var examined: Set<String> = [], matches: Set<String> = []
            var bytes = 0, failures = 0
            for (context, row) in candidates.prefix(20) {
                guard let record = row.record else { continue }
                let batch = SourceContentSearch.search(store: context.store, records: [record], query: query, byteLimit: 8 * 1024 * 1024 - bytes)
                guard !batch.examined.isEmpty else { break }
                examined.insert(row.id)
                if !batch.matches.isEmpty { matches.insert(row.id) }
                bytes += batch.bytes
                failures += batch.issues.count
            }
            return (examined, matches, failures)
        }.value
        examined.formUnion(result.0)
        matches.formUnion(result.1)
        sourceFailures += result.2
        sourceSearchNote = "Source search: \(examined.count) sources checked, \(matches.count) matched, \(sourceFailures) unavailable. Only checked sources under the metadata selection are covered. Read more directory entries to reach other documents."
        loading = false
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

public struct LibraryView: View {
    @Bindable var model: LibraryModel
    let open: (DocumentReference) -> Void
    let openFile: () -> Void
    @State private var selection: String?

    public init(model: LibraryModel, open: @escaping (DocumentReference) -> Void, openFile: @escaping () -> Void) {
        self.model = model
        self.open = open
        self.openFile = openFile
    }

    public var body: some View {
        VStack(spacing: 0) {
            metadataControls
            List(selection: $selection) {
                ForEach(model.sections) { section in
                    Section(section.title) {
                        ForEach(model.visibleRows(section)) { row in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title).lineLimit(1)
                                Text(row.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                if !row.source.isEmpty { Text(row.source).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
                            }
                            .tag("\(section.id)|\(row.id)")
                            .accessibilityElement(children: .combine)
                            .accessibilityAction(named: "Open") { open(row.reference) }
                        }
                        if let note = section.note { Text(note).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                        if section.hasMore {
                            Button("Read Next Documents") { Task { await model.loadMore(section.id) } }.disabled(model.loading)
                        }
                    }
                }
            }
            .contextMenu(forSelectionType: String.self) { _ in Button("Open") { openSelected() } } primaryAction: { _ in openSelected() }
            .onKeyPress(.return) { openSelected(); return .handled }
            DisclosureGroup("Source-content search (separate from metadata)") {
                HStack {
                    TextField("Literal source text", text: $model.sourceQuery)
                    Button("Search Next Sources") { Task { await model.searchNextSources() } }.disabled(model.loading || model.sourceQuery.isEmpty)
                    Button("Clear") { model.sourceQuery = ""; model.clearSourceSearch() }
                }
                if let note = model.sourceSearchNote { Text(note).font(.caption).foregroundStyle(.secondary) }
                Text("Each action checks up to 20 loaded sources and reads at most 8 MiB. It does not search unscanned documents.").font(.caption).foregroundStyle(.secondary)
            }.padding(10)
        }
        .searchable(text: $model.filter, placement: .toolbar, prompt: "Metadata: title or ID")
        .toolbar {
            ToolbarItemGroup {
                Button { Task { await model.reload() } } label: { Label("Reload", systemImage: "arrow.clockwise") }.disabled(model.loading)
                Button { openFile() } label: { Label("Open File…", systemImage: "folder") }
            }
        }
        .overlay { if model.loading && model.sections.isEmpty { ProgressView() } }
        .task { await model.reload() }
    }

    private var metadataControls: some View {
        DisclosureGroup("Metadata selection") {
            HStack {
                Picker("Kind", selection: $model.kind) {
                    Text("All").tag("all")
                    Text("Published").tag("published")
                    Text("Responses").tag("response")
                    Text("Files").tag("file")
                }
                TextField("Source or workspace", text: $model.sourceFilter)
            }
            HStack {
                TextField("From YYYY-MM-DD", text: $model.fromDate)
                TextField("Through YYYY-MM-DD", text: $model.throughDate)
            }
            if let error = model.dateError { Text(error).foregroundStyle(.red).font(.caption) }
            Text("Filters apply only to scanned metadata. Dates select the UTC update date.").font(.caption).foregroundStyle(.secondary)
        }.padding(10)
    }

    private func openSelected() {
        guard let selection else { return }
        for section in model.sections {
            if let row = model.visibleRows(section).first(where: { "\(section.id)|\($0.id)" == selection }) { open(row.reference); return }
        }
    }
}
