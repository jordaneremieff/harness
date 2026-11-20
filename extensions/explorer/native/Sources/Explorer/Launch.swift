import CoreFoundation
import Foundation

func ignoredOption(_ value: String?) throws -> Bool {
    switch value {
    case nil, "show": return true
    case "hide": return false
    default: throw ExplorerError("arguments", "--ignored must be show or hide.")
    }
}

struct Launch {
    let root: String
    let fields: [String: Any]
    var path: String? { fields["path"] as? String }

    init(target: [String: Any]) throws {
        guard let root = target["root"] as? String, root.hasPrefix("/"), !root.utf8.contains(0), root.utf8.count <= 4096 else {
            throw ExplorerError("invalid-root", "An absolute --root is required.")
        }
        var fields = target
        fields.removeValue(forKey: "root")
        try Self.validate(fields, launch: true)
        self.root = root
        self.fields = fields
    }

    init(arguments: [String]) throws {
        let allowed = Set(["root", "path", "line", "end", "view", "review", "tour", "note"])
        let parsed = try options(arguments, allowed: allowed)
        var target: [String: Any] = parsed
        for key in ["line", "end"] where parsed[key] != nil {
            guard let value = Int(parsed[key]!), value > 0 else { throw ExplorerError("invalid", "--\(key) must be a positive integer.") }
            target[key] = value
        }
        if let raw = parsed["review"] {
            guard raw.utf8.count <= 4096, let scope = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else {
                throw ExplorerError("invalid", "--review must be a review scope object.")
            }
            target["review"] = scope
        }
        try self.init(target: target)
    }

    static func validate(_ fields: [String: Any], launch: Bool) throws {
        let allowed = Set(launch ? ["path", "line", "end", "view", "review", "tour", "note"] : ["path", "line", "view", "review"])
        guard Set(fields.keys).isSubset(of: allowed) else { throw ExplorerError("invalid", "Unknown location field.") }
        if let path = fields["path"], (path as? String).map(validPath) != true { throw ExplorerError("invalid-path", "The file path is not relative to the opened folder.") }
        for key in ["line", "end"] {
            if let value = fields[key] {
                guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      let line = value as? Int, (1...Int(Int32.max)).contains(line) else {
                    throw ExplorerError("invalid", "A line number must be a positive integer.")
                }
            }
        }
        if let end = fields["end"] as? Int, let start = fields["line"] as? Int, end < start { throw ExplorerError("invalid", "The end line precedes the start line.") }
        if let view = fields["view"], !(view as? String).map({ ["file", "changes", "notes"].contains($0) }).orFalse {
            throw ExplorerError("invalid", "The view must be file, changes or notes.")
        }
        if let review = fields["review"] { _ = try scopeShape(review) }
        for key in ["tour", "note"] {
            if let raw = fields[key], (raw as? String)?.range(of: #"^[a-zA-Z0-9_-]{1,128}$"#, options: .regularExpression) == nil {
                throw ExplorerError("invalid", "The \(key) identifier is invalid.")
            }
        }
    }
}

private extension Optional where Wrapped == Bool { var orFalse: Bool { self == true } }

func scopeShape(_ raw: Any?) throws -> [String: Any] {
    guard let scope = raw as? [String: Any], let kind = scope["kind"] as? String else { throw ExplorerError("invalid", "A review scope is required.") }
    let required: Set<String>
    var allowed: Set<String> = ["kind"]
    switch kind {
    case "uncommitted", "since-review": required = []
    case "commit": required = ["commit"]
    case "range": required = ["base", "head"]
    case "branch": required = []; allowed.insert("base")
    default: throw ExplorerError("invalid", "Unknown review scope.")
    }
    allowed.formUnion(required)
    guard Set(scope.keys).isSubset(of: allowed), required.isSubset(of: Set(scope.keys)),
          scope.filter({ $0.key != "kind" }).values.allSatisfy({
              guard let ref = $0 as? String else { return false }
              return !ref.hasPrefix("-") && !ref.contains("..") && ref.range(of: #"^[A-Za-z0-9_./-]{1,255}$"#, options: .regularExpression) != nil
          }) else { throw ExplorerError("invalid", "The review arguments are invalid.") }
    return scope
}

func options(_ args: [String], allowed: Set<String>) throws -> [String: String] {
    guard args.count.isMultiple(of: 2) else { throw ExplorerError("arguments", "Each option needs a value.") }
    var values: [String: String] = [:]
    for i in stride(from: 0, to: args.count, by: 2) {
        let flag = args[i], key = String(flag.dropFirst(2))
        guard flag.hasPrefix("--"), allowed.contains(key), values[key] == nil else {
            throw ExplorerError("arguments", "Unknown or repeated option: \(flag.debugDescription)")
        }
        values[key] = args[i + 1]
    }
    return values
}

func paneArguments(_ text: String) throws -> [String] {
    let bytes = Array(text.utf8)
    var i = 0, words: [String] = []
    func whitespace(_ b: UInt8) -> Bool { b == 32 || b == 9 }
    while i < bytes.count {
        if whitespace(bytes[i]) { i += 1; continue }
        let first = i
        if bytes[i] == 34 {
            i += 1
            while i < bytes.count, bytes[i] != 34 { i += bytes[i] == 92 ? 2 : 1 }
            guard i < bytes.count, i + 1 == bytes.count || whitespace(bytes[i + 1]),
                  let value = try? JSONDecoder().decode(String.self, from: Data(bytes[first...i])) else {
                throw ExplorerError("arguments", "Use JSON double quotes around an argument with spaces or escapes.")
            }
            words.append(value)
            i += 1
        } else {
            while i < bytes.count, !whitespace(bytes[i]) { i += 1 }
            words.append(String(decoding: bytes[first..<i], as: UTF8.self))
        }
    }
    guard words.first == "open" else { throw ExplorerError("arguments", "Use :open --root <folder> or q to close.") }
    return Array(words.dropFirst())
}

func resourcesURL() -> URL {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
    return executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources", isDirectory: true)
}

func buildRecord(_ resources: URL) -> [String: Any] {
    guard let data = try? Data(contentsOf: resources.appendingPathComponent("build.json")),
          let build = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return build
}
