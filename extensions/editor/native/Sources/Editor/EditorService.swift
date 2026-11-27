import Darwin
import Foundation

@MainActor
final class EditorService: EditorAPI {
    enum Status: Equatable, Sendable {
        case ready, reconnecting, failed(String)
    }

    private struct Configuration: Encodable {
        let root: String
        let agentDir: String
        let paneId: String
        let participant: EditorTicket.Participant
        let appPid: Int32
    }

    private struct Handshake: Decodable {
        let port: Int
        let token: String

        var isValid: Bool {
            (1...65535).contains(port) && token.utf8.count == 64 &&
                token.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
    }

    private final class Attempt {
        let id = UUID()
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        let stderr = Pipe()
        var writeSource: DispatchSourceWrite?
        var readSource: DispatchSourceRead?
        var stderrSource: DispatchSourceRead?
        var stderrRemaining = 64 * 1024
        var configOffset = 0
        var writeSuspended = false
        var line = Data()
        var client: NativeEditorClient?
        var deadline: Task<Void, Never>?
        var killDeadline: Task<Void, Never>?
        var failure: String?
        var retiring = false
    }

    private static let unavailable = EditorIssue(code: "service_unavailable", message: "Editor lost its connection to the workspace service.")
    private static let lineLimit = 1024
    private let ticket: EditorTicket
    private let log: EditorServiceLog
    private let startupTimeout: Duration
    private var configuration = Data()
    private var attempt: Attempt?
    private var starts = 0
    private var firstFailure: String?
    private var stopped = false
    private var onStopped: (() -> Void)?
    var onStatus: ((Status) -> Void)?

    init(ticket: EditorTicket, workspace: URL, startupTimeout: Duration = .seconds(10)) {
        self.ticket = ticket
        self.log = EditorServiceLog(workspace: workspace, paneId: ticket.paneId)
        self.startupTimeout = startupTimeout
    }

    func start() {
        guard starts == 0, !stopped else { return }
        let config = Configuration(root: ticket.root, agentDir: ticket.agentDir, paneId: ticket.paneId,
                                   participant: ticket.participant, appPid: getpid())
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        guard var line = try? encoder.encode(config), line.count < 32768 else {
            fail("The workspace service configuration exceeds its startup limit.")
            return
        }
        line.append(10)
        configuration = line
        launch()
    }

    func call(_ op: String, _ fields: Fields) async throws -> Fields {
        try Task.checkCancellation()
        guard let attempt, let client = attempt.client else { throw Self.unavailable }
        do {
            let result = try await client.call(op, fields)
            try Task.checkCancellation()
            guard self.attempt === attempt, !attempt.retiring else { throw Self.unavailable }
            return result
        } catch {
            try Task.checkCancellation()
            guard self.attempt === attempt, !attempt.retiring else { throw Self.unavailable }
            if let error = error as? URLError {
                switch error.code {
                case .cannotConnectToHost, .networkConnectionLost:
                    retry(problem: "Editor lost its HTTP connection to the workspace service (network error \(error.code.rawValue)).")
                    throw Self.unavailable
                case .timedOut:
                    throw EditorIssue(code: "service_timeout", message: "The workspace service did not respond in time.")
                default: break
                }
            }
            throw error
        }
    }

    func retry(problem: String) {
        guard let attempt, !attempt.retiring, !stopped else { return }
        attempt.failure = problem
        retire(attempt)
        onStatus?(.reconnecting)
    }

    func stop(_ completion: @escaping () -> Void) {
        stopped = true
        onStatus = nil
        guard let attempt else { completion(); return }
        onStopped = completion
        retire(attempt)
    }

    private func launch() {
        starts += 1
        let child = Attempt()
        let id = child.id
        let input = child.input.fileHandleForWriting
        let output = child.output.fileHandleForReading
        let inFD = input.fileDescriptor
        let outFD = output.fileDescriptor
        child.process.executableURL = URL(fileURLWithPath: ticket.node)
        child.process.arguments = [ticket.program]
        child.process.standardInput = child.input
        child.process.standardOutput = child.output
        child.process.standardError = child.stderr
        child.process.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.exited(id) }
        }
        guard fcntl(inFD, F_SETNOSIGPIPE, 1) != -1,
              fcntl(inFD, F_SETFL, O_NONBLOCK) != -1,
              fcntl(outFD, F_SETFL, O_NONBLOCK) != -1,
              fcntl(child.stderr.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) != -1 else {
            relaunchOrFail("Editor could not configure the service pipes (system error \(errno)).")
            return
        }
        do { try child.process.run() }
        catch {
            let error = error as NSError
            let cause = (error.userInfo[NSUnderlyingErrorKey] as? NSError) ?? error
            let detail: String
            switch (cause.domain, cause.code) {
            case (NSPOSIXErrorDomain, Int(ENOENT)), (NSCocoaErrorDomain, CocoaError.fileNoSuchFile.rawValue),
                 (NSCocoaErrorDomain, CocoaError.fileReadNoSuchFile.rawValue):
                detail = "the executable was not found"
            case (NSPOSIXErrorDomain, Int(EACCES)), (NSCocoaErrorDomain, CocoaError.fileReadNoPermission.rawValue):
                detail = "permission was denied"
            case (NSPOSIXErrorDomain, Int(ENOEXEC)), (NSCocoaErrorDomain, CocoaError.executableNotLoadable.rawValue):
                detail = "the file is not a loadable executable"
            default:
                let category = cause.domain == NSPOSIXErrorDomain ? "system error" : "launch error"
                detail = "\(category) \(cause.code)"
            }
            relaunchOrFail("Editor could not run the Node executable: \(detail).")
            return
        }
        attempt = child
        try? child.input.fileHandleForReading.close()
        try? child.output.fileHandleForWriting.close()
        startStderr(child)

        let reader = DispatchSource.makeReadSource(fileDescriptor: outFD, queue: .main)
        reader.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.readHandshake(id) } }
        reader.setCancelHandler { try? output.close() }
        child.readSource = reader
        reader.resume()

        let writer = DispatchSource.makeWriteSource(fileDescriptor: inFD, queue: .main)
        writer.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.writeConfiguration(id) } }
        writer.setCancelHandler { try? input.close() }
        child.writeSource = writer
        writer.resume()

        child.deadline = Task { [weak self, startupTimeout] in
            do { try await Task.sleep(for: startupTimeout) } catch { return }
            guard let self, attempt?.id == id else { return }
            retry(problem: "The workspace service did not return its startup handshake in time.")
        }
    }

    private func writeConfiguration(_ id: UUID) {
        guard let attempt, attempt.id == id, !attempt.retiring else { return }
        let result = configuration.withUnsafeBytes { bytes in
            Darwin.write(attempt.input.fileHandleForWriting.fileDescriptor,
                         bytes.baseAddress?.advanced(by: attempt.configOffset), bytes.count - attempt.configOffset)
        }
        if result < 0, errno == EAGAIN || errno == EINTR { return }
        if result < 0, errno == EPIPE {
            attempt.writeSuspended = true
            attempt.writeSource?.suspend()
            pipeClosed(attempt, problem: "The workspace service closed stdin before it received the startup configuration.")
            return
        }
        guard result > 0 else {
            retry(problem: "Editor could not send the startup configuration (system error \(errno)).")
            return
        }
        attempt.configOffset += result
        if attempt.configOffset == configuration.count {
            // Keep stdin open after the configuration. EOF is the child's shutdown signal.
            attempt.writeSuspended = true
            attempt.writeSource?.suspend()
        }
    }

    private func readHandshake(_ id: UUID) {
        guard let attempt, attempt.id == id, !attempt.retiring else { return }
        var bytes = [UInt8](repeating: 0, count: Self.lineLimit + 1)
        let size = Darwin.read(attempt.output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
        if size < 0, errno == EAGAIN || errno == EINTR { return }
        if size == 0 {
            attempt.readSource?.cancel()
            attempt.readSource = nil
            pipeClosed(attempt, problem: "The workspace service closed stdout unexpectedly.")
            return
        }
        guard size > 0 else {
            retry(problem: "Editor could not read the service handshake (system error \(errno)).")
            return
        }
        guard attempt.client == nil else {
            retry(problem: "The workspace service sent extra output after its startup handshake.")
            return
        }
        guard attempt.line.count + size <= Self.lineLimit else {
            retry(problem: "The workspace service exceeded the startup handshake size limit.")
            return
        }
        attempt.line.append(contentsOf: bytes.prefix(size))
        guard let newline = attempt.line.firstIndex(of: 10) else { return }
        guard newline == attempt.line.count - 1, attempt.configOffset == configuration.count,
              let hello = try? JSONDecoder().decode(Handshake.self, from: attempt.line.prefix(newline)), hello.isValid
        else { retry(problem: "The workspace service returned an invalid startup handshake."); return }
        attempt.line.removeAll()
        attempt.deadline?.cancel()
        attempt.client = NativeEditorClient(port: hello.port, token: hello.token)
        onStatus?(.ready)
    }

    private func startStderr(_ child: Attempt) {
        try? child.stderr.fileHandleForWriting.close()
        let handle = child.stderr.fileHandleForReading
        let reader = DispatchSource.makeReadSource(fileDescriptor: handle.fileDescriptor, queue: .main)
        let id = child.id
        reader.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let child = self.attempt, child.id == id else { return }
                _ = self.drainStderr(child)
            }
        }
        reader.setCancelHandler { try? handle.close() }
        child.stderrSource = reader
        reader.resume()
    }

    @discardableResult
    private func drainStderr(_ child: Attempt) -> Bool {
        guard child.stderrSource != nil else { return false }
        var bytes = [UInt8](repeating: 0, count: 16 * 1024)
        let fd = child.stderr.fileHandleForReading.fileDescriptor
        var count: Int
        repeat { count = Darwin.read(fd, &bytes, bytes.count) } while count < 0 && errno == EINTR
        if count < 0, errno == EAGAIN { return false }
        guard count > 0 else { closeStderr(child); return false }
        // Keep the pipe drained after the cap so noisy stderr cannot block the child.
        let retained = min(count, child.stderrRemaining)
        if retained > 0 {
            child.stderrRemaining -= retained
            log.append(bytes.prefix(retained))
        }
        return true
    }

    private func closeStderr(_ child: Attempt) {
        child.stderrSource?.cancel()
        child.stderrSource = nil
    }

    private func pipeClosed(_ child: Attempt, problem: String) {
        // The pipe may report EOF before Foundation reports the child's exit status.
        child.deadline?.cancel()
        let id = child.id
        child.deadline = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard let self, attempt?.id == id else { return }
            retry(problem: problem)
        }
    }

    private func closePipes(_ child: Attempt) {
        child.deadline?.cancel()
        child.client?.stop()
        child.client = nil
        child.readSource?.cancel()
        child.readSource = nil
        if let writer = child.writeSource {
            writer.cancel()
            if child.writeSuspended { writer.resume() }
            child.writeSource = nil
        }
    }

    private func retire(_ child: Attempt) {
        guard !child.retiring else { return }
        child.retiring = true
        closePipes(child)
        let id = child.id
        // A blocked child might not observe EOF. Do not replace it until it exits.
        child.killDeadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            guard let child = self?.attempt, child.id == id, child.process.isRunning else { return }
            kill(child.process.processIdentifier, SIGKILL)
        }
    }

    private func exited(_ id: UUID) {
        guard let child = attempt, child.id == id else { return }
        let stage = child.client == nil ? "before its startup handshake" : "after its startup handshake"
        if !child.retiring { closePipes(child) }
        // Termination can arrive before the read source observes the last stderr bytes.
        while child.stderrRemaining > 0, drainStderr(child) {}
        closeStderr(child)
        child.killDeadline?.cancel()
        attempt = nil
        if !child.retiring, !stopped { onStatus?(.reconnecting) }
        if stopped {
            let completion = onStopped
            onStopped = nil
            completion?()
        } else {
            let termination = child.process.terminationReason == .uncaughtSignal ? "signal" : "exit status"
            let problem = child.failure ?? "The workspace service stopped \(stage) (\(termination) \(child.process.terminationStatus))."
            relaunchOrFail(problem)
        }
    }

    private func relaunchOrFail(_ problem: String) {
        if starts < 2 {
            firstFailure = problem
            launch()
        } else {
            let detail = firstFailure.flatMap { $0 == problem ? nil : "First attempt: \($0) " } ?? ""
            fail("\(detail)\(problem)")
        }
    }

    private func fail(_ problem: String) {
        onStatus?(.failed("\(problem) \(log.location())"))
    }
}
