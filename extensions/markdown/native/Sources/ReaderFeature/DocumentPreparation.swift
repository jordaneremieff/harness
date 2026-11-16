import Foundation
import MarkdownCore

/// A rendering prepared off the main thread.
struct PreparedDocument: Sendable {
    var snapshot: DocumentSnapshot
    var rendered: RenderedDocument
    var readMilliseconds: Double
    var renderMilliseconds: Double
}

struct DraftPreviewSource: Sendable {
    var title: String
    var source: String
    var resolver: any AssetResolving
}

/// What a window asks to prepare: a revision or an immutable draft snapshot.
struct PreparationRequest: Sendable {
    var reference: DocumentReference
    var revision: Int?
    var pinnedDigest: String?
    var draft: DraftPreviewSource? = nil
}

/// Runs synchronous preparation work off the main thread, one request at a time. Work that has
/// started runs to completion, because reading and cmark parsing cannot be interrupted, so a
/// request that arrives while work runs waits, and a newer request replaces the waiting one.
/// A replaced request returns nil without running. At most two requests exist at once: the one
/// that runs and the newest one that waits.
@MainActor
final class PreparationQueue<Request: Sendable, Output: Sendable> {
    private let work: @Sendable (Request) -> Output
    private var running = false
    private var waiting: (request: Request, continuation: CheckedContinuation<Output?, Never>)?
    /// Requests whose work ran.
    private(set) var started = 0
    /// Requests that a newer request or `discardWaiting` released before they ran.
    private(set) var replaced = 0
    var hasWaiting: Bool { waiting != nil }

    init(work: @escaping @Sendable (Request) -> Output) {
        self.work = work
    }

    /// Runs the request's work, or returns nil when a newer request replaced it before it ran.
    func run(_ request: Request) async -> Output? {
        guard running else {
            running = true
            let output = await execute(request)
            startWaiting()
            return output
        }
        release()
        return await withCheckedContinuation { waiting = (request, $0) }
    }

    /// Releases the waiting request without running it.
    func discardWaiting() {
        release()
    }

    private func release() {
        guard let previous = waiting else { return }
        waiting = nil
        replaced += 1
        previous.continuation.resume(returning: nil)
    }

    private func startWaiting() {
        guard let next = waiting else {
            running = false
            return
        }
        waiting = nil
        Task { @MainActor in
            let output = await self.execute(next.request)
            next.continuation.resume(returning: output)
            self.startWaiting()
        }
    }

    private func execute(_ request: Request) async -> Output {
        started += 1
        let work = self.work
        return await Task.detached(priority: .userInitiated) { work(request) }.value
    }
}

extension PreparationRequest {
    /// Reads and renders the requested revision.
    static func prepare(_ request: PreparationRequest) -> Result<PreparedDocument, any Error> {
        Result {
            let readStart = Date()
            let snapshot: DocumentSnapshot
            if let draft = request.draft {
                snapshot = DocumentSnapshot.draft(reference: request.reference, title: draft.title, source: draft.source, resolver: draft.resolver)
            } else {
                snapshot = try DocumentLoader.load(request.reference, revision: request.revision, pinnedDigest: request.pinnedDigest)
            }
            guard snapshot.bytes <= Limits.sourceBytes else { throw StoreError.tooLarge(name: "Draft preview", bytes: snapshot.bytes, limit: Limits.sourceBytes) }
            let renderStart = Date()
            let rendered = MarkdownRenderer.render(snapshot.source, resolver: snapshot.resolver)
            return PreparedDocument(
                snapshot: snapshot,
                rendered: rendered,
                readMilliseconds: renderStart.timeIntervalSince(readStart) * 1000,
                renderMilliseconds: Date().timeIntervalSince(renderStart) * 1000
            )
        }
    }
}
