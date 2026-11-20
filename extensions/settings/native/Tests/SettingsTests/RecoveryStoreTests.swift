import Darwin
import Foundation
import Testing
@testable import Settings

@Test func activeDraftIsPrivateAndNeverOfferedToAnotherPane() async throws {
    try await withSettingsFixture { root in
        let writer = RecoveryStore(agentDir: "/agent", cwd: "/project", applicationSupport: root)
        let other = RecoveryStore(agentDir: "/agent", cwd: "/project", applicationSupport: root)
        let first = Data("first".utf8)
        try await writer.save(first)
        let enumerator = try #require(FileManager.default.enumerator(atPath: root.path))
        let file = try #require(enumerator.compactMap { $0 as? String }.first { $0.hasSuffix(".json") })
        let draft = root.appendingPathComponent(file)
        var before = stat(), after = stat()
        try #require(lstat(draft.path, &before) == 0)
        #expect(before.st_mode == S_IFREG | 0o600)
        #expect(try Data(contentsOf: draft) == first)
        try await writer.save(Data("replacement".utf8))
        try #require(lstat(draft.path, &after) == 0)
        #expect(after.st_ino != before.st_ino)
        #expect(try await other.load().isEmpty)
        await #expect(throws: SettingsFailure.self) { try await other.discard(id: draft.deletingPathExtension().lastPathComponent) }
        #expect(try Data(contentsOf: draft) == Data("replacement".utf8))
        try await writer.save(nil)
        #expect(!FileManager.default.fileExists(atPath: draft.path))
    }
}

@Test func expiredDraftRequiresExplicitDiscardAfterAdoption() async throws {
    try await withSettingsFixture { root in
        let original = Data("recover me".utf8)
        do {
            let writer = RecoveryStore(agentDir: "/agent", cwd: "/project", applicationSupport: root)
            try await writer.save(original)
        }
        let otherProject = RecoveryStore(agentDir: "/agent", cwd: "/other-project", applicationSupport: root)
        let otherAgent = RecoveryStore(agentDir: "/other-agent", cwd: "/project", applicationSupport: root)
        #expect(try await otherProject.load().isEmpty)
        #expect(try await otherAgent.load().isEmpty)
        let adopter = RecoveryStore(agentDir: "/agent", cwd: "/project", applicationSupport: root)
        let observer = RecoveryStore(agentDir: "/agent", cwd: "/project", applicationSupport: root)
        let offered = try await adopter.load()
        let item = try #require(offered.first)
        #expect(offered.count == 1)
        #expect(item.data == original)
        #expect(try await adopter.load().first?.id == item.id)
        #expect(try await observer.load().isEmpty)
        await #expect(throws: SettingsFailure.self) { try await observer.discard(id: item.id) }
        await #expect(throws: SettingsFailure.self) { try await adopter.discard(id: "../another-draft") }
        try await adopter.save(item.data)
        try await adopter.discard(id: item.id)
        #expect(try await adopter.load().isEmpty)
        #expect(try await observer.load().isEmpty)
        try await adopter.save(nil)
    }
}

@Test func abandonedRecoveryOfferLeavesTheDraftIntact() async throws {
    try await withSettingsFixture { root in
        func store() -> RecoveryStore { RecoveryStore(agentDir: "/agent", cwd: "/project", applicationSupport: root) }
        let data = Data("still recoverable".utf8)
        do {
            let writer = store()
            try await writer.save(data)
        }
        do {
            let reader = store()
            #expect(try await reader.load().first?.data == data)
        }
        let reader = store()
        #expect(try await reader.load().first?.data == data)
    }
}
