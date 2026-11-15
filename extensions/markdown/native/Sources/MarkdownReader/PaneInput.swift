/// Keys typed into the pane's terminal. `q`, Ctrl-C and Ctrl-D close the reader; `:` starts a
/// command line that Enter runs and Escape cancels; any other key gives the reader the keyboard.
/// A command line holds printable ASCII only and at most `limit` characters, so terminal input
/// can name a document but never control the terminal.
struct PaneInput {
    enum Event: Equatable {
        case quit
        case focus
        /// The command line changed; nil when it closed.
        case line(String?)
        case command(String)
    }

    static let limit = 64
    private(set) var line: String?

    mutating func feed(_ bytes: some Sequence<UInt8>) -> [Event] {
        var events: [Event] = []
        var focused = false
        var escaping = false
        for byte in bytes {
            if byte == 3 || byte == 4 { return events + [.quit] }
            // The printable bytes that follow an Escape in the same read belong to its sequence.
            if escaping, (0x20...0x7E).contains(byte) { continue }
            escaping = false
            guard let current = line else {
                switch byte {
                case UInt8(ascii: "q"), UInt8(ascii: "Q"): return events + [.quit]
                case UInt8(ascii: ":"):
                    line = ""
                    events.append(.line(""))
                default:
                    if !focused { events.append(.focus) }
                    focused = true
                }
                continue
            }
            switch byte {
            case 0x1B:
                // Escape cancels the line; the rest of an escape sequence is not text.
                line = nil
                escaping = true
                events.append(.line(nil))
            case 0x0D, 0x0A:
                line = nil
                events += [.line(nil), .command(current)]
            case 0x7F, 0x08:
                line = current.isEmpty ? nil : String(current.dropLast())
                events.append(.line(line))
            case 0x20...0x7E where current.count < Self.limit:
                line = current + String(UnicodeScalar(byte))
                events.append(.line(line))
            default:
                continue
            }
        }
        return events
    }
}

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
