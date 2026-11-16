import AppKit

/// A cmark-confirmed list prefix carried only through edits that cannot change code context.
struct MarkdownListContinuation {
    static let lineLimit = 4096
    private static let contextCharacters = CharacterSet(charactersIn: "`~\\").union(.newlines)
    var generation: UInt64
    var line: NSRange
    let bodyStart: Int
    let prefix: String

    static func lineRange(in text: NSString, at offset: Int) -> NSRange {
        var start = 0, end = 0, contentsEnd = 0
        text.getLineStart(&start, end: &end, contentsEnd: &contentsEnd, for: NSRange(location: offset, length: 0))
        return NSRange(location: start, length: contentsEnd - start)
    }

    init?(source: String, generation: UInt64, line: NSRange, markerEnd: Int) {
        let text = source as NSString
        guard line.length <= Self.lineLimit, markerEnd > line.location, markerEnd <= NSMaxRange(line),
              text.substring(with: line).rangeOfCharacter(from: Self.contextCharacters) == nil else { return nil }
        var bodyStart = markerEnd
        while bodyStart < NSMaxRange(line), [32, 9].contains(text.character(at: bodyStart)) { bodyStart += 1 }
        self.generation = generation
        self.line = line
        self.bodyStart = bodyStart
        prefix = text.substring(with: NSRange(location: line.location, length: bodyStart - line.location))
    }

    func contains(_ selection: NSRange, source: String, generation: UInt64) -> Bool {
        guard generation == self.generation, selection.length == 0,
              selection.location >= bodyStart, selection.location <= NSMaxRange(line) else { return false }
        let text = source as NSString
        guard NSMaxRange(line) <= text.length else { return false }
        return text.substring(with: NSRange(location: line.location, length: prefix.utf16.count)).utf16.elementsEqual(prefix.utf16)
    }

    func replacing(_ range: NSRange, with replacement: String) -> Self? {
        guard range.location >= bodyStart, NSMaxRange(range) <= NSMaxRange(line),
              line.length - range.length + replacement.utf16.count <= Self.lineLimit,
              replacement.rangeOfCharacter(from: Self.contextCharacters) == nil else { return nil }
        // Keep the first content character intact. Only an empty item accepts new content there.
        if range.location == bodyStart {
            guard bodyStart == NSMaxRange(line), range.length == 0,
                  let first = replacement.unicodeScalars.first, !CharacterSet.whitespaces.contains(first) else { return nil }
        }
        var result = self
        result.line.length += replacement.utf16.count - range.length
        return result
    }
}
