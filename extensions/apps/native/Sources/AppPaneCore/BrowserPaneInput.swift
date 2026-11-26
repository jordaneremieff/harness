import Foundation

/// The command line of a browser pane accepts a whole URL, including UTF-8 split across reads.
/// A damaged or overlong command must not open the valid-looking prefix of an address.
public struct BrowserPaneInput {
    public enum Action: Equatable {
        case focus, quit, invalid
        case newTab(URL?)
    }

    private var bytes: [UInt8] = []
    private var editing = false
    private var invalid = false
    public var line: String? { editing ? String(decoding: bytes, as: UTF8.self) : nil }

    public init() {}

    public mutating func feed(_ input: ArraySlice<UInt8>) -> [Action] {
        var actions: [Action] = []
        for byte in input {
            if byte == 3 || byte == 4 { return actions + [.quit] }
            if !editing {
                switch byte {
                case 0x71, 0x51: return actions + [.quit]
                case 0x3a: editing = true
                case 0x0a, 0x0d: break
                default: if actions.last != .focus { actions.append(.focus) }
                }
                continue
            }
            switch byte {
            case 0x0d, 0x0a:
                actions.append(command())
                reset()
            case 0x1b: reset()
            case 0x7f, 0x08:
                if bytes.isEmpty { reset() }
                else { while let last = bytes.popLast(), last & 0xc0 == 0x80 {} }
            case 0x20...0xff where bytes.count < 4 + 2048 * 4:
                bytes.append(byte)
            default: invalid = true
            }
        }
        return actions
    }

    private func command() -> Action {
        guard !invalid, let text = String(bytes: bytes, encoding: .utf8) else { return .invalid }
        if text == "tab" { return .newTab(nil) }
        guard text.hasPrefix("tab "), let url = try? PaneRequest.address(String(text.dropFirst(4))) else { return .invalid }
        return .newTab(url)
    }

    private mutating func reset() {
        bytes.removeAll(keepingCapacity: true)
        editing = false
        invalid = false
    }
}
