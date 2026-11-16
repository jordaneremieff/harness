import Testing
@testable import MarkdownCore
@testable import EditorFeature

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-editor-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@Test @MainActor func recoveryRetainsEmptyDraftAndIndependentBranches() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = DraftStore(directory: root)
    let first = EditSession(drafts: store)
    #expect(await first.persist())
    let empty = try await store.load(id: first.record.id, branch: first.record.branch)
    #expect(empty.source == "")
    let other = EditSession(record: empty.resumed(), drafts: store)
    first.receive(source: "first 👨‍👩‍👧‍👦\r\n", generation: 1, selection: .init(location: 3), markedText: false)
    other.receive(source: "second 日本語", generation: 1, selection: .init(location: 2), markedText: true)
    #expect(await first.persist())
    #expect(first.recovery == .current)
    #expect(await other.persist())
    #expect(other.recovery == .current)
    #expect(try await store.load(id: first.record.id, branch: first.record.branch).source == "first 👨‍👩‍👧‍👦\r\n")
    #expect(try await store.load(id: other.record.id, branch: other.record.branch).source == "second 日本語")
}

@Test @MainActor func saveReceiptDoesNotClearLaterTypingOrConflictOnRecovery() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = DraftStore(directory: root)
    let session = EditSession(drafts: store)
    session.receive(source: "saved", generation: 1, selection: .init(), markedText: false)
    let saving = try #require(session.beginSave())
    session.receive(source: "saved + later", generation: 2, selection: .init(location: 13), markedText: false)
    session.finishSave(source: saving.source, destination: .scratchpad)
    #expect(session.isDirty)
    #expect(session.record.source == "saved + later")
    session.setConflict(.init(message: "New revision", revision: 4, digest: "sha256:abc"))
    #expect(await session.persist())
    let restored = try await store.load(id: session.record.id, branch: session.record.branch)
    #expect(restored.conflict?.revision == 4)
    #expect(restored.savedSource == "saved")
    #expect(restored.selection.location == 13)
}

@Test func recoveryRejectsLateOlderSnapshotsWithoutUsingWallClockOrder() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = DraftStore(directory: root)
    var old = DraftRecord(source: "old")
    old.updatedAt = Date.distantFuture
    var latest = old
    latest.source = "new"; latest.mutation = 1; latest.updatedAt = Date.distantPast
    try await store.save(latest)
    try await store.save(old)
    #expect(try await store.load(id: old.id, branch: old.branch).source == "new")
}

@Test @MainActor func pendingPublicationSerialisesReconciliation() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let session = EditSession(drafts: DraftStore(directory: root))
    let request = Data("immutable invocation".utf8)
    session.setPendingPublication(request)
    #expect(session.beginSave() == nil)
    #expect(session.beginReconciliation() == request)
    #expect(session.beginReconciliation() == nil)
    session.failSave("unknown")
    #expect(session.beginReconciliation() == request)
    #expect(session.record.pendingPublication == request)
}

@Test func fileSavePreservesNoOpBytesAndRefusesExternalReplacement() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("source.md")
    let original = Data([0xef, 0xbb, 0xbf]) + Data("a\r\nb\nc\r\n".utf8)
    try original.write(to: url)
    let opened = try LocalFileSave.open(url)
    let unchanged = try LocalFileSave.save(source: opened.source, base: opened.base)
    #expect(unchanged == opened.base)
    #expect(try Data(contentsOf: url) == original)
    try Data("external".utf8).write(to: url, options: .atomic)
    #expect(throws: (any Error).self) { try LocalFileSave.save(source: "mine", base: opened.base) }
    #expect(try String(contentsOf: url, encoding: .utf8) == "external")
}

@Test func emptyFileAndExclusiveSaveAreExplicit() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let target = root.appendingPathComponent("target.md")
    let base = try LocalFileSave.saveAs(source: "", url: target)
    #expect(try Data(contentsOf: target).isEmpty)
    #expect(throws: (any Error).self) { try LocalFileSave.saveAs(source: "overwrite", url: target) }
    let changed = try LocalFileSave.save(source: "a\r\nb\n", base: base)
    #expect(try String(contentsOf: target, encoding: .utf8) == "a\r\nb\n")
    #expect(changed.digest != base.digest)
}
