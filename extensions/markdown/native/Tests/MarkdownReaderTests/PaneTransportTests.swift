import Foundation
import Observation
import Testing
@testable import MarkdownReader

@Suite(.serialized) @MainActor struct PaneTransportTests {
    @Observable final class Page {
        var view = LivePaneView.loading
        weak var client: CollaborationClient?
    }

    private func eventually(within budget: Duration = .seconds(8), _ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: budget)
        while try await !condition() {
            guard ContinuousClock.now < deadline else { throw LiveTestBridge.Failure.deadline }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    @Test func pageStateAndConfirmedNavigationPrecedeTheNewConnection() async throws {
        let server = try LiveTestBridge(mode: "transport"); defer { server.stop() }
        let config = try await server.configuration(started: false)
        _ = try await config.reportStarting()
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

    enum Navigation: CaseIterable { case confirmed, refused, reselected, invalidReceipt }

    @Test(arguments: Navigation.allCases) func destinationSendWaitsForItsOwnNavigation(navigation: Navigation) async throws {
        let server = try LiveTestBridge(mode: "transport"); defer { server.stop() }
        let page = Page(), workspace = UUID(), original = UUID(), destination = UUID(), request = UUID().uuidString
        let text = "Why did this paragraph change?"
        var submission: CollaborationClient.PromptSubmission?
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: workspace, document: original, view: { page.view }) { command in
            guard command.op == "navigate", let client = page.client else { return LiveResult(status: "closed") }
            page.view = LivePaneView(kind: "published", title: "Destination", mode: "reading", dirty: false, conflict: false,
                storeId: command.storeId, documentId: command.documentId, revision: 1, digest: "sha256:" + String(repeating: "a", count: 64))
            client.bind(document: destination)
            Task { @MainActor in submission = await client.submitAnnotation(requestId: request, threadId: request, text: text, quote: nil) }
            do {
                try await eventually(within: .seconds(1)) { submission != nil || !client.isFreshPrompt(requestId: request) }
            } catch { Issue.record("The destination send never entered preparation") }
            #expect(submission == nil && !client.isFreshPrompt(requestId: request) && !client.knowsPrompt(requestId: request, threadId: request))
            if navigation == .refused { return LiveResult(status: "busy", message: "The destination did not confirm its page.") }
            if navigation == .reselected { client.bind(document: original); client.bind(document: destination) }
            var receiptView = page.view
            if navigation == .invalidReceipt { receiptView.revision = nil }
            return LiveResult(status: "navigated", workspace: workspace.uuidString, document: destination.uuidString,
                handle: workspace.uuidString + ":" + destination.uuidString, view: receiptView)
        }
        page.client = client; client.start(); defer { client.stop() }
        try await eventually { client.status == "Agent connected" }
        let receipt = try await server.request(["op": "navigate", "storeId": String(repeating: "a", count: 32), "documentId": "md-" + String(repeating: "b", count: 20)])
        if navigation == .invalidReceipt {
            #expect(receipt["status"] as? String == "uncertain")
            #expect((receipt["message"] as? String)?.contains("revision") == true)
        } else { #expect(receipt["status"] as? String == (navigation == .refused ? "busy" : "navigated")) }
        try await eventually {
            let state = try await server.request(["op": "state"])
            let events = state["transport"] as? [[String: Any]] ?? []
            return submission != nil && state["document"] as? String == destination.uuidString && events.contains {
                $0["path"] as? String == "/connect" && ($0["body"] as? [String: Any])?["document"] as? String == destination.uuidString
            }
        }
        let prompts = try #require(try await server.request(["op": "state"])["prompts"] as? [[String: String]])
        if navigation == .confirmed {
            #expect(submission == .submitted)
            #expect(prompts == [["workspace": workspace.uuidString, "document": destination.uuidString, "operationId": request, "text": text]])
        } else {
            guard case .refused = submission else { Issue.record("An invalidated destination send was not refused"); return }
            #expect(prompts.isEmpty && client.isFreshPrompt(requestId: request))
        }
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

    @Test func unconnectedSubmissionRemainsFreshAfterTimeoutOrRebind() async throws {
        let server = try LiveTestBridge(); defer { server.stop() }
        let logical = UUID(), reopened = UUID(), request = UUID().uuidString
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID(),
            documentKey: { logical }) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        func submit(_ text: String) async -> CollaborationClient.PromptSubmission {
            await client.submitAnnotation(requestId: request, threadId: request, text: text, quote: nil)
        }
        let timedOut = await submit("Before connection")
        guard case .refused = timedOut else { Issue.record("A request that never left the reader was not refused"); return }
        #expect(client.isFreshPrompt(requestId: request) && !client.hasPendingPrompt)
        let first = Task { await submit("Before switch") }
        try await eventually { !client.isFreshPrompt(requestId: request) }
        guard case .refused = await submit("Overlapping attempt") else { Issue.record("Duplicate preparation"); return }
        #expect(!client.isFreshPrompt(requestId: request))
        client.bind(document: reopened)
        guard case .refused = await first.value else { Issue.record("A request crossed a buffer switch"); return }
        #expect(client.isFreshPrompt(requestId: request) && !client.hasPendingPrompt)
        #expect(await submit("After switch") == .submitted)
        let prompts = try #require(try await server.request(["op": "state"])["prompts"] as? [[String: String]])
        #expect(prompts.count == 1 && prompts.first?["text"] == "After switch" && prompts.first?["document"] == reopened.uuidString)
        #expect(!client.isFreshPrompt(requestId: request))
    }

    @Test(arguments: [false, true]) func initialConnectDistinguishesStartupResetFromEndpointClosure(closed: Bool) async throws {
        let server = try LiveTestBridge(mode: closed ? "normal" : "reset-start"); defer { server.stop() }
        let config = try await server.configuration(started: false)
        _ = try await config.reportStarting()
        if closed { _ = try await server.request(["op": "closeEndpoint"]) }
        let client = CollaborationClient(configuration: config, workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        client.start(); defer { client.stop() }
        if closed {
            try await eventually { client.isClosed }
            #expect(client.connectionStatus.contains(config.target) && client.connectionStatus.contains("Reopen"))
            await client.stop()?.value
        } else {
            try await eventually { client.status == "Agent connected" }
            let state = try await server.request(["op": "state"])
            let events = try #require(state["transport"] as? [[String: Any]])
            let attempts = events.filter { $0["path"] as? String == "/starting" }.compactMap { $0["body"] as? [String: Any] }
            #expect(attempts.count >= 2 && attempts.allSatisfy { $0["launchId"] as? String == config.launchId })
        }
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
