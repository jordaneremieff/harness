import Darwin
import Foundation
import Testing
@testable import MarkdownReader

struct ComposerDraftTests {
    @Test func draftRetentionIsPrivateAndExact() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID().uuidString
        let store = ComposerDraftStore(directory: root, composer: id)
        let text = "a\n'quotes' 🌲\r\n"
        try store.save(text)
        #expect(store.retained() == text)
        let url = root.appendingPathComponent("\(id).json")
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect(attrs[.posixPermissions] as? Int == 0o600)
        try store.save("")
        #expect(store.retained().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func onlyDeadComposerDraftsAreOffered() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ComposerDraftStore(directory: root, composer: UUID().uuidString)
        let active = ComposerDraftStore(directory: root, composer: UUID().uuidString)
        try active.save("active")
        let ended = ComposerDraftStore.Draft(composer: UUID().uuidString, pid: .max, updated: Date(), text: "recovered")
        try JSONEncoder().encode(ended).write(to: root.appendingPathComponent("\(ended.composer).json"))
        #expect(store.orphans() == [ended])
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
