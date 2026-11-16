import Foundation

public enum MarkdownThemeAppearance: String, Sendable, Codable, CaseIterable {
    case system, light, dark
}

/// Semantic colours shared by native source presentation and rendered pages.
public struct MarkdownThemePalette: Sendable, Equatable {
    public let text: UInt32
    public let muted: UInt32
    public let faint: UInt32
    public let background: UInt32
    public let surface: UInt32
    public let surfaceStrong: UInt32
    public let border: UInt32
    public let link: UInt32
    public let accent: UInt32
    public let check: UInt32
    public let code: UInt32
    public let heading: UInt32
    public let selection: UInt32
    public let selectionText: UInt32
    public let currentLine: UInt32
    public let markCSS: String

    public static let light = Self(text: 0x1d1d1f, muted: 0x5f6368, faint: 0x8a8f98,
        background: 0xffffff, surface: 0xf6f7f9, surfaceStrong: 0xeceef2, border: 0xdfe2e7,
        link: 0x0a5cc2, accent: 0xc8ccd4, check: 0x1f7a3d, code: 0x8a3f53, heading: 0x253d59,
        selection: 0xb6d6fc, selectionText: 0x12253b, currentLine: 0xf2f6fb,
        markCSS: "rgba(255, 213, 79, 0.55)")
    public static let dark = Self(text: 0xe6e6e8, muted: 0xa1a5ad, faint: 0x7d828b,
        background: 0x1c1d20, surface: 0x25272b, surfaceStrong: 0x2e3035, border: 0x3a3d43,
        link: 0x6cb0ff, accent: 0x50545c, check: 0x70c98e, code: 0xe8afbd, heading: 0xc7dbf4,
        selection: 0x31577f, selectionText: 0xffffff, currentLine: 0x242b34,
        markCSS: "rgba(255, 196, 0, 0.35)")

    public var cssVariables: String {
        [("text", text), ("muted", muted), ("faint", faint), ("background", background),
         ("surface", surface), ("surface-strong", surfaceStrong), ("border", border),
         ("link", link), ("accent", accent), ("check", check), ("editor-code", code),
         ("editor-heading", heading), ("editor-selection", selection)]
            .map { "--\($0.0): #\(String(format: "%06x", $0.1));" }.joined(separator: "\n")
            + "\n--mark: \(markCSS);"
    }
}
