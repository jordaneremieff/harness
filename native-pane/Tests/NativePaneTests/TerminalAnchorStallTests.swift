import CoreGraphics
import Foundation
import Synchronization
import Testing
@testable import NativePane

private final class PlacementReads: Sendable {
    private let count = Mutex(0)
    let finishStaleRead = DispatchSemaphore(value: 0)

    func next() -> AnchorWorker.Result {
        let step = count.withLock { $0 += 1; return $0 }
        let frame = CGRect(x: step <= 2 ? 100 : 180, y: 100, width: 400, height: 300)
        let place = AnchorWorker.RawPlacement(frame: frame, host: 42, window: 7)
        // Return the second placement only after the window-server check has hidden it.
        if step == 2 { _ = finishStaleRead.wait(timeout: .now() + 8) }
        return AnchorWorker.Result(state: .placed(place))
    }
}

@MainActor @Test func aStalledPlacementStaysHiddenUntilAFreshRead() async {
    let reads = PlacementReads()
    let anchor = TerminalAnchor(read: { _ in reads.next() }, windowInfo: { _ in nil }, idleInterval: 60)
    let (changes, writer) = AsyncStream<TerminalAnchor.Status>.makeStream()
    anchor.onChange = { writer.yield($0) }
    let deadline = DispatchWorkItem { writer.finish() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: deadline)
    defer {
        deadline.cancel()
        anchor.stop()
        reads.finishStaleRead.signal()
        writer.finish()
    }

    var events = changes.makeAsyncIterator()
    anchor.start()
    guard case .placed(let initial)? = await events.next() else {
        Issue.record("The initial placement did not arrive")
        return
    }
    #expect(initial.frame.minX == 100)
    anchor.refresh() // Start a read now, without waiting for the next poll.
    guard case .concealed(let hidden)? = await events.next() else {
        Issue.record("The panel remained visible during a stalled read between slow polls")
        return
    }
    #expect(hidden == initial)
    reads.finishStaleRead.signal()
    guard case .placed(let fresh)? = await events.next() else {
        Issue.record("A fresh placement did not restore the panel")
        return
    }
    #expect(fresh.frame.minX == 180, "The stale read restored the old placement")
}
