import Testing
@testable import MarkdownCore

@Suite(.serialized) struct LibraryStoreReads {
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
