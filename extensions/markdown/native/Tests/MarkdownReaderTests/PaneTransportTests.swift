import Foundation
import Observation
import Testing
@testable import MarkdownReader

@Suite(.serialized) @MainActor struct PaneTransportTests {
    @Observable final class Page {
        var view = LivePaneView.loading
        weak var client: CollaborationClient?
    }

    private func eventually(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while try await !condition() {
            guard ContinuousClock.now < deadline else { throw LiveTestBridge.Failure.deadline }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    @Test func pageStateAndConfirmedNavigationPrecedeTheNewConnection() async throws {
        let server = try LiveTestBridge(mode: "transport"); defer { server.stop() }
        let config = try await server.configuration()
        try await config.reportStarting()
        let page = Page(), workspace = UUID(), original = UUID(), target = UUID()
        let client = CollaborationClient(configuration: config, workspace: workspace, document: original, view: { page.view }) { command in
            guard command.op == "navigate" else { return LiveResult(status: "closed") }
            page.view = LivePaneView(kind: "published", title: "Target", mode: "reading", dirty: false, conflict: false,
                storeId: command.storeId, documentId: command.documentId, revision: 1, digest: "sha256:" + String(repeating: "a", count: 64))
            page.client?.bind(document: target, closing: original)
            return LiveResult(status: "navigated", workspace: workspace.uuidString, document: target.uuidString,
                handle: workspace.uuidString + ":" + target.uuidString, view: page.view)
        }
        page.client = client; client.start(); defer { client.stop() }
        try await eventually { client.status == "Agent connected" }
        page.view = LivePaneView(kind: "scratchpad", title: "Draft", mode: "writing", dirty: true, conflict: false)
        func events() async throws -> [[String: Any]] {
            try #require(try await server.request(["op": "state"])["transport"] as? [[String: Any]])
        }
        try await eventually { try await events().contains { $0["path"] as? String == "/state" } }
        let result = try await server.request(["op": "navigate", "storeId": String(repeating: "a", count: 32), "documentId": "md-" + String(repeating: "b", count: 20)])
        #expect(result["status"] as? String == "navigated")
        try await eventually { try await events().filter { $0["path"] as? String == "/connect" }.count == 2 }
        let wire = try await events()
        #expect(wire.compactMap { $0["path"] as? String } == ["/starting", "/connect", "/state", "/result", "/connect"])
        let bodies = wire.dropFirst().compactMap { $0["body"] as? [String: Any] }
        let serials = bodies.compactMap { $0["serial"] as? Int }
        #expect(serials.count == 4 && serials == serials.sorted() && Set(serials).count == 4)
        #expect(bodies.compactMap { $0["document"] as? String } == [original.uuidString, original.uuidString, original.uuidString, target.uuidString])
    }

    @Test func unresolvedReceiptKeepsItsOriginalTransportAndHiddenAnswerKeepsItsLogicalDocument() async throws {
        let server = try LiveTestBridge(mode: "lost-receipt"); defer { server.stop() }
        let first = UUID(), second = UUID(), reopened = UUID(), logical = UUID()
        let request = UUID().uuidString
        var selectedKey = logical, replies: [UUID] = []
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: first,
            documentKey: { selectedKey }) { _ in LiveResult(status: "closed") }
        client.onDocumentPromptState = { key, id, _, state, _ in
            if id == request, state == "answered" { replies.append(key) }
        }
        client.start(); defer { client.stop() }
        try await eventually { client.status == "Agent connected" }
        let submission = Task { await client.submitAnnotation(requestId: request, threadId: request, text: "Why?", quote: nil, authoredRevision: 3) }
        try await eventually { try await server.request(["op": "state"])["submissions"] as? Int == 1 }
        selectedKey = second; client.bind(document: second)
        _ = try await server.request(["op": "release"])
        _ = await submission.value
        selectedKey = logical; client.bind(document: reopened)
        let receipt = await client.submitAnnotation(requestId: request, threadId: request, text: "Why?", quote: nil, authoredRevision: 3)
        #expect(receipt == .submitted)
        let prompts = try #require(try await server.request(["op": "state"])["prompts"] as? [[String: String]])
        #expect(prompts.count == 2 && prompts.first == prompts.last)
        #expect(prompts.first?["document"] == first.uuidString && prompts.first?["text"]?.contains("revision 3") == true)
        selectedKey = second; client.bind(document: second)
        _ = try await server.request(["op": "publish", "status": "answer", "text": "Because.", "operationId": request])
        try await eventually { replies == [logical] }
        #expect(client.answer.isEmpty)
    }

    @Test func stalePollReconnectsSameBindingAndVersionRefusalKeepsDraft() async throws {
        let server = try LiveTestBridge(mode: "transport"); defer { server.stop() }
        let config = try await server.configuration(), document = UUID()
        let client = CollaborationClient(configuration: config, workspace: UUID(), document: document) { _ in LiveResult(status: "closed") }
        client.start(); defer { client.stop() }
        try await eventually { client.status == "Agent connected" }
        client.prompt = "Unsent comment"
        _ = try await server.request(["op": "failPoll", "status": 409])
        try await eventually {
            let records = try await server.request(["op": "state"])["transport"] as? [[String: Any]] ?? []
            let connects = records.filter { $0["path"] as? String == "/connect" }.compactMap { $0["body"] as? [String: Any] }
            return connects.count == 2 && connects.allSatisfy { $0["document"] as? String == document.uuidString && $0["launchId"] as? String == config.launchId }
        }
        _ = try await server.request(["op": "failPoll", "status": 426])
        try await eventually { client.isClosed }
        #expect(client.connectionStatus.contains(config.target) && client.connectionStatus.contains("Reopen"))
        #expect(client.prompt == "Unsent comment")
        #expect(try await server.request(["op": "state"])["submissions"] as? Int == 0)
    }
}
