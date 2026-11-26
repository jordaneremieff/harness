import AppKit

extension CodeTextView {
    func selectedLineBlocks() -> [ClosedRange<Int>] {
        var blocks: [ClosedRange<Int>] = []
        for selection in sourceSelections {
            let first = line(at: selection.location)
            let last = line(at: max(selection.location, NSMaxRange(selection) - 1))
            if let previous = blocks.last, first <= previous.upperBound + 1 {
                blocks[blocks.count - 1] = previous.lowerBound...max(last, previous.upperBound)
            } else { blocks.append(first...last) }
        }
        return blocks
    }

    func lineBlockRange(_ lines: ClosedRange<Int>) -> NSRange {
        NSUnionRange(lineRange(lines.lowerBound), lineRange(lines.upperBound))
    }

    func indentLines(increase: Bool) {
        let edits: [TextEdit] = selectedLineBlocks().flatMap { lines in
            lines.compactMap { line in
                let details = leadingIndent(on: line)
                let start = lineRange(line).location
                if increase {
                    return TextEdit(range: NSRange(location: start, length: 0), replacement: indentUnit)
                }
                guard details.length > 0 else { return nil }
                let width = max(0, ((details.columns - 1) / indentation.width) * indentation.width)
                return TextEdit(range: NSRange(location: start, length: details.length), replacement: indentString(width))
            }
        }
        _ = edit(edits)
    }

    func detectedIndentation(fallback: (spaces: Bool, width: Int)) -> (spaces: Bool, width: Int) {
        var tabs = 0, spaces = 0
        var counts: [Int: Int] = [:]
        var previous = 0
        for line in 0..<min(lineCount, 512) {
            let prefix = leadingIndent(on: line)
            if prefix.blank { continue }
            let range = contents(of: line)
            if prefix.length > 0 {
                if source.character(at: range.location) == 9 { tabs += 1 }
                else { spaces += 1 }
                let difference = abs(prefix.columns - previous)
                if (2...8).contains(difference) { counts[difference, default: 0] += 1 }
            }
            previous = prefix.columns
        }
        if tabs > spaces { return (false, fallback.width) }
        guard spaces > 0 else { return fallback }
        let width = counts.keys.sorted { a, b in
            let left = counts[a] ?? 0, right = counts[b] ?? 0
            return left == right ? a < b : left > right
        }.first ?? fallback.width
        return (true, width)
    }

    func indentationEdits(spaces: Bool) -> [TextEdit] {
        var edits: [TextEdit] = []
        for line in 0..<lineCount {
            let prefix = leadingIndent(on: line)
            guard prefix.length > 0 else { continue }
            let existing = NSRange(location: contents(of: line).location, length: prefix.length)
            let replacement = spaces ? String(repeating: " ", count: prefix.columns) :
                String(repeating: "\t", count: prefix.columns / indentation.width) + String(repeating: " ", count: prefix.columns % indentation.width)
            if source.substring(with: existing) != replacement { edits.append(TextEdit(range: existing, replacement: replacement)) }
        }
        return edits
    }

    func toggleComment(block: Bool) {
        let language = syntax.engine.language
        let text = source
        if !block, let marker = language.lineComment {
            let rows = selectedLineBlocks().flatMap(Array.init)
            let heads = rows.compactMap { line -> Int? in
                let prefix = leadingIndent(on: line)
                return prefix.blank ? nil : contents(of: line).location + prefix.length
            }
            let targets = heads.isEmpty ? rows.map { contents(of: $0).location + leadingIndent(on: $0).length } : heads
            let markerSize = marker.utf16.count
            func hasMarker(at offset: Int) -> Bool {
                offset + markerSize <= text.length && text.compare(marker, options: .literal,
                    range: NSRange(location: offset, length: markerSize)) == .orderedSame
            }
            let remove = targets.allSatisfy(hasMarker)
            _ = edit(targets.map { offset in
                if remove {
                    let end = offset + markerSize
                    let space = end < text.length && text.character(at: end) == 32 ? 1 : 0
                    return TextEdit(range: NSRange(location: offset, length: markerSize + space), replacement: "")
                }
                return TextEdit(range: NSRange(location: offset, length: 0), replacement: marker + " ")
            })
            return
        }
        guard let pair = language.blockComment else { return }
        let ranges = sourceSelections.map { $0.length > 0 ? $0 : contents(of: line(at: $0.location)) }
        let unique = Array(Set(ranges)).sorted { $0.location < $1.location }
        let left = pair.open.utf16.count, right = pair.close.utf16.count
        _ = edit(unique.map { range in
            let value = text.substring(with: range)
            if value.hasPrefix(pair.open), value.hasSuffix(pair.close), range.length >= left + right {
                let body = NSRange(location: range.location + left, length: range.length - left - right)
                return TextEdit(range: range, replacement: text.substring(with: body),
                                selection: NSRange(location: 0, length: body.length))
            }
            let end = NSMaxRange(range)
            if range.location >= left, end + right <= text.length,
               text.substring(with: NSRange(location: range.location - left, length: left)) == pair.open,
               text.substring(with: NSRange(location: end, length: right)) == pair.close {
                return TextEdit(range: NSRange(location: range.location - left, length: left + range.length + right),
                                replacement: value, selection: NSRange(location: 0, length: range.length))
            }
            return TextEdit(range: range, replacement: pair.open + value + pair.close,
                            selection: NSRange(location: left, length: range.length))
        })
    }

    func insertLines(before: Bool) {
        let rows = Set(sourceSelections.map { line(at: $0.location) }).sorted()
        _ = edit(rows.map { row in
            let content = contents(of: row)
            let indent = leadingIndent(on: row)
            let prefix = source.substring(with: NSRange(location: content.location, length: indent.length))
            if before {
                return .caret(NSRange(location: content.location, length: 0), prefix + "\n", at: prefix.utf16.count)
            }
            return .caret(NSRange(location: NSMaxRange(content), length: 0), "\n" + prefix)
        })
    }

    func deleteLines() {
        _ = edit(selectedLineBlocks().map { lines in
            var range = lineBlockRange(lines)
            if lines.upperBound == lineCount - 1, range.location > 0 {
                range.location -= 1
                range.length += 1
            }
            return .caret(range, "")
        })
    }

    func duplicateLines() {
        let selections = sourceSelections
        if selections.allSatisfy({ $0.length > 0 }) {
            _ = edit(selections.map { range in
                let target = NSRange(location: NSMaxRange(range), length: 0)
                return TextEdit(range: target, replacement: source.substring(with: range),
                                selection: NSRange(location: 0, length: range.length))
            })
            return
        }
        _ = edit(selectedLineBlocks().map { rows in
            let range = lineBlockRange(rows)
            let value = source.substring(with: range)
            let hasLF = value.hasSuffix("\n")
            let insert = hasLF ? value : "\n" + value
            return TextEdit(range: NSRange(location: NSMaxRange(range), length: 0), replacement: insert,
                            selection: NSRange(location: hasLF ? 0 : 1, length: value.utf16.count - (hasLF ? 1 : 0)))
        })
    }

    func moveLines(direction: Int) {
        let primary = selections.last?.head
        _ = edit(selectedLineBlocks().compactMap { rows -> TextEdit? in
            let adjacent = direction < 0 ? rows.lowerBound - 1 : rows.upperBound + 1
            let last = lineCount - 1
            guard adjacent >= 0, adjacent <= last, !(adjacent == last && lineRange(last).length == 0) else { return nil }
            let span = min(rows.lowerBound, adjacent)...max(rows.upperBound, adjacent)
            let range = lineBlockRange(span)
            let trailing = hasLineFeed(span.upperBound)
            let content = lineTexts(rows).joined(separator: "\n")
            let other = source.substring(with: contents(of: adjacent))
            let replacement = (direction < 0 ? content + "\n" + other : other + "\n" + content) + (trailing ? "\n" : "")
            let offset = direction < 0 ? 0 : other.utf16.count + 1
            let original = lineBlockRange(rows)
            if rows.count == 1, let primary, primary >= original.location, primary <= NSMaxRange(original), sourceSelections.count == 1,
               sourceSelections[0].length == 0 {
                return .caret(range, replacement, at: offset + min(content.utf16.count, primary - original.location))
            }
            return TextEdit(range: range, replacement: replacement, selection: NSRange(location: offset, length: content.utf16.count))
        })
    }

    func joinLines() {
        let maxLine = lineCount - 1
        var groups: [ClosedRange<Int>] = []
        for group in selectedLineBlocks() {
            let first = group.lowerBound, last = group.upperBound
            let end = first == last ? min(last + 1, maxLine) : last
            guard first < end else { continue }
            if let previous = groups.last, previous.upperBound >= first {
                groups[groups.count - 1] = previous.lowerBound...end
            } else { groups.append(first...end) }
        }
        _ = edit(groups.map { rows in
            let parts = lineTexts(rows)
            var joined = parts.first ?? ""
            for line in parts.dropFirst() {
                while joined.last == " " || joined.last == "\t" { joined.removeLast() }
                let remainder = line.drop(while: { $0 == " " || $0 == "\t" })
                if !joined.isEmpty, !remainder.isEmpty { joined += " " }
                joined += remainder
            }
            if hasLineFeed(rows.upperBound) { joined += "\n" }
            let firstWidth = min(parts.first?.utf16.count ?? 0, joined.utf16.count)
            return .caret(lineBlockRange(rows), joined, at: firstWidth)
        })
    }

    func rearrangeLines(_ command: TextCommand) {
        var blocks = selectedLineBlocks()
        if sourceSelections.count == 1, sourceSelections[0].length == 0 {
            let last = lineCount - 1
            blocks = [0...max(0, last - (lineRange(last).length == 0 ? 1 : 0))]
        }
        _ = edit(blocks.map { rows in
            let values = lineTexts(rows)
            let result: [String]
            switch command {
            case .sort: result = values.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            case .reverse: result = Array(values.reversed())
            case .unique:
                var seen = Set<String>()
                result = values.filter { seen.insert($0).inserted }
            default: return TextEdit(range: lineBlockRange(rows), replacement: values.joined(separator: "\n"))
            }
            return TextEdit(range: lineBlockRange(rows), replacement: result.joined(separator: "\n") + (hasLineFeed(rows.upperBound) ? "\n" : ""))
        })
    }

    func cleanupEdits(trim: Bool, newline: Bool) -> [TextEdit] {
        guard trim || newline else { return [] }
        let text = source
        var edits: [TextEdit] = []
        if trim {
            for line in 0..<lineCount {
                let range = contents(of: line)
                var cursor = NSMaxRange(range)
                while cursor > range.location {
                    let unit = text.character(at: cursor - 1)
                    if unit != 32, unit != 9 { break }
                    cursor -= 1
                }
                if cursor < NSMaxRange(range) { edits.append(TextEdit(range: NSRange(location: cursor, length: NSMaxRange(range) - cursor), replacement: "")) }
            }
        }
        if newline, text.length == 0 || text.character(at: text.length - 1) != 10 {
            if let last = edits.last, NSMaxRange(last.range) == text.length {
                edits[edits.count - 1] = TextEdit(range: last.range, replacement: "\n")
            } else { edits.append(TextEdit(range: NSRange(location: text.length, length: 0), replacement: "\n")) }
        }
        return edits
    }

    func convertCase(_ command: TextCommand) {
        let ranges = sourceSelections.compactMap { $0.length > 0 ? $0 : word(at: $0.location) }
        _ = edit(Array(Set(ranges)).sorted { $0.location < $1.location }.map { range in
            let value = source.substring(with: range)
            let changed: String
            switch command {
            case .upper: changed = value.uppercased()
            case .lower: changed = value.lowercased()
            case .title: changed = value.capitalized
            default:
                let divided = value.replacingOccurrences(of: "([[:lower:]\\d])([[:upper:]])", with: "$1 $2", options: .regularExpression)
                let words = divided.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
                if words.isEmpty { changed = value }
                else if command == .camel { changed = words[0].lowercased() + words.dropFirst().map { $0.capitalized }.joined() }
                else { changed = words.map { $0.lowercased() }.joined(separator: command == .snake ? "_" : "-") }
            }
            return TextEdit(range: range, replacement: changed, selection: NSRange(location: 0, length: changed.utf16.count))
        })
    }

    func transpose() {
        let text = source
        let ranges = sourceSelections
        if ranges.count > 1, ranges.allSatisfy({ $0.length > 0 }) {
            let values = ranges.map { text.substring(with: $0) }
            _ = edit(ranges.indices.map { index in
                let value = values[(index + values.count - 1) % values.count]
                return TextEdit(range: ranges[index], replacement: value, selection: NSRange(location: 0, length: value.utf16.count))
            })
            return
        }
        _ = edit(ranges.compactMap { selection -> TextEdit? in
            if selection.length > 0 {
                let value = String(text.substring(with: selection).reversed())
                return TextEdit(range: selection, replacement: value, selection: NSRange(location: 0, length: value.utf16.count))
            }
            var cursor = selection.location
            let line = contents(of: line(at: cursor))
            if cursor == NSMaxRange(line), cursor > line.location { cursor = text.rangeOfComposedCharacterSequence(at: cursor - 1).location }
            guard cursor > line.location, cursor < NSMaxRange(line) else { return nil }
            let left = text.rangeOfComposedCharacterSequence(at: cursor - 1)
            let right = text.rangeOfComposedCharacterSequence(at: cursor)
            return .caret(NSUnionRange(left, right), text.substring(with: right) + text.substring(with: left))
        })
    }

    private func lineTexts(_ rows: ClosedRange<Int>) -> [String] { rows.map { source.substring(with: contents(of: $0)) } }
    private func hasLineFeed(_ line: Int) -> Bool { lineRange(line).length > contents(of: line).length }
}
