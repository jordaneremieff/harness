import Foundation
import Testing
@testable import Editor

struct TextLineIndexTests {
    @Test func updatesAfterUTF16EditsAndKeepsTheTerminalLine() {
        let storage = NSMutableString(string: "😀\nalpha\n\nlast\n")
        let index = TextLineIndex(storage)
        func verify() {
            let lines = (storage as String).components(separatedBy: "\n")
            #expect(index.count == lines.count)
            var offset = 0
            for row in lines.indices {
                let width = lines[row].utf16.count + (row + 1 < lines.count ? 1 : 0)
                #expect(index.range(of: row) == NSRange(location: offset, length: width))
                for unit in 0..<width { #expect(index.line(at: offset + unit) == row) }
                offset += width
            }
            #expect(index.line(at: storage.length) == lines.count - 1)
        }
        func replace(_ start: Int, _ count: Int, _ value: String) {
            let width = value.utf16.count
            storage.replaceCharacters(in: NSRange(location: start, length: count), with: value)
            index.applyEdit(in: storage, range: NSRange(location: start, length: width), delta: width - count)
            verify()
        }
        verify()
        replace(2, 1, "")
        replace(2, 0, "\n🍎\n")
        replace(storage.length - 1, 1, "")
        replace(storage.length, 0, "\n\n")
        replace(0, storage.length, "")
        replace(0, 0, "one\ntwo\n")
    }

    @Test func showsSeparatedChangeHunksAndADelimiterOnlyDeletion() {
        #expect(CodeChangeDiff.between(base: "a\nold\nb\nremoved\nc\n", current: "a\nnew\nb\nc\nextra\n") == [
            CodeChangeMark(line: 1, kind: .modified),
            CodeChangeMark(line: 3, kind: .deleted),
            CodeChangeMark(line: 4, kind: .added),
        ])
        #expect(CodeChangeDiff.between(base: "a\n", current: "a") == [CodeChangeMark(line: 0, kind: .deleted)])
    }
}
