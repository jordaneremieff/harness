import Foundation

/// Maps parser line and byte-column positions to UTF-16 ranges in the exact source, and maps
/// UTF-16 offsets back to one-based lines and visible grapheme columns.
public struct EditorSourceCoordinates: Sendable {
    private struct Line: Sendable {
        let startUTF16: Int
        let contentEndUTF16: Int
        let startUTF8: Int
        let contentEndUTF8: Int
        let firstGrapheme: Int
        let endGrapheme: Int
    }

    private let lines: [Line]
    private let graphemeUTF16: [Int]
    private let graphemeUTF8: [Int]
    private let utf16Length: Int

    public init(_ source: String) {
        var lines: [Line] = []
        var graphemeUTF16: [Int] = []
        var graphemeUTF8: [Int] = []
        var utf16Offset = 0
        var utf8Offset = 0
        var lineStartUTF16 = 0
        var lineStartUTF8 = 0
        var lineFirstGrapheme = 0
        var graphemeIndex = 0

        for character in source {
            graphemeUTF16.append(utf16Offset)
            graphemeUTF8.append(utf8Offset)
            let isLineBreak = character == "\n" || character == "\r" || character == "\r\n"
            if isLineBreak {
                lines.append(Line(
                    startUTF16: lineStartUTF16,
                    contentEndUTF16: utf16Offset,
                    startUTF8: lineStartUTF8,
                    contentEndUTF8: utf8Offset,
                    firstGrapheme: lineFirstGrapheme,
                    endGrapheme: graphemeIndex
                ))
                utf16Offset += character.utf16.count
                utf8Offset += character.utf8.count
                lineStartUTF16 = utf16Offset
                lineStartUTF8 = utf8Offset
                graphemeIndex += 1
                lineFirstGrapheme = graphemeIndex
            } else {
                utf16Offset += character.utf16.count
                utf8Offset += character.utf8.count
                graphemeIndex += 1
            }
        }

        lines.append(Line(
            startUTF16: lineStartUTF16,
            contentEndUTF16: utf16Offset,
            startUTF8: lineStartUTF8,
            contentEndUTF8: utf8Offset,
            firstGrapheme: lineFirstGrapheme,
            endGrapheme: graphemeIndex
        ))
        graphemeUTF16.append(utf16Offset)
        graphemeUTF8.append(utf8Offset)

        self.lines = lines
        self.graphemeUTF16 = graphemeUTF16
        self.graphemeUTF8 = graphemeUTF8
        self.utf16Length = utf16Offset
    }

    /// The UTF-16 range of an inclusive parser span. Lines and columns are one-based; columns
    /// count UTF-8 bytes as the parser reports them. Ranges stop at grapheme-cluster boundaries.
    public func range(startLine: Int, startColumn: Int, endLine: Int, endColumn: Int) -> NSRange? {
        guard startLine >= 1, endLine >= 1, startColumn >= 1, endColumn >= 1,
              startLine <= lines.count, endLine <= lines.count else { return nil }
        let start = lines[startLine - 1]
        let end = lines[endLine - 1]
        if endLine < startLine { return nil }

        let startByte = min(max(start.startUTF8 + startColumn - 1, start.startUTF8), start.contentEndUTF8)
        let endByte = min(max(end.startUTF8 + endColumn, end.startUTF8), end.contentEndUTF8)
        guard let startOffset = offset(forByte: startByte, in: start, roundUp: false),
              let endOffset = offset(forByte: endByte, in: end, roundUp: true),
              endOffset >= startOffset else { return nil }
        return NSRange(location: startOffset, length: endOffset - startOffset)
    }

    /// The one-based line and visible column at a UTF-16 offset. The column counts grapheme
    /// clusters, so combining marks, emoji sequences and bidirectional text count as displayed.
    public func position(atUTF16 offset: Int) -> (line: Int, column: Int) {
        let clamped = min(max(offset, 0), utf16Length)
        let lineIndex = self.lineIndex(containing: clamped)
        let line = lines[lineIndex]
        let visible = min(max(clamped, line.startUTF16), line.contentEndUTF16)
        var low = line.firstGrapheme
        var high = line.endGrapheme
        while low < high {
            let middle = (low + high + 1) / 2
            if graphemeUTF16[middle] <= visible {
                low = middle
            } else {
                high = middle - 1
            }
        }
        return (lineIndex + 1, low - line.firstGrapheme + 1)
    }

    func lineContentRange(_ line: Int) -> NSRange? {
        guard line >= 1, line <= lines.count else { return nil }
        let value = lines[line - 1]
        return NSRange(location: value.startUTF16, length: value.contentEndUTF16 - value.startUTF16)
    }

    private func lineIndex(containing offset: Int) -> Int {
        var low = 0
        var high = lines.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if lines[middle].startUTF16 <= offset {
                low = middle
            } else {
                high = middle - 1
            }
        }
        return low
    }

    private func offset(forByte byte: Int, in line: Line, roundUp: Bool) -> Int? {
        if byte <= line.startUTF8 { return line.startUTF16 }
        if byte >= line.contentEndUTF8 { return line.contentEndUTF16 }
        var low = line.firstGrapheme
        var high = line.endGrapheme
        while low < high {
            let middle = (low + high + 1) / 2
            if graphemeUTF8[middle] <= byte {
                low = middle
            } else {
                high = middle - 1
            }
        }
        if !roundUp || graphemeUTF8[low] == byte {
            return graphemeUTF16[low]
        }
        let next = min(low + 1, line.endGrapheme)
        return graphemeUTF16[next]
    }
}
