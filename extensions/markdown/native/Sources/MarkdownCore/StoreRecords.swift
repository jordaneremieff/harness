import Foundation

/// Records of the private document store, format version 1. The TypeScript store writer owns the
/// format; this module only reads it. Unknown members are ignored so that the writer can add
/// optional members without a reader change.
public enum StoreFormat {
    public static let version = 1
    public static let manifestName = "store.json"
    /// Published documents.
    public static let documentsDirectory = "documents"
    /// Response and file snapshots.
    public static let snapshotsDirectory = "snapshots"
    public static let opensDirectory = "opens"
}

public struct StoreManifest: Codable, Sendable, Equatable {
    public var version: Int
    public var storeId: String
}

public enum DocumentKind: String, Codable, Sendable {
    case published
    case response
    case file

    /// The collection directory that holds documents of this kind.
    public var collection: StoreCollection { self == .published ? .published : .snapshots }
}

public enum StoreCollection: String, Sendable, CaseIterable {
    case published
    case snapshots

    public var directory: String {
        self == .published ? StoreFormat.documentsDirectory : StoreFormat.snapshotsDirectory
    }
}

public struct DocumentRecord: Codable, Sendable, Equatable {
    public var version: Int
    public var id: String
    public var kind: DocumentKind
    public var title: String
    public var createdAt: String
    public var updatedAt: String
    public var revision: Int
    public var digest: String
    public var bytes: Int
}

public struct Completeness: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable {
        case complete
        case partial
    }

    public var state: State
    public var reason: String?
    public var note: String?

    public init(state: State, reason: String? = nil, note: String? = nil) {
        self.state = state
        self.reason = reason
        self.note = note
    }

    public static let complete = Completeness(state: .complete)
}

public struct ContentOrigin: Codable, Sendable, Equatable {
    public struct Part: Codable, Sendable, Equatable {
        public var chars: Int
    }

    public var kind: String
    public var host: String?
    public var session: String?
    public var conversation: String?
    public var entry: String?
    public var model: String?
    public var path: String?
    public var cwd: String?
    public var capturedAt: String?
    public var parts: [Part]?
}

/// One destination of the reference inventory that publication records with a revision.
public struct ReferenceItem: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case image
        case link
    }

    public var kind: Kind
    public var reference: String
    /// `retained`, `external`, `embedded`, `unavailable` for images; `local-only` for links.
    public var state: String
    public var file: String?
    public var mediaType: String?
    public var bytes: Int?
    public var digest: String?
    public var reason: String?
}

public struct ReferenceInventory: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable {
        case inspected
        case uninspected
    }

    public var state: State
    public var truncated: Bool?
    public var omitted: Int?
    public var items: [ReferenceItem]?
}

public struct RevisionRecord: Codable, Sendable, Equatable {
    public var version: Int
    public var document: String
    public var revision: Int
    public var title: String
    public var createdAt: String
    public var digest: String
    public var bytes: Int
    public var completeness: Completeness?
    public var contentOrigin: ContentOrigin?
    public var references: ReferenceInventory?
    public var selfContained: Bool?
}

/// A JSON value kept opaque, for members another owner defines.
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// The terminal a reader window was opened from. It belongs to the open request and the window,
/// never to document metadata. `exact` is owned by the terminal's helper and kept opaque.
public struct LaunchOrigin: Codable, Sendable, Hashable {
    public struct Application: Codable, Sendable, Hashable {
        public var bundleId: String
    }

    public var version: Int
    public var terminal: String
    public var application: Application
    public var exact: JSONValue?

    public init(terminal: String, bundleId: String, exact: JSONValue? = nil) {
        self.version = 1
        self.terminal = terminal
        self.application = Application(bundleId: bundleId)
        self.exact = exact
    }

    public static let rexTerminal = "Rex"
    public static let rexBundleId = "com.superlogical.rex"

    /// Version 1 of the terminal-origin contract names only Rex, with its fixed bundle ID.
    public var isUsable: Bool {
        version == 1 && terminal == Self.rexTerminal && application.bundleId == Self.rexBundleId
    }
}

/// An explicit request to show one exact revision, written by the local opener into
/// `<root>/opens/`. The reader removes it once accepted.
public struct OpenRequest: Codable, Sendable, Equatable {
    public var version: Int
    public var storeId: String
    public var document: String
    public var revision: Int
    public var digest: String
    public var requestedAt: String?
    public var launchOrigin: LaunchOrigin?

    public init(storeId: String, document: String, revision: Int, digest: String, requestedAt: String? = nil, launchOrigin: LaunchOrigin? = nil) {
        self.version = StoreFormat.version
        self.storeId = storeId
        self.document = document
        self.revision = revision
        self.digest = digest
        self.requestedAt = requestedAt
        self.launchOrigin = launchOrigin
    }

    private enum CodingKeys: String, CodingKey {
        case version, storeId, document, revision, digest, requestedAt, launchOrigin
    }

    /// A malformed launch origin is dropped instead of refusing the open: the document still
    /// opens, without a return action.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        storeId = try container.decode(String.self, forKey: .storeId)
        document = try container.decode(String.self, forKey: .document)
        revision = try container.decode(Int.self, forKey: .revision)
        digest = try container.decode(String.self, forKey: .digest)
        requestedAt = try container.decodeIfPresent(String.self, forKey: .requestedAt)
        launchOrigin = try? container.decodeIfPresent(LaunchOrigin.self, forKey: .launchOrigin)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(storeId, forKey: .storeId)
        try container.encode(document, forKey: .document)
        try container.encode(revision, forKey: .revision)
        try container.encode(digest, forKey: .digest)
        try container.encodeIfPresent(requestedAt, forKey: .requestedAt)
        try container.encode(launchOrigin, forKey: .launchOrigin)
    }
}

public enum Identifiers {
    /// `md-` followed by 20 lowercase hexadecimal digits.
    public static func isDocumentId(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 23, value.hasPrefix("md-") else { return false }
        return bytes[3...].allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    public static func isStoreId(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return bytes.count == 32 && bytes.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }
}
