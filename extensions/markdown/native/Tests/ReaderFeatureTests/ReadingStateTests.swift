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
}
