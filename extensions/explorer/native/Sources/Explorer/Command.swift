import Darwin
import Foundation

struct ExplorerError: LocalizedError {
    let code: String
    let message: String
    let retryable: Bool?
    init(_ code: String, _ message: String, retryable: Bool? = nil) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }
    var errorDescription: String? { message }
}

let kib = 1024
let mib = 1024 * kib
let jsonNull = NSNull()

struct CommandResult {
    let data: Data
    let status: Int32
    let truncated: Bool
    var string: String { String(decoding: data, as: UTF8.self) }
}

func command(_ binary: String, _ args: [String], cwd: URL? = nil, environment: [String: String]? = nil,
             input: Data? = nil, limit: Int, seconds: Double, onChunk: ((Data) -> Bool)? = nil) throws -> CommandResult {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: binary)
    task.arguments = args
    task.currentDirectoryURL = cwd
    task.environment = environment
    let output = Pipe()
    let stdin = input.map { _ in Pipe() }
    task.standardOutput = output
    task.standardError = FileHandle.nullDevice
    task.standardInput = stdin.map { $0 as Any } ?? FileHandle.nullDevice
    try task.run()
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    defer {
        if task.isRunning { kill(task.processIdentifier, SIGKILL) }
        task.waitUntilExit()
    }
    if let stdin, let input {
        let writer = stdin.fileHandleForWriting
        _ = fcntl(writer.fileDescriptor, F_SETNOSIGPIPE, 1)
        DispatchQueue.global(qos: .utility).async {
            defer { try? writer.close() }
            try? writer.write(contentsOf: input)
        }
    }
    let fd = output.fileHandleForReading.fileDescriptor
    _ = fcntl(fd, F_SETFL, O_NONBLOCK)
    var result = Data(), received = 0
    var buf = [UInt8](repeating: 0, count: 64 * kib)
    var truncated = false
    while true {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { throw ExplorerError("timeout", "The operation exceeded its time limit.") }
        var entry = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let ready = poll(&entry, 1, Int32(ceil(remaining * 1000)))
        if ready < 0, errno != EINTR { throw ExplorerError("io", "The command output could not be read.") }
        if ready <= 0 { continue }
        let size = min(64 * kib, limit - received + 1)
        let n = buf.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, size) }
        if n == 0 { break }
        if n < 0 {
            if errno == EAGAIN || errno == EINTR { continue }
            throw ExplorerError("io", "The command output could not be read.")
        }
        let capacity = limit - received
        let count = min(n, capacity)
        let chunk = buf.prefix(count)
        received += count
        let accepted: Bool
        if let onChunk { accepted = onChunk(Data(chunk)) }
        else { result.append(contentsOf: chunk); accepted = true }
        if n > capacity || !accepted {
            // The cap is detected independently of how the pipe chunks its output.
            truncated = true
            break
        }
    }
    if truncated, task.isRunning { kill(task.processIdentifier, SIGKILL) }
    // EOF normally precedes exit by only a few instructions, but a command may close stdout early.
    if task.isRunning {
        let exited = DispatchSemaphore(value: 0)
        task.terminationHandler = { _ in exited.signal() }
        if task.isRunning, exited.wait(timeout: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime)) == .timedOut {
            throw ExplorerError("timeout", "The operation exceeded its time limit.")
        }
    }
    task.waitUntilExit()
    return CommandResult(data: result, status: task.terminationStatus, truncated: truncated)
}
