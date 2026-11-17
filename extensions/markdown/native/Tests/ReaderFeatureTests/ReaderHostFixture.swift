import Foundation

/// The test host is staged explicitly as a web root. Production resources never use this path.
enum ReaderHostFixture {
    static let root: URL = {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let native = source.deletingLastPathComponent().deletingLastPathComponent()
        let root = native.appendingPathComponent(".build/reader-host-fixture-\(UUID().uuidString)", isDirectory: true)
        let fixture = source.appendingPathComponent("Fixtures/ReaderHost", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: fixture.appendingPathComponent("index.html"), to: root.appendingPathComponent("index.html"))
            try FileManager.default.copyItem(at: fixture.appendingPathComponent("host.css"), to: root.appendingPathComponent("host.css"))
            try FileManager.default.copyItem(at: fixture.appendingPathComponent("host.ts"), to: root.appendingPathComponent("host.js"))
            return root
        } catch {
            preconditionFailure("The reader host fixture could not be staged: \(error)")
        }
    }()
}
