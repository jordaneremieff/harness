import Darwin
import Foundation

/// The terminal is free to kill its direct child and foreground process group when a pane
/// closes. The window owner runs in another session, with the same terminal descriptors. A
/// pipe with no writer left tells it to release the window even if the direct child was killed.
enum PaneProcess {
    static let argument = "--pane-process"
    private static let lifetime: Int32 = 3

    static func launch(_ arguments: [String]) -> Int32 {
        guard let executable = Bundle.main.executableURL?.path else { return failure(ENOENT) }
        var lifeline = [Int32](repeating: -1, count: 2)
        guard pipe(&lifeline) == 0 else { return failure(errno) }
        let readEnd = lifeline[0], writeEnd = lifeline[1]
        defer { close(readEnd); close(writeEnd) }
        // dup2 needs a different source FD; it also clears close-on-exec on the destination.
        let sourceFD = fcntl(readEnd, F_DUPFD_CLOEXEC, lifetime + 1)
        guard sourceFD >= 0 else { return failure(errno) }
        defer { close(sourceFD) }
        guard fcntl(readEnd, F_SETFD, FD_CLOEXEC) == 0, fcntl(writeEnd, F_SETFD, FD_CLOEXEC) == 0 else { return failure(errno) }

        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        var error = posix_spawn_file_actions_init(&actions)
        guard error == 0 else { return failure(error) }
        defer { posix_spawn_file_actions_destroy(&actions) }
        error = posix_spawnattr_init(&attributes)
        guard error == 0 else { return failure(error) }
        defer { posix_spawnattr_destroy(&attributes) }
        error = posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
        if error == 0 { error = posix_spawn_file_actions_addclose(&actions, writeEnd) }
        if error == 0 { error = posix_spawn_file_actions_adddup2(&actions, sourceFD, lifetime) }
        guard error == 0 else { return failure(error) }

        var argv = ([executable, argument] + arguments).map { strdup($0) }
        defer { argv.forEach { free($0) } }
        guard !argv.contains(nil) else { return failure(ENOMEM) }
        argv.append(nil)
        var child: pid_t = 0
        error = posix_spawn(&child, executable, &actions, &attributes, &argv, environ)
        guard error == 0 else { return failure(error) }

        // The owner no longer belongs to the terminal's foreground group. Relay size changes
        // and explicit interrupts; terminal hangup itself is handled by the lifetime pipe.
        let pid = child
        let relays = [SIGWINCH, SIGTERM, SIGINT].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { kill(pid, number) }
            source.resume()
            return source
        }
        defer { relays.forEach { $0.cancel() } }
        var status: Int32 = 0
        while waitpid(child, &status, 0) < 0 {
            guard errno == EINTR else { return failure(errno) }
        }
        let exitSignal = status & 0x7f
        return exitSignal == 0 ? (status >> 8) & 0xff : 128 + exitSignal
    }

    /// Nil if the terminal child is already gone or this was not an internal launch.
    @MainActor
    static func watchLifetime(_ terminate: @escaping @MainActor () -> Void) -> DispatchSourceRead? {
        guard fcntl(lifetime, F_SETFD, FD_CLOEXEC) == 0 else { return nil }
        var descriptor = pollfd(fd: lifetime, events: Int16(POLLIN), revents: 0)
        guard poll(&descriptor, 1, 0) == 0 else { return nil }
        let source = DispatchSource.makeReadSource(fileDescriptor: lifetime, queue: .main)
        source.setEventHandler {
            source.cancel()
            MainActor.assumeIsolated { terminate() }
        }
        source.setCancelHandler { close(lifetime) }
        source.resume()
        return source
    }

    private static func failure(_ error: Int32) -> Int32 {
        let text = "App Pane: Could not start the window owner: \(String(cString: strerror(error))).\n"
        FileHandle.standardError.write(Data(text.utf8))
        return 1
    }
}
