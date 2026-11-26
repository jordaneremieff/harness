import Foundation

struct FindOptions: Equatable, Sendable {
    var regularExpression = false
    var caseSensitive = false
    var wholeWord = false
    var inSelection = false
    var wrap = true
    var highlight = true
}

struct FindMatches: Sendable {
    struct Match: Sendable {
        var range: NSRange
        var replacement: String
    }

    var matches: [Match] = []
    var problem: String?
    var limited = false

    static func search(_ query: String, in text: String, options: FindOptions,
                       selection: [NSRange] = [], replacement: String = "", limit: Int = 100_000) -> Self {
        guard !query.isEmpty, limit > 0 else { return Self() }
        let pattern = options.regularExpression ? query : NSRegularExpression.escapedPattern(for: query)
        let expression = options.wholeWord ? "(?<!\\w)(?:\(pattern))(?!\\w)" : pattern
        let regex: NSRegularExpression
        do { regex = try NSRegularExpression(pattern: expression, options: options.caseSensitive ? [.anchorsMatchLines] : [.anchorsMatchLines, .caseInsensitive]) }
        catch { return Self(problem: "Invalid regular expression") }
        let length = text.utf16.count
        let scopes = options.inSelection ? normalized(selection, length: length) : [NSRange(location: 0, length: length)]
        var result = Self()
        for scope in scopes {
            regex.enumerateMatches(in: text, options: [.withTransparentBounds, .withoutAnchoringBounds, .reportProgress], range: scope) { found, _, stop in
                if Task.isCancelled { stop.pointee = true; return }
                guard let found else { return }
                if result.matches.count >= limit { result.limited = true; stop.pointee = true; return }
                let value = options.regularExpression ? regex.replacementString(for: found, in: text, offset: 0, template: replacement) : replacement
                result.matches.append(Match(range: found.range, replacement: value))
            }
            if result.limited || Task.isCancelled { break }
        }
        return result
    }

    private static func normalized(_ scopes: [NSRange], length: Int) -> [NSRange] {
        var merged: [NSRange] = []
        for range in scopes.sorted(by: { $0.location < $1.location }) {
            guard range.location >= 0, range.location < length, range.length > 0 else { continue }
            let end = range.location + min(range.length, length - range.location)
            if let previous = merged.last, NSMaxRange(previous) > range.location {
                merged[merged.count - 1].length = max(end, NSMaxRange(previous)) - previous.location
            } else { merged.append(NSRange(location: range.location, length: end - range.location)) }
        }
        return merged
    }

    static func adjust(_ scopes: [NSRange], edited: NSRange, delta: Int) -> [NSRange] {
        guard edited.location != NSNotFound else { return scopes }
        let oldEnd = NSMaxRange(edited) - delta
        let newEnd = NSMaxRange(edited)
        return scopes.compactMap { scope in
            let upper = NSMaxRange(scope)
            let start = scope.location <= edited.location ? scope.location : scope.location >= oldEnd ? scope.location + delta : edited.location
            let end = upper < edited.location ? upper : upper >= oldEnd ? upper + delta : newEnd
            return end > start ? NSRange(location: start, length: end - start) : nil
        }
    }

    func nearest(to caret: Int, backwards: Bool, wrap: Bool) -> Int? {
        if backwards { return matches.lastIndex { $0.range.location < caret } ?? (wrap ? matches.indices.last : nil) }
        return matches.firstIndex { $0.range.location >= caret } ?? (wrap ? matches.indices.first : nil)
    }
}
