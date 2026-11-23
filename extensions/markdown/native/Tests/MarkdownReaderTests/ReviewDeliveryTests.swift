import Foundation
import Testing
@testable import MarkdownReader

@MainActor struct ReviewDeliveryTests {
    @Test func onlyConfirmedOriginalsReachTheirDocumentAndKeepEachAuthoredRevision() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let reviews = ReaderReviewComments(directory: root)
        let a = ReviewScope(conversation: "first", document: "a"), b = ReviewScope(conversation: "first", document: "b")
        let other = ReviewScope(conversation: "second", document: "a")
        let id = UUID(), request = ReaderReviewComments.Request(document: UUID(), id: id)
        let proof: [String: Any] = ["text": "**term**", "contexts": [["before": "A", "after": "."]], "headings": []]
        let packet: [String: Any] = ["requestId": id.uuidString, "threadId": id.uuidString, "overall": "For readers", "authoredRevision": 3,
            "annotations": [["text": "Explain this", "authoredRevision": 2, "quote": "term", "passageAnchor": proof, "quoteRange": ["start": 1, "end": 9]]]]
        reviews.prepare(request, scope: a, message: packet, source: "A**term**.")
        let initial = try await reviews.sheet(scope: a)
        #expect(initial.comments.isEmpty)
        // A view switch between send and confirmation is not a destination change for the review.
        reviews.prepare(request, scope: b, message: packet, source: "A different revision")
        try await reviews.confirmed(request)
        try await reviews.confirmed(request)
        let sheet = try await reviews.sheet(scope: a), elsewhere = try await reviews.sheet(scope: b), privateSheet = try await reviews.sheet(scope: other)
        #expect(elsewhere.comments.isEmpty); #expect(privateSheet.comments.isEmpty)
        #expect(sheet.comments.map(\.kind) == ["overall", "annotation"])
        #expect(sheet.comments.map(\.madeOnRevision) == [3, 2]); #expect(sheet.comments.last?.sourceAnchor == "**term**")
        let item = try #require(sheet.comments.last)
        let wire = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(LiveReviewComment(item))) as? [String: Any])
        #expect(wire["quote"] as? String == "term"); #expect(item.anchorDigest != nil); #expect(item.passageAnchor?.text == "**term**")
        #expect(wire["anchorDigest"] == nil); #expect(wire["sourceAnchor"] == nil); #expect(wire["passageAnchor"] == nil); #expect(wire["start"] == nil)
        #expect(ReaderReviewComments.initialComments(["requestId": UUID().uuidString, "threadId": id.uuidString, "text": "Follow up"], source: nil).isEmpty)
    }
}
