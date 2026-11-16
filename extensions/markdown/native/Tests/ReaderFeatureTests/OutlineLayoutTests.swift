import Testing
@testable import ReaderFeature

struct OutlineLayoutTests {
    @Test func resizeUsesAvailableWidthInsteadOfFixedSidebarCap() {
        var layout = OutlineLayout()
        layout.resize(to: 500, in: 1200)
        #expect(layout.outlineWidth(in: 1200) == 500)
        #expect(layout.outlineWidth(in: 1500) == 625)
    }

    @Test func limitsPreserveReadableDocumentAndUsefulContents() {
        var layout = OutlineLayout()
        layout.resize(to: 10000, in: 900)
        #expect(layout.outlineWidth(in: 900) == 532)
        layout.resize(to: -100, in: 900)
        #expect(layout.outlineWidth(in: 900) == 160)
    }

    @Test func compactResizePreservesThePreferredProportion() {
        var layout = OutlineLayout()
        layout.resize(to: 420, in: 1000)
        let preferred = layout
        #expect(layout.isCompact(in: 639))
        #expect(!layout.isCompact(in: 640))
        layout.resize(to: 100, in: 400)
        #expect(layout == preferred)
        #expect(layout.outlineWidth(in: 1000) == 420)
        #expect(layout.outlineWidth(in: 300) == 0)
    }

    @Test func invalidMeasurementsDoNotDestroyPreferenceAndResetRestoresDefault() {
        var layout = OutlineLayout()
        layout.resize(to: 500, in: 1200)
        let preferred = layout
        layout.resize(to: .nan, in: 900)
        layout.resize(to: 200, in: .infinity)
        #expect(layout == preferred)
        layout.reset()
        #expect(layout == OutlineLayout())
    }
}
