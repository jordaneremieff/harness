import AppKit
import Testing
@testable import Editor

struct RequestCardViewTests {
    private let preferred = NSSize(width: 335, height: 240)

    @Test func prefersRightEvenIfItNeedsToNarrowTheCard() throws {
        let viewport = NSRect(x: 20, y: 30, width: 610, height: 640)
        let anchor = NSRect(x: 290, y: 210, width: 75, height: 24)
        let card = try #require(requestCardFrame(in: viewport, avoiding: anchor, preferred: preferred))

        #expect(card.minX > anchor.maxX)
        #expect(card.minY == anchor.minY)
        #expect(card.width >= 220 && card.width < preferred.width)
        #expect(card.height == preferred.height)
        #expect(viewport.contains(card))
        #expect(!card.intersects(anchor))
    }

    @Test func usesTheVerticalSideThatFitsTheCardInFlippedCoordinates() throws {
        let viewport = NSRect(x: 20, y: 30, width: 370, height: 470)
        let nearTop = NSRect(x: 95, y: 75, width: 270, height: 40)
        let nearBottom = NSRect(x: 95, y: 420, width: 270, height: 40)
        let below = try #require(requestCardFrame(in: viewport, avoiding: nearTop, preferred: preferred))
        let above = try #require(requestCardFrame(in: viewport, avoiding: nearBottom, preferred: preferred))

        #expect(below.minY > nearTop.maxY)
        #expect(above.maxY < nearBottom.minY)
        for card in [above, below] {
            #expect(card.size == preferred)
            #expect(viewport.contains(card))
        }
    }

    @Test func shortensTheCardBeforeGivingUpOnVerticalPlacement() throws {
        let viewport = NSRect(x: 0, y: 0, width: 380, height: 350)
        let anchor = NSRect(x: 12, y: 120, width: 340, height: 32)
        let card = try #require(requestCardFrame(in: viewport, avoiding: anchor, preferred: preferred))

        #expect(card.minY > anchor.maxY)
        #expect(card.height < preferred.height)
        #expect(viewport.contains(card))
    }

    @Test func triesTheLeftWhenVerticalPlacementCannotFit() throws {
        let viewport = NSRect(x: 0, y: 0, width: 650, height: 250)
        let anchor = NSRect(x: 448, y: 90, width: 190, height: 65)
        let card = try #require(requestCardFrame(in: viewport, avoiding: anchor, preferred: preferred))

        #expect(card.maxX < anchor.minX)
        #expect(card.width == preferred.width)
        #expect(viewport.contains(card))
        #expect(!card.intersects(anchor))
    }

    @Test func usesTheTopRightWhenTheSelectionIsNotVisible() throws {
        let viewport = NSRect(x: 40, y: 16, width: 252, height: 230)
        let noAnchor = try #require(requestCardFrame(in: viewport, avoiding: .null, preferred: preferred))
        let offscreen = NSRect(x: -70, y: 37, width: 100, height: 15)
        let outside = try #require(requestCardFrame(in: viewport, avoiding: offscreen, preferred: preferred))

        #expect(noAnchor == outside)
        #expect(viewport.contains(noAnchor))
        #expect(noAnchor.minY - viewport.minY == viewport.maxX - noAnchor.maxX)
        #expect(noAnchor.width >= 220 && noAnchor.width < preferred.width)
        #expect(noAnchor.height < preferred.height)
    }

    @Test func declinesWhenTheCardOrItsControlsCannotFit() {
        let viewport = NSRect(x: 12, y: 9, width: 300, height: 280)
        let clippedSelection = viewport.insetBy(dx: -20, dy: -20)

        #expect(requestCardFrame(in: viewport, avoiding: clippedSelection, preferred: preferred) == nil)
        #expect(requestCardFrame(in: NSRect(x: 0, y: 0, width: 219, height: 380), avoiding: .null, preferred: preferred) == nil)
        #expect(requestCardFrame(in: NSRect(x: 0, y: 0, width: 500, height: 149), avoiding: .null, preferred: preferred) == nil)
        #expect(requestCardFrame(in: .null, avoiding: .null, preferred: preferred) == nil)
    }
}
