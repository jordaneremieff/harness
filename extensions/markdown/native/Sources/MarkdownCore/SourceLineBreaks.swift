import Foundation

/// Exact line breaks shared by parser ranges, source edits and retained source copies.
enum SourceLineBreaks {
    struct Boundary {
        var startUTF8: Int
        var endUTF8: Int
        var startUTF16: Int
        var endUTF16: Int
    }
    static func isBreak(_ character: Character) -> Bool {
        character == "\r" || character == "\n" || character == "\r\n"
    }
    static func forEach(in source: String, _ visit: (Boundary) -> Void) {
        var utf8 = 0, utf16 = 0
        for character in source {
            let endUTF8 = utf8 + character.utf8.count
            let endUTF16 = utf16 + character.utf16.count
            if isBreak(character) {
                visit(Boundary(startUTF8: utf8, endUTF8: endUTF8, startUTF16: utf16, endUTF16: endUTF16))
            }
            utf8 = endUTF8; utf16 = endUTF16
        }
    }
    static func withoutFinalBreak(_ source: String) -> Substring {
        source.last.map(isBreak) == true ? source.dropLast() : source[...]
    }
    static func count(in source: String) -> Int {
        var count = 0
        for character in source where isBreak(character) { count += 1 }
        return count
    }
}
