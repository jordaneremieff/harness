import Foundation

/// A check deadline does not await or cancel the work it bounds. A stuck native operation must
/// still produce a named failure and end the check process instead of blocking its report.
@MainActor
final class VerificationDeadline {
    var stage = "starting"
    private var task: Task<Void, Never>?

    func start(seconds: Double = 30, expired: @escaping @MainActor (String) -> Void) {
        stop()
        stage = "starting"
        task = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.task = nil
            expired(self.stage)
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
