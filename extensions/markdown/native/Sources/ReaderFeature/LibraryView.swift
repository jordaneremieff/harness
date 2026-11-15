import Foundation
import MarkdownCore
import Observation
import SwiftUI

/// Stored documents of the known store folders and recently read documents. Everything stays
/// openable after every producer has exited.
@MainActor @Observable
public final class LibraryModel {
    public struct Row: Identifiable, Hashable, Sendable {
        public var reference: DocumentReference
        public var title: String
        public var detail: String
        public var id: String { reference.key }
    }

    public struct Section: Identifiable, Sendable {
        public var id: String
        public var title: String
        public var rows: [Row]
        public var note: String?
    }

    public private(set) var sections: [Section] = []
    public private(set) var loading = false
    public var filter = ""
    @ObservationIgnored let state: ReadingStateStore
    @ObservationIgnored let extraRoots: [String]

    /// `extraRoots` are store folders the host knows about besides those seen in open requests.
    public init(state: ReadingStateStore, extraRoots: [String]) {
        self.state = state
        self.extraRoots = extraRoots
    }

    public func reload() async {
        loading = true
        var roots: [String] = []
        for root in state.knownRoots + extraRoots where !roots.contains(root) { roots.append(root) }
        let recents = state.recents
        let loaded = await Task.detached { () -> [Section] in
            var sections: [Section] = []
            let recentRows = recents.map { recent in
                Row(reference: recent.reference, title: recent.title, detail: Self.recentDetail(recent))
            }
            sections.append(Section(id: "recent", title: "Recently Read", rows: recentRows, note: recentRows.isEmpty ? "Documents you open appear here." : nil))
            for root in roots {
                do {
                    let store = try DirectoryStore(root: URL(fileURLWithPath: root))
                    for collection in StoreCollection.allCases {
                        sections.append(Self.section(store: store, root: root, collection: collection))
                    }
                } catch {
                    sections.append(Section(id: root, title: root, rows: [], note: "Store unavailable: \(error)"))
                }
            }
            return sections
        }.value
        sections = loaded
        loading = false
    }

    /// Each collection read reports its bound and omissions. An unavailable collection is not
    /// an empty collection, and usable rows survive individual malformed records.
    nonisolated static func section(store: DirectoryStore, root: String, collection: StoreCollection) -> Section {
        let title = collection == .published ? "Published in \(abbreviated(root))" : "Saved responses and files in \(abbreviated(root))"
        let listing: DocumentListing
        do { listing = try store.list(collection) }
        catch { return Section(id: "\(root)|\(collection.rawValue)", title: title, rows: [], note: "Collection unavailable: \(error)") }
        let rows = listing.documents.map { record in
            Row(
                reference: .stored(root: FileAccess.canonicalPath(root), storeId: store.storeId, document: record.id),
                title: record.title,
                detail: storedDetail(record)
            )
        }
        var notes: [String] = []
        if listing.truncated { notes.append("Newest among scanned rows. The scan stopped after \(listing.scanned) entries; other documents are not listed.") }
        if listing.unreadable > 0 { notes.append("\(listing.unreadable) document records omitted. This list is incomplete.") }
        for issue in listing.issues { notes.append("\(issue.document): \(issue.reason)") }
        if let failure = listing.failure { notes.append("Collection read failed: \(failure). This list is incomplete.") }
        if listing.absent { notes.append("This collection does not exist yet.") }
        else if rows.isEmpty && !listing.truncated && listing.unreadable == 0 && listing.failure == nil {
            notes.append(collection == .published ? "No published documents." : "No saved snapshots.")
        }
        return Section(id: "\(root)|\(collection.rawValue)", title: title, rows: rows, note: notes.isEmpty ? nil : notes.joined(separator: " "))
    }

    public func visibleRows(_ section: Section) -> [Row] {
        let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return section.rows }
        return section.rows.filter { row in
            row.title.lowercased().contains(query) || row.reference.key.lowercased().contains(query)
        }
    }

    nonisolated static func storedDetail(_ record: DocumentRecord) -> String {
        let kind = switch record.kind {
        case .response: "Response"
        case .published: "Published"
        case .file: "File snapshot"
        }
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

    nonisolated static func abbreviated(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }
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
        List(selection: $selection) {
            ForEach(model.sections) { section in
                Section(section.title) {
                    ForEach(model.visibleRows(section)) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title).lineLimit(1)
                            Text(row.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        .tag("\(section.id)|\(row.id)")
                        .accessibilityElement(children: .combine)
                        .accessibilityAction(named: "Open") { open(row.reference) }
                    }
                    if let note = section.note {
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .contextMenu(forSelectionType: String.self) { _ in
            Button("Open") { openSelected() }
        } primaryAction: { _ in
            openSelected()
        }
        .onKeyPress(.return) {
            openSelected()
            return .handled
        }
        .searchable(text: $model.filter, placement: .toolbar, prompt: "Filter by title or ID")
        .toolbar {
            ToolbarItemGroup {
                Button { Task { await model.reload() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Read the store folders again")
                Button { openFile() } label: { Label("Open File…", systemImage: "folder") }
                    .help("Open a Markdown file (⌘O)")
            }
        }
        .overlay {
            if model.loading && model.sections.isEmpty { ProgressView() }
        }
        .task { await model.reload() }
    }

    private func openSelected() {
        guard let selection else { return }
        for section in model.sections {
            if let row = section.rows.first(where: { "\(section.id)|\($0.id)" == selection }) {
                open(row.reference)
                return
            }
        }
    }
}
