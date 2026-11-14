import Darwin
import Dispatch
import Foundation

/// Writes to one file descriptor on a thread of its own, in order. A terminal or pipe that stops
/// reading holds only that thread: callers never wait longer than the deadline they choose. The
/// descriptor's flags stay as they are, because other processes can share the same open file.
///
/// Frames, such as a redrawn placeholder, replace one another while earlier output is still on
/// its way; other output is never dropped and keeps its order.
public final class TerminalOutput: @unchecked Sendable {
    private let descriptor: Int32
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var frame: [UInt8]?
    private var frameScheduled = false

    public init(descriptor: Int32, label: String) {
        self.descriptor = descriptor
        queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    /// Sends a frame. A newer frame replaces this one if it is still waiting.
    public func post(frame bytes: [UInt8]) {
        lock.lock()
        frame = bytes
        let schedule = !frameScheduled
        frameScheduled = true
        lock.unlock()
        guard schedule else { return }
        queue.async { [self] in
            lock.lock()
            let bytes = frame
            frame = nil
            frameScheduled = false
            lock.unlock()
            if let bytes { _ = Self.write(descriptor, bytes) }
        }
    }

    /// Sends bytes after all earlier output without waiting for them.
    public func enqueue(_ bytes: [UInt8]) {
        queue.async { [descriptor] in _ = Self.write(descriptor, bytes) }
    }

    /// Sends bytes after all earlier output and waits until they are written or the deadline,
    /// on the monotonic clock, passes. Returns whether they were written in time; bytes that
    /// were not can still be written later.
    @discardableResult
    public func send(_ bytes: [UInt8], before deadline: DispatchTime) -> Bool {
        let done = DispatchSemaphore(value: 0)
        let outcome = Outcome()
        queue.async { [descriptor] in
            outcome.written = Self.write(descriptor, bytes)
            done.signal()
        }
        return done.wait(timeout: deadline) == .success && outcome.written
    }

    private final class Outcome: @unchecked Sendable {
        var written = false
    }

    /// Writes every byte; false when the descriptor refuses them. A descriptor that another
    /// process made nonblocking is waited for.
    static func write(_ descriptor: Int32, _ bytes: [UInt8]) -> Bool {
        var offset = 0
        while offset < bytes.count {
            let count = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress! + offset, $0.count - offset) }
            if count > 0 {
                offset += count
                continue
            }
            guard count < 0 else { return false }
            switch errno {
            case EINTR: continue
            case EAGAIN:
                var ready = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
                _ = poll(&ready, 1, 1000)
            default: return false
            }
        }
        return true
    }
}
