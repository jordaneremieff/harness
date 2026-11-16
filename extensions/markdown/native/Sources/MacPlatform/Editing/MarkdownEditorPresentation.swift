import AppKit
import MarkdownCore

public enum MarkdownSourceMode: String, Sendable, CaseIterable { case visual, styled, raw }
public enum MarkdownSourceFont: String, Sendable, CaseIterable { case system, serif, monospaced }

public struct MarkdownEditorPresentation: Equatable, Sendable {
    public var mode: MarkdownSourceMode
    public var appearance: MarkdownThemeAppearance
    public var font: MarkdownSourceFont
    public var fontSize: CGFloat
    public var wrapsLines: Bool

    public init(mode: MarkdownSourceMode = .styled, appearance: MarkdownThemeAppearance = .system,
                font: MarkdownSourceFont = .system, fontSize: CGFloat = 16, wrapsLines: Bool = true) {
        self.mode = mode
        self.appearance = appearance
        self.font = font
        self.fontSize = min(32, max(11, fontSize))
        self.wrapsLines = wrapsLines
    }
}

@MainActor enum MarkdownEditorTheme {
    static func colour(_ rgb: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255,
                green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
    }

    static func palette(for view: NSView) -> MarkdownThemePalette {
        view.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .dark : .light
    }

    static func font(_ presentation: MarkdownEditorPresentation) -> NSFont {
        let size = min(32, max(11, presentation.fontSize))
        if presentation.mode == .raw || presentation.font == .monospaced {
            return .monospacedSystemFont(ofSize: size, weight: .regular)
        }
        let base = NSFont.systemFont(ofSize: size)
        if presentation.font == .serif, let descriptor = base.fontDescriptor.withDesign(.serif) {
            return NSFont(descriptor: descriptor, size: size) ?? base
        }
        return base
    }

    static func attributes(for role: EditorSemanticRole, presentation: MarkdownEditorPresentation,
                           palette: MarkdownThemePalette) -> [NSAttributedString.Key: Any] {
        let base = font(presentation)
        let mono = NSFont.monospacedSystemFont(ofSize: base.pointSize * 0.94, weight: .regular)
        switch role {
        case .heading1, .heading2, .heading3, .heading4, .heading5, .heading6:
            let scale: CGFloat = switch role {
            case .heading1: 1.6
            case .heading2: 1.35
            case .heading3: 1.18
            default: 1.05
            }
            return [.font: NSFont.systemFont(ofSize: base.pointSize * scale, weight: .semibold), .foregroundColor: colour(palette.heading)]
        case .emphasis:
            return [.font: NSFontManager.shared.convert(base, toHaveTrait: .italicFontMask)]
        case .strong:
            return [.font: NSFontManager.shared.convert(base, toHaveTrait: .boldFontMask)]
        case .strikethrough:
            return [.strikethroughStyle: NSUnderlineStyle.single.rawValue, .foregroundColor: colour(palette.muted)]
        case .inlineCode:
            return [.font: mono, .foregroundColor: colour(palette.code), .backgroundColor: colour(palette.surface)]
        case .codeBlock, .frontMatter:
            return [.font: mono, .foregroundColor: colour(palette.text), .backgroundColor: colour(palette.surface)]
        case .linkLabel, .imageLabel:
            return [.foregroundColor: colour(palette.link), .underlineStyle: NSUnderlineStyle.single.rawValue]
        case .destination:
            return [.font: mono, .foregroundColor: colour(palette.muted)]
        case .checkedTask:
            return [.foregroundColor: colour(palette.check)]
        case .taskMarker:
            return [.font: mono, .foregroundColor: colour(palette.link)]
        case .quote:
            return [.foregroundColor: colour(palette.muted)]
        case .html:
            return [.font: mono, .foregroundColor: colour(palette.code)]
        case .marker, .listMarker, .rule, .tableDelimiter, .reference, .footnote, .fenceLanguage, .escape:
            return [.foregroundColor: colour(palette.muted)]
        }
    }
}
