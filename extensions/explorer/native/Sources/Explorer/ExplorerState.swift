import CoreFoundation
import Foundation

struct ExplorerState {
    let store: URL
    private var dir: URL { store.appendingPathComponent("pane-v1", isDirectory: true) }
    static let defaults: [String: Any] = ["textSize": 16, "wrap": false, "preview": true, "diff": "auto", "sidebar": ["open": true, "width": 244], "tab": "files", "zoom": 1.0]

    var settings: [String: Any] {
        (try? Self.validSettings(load(dir.appendingPathComponent("settings.json")))) ?? Self.defaults
    }

    var zoom: Double { settings["zoom"] as? Double ?? 1 }

    /// The page saves its settings; the host owns the zoom level, so the stored level survives a page save.
    func saveSettings(_ value: Any?) throws {
        var next = try Self.validSettings(value)
        next["zoom"] = zoom
        try write(next, to: dir.appendingPathComponent("settings.json"))
    }

    func saveZoom(_ value: Double) throws {
        guard ExplorerZoom.range.contains(value) else { throw ExplorerError("invalid", "The zoom level is out of range.") }
        var next = settings
        next["zoom"] = value
        try write(next, to: dir.appendingPathComponent("settings.json"))
    }

    static func validSettings(_ value: Any?) throws -> [String: Any] {
        guard let value = value as? [String: Any], let textSize = value["textSize"] as? Int, (10...32).contains(textSize),
              let wrap = value["wrap"] as? Bool, let diff = value["diff"] as? String, ["auto", "unified", "split"].contains(diff),
              let sidebar = value["sidebar"] as? [String: Any], let open = sidebar["open"] as? Bool,
              let width = sidebar["width"] as? Double, (140...640).contains(width),
              let tab = value["tab"] as? String, ["files", "changes", "notes"].contains(tab) else {
            throw ExplorerError("invalid", "Explorer page settings are invalid.")
        }
        guard value["preview"] == nil || value["preview"] is Bool else {
            throw ExplorerError("invalid", "The Markdown preview setting is invalid.")
        }
        var zoom = 1.0
        if let raw = value["zoom"] {
            guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  ExplorerZoom.range.contains(number.doubleValue) else { throw ExplorerError("invalid", "The zoom level is invalid.") }
            zoom = number.doubleValue
        }
        return ["textSize": textSize, "wrap": wrap, "preview": value["preview"] as? Bool ?? true, "diff": diff, "sidebar": ["open": open, "width": width], "tab": tab,
                "zoom": zoom]
    }

    private func location(_ key: String, record: String = "position") -> URL {
        dir.appendingPathComponent("\(record)-\(contentDigest(Data(key.utf8))).json")
    }

    private func editDirectory(_ root: URL) -> URL {
        dir.appendingPathComponent("edits-\(contentDigest(Data(root.path.utf8)))", isDirectory: true)
    }

    private func editFile(_ folder: URL, _ path: String) -> URL {
        folder.appendingPathComponent(contentDigest(Data(path.utf8)) + ".draft")
    }

    private func editRecords(_ folder: URL) throws -> [URL] {
        guard let scan = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: nil, options: [.skipsSubdirectoryDescendants, .skipsHiddenFiles]) else { return [] }
        var records: [URL] = []
        for case let file as URL in scan where file.pathExtension == "draft" {
            guard records.count < 32 else { throw ExplorerError("draft-limit", "Explorer already holds 32 edited files for this folder.") }
            records.append(file)
        }
        return records
    }

    func editedPaths(root: URL) throws -> [String] {
        let folder = editDirectory(root)
        return try editRecords(folder).compactMap { file in
            guard let handle = try? FileHandle(forReadingFrom: file),
                  let bytes = try? handle.read(upToCount: 25 * kib), let end = bytes.firstIndex(of: 10),
                  let values = try? JSONDecoder().decode([String].self, from: bytes.prefix(upTo: end)),
                  let path = values.first, validPath(path), editFile(folder, path).lastPathComponent == file.lastPathComponent else { return nil }
            return path
        }
    }

    func editDraft(root: URL, path: String, value: Any?) throws -> [String: Any]? {
        guard validPath(path) else { throw ExplorerError("invalid-path", "An edit draft needs a valid file path.") }
        let folder = editDirectory(root), file = editFile(folder, path)
        if value == nil {
            guard let handle = try? FileHandle(forReadingFrom: file), let bytes = try handle.read(upToCount: 13 * mib),
                  let end = bytes.firstIndex(of: 10), let fields = try? JSONSerialization.jsonObject(with: bytes.suffix(from: end + 1)) else { return nil }
            return try Self.validEditDraft(fields)
        }
        if value is NSNull {
            if unlink(file.path) != 0, errno != ENOENT { throw ExplorerError("io", "Explorer could not clear the edit draft.") }
            return nil
        }
        let fields = try Self.validEditDraft(value)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(folder.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw ExplorerError("io", "Explorer could not open the edit draft folder.") }
        defer { close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw ExplorerError("busy", "Another pane is saving an edit draft.") }
        if !FileManager.default.fileExists(atPath: file.path), try editRecords(folder).count >= 32 {
            throw ExplorerError("draft-limit", "Explorer already holds 32 edited files for this folder.")
        }
        var bytes = try JSONEncoder().encode([path])
        bytes.append(10)
        bytes.append(try JSONSerialization.data(withJSONObject: fields))
        try write(bytes, to: file)
        return nil
    }

    private static func validEditDraft(_ value: Any?) throws -> [String: Any] {
        guard let fields = value as? [String: Any], Set(fields.keys) == ["base", "text", "ending"],
              let base = fields["base"] as? String, validEditBase(base),
              let text = fields["text"] as? String, validEditText(Data(text.utf8)), !text.utf8.contains(13),
              let ending = fields["ending"] as? String, ["lf", "crlf", "cr"].contains(ending) else {
            throw ExplorerError("invalid", "The edit draft is invalid or too large.")
        }
        return fields
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
        try write(JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), to: file)
    }
    private func write(_ data: Data, to file: URL) throws {
        let staged = file.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: staged) }
        try data.write(to: staged, options: [.withoutOverwriting])
        guard chmod(staged.path, 0o600) == 0, rename(staged.path, file.path) == 0 else {
            throw ExplorerError("io", "Explorer could not save the pane state.")
        }
    }
}
