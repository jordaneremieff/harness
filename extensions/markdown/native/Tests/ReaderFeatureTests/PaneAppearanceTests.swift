import Foundation
import Observation
import Testing
@testable import ReaderFeature

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    var value: Bool { lock.withLock { raised } }
    func set() { lock.withLock { raised = true } }
}

/// The shared pane appearance file of docs/conventions/pane-appearance.md.
@MainActor @Suite(.serialized) struct PaneAppearanceFile {
    static func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pane-appearance-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Replaces the file as the convention requires: a temporary file in the same folder, then a rename.
    static func replace(_ file: URL, _ text: String) throws {
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".writer-\(UUID().uuidString)")
        try Data(text.utf8).write(to: temporary)
        #expect(rename(temporary.path, file.path) == 0)
    }

    @Test func absentOrInvalidFilesMeanSystemAndFrappe() {
        for text in [nil, "", "{", "[]", #"{"version":2,"appearance":"dark","darkTheme":"mocha"}"#,
                     #"{"version":true,"appearance":"dark"}"#, #"{"appearance":"dark","darkTheme":"mocha"}"#] {
            let choice = PaneAppearance.decode(text.map { Data($0.utf8) })
            #expect(choice.appearance == "system" && choice.darkTheme == "frappe")
        }
        let partial = PaneAppearance.decode(Data(#"{"version":1,"appearance":"light","darkTheme":"latte","other":3}"#.utf8))
        #expect(partial.appearance == "light" && partial.darkTheme == "frappe")
        let full = PaneAppearance.decode(Data(#"{"version":1,"appearance":"dark","darkTheme":"mocha"}"#.utf8))
        #expect(full.appearance == "dark" && full.darkTheme == "mocha")
    }

    @Test func writesReplaceTheWholeFilePrivately() throws {
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("pane-appearance.json")
        let theme = PaneAppearance(file: file)
        #expect(theme.appearance == "system" && theme.darkTheme == "frappe")
        try theme.set(darkTheme: "macchiato")
        try theme.set(appearance: "dark", darkTheme: "latte")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        #expect(object?["version"] as? Int == 1)
        #expect(object?["appearance"] as? String == "dark")
        #expect(object?["darkTheme"] as? String == "macchiato")
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o600)
        let left = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        #expect(left == ["pane-appearance.json"])
    }

    @Test func inMemoryChoicesNeverTouchAFile() throws {
        let theme = PaneAppearance(file: nil, appearance: "light", darkTheme: "mocha")
        #expect(theme.appearance == "light" && theme.darkTheme == "mocha")
        try theme.set(appearance: "dark")
        #expect(theme.appearance == "dark")
    }

    @Test func anotherWritersChangeArrivesWithinASecond() async throws {
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("pane-appearance.json")
        let state = ReadingStateStore(directory: nil, theme: PaneAppearance(file: file))
        let changed = Flag()
        _ = withObservationTracking { (state.appearance, state.darkTheme) } onChange: { changed.set() }
        try Self.replace(file, #"{"version":1,"appearance":"light","darkTheme":"mocha"}"#)
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline, !(state.appearance == "light" && state.darkTheme == "mocha") {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(state.appearance == "light" && state.darkTheme == "mocha")
        #expect(changed.value)
    }
}
