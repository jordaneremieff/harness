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

    @Test func textSizeMultipliersRoundTripWithoutChangingStoredIndices() throws {
        for (index, pixels) in PageSettings.textSizes.enumerated() {
            let settings = PageSettings(textSize: index)
            #expect(settings.textSizeMultiplier == Double(pixels) / 16)
            #expect(PageSettings.textSizeMultipliers[index] == settings.textSizeMultiplier)
            #expect(PageSettings.nearestTextSize(to: settings.textSizeMultiplier) == index)
            let stored = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any]
            #expect(stored?["textSize"] as? Int == index)
        }
        #expect(PageSettings.nearestTextSize(to: 1) == 3)
        #expect(PageSettings.nearestTextSize(to: 1.11) == 5)
        let midpoint = (PageSettings.textSizeMultipliers[0] + PageSettings.textSizeMultipliers[1]) / 2
        #expect(PageSettings.nearestTextSize(to: midpoint) == 0)
        #expect(PageSettings.nearestTextSize(to: 0) == 0)
        #expect(PageSettings.nearestTextSize(to: .greatestFiniteMagnitude) == PageSettings.textSizes.count - 1)
        #expect(PageSettings.nearestTextSize(to: .nan) == PageSettings.defaultTextSize)
    }

    @Test func draftLocksDefaultToWritingAndMergeByDraftIdentity() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let firstId = UUID().uuidString, secondId = UUID().uuidString
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        #expect(first.draftLock(for: firstId) == .writing)
        first.setDraftLock(.reading, for: firstId)
        second.setDraftLock(.writing, for: secondId)
        #expect(await first.flush(timeout: 2) == .saved)
        #expect(await second.flush(timeout: 2) == .saved)
        let reopened = ReadingStateStore(directory: directory)
        #expect(reopened.draftLock(for: firstId) == .reading)
        #expect(reopened.draftLock(for: secondId) == .writing)
    }

    @Test func presentationSettingsSurvivePositionSaves() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        first.setPresentation(appearance: "dark", outlineWidth: 310, outlineOpen: false)
        #expect(await first.flush(timeout: 2) == .saved)
        second.setPosition(Self.position("block", at: 2), for: Self.reference(1))
        #expect(await second.flush(timeout: 2) == .saved)
        let reopened = ReadingStateStore(directory: directory)
        #expect(reopened.appearance == "dark")
        #expect(reopened.outlineWidth == 310)
        #expect(!reopened.outlineOpen)
    }

    @Test func selectionSurvivesAnotherReadersPositionSave() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        first.selectStore(root: "/stores/selected")
        #expect(first.recents.isEmpty)
        #expect(await first.flush(timeout: 2) == .saved)
        second.setPosition(Self.position("elsewhere", at: 2), for: Self.reference(1))
        #expect(await second.flush(timeout: 2) == .saved)
        let later = ReadingStateStore(directory: directory)
        #expect(later.selectedStoreRoot == "/stores/selected")
        #expect(later.knownRoots.first == "/stores/selected")
        #expect(later.position(for: Self.reference(1))?.blockKey == "elsewhere")
        second.reload()
        #expect(second.selectedStoreRoot == "/stores/selected")
    }

    @Test func anUnsavedExplicitSelectionSurvivesReload() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        first.selectStore(root: "/stores/first")
        second.selectStore(root: "/stores/second")
        #expect(await second.flush(timeout: 2) == .saved)
        first.reload()
        #expect(first.selectedStoreRoot == "/stores/first")
        #expect(await first.flush(timeout: 2) == .saved)
        #expect(ReadingStateStore(directory: directory).selectedStoreRoot == "/stores/first")
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

    @Test func longAnchorsSaveAndReopenWithinTheByteLimit() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ReadingStateStore(directory: directory)
        let anchor = String(repeating: "a", count: 2300)
        for index in 0..<ReadingStateStore.positionLimit {
            var position = Self.position("block", at: Double(index))
            position.anchor = anchor
            position.ratio = 0.5
            store.setPosition(position, for: Self.reference(index))
        }
        #expect(await store.flush(timeout: 10) == .saved)
        let data = try Data(contentsOf: directory.appendingPathComponent("reading-state.json"))
        #expect(data.count <= ReadingStateStore.fileLimit)
        let reopened = ReadingStateStore(directory: directory)
        for index in 0..<ReadingStateStore.positionLimit {
            #expect(reopened.position(for: Self.reference(index))?.blockKey == "block")
            #expect(reopened.position(for: Self.reference(index))?.ratio == 0.5)
        }
        #expect(reopened.position(for: Self.reference(0))?.anchor == nil)
        #expect(reopened.lastRecovery == nil)
    }

    @Test func theByteBudgetKeepsTheNewestRecentsThatFit() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ReadingStateStore(directory: directory)
        for index in 0..<ReadingStateStore.recentLimit {
            store.noteOpened(Self.reference(index), title: "\(index) " + String(repeating: "q", count: 40_000))
        }
        #expect(await store.flush(timeout: 10) == .saved)
        let url = directory.appendingPathComponent("reading-state.json")
        #expect(try Data(contentsOf: url).count <= ReadingStateStore.fileLimit)
        let reopened = ReadingStateStore(directory: directory)
        #expect(!reopened.recents.isEmpty)
        #expect(reopened.recents.count < ReadingStateStore.recentLimit)
        #expect(reopened.recents.first?.reference == Self.reference(ReadingStateStore.recentLimit - 1))
        #expect(reopened.recents.last?.reference != Self.reference(0))
    }

    @Test func oversizedCacheEntriesNeverMakeTheSavedStateUnreadable() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ReadingStateStore(directory: directory)
        let oversized = String(repeating: "x", count: ReadingStateStore.fileLimit + 1)
        store.noteOpened(Self.reference(1), title: "Kept")
        store.noteOpened(Self.reference(2), title: oversized)
        store.selectStore(root: "/stores/kept")
        store.selectStore(root: oversized)
        store.setPosition(Self.position("kept", at: 2), for: Self.reference(1))
        store.setPosition(Self.position("too large", at: 1), for: .file(path: oversized))
        #expect(await store.flush(timeout: 10) == .saved)
        let url = directory.appendingPathComponent("reading-state.json")
        #expect(try Data(contentsOf: url).count <= ReadingStateStore.fileLimit)
        let reopened = ReadingStateStore(directory: directory)
        #expect(reopened.position(for: Self.reference(1))?.blockKey == "kept")
        #expect(reopened.position(for: .file(path: oversized)) == nil)
        #expect(reopened.recents.map(\.title) == ["Kept"])
        #expect(reopened.knownRoots == ["/stores/kept"])
        #expect(reopened.selectedStoreRoot == nil)
    }

    static func position(_ block: String, at seconds: Double) -> ReadingPosition {
        ReadingPosition(blockKey: block, fraction: 0, anchor: nil, ratio: 0, revision: 1, savedAt: Date(timeIntervalSince1970: 1_800_000_000 + seconds))
    }

    /// Two reader processes that loaded the file before either saved: each save keeps the
    /// other's progress, and the newer position of one document wins.
    @Test func savesFromSeveralReadersKeepEachOthersPositions() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        first.setPosition(Self.position("a", at: 10), for: Self.reference(1))
        first.setPosition(Self.position("old", at: 10), for: Self.reference(3))
        second.setPosition(Self.position("b", at: 20), for: Self.reference(2))
        second.setPosition(Self.position("new", at: 30), for: Self.reference(3))
        #expect(await second.flush(timeout: 2) == .saved)
        #expect(await first.flush(timeout: 2) == .saved)

        let later = ReadingStateStore(directory: directory)
        #expect(later.position(for: Self.reference(1))?.blockKey == "a")
        #expect(later.position(for: Self.reference(2))?.blockKey == "b")
        #expect(later.position(for: Self.reference(3))?.blockKey == "new")
    }

    /// An opening reads positions that another reader saved after this one started.
    @Test func reloadTakesInPositionsSavedElsewhere() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let reader = ReadingStateStore(directory: directory)
        let other = ReadingStateStore(directory: directory)
        other.setPosition(Self.position("elsewhere", at: 5), for: Self.reference(1))
        #expect(await other.flush(timeout: 2) == .saved)
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
    /// saved within the same second.
    @Test func anEarlierSaveNeverReplacesAnotherReadersNewerPosition() async throws {
        let directory = try Self.directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = ReadingStateStore(directory: directory)
        let second = ReadingStateStore(directory: directory)
        first.setPosition(Self.position("older", at: 0.1), for: Self.reference(1))
        #expect(await first.flush(timeout: 2) == .saved)
        second.setPosition(Self.position("newer", at: 0.8), for: Self.reference(1))
        #expect(await second.flush(timeout: 2) == .saved)
        first.setPosition(Self.position("other", at: 0.9), for: Self.reference(2))
        #expect(await first.flush(timeout: 2) == .saved)

        let later = ReadingStateStore(directory: directory)
        #expect(later.position(for: Self.reference(1))?.blockKey == "newer")
        #expect(later.position(for: Self.reference(2))?.blockKey == "other")
    }
}

/// A reading place carried into the text of another revision.
@Suite struct ReadingPositionCarry {
    static func offset(_ text: String, of part: String) -> Int { (text as NSString).range(of: part).location }

    @Test func placeAfterTheChangeFollowsItsText() {
        let old = "# Title\n\n👩🏽‍💻 First paragraph.\n\n## Section\n\nLast paragraph.\n"
        let new = "# Title\n\nAn inserted paragraph.\n\n👩🏽‍💻 First paragraph, changed.\n\n## Section\n\nLast paragraph.\n"
        let moved = ReadingPosition(blockStart: Self.offset(old, of: "## Section"), offsetY: 36, revision: 1).carried(from: old, to: new)
        #expect(moved.blockStart == Self.offset(new, of: "## Section"))
        #expect(moved.offsetY == 36)
        #expect(moved.revision == 1)
    }

    @Test func placeBeforeTheChangeStaysAndPlaceInsideGoesToItsStart() {
        let old = "# Title\n\nFirst paragraph.\n\n## Section\n"
        let new = "# Title\n\nAn inserted paragraph.\n\nFirst paragraph, changed.\n\n## Section\n"
        #expect(ReadingPosition(blockStart: 0, offsetY: 4, revision: 1).carried(from: old, to: new).blockStart == 0)
        let inside = ReadingPosition(blockStart: Self.offset(old, of: "paragraph."), offsetY: 0, revision: 1).carried(from: old, to: new)
        #expect(inside.blockStart == Self.offset(old, of: "First"))
        let same = ReadingPosition(blockStart: 12, offsetY: 0, revision: 1)
        #expect(same.carried(from: old, to: old) == same)
    }
}
