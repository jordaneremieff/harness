import AppKit
import Testing
@testable import Editor

struct RequestCardViewTests {
    private let preferred = NSSize(width: 335, height: 240)
    private var rows: [NSRect] {
        (0..<27).map { NSRect(x: 0, y: CGFloat(10 + $0 * 20), width: 380, height: 20) }
    }

    @Test func rightPlacementClearsTheLongestVisibleRow() throws {
        let viewport = NSRect(x: 0, y: 0, width: 850, height: 550)
        let anchor = NSRect(x: 22, y: 110, width: 45, height: 20)
        let card = try #require(requestCardPlacement(in: viewport, anchor: anchor, codeEnd: 380, rows: rows, preferred: preferred))
        #expect(card.minX == 388)
        #expect(card.minY == anchor.minY)
        #expect(card.size == preferred)
        #expect(viewport.contains(card))
        let narrower = try #require(requestCardPlacement(in: viewport, anchor: anchor, codeEnd: 540, rows: rows, preferred: preferred))
        #expect(narrower.minX == 548)
        #expect(narrower.width < preferred.width)
    }

    @Test func verticalPlacementBelowOrAboveNeverCutsThroughARow() throws {
        let viewport = NSRect(x: 0, y: 0, width: 390, height: 550)
        let nearTop = NSRect(x: 22, y: 113, width: 120, height: 16)
        let nearBottom = NSRect(x: 22, y: 475, width: 120, height: 16)
        let below = try #require(requestCardPlacement(in: viewport, anchor: nearTop, codeEnd: 375, rows: rows, preferred: preferred))
        let above = try #require(requestCardPlacement(in: viewport, anchor: nearBottom, codeEnd: 375, rows: rows, preferred: preferred))
        #expect(below.minY >= nearTop.maxY)
        #expect(above.maxY <= nearBottom.minY)
        for card in [above, below] {
            #expect(viewport.contains(card))
            #expect(card.width == viewport.width)
            #expect(!rows.contains { ($0.minY < card.minY && card.minY < $0.maxY) || ($0.minY < card.maxY && card.maxY < $0.maxY) })
        }
    }

    @Test func cardDocksWhenThereIsNoClearSideOrEnoughCompleteRows() {
        let viewport = NSRect(x: 0, y: 0, width: 650, height: 250)
        let anchor = NSRect(x: 440, y: 91, width: 190, height: 65)
        #expect(requestCardPlacement(in: viewport, anchor: anchor, codeEnd: 630, rows: rows, preferred: preferred) == nil)
        #expect(requestCardPlacement(in: NSRect(x: 0, y: 0, width: 219, height: 380), anchor: .null,
                                     codeEnd: 20, rows: rows, preferred: preferred) == nil)
    }

    @MainActor @Test func narrowCardShowsTheStartOfTheLatestAnswerBeforeChangedFiles() throws {
        _ = NSApplication.shared
        let card = RequestCardView()
        card.frame = NSRect(x: 0, y: 0, width: 370, height: 238)
        card.update(title: "source.swift · Line 3", recipients: [("id", "Agent")], selected: "id", state: "Answered",
                    messages: [("You", "What changed?"), ("Agent", "- It uses `retryLimit`.\n- The default is four.")],
                    files: ["source.swift", "tests.swift", "fixtures.swift"], pending: false)
        card.layoutSubtreeIfNeeded()
        let scroll = try #require(card.subviews.compactMap { $0 as? NSScrollView }.first {
            $0.documentView?.subviews.contains(where: { $0 is RequestAnswerView }) == true
        })
        let answer = try #require(scroll.documentView?.subviews.compactMap { $0 as? RequestAnswerView }.first)
        #expect(scroll.documentVisibleRect.minY <= answer.frame.minY)
        #expect(scroll.documentVisibleRect.maxY > answer.frame.minY + 12)
    }

    @MainActor @Test func answerKeepsInlineStylesWhitespaceAndListMarkers() throws {
        _ = NSApplication.shared
        let view = RequestAnswerView("- **First** with `retry`.\n  - *Second*, [read](https://example.com).")
        let result = view.attributedString()
        #expect(result.string == "- First with retry.\n  - Second, read.")
        func attribute(_ key: NSAttributedString.Key, for word: String) throws -> Any? {
            let range = (result.string as NSString).range(of: word)
            try #require(range.location != NSNotFound)
            return result.attribute(key, at: range.location, effectiveRange: nil)
        }
        #expect(try attribute(.font, for: "retry") as? NSFont == WorkspaceStyle.settings.sourceFont)
        let bold = try #require(try attribute(.font, for: "First") as? NSFont)
        let italic = try #require(try attribute(.font, for: "Second") as? NSFont)
        #expect(NSFontManager.shared.traits(of: bold).contains(.boldFontMask))
        #expect(NSFontManager.shared.traits(of: italic).contains(.italicFontMask))
        #expect(try attribute(.link, for: "read") as? URL == URL(string: "https://example.com"))
    }
}
