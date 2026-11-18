import Foundation

@MainActor
enum CloseDeadline {
    static let outputAllowance = 0.2
    private final class Gate { var value = false }

    /// Runs `work` and reports whether it finished before `deadline`; after the deadline the
    /// caller goes on and the work continues on its own.
    static func run(until deadline: DispatchTime, _ work: @escaping @MainActor () async -> Void) async -> Bool {
        await withCheckedContinuation { continuation in
            let resumed = Gate()
            Task { @MainActor in
                await work()
                guard !resumed.value else { return }
                resumed.value = true
                continuation.resume(returning: true)
            }
            DispatchQueue.main.asyncAfter(deadline: deadline) {
                MainActor.assumeIsolated {
                    guard !resumed.value else { return }
                    resumed.value = true
                    continuation.resume(returning: false)
                }
            }
        }
    }
}
