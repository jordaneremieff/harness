import CoreFoundation
import CryptoKit
import Foundation

struct ExplorerState {
    let store: URL
    private var dir: URL { store.appendingPathComponent("pane-v1", isDirectory: true) }
    static let defaults: [String: Any] = ["textSize": 16, "wrap": false, "diff": "auto", "sidebar": ["open": true, "width": 244], "tab": "files"]

    var settings: [String: Any] {
        (try? Self.validSettings(load(dir.appendingPathComponent("settings.json")))) ?? Self.defaults
    }

    func saveSettings(_ value: Any?) throws {
        try write(Self.validSettings(value), to: dir.appendingPathComponent("settings.json"))
    }

    static func validSettings(_ value: Any?) throws -> [String: Any] {
        guard let value = value as? [String: Any], let textSize = value["textSize"] as? Int, (10...32).contains(textSize),
              let wrap = value["wrap"] as? Bool, let diff = value["diff"] as? String, ["auto", "unified", "split"].contains(diff),
              let sidebar = value["sidebar"] as? [String: Any], let open = sidebar["open"] as? Bool,
              let width = sidebar["width"] as? Double, (140...640).contains(width),
              let tab = value["tab"] as? String, ["files", "changes", "notes"].contains(tab) else {
            throw ExplorerError("invalid", "Explorer page settings are invalid.")
        }
        return ["textSize": textSize, "wrap": wrap, "diff": diff, "sidebar": ["open": open, "width": width], "tab": tab]
    }

    private func location(_ key: String, record: String = "position") -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return dir.appendingPathComponent("\(record)-\(digest).json")
    }

    func restore(root: URL, launch: [String: Any]) -> [String: Any] {
        var next = launch
        if launch.isEmpty, let stored = load(location(root.path)), (try? Launch.validate(stored, launch: false)) != nil { next = stored }
        guard let path = next["path"] as? String,
              ["line", "end", "note", "tour"].allSatisfy({ launch[$0] == nil }) else { return next }
        let key = root.path + "\0" + path
        if next["line"] == nil, let position = load(location(key)), (try? Launch.validate(position, launch: false)) != nil {
            next["line"] = position["line"]
        }
        if let stored = load(location(key, record: "draft")), let draft = try? Self.validDraft(stored) { next["draft"] = draft }
        return next
    }

    @discardableResult
    func save(root: URL, fields: [String: Any]) throws -> Bool {
        var position = fields
        let draft = position.removeValue(forKey: "draft")
        try Launch.validate(position, launch: false)
        let path = position["path"] as? String
        if let draft {
            guard let path else { throw ExplorerError("invalid", "A draft needs a file path.") }
            let file = location(root.path + "\0" + path, record: "draft")
            if draft is NSNull {
                if unlink(file.path) != 0, errno != ENOENT { throw ExplorerError("io", "Explorer could not clear the draft.") }
            } else {
                try write(Self.validDraft(draft), to: file)
            }
            if position.count == 1 { return false }
        }
        try write(position, to: location(root.path))
        if let path, let line = position["line"] { try write(["line": line], to: location(root.path + "\0" + path)) }
        return true
    }

    private static func validDraft(_ value: Any) throws -> [String: Any] {
        let invalid = ExplorerError("invalid", "The card draft is invalid or too large.")
        guard let fields = value as? [String: Any], Set(fields.keys).isSubset(of: ["mode", "text", "range", "noteId", "quote", "commit"]),
              let mode = fields["mode"] as? String, ["ask", "comment", "note"].contains(mode),
              let text = fields["text"] as? String, text.utf16.count <= 16 * kib else { throw invalid }
        if let raw = fields["range"] {
            guard let range = raw as? [String: Any], Set(range.keys) == ["side", "start", "end"],
                  let side = range["side"] as? String, ["base", "head"].contains(side),
                  let start = lineNumber(range["start"]), let end = lineNumber(range["end"]), start <= end else { throw invalid }
        }
        if let id = fields["noteId"], (id as? String)?.range(of: #"\An-[0-9a-f]{20}\z"#, options: .regularExpression) == nil { throw invalid }
        if let quote = fields["quote"], (quote as? String).map({ $0.utf8.count <= 32 * kib }) != true { throw invalid }
        if let commit = fields["commit"], !(commit is NSNull),
           (commit as? String)?.range(of: #"\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z"#, options: .regularExpression) == nil { throw invalid }
        return fields
    }

    private static func lineNumber(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let line = value as? Int, (1...Int(Int32.max)).contains(line) else { return nil }
        return line
    }

    private func load(_ file: URL) -> [String: Any]? {
        guard let handle = try? FileHandle(forReadingFrom: file), let data = try? handle.read(upToCount: 256 * kib),
              let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return object as? [String: Any]
    }
    private func write(_ fields: [String: Any], to file: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        let staged = dir.appendingPathComponent(".\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: staged) }
        try data.write(to: staged, options: [.withoutOverwriting])
        guard chmod(staged.path, 0o600) == 0, rename(staged.path, file.path) == 0 else {
            throw ExplorerError("io", "Explorer could not save the pane state.")
        }
    }
}
