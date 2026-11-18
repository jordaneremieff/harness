/// A command typed into the pane's terminal.
enum PaneCommand: Equatable {
    /// Shows another document of the same store in this pane.
    case open(String)
    case unknown(String)

    init(_ text: String) {
        let words = text.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if words.count == 2, words[0] == "open" {
            self = .open(words[1])
        } else {
            self = .unknown(text)
        }
    }

    /// A full document identity: `md-` and 20 lowercase hexadecimal digits.
    static func isDocumentIdentity(_ value: String) -> Bool {
        let utf8 = Array(value.utf8)
        return utf8.count == 23 && value.hasPrefix("md-") && utf8.dropFirst(3).allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }
}
