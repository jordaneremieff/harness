import Foundation
import MarkdownCore
import ReaderFeature

extension EditorWorkspace {
    /// A published editor and its reading view share comments across revisions. A private copy does not inherit them.
    var reviewScope: ReviewScope? {
        guard !closing, !libraryVisible, publishedLibrary == nil,
              let conversation = collaboration?.conversation else { return nil }
        let key: String
        if let reading {
            guard let reference = reading.snapshot?.reference else { return nil }
            key = reference.key
        } else if let record = active?.session.record {
            switch record.destination {
            case .published(let base): key = DocumentReference.stored(root: base.root, storeId: base.storeId, document: base.document).key
            case .file(let file): key = DocumentReference.file(path: file.path).key
            case .copy, .scratchpad: key = "draft:\(record.id.uuidString):\(record.branch.uuidString)"
            }
        } else { return nil }
        return ReviewScope(conversation: conversation, document: key)
    }

    /// A page can finish a queued draft save after navigation. Resolve its issued reference, never the currently selected title or revision.
    private func pendingReviewScope(key: String) -> ReviewScope? {
        guard UUID(uuidString: key) != nil, let conversation = collaboration?.conversation else { return nil }
        guard let reference = webHostModel?.resolveReference(key) ?? reading?.resolveReference(key),
              case .stored = reference else { return nil }
        return ReviewScope(conversation: conversation, document: reference.key)
    }

    func reviewDraftPage(_ fields: [String: Any]) async throws -> [String: Any] {
        guard let key = fields["documentKey"] as? String else { throw ReviewStoreError.invalid }
        guard let scope = pendingReviewScope(key: key) else { return ["available": false, "version": 0] }
        let store = ReviewDraftStore(directory: reviewComments.store.directory)
        let snapshot = try await Task.detached { try store.load(scope: scope) }.value
        var reply: [String: Any] = ["available": true, "version": snapshot.version]
        if let bytes = snapshot.draft {
            guard let draft = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw ReviewStoreError.invalid }
            try ReaderBridgeCodec.validateReviewDraft(draft)
            reply["draft"] = draft
        }
        return reply
    }

    func reviewDraftSet(_ fields: [String: Any]) async -> [String: Any] {
        guard let key = fields["documentKey"] as? String, let scope = pendingReviewScope(key: key),
              let version = fields["expectedVersion"] as? Int else {
            return ["status": "error", "message": "This private review draft has no bound document and conversation."]
        }
        do {
            var payload: Data?
            if let content = fields["draft"] {
                guard let draft = content as? [String: Any] else { throw ReviewStoreError.invalid }
                // The native page codec has validated the schema before it reaches this owner.
                payload = try JSONSerialization.data(withJSONObject: draft, options: [.withoutEscapingSlashes])
            }
            let store = ReviewDraftStore(directory: reviewComments.store.directory)
            let next = try await Task.detached { [payload] in try store.set(scope: scope, expectedVersion: version, draft: payload) }.value
            return ["status": "stored", "version": next.version]
        } catch {
            if (error as? ReviewStoreError) == .stale {
                return ["status": "stale", "message": "Another pane changed this review batch. The reader kept its newer copy."]
            }
            let result = Self.reviewError(error)
            return ["status": result.status, "message": result.message ?? "The reader could not save the review batch."]
        }
    }

    func reviewPage(_ fields: [String: Any]) async throws -> [String: Any] {
        guard let key = fields["documentKey"] as? String, let logical = logicalDocumentKey, UUID(uuidString: key) == logical else {
            throw ReviewStoreError.stale
        }
        guard let scope = reviewScope else { return ["available": false, "comments": [], "revision": 0] }
        let sheet = try await reviewComments.sheet(scope: scope)
        guard logical == logicalDocumentKey, let current = reviewScope, current.document == scope.document, current.conversation == scope.conversation else {
            throw ReviewStoreError.stale
        }
        let data = try JSONEncoder().encode(sheet.comments)
        return ["available": true, "revision": sheet.revision, "comments": try JSONSerialization.jsonObject(with: data)]
    }

    func reviewPageSet(_ fields: [String: Any]) async -> [String: Any] {
        guard let key = fields["documentKey"] as? String, let logical = logicalDocumentKey, UUID(uuidString: key) == logical,
              let scope = reviewScope else {
            return ["status": "stale", "message": "This review no longer belongs to the shown document."]
        }
        guard let id = fields["commentId"] as? String, let state = fields["commentState"] as? String,
              let version = fields["expectedVersion"] as? Int else {
            return ["status": "error", "message": "A comment, state and current version are required."]
        }
        do {
            _ = try await reviewComments.set(scope: scope, id: id, state: state, expectedVersion: version)
            return ["status": "commentSet"]
        } catch {
            let result = Self.reviewError(error)
            return ["status": result.status, "message": result.message ?? "The reader could not change the comment."]
        }
    }

    func handleReview(_ command: LiveCommand) async -> LiveResult {
        guard livePaneView.kind != "loading" else { return LiveResult(status: "busy", message: "Select an open document first.") }
        guard let scope = reviewScope else { return LiveResult(status: "error", message: "This document has no review scope. Open it from the original conversation with the current reader.") }
        guard let state = command.commentState, state == "open" || state == "closed" else { return Self.reviewError(ReviewStoreError.invalid) }
        do {
            if command.op == "setComment", let id = command.commentId, let version = command.expectedVersion {
                let item = try await reviewComments.set(scope: scope, id: id, state: state, expectedVersion: version)
                return LiveResult(status: "commentSet", commentId: item.commentId, commentState: item.commentState, version: item.version)
            }
            guard command.op == "comments", let offset = command.offset, offset >= 0, offset == 0 || command.expectedVersion != nil else {
                throw ReviewStoreError.invalid
            }
            let sheet = try await reviewComments.sheet(scope: scope)
            guard command.document == liveDocumentID.uuidString, reviewScope?.document == scope.document, !closing else { return LiveResult(status: "closed", message: "The document changed during the comment read.") }
            guard command.expectedVersion == nil || sheet.revision == command.expectedVersion else {
                return LiveResult(status: "stale", message: "The comment list changed. Start again at offset zero.")
            }
            let items = sheet.comments.filter { $0.commentState == state }
            guard offset <= items.count else { throw ReviewStoreError.invalid }
            var page: [LiveReviewComment] = [], bytes = 0
            for item in items.dropFirst(offset).prefix(20) {
                let size = item.text.utf8.count + (item.quote?.utf8.count ?? 0)
                if !page.isEmpty, bytes + size > 65536 { break }
                bytes += size; page.append(.init(item))
            }
            let end = offset + page.count
            return LiveResult(status: "comments", commentState: state, version: sheet.revision, comments: page, total: items.count,
                              offset: offset, nextOffset: end == items.count ? nil : end)
        } catch { return Self.reviewError(error) }
    }

    private static func reviewError(_ error: Error) -> LiveResult {
        let status: String = switch error as? ReviewStoreError { case .stale: "stale"; case .busy: "busy"; default: "error" }
        return LiveResult(status: status, message: (error as? ReviewStoreError)?.localizedDescription ?? "The reader could not access the private review file.")
    }
}
