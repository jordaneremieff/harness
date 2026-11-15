import Foundation

/// The model, not a replaced WebKit navigation sequence, owns the lifetime of a display wait.
/// A navigation consumer holds no model or prepared document. Supersession releases the caller
/// immediately even when that consumer ignores task cancellation.
@MainActor
final class DisplayWait {
    struct Superseded: Error {}

    private var continuation: CheckedContinuation<Void, any Error>?
    private var consumer: Task<Void, Never>?
    private var finished = false

    func run(_ operation: @escaping @MainActor () async throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            guard !finished else {
                continuation.resume(throwing: Superseded())
                return
            }
            self.continuation = continuation
            consumer = Task { @MainActor [weak self] in
                do {
                    try await operation()
                    self?.finish(.success(()))
                } catch {
                    self?.finish(.failure(error))
                }
            }
        }
    }

    func supersede() {
        finish(.failure(Superseded()))
    }

    private func finish(_ result: Result<Void, any Error>) {
        guard !finished else { return }
        finished = true
        let continuation = self.continuation
        self.continuation = nil
        consumer?.cancel()
        consumer = nil
        continuation?.resume(with: result)
    }
}
