import Foundation

/// Private evidence for locating the same passage in a later revision. Never sent over the agent connection.
struct ReviewPassageAnchor: Codable, Sendable {
    struct Context: Codable, Sendable { let before: String; let after: String }
    struct Rendered: Codable, Sendable { let before: String; let text: String; let after: String }
    let text: String
    let contexts: [Context]
    let headings: [String]?
    let rendered: Rendered?

    func valid(raw: String?, quote: String?) -> Bool {
        guard let raw, !raw.isEmpty, text.utf8.elementsEqual(raw.utf8), text.utf8.count <= 16 * 1024,
              contexts.count <= 2, contexts.allSatisfy({ $0.before.utf16.count <= 64 && $0.after.utf16.count <= 64 &&
                !($0.before + $0.after).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { return false }
        if let headings, headings.count > 6 || !headings.allSatisfy({ $0.utf16.count <= 256 }) { return false }
        if let rendered {
            guard let quote, rendered.before.utf16.count <= 256, rendered.after.utf16.count <= 256,
                  rendered.text.utf8.elementsEqual(quote.utf8), quote.utf8.count <= 8192 else { return false }
        }
        return true
    }
}
