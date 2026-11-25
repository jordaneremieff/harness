import AppKit
import Foundation
import Testing
@testable import Explorer

/// The shared pane appearance file of docs/conventions/pane-appearance.md.
@MainActor @Suite(.serialized) struct ExplorerAppearanceTests {
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("explorer-appearance-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func absentOrInvalidFilesMeanSystemAndFrappe() {
        for text in [nil, "", "{", "[]", #"{"version":2,"appearance":"dark","darkTheme":"mocha"}"#,
                     #"{"version":true,"appearance":"dark"}"#, #"{"appearance":"dark","darkTheme":"mocha"}"#] {
            let choice = ExplorerAppearance.decode(text.map { Data($0.utf8) })
            #expect(choice.appearance == "system" && choice.darkTheme == "frappe")
        }
        let partial = ExplorerAppearance.decode(Data(#"{"version":1,"appearance":"light","darkTheme":"latte"}"#.utf8))
        #expect(partial.appearance == "light" && partial.darkTheme == "frappe")
        let full = ExplorerAppearance.decode(Data(#"{"version":1,"appearance":"dark","darkTheme":"mocha","other":true}"#.utf8))
        #expect(full.appearance == "dark" && full.darkTheme == "mocha")
    }

    @Test func choicesReplaceTheWholeFilePrivatelyAndRejectUnknownValues() throws {
        let folder = try folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("pane-appearance.json")
        let theme = ExplorerAppearance(file: file)
        var changes = 0
        theme.onChange = { changes += 1 }
        try theme.set(["darkTheme": "macchiato"])
        try theme.set(["appearance": "dark"])
        #expect(throws: ExplorerError.self) { try theme.set(["darkTheme": "latte"]) }
        #expect(throws: ExplorerError.self) { try theme.set(["accent": "blue"]) }
        #expect(changes == 2)
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        #expect(object?["version"] as? Int == 1 && object?["appearance"] as? String == "dark" && object?["darkTheme"] as? String == "macchiato")
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o600)
        #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path) == ["pane-appearance.json"])
    }

    @Test func anotherWritersChangeArrivesWithinASecond() async throws {
        let folder = try folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("pane-appearance.json")
        let theme = ExplorerAppearance(file: file)
        var changes = 0
        theme.onChange = { changes += 1 }
        let temporary = folder.appendingPathComponent(".writer")
        try Data(#"{"version":1,"appearance":"light","darkTheme":"mocha"}"#.utf8).write(to: temporary)
        #expect(rename(temporary.path, file.path) == 0)
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline, changes == 0 { try await Task.sleep(for: .milliseconds(20)) }
        #expect(changes == 1)
        #expect(theme.appearance == "light" && theme.darkTheme == "mocha")
        #expect(theme.applicationAppearance?.name == .aqua)
    }

    @Test func inMemoryChoiceAndPaperFollowTheFlavour() throws {
        let theme = ExplorerAppearance(file: nil, appearance: "dark", darkTheme: "mocha")
        #expect(theme.applicationAppearance?.name == .darkAqua)
        // The shared palette that the build copies into the bundle, read from the checkout.
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("assets/themes/catppuccin.json"))
        let bases = ExplorerAppearance.bases(data)
        #expect(ExplorerAppearance.base(light: false, darkTheme: "macchiato", from: bases).map { [$0.red, $0.green, $0.blue] } == [36, 39, 58])
        #expect(ExplorerAppearance.base(light: true, darkTheme: "mocha", from: bases).map { [$0.red, $0.green, $0.blue] } == [239, 241, 245])
        func paper(_ name: NSAppearance.Name) -> [Int] {
            var components: [Int] = []
            NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
                let colour = theme.paper.usingColorSpace(.sRGB)!
                components = [colour.redComponent, colour.greenComponent, colour.blueComponent].map { Int(($0 * 255).rounded()) }
            }
            return components
        }
        // A test process has no bundle, so the paper takes the window background in place of a palette base.
        #expect(paper(.darkAqua).count == 3)
        #expect(ExplorerAppearance(file: nil).applicationAppearance == nil)
    }
}
