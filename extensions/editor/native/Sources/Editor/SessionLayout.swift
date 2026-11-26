import AppKit

struct SessionLayout: Codable, Equatable {
    struct Group: Codable, Equatable {
        var id: Int
        var keys: [String]
        var selected: String?
    }

    var arrangement: WorkspaceArrangement
    var fixedLayout: Bool
    var groups: [Group]
    var active: Int
    var sidebar: String?
    var lastSidebar: String
    var sidebarWidth: Double?
    var expandedFolders: [String]
    var splitWeights: [Double]
    var positions: [String: WorkspacePosition]
    var previewKeys: [String]
    var hiddenViews: [String: Int]

    static func read(_ file: URL) throws -> Self {
        try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
    }

    func write(_ file: URL) throws {
        try replaceFileAtomically(file, with: JSONEncoder().encode(self))
    }
}

struct WorkspacePosition: Codable, Equatable {
    struct Selection: Codable, Equatable {
        var location: Int
        var length: Int

        func clamped(to count: Int) -> NSRange {
            let start = min(count, max(0, location))
            return NSRange(location: start, length: min(count - start, max(0, length)))
        }
    }

    struct ViewportAnchor: Codable, Equatable {
        let character: Int
        let offset: Double
    }

    let selections: [Selection]
    let horizontal: Double
    let vertical: Double
    let viewport: ViewportAnchor?

    @MainActor init(_ editor: CodeEditor) {
        selections = editor.findSelections.map { Selection(location: $0.location, length: $0.length) }
        let origin = editor.scroll.contentView.bounds.origin
        horizontal = origin.x
        vertical = origin.y
        let text = editor.textView
        let count = text.textStorage?.length ?? 0
        if origin.y > 0, count > 0, let container = text.textContainer, let manager = text.layoutManager {
            let localY = origin.y - text.textContainerOrigin.y
            let point = NSPoint(x: container.lineFragmentPadding, y: max(0, localY))
            let character = min(count - 1, manager.characterIndex(for: point, in: container, fractionOfDistanceBetweenInsertionPoints: nil))
            if let line = Self.line(at: character, in: text) {
                viewport = ViewportAnchor(character: character, offset: origin.y - line.minY)
            } else { viewport = nil }
        } else { viewport = nil }
    }

    @MainActor func apply(to editor: CodeEditor) {
        let length = editor.textView.textStorage?.length ?? 0
        let ranges = selections.map { $0.clamped(to: length) }
        if !ranges.isEmpty { editor.selectFound(ranges, reveal: nil) }
        let text = editor.textView
        let clip = editor.scroll.contentView
        guard horizontal.isFinite, vertical.isFinite else { return }
        var y = vertical
        if let viewport, viewport.character >= 0, viewport.character < length, viewport.offset.isFinite {
            // TextKit lays out distant lines on demand. The same text can have a different
            // estimated y coordinate before the first scroll, or after a pane width change.
            text.scrollRangeToVisible(NSRange(location: viewport.character, length: 1))
            if let line = Self.line(at: viewport.character, in: text) { y = line.minY + viewport.offset }
        }
        let requested = NSRect(origin: NSPoint(x: horizontal, y: y), size: clip.bounds.size)
        clip.scroll(to: clip.constrainBoundsRect(requested).origin)
        editor.scroll.reflectScrolledClipView(clip)
    }

    @MainActor private static func line(at character: Int, in text: NSTextView) -> NSRect? {
        guard let manager = text.layoutManager else { return nil }
        let glyphs = manager.glyphRange(forCharacterRange: NSRange(location: character, length: 1), actualCharacterRange: nil)
        guard glyphs.length > 0 else { return nil }
        let line = manager.lineFragmentRect(forGlyphAt: glyphs.location, effectiveRange: nil)
        return line.offsetBy(dx: text.textContainerOrigin.x, dy: text.textContainerOrigin.y)
    }
}
