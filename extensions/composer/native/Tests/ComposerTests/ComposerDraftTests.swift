import Darwin
import Foundation
import Testing
@testable import Composer

struct ComposerDraftTests {
    @Test func draftRetentionIsPrivateAndExact() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString
        let store = ComposerDraftStore(directory: root, composer: id)
        let text = "a\n'quotes' 🌲\r\n"
        try store.save(text, sessionID: "session")
        #expect(store.retained() == text)
        let url = root.appendingPathComponent("\(id).json")
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect(attrs[.posixPermissions] as? Int == 0o600)
        let record = try JSONDecoder().decode(ComposerDraftStore.Draft.self, from: Data(contentsOf: url))
        #expect(record.sessionID == "session")
        try store.save("", sessionID: "session")
        #expect(store.retained().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func preparationCreatesAPrivateDirectoryAndExplainsUnsafePermissions() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try ComposerDraftStore.prepare(root)
        let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
        #expect(attributes[.posixPermissions] as? Int == 0o700)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        let store = ComposerDraftStore(directory: root, composer: UUID().uuidString)
        do {
            try store.save("keep my draft", sessionID: "session")
            Issue.record("An unsafe directory accepted a draft.")
        } catch {
            #expect(error.localizedDescription.contains(root.path))
            #expect(error.localizedDescription.contains("0700"))
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }

    @Test func onlyTheNewestDeadComposerDraftInTheSessionIsOffered() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ComposerDraftStore(directory: root, composer: UUID().uuidString)
        let active = ComposerDraftStore(directory: root, composer: UUID().uuidString)
        try active.save("active", sessionID: "session")
        func orphan(_ text: String, at timestamp: Double, session: String?) throws -> ComposerDraftStore.Draft {
            let draft = ComposerDraftStore.Draft(composer: UUID().uuidString, pid: .max, updated: Date(timeIntervalSince1970: timestamp), sessionID: session, text: text)
            try JSONEncoder().encode(draft).write(to: root.appendingPathComponent("\(draft.composer).json"))
            return draft
        }
        let earlier = Date().timeIntervalSince1970 - 100
        _ = try orphan("older", at: earlier, session: "session")
        let newest = try orphan("this session", at: earlier + 1, session: "session")
        let other = try orphan("other session", at: earlier + 2, session: "other")
        _ = try orphan("unknown session", at: earlier + 3, session: nil)
        #expect(store.newestOrphan(in: "session") == newest)
        #expect(store.newestOrphan(in: "other") == other)
        #expect(store.newestOrphan(in: "different") == nil)
    }

    @Test func composerTerminalTreatsQAndSplitScalarsAsText() {
        var input = ComposerTerminalInput()
        let bytes = Array("q🌲".utf8)
        #expect(input.feed(bytes.prefix(2)).text == "q")
        #expect(input.feed(bytes.dropFirst(2)).text == "🌲")
        #expect(input.feed([27, 91, 65, 3][...]).text.isEmpty)
        #expect(input.feed([4][...]).close)
    }
}
