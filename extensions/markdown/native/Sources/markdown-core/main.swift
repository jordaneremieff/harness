import Foundation
import MarkdownCore

/// Headless tool of the reader's core. It opens no window and uses no AppKit.
///
///   markdown-core references   read UTF-8 Markdown on standard input and print its image and
///                              link destinations as one JSON object
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("markdown-core: " + message.prefix(200) + "\n").utf8))
    exit(1)
}

let arguments = CommandLine.arguments.dropFirst()
guard arguments.first == "references", arguments.count == 1 else {
    fail("usage: markdown-core references < source.md")
}
let input = FileHandle.standardInput.readData(ofLength: Limits.sourceBytes + 1)
guard input.count <= Limits.sourceBytes else { fail("the source exceeds \(Limits.sourceBytes) bytes") }
guard let source = String(data: input, encoding: .utf8) else { fail("the source is not valid UTF-8") }
guard let scan = ReferenceInventoryScan.scan(source) else { fail("the parser failed") }
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
guard let output = try? encoder.encode(scan) else { fail("the result could not be encoded") }
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data("\n".utf8))
