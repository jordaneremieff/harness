/// Keys typed into the terminal. An open command uses bounded UTF-8; other keys focus Explorer.
public struct PaneInput {
    public enum Event: Equatable {
        case quit
        case focus
        case line(String?)
        case command(String)
    }

    static let limit = 32 * 1024
    private var bytes: [UInt8]?
    private var overflow = false
    var line: String? { bytes.map { String(decoding: $0, as: UTF8.self) } }

    mutating func feed(_ input: some Sequence<UInt8>) -> [Event] {
        var events: [Event] = []
        var focused = false, changed = false, escaping = false
        for byte in input {
            if byte == 3 || byte == 4 { return events + [.quit] }
            if escaping, (0x20...0x7E).contains(byte) { continue }
            escaping = false
            guard bytes != nil else {
                switch byte {
                case 0x71, 0x51: return events + [.quit]
                case 0x3A:
                    bytes = []; overflow = false
                    events.append(.line(""))
                default:
                    if !focused { events.append(.focus) }
                    focused = true
                }
                continue
            }
            switch byte {
            case 0x1B:
                bytes = nil; escaping = true; changed = false
                events.append(.line(nil))
            case 0x0D, 0x0A:
                let command = !overflow ? String(bytes: bytes!, encoding: .utf8) : nil
                bytes = nil; changed = false
                events += [.line(nil), .command(command ?? "")]
            case 0x7F, 0x08:
                if let value = line, !value.isEmpty { bytes = Array(value.dropLast().utf8) } else { bytes = nil }
                events.append(.line(line)); changed = false
            case 0x20...0x7E, 0x80...0xF4:
                if bytes!.count < Self.limit { bytes!.append(byte); changed = true } else { overflow = true }
            default: continue
            }
        }
        if changed { events.append(.line(line)) }
        return events
    }
}
