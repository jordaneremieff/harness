import Foundation

struct FuzzyMatch: Equatable, Sendable {
    let score: Int
    let ranges: [NSRange]
}

struct FuzzyQuery: Sendable {
    private let letters: [String]

    init(_ text: String) {
        letters = text.filter { !$0.isWhitespace }.map(FuzzyLabel.fold)
    }

    var isEmpty: Bool { letters.isEmpty }

    func match(_ label: FuzzyLabel) -> FuzzyMatch? {
        guard !letters.isEmpty else { return FuzzyMatch(score: 0, ranges: []) }
        let width = label.glyphs.count
        guard letters.count <= width else { return nil }
        var hits = 0
        for glyph in label.glyphs where hits < letters.count && glyph.text == letters[hits] { hits += 1 }
        guard hits == letters.count else { return nil }

        let missing = Int.min / 4
        var prior = Array(repeating: missing, count: width)
        var next = prior
        var origins = Array(repeating: -1, count: width * letters.count)
        for (row, letter) in letters.enumerated() {
            var gapScore = missing
            var gapSource = -1
            for (i, glyph) in label.glyphs.enumerated() {
                if row > 0, i >= 2, prior[i - 2] != missing, prior[i - 2] + i - 2 > gapScore {
                    gapScore = prior[i - 2] + i - 2
                    gapSource = i - 2
                }
                next[i] = missing
                guard letter == glyph.text else { continue }
                let bonus = glyph.boundary + (i >= label.basename ? 7 : 0)
                if row == 0 {
                    next[i] = bonus - min(18, max(0, i - label.basename))
                } else if i > 0 {
                    let consecutive = prior[i - 1]
                    let spaced = gapScore - i + 1
                    if consecutive != missing, consecutive + 18 >= spaced {
                        origins[row * width + i] = i - 1
                        next[i] = consecutive + 18 + bonus
                    } else if gapSource >= 0 {
                        origins[row * width + i] = gapSource
                        next[i] = spaced + bonus
                    }
                }
            }
            swap(&prior, &next)
        }
        guard var best = prior.indices.max(by: { prior[$0] < prior[$1] }), prior[best] != missing else { return nil }
        let score = prior[best] - min(24, width - letters.count)
        var ranges: [NSRange] = []
        for row in letters.indices.reversed() {
            ranges.append(label.glyphs[best].range)
            best = origins[row * width + best]
        }
        return FuzzyMatch(score: score, ranges: ranges.reversed())
    }
}

struct FuzzyLabel: Sendable {
    struct Glyph: Sendable {
        let text: String
        let range: NSRange
        let boundary: Int
    }

    let glyphs: [Glyph]
    let basename: Int

    init(_ text: String) {
        var previous: Character?
        var glyphs: [Glyph] = []
        var offset = 0
        var basename = 0
        for character in text {
            let size = String(character).utf16.count
            let boundary: Int
            if previous == "/" { boundary = 14; basename = glyphs.count }
            else if let previous {
                boundary = (!previous.isLetter && !previous.isNumber) || (previous.isLowercase && character.isUppercase) ? 11 : 0
            } else { boundary = 14 }
            glyphs.append(Glyph(text: Self.fold(character), range: NSRange(location: offset, length: size), boundary: boundary))
            offset += size
            previous = character
        }
        self.glyphs = glyphs
        self.basename = basename
    }

    static func fold(_ character: Character) -> String {
        String(character).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
}
