import Foundation
import MarkdownCore

/// A returned prompt receipt and a later correlated activity update can both confirm the same send.
/// The scope, original revision and source slice must come from dispatch, not from the page at confirmation.
@MainActor
final class ReaderReviewComments: NSObject {
    struct Request: Hashable {
        var document: UUID
        var id: UUID
    }
    struct Candidate: Sendable {
        var scope: ReviewScope
        var comments: [ReviewComment]
    }
    let store: ReviewCommentStore
    private var candidates: [Request: Candidate] = [:]
    private var writes: [Request: Task<Void, Error>] = [:]
    private var delivered: Set<Request> = []
    private static let changeName = Notification.Name("MarkdownReaderReviewSheetChanged")
    var onChange: ((String) -> Void)?

    init(directory: URL) {
        store = .init(directory: directory)
        super.init()
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(externalChange(_:)),
            name: Self.changeName, object: nil, suspensionBehavior: .coalesce)
    }
    deinit { DistributedNotificationCenter.default().removeObserver(self) }

    func identity(_ scope: ReviewScope) -> String {
        let values = [store.directory.path, scope.conversation, scope.document]
        return Digest.sha256(Data(values.map { "\($0.utf8.count):\($0)" }.joined().utf8))
    }
    @objc private func externalChange(_ note: Notification) {
        guard let value = note.object as? String else { return }
        onChange?(value)
    }
    private func changed(_ scope: ReviewScope) {
        let value = identity(scope)
        DistributedNotificationCenter.default().postNotificationName(Self.changeName, object: value, userInfo: nil, deliverImmediately: true)
    }

    /// Numbering mirrors the original request: the overall comment precedes independent numbered comments.
    static func initialComments(_ message: [String: Any], source: String?) -> [ReviewComment] {
        guard let requestId = message["requestId"] as? String, let request = UUID(uuidString: requestId),
              let threadId = message["threadId"] as? String, UUID(uuidString: threadId) == request else { return [] }
        let thread = request.uuidString.lowercased()
        var digest: String?
        func comment(_ fields: [String: Any], _ text: String, _ kind: String, _ ordinal: Int) -> ReviewComment {
            var record = ReviewComment(commentId: "\(thread):\(ordinal)", threadId: thread, kind: kind,
                ordinal: ordinal, text: text, quote: fields["quote"] as? String, madeOnRevision: fields["authoredRevision"] as? Int)
            if record.quote?.isEmpty == true { record.quote = nil }
            if let source, let range = fields["quoteRange"] as? [String: Any], let start = range["start"] as? Int,
               let end = range["end"] as? Int, start >= 0, end > start, end <= source.utf16.count {
                let selection = NSRange(location: start, length: end - start)
                if MirrorText.validRange(selection, source: source) {
                    let anchor = (source as NSString).substring(with: selection)
                    if anchor.utf8.count <= 16 * 1024 {
                        if digest == nil { digest = Digest.sha256(Data(source.utf8)) }
                        record.sourceAnchor = anchor; record.anchorDigest = digest; record.start = start; record.end = end
                        if let evidence = fields["passageAnchor"] as? [String: Any],
                           let encoded = try? JSONSerialization.data(withJSONObject: evidence),
                           let proof = try? JSONDecoder().decode(ReviewPassageAnchor.self, from: encoded),
                           proof.valid(raw: anchor, quote: record.quote) { record.passageAnchor = proof }
                    }
                }
            }
            return record
        }
        if let batch = message["annotations"] as? [[String: Any]] {
            var records: [ReviewComment] = []
            if let overall = message["overall"] as? String { records.append(comment(message, overall, "overall", 0)) }
            for (index, item) in batch.enumerated() {
                guard let text = item["text"] as? String else { return [] }
                records.append(comment(item, text, "annotation", index + 1))
            }
            return records
        }
        guard let text = message["text"] as? String else { return [] }
        return [comment(message, text.trimmingCharacters(in: .whitespacesAndNewlines), "question", 0)]
    }

    func prepare(_ request: Request, scope: ReviewScope, message: [String: Any], source: String?) {
        guard candidates[request] == nil else { return }
        let comments = Self.initialComments(message, source: source)
        if !comments.isEmpty { candidates[request] = Candidate(scope: scope, comments: comments) }
    }
    func refused(_ request: Request) {
        if !delivered.contains(request) { candidates[request] = nil }
    }
    func confirmed(_ request: Request) async throws {
        if let write = writes[request] { try await write.value; return }
        guard let candidate = candidates[request] else { return }
        delivered.insert(request)
        let write = Task.detached { [store] in try store.record(scope: candidate.scope, comments: candidate.comments) }
        writes[request] = write
        defer { writes[request] = nil }
        try await write.value
        candidates[request] = nil
        delivered.remove(request)
        changed(candidate.scope)
    }
    func sheet(scope: ReviewScope) async throws -> ReviewSheet {
        // A later read reconciles a failed local write. It never repeats the prompt or promotes an uncertain send.
        let outstanding = delivered.filter { request in
            guard let pending = candidates[request]?.scope else { return false }
            return pending.conversation == scope.conversation && pending.document == scope.document
        }
        for request in outstanding { try await confirmed(request) }
        return try await Task.detached { [store] in try store.load(scope: scope) }.value
    }
    func set(scope: ReviewScope, id: String, state: String, expectedVersion: Int) async throws -> ReviewComment {
        let item = try await Task.detached { [store] in
            try store.set(scope: scope, id: id, state: state, expectedVersion: expectedVersion)
        }.value
        if item.version != expectedVersion { changed(scope) }
        return item
    }
}

/// The agent already received the quote and comment; locating the mark in the page can require additional source
/// the person never sent. That source belongs only in the reader's private copy of the item.
struct LiveReviewComment: Codable, Sendable {
    let commentId: String
    let threadId: String
    let kind: String
    let ordinal: Int
    let text: String
    let quote: String?
    let madeOnRevision: Int?
    let commentState: String
    let version: Int

    init(_ item: ReviewComment) {
        commentId = item.commentId; threadId = item.threadId; kind = item.kind; ordinal = item.ordinal
        text = item.text; quote = item.quote; madeOnRevision = item.madeOnRevision
        commentState = item.commentState; version = item.version
    }
}
