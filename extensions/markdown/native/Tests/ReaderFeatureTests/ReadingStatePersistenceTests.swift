import Darwin
import Testing
@testable import MarkdownCore
@testable import ReaderFeature

/// A writer gate leaves the main actor free and releases every blocked write during cleanup.
final class StateWriteGate: @unchecked Sendable {
    let entries: AsyncStream<Void>
    private let entered: AsyncStream<Void>.Continuation
    private let condition = NSCondition()
    private var released = false

    init() {
        (entries, entered) = AsyncStream.makeStream()
    }

    func wait() {
        condition.lock()
        defer { condition.unlock() }
        entered.yield(())
        while !released { condition.wait() }
    }

    func release() {
        condition.lock()
        released = true
        condition.broadcast()
        condition.unlock()
    }
}

private final class StateWriteSequence: @unchecked Sendable {
    let gates = [StateWriteGate(), StateWriteGate()]
    private let lock = NSLock()
    private var next = 0

    func wait() {
        let index = lock.withLock {
            let index = next
            next += 1
            return index
        }
        if gates.indices.contains(index) { gates[index].wait() }
    }
}

@MainActor @Suite(.serialized) struct ReadingStatePersistence {
    private func directory() throws -> URL { try ReadingStateIntake.directory() }
    private func reference(_ index: Int) -> DocumentReference { ReadingStateIntake.reference(index) }
    private func position(_ block: String, at seconds: Double = 0.123456) -> ReadingPosition {
        ReadingStateIntake.position(block, at: seconds)
    }

    private func expectNotSaved(_ result: ReadingStateFlushResult) {
        guard case .notSaved(let reason) = result else {
            Issue.record("Expected a not-saved result, got \(result)")
            return
        }
        #expect(!reason.isEmpty)
    }

    @Test func lockHeldByAnotherProcessNeverBlocksTheMainActorOrAllowsAWrite() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/lockf")
        process.arguments = ["-k", directory.appendingPathComponent("reading-state.lock").path,
                             "/bin/sh", "-c", "printf x; exec /bin/cat"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            process.waitUntilExit()
        }
        #expect(try output.fileHandleForReading.read(upToCount: 1) == Data("x".utf8))

        let store = ReadingStateStore(directory: directory)
        store.setPosition(position("pending"), for: reference(1))
        let clock = ContinuousClock()
        let start = clock.now
        let responsive = Task { @MainActor in true }
        expectNotSaved(await store.flush(timeout: 0.1))
        #expect(await responsive.value)
        #expect(start.duration(to: clock.now) < .seconds(1))
        #expect(store.hasPendingChanges)
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("reading-state.json").path))
        // The writer's own lock deadline also reports failure without losing the mutation.
        expectNotSaved(await store.flush(timeout: 1))
        #expect(store.hasPendingChanges)
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("reading-state.json").path))

        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        #expect(await store.flush(timeout: 2) == .saved)
        #expect(!store.hasPendingChanges)
        #expect(ReadingStateStore(directory: directory).position(for: reference(1))?.blockKey == "pending")
    }

    @Test func lockOpenFailureNeverWritesAndRetainsPendingChanges() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let lock = directory.appendingPathComponent("reading-state.lock")
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        let store = ReadingStateStore(directory: directory)
        store.setPosition(position("pending"), for: reference(1))
        expectNotSaved(await store.flush(timeout: 2))
        #expect(store.hasPendingChanges)
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("reading-state.json").path))
        try FileManager.default.removeItem(at: lock)
        #expect(await store.flush(timeout: 2) == .saved)
    }

    @Test func failedAtomicWriteRetainsChangesAndRetriesWithoutAnotherMutation() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("reading-state.json")
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        let store = ReadingStateStore(directory: directory)
        store.setPosition(position("retry"), for: reference(1))
        expectNotSaved(await store.flush(timeout: 2))
        #expect(store.hasPendingChanges)
        #expect(!store.isSaving)
        try FileManager.default.removeItem(at: file)
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(3))
        while store.hasPendingChanges, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(!store.hasPendingChanges)
        #expect(ReadingStateStore(directory: directory).position(for: reference(1))?.blockKey == "retry")
        #expect(await store.flush(timeout: 1) == .nothingToSave)
    }

    @Test func mutationDuringWriteStaysPendingUntilItsOwnSuccessfulSnapshot() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = StateWriteGate()
        defer { gate.release() }
        let store = ReadingStateStore(directory: directory, beforeWrite: { gate.wait() })
        store.setPosition(position("first", at: 0.1), for: reference(1))
        let first = Task { await store.flush(timeout: 2) }
        var entries = gate.entries.makeAsyncIterator()
        await entries.next()
        #expect(store.isSaving)
        store.setPosition(position("second", at: 0.2), for: reference(1))
        store.setPosition(position("other", at: 0.3), for: reference(2))
        store.settings = PageSettings(textSize: 7)
        store.noteOpened(reference(2), title: "Other")
        gate.release()
        #expect(await first.value == .saved)
        #expect(store.hasPendingChanges)
        #expect(store.position(for: reference(1))?.blockKey == "second")
        let firstDisk = ReadingStateStore(directory: directory)
        #expect(firstDisk.position(for: reference(1))?.blockKey == "first")
        #expect(firstDisk.position(for: reference(2)) == nil)
        #expect(await store.flush(timeout: 2) == .saved)
        #expect(!store.hasPendingChanges)
        let finalDisk = ReadingStateStore(directory: directory)
        #expect(finalDisk.position(for: reference(1))?.blockKey == "second")
        #expect(finalDisk.position(for: reference(2))?.blockKey == "other")
        #expect(finalDisk.settings.textSize == 7)
        #expect(finalDisk.recents.first?.title == "Other")
    }

    @Test func laterFlushDoesNotAcknowledgeAReplacementFromAnEarlierSnapshot() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let sequence = StateWriteSequence()
        defer { sequence.gates.forEach { $0.release() } }
        let store = ReadingStateStore(directory: directory, beforeWrite: { sequence.wait() })
        store.setPosition(position("first", at: 0.1), for: reference(1))
        let first = Task { await store.flush(timeout: 2) }
        var firstEntries = sequence.gates[0].entries.makeAsyncIterator()
        await firstEntries.next()
        store.setPosition(position("replacement", at: 0.2), for: reference(1))
        let (started, ready) = AsyncStream<Void>.makeStream()
        let later = Task {
            ready.yield(())
            return await store.flush(timeout: 0.15)
        }
        var starts = started.makeAsyncIterator()
        await starts.next()
        sequence.gates[0].release()
        var secondEntries = sequence.gates[1].entries.makeAsyncIterator()
        await secondEntries.next()
        #expect(await first.value == .saved)
        expectNotSaved(await later.value)
        #expect(store.hasPendingChanges)
        #expect(ReadingStateStore(directory: directory).position(for: reference(1))?.blockKey == "first")
        sequence.gates[1].release()
        #expect(await store.flush(timeout: 2) == .saved)
        #expect(ReadingStateStore(directory: directory).position(for: reference(1))?.blockKey == "replacement")
    }

    @Test func deadlineDoesNotWaitForAHungWriterAndSaveNowReturnsImmediately() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = StateWriteGate()
        defer { gate.release() }
        let store = ReadingStateStore(directory: directory, beforeWrite: { gate.wait() })
        store.setPosition(position("pending"), for: reference(1))
        store.saveNow()
        var entries = gate.entries.makeAsyncIterator()
        await entries.next()
        let clock = ContinuousClock()
        let start = clock.now
        expectNotSaved(await store.flush(timeout: 0.05))
        #expect(start.duration(to: clock.now) < .seconds(1))
        #expect(store.hasPendingChanges)
        #expect(store.isSaving)
        expectNotSaved(await store.flush(timeout: 0))
        gate.release()
        #expect(await store.flush(timeout: 2) == .saved)
        #expect(!store.hasPendingChanges)
    }

    @Test func reverseFlushWithinOneSecondKeepsLaterCaptureAndUnrelatedDocuments() async throws {
        let directory = try directory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let earlier = ReadingStateStore(directory: directory)
        let later = ReadingStateStore(directory: directory)
        earlier.setPosition(position("earlier", at: 0.123456), for: reference(1))
        earlier.setPosition(position("only-earlier", at: 0.2), for: reference(2))
        later.setPosition(position("later", at: 0.123457), for: reference(1))
        later.setPosition(position("only-later", at: 0.3), for: reference(3))
        #expect(await later.flush(timeout: 2) == .saved)
        #expect(await earlier.flush(timeout: 2) == .saved)
        let disk = ReadingStateStore(directory: directory)
        #expect(disk.position(for: reference(1))?.blockKey == "later")
        #expect(disk.position(for: reference(2))?.blockKey == "only-earlier")
        #expect(disk.position(for: reference(3))?.blockKey == "only-later")
        #expect(earlier.position(for: reference(1))?.blockKey == "later")
        let data = try Data(contentsOf: directory.appendingPathComponent("reading-state.json"))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let file = try decoder.decode(ReadingStateFile.self, from: data)
        #expect(file.version == 1)
        #expect(file.positions[reference(1).key]?.savedAt == position("later", at: 0.123457).savedAt)
        #expect(String(decoding: data, as: UTF8.self).range(of: #"T\d{2}:\d{2}:\d{2}\.\d+Z"#, options: .regularExpression) != nil)
    }

    @Test func memoryOnlyStoreHasNothingToFlush() async {
        let store = ReadingStateStore(directory: nil)
        store.setPosition(position("memory"), for: reference(1))
        #expect(!store.hasPendingChanges)
        #expect(await store.flush(timeout: 1) == .nothingToSave)
        #expect(store.position(for: reference(1))?.blockKey == "memory")
    }
}
