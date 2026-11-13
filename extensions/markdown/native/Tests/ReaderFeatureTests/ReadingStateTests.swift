import Testing
@testable import MarkdownCore
@testable import ReaderFeature

/// Intake of the reader's own state file.
@MainActor @Suite(.serialized) struct ReadingStateIntake {
    static func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("reading-state-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func reference(_ index: Int) -> DocumentReference {
        .file(path: "/notes/\(index).md")
    }

    @Test func enforcesEveryCollectionLimitWhenDecoding() throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var file = ReadingStateFile()
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        let positionCount = ReadingStateStore.positionLimit + 20
        for index in 0..<positionCount {
            let position = ReadingPosition(blockKey: "b", fraction: 0, anchor: nil, ratio: 0, revision: nil, savedAt: base.addingTimeInterval(Double(index)))
            file.positions[Self.reference(index).key] = position
        }
        file.recents = (0..<(ReadingStateStore.recentLimit + 5)).map { RecentDocument(reference: Self.reference($0), title: "\($0)", openedAt: base) }
        file.knownRoots = (0..<(ReadingStateStore.rootLimit + 5)).map { "/stores/\($0)" }
        try JSONEncoder.reading.encode(file).write(to: directory.appendingPathComponent("reading-state.json"))

        let store = ReadingStateStore(directory: directory)
        #expect(store.recents.count == ReadingStateStore.recentLimit)
        #expect(store.recents.first?.title == "0")
        #expect(store.knownRoots.count == ReadingStateStore.rootLimit)
        #expect(store.knownRoots.first == "/stores/0")
        // The newest positions stay.
        #expect(store.position(for: Self.reference(positionCount - 1)) != nil)
        #expect(store.position(for: Self.reference(19)) == nil)
        #expect(store.position(for: Self.reference(20)) != nil)
    }

    @Test func ignoresOversizedAndUndecodableFilesAndLeavesThem() throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("reading-state.json")

        var file = ReadingStateFile()
        file.knownRoots = ["/stores/a"]
        var data = try JSONEncoder.reading.encode(file)
        data.append(Data(repeating: 0x20, count: ReadingStateStore.fileLimit))
        try data.write(to: url)
        #expect(ReadingStateStore(directory: directory).knownRoots.isEmpty)
        #expect(try Data(contentsOf: url) == data)

        let garbage = Data("{\"version\":1,\"positions\":[".utf8)
        try garbage.write(to: url)
        #expect(ReadingStateStore(directory: directory).recents.isEmpty)
        #expect(try Data(contentsOf: url) == garbage)
    }

    static func position(_ block: String, at seconds: Double) -> ReadingPosition {
        ReadingPosition(blockKey: block, fraction: 0, anchor: nil, ratio: 0, revision: 1, savedAt: Date(timeIntervalSince1970: 1_800_000_000 + seconds))
    }

    /// Two reader processes that loaded the file before either saved: each save keeps the
    /// other's progress, and the newer position of one document wins.
    @Test func savesFromSeveralReadersKeepEachOthersPositions() throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        first.setPosition(Self.position("a", at: 10), for: Self.reference(1))
        first.setPosition(Self.position("old", at: 10), for: Self.reference(3))
        second.setPosition(Self.position("b", at: 20), for: Self.reference(2))
        second.setPosition(Self.position("new", at: 30), for: Self.reference(3))
        second.saveNow()
        first.saveNow()

        let later = ReadingStateStore(directory: directory)
        #expect(later.position(for: Self.reference(1))?.blockKey == "a")
        #expect(later.position(for: Self.reference(2))?.blockKey == "b")
        #expect(later.position(for: Self.reference(3))?.blockKey == "new")
    }

    /// An opening reads positions that another reader saved after this one started.
    @Test func reloadTakesInPositionsSavedElsewhere() throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let reader = ReadingStateStore(directory: directory)
        let other = ReadingStateStore(directory: directory)
        other.setPosition(Self.position("elsewhere", at: 5), for: Self.reference(1))
        other.saveNow()
        #expect(reader.position(for: Self.reference(1)) == nil)
        reader.reload()
        #expect(reader.position(for: Self.reference(1))?.blockKey == "elsewhere")
    }

    /// A forgotten recent stays forgotten although another reader's file still lists it; settings
    /// follow the file unless this reader changed them.
    @Test func mergeKeepsForgottenRecentsAndUnchangedSettings() {
        var ours = ReadingStateFile()
        var theirs = ReadingStateFile()
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        theirs.recents = [RecentDocument(reference: Self.reference(1), title: "one", openedAt: base), RecentDocument(reference: Self.reference(2), title: "two", openedAt: base.addingTimeInterval(1))]
        ours.recents = [RecentDocument(reference: Self.reference(3), title: "three", openedAt: base.addingTimeInterval(2))]
        theirs.settings = PageSettings(textSize: 7)
        ours.settings = PageSettings(textSize: 2)

        let changes = ReadingStateStore.Changes(recents: [Self.reference(3).key], forgotten: [Self.reference(1).key])
        let merged = ReadingStateStore.merged(ours: ours, theirs: theirs, changes: changes)
        #expect(merged.recents.map(\.title) == ["three", "two"])
        #expect(merged.settings.textSize == 7)
        #expect(ReadingStateStore.merged(ours: ours, theirs: theirs, changes: ReadingStateStore.Changes(settings: true)).settings.textSize == 2)
    }

    /// A position that this reader saved earlier never replaces a newer one that another reader
    /// saved within the same second, although the file keeps whole seconds only.
    @Test func anEarlierSaveNeverReplacesAnotherReadersNewerPosition() throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        first.setPosition(Self.position("older", at: 0.1), for: Self.reference(1))
        first.saveNow()
        second.setPosition(Self.position("newer", at: 0.8), for: Self.reference(1))
        second.saveNow()
        first.setPosition(Self.position("other", at: 0.9), for: Self.reference(2))
        first.saveNow()

        let later = ReadingStateStore(directory: directory)
        #expect(later.position(for: Self.reference(1))?.blockKey == "newer")
        #expect(later.position(for: Self.reference(2))?.blockKey == "other")
    }
}
