import Foundation

/// One report of the pane stacking contract (`docs/conventions/pane-stacking.md`): where the
/// pane sits in its terminal window's layout, and the areas of other content that the terminal
/// draws over it, in fractions of the window's layout area.
public struct StackingReport: Equatable, Sendable {
    /// Nil when the pane is not part of a shown layout.
    public var pane: CGRect?
    public var above: [CGRect]

    static let lineLimit = 16 * 1024
    static let areaLimit = 64

    /// The report in one line of the command's output, or nil for a line that the contract tells
    /// a consumer to ignore.
    static func parse(_ line: Data) -> StackingReport? {
        guard line.count <= lineLimit,
              let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1
        else { return nil }
        if object["pane"] is NSNull { return StackingReport(pane: nil, above: []) }
        guard let pane = area(object["pane"]), let list = object["above"] as? [Any], list.count <= areaLimit else { return nil }
        var above: [CGRect] = []
        for item in list {
            guard let rect = area(item) else { return nil }
            above.append(rect)
        }
        return StackingReport(pane: pane, above: above)
    }

    private static func area(_ value: Any?) -> CGRect? {
        guard let numbers = value as? [NSNumber], numbers.count == 4 else { return nil }
        let values = numbers.map(\.doubleValue)
        guard values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }

    /// The command that the environment offers: a JSON array of 1 to 16 strings with an absolute
    /// executable path first.
    static func command(_ environment: [String: String]) -> [String]? {
        guard let value = environment["PI_PANE_STACKING"], value.utf8.count <= 64 * 1024,
              let words = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String],
              (1 ... 16).contains(words.count), words[0].hasPrefix("/")
        else { return nil }
        return words
    }
}

/// Splits the command's output into lines of at most `limit` bytes. A longer line is dropped
/// whole: once it passes the limit, every byte up to and including its newline is discarded, so no
/// part of it is read as a line.
struct StackingLines {
    let limit: Int
    private var pending = Data()
    private var skipping = false

    init(limit: Int = StackingReport.lineLimit) {
        self.limit = limit
    }

    /// The lines that this chunk completes, without their newlines.
    mutating func append(_ chunk: Data) -> [Data] {
        var lines: [Data] = []
        var start = chunk.startIndex
        while start < chunk.endIndex {
            let newline = chunk[start...].firstIndex(of: 0x0A)
            let end = newline ?? chunk.endIndex
            if !skipping {
                if pending.count + (end - start) > limit {
                    skipping = true
                    pending = Data()
                } else {
                    pending.append(chunk[start ..< end])
                }
            }
            guard let newline else { break }
            if !skipping { lines.append(pending) }
            pending = Data()
            skipping = false
            start = newline + 1
        }
        return lines
    }
}

/// Runs the stacking command that the pane's environment offers and keeps its last valid report.
/// The command ends when this process closes its input, at the latest when the process exits.
public final class StackingFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var report: StackingReport?
    private var generation = 0
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var lines = StackingLines()
    /// Called on an arbitrary queue after each new report.
    public var onReport: (@Sendable () -> Void)?

    /// Starts the offered command; nil when the environment offers none or it cannot start.
    public static func start(environment: [String: String] = ProcessInfo.processInfo.environment) -> StackingFeed? {
        guard let command = StackingReport.command(environment) else { return nil }
        let feed = StackingFeed()
        return feed.launch(command) ? feed : nil
    }

    private func launch(_ command: [String]) -> Bool {
        process.executableURL = URL(fileURLWithPath: command[0])
        process.arguments = Array(command.dropFirst())
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                self?.ended()
                return
            }
            self?.receive(chunk)
        }
        do {
            try process.run()
            return true
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            return false
        }
    }

    /// The last valid report and a number that changes with each new report.
    public var latest: (report: StackingReport?, generation: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (report, generation)
    }

    /// Closes the command's input, which ends a command that keeps the contract, and terminates
    /// a command that still runs a second later.
    public func stop() {
        output.fileHandleForReading.readabilityHandler = nil
        try? input.fileHandleForWriting.close()
        let process = process
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if process.isRunning { process.terminate() }
        }
    }

    /// The command ended: its last report no longer describes the pane, so the feed reports
    /// nothing from now on and the anchor falls back to its own judgement.
    private func ended() {
        lock.lock()
        let changed = report != nil
        report = nil
        if changed { generation += 1 }
        lock.unlock()
        if changed { onReport?() }
    }

    private func receive(_ chunk: Data) {
        var newest: StackingReport?
        for line in lines.append(chunk) {
            if let parsed = StackingReport.parse(line) { newest = parsed }
        }
        guard let newest else { return }
        lock.lock()
        let changed = newest != report
        if changed {
            report = newest
            generation += 1
        }
        lock.unlock()
        if changed { onReport?() }
    }
}
