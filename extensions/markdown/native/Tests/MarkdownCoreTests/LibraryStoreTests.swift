import Testing
@testable import MarkdownCore

@Suite(.serialized) struct LibraryStoreReads {
    @Test func continuingScanReachesEveryPageWithoutDuplicates() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        for id in [docA, docB, docC] { try fixture.addRevision(id, revision: 1, source: id) }
        let scan = try CollectionScan(store: DirectoryStore(root: fixture.root), collection: .published)
        let first = scan.next(limit: 1)
        let second = scan.next(limit: 1)
        let third = scan.next(limit: 1)
        #expect(first.truncated && second.truncated && !third.truncated)
        #expect(Set((first.documents + second.documents + third.documents).map(\.id)) == Set([docA, docB, docC]))
        #expect(first.scanned + second.scanned + third.scanned == 3)
        #expect(scan.next(limit: 1).documents.isEmpty)
    }

    @Test func metadataSelectionIsSeparateFromSourceContent() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        let emoji = "👩🏽‍💻"
        let combining = "e\u{301}"
        let source = String(repeating: emoji, count: 90) + "needle" + String(repeating: combining, count: 200)
        let directory = try fixture.addRevision(docA, revision: 1, source: source)
        try fixture.addRevision(docB, revision: 1, source: "This source has no matching term.")
        let store = try DirectoryStore(root: fixture.root)
        let pointer = try store.document(docA)
        let nonmatch = try store.document(docB)
        var filter = LibraryFilter()
        filter.text = "needle"
        #expect(!filter.matches(title: pointer.title, id: pointer.id, kind: pointer.kind, source: "", updatedAt: pointer.updatedAt))
        let searched = SourceContentSearch.search(store: store, records: [pointer, nonmatch], query: "NEEDLE", limit: 2)
        #expect(searched.examined == [docA, docB] && searched.matches == [docA] && searched.issues.isEmpty)
        let excerpt = try #require(searched.excerpts[docA])
        #expect(excerpt.localizedCaseInsensitiveContains("NEEDLE"))
        #expect(excerpt.count <= 180)
        #expect(excerpt.utf8.count <= 2048)
        #expect(excerpt == String(repeating: emoji, count: 60) + "needle" + String(repeating: combining, count: 114))
        #expect(!excerpt.contains("\u{FFFD}"))
        #expect(String(data: Data(excerpt.utf8), encoding: .utf8) == excerpt)
        #expect(searched.excerpts[docB] == nil)
        #expect(Set(searched.excerpts.keys) == [docA])
        let hugeCluster = "a" + String(repeating: "\u{301}", count: 3000)
        let bounded = try #require(SourceContentSearch.excerpt(in: hugeCluster + "needle", query: "needle"))
        #expect(bounded.isEmpty)
        #expect(bounded.utf8.count <= 2048)
        #expect(bounded.count <= 180)
        try Data("changed".utf8).write(to: directory.appendingPathComponent("source.md"))
        #expect(try store.revisionMetadata(docA, revision: 1).contentOrigin?.kind == "native-response")
        let failed = SourceContentSearch.search(store: store, records: [pointer], query: "needle")
        #expect(failed.matches.isEmpty && failed.issues.count == 1)
        #expect(failed.excerpts.isEmpty)
        #expect(SourceContentSearch.search(store: store, records: [pointer], query: "needle", byteLimit: 0).examined.isEmpty)
    }

    @Test func filtersKindWorkspaceAndUTCDateWithValidation() {
        var filter = LibraryFilter()
        filter.kind = .file
        filter.source = "workspace/report"
        filter.fromDate = "2026-11-01"
        filter.throughDate = "2026-11-15"
        #expect(filter.matches(title: "report", id: docA, kind: .file, source: "/workspace/report.md", updatedAt: "2026-11-15T23:59:59Z"))
        #expect(!filter.matches(title: "report", id: docA, kind: .response, source: "/workspace/report.md", updatedAt: "2026-11-15T23:59:59Z"))
        #expect(!filter.matches(title: "report", id: docA, kind: .file, source: "/other/file.md", updatedAt: "2026-11-15T23:59:59Z"))
        #expect(!filter.matches(title: "report", id: docA, kind: .file, source: "/workspace/report.md", updatedAt: "2026-11-16T00:00:00Z"))
        filter.fromDate = "2026-02-30"
        #expect(filter.dateError != nil)
    }

    @Test func absentCollectionIsDifferentFromAnUnreadableCollection() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        let store = try DirectoryStore(root: fixture.root)
        let snapshots = fixture.root.appendingPathComponent("snapshots")
        try FileManager.default.removeItem(at: snapshots)
        let absent = try store.list(.snapshots)
        #expect(absent.absent && absent.documents.isEmpty && !absent.truncated)
        try Data().write(to: snapshots)
        #expect(throws: StoreError.self) { try store.list(.snapshots) }
    }

    @Test func inaccessibleCollectionReportsPermissionFailure() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        let path = fixture.root.appendingPathComponent("documents").path
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path) }
        #expect(throws: StoreError.self) { try DirectoryStore(root: fixture.root).list(.published) }
    }

    @Test func malformedRecordsDoNotHideUsableRowsOrClaimCompleteness() throws {
        let fixture = try FixtureStore()
        defer { fixture.remove() }
        try fixture.addRevision(docA, revision: 1, source: "good")
        try fixture.addRevision(docB, revision: 1, source: "bad")
        try Data("{}".utf8).write(to: fixture.root.appendingPathComponent("documents/\(docB)/document.json"))
        let listing = try DirectoryStore(root: fixture.root).list(.published)
        #expect(listing.documents.map(\.id) == [docA])
        #expect(listing.unreadable == 1)
        #expect(listing.issues.count == 1)
        #expect(listing.issues.first?.document == docB)
        #expect(listing.issues.first?.reason.contains("document.json") == true)
        #expect(!listing.absent && !listing.truncated && listing.scanned == 2)
    }
}
