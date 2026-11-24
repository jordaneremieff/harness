import Foundation

/// What one pane shows: a window of one application, chosen on the command line.
public struct PaneRequest: Equatable, Sendable {
    /// An application name, a bundle identifier, or an absolute path to an application bundle.
    public var app: String
    /// An http or https address that a new browser window opens.
    public var url: URL?
    /// Text that the title of an existing window contains.
    public var window: String?

    public init(app: String, url: URL? = nil, window: String? = nil) {
        self.app = app
        self.url = url
        self.window = window
    }

    public struct Invalid: Error, Equatable, CustomStringConvertible {
        public var description: String
    }

    public static let usage = "usage: AppPane --app <name, bundle ID or .app path> [--url <http or https address> | --window <title text>]"

    public static func parse(_ arguments: [String]) throws(Invalid) -> PaneRequest {
        var app: String?
        var url: URL?
        var window: String?
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard index + 1 < arguments.count else { throw Invalid(description: "\(flag) needs a value. \(usage)") }
            let value = arguments[index + 1]
            switch flag {
            case "--app" where app == nil:
                guard let text = Self.text(value, limit: 1024) else { throw Invalid(description: "The application is empty or too long.") }
                app = text
            case "--url" where url == nil:
                url = try address(value)
            case "--window" where window == nil:
                guard let text = Self.text(value, limit: 256) else { throw Invalid(description: "The window title text is empty or too long.") }
                window = text
            default:
                throw Invalid(description: "Unexpected argument \(flag). \(usage)")
            }
            index += 2
        }
        guard let app else { throw Invalid(description: usage) }
        if url != nil, window != nil { throw Invalid(description: "Use --url or --window, not both.") }
        return PaneRequest(app: app, url: url, window: window)
    }

    /// An http or https address of at most 2,048 characters without whitespace or control characters.
    public static func address(_ value: String) throws(Invalid) -> URL {
        guard value.count <= 2048,
              !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              let url = URL(string: value), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host(), !host.isEmpty else {
            throw Invalid(description: "The address must be an http or https URL.")
        }
        return url
    }

    /// Trimmed text without control characters, or nil when it is empty or longer than `limit`.
    static func text(_ value: String, limit: Int) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.count <= limit,
              !trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return trimmed
    }
}
