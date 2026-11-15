import Testing
import Darwin
@testable import MarkdownCore
@testable import MarkdownReader

@MainActor @Suite struct MeasurementBounds {
    @Test func measurementRejectsUnknownOrUnboundedWorkloads() {
        for arguments in [
            ["--measure", "--shapes", "unknown"],
            ["--measure", "--shapes", "sections,sections"],
            ["--measure", "--sizes", "0", "corpus.md"],
            ["--measure", "--sizes", "2097153", "corpus.md"],
            ["--measure", "--sizes", "512,broken", "corpus.md"],
        ] {
            guard case .usage = LaunchMode.parse(arguments) else {
                Issue.record("Workload was not rejected: \(arguments)")
                continue
            }
        }
        guard case .measure(let corpus, let sizes, let shapes, _) = LaunchMode.parse(["--measure", "--shapes", "all"]) else {
            Issue.record("Named shapes need no corpus")
            return
        }
        #expect(corpus.isEmpty && sizes.isEmpty)
        #expect(shapes == ShapeMeasurement.allShapes)
    }

    @Test func cpuProbeAgreesWithGetrusage() throws {
        func cpu() throws -> Double {
            var usage = rusage()
            guard getrusage(RUSAGE_SELF, &usage) == 0 else { throw POSIXError(.EIO) }
            return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
                + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6
        }
        let start = try cpu()
        let probeStart = try #require(ProcessProbe.cpuSeconds(getpid()))
        while try cpu() - start < 0.1 {}
        let probeEnd = try #require(ProcessProbe.cpuSeconds(getpid()))
        let elapsed = try cpu() - start
        let observed = probeEnd - probeStart
        print("CPU comparison: getrusage=\(elapsed)s, proc_pid_rusage=\(observed)s")
        #expect(abs(observed - elapsed) < 0.02)
    }

    @Test func cpuIntervalsDoNotCombineReplacedOrMissingProcesses() {
        let before = ShapeMeasurement.Usage(app: 1, web: [11: 2, 12: 3], unresolvedWindows: 0, unavailableProcesses: 0)
        let after = ShapeMeasurement.Usage(app: 1.2, web: [11: 2.5, 13: 0.1], unresolvedWindows: 0, unavailableProcesses: 0)
        let delta = after - before
        #expect(delta.web == nil && delta.knownWeb == 0.5)
        #expect(delta.startPIDs == [11, 12] && delta.endPIDs == [11, 13])
        let missing = ShapeMeasurement.Usage(app: nil, web: [:], unresolvedWindows: 1, unavailableProcesses: 1)
        let unavailable = missing - before
        #expect(unavailable.app == nil && unavailable.web == nil && unavailable.knownWeb == nil)
        #expect(JSONSerialization.isValidJSONObject(unavailable.json))
        let valid = before - before
        #expect(valid.app == 0 && valid.web == 0)
    }
}
