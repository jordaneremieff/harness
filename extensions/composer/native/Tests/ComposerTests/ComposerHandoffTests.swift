import Testing
@testable import Composer

struct ComposerHandoffTests {
    @Test func aViewThatAnswersTheComposerTakesTheKeyboardAndGivesItBack() {
        var handoff = ComposerHandoff()
        #expect(handoff.update(waiting: true, answersComposer: true, composerHasKeyboard: true) == .release)
        #expect(handoff.released)
        #expect(handoff.update(waiting: true, answersComposer: true, composerHasKeyboard: true) == .none)
        #expect(handoff.update(waiting: false, answersComposer: false, composerHasKeyboard: false) == .reclaim)
        #expect(!handoff.released)
        #expect(handoff.update(waiting: false, answersComposer: false, composerHasKeyboard: false) == .none)
    }

    @Test func otherViewsLeaveTheKeyboardWhereItIs() {
        var handoff = ComposerHandoff()
        #expect(handoff.update(waiting: true, answersComposer: false, composerHasKeyboard: true) == .none)
        #expect(handoff.update(waiting: false, answersComposer: false, composerHasKeyboard: true) == .none)
        #expect(handoff.update(waiting: true, answersComposer: true, composerHasKeyboard: false) == .none, "The operator works elsewhere.")
        #expect(handoff.update(waiting: false, answersComposer: false, composerHasKeyboard: false) == .none)
    }

    @Test func theOperatorsOwnMoveToTheTerminalReturnsWhenTheViewCloses() {
        var handoff = ComposerHandoff()
        handoff.operatorReleased()
        #expect(!handoff.released, "No view is open.")
        #expect(handoff.update(waiting: true, answersComposer: false, composerHasKeyboard: true) == .none)
        handoff.operatorReleased()
        #expect(handoff.update(waiting: false, answersComposer: false, composerHasKeyboard: false) == .reclaim)
    }
}
