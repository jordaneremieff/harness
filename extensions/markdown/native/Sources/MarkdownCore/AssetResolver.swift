import Foundation

/// A local image that passed containment, type and size checks.
public struct ResolvedAsset: Sendable, Equatable {
    /// Canonical path of the file.
    public var path: String
    /// Canonical document-scoped root the file must stay inside.
    public var root: String
    public var mediaType: String
    public var bytes: Int

    /// Reads the bytes again with the same checks, so that a file replaced after resolution
    /// (for example by a symlink) cannot escape the root. The file is opened without following a
    /// symbolic link and must be a regular file.
    public func readData() throws -> Data {
        guard FileAccess.canonicalPath(path) == path, FileAccess.isInside(path, root: root) else { throw StoreError.outsideStore }
        return try FileAccess.readRegularFile(URL(fileURLWithPath: path), limit: Limits.assetBytes, missing: .notFound(path))
    }
}

public enum AssetResolution: Sendable, Equatable {
    case local(ResolvedAsset)
    case external(URL)
    /// An image carried inside the source as a `data:` address, shown inline.
    case embedded(String)
    case unavailable(reason: String)
}

public protocol AssetResolving: Sendable {
    func resolve(_ reference: String) -> AssetResolution
}

public enum MediaTypes {
    public static let images: [String: String] = [
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
    ]
    static let embeddedImages = ["image/png", "image/jpeg", "image/gif", "image/webp"]
    /// Largest `data:` image address shown inline.
    public static let embeddedLimit = 1024 * 1024
}

enum References {
    /// The reference as a web URL, when it is one. A protocol-relative reference counts as https.
    static func webURL(_ reference: String) -> URL? {
        let candidate = reference.hasPrefix("//") ? "https:" + reference : reference
        guard let url = URL(string: candidate), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host?.isEmpty == false else { return nil }
        return url
    }

    /// True when the reference names a scheme (`x:`) rather than a relative path.
    static func hasScheme(_ reference: String) -> Bool {
        guard let colon = reference.firstIndex(of: ":") else { return false }
        let head = reference[..<colon]
        guard let first = head.first, first.isLetter else { return false }
        return head.allSatisfy { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "-" || $0 == "." }
    }

    /// The reader's own rule for every image address that is not a relative path. A nil result
    /// means the reference is a relative path for the document's resolver.
    static func classifyNonRelative(_ reference: String) -> AssetResolution? {
        if let url = webURL(reference) { return .external(url) }
        if reference.lowercased().hasPrefix("data:") {
            let header = reference.prefix(64).lowercased()
            guard MediaTypes.embeddedImages.contains(where: { header.hasPrefix("data:\($0);") || header.hasPrefix("data:\($0),") }) else {
                return .unavailable(reason: "unsupported-type")
            }
            return reference.utf8.count <= MediaTypes.embeddedLimit ? .embedded(reference) : .unavailable(reason: "too-large")
        }
        if hasScheme(reference) { return .unavailable(reason: "unsupported-scheme") }
        if reference.hasPrefix("/") { return .unavailable(reason: "outside-root") }
        if reference.isEmpty { return .unavailable(reason: "missing") }
        return nil
    }

    /// Checks a candidate path against a canonical root and the image limits.
    static func check(_ candidate: String, root: String) -> AssetResolution {
        let path = FileAccess.canonicalPath(candidate)
        guard FileAccess.isInside(path, root: root) else { return .unavailable(reason: "outside-root") }
        guard FileManager.default.fileExists(atPath: path) else { return .unavailable(reason: "missing") }
        guard FileAccess.isRegularFile(path) else { return .unavailable(reason: "unsupported-type") }
        guard let mediaType = MediaTypes.images[(path as NSString).pathExtension.lowercased()] else {
            return .unavailable(reason: "unsupported-type")
        }
        guard let bytes = FileAccess.fileSize(path), bytes <= Limits.assetBytes else { return .unavailable(reason: "too-large") }
        return .local(ResolvedAsset(path: path, root: root, mediaType: mediaType, bytes: bytes))
    }
}

/// Resolves images of a stored revision. Only `retained` inventory entries resolve to files, and
/// only under the revision's own `assets` directory, which must not be a symbolic link; every
/// other image follows the reader's own rule, with the recorded reason when the inventory has one.
public struct StoredAssetResolver: AssetResolving {
    /// The canonical `assets` directory, or nil when it is not the expected directory.
    private let assetsRoot: String?
    private let items: [String: ReferenceItem]
    private let kind: DocumentKind

    /// `revisionDirectory` is the canonical revision directory that the store verified.
    public init(revisionDirectory: URL, references: ReferenceInventory?, kind: DocumentKind) {
        let expected = revisionDirectory.appendingPathComponent("assets").path
        self.assetsRoot = FileAccess.canonicalPath(expected) == expected ? expected : nil
        var items: [String: ReferenceItem] = [:]
        for item in references?.items ?? [] where item.kind == .image && items[item.reference] == nil {
            items[item.reference] = item
        }
        self.items = items
        self.kind = kind
    }

    public func resolve(_ reference: String) -> AssetResolution {
        if let own = References.classifyNonRelative(reference) { return own }
        guard let item = items[reference] else {
            return .unavailable(reason: kind == .file ? "not-captured" : "no-base")
        }
        if item.state == "retained" { return retained(item) }
        return .unavailable(reason: item.reason ?? "unavailable")
    }

    private func retained(_ item: ReferenceItem) -> AssetResolution {
        guard let assetsRoot else { return .unavailable(reason: "outside-root") }
        guard let file = item.file, file.hasPrefix("assets/") else { return .unavailable(reason: "invalid") }
        let name = String(file.dropFirst("assets/".count))
        let parts = name.split(separator: ".")
        guard parts.count == 2, parts[0].utf8.count == 64,
              parts[0].utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else {
            return .unavailable(reason: "invalid")
        }
        return References.check((assetsRoot as NSString).appendingPathComponent(name), root: assetsRoot)
    }
}

/// Resolves relative image references of a plain Markdown file against the file's directory.
/// Each reference is checked separately; the directory itself is never exposed.
public struct DirectoryAssetResolver: AssetResolving {
    private let root: String

    public init(directory: URL) {
        self.root = FileAccess.canonicalPath(directory.path)
    }

    public func resolve(_ reference: String) -> AssetResolution {
        if let own = References.classifyNonRelative(reference) { return own }
        var path = reference
        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<cut]) }
        guard !path.isEmpty else { return .unavailable(reason: "missing") }
        guard let decoded = path.removingPercentEncoding else { return .unavailable(reason: "invalid") }
        return References.check((root as NSString).appendingPathComponent(decoded), root: root)
    }
}

/// Text sources have no base directory: relative images are unavailable.
public struct NoAssetResolver: AssetResolving {
    public init() {}

    public func resolve(_ reference: String) -> AssetResolution {
        References.classifyNonRelative(reference) ?? .unavailable(reason: "no-base")
    }
}
