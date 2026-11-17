import CoreFoundation
import Foundation
import MarkdownCore

public enum ReaderBridgeError: Error, Equatable, Sendable {
    case invalid(String)
    case oversized
    case staleGeneration
    case expectedMismatch
    case invalidRange
}

public enum ReaderBridgeMessageType: String, Sendable {
    case ready, state, edits, agentRefused, render, lock, prompt, command, log, query
}

public enum ReaderBridgeLock: String, Codable, Sendable { case reading, writing }
public enum ReaderBridgeOrigin: String, Sendable { case person, agent, history }

public struct ReaderBridgeRange: Equatable, Sendable {
    public let start: Int
    public let end: Int
    public init(start: Int, end: Int) { self.start = start; self.end = end }

    /// A caret at either edge of a held passage belongs to that passage.
    public func overlaps(_ other: Self) -> Bool {
        if start == end { return other.start <= start && start <= other.end }
        if other.start == other.end { return start <= other.start && other.start <= end }
        return start < other.end && other.start < end
    }
}

public struct ReaderBridgeScroll: Equatable, Sendable {
    public let blockStart: Int
    public let offsetY: Double
    public init(blockStart: Int, offsetY: Double) { self.blockStart = blockStart; self.offsetY = offsetY }
}

public struct ReaderBridgeFindState: Equatable, Sendable {
    public let query: String
    public let count: Int
    public let index: Int
    public init(query: String, count: Int, index: Int) { self.query = query; self.count = count; self.index = index }
}

public struct ReaderBridgeSelection: Equatable, Sendable {
    public let text: String
    public let start: Int
    public let end: Int
    public init(text: String, start: Int, end: Int) { self.text = text; self.start = start; self.end = end }
}

public struct ReaderBridgePageState: Equatable, Sendable {
    public var lock: ReaderBridgeLock
    public var canUndo: Bool
    public var canRedo: Bool
    public var hasSelection: Bool
    public var findOpen: Bool
    public var held: ReaderBridgeRange?
    public var activeBlock: ReaderBridgeRange?
    public var scroll: ReaderBridgeScroll
    public var find: ReaderBridgeFindState?
    public var selection: ReaderBridgeSelection?
    public var overlay: String?

    public init(lock: ReaderBridgeLock = .reading, canUndo: Bool = false, canRedo: Bool = false,
                hasSelection: Bool = false, findOpen: Bool = false, held: ReaderBridgeRange? = nil,
                activeBlock: ReaderBridgeRange? = nil, scroll: ReaderBridgeScroll = .init(blockStart: 0, offsetY: 0),
                find: ReaderBridgeFindState? = nil, selection: ReaderBridgeSelection? = nil, overlay: String? = nil) {
        self.lock = lock; self.canUndo = canUndo; self.canRedo = canRedo
        self.hasSelection = hasSelection; self.findOpen = findOpen
        self.held = held; self.activeBlock = activeBlock; self.scroll = scroll
        self.find = find; self.selection = selection; self.overlay = overlay
    }

    public init(fields: [String: Any]) throws {
        guard let lock = ReaderBridgeLock(rawValue: try BridgeField.string(fields, "lock", limit: 16)) else {
            throw ReaderBridgeError.invalid("lock")
        }
        var overlay: String?
        if let value = fields["overlay"], !(value is NSNull) {
            try BridgeField.choice(fields, "overlay", values: ["review", "image", "details", "source", "library"])
            overlay = value as? String
        }
        let scroll = try BridgeField.object(fields, "scroll")
        try BridgeField.keys(scroll, allowed: ["blockStart", "offsetY"])
        self.init(lock: lock, canUndo: try BridgeField.bool(fields, "canUndo"),
                  canRedo: try BridgeField.bool(fields, "canRedo"),
                  hasSelection: try BridgeField.bool(fields, "hasSelection"),
                  findOpen: try BridgeField.bool(fields, "findOpen"),
                  held: try BridgeField.optionalRange(fields, "held"),
                  activeBlock: try BridgeField.optionalRange(fields, "activeBlock"),
                  scroll: .init(blockStart: try BridgeField.integer(scroll, "blockStart", max: ReaderBridgeCodec.sourceLimit),
                                offsetY: try BridgeField.number(scroll, "offsetY", magnitude: 1_000_000_000)), overlay: overlay)
        if fields["find"] != nil {
            let value = try BridgeField.object(fields, "find")
            try BridgeField.keys(value, allowed: ["query", "count", "index"])
            let count = try BridgeField.integer(value, "count")
            let index = try BridgeField.number(value, "index", magnitude: Double(ReaderBridgeCodec.maxInteger))
            guard index >= -1, index.rounded(.towardZero) == index, index <= Double(count) else {
                throw ReaderBridgeError.invalid("find index")
            }
            find = .init(query: try BridgeField.string(value, "query", limit: 8192, empty: true), count: count, index: Int(index))
        }
        if fields["selection"] != nil {
            let value = try BridgeField.object(fields, "selection")
            try BridgeField.keys(value, allowed: ["text", "start", "end"])
            let range = try BridgeField.range(value)
            selection = .init(text: try BridgeField.string(value, "text", limit: ReaderBridgeCodec.messageLimit, empty: true),
                              start: range.start, end: range.end)
        }
    }
}

public struct ReaderBridgeEdit: Equatable, Sendable {
    public let start: Int
    public let end: Int
    public let text: String
    public let expected: String
    public var range: ReaderBridgeRange { .init(start: start, end: end) }
    public init(start: Int, end: Int, text: String, expected: String) {
        self.start = start; self.end = end; self.text = text; self.expected = expected
    }
}

public struct ReaderBridgeChange: Equatable, Sendable {
    public let baseGeneration: Int
    public let generation: Int
    public let origin: ReaderBridgeOrigin
    public let operationId: String?
    public let edits: [ReaderBridgeEdit]
    public init(baseGeneration: Int, generation: Int, origin: ReaderBridgeOrigin,
                operationId: String? = nil, edits: [ReaderBridgeEdit]) {
        self.baseGeneration = baseGeneration; self.generation = generation
        self.origin = origin; self.operationId = operationId; self.edits = edits
    }

    public init(fields: [String: Any]) throws {
        guard let origin = ReaderBridgeOrigin(rawValue: try BridgeField.string(fields, "origin", limit: 16)) else {
            throw ReaderBridgeError.invalid("origin")
        }
        let base = try BridgeField.integer(fields, "baseGeneration")
        let generation = try BridgeField.integer(fields, "generation")
        guard generation == base + 1 else { throw ReaderBridgeError.invalid("generation") }
        guard let records = fields["edits"] as? [[String: Any]], !records.isEmpty, records.count <= ReaderBridgeCodec.editLimit else {
            throw ReaderBridgeError.invalid("edits")
        }
        var edits: [ReaderBridgeEdit] = []
        var previousEnd = 0
        for record in records {
            try BridgeField.keys(record, allowed: ["start", "end", "text", "expected"])
            let range = try BridgeField.range(record)
            guard range.start >= previousEnd else { throw ReaderBridgeError.invalid("edits order") }
            let text = try BridgeField.string(record, "text", limit: ReaderBridgeCodec.sourceLimit, empty: true)
            let expected = try BridgeField.string(record, "expected", limit: ReaderBridgeCodec.sourceLimit, empty: true)
            guard expected.utf16.count == range.end - range.start else { throw ReaderBridgeError.invalid("expected length") }
            edits.append(.init(start: range.start, end: range.end, text: text, expected: expected))
            previousEnd = range.end
        }
        self.init(baseGeneration: base, generation: generation, origin: origin,
                  operationId: try BridgeField.optionalString(fields, "operationId", limit: 256), edits: edits)
    }
}

public struct ReaderBridgeMessage {
    public let type: ReaderBridgeMessageType
    public let id: String?
    /// Validated wire fields, excluding the envelope's v, type and id.
    public let fields: [String: Any]
    public let change: ReaderBridgeChange?
    public let pageState: ReaderBridgePageState?
}

/// Validates bridge envelopes and applies the transport's independent UTF-8 byte budgets.
public enum ReaderBridgeCodec {
    public static let messageLimit = 256 * 1024
    public static let sourceLimit = 2 * 1024 * 1024
    public static let renderedLimit = 16 * 1024 * 1024
    public static let editListLimit = 5 * 1024 * 1024
    public static let editLimit = 4096
    public static let maxInteger = 9_007_199_254_740_991

    public static func decode(body: Any) throws -> ReaderBridgeMessage {
        guard let object = body as? [String: Any], JSONSerialization.isValidJSONObject(object) else {
            throw ReaderBridgeError.invalid("object")
        }
        return try decodeObject(object)
    }

    public static func decode(data: Data) throws -> ReaderBridgeMessage {
        // The small allowance covers the edits member's key and JSON separators. Group
        // validation below still enforces each exact budget independently.
        guard data.count <= editListLimit + messageLimit + 16 else { throw ReaderBridgeError.oversized }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ReaderBridgeError.invalid("object")
        }
        if object["type"] as? String != "edits", data.count > messageLimit { throw ReaderBridgeError.oversized }
        return try decodeObject(object)
    }

    private static func decodeObject(_ object: [String: Any]) throws -> ReaderBridgeMessage {
        guard try BridgeField.integer(object, "v") == 1 else { throw ReaderBridgeError.invalid("v") }
        guard let type = ReaderBridgeMessageType(rawValue: try BridgeField.string(object, "type", limit: 32)) else {
            throw ReaderBridgeError.invalid("type")
        }
        if type == .edits { try validateArrayGroup(object, key: "edits", limit: editListLimit) }
        else { try validateJSONSize(object, limit: messageLimit) }
        let id = try BridgeField.optionalString(object, "id", limit: 256)
        var fields = object
        fields.removeValue(forKey: "v"); fields.removeValue(forKey: "type"); fields.removeValue(forKey: "id")
        var change: ReaderBridgeChange?
        var pageState: ReaderBridgePageState?
        switch type {
        case .ready:
            try BridgeField.keys(fields, allowed: ["version", "capabilities"])
            _ = try BridgeField.string(fields, "version", limit: 256)
            let capabilities = try BridgeField.object(fields, "capabilities")
            guard capabilities.count <= 32 else { throw ReaderBridgeError.invalid("capabilities") }
            for (key, value) in capabilities {
                guard key.utf8.count <= 80, !key.isEmpty, BridgeField.isBool(value) else {
                    throw ReaderBridgeError.invalid("capabilities")
                }
            }
        case .state:
            try BridgeField.keys(fields, allowed: ["lock", "overlay", "canUndo", "canRedo", "hasSelection", "findOpen", "held", "activeBlock", "scroll", "find", "selection"])
            pageState = try ReaderBridgePageState(fields: fields)
        case .edits:
            try BridgeField.keys(fields, allowed: ["baseGeneration", "generation", "origin", "operationId", "edits"])
            change = try ReaderBridgeChange(fields: fields)
        case .agentRefused:
            try BridgeField.keys(fields, allowed: ["operationId", "reason", "range"])
            _ = try BridgeField.string(fields, "operationId", limit: 256)
            try BridgeField.choice(fields, "reason", values: ["held", "stale"])
            _ = try BridgeField.optionalRange(fields, "range")
        case .render:
            try BridgeField.keys(fields, allowed: ["generation"])
            _ = try BridgeField.integer(fields, "generation")
        case .lock:
            try BridgeField.keys(fields, allowed: ["lock", "copy"])
            try BridgeField.choice(fields, "lock", values: ["reading", "writing"])
            _ = try BridgeField.bool(fields, "copy")
        case .prompt:
            try BridgeField.keys(fields, allowed: ["requestId", "threadId", "quote", "quoteRange", "text", "generation"])
            _ = try BridgeField.string(fields, "requestId", limit: 256)
            _ = try BridgeField.string(fields, "threadId", limit: 256)
            _ = try BridgeField.optionalString(fields, "quote", limit: 64 * 1024, empty: true)
            _ = try BridgeField.optionalRange(fields, "quoteRange")
            _ = try BridgeField.string(fields, "text", limit: 64 * 1024)
            _ = try BridgeField.integer(fields, "generation")
        case .command:
            try BridgeField.keys(fields, allowed: ["name", "args"])
            try validateCommand(fields)
        case .query:
            try validateQuery(fields)
        case .log:
            try BridgeField.keys(fields, allowed: ["level", "message"])
            try BridgeField.choice(fields, "level", values: ["debug", "info", "warn", "error"])
            _ = try BridgeField.string(fields, "message", limit: 8192, empty: true)
        }
        return ReaderBridgeMessage(type: type, id: id, fields: fields, change: change, pageState: pageState)
    }

    /// Validates a complete native-to-page envelope before WebKit receives it.
    public static func validateNativeEnvelope(_ fields: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(fields) else { throw ReaderBridgeError.invalid("object") }
        guard try BridgeField.integer(fields, "v") == 1 else { throw ReaderBridgeError.invalid("v") }
        let type = try BridgeField.string(fields, "type", limit: 32)
        _ = try BridgeField.optionalString(fields, "id", limit: 256)
        switch type {
        case "document":
            guard let source = fields["source"] as? String else { throw ReaderBridgeError.invalid("source") }
            guard source.utf8.count <= sourceLimit else { throw ReaderBridgeError.oversized }
            var withoutSource = fields
            withoutSource.removeValue(forKey: "source")
            try validateArrayGroup(withoutSource, key: "blocks", limit: renderedLimit)
        case "renderResult":
            try validateArrayGroup(fields, key: "blocks", limit: renderedLimit)
        case "agentApply":
            try validateArrayGroup(fields, key: "edits", limit: editListLimit)
        case "ack", "refused", "claim", "release", "promptState", "saveState", "command", "notice":
            try validateJSONSize(fields, limit: messageLimit)
        default: throw ReaderBridgeError.invalid("type")
        }
    }

    /// The reply includes v/type/ok/id. Only its request grants a large render or review group.
    public static func validateReply(_ fields: [String: Any], request: ReaderBridgeMessage) throws {
        guard JSONSerialization.isValidJSONObject(fields) else { throw ReaderBridgeError.invalid("object") }
        guard try BridgeField.integer(fields, "v") == 1,
              try BridgeField.string(fields, "type", limit: 32) == "reply" else { throw ReaderBridgeError.invalid("reply") }
        let id = try BridgeField.optionalString(fields, "id", limit: 256)
        guard id == request.id else { throw ReaderBridgeError.invalid("reply id") }
        let ok = try BridgeField.bool(fields, "ok")
        if !ok { try validateJSONSize(fields, limit: messageLimit); return }
        if request.type == .render {
            try validateArrayGroup(fields, key: "blocks", limit: renderedLimit)
        } else if request.type == .query, request.fields["kind"] as? String == "review" {
            guard let html = fields["html"] as? String else { throw ReaderBridgeError.invalid("html") }
            guard html.utf8.count <= renderedLimit else { throw ReaderBridgeError.oversized }
            var metadata = fields
            metadata.removeValue(forKey: "html")
            try validateJSONSize(metadata, limit: messageLimit)
        } else {
            try validateJSONSize(fields, limit: messageLimit)
        }
    }

    private static func validateArrayGroup(_ fields: [String: Any], key: String, limit: Int) throws {
        guard let records = fields[key] as? [[String: Any]] else { throw ReaderBridgeError.invalid(key) }
        try validateJSONSize(records, limit: limit)
        var metadata = fields
        metadata.removeValue(forKey: key)
        try validateJSONSize(metadata, limit: messageLimit)
    }

    private static func validateJSONSize(_ value: Any, limit: Int) throws {
        guard JSONSerialization.isValidJSONObject(value) else { throw ReaderBridgeError.invalid("JSON") }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])
        guard data.count <= limit else { throw ReaderBridgeError.oversized }
    }

    private static func validateQuery(_ fields: [String: Any]) throws {
        let kind = try BridgeField.string(fields, "kind", limit: 32)
        switch kind {
        case "details":
            try BridgeField.keys(fields, allowed: ["kind"])
        case "review":
            try BridgeField.keys(fields, allowed: ["kind", "against"])
            if let value = fields["against"] as? String {
                guard value == "previous" || value == "base" else { throw ReaderBridgeError.invalid("against") }
            } else { _ = try BridgeField.integer(fields, "against") }
        case "image":
            try BridgeField.keys(fields, allowed: ["kind", "index"])
            _ = try BridgeField.integer(fields, "index")
        case "library":
            try BridgeField.keys(fields, allowed: ["kind", "collection", "query", "cursor", "match"])
            try BridgeField.choice(fields, "collection", values: ["drafts", "recent", "published"])
            if fields["match"] != nil { try BridgeField.choice(fields, "match", values: ["title", "source"]) }
            _ = try BridgeField.optionalString(fields, "query", limit: 8192, empty: true)
            _ = try BridgeField.optionalString(fields, "cursor", limit: 4096)
        default: throw ReaderBridgeError.invalid("query kind")
        }
    }

    private static func validateCommand(_ fields: [String: Any]) throws {
        let name = try BridgeField.string(fields, "name", limit: 32)
        let args: [String: Any]
        if fields["args"] != nil { args = try BridgeField.object(fields, "args") } else { args = [:] }
        switch name {
        case "returnFocus", "close", "showOriginal", "details", "newDraft", "chooseStore":
            try BridgeField.keys(args, allowed: [])
        case "pickImage":
            try BridgeField.keys(args, allowed: ["generation", "range"])
            _ = try BridgeField.integer(args, "generation")
            let sourceRange = try BridgeField.object(args, "range")
            try BridgeField.keys(sourceRange, allowed: ["start", "end"])
            _ = try BridgeField.range(sourceRange)
        case "openLink":
            try BridgeField.keys(args, allowed: ["href"])
            _ = try BridgeField.string(args, "href", limit: 8192)
        case "copy":
            try BridgeField.keys(args, allowed: ["text", "markdown"])
            _ = try BridgeField.string(args, "text", limit: messageLimit, empty: true)
            _ = try BridgeField.optionalString(args, "markdown", limit: messageLimit, empty: true)
        case "export":
            try BridgeField.keys(args, allowed: ["format"])
            try BridgeField.choice(args, "format", values: ["archive", "sharing", "pdf"])
        case "open":
            try BridgeField.keys(args, allowed: ["ref"])
            _ = try BridgeField.optionalString(args, "ref", limit: 8192)
        case "showRevision", "reviewChanges", "inspectImage":
            let key = name == "showRevision" ? "n" : name == "reviewChanges" ? "against" : "index"
            try BridgeField.keys(args, allowed: [key])
            _ = try BridgeField.integer(args, key)
        case "saveSettings":
            try BridgeField.keys(args, allowed: ["patch"])
            let patch = try BridgeField.object(args, "patch")
            try BridgeField.keys(patch, allowed: ["textSize", "codeWrap", "appearance", "outlineWidth", "outlineOpen"])
            if patch["textSize"] != nil {
                let size = try BridgeField.number(patch, "textSize", magnitude: .greatestFiniteMagnitude)
                guard size > 0 else { throw ReaderBridgeError.invalid("textSize") }
            }
            for key in ["codeWrap", "outlineOpen"] where patch[key] != nil { _ = try BridgeField.bool(patch, key) }
            if patch["appearance"] != nil { try BridgeField.choice(patch, "appearance", values: ["system", "light", "dark"]) }
            if patch["outlineWidth"] != nil {
                let width = try BridgeField.number(patch, "outlineWidth", magnitude: 4096)
                guard width >= 0 else { throw ReaderBridgeError.invalid("outlineWidth") }
            }
        default: throw ReaderBridgeError.invalid("command")
        }
    }
}

/// A native mirror changes only after every edit passes generation, scalar-boundary and exact-byte checks.
public struct ReaderSourceMirror: Sendable {
    public private(set) var source: String
    public private(set) var generation: Int
    public var digest: String { Digest.sha256(Data(source.utf8)) }

    public init(source: String, generation: Int = 0) throws {
        guard source.utf8.count <= ReaderBridgeCodec.sourceLimit else { throw ReaderBridgeError.oversized }
        guard generation >= 0, generation <= ReaderBridgeCodec.maxInteger else { throw ReaderBridgeError.invalid("generation") }
        self.source = source; self.generation = generation
    }

    public mutating func apply(_ change: ReaderBridgeChange) throws {
        guard change.baseGeneration == generation, generation < ReaderBridgeCodec.maxInteger,
              change.generation == generation + 1 else { throw ReaderBridgeError.staleGeneration }
        guard !change.edits.isEmpty, change.edits.count <= ReaderBridgeCodec.editLimit else { throw ReaderBridgeError.invalid("edits") }
        let units = Array(source.utf16)
        var previousEnd = 0
        var output: [UInt16] = []
        for edit in change.edits {
            guard edit.start >= previousEnd, edit.end >= edit.start, edit.end <= units.count,
                  Self.isBoundary(edit.start, in: units), Self.isBoundary(edit.end, in: units) else {
                throw ReaderBridgeError.invalidRange
            }
            guard units[edit.start..<edit.end].elementsEqual(edit.expected.utf16) else { throw ReaderBridgeError.expectedMismatch }
            guard edit.text.utf8.count <= ReaderBridgeCodec.sourceLimit else { throw ReaderBridgeError.oversized }
            output.append(contentsOf: units[previousEnd..<edit.start])
            output.append(contentsOf: edit.text.utf16)
            guard output.count <= ReaderBridgeCodec.sourceLimit else { throw ReaderBridgeError.oversized }
            previousEnd = edit.end
        }
        output.append(contentsOf: units[previousEnd...])
        let next = String(decoding: output, as: UTF16.self)
        guard next.utf8.count <= ReaderBridgeCodec.sourceLimit else { throw ReaderBridgeError.oversized }
        source = next
        generation = change.generation
    }

    private static func isBoundary(_ offset: Int, in units: [UInt16]) -> Bool {
        guard offset > 0, offset < units.count else { return true }
        return !(0xD800...0xDBFF).contains(units[offset - 1]) || !(0xDC00...0xDFFF).contains(units[offset])
    }
}

public enum ReaderPageCommand: String, CaseIterable, Sendable {
    case undo, redo, find, findNext, findPrevious, replace, zoomIn, zoomOut, zoomReset
    case toggleOutline, toggleLock, askSelection, askDocument, copyMarkdown, copyPassage, open, selectAll, escape, format
    case showReview, showDetails, inspectImage, showSource, showLibrary

    public func isEnabled(state: ReaderBridgePageState?, documentLoaded: Bool) -> Bool {
        if self == .open { return true }
        guard documentLoaded, let state else { return false }
        switch self {
        case .undo: return state.canUndo
        case .redo: return state.canRedo
        case .askSelection, .copyPassage: return state.hasSelection
        case .replace: return state.lock == .writing
        case .format: return state.lock == .writing && state.activeBlock != nil
        default: return true
        }
    }
}

private enum BridgeField {
    static func keys(_ object: [String: Any], allowed: Set<String>) throws {
        guard Set(object.keys).isSubset(of: allowed) else { throw ReaderBridgeError.invalid("unknown field") }
    }
    static func isBool(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }
    static func bool(_ object: [String: Any], _ key: String) throws -> Bool {
        guard let value = object[key], isBool(value), let number = value as? NSNumber else { throw ReaderBridgeError.invalid(key) }
        return number.boolValue
    }
    static func number(_ object: [String: Any], _ key: String, magnitude: Double) throws -> Double {
        guard let number = object[key] as? NSNumber, !isBool(number) else { throw ReaderBridgeError.invalid(key) }
        let value = number.doubleValue
        guard value.isFinite, abs(value) <= magnitude else { throw ReaderBridgeError.invalid(key) }
        return value
    }
    static func integer(_ object: [String: Any], _ key: String, max: Int = ReaderBridgeCodec.maxInteger) throws -> Int {
        let value = try number(object, key, magnitude: Double(max))
        guard value >= 0, value.rounded(.towardZero) == value else { throw ReaderBridgeError.invalid(key) }
        return Int(value)
    }
    static func string(_ object: [String: Any], _ key: String, limit: Int, empty: Bool = false) throws -> String {
        guard let value = object[key] as? String, (empty || !value.isEmpty), value.utf8.count <= limit else { throw ReaderBridgeError.invalid(key) }
        return value
    }
    static func optionalString(_ object: [String: Any], _ key: String, limit: Int, empty: Bool = false) throws -> String? {
        guard object[key] != nil else { return nil }
        return try string(object, key, limit: limit, empty: empty)
    }
    static func object(_ object: [String: Any], _ key: String) throws -> [String: Any] {
        guard let value = object[key] as? [String: Any] else { throw ReaderBridgeError.invalid(key) }
        return value
    }
    static func choice(_ object: [String: Any], _ key: String, values: Set<String>) throws {
        guard values.contains(try string(object, key, limit: 80)) else { throw ReaderBridgeError.invalid(key) }
    }
    static func range(_ object: [String: Any]) throws -> ReaderBridgeRange {
        let start = try integer(object, "start", max: ReaderBridgeCodec.sourceLimit)
        let end = try integer(object, "end", max: ReaderBridgeCodec.sourceLimit)
        guard start <= end else { throw ReaderBridgeError.invalid("range") }
        return .init(start: start, end: end)
    }
    static func optionalRange(_ object: [String: Any], _ key: String) throws -> ReaderBridgeRange? {
        guard let raw = object[key], !(raw is NSNull) else { return nil }
        guard let value = raw as? [String: Any] else { throw ReaderBridgeError.invalid(key) }
        try keys(value, allowed: ["start", "end"])
        return try range(value)
    }
}
