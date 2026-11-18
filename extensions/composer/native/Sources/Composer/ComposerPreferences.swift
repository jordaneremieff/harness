import Foundation

struct ComposerPreferences: Codable {
    var sendKey = "return"
    var textAdjust = 0

    private static func file(in directory: URL) -> URL {
        directory.appendingPathComponent("preferences.json")
    }

    static func load(from directory: URL) -> Self {
        guard let data = try? ComposerFileRead.read(file(in: directory), limit: 4096),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              ["return", "command"].contains(value.sendKey), (-4...8).contains(value.textAdjust) else { return Self() }
        return value
    }

    func save(to directory: URL) throws {
        try ComposerDraftStore.prepare(directory)
        try JSONEncoder().encode(self).write(to: Self.file(in: directory), options: .atomic)
    }
}
