import Foundation

/// One application that a pane can show.
public struct AppEntry: Codable, Equatable, Sendable {
    public var name: String
    public var path: String
    public var bundleIdentifier: String?
    public var running: Bool
    /// Whether the pane opens a new window of this browser for itself.
    public var browser: Bool

    public init(name: String, path: String, bundleIdentifier: String?, running: Bool) {
        self.name = name
        self.path = path
        self.bundleIdentifier = bundleIdentifier
        self.running = running
        browser = BrowserScripting(bundleIdentifier: bundleIdentifier) != nil
    }
}

public enum AppMatch: Equatable, Sendable {
    case found(AppEntry)
    case ambiguous([AppEntry])
    case missing
}

public enum Applications {
    /// Whether the text has the form of a bundle identifier rather than a name.
    public static func isBundleIdentifier(_ text: String) -> Bool {
        text.range(of: #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil
    }

    /// One entry per application path, running applications first, each group sorted by name.
    public static func merged(_ entries: [AppEntry]) -> [AppEntry] {
        var byPath: [String: AppEntry] = [:]
        for entry in entries {
            if var known = byPath[entry.path] {
                known.running = known.running || entry.running
                byPath[entry.path] = known
            } else {
                byPath[entry.path] = entry
            }
        }
        return byPath.values.sorted {
            if $0.running != $1.running { return $0.running }
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            return order == .orderedSame ? $0.path < $1.path : order == .orderedAscending
        }
    }

    /// Finds the application that a person means by `query`: an exact bundle identifier or name
    /// first, then names whose words start with the query's words in order, such as "brave" for
    /// "Brave Browser" or "activity" for "Activity Monitor". A running application wins over an
    /// installed one with the same name. Several different applications are ambiguous.
    public static func match(_ query: String, in entries: [AppEntry]) -> AppMatch {
        let candidates = merged(entries)
        let wanted = normalized(query)
        guard !wanted.isEmpty else { return .missing }
        if isBundleIdentifier(query) {
            let identified = candidates.filter { $0.bundleIdentifier?.lowercased() == query.lowercased() }
            if let first = identified.first { return .found(first) }
        }
        let exact = candidates.filter { normalized($0.name) == wanted }
        if let first = exact.first { return .found(first) }
        let words = wanted.split(separator: " ").map(String.init)
        let partial = candidates.filter { startsWithWords(normalized($0.name), words) }
        switch partial.count {
        case 0: return .missing
        case 1: return .found(partial[0])
        default:
            let running = partial.filter(\.running)
            if running.count == 1 { return .found(running[0]) }
            return .ambiguous(Array(partial.prefix(8)))
        }
    }

    static func normalized(_ name: String) -> String {
        var text = name.lowercased()
        if text.hasSuffix(".app") { text.removeLast(4) }
        return text.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" }).joined(separator: " ")
    }

    /// Whether the query words start successive words of the name, in order.
    static func startsWithWords(_ name: String, _ words: [String]) -> Bool {
        let parts = name.split(separator: " ").map(String.init)
        var index = 0
        for word in words {
            while index < parts.count, !parts[index].hasPrefix(word) { index += 1 }
            guard index < parts.count else { return false }
            index += 1
        }
        return true
    }
}

/// The scripting family of a browser whose windows a pane can open by Apple Events.
public enum BrowserScripting: Equatable, Sendable {
    case chromium
    case safari

    public init?(bundleIdentifier: String?) {
        switch bundleIdentifier?.lowercased() {
        case "com.brave.browser", "com.brave.browser.beta", "com.brave.browser.nightly",
             "com.google.chrome", "com.google.chrome.beta", "com.google.chrome.dev", "com.google.chrome.canary",
             "com.google.chrome.for.testing", "com.microsoft.edgemac", "com.vivaldi.vivaldi", "org.chromium.chromium":
            self = .chromium
        case "com.apple.safari":
            self = .safari
        default:
            return nil
        }
    }

    /// Chromium specifies windows by a text ID, while Safari uses an integer ID.
    public enum WindowID: Equatable, Sendable {
        case text(String)
        case integer(Int32)
    }

    public func windowID(_ id: String) -> WindowID? {
        guard !id.isEmpty, id.utf8.allSatisfy({ (48...57).contains($0) }), id.first != "0" else { return nil }
        switch self {
        case .chromium: return .text(id)
        case .safari: return Int32(id).map(WindowID.integer)
        }
    }
}
