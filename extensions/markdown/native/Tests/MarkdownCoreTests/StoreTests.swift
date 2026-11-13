import CryptoKit
import Testing
@testable import MarkdownCore

/// A store written exactly in the version-1 layout, as the TypeScript writer produces it.
struct FixtureStore {
    let root: URL
    let storeId = "0123456789abcdef0123456789abcdef"

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-core-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("documents"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("snapshots"), withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent(".lock"))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("opens"), withIntermediateDirectories: true)
        try write(["version": 1, "storeId": storeId], to: root.appendingPathComponent("store.json"))
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }

    func write(_ object: Any, to url: URL) throws {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: url)
    }

    static func digest(_ data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Writes revision `revision` of `id` and, unless `publish` is false, moves the pointer to it.
    @discardableResult
    func addRevision(_ id: String, revision: Int, source: String, kind: String = "published", collection: String? = nil, references: Any? = nil, publish: Bool = true, assets: [String: Data] = [:]) throws -> URL {
        let documentDir = root.appendingPathComponent("\(collection ?? (kind == "published" ? "documents" : "snapshots"))/\(id)")
        let revisionDir = documentDir.appendingPathComponent("revisions/\(revision)")
        try FileManager.default.createDirectory(at: revisionDir.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let data = Data(source.utf8)
        try data.write(to: revisionDir.appendingPathComponent("source.md"))
        for (name, bytes) in assets { try bytes.write(to: revisionDir.appendingPathComponent("assets/\(name)")) }
        var record: [String: Any] = [
            "version": 1, "document": id, "revision": revision, "title": "Doc \(revision)",
            "createdAt": "2026-11-13T10:00:00.000Z", "digest": Self.digest(data), "bytes": data.count,
            "publication": "pub-\(revision)",
            "completeness": ["state": "partial", "reason": "length"],
            "contentOrigin": ["kind": "native-response", "host": "native", "conversation": "c1", "entry": "42", "model": "p/m", "capturedAt": "2026-11-13T10:00:00.000Z", "parts": [["chars": 3]]],
        ]
        if let references { record["references"] = references }
        try write(record, to: revisionDir.appendingPathComponent("revision.json"))
        if publish {
            try write([
                "version": 1, "id": id, "kind": kind, "title": "Doc \(revision)", "createdAt": "2026-11-13T10:00:00.000Z",
                "updatedAt": "2026-11-13T10:0\(revision):00.000Z", "revision": revision, "digest": Self.digest(data), "bytes": data.count,
            ], to: documentDir.appendingPathComponent("document.json"))
        }
        return revisionDir
    }

    func request(_ id: String, revision: Int, digest: String, storeId: String? = nil, origin: Any? = NSNull()) throws -> URL {
        let url = root.appendingPathComponent("opens/\(UUID().uuidString).json")
        try write([
            "version": 1, "storeId": storeId ?? self.storeId, "document": id, "revision": revision, "digest": digest,
            "requestedAt": "2026-11-13T10:00:00.000Z", "launchOrigin": origin ?? NSNull(),
        ], to: url)
        return url
    }
}

let docA = "md-0123456789abcdef0123"
let docB = "md-fedcba9876543210fedc"
let docC = "md-00000000001111111111"

@Suite(.serialized) struct StoreReading {
    @Test func readsPointerRevisionsAndIgnoresOrphans() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: "# One\n")
        try store.addRevision(docA, revision: 2, source: "# Two\n")
        try store.addRevision(docA, revision: 3, source: "# Orphan\n", publish: false)
        try FileManager.default.createDirectory(at: store.root.appendingPathComponent("documents/\(docA)/revisions/.tmp-x"), withIntermediateDirectories: true)
        let reader = try DirectoryStore(root: store.root)
        #expect(reader.storeId == store.storeId)
        let latest = try reader.loadRevision(docA)
        #expect(latest.record.revision == 2)
        #expect(latest.source == "# Two\n")
        #expect(latest.revisions == [1, 2])
        #expect(latest.record.completeness == Completeness(state: .partial, reason: "length"))
        #expect(latest.record.contentOrigin?.model == "p/m")
        #expect(try reader.loadRevision(docA, revision: 1).source == "# One\n")
        #expect(throws: StoreError.notFound("\(docA) revision 3")) { try reader.loadRevision(docA, revision: 3) }
    }

    @Test func refusesTamperedSourceAndBadIdentifiers() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        let dir = try store.addRevision(docA, revision: 1, source: "original")
        try Data("changed!".utf8).write(to: dir.appendingPathComponent("source.md"))
        let reader = try DirectoryStore(root: store.root)
        #expect(throws: StoreError.digestMismatch) { try reader.loadRevision(docA) }
        #expect(throws: StoreError.invalidIdentifier("../x")) { try reader.loadRevision("../x") }
        #expect(throws: StoreError.invalidIdentifier("md-ABCDEF0123456789abcd")) { try reader.document("md-ABCDEF0123456789abcd") }
    }

    @Test func refusesOtherVersionsAndNonStores() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.write(["version": 2, "storeId": store.storeId], to: store.root.appendingPathComponent("store.json"))
        #expect(throws: StoreError.incompatibleVersion(2)) { try DirectoryStore(root: store.root) }
        #expect(throws: StoreError.notAStore) { try DirectoryStore(root: store.root.appendingPathComponent("documents")) }
    }

    @Test func listsEachCollectionNewestFirst() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: "a")
        try store.addRevision(docB, revision: 2, source: "b")
        try store.addRevision(docC, revision: 1, source: "c", kind: "response")
        try FileManager.default.createDirectory(at: store.root.appendingPathComponent("documents/.tmp-abc"), withIntermediateDirectories: true)
        let reader = try DirectoryStore(root: store.root)
        let published = try reader.list(.published)
        #expect(published.documents.map(\.id) == [docB, docA])
        #expect(!published.truncated)
        #expect(try reader.list(.snapshots).documents.map(\.id) == [docC])
    }

    @Test func resolvesSnapshotsAndRefusesKindOutsideItsCollection() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docC, revision: 1, source: "snapshot", kind: "response")
        try store.addRevision(docA, revision: 1, source: "misplaced", kind: "file", collection: "documents")
        let reader = try DirectoryStore(root: store.root)
        #expect(try reader.loadRevision(docC).source == "snapshot")
        #expect(try reader.document(docC).kind == .response)
        #expect(throws: StoreError.self) { try reader.loadRevision(docA) }
        #expect(throws: StoreError.notFound(docB)) { try reader.document(docB) }
    }

    @Test func offersTheNewestRevisionsFromThePointer() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        let pointer = Limits.revisionChoices + 5
        for revision in 1...pointer { try store.addRevision(docA, revision: revision, source: "r\(revision)") }
        try store.addRevision(docA, revision: pointer + 1, source: "orphan", publish: false)
        let loaded = try DirectoryStore(root: store.root).loadRevision(docA)
        #expect(loaded.revisions == Array(6...pointer))
        #expect(loaded.olderRevisionsUnlisted)
        let few = try FixtureStore()
        defer { few.remove() }
        try few.addRevision(docB, revision: 1, source: "one")
        #expect(try DirectoryStore(root: few.root).loadRevision(docB).olderRevisionsUnlisted == false)
    }

    @Test func listingStopsItsDirectoryReadAtTheBound() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        for id in [docA, docB, docC] { try store.addRevision(id, revision: 1, source: id) }
        let reader = try DirectoryStore(root: store.root)
        let bounded = try reader.list(.published, scanLimit: 2)
        #expect(bounded.truncated)
        #expect(bounded.documents.count == 2)
        let complete = try reader.list(.published, scanLimit: 3)
        #expect(!complete.truncated)
        #expect(complete.documents.count == 3)
    }

    @Test func refusesSymlinkedSourceAndDirectories() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-core-outside-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }

        // source.md replaced by a link to a file outside the store with the same bytes.
        let dir = try store.addRevision(docA, revision: 1, source: "secret")
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secret.md"))
        try FileManager.default.removeItem(at: dir.appendingPathComponent("source.md"))
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("source.md"), withDestinationURL: outside.appendingPathComponent("secret.md"))
        let reader = try DirectoryStore(root: store.root)
        #expect(throws: StoreError.unreadable("source.md is a symbolic link")) { try reader.loadRevision(docA) }

        // A revision directory and a document directory reached through a link.
        let revisionDir = try store.addRevision(docB, revision: 1, source: "b")
        try FileManager.default.moveItem(at: revisionDir, to: outside.appendingPathComponent("revision"))
        try FileManager.default.createSymbolicLink(at: revisionDir, withDestinationURL: outside.appendingPathComponent("revision"))
        #expect(throws: StoreError.outsideStore) { try reader.loadRevision(docB) }
        let documentDir = try store.addRevision(docC, revision: 1, source: "c").deletingLastPathComponent().deletingLastPathComponent()
        try FileManager.default.moveItem(at: documentDir, to: outside.appendingPathComponent("document"))
        try FileManager.default.createSymbolicLink(at: documentDir, withDestinationURL: outside.appendingPathComponent("document"))
        #expect(throws: StoreError.outsideStore) { try reader.loadRevision(docC) }
    }

    @Test func pinnedDigestRefusesAReplacedRevision() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: "one")
        try store.addRevision(docA, revision: 2, source: "two")
        let pinned = FixtureStore.digest(Data("one".utf8))
        let reference = DocumentReference.stored(root: FileAccess.canonicalPath(store.root.path), storeId: store.storeId, document: docA)
        #expect(try DocumentLoader.load(reference, revision: 1, pinnedDigest: pinned).source == "one")
        // Revision 1 rewritten consistently after acceptance: the store accepts it, the pin does not.
        try store.addRevision(docA, revision: 1, source: "replaced", publish: false)
        #expect(try DocumentLoader.load(reference, revision: 1).source == "replaced")
        #expect(throws: StoreError.pinnedDigestMismatch(1)) { try DocumentLoader.load(reference, revision: 1, pinnedDigest: pinned) }
    }

    @Test func refusesSourceAboveTheLimit() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: String(repeating: "x", count: Limits.sourceBytes + 1))
        #expect(throws: StoreError.tooLarge(Limits.sourceBytes + 1)) { try DirectoryStore(root: store.root).loadRevision(docA) }
    }
}

@Suite(.serialized) struct OpenRequests {
    @Test func acceptsPinnedRevisionAndRemovesRequest() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: "one")
        try store.addRevision(docA, revision: 2, source: "two")
        let origin: [String: Any] = ["version": 1, "terminal": "Rex", "application": ["bundleId": "com.superlogical.rex"], "exact": ["session": "s"]]
        let file = try store.request(docA, revision: 1, digest: FixtureStore.digest(Data("one".utf8)), origin: origin)
        let target = try OpenIntake.classify(file)
        guard case .stored(let reader, let request, let requestFile) = target else {
            Issue.record("expected a stored target")
            return
        }
        #expect(request.revision == 1)
        #expect(request.launchOrigin?.terminal == "Rex")
        #expect(request.launchOrigin?.isUsable == true)
        let loaded = try OpenIntake.accept(reader, request, requestFile: requestFile)
        #expect(loaded.source == "one")
        #expect(loaded.document.revision == 2)
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func leavesInvalidRequestsInPlace() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: "one")
        let wrongStore = try store.request(docA, revision: 1, digest: FixtureStore.digest(Data("one".utf8)), storeId: String(repeating: "f", count: 32))
        #expect(throws: OpenIntakeError.self) { try OpenIntake.classify(wrongStore) }
        let wrongDigest = try store.request(docA, revision: 1, digest: "sha256:00")
        guard case .stored(let reader, let request, let file) = try OpenIntake.classify(wrongDigest) else {
            Issue.record("expected a stored target")
            return
        }
        #expect(throws: OpenIntakeError.self) { try OpenIntake.accept(reader, request, requestFile: file) }
        #expect(FileManager.default.fileExists(atPath: wrongStore.path))
        #expect(FileManager.default.fileExists(atPath: wrongDigest.path))
    }

    @Test func leavesAReplacedRequestInPlace() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: "one")
        let file = try store.request(docA, revision: 1, digest: FixtureStore.digest(Data("one".utf8)))
        guard case .stored(let reader, let request, let requestFile) = try OpenIntake.classify(file) else {
            Issue.record("expected a stored target")
            return
        }
        // Replaced by a directory that holds an unrelated file.
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        let unrelated = file.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: unrelated)
        #expect(throws: OpenIntakeError.requestReplaced) { try OpenIntake.accept(reader, request, requestFile: requestFile) }
        #expect(FileManager.default.fileExists(atPath: unrelated.path))

        // Replaced by another regular file with the same content.
        try FileManager.default.removeItem(at: file)
        let again = try store.request(docA, revision: 1, digest: request.digest)
        try FileManager.default.moveItem(at: again, to: file)
        #expect(throws: OpenIntakeError.requestReplaced) { try OpenIntake.accept(reader, request, requestFile: requestFile) }
        #expect(FileManager.default.fileExists(atPath: file.path))
    }

    @Test func dropsUnusableOriginsAndRejectsRequestsOutsideOpens() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        try store.addRevision(docA, revision: 1, source: "one")
        let origin: [String: Any] = ["version": 1, "terminal": "Rex", "application": ["bundleId": "/usr/bin/evil; rm"]]
        let file = try store.request(docA, revision: 1, digest: FixtureStore.digest(Data("one".utf8)), origin: origin)
        guard case .stored(_, let request, _) = try OpenIntake.classify(file) else {
            Issue.record("expected a stored target")
            return
        }
        #expect(request.launchOrigin == nil)
        let outside = store.root.appendingPathComponent("request.json")
        try FileManager.default.copyItem(at: file, to: outside)
        #expect(throws: OpenIntakeError.notAnOpenRequest) { try OpenIntake.classify(outside) }
        guard case .plainFile = try OpenIntake.classify(URL(fileURLWithPath: "/tmp/notes.md")) else {
            Issue.record("expected a plain file")
            return
        }
        #expect(throws: OpenIntakeError.unsupportedFile("tool.sh")) { try OpenIntake.classify(URL(fileURLWithPath: "/tmp/tool.sh")) }
    }

    @Test func opensThePlainFileThatASymbolicLinkNames() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        let real = store.root.appendingPathComponent("real.md")
        try Data("# Linked\n".utf8).write(to: real)
        let link = store.root.appendingPathComponent("link.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        let target = try OpenIntake.classify(link)
        guard case .plainFile(let url) = target else {
            Issue.record("expected a plain file")
            return
        }
        #expect(url.path == FileAccess.canonicalPath(real.path))
        #expect(try DocumentLoader.load(target.reference).source == "# Linked\n")
    }
}

@Suite(.serialized) struct AssetContainment {
    static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    static let hash = String(repeating: "a", count: 64)

    @Test func storedResolverServesOnlyRetainedFilesInsideTheRevision() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        let outsideFile = store.root.appendingPathComponent("secret.png")
        try Self.png.write(to: outsideFile)
        let linkHash = String(repeating: "b", count: 64)
        let references: [String: Any] = [
            "state": "inspected", "omitted": 0, "truncated": false,
            "items": [
                ["kind": "image", "reference": "img/a.png", "state": "retained", "file": "assets/\(Self.hash).png", "mediaType": "image/png", "bytes": 8, "digest": "sha256:x"],
                ["kind": "image", "reference": "img/link.png", "state": "retained", "file": "assets/\(linkHash).png"],
                ["kind": "image", "reference": "img/up.png", "state": "retained", "file": "assets/../../../secret.png"],
                ["kind": "image", "reference": "../s.png", "state": "unavailable", "reason": "outside-root"],
                ["kind": "link", "reference": "docs/x.md", "state": "local-only"],
            ],
        ]
        let dir = try store.addRevision(docA, revision: 1, source: "x", kind: "file", references: references, assets: ["\(Self.hash).png": Self.png])
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("assets/\(linkHash).png"), withDestinationURL: outsideFile)
        let loaded = try DirectoryStore(root: store.root).loadRevision(docA)
        let resolver = StoredAssetResolver(revisionDirectory: loaded.directory, references: loaded.record.references, kind: .file)
        guard case .local(let asset) = resolver.resolve("img/a.png") else {
            Issue.record("expected a retained asset")
            return
        }
        #expect(try asset.readData() == Self.png)
        #expect(resolver.resolve("img/link.png") == .unavailable(reason: "outside-root"))
        #expect(resolver.resolve("img/up.png") == .unavailable(reason: "invalid"))
        #expect(resolver.resolve("../s.png") == .unavailable(reason: "outside-root"))
        #expect(resolver.resolve("img/other.png") == .unavailable(reason: "not-captured"))
        #expect(resolver.resolve("https://e.com/a.png") == .external(URL(string: "https://e.com/a.png")!))
        #expect(resolver.resolve("javascript:alert(1)") == .unavailable(reason: "unsupported-scheme"))

        // A file replaced by a symlink after resolution is refused when read.
        let retained = dir.appendingPathComponent("assets/\(Self.hash).png")
        try FileManager.default.removeItem(at: retained)
        try FileManager.default.createSymbolicLink(at: retained, withDestinationURL: outsideFile)
        #expect(throws: StoreError.self) { try asset.readData() }
    }

    @Test func symlinkedAssetsDirectoryServesNothing() throws {
        let store = try FixtureStore()
        defer { store.remove() }
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-core-assets-out-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }
        try Self.png.write(to: outside.appendingPathComponent("\(Self.hash).png"))
        let references: [String: Any] = ["state": "inspected", "omitted": 0, "items": [
            ["kind": "image", "reference": "a.png", "state": "retained", "file": "assets/\(Self.hash).png"],
        ]]
        let dir = try store.addRevision(docA, revision: 1, source: "![a](a.png)", kind: "file", references: references)
        try FileManager.default.removeItem(at: dir.appendingPathComponent("assets"))
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("assets"), withDestinationURL: outside)
        let snapshot = try DocumentLoader.load(.stored(root: FileAccess.canonicalPath(store.root.path), storeId: store.storeId, document: docA))
        #expect(snapshot.resolver.resolve("a.png") == .unavailable(reason: "outside-root"))
        let rendered = MarkdownRenderer.render(snapshot.source, resolver: snapshot.resolver, nonce: "n")
        #expect(rendered.assets.isEmpty)
    }

    @Test func directoryResolverChecksTraversalSymlinksTypesAndSize() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-core-assets-\(UUID().uuidString)")
        let root = base.appendingPathComponent("doc")
        defer { try? FileManager.default.removeItem(at: base) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("img"), withIntermediateDirectories: true)
        try Self.png.write(to: root.appendingPathComponent("img/ok image.png"))
        try Self.png.write(to: base.appendingPathComponent("outside.png"))
        try Data("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>".utf8).write(to: root.appendingPathComponent("img/hostile.svg"))
        try Data("#!/bin/sh".utf8).write(to: root.appendingPathComponent("img/run.sh"))
        try Data(count: Limits.assetBytes + 1).write(to: root.appendingPathComponent("img/huge.png"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("img/escape.png"), withDestinationURL: base.appendingPathComponent("outside.png"))
        let resolver = DirectoryAssetResolver(directory: root)
        guard case .local(let asset) = resolver.resolve("img/ok%20image.png?x=1#y") else {
            Issue.record("expected a local asset")
            return
        }
        #expect(asset.mediaType == "image/png")
        guard case .local(let svg) = resolver.resolve("img/hostile.svg") else {
            Issue.record("expected the svg to resolve as an image")
            return
        }
        #expect(svg.mediaType == "image/svg+xml")
        #expect(resolver.resolve("../outside.png") == .unavailable(reason: "outside-root"))
        #expect(resolver.resolve("img/../../outside.png") == .unavailable(reason: "outside-root"))
        #expect(resolver.resolve("img/escape.png") == .unavailable(reason: "outside-root"))
        #expect(resolver.resolve(base.appendingPathComponent("outside.png").path) == .unavailable(reason: "outside-root"))
        #expect(resolver.resolve("img/run.sh") == .unavailable(reason: "unsupported-type"))
        #expect(resolver.resolve("img/huge.png") == .unavailable(reason: "too-large"))
        #expect(resolver.resolve("img/missing.png") == .unavailable(reason: "missing"))
        #expect(resolver.resolve("file:///etc/passwd") == .unavailable(reason: "unsupported-scheme"))
        #expect(resolver.resolve("img/%E0%A4%A.png") == .unavailable(reason: "invalid"))
    }

    @Test func renderedImagesUseTokensNotPaths() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("markdown-core-render-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        try Self.png.write(to: base.appendingPathComponent("a.png"))
        let rendered = MarkdownRenderer.render("![alt](a.png) ![again](a.png) ![no](../x.png)", resolver: DirectoryAssetResolver(directory: base), nonce: "n")
        #expect(rendered.body.contains("<img src=\"reader-asset://doc/a0\" alt=\"alt\""))
        #expect(rendered.body.contains("reader-asset://doc/a1"))
        #expect(!rendered.body.contains(base.path))
        #expect(rendered.assets.count == 2)
        #expect(rendered.unavailableImages.map(\.reason) == ["outside-root"])
    }
}
