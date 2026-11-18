import Darwin
import Foundation

struct ComposerFit {
    static let shares = 0.1...0.4
    private static let storableOffsets = -200.0...200.0
    private static let observationTimeout = Duration.seconds(2)
    private static let maxAttempts = 4
    private static let minimumMove = 2.0

    struct Startup {
        private let fallback: ContinuousClock.Instant
        private var terminalSized = false
        private var sample: (frame: CGRect, since: ContinuousClock.Instant)?

        init(now: ContinuousClock.Instant) { fallback = now + .seconds(2) }

        mutating func terminalResized() {
            if !terminalSized { sample = nil }
            terminalSized = true
        }

        mutating func settled(_ frame: CGRect?, now: ContinuousClock.Instant) -> Bool {
            guard let frame, terminalSized || now >= fallback else {
                sample = nil
                return false
            }
            if let sample, sample.frame == frame { return now - sample.since >= .milliseconds(200) }
            sample = (frame, now)
            return false
        }
    }

    struct Geometry {
        let height: Double
        let windowHeight: Double
        var splitHeight: Double = 0

        var splitSpan: Double? {
            let span = splitHeight > 0 ? splitHeight : windowHeight
            return span.isFinite && span > 0 ? span : nil
        }

        // Split bounds and the observed pane can differ by the divider and window chrome.
        var maximumSlope: Double? { splitSpan.map { $0 * 1.15 } }
    }

    private struct Attempt {
        let before: Geometry
        let from: Double
        let to: Double
        let expectedMove: Double
        let predictedHeight: Double
        let startedClamped: Bool
    }

    private(set) var share = 0.0
    private(set) var needed: Double?
    private(set) var slope: Double?
    private(set) var offset: Double
    private(set) var manual = false
    private(set) var floor: Double?
    private(set) var attempts = 0
    private let now: () -> ContinuousClock.Instant
    private var latest: Geometry?
    private var latestClamped = false
    private var consideredLayout = false
    private var inFlight: Attempt?
    private var awaiting: (attempt: Attempt, deadline: ContinuousClock.Instant)?
    var pending: Double? { inFlight?.to ?? awaiting?.attempt.to }
    var awaitsFrame: Bool { awaiting != nil }
    var growsPane: Bool {
        guard let attempt = inFlight ?? awaiting?.attempt else { return false }
        return attempt.to > attempt.from
    }

    func shrinkHeight(beforeRows: Int, afterRows: Int) -> Double? {
        guard afterRows > 0, afterRows < beforeRows else { return nil }
        return predictedShrinkHeight
    }

    var predictedShrinkHeight: Double? {
        guard let attempt = inFlight ?? awaiting?.attempt, attempt.to < attempt.from,
              !attempt.startedClamped, attempt.predictedHeight > 0,
              attempt.predictedHeight < attempt.before.height else { return nil }
        return attempt.predictedHeight
    }

    init(offset: Double = 0, now: @escaping () -> ContinuousClock.Instant = { ContinuousClock.now }) {
        self.offset = Self.storableOffsets.contains(offset) ? offset : 0
        self.now = now
    }

    private static func offsetFile(in directory: URL) -> URL {
        directory.appendingPathComponent("fit-offset.json")
    }

    static func loadOffset(from directory: URL) -> Double {
        guard let data = try? ComposerFileRead.read(offsetFile(in: directory), limit: 256),
              let offset = try? JSONDecoder().decode(Double.self, from: data), storableOffsets.contains(offset) else { return 0 }
        return offset
    }

    static func saveOffset(_ offset: Double, to directory: URL) throws {
        guard storableOffsets.contains(offset) else { return }
        try ComposerDraftStore.prepare(directory)
        let next = directory.appendingPathComponent(".\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: next.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        defer { _ = unlink(next.path) }
        try JSONEncoder().encode(offset).write(to: next)
        guard rename(next.path, offsetFile(in: directory).path) == 0 else { throw POSIXError(.EIO) }
    }

    mutating func layout(_ height: Double) -> Bool {
        guard height.isFinite, height > 0, height <= 8192 else { return false }
        if needed != height {
            attempts = 0
            consideredLayout = false
        }
        needed = height
        return true
    }

    @discardableResult
    mutating func observe(_ current: Geometry) -> Double? {
        guard current.height.isFinite, current.height > 0, !manual, inFlight == nil else { return nil }
        if let (attempt, _) = awaiting {
            let delta = current.height - attempt.before.height
            guard abs(delta) >= 1 else {
                expire(geometry: current)
                return nil
            }
            let calibrated = delta / (attempt.to - attempt.from)
            guard calibrated > 0 else {
                manual = true
                awaiting = nil
                return nil
            }
            accept(attempt, geometry: current)
            if abs(delta) < attempt.expectedMove / 2 {
                recordClamp(attempt, geometry: current)
                return nil
            }
            // Neither endpoint of a calibration can be a clamped frame.
            if attempt.startedClamped { return nil }
            if !differentWindowHeight(current, attempt.before),
               let bound = current.maximumSlope, calibrated <= bound {
                slope = calibrated
                offset = current.height - calibrated * attempt.to
                return offset
            }
            if differentWindowHeight(current, attempt.before) {
                seedSlope(current)
            } else if let slope {
                // The observed point is useful even when its secant is not plausible.
                offset = current.height - slope * attempt.to
            }
        } else if let latest {
            if differentWindowHeight(current, latest) {
                seedSlope(current)
                if current.height < (needed ?? 0) {
                    attempts = 0
                    consideredLayout = false
                }
            } else if abs(current.height - latest.height) >= 1 {
                manual = true
            }
        } else {
            guard let span = current.splitSpan else { return nil }
            // The launch ratio is a command, not an observation of the client layout.
            if offset >= current.height { offset = 0 }
            slope = span
            share = (current.height - offset) / span
        }
        latest = current
        return nil
    }

    private func differentWindowHeight(_ a: Geometry, _ b: Geometry) -> Bool {
        a.windowHeight > 0 && b.windowHeight > 0 && abs(a.windowHeight - b.windowHeight) >= 1
    }

    private mutating func seedSlope(_ geometry: Geometry) {
        if offset >= geometry.height { offset = 0 }
        let estimate = (geometry.height - offset) / share
        slope = min(estimate, geometry.maximumSlope ?? estimate)
    }

    mutating func expire(geometry: Geometry? = nil) {
        guard let (attempt, deadline) = awaiting, now() >= deadline else { return }
        let result = geometry ?? attempt.before
        accept(attempt, geometry: result)
        recordClamp(attempt, geometry: result)
    }

    private mutating func accept(_ attempt: Attempt, geometry: Geometry) {
        share = attempt.to
        awaiting = nil
        latest = geometry
        latestClamped = false
        if let floor, geometry.height < floor { self.floor = geometry.height }
    }

    private mutating func recordClamp(_ attempt: Attempt, geometry: Geometry) {
        // Only a shortfall in shrink establishes a lower height limit. A stalled
        // growth is not evidence that the pane cannot shrink below its current height.
        latestClamped = true
        if attempt.to < attempt.from, geometry.height > attempt.predictedHeight { floor = geometry.height }
    }

    var goal: Double? {
        guard let needed, let slope, slope > 0, let latest else { return nil }
        let target = max(ceil(needed), floor ?? 0)
        var desired = (target - offset) / slope
        if needed > latest.height, attempts > 0 || desired < share {
            // If the measured pane is short, grow from the observed point as well
            // as the model. A clamped/unchanged move can leave the two out of sync.
            desired = max(desired, share + max(target - latest.height, Self.minimumMove) / slope)
        }
        let rounded = ceil(desired * 1000) / 1000
        return min(Self.shares.upperBound, max(Self.shares.lowerBound, rounded))
    }

    mutating func request() -> Double? {
        guard !manual, pending == nil, attempts < Self.maxAttempts,
              let latest, let needed, let slope, let goal else { return nil }
        guard !consideredLayout || (attempts > 0 && latest.height < needed && goal > share) else { return nil }
        consideredLayout = true
        let predictedHeight = slope * goal + offset
        let expectedMove = latestClamped ? abs(predictedHeight - latest.height) : abs(goal - share) * slope
        guard goal != share, expectedMove + 1e-9 >= Self.minimumMove,
              predictedHeight + 1e-9 >= (floor ?? 0) else { return nil }
        attempts += 1
        inFlight = Attempt(before: latest, from: share, to: goal, expectedMove: expectedMove,
                           predictedHeight: predictedHeight, startedClamped: latestClamped)
        return goal
    }

    mutating func finish(applied: Bool) {
        if applied, let inFlight {
            awaiting = (inFlight, now() + Self.observationTimeout)
        } else if inFlight != nil {
            // An unconfirmed side effect must not be retried for this layout.
            attempts = Self.maxAttempts
        }
        inFlight = nil
    }
}
