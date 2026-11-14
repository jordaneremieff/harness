import Testing
@testable import MarkdownCore
@testable import MacPlatform

/// Output to descriptors that stop reading: a pipe and a pseudo-terminal whose buffers are full.
@Suite(.serialized) struct TerminalOutputBounds {
    /// Fills the descriptor's buffer without blocking and leaves its flags as they were.
    func fill(_ descriptor: Int32) {
        let flags = fcntl(descriptor, F_GETFL)
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
        let chunk = [UInt8](repeating: UInt8(ascii: "."), count: 1024)
        while chunk.withUnsafeBytes({ Darwin.write(descriptor, $0.baseAddress!, $0.count) }) > 0 {}
        _ = fcntl(descriptor, F_SETFL, flags)
    }

    /// Reads from `descriptor` until `expected` arrives or two seconds pass; returns the text.
    func drain(_ descriptor: Int32, until expected: String) -> String {
        var collected = [UInt8]()
        let deadline = DispatchTime.now() + 2
        var buffer = [UInt8](repeating: 0, count: 4096)
        while DispatchTime.now() < deadline {
            var ready = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            guard poll(&ready, 1, 50) > 0 else { continue }
            let count = read(descriptor, &buffer, buffer.count)
            guard count > 0 else { break }
            collected += buffer.prefix(count)
            if String(decoding: collected, as: UTF8.self).hasSuffix(expected) { break }
        }
        return String(decoding: collected.filter { $0 != UInt8(ascii: ".") }, as: UTF8.self)
    }

    @Test func aPipeThatStopsReadingHoldsTheCallerOnlyUntilItsDeadline() {
        signal(SIGPIPE, SIG_IGN)
        var ends: [Int32] = [0, 0]
        #expect(pipe(&ends) == 0)
        defer { close(ends[0]); close(ends[1]) }
        fill(ends[1])
        let output = TerminalOutput(descriptor: ends[1], label: "test.pipe")
        let start = DispatchTime.now()
        let written = output.send(Array("restore".utf8), before: .now() + 0.2)
        let waited = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        #expect(!written)
        #expect(waited >= 0.15 && waited < 1)
        // The shared descriptor keeps its blocking mode.
        #expect(fcntl(ends[1], F_GETFL) & O_NONBLOCK == 0)
        // The bytes follow once the pipe is read again.
        #expect(drain(ends[0], until: "restore") == "restore")
    }

    @Test func aTerminalThatStopsReadingHoldsTheCallerOnlyUntilItsDeadline() {
        var primary: Int32 = 0
        var secondary: Int32 = 0
        #expect(openpty(&primary, &secondary, nil, nil, nil) == 0)
        defer { close(primary); close(secondary) }
        var settings = termios()
        tcgetattr(secondary, &settings)
        cfmakeraw(&settings)
        tcsetattr(secondary, TCSANOW, &settings)
        fill(secondary)
        let output = TerminalOutput(descriptor: secondary, label: "test.terminal")
        let start = DispatchTime.now()
        let written = output.send(Array("restore".utf8), before: .now() + 0.2)
        let waited = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        #expect(!written)
        #expect(waited < 1)
        #expect(drain(primary, until: "restore") == "restore")
    }

    @Test func aNewerFrameReplacesFramesThatWaitBehindABusyWrite() {
        var ends: [Int32] = [0, 0]
        #expect(pipe(&ends) == 0)
        defer { close(ends[0]); close(ends[1]) }
        fill(ends[1])
        let output = TerminalOutput(descriptor: ends[1], label: "test.frames")
        for frame in 1 ... 10 { output.post(frame: Array("[frame \(frame)]".utf8)) }
        output.enqueue(Array("end".utf8))
        // At most the frame whose write was under way and the newest frame reach the pipe, in order.
        let text = drain(ends[0], until: "end")
        #expect(text.hasSuffix("[frame 10]end"))
        #expect(text.components(separatedBy: "[frame").count - 1 <= 2)
    }
}
