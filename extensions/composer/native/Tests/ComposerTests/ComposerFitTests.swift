import Foundation
import Testing
@testable import Composer

struct ComposerFitTests {
    private func geometry(_ height: Double, window: Double = 987, span: Double = 0) -> ComposerFit.Geometry {
        .init(height: height, windowHeight: window, splitHeight: span)
    }

    @Test func correctsTheShortLandingAndThenFitsInOneStep() {
        var fit = ComposerFit()
        fit.observe(geometry(458, span: 916))
        // A 160 pt layout gives a 0.175 first share with the zero-offset estimate.
        let accepted = fit.layout(160)
        #expect(accepted)
        let first = fit.request()
        #expect(first == 0.175)
        fit.finish(applied: true)
        fit.observe(geometry(137))
        #expect(!fit.manual)
        #expect(abs((fit.slope ?? 0) - 987.69) < 0.01)
        #expect(abs(fit.offset - (-35.85)) < 0.02)
        let correction = fit.request()
        #expect(correction == 0.199)
        fit.finish(applied: true)
        fit.observe(geometry(161))
        let extra = fit.request()
        #expect(extra == nil)
        #expect(!fit.manual)
        let larger = fit.layout(211)
        #expect(larger)
        let growth = fit.request()
        #expect(growth == 0.25)
        fit.finish(applied: true)
        fit.observe(geometry(211))
        let smaller = fit.layout(146)
        #expect(smaller)
        let shrink = fit.request()
        #expect(shrink == 0.184)
    }

    @Test func windowHeightChangeRecalibratesAtTheSameShare() {
        var fit = ComposerFit()
        fit.observe(geometry(211, span: 844))
        _ = fit.layout(295)
        let first = fit.request()
        #expect(first == 0.35)
        fit.finish(applied: true)
        fit.observe(geometry(310))
        #expect(abs(fit.offset + 36.5) < 0.001)
        fit.observe(geometry(245, window: 800))
        #expect(fit.share == 0.35)
        #expect(abs((fit.slope ?? 0) - 804.2857) < 0.001)
        #expect(!fit.manual)
        let grow = fit.request()
        #expect(grow == 0.4)
    }

    @Test func doesNotRetryARefusalOrExceedTheCap() {
        var fit = ComposerFit()
        fit.observe(geometry(162, span: 810))
        _ = fit.layout(500)
        let first = fit.request()
        #expect(first == 0.4)
        fit.finish(applied: false)
        let retry = fit.request()
        #expect(retry == nil)
        _ = fit.layout(501)
        let newAttempt = fit.request()
        #expect(newAttempt == 0.4)
        fit.finish(applied: true)
        fit.observe(geometry(360))
        let aboveCap = fit.request()
        #expect(aboveCap == nil)
        #expect(!fit.manual)
    }

    @Test func correctsAShortLandingWithABoundedAttemptBudget() {
        var fit = ComposerFit()
        fit.observe(geometry(162, span: 810))
        _ = fit.layout(340)
        let first = fit.request()
        #expect(first == 0.4)
        fit.finish(applied: true)
        fit.observe(geometry(365))
        _ = fit.layout(200)
        let shrink = fit.request()
        #expect(shrink == 0.238)
        fit.finish(applied: true)
        fit.observe(geometry(193))
        let correction = fit.request()
        #expect(correction == 0.245)
        fit.finish(applied: true)
        fit.observe(geometry(198))
        for _ in 0..<2 {
            let extra = fit.request()
            #expect(extra != nil)
            fit.finish(applied: true)
            fit.observe(geometry(199))
        }
        #expect(fit.attempts == 4)
        let exhausted = fit.request()
        #expect(exhausted == nil)
    }

    @Test func acceptsASubRowCorrectionAndIgnoresALatePTYChange() {
        var fit = ComposerFit()
        fit.observe(geometry(211, span: 844))
        _ = fit.layout(144)
        let shrink = fit.request()
        #expect(shrink == 0.171)
        fit.finish(applied: true)
        fit.observe(geometry(133))
        let correction = fit.request()
        #expect(correction == 0.183)
        fit.finish(applied: true)
        // AX rises by 7 pt while the PTY stays on the same row count.
        fit.observe(geometry(140))
        #expect(fit.pending == nil)
        #expect(fit.share == 0.183)
        // The PTY changes later without another AX change.
        fit.observe(geometry(140))
        #expect(!fit.manual)
        _ = fit.layout(165)
        let growth = fit.request()
        #expect(growth != nil)
    }

    @Test func unchangedFrameCannotStopFitWhenThePTYChanges() {
        var fit = ComposerFit()
        fit.observe(geometry(162, span: 810))
        // A font resize changes the row count but not the frame.
        fit.observe(geometry(162))
        #expect(!fit.manual)
        _ = fit.layout(260)
        let growth = fit.request()
        #expect(growth != nil)
    }

    @Test func skipsMovesUnderTwoPoints() {
        var fit = ComposerFit()
        fit.observe(geometry(162, span: 810))
        _ = fit.layout(163)
        #expect(fit.goal == 0.202)
        let skipped = fit.request()
        #expect(skipped == nil)
        #expect(fit.pending == nil)
        _ = fit.layout(165)
        let growth = fit.request()
        #expect(growth == 0.204)
    }

    @Test(arguments: [true, false])
    func expiresAnAppliedResizeWithoutCalibrating(placed: Bool) {
        var time = ContinuousClock.now
        var fit = ComposerFit(offset: -35.7, now: { time })
        fit.observe(geometry(161.6, span: 986.5))
        let slope = fit.slope
        _ = fit.layout(200)
        let growth = fit.request()
        #expect(growth != nil)
        fit.finish(applied: true)
        time += .milliseconds(1999)
        fit.observe(geometry(162.1))
        #expect(fit.pending == growth)
        time += .milliseconds(1)
        if placed { fit.observe(geometry(162.1)) } else { fit.expire() }
        #expect(fit.pending == nil)
        #expect(fit.share == growth)
        #expect(fit.slope == slope)
        #expect(fit.offset == -35.7)
        let retry = fit.request()
        #expect((retry ?? 0) > (growth ?? 0))
    }

    @Test func persistedOffsetFitsTheNextOpenInOneStep() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let empty = ComposerFit.loadOffset(from: directory)
        #expect(empty == 0)
        let file = directory.appendingPathComponent("fit-offset.json")
        try ComposerDraftStore.prepare(directory)
        try Data("0".utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        try ComposerFit.saveOffset(-35.7, to: directory)
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        #expect(attrs[.posixPermissions] as? Int == 0o600)
        let stored = ComposerFit.loadOffset(from: directory)
        #expect(stored == -35.7)
        var fit = ComposerFit(offset: stored)
        fit.observe(geometry(161.6, span: 986.7))
        _ = fit.layout(128)
        let requested = fit.request()
        let share = try #require(requested)
        #expect(share == 0.166)
        let height = 986.7 * share - 35.7
        #expect(height >= 128)
        fit.finish(applied: true)
        fit.observe(geometry(height))
        let correction = fit.request()
        #expect(correction == nil)
    }

    @Test(arguments: [161.5, 458])
    func fitsVisibleAndHiddenLaunchesFromTheSettledFrame(settledHeight: Double) throws {
        let start = ContinuousClock.now
        var startup = ComposerFit.Startup(now: start)
        var fit = ComposerFit(offset: -38)
        _ = fit.layout(136)
        let transitional = CGRect(x: 0, y: 0, width: 800, height: 458)
        let settled = CGRect(x: 0, y: 0, width: 800, height: settledHeight)
        // The PTY still has its default 24 rows; no terminal resize arrived.
        for ms in [0, 500] {
            if startup.settled(transitional, now: start + .milliseconds(ms)) {
                fit.observe(geometry(transitional.height, span: 996))
            }
            #expect(fit.slope == nil)
            let early = fit.request()
            #expect(early == nil)
        }
        startup.terminalResized()
        let sample1 = startup.settled(nil, now: start + .milliseconds(600))
        #expect(!sample1)
        let sample2 = startup.settled(settled, now: start + .milliseconds(750))
        #expect(!sample2)
        let sample3 = startup.settled(settled, now: start + .milliseconds(949))
        #expect(!sample3)
        let ready = startup.settled(settled, now: start + .milliseconds(950))
        #expect(ready)
        fit.observe(geometry(settled.height, span: 996))
        #expect(abs(fit.share - (settledHeight + 38) / 996) < 0.0001)
        let requested = fit.request()
        let share = try #require(requested)
        #expect(share == 0.175)
        let height = 986.7 * share - 35.7
        #expect(height >= 136)
        fit.finish(applied: true)
        fit.observe(geometry(height))
        let extra = fit.request()
        #expect(extra == nil)
    }

    @Test func usesAStableFrameIfTheInitialTerminalResizeSignalDoesNotArrive() {
        let start = ContinuousClock.now
        var startup = ComposerFit.Startup(now: start)
        let frame = CGRect(x: 0, y: 0, width: 800, height: 161.5)
        let sample4 = startup.settled(frame, now: start + .milliseconds(1999))
        #expect(!sample4)
        let sample5 = startup.settled(frame, now: start + .seconds(2))
        #expect(!sample5)
        let sample6 = startup.settled(frame, now: start + .milliseconds(2200))
        #expect(sample6)
    }

    @Test(arguments: [true, false])
    func ignoresClampedShrinkAndUsesTheOriginalModelToRecover(noMove: Bool) throws {
        var time = ContinuousClock.now
        let initialShare = noMove ? (84 + 35.8) / 986.7 : 0.13
        var fit = ComposerFit(offset: -35.8, now: { time })
        fit.observe(geometry(986.7 * initialShare - 35.8, span: 986.7))
        _ = fit.layout(60)
        let shrink = fit.request()
        #expect(shrink == 0.1)
        fit.finish(applied: true)
        _ = fit.layout(136)
        if noMove { time += .seconds(2) }
        let saved = fit.observe(geometry(84))
        #expect(saved == nil)
        #expect(fit.pending == nil)
        #expect(fit.floor == 84)
        #expect(fit.offset == -35.8)
        #expect(abs((fit.slope ?? 0) - 986.7) < 0.001)
        let growth = fit.request()
        let share = try #require(growth)
        #expect(share == 0.175)
        let height = 986.7 * share - 35.8
        #expect(height >= 136)
        fit.finish(applied: true)
        fit.observe(geometry(height))
        let extra = fit.request()
        #expect(extra == nil)
        _ = fit.layout(60)
        let bounded = fit.request()
        #expect((bounded ?? 0) >= (84 + 35.8) / 986.7)
    }

    @Test(arguments: [true, false])
    func rejectsASlopeAboveTheSplitOrWindowBound(hasSplit: Bool) {
        let split = hasSplit ? 987.0 : 0
        let window = hasSplit ? 2000.0 : 1000.0
        var fit = ComposerFit(offset: -35.8)
        fit.observe(.init(height: 161.5, windowHeight: window, splitHeight: split))
        let slope = fit.slope
        _ = fit.layout(136)
        let requested = fit.request()
        #expect(requested == (hasSplit ? 0.175 : 0.172))
        fit.finish(applied: true)
        let saved = fit.observe(.init(height: 84, windowHeight: window, splitHeight: split))
        #expect(saved == nil)
        #expect(fit.slope == slope)
        #expect(abs(fit.offset - (84 - (slope ?? 0) * (requested ?? 0))) < 0.001)
        let growth = fit.request()
        #expect((growth ?? 0) > (requested ?? 0))
    }

    @Test func ignoresStoredOffsetsOutsideThePlausibleRange() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try ComposerDraftStore.prepare(directory)
        let file = directory.appendingPathComponent("fit-offset.json")
        for (raw, expected) in [("-201", 0.0), ("201", 0.0), ("-200", -200.0), ("200", 200.0), ("null", 0.0)] {
            try Data(raw.utf8).write(to: file)
            #expect(ComposerFit.loadOffset(from: directory) == expected)
        }
    }

    @Test(arguments: [true, false])
    func manualDragStopsFitWhenUnsolicitedOrAgainstAnAppliedRequest(awaiting: Bool) {
        var fit = ComposerFit()
        fit.observe(geometry(162, span: 810))
        _ = fit.layout(260)
        if awaiting {
            let grow = fit.request()
            #expect(grow != nil)
            fit.finish(applied: true)
        }
        fit.observe(geometry(145))
        #expect(fit.manual)
        let grow = fit.request()
        #expect(grow == nil)
    }
}
