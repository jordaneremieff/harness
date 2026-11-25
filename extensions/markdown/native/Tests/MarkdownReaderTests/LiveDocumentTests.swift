import Testing
@testable import MarkdownCore
import AppKit
import EditorFeature
import ReaderFeature
@testable import MarkdownReader

/// Runs the production bridge on isolated loopback sockets; the proxy controls only receipt delivery.
@MainActor final class LiveTestBridge {
    enum Failure: Error { case response, deadline }
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var launchData: Data?
    private let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    init(mode: String = "normal") throws {
        let script = #"""
        import { createServer } from 'node:http';
        import { randomUUID } from 'node:crypto';
        import { readFile, writeFile } from 'node:fs/promises';
        import { createInterface } from 'node:readline';
        import { pathToFileURL } from 'node:url';
        const { LiveBridge } = await import(pathToFileURL(process.argv[1]));
        const mode = process.argv[2];
        let submissions = 0, release;
        const gate = new Promise(resolve => { release = resolve; });
        const prompts = [];
        const bridge = new LiveBridge({ submit: async () => {
          submissions++;
          if (mode === 'rejected' || (mode === 'reject-first' && submissions === 1)) return { status: 'rejected', message: 'This request was not admitted.' };
          if (mode === 'uncertain') throw new Error('Admission unavailable');
          if (mode === 'ordinary') return { status: 'requested' };
          return { status: 'admitted', submissionId: 'fixture' };
        } }, 2000, 100);
        const config = await bridge.start();
        const post = (route, body) => fetch(config.endpoint + route, {method:'POST', headers:{Authorization:'Bearer ' + config.token, 'Content-Type':'application/json'}, body:JSON.stringify(body)});
        const launchId = randomUUID();
        const reservation = await post('/reserve', { launchId, origin:mode === 'transport' ? 'agent' : 'operator' });
        if (!reservation.ok) throw new Error('Reservation refused: ' + reservation.status);
        const {path, expiresAt} = await reservation.json();
        const launch = JSON.parse(await readFile(path, 'utf8'));
        const transport = []; let currentConnect, pollFailure, resetStartup = mode === 'reset-start';
        const proxy = createServer(async (request, response) => {
          const chunks = [];
          try { for await (const chunk of request) chunks.push(chunk); }
          catch (error) { if (request.aborted && error.code === 'ECONNRESET') return; throw error; }
          const body = Buffer.concat(chunks).toString();
          if (request.url === '/connect') currentConnect = JSON.parse(body);
          if (['/connect','/result','/state','/starting'].includes(request.url)) transport.push({path:request.url, body:JSON.parse(body)});
          if (request.url === '/poll' && pollFailure) {response.writeHead(pollFailure); pollFailure = undefined; response.end(); return;}
          if (request.url === '/prompt') prompts.push(JSON.parse(body));
          const upstream = await fetch(config.endpoint + request.url, { method: 'POST',
            headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' }, body });
          const text = await upstream.text();
          if (request.url === '/starting' && resetStartup && upstream.ok) { resetStartup = false; response.destroy(); return; }
          if (request.url === '/prompt' && ((mode === 'lost-receipt' && prompts.length === 1) ||
              (mode === 'lost-follow-up-receipt' && prompts.length === 2))) {
            await gate;
            response.writeHead(200); response.end('{');
          } else if (mode === 'unscoped' && request.url === '/poll') {
            const poll = JSON.parse(text); delete poll.state.operationId;
            response.writeHead(upstream.status); response.end(JSON.stringify(poll));
          } else { response.writeHead(upstream.status); response.end(text); }
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const write = value => process.stdout.write(JSON.stringify(value) + '\n');
        launch.endpoint = 'http://127.0.0.1:' + proxy.address().port;
        await writeFile(path, JSON.stringify(launch));
        write({ ...launch, path });
        const lines = createInterface({ input: process.stdin });
        for await (const line of lines) {
          const command = JSON.parse(line);
          if (command.op === 'release') { release(); write({ ok: true }); }
          else if (command.op === 'state') {
            const pane = bridge.list()[0];
            write({ document: pane?.document, view: pane?.view, prompts, submissions, transport, failed: bridge.failedLaunches(), departed: bridge.paneDepartures() });
          }
          else if (command.op === 'expireOffer') {
            const now = Date.now;
            try { Date.now = () => expiresAt + 1; write({ pending: bridge.pendingLaunches() }); }
            finally { Date.now = now; }
          }
          else if (command.op === 'closeEndpoint') { proxy.close(); proxy.closeAllConnections(); write({ok:true}); }
          else if (command.op === 'failPoll') { pollFailure = command.status; write({ok:true}); }
          else if (command.op === 'navigate' || command.op === 'claim') write(await bridge.execute(bridge.list()[0].handle, command));
          else if (command.op === 'publish') { bridge.publish(command.status, command.text, command.operationId); write({ ok: true }); }
          else if (command.op === 'read') write(await bridge.execute(bridge.list()[0].handle, { op: 'read' }));
          else if (command.op === 'connect') {
            const response = await fetch(config.endpoint + '/connect', { method: 'POST',
              headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' }, body: JSON.stringify({...currentConnect, ...command, serial:currentConnect.serial + 1}) });
            write({ status: response.status });
          }
        }
        """#
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--input-type=module", "-e", "setTimeout(() => process.exit(2), 60000).unref();\n" + script, root.appendingPathComponent("live-bridge.ts").path, mode]
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        var environment = ProcessInfo.processInfo.environment
        environment["PI_CODING_AGENT_DIR"] = home.path; process.environment = environment
        process.standardInput = input; process.standardOutput = output
        try process.run()
    }
    func stop() {
        if process.isRunning { process.terminate() }
        try? input.fileHandleForWriting.close()
        try? FileManager.default.removeItem(at: home)
    }
    private func launch() async throws -> Data {
        if let launchData { return launchData }
        let data = try await line()
        launchData = data
        return data
    }
    func configuration(started: Bool = true) async throws -> CollaborationConfiguration {
        let config = try JSONDecoder().decode(CollaborationConfiguration.self, from: await launch())
        if started { _ = try await config.reportStarting() }
        return config
    }
    func configurationFile() async throws -> URL {
        let data = try await launch()
        let fields = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return URL(fileURLWithPath: try #require(fields["path"] as? String))
    }
    func request(_ value: [String: Any]) async throws -> [String: Any] {
        var bytes = try JSONSerialization.data(withJSONObject: value); bytes.append(10)
        try input.fileHandleForWriting.write(contentsOf: bytes)
        return try #require(JSONSerialization.jsonObject(with: await line()) as? [String: Any])
    }
    private func line() async throws -> Data {
        let handle = output.fileHandleForReading
        return try await Task.detached {
            var bytes = Data()
            while bytes.count < 65536, let next = try handle.read(upToCount: 1), !next.isEmpty {
                if next[0] == 10 { return bytes }
                bytes.append(next)
            }
            throw Failure.response
        }.value
    }
}

@Suite(.serialized) @MainActor struct LiveDocumentTests {
    private func directory() throws -> URL {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("live-document-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func connectPage(_ workspace: EditorWorkspace) {
        workspace.webReady = true
        workspace.webAgentApply = { [weak workspace] operation, generation, edits in
            guard let workspace else { return .refused(reason: "closed") }
            let change = WebPageChange(baseGeneration: generation, generation: generation + 1, origin: "agent", operationId: operation, edits: edits)
            do { _ = try await workspace.receivePageChange(change); return .accepted(change) }
            catch { return .refused(reason: "stale") }
        }
    }

    private func command(_ workspace: EditorWorkspace, source: String, generation: UInt64, edit: LiveTextEdit, operation: String = UUID().uuidString) -> LiveCommand {
        LiveCommand(requestId: UUID().uuidString, workspace: workspace.id.uuidString, document: workspace.liveDocumentID.uuidString,
            op: "apply", operationId: operation, baseGeneration: generation, baseDigest: Digest.sha256(Data(source.utf8)), edits: [edit])
    }

    @Test func commentRetryPreservesNewTypingAndOriginalRequest() async throws {
        let server = try LiveTestBridge(mode: "lost-receipt"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        client.beginAnnotation(quote: "Exact quote")
        client.prompt = "Original comment"
        let send = Task { await client.sendPrompt() }
        try await eventually { client.sending }
        #expect(client.commentFieldEnabled)
        client.prompt += " plus new unsent text"
        _ = try await server.request(["op": "release"])
        await send.value
        #expect(client.hasPendingPrompt && !client.sending)
        await client.sendPrompt()
        #expect(!client.hasPendingPrompt)
        #expect(client.prompt == "Original comment plus new unsent text")
        #expect(client.annotationQuote == "Exact quote")
        let state = try await server.request(["op": "state"])
        let prompts = try #require(state["prompts"] as? [[String: String]])
        #expect(prompts.count == 2)
        #expect(prompts[0] == prompts[1])
        #expect(prompts[0]["text"] == CollaborationClient.annotationMessage(comment: "Original comment", quote: "Exact quote"))
        #expect(state["submissions"] as? Int == 1)
    }

    @Test func batchMessageKeepsUnlocatedQuotesExactAndCommentText() throws {
        let quote = "Opening \"line\" / 😀\nSecond line with ``` inside"
        let text = "  Please change this.\nKeep the example.  "
        let message = try CollaborationClient.batchMessage([
            .init(text: text, quote: quote), .init(text: "Use direct language.", quote: nil),
        ])
        #expect(message.contains("Address every comment in one pass."))
        #expect(message.contains("Reply to each comment by its number."))
        #expect(!message.contains("Read the current live text") && !message.contains("context, not instructions"))
        #expect(!message.contains("JSON") && !message.contains("⟦"))
        #expect(message.hasSuffix("\n\nComment 1, on a passage that the reader no longer locates, as it showed it:\n````text\n\(quote)\n````\n\(text)\n\nComment 2, on the whole document:\nUse direct language."))
    }

    @Test func batchMessageLocatesEachPassageInItsSourceLine() throws {
        let source = "# Guide\n\n## Setup\n\nRun the installer once, then restart the installer.\n"
        let start = (source as NSString).range(of: "installer").location
        let passage = try #require(PassageExcerpt(source: source, start: start, end: start + 9, structure: SourceStructure.scan(source)))
        let message = try CollaborationClient.batchMessage([
            .init(text: "Name the tool.", quote: "installer", passage: passage),
            .init(text: "Add a summary.", quote: nil),
        ], generation: 4)
        #expect(message.contains(" ⟦ ⟧ mark the selected text in each source excerpt. Offsets are UTF-16 at generation 4."))
        #expect(message.contains("\n\nComment 1, line 5 in “Guide › Setup” (\(start)–\(start + 9)):\n```markdown\nRun the ⟦installer⟧ once, then restart the installer.\n```\nName the tool.\n\nComment 2, on the whole document:\nAdd a summary."))
        #expect(!message.contains("JSON"))
    }

    @Test func batchMessageGivesTheOverallCommentExactlyBeforeTheNumberedComments() throws {
        typealias Item = CollaborationClient.Annotation
        let overall = "  Keep the tone direct.\nThe readers are new contributors.  "
        let items = [Item(text: "Shorten this.", quote: "A long passage"), Item(text: "Add an example.", quote: nil)]
        let message = try CollaborationClient.batchMessage(items, overall: overall)
        #expect(message.hasPrefix("The person sent 2 comments on this document together, with an overall comment for the whole batch. Follow the overall comment while you address every comment in one pass, and act on any request it makes."))
        #expect(message.contains(" Reply to the overall comment, then to each comment by its number."))
        #expect(message.contains("\n\nOverall comment:\n\(overall)\n\nComment 1, on a passage that the reader no longer locates, as it showed it:\n"))
        #expect(message.hasSuffix("\n\nComment 2, on the whole document:\nAdd an example."))
        let plain = try CollaborationClient.batchMessage(items)
        #expect(!plain.contains("overall") && plain.contains(" Reply to each comment by its number."))
        for blank in [" \n", "\u{85}"] {
            #expect(throws: CollaborationClient.PromptRefusal.self) { try CollaborationClient.batchMessage(items, overall: blank) }
        }
        #expect(try CollaborationClient.batchMessage(items, overall: String(repeating: "o", count: 64 * 1024)).contains("Overall comment:"))
        #expect(throws: CollaborationClient.PromptRefusal.self) {
            try CollaborationClient.batchMessage(items, overall: String(repeating: "o", count: 64 * 1024 + 1))
        }
    }

    @Test func batchMessageEnforcesByteAndCountLimits() throws {
        typealias Item = CollaborationClient.Annotation
        let quote = String(repeating: "😀", count: 2048)
        #expect(throws: CollaborationClient.PromptRefusal.self) { try CollaborationClient.batchMessage([]) }
        #expect(throws: CollaborationClient.PromptRefusal.self) {
            try CollaborationClient.batchMessage(Array(repeating: Item(text: "One", quote: nil), count: 51))
        }
        #expect(throws: CollaborationClient.PromptRefusal.self) {
            try CollaborationClient.batchMessage([Item(text: " \n", quote: nil)])
        }
        let article = [Item(text: "First", quote: nil), Item(text: "Second", quote: quote)]
        let base = try CollaborationClient.batchMessage(article)
        #expect(base.contains(quote))
        do {
            _ = try CollaborationClient.batchMessage([article[0], Item(text: "Second", quote: quote + "!")])
            Issue.record("An oversized quote was accepted")
        } catch let refusal as CollaborationClient.PromptRefusal {
            #expect(refusal.detail == "Select a shorter passage for comment 2.")
        }
        let first = String(repeating: "a", count: 65536)
        let second = String(repeating: "b", count: 131072 - base.utf8.count - first.utf8.count)
        let boundary = [Item(text: "First" + first, quote: nil), Item(text: "Second" + second, quote: quote)]
        #expect(try CollaborationClient.batchMessage(boundary).utf8.count == 131072)
        #expect(throws: CollaborationClient.PromptRefusal.self) {
            try CollaborationClient.batchMessage([boundary[0], Item(text: boundary[1].text + "!", quote: quote)])
        }
    }

    @Test func batchAndFollowUpUseOneThreadAndSeparateRequests() async throws {
        let server = try LiveTestBridge(mode: "ordinary"); defer { server.stop() }
        let document = UUID()
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: document) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let thread = UUID().uuidString, followUp = UUID().uuidString
        let batch: [CollaborationClient.Annotation] = [.init(text: "First", quote: "A passage"), .init(text: "Second", quote: "Another passage")]
        #expect(await client.submitBatch(requestId: thread, threadId: thread, annotations: batch) == .submitted)
        #expect(client.currentAdmittedThreadId(for: document) == thread)
        #expect(await client.submitPrompt(requestId: followUp, threadId: thread, text: "Follow-up"))
        let state = try await server.request(["op": "state"])
        let prompts = try #require(state["prompts"] as? [[String: String]])
        #expect(prompts.map { $0["operationId"] } == [thread, followUp])
        #expect(try prompts.first?["text"] == CollaborationClient.batchMessage(batch))
        #expect(prompts.first?["follows"] == nil && prompts.last?["follows"] == thread)
        #expect(prompts.last?["text"] == "Keep that request’s comments as context.\n\nFollow-up")
    }

    @Test func anOverallCommentTravelsWithItsBatchAndStaysFollowUpContext() async throws {
        let server = try LiveTestBridge(mode: "ordinary"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let thread = UUID().uuidString, followUp = UUID().uuidString
        let batch: [CollaborationClient.Annotation] = [.init(text: "First", quote: "A passage")]
        #expect(await client.submitBatch(requestId: thread, threadId: thread, annotations: batch, overall: "Keep it short.") == .submitted)
        #expect(await client.submitPrompt(requestId: followUp, threadId: thread, text: "And the title?"))
        let prompts = try #require(try await server.request(["op": "state"])["prompts"] as? [[String: String]])
        #expect(try prompts.first?["text"] == CollaborationClient.batchMessage(batch, overall: "Keep it short."))
        #expect(prompts.last?["follows"] == thread)
        #expect(prompts.last?["text"] == "Keep that request’s overall comment and comments as context.\n\nAnd the title?")
    }

    @Test func ordinaryReplyReachesItsQuestionAndAllowsAFollowUp() async throws {
        let server = try LiveTestBridge(mode: "ordinary"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        var states: [(request: String, thread: String, state: String, detail: String?)] = []
        client.onPromptState = { states.append(($0, $1, $2, $3)) }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let thread = UUID().uuidString
        #expect(await client.submitPrompt(requestId: thread, threadId: thread, text: "Shorten this", quote: "Long passage"))
        #expect(states.last?.state == "sent")
        _ = try await server.request(["op": "publish", "status": "working", "text": "", "operationId": thread])
        try await eventually { states.last?.state == "working" }
        _ = try await server.request(["op": "publish", "status": "answer", "text": "Shortened.", "operationId": thread])
        try await eventually { states.last?.state == "answered" }
        #expect(states.last?.request == thread && states.last?.thread == thread)
        #expect(states.last?.detail == "Shortened.")
        let followUp = UUID().uuidString
        #expect(await client.submitPrompt(requestId: followUp, threadId: thread, text: "Shorter again"))
        #expect(states.last?.request == followUp && states.last?.state == "sent")
        let long = String(repeating: "Text.\n", count: 14000)
        _ = try await server.request(["op": "publish", "status": "answer", "text": long, "operationId": followUp])
        try await eventually { states.last?.request == followUp && states.last?.state == "answered" }
        #expect(states.last?.detail?.hasPrefix("Text.\n") == true)
        #expect(states.last?.detail?.hasSuffix("[Reply shortened. The full reply is in chat.]") == true)
    }

    @Test func failedBatchPostOffersAnExactRetryWithoutAnotherSubmission() async throws {
        let server = try LiveTestBridge(mode: "lost-receipt"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let id = UUID().uuidString
        let items: [CollaborationClient.Annotation] = [.init(text: "Explain.", quote: "A passage")]
        let send = Task { await client.submitBatch(requestId: id, threadId: id, annotations: items) }
        try await eventually { try await server.request(["op": "state"])["submissions"] as? Int == 1 }
        _ = try await server.request(["op": "release"])
        #expect(await send.value == .unknown(retryable: true))
        #expect(client.knowsPrompt(requestId: id, threadId: id))
        #expect(await client.submitBatch(requestId: id, threadId: id, annotations: items) == .submitted)
        let state = try await server.request(["op": "state"])
        let posts = try #require(state["prompts"] as? [[String: String]])
        #expect(posts.count == 2 && posts.first == posts.last)
        #expect(state["submissions"] as? Int == 1)
    }

    @Test func aRetryAfterTheDocumentChangedRepeatsItsFirstMessage() async throws {
        let server = try LiveTestBridge(mode: "lost-receipt"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let before = "Intro.\n\nThe word here.\n", after = "New first line.\n" + before
        let range = NSRange(location: 12, length: 4)
        let first = try #require(PassageExcerpt(source: before, start: 12, end: 16))
        let moved = try #require(PassageExcerpt(source: after, start: 12 + 16, end: 16 + 16))
        #expect(first.lines != moved.lines)
        let id = UUID().uuidString
        let send = Task { await client.submitAnnotation(requestId: id, threadId: id, text: "Why?", quote: "word", range: range, passage: first, generation: 1) }
        try await eventually { try await server.request(["op": "state"])["submissions"] as? Int == 1 }
        _ = try await server.request(["op": "release"])
        #expect(await send.value == .unknown(retryable: true))
        #expect(await client.submitAnnotation(requestId: id, threadId: id, text: "Why?", quote: "word", range: range, passage: moved, generation: 2) == .submitted)
        let posts = try #require(try await server.request(["op": "state"])["prompts"] as? [[String: String]])
        #expect(posts.count == 2 && posts.first == posts.last)
        #expect(posts.first?["text"]?.contains("line 3 ") == true)
        let changed = NSRange(location: 13, length: 3)
        #expect(await client.submitAnnotation(requestId: id, threadId: id, text: "Why?", quote: "word", range: changed, passage: moved) == .refused("The request ID names different comment text."))
    }

    @Test func aFollowUpRetryKeepsItsBodyAndContextRequest() async throws {
        let server = try LiveTestBridge(mode: "lost-follow-up-receipt"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let thread = UUID().uuidString, followUp = UUID().uuidString
        #expect(await client.submitPrompt(requestId: thread, threadId: thread, text: "Explain the document.") == true)
        let send = Task { await client.submitAnnotation(requestId: followUp, threadId: thread, text: "Explain more.", quote: nil) }
        try await eventually { try await server.request(["op": "state"])["submissions"] as? Int == 2 }
        _ = try await server.request(["op": "release"])
        #expect(await send.value == .unknown(retryable: true))
        #expect(await client.submitAnnotation(requestId: followUp, threadId: thread, text: "Explain more.", quote: nil) == .submitted)
        let state = try await server.request(["op": "state"])
        let posts = try #require(state["prompts"] as? [[String: String]])
        #expect(posts.map { $0["operationId"] } == [thread, followUp, followUp])
        #expect(posts.first?["follows"] == nil && posts.last?["follows"] == thread)
        #expect(posts.last?["text"] == "Explain more.")
        #expect(posts.dropFirst().first == posts.last && state["submissions"] as? Int == 2)
    }

    @Test func aFollowUpGivesThePassageUntilAMessageThatGaveItIsDelivered() async throws {
        let server = try LiveTestBridge(mode: "reject-first"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let source = "# Notes\n\nThe word here.\n"
        let start = (source as NSString).range(of: "word").location
        let passage = try #require(PassageExcerpt(source: source, start: start, end: start + 4, structure: SourceStructure.scan(source)))
        let range = NSRange(location: start, length: 4)
        let thread = UUID().uuidString, second = UUID().uuidString, third = UUID().uuidString
        #expect(await client.submitAnnotation(requestId: thread, threadId: thread, text: "Why?", quote: "word", range: range, passage: passage)
            == .refused("This request was not admitted."))
        #expect(await client.submitAnnotation(requestId: second, threadId: thread, text: "Why this word?", quote: "word", range: range, passage: passage) == .submitted)
        #expect(await client.submitAnnotation(requestId: third, threadId: thread, text: "And then?", quote: "word", range: range, passage: passage) == .submitted)
        let prompts = try #require(try await server.request(["op": "state"])["prompts"] as? [[String: String]])
        #expect(prompts.map { $0["follows"] } == [nil, nil, second])
        #expect(prompts[1]["text"]?.hasPrefix("Comment on line 3 in “Notes”") == true)
        #expect(prompts[1]["text"]?.contains("\nThe ⟦word⟧ here.\n") == true)
        #expect(prompts[2]["text"] == "Keep its passage as context.\n\nAnd then?")
    }

    @Test func aRequestIDNamesExactlyTheInputsOfItsFirstSubmission() async throws {
        let server = try LiveTestBridge(mode: "ordinary"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        client.start()
        try await eventually { client.status == "Agent connected" }
        typealias Item = CollaborationClient.Annotation
        let changed = CollaborationClient.PromptSubmission.refused("The request ID names different comment text.")
        let batch = UUID().uuidString
        #expect(await client.submitBatch(requestId: batch, threadId: batch, annotations: [Item(text: "A\u{1F}B", quote: "C")]) == .submitted)
        #expect(await client.submitBatch(requestId: batch, threadId: batch, annotations: [Item(text: "A", quote: "B\u{1F}C")]) == changed)
        #expect(await client.submitBatch(requestId: batch, threadId: batch, annotations: [Item(text: "A\u{1F}B", quote: "C")]) == .submitted)
        let withOverall = UUID().uuidString, items = [Item(text: "A", quote: nil)]
        #expect(await client.submitBatch(requestId: withOverall, threadId: withOverall, annotations: items, overall: "Overall") == .submitted)
        #expect(await client.submitBatch(requestId: withOverall, threadId: withOverall, annotations: items, overall: "Other") == changed)
        #expect(await client.submitBatch(requestId: withOverall, threadId: withOverall, annotations: items) == changed)
        #expect(await client.submitBatch(requestId: withOverall, threadId: withOverall, annotations: items, overall: "Overall") == .submitted)
        let single = UUID().uuidString, range = NSRange(location: 0, length: 4)
        #expect(await client.submitAnnotation(requestId: single, threadId: single, text: "Why?", quote: "word", range: range) == .submitted)
        #expect(await client.submitAnnotation(requestId: single, threadId: single, text: "Why?", quote: "other", range: range) == changed)
        #expect(try await server.request(["op": "state"])["submissions"] as? Int == 3)
    }

    @Test func anAnswerBeforeALostReceiptConfirmsTheQuestionWithoutResubmission() async throws {
        let server = try LiveTestBridge(mode: "lost-receipt"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        var states: [String] = []
        client.onPromptState = { _, _, state, _ in states.append(state) }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let id = UUID().uuidString
        let send = Task { await client.submitPrompt(requestId: id, threadId: id, text: "Explain.") }
        try await eventually { try await server.request(["op": "state"])["submissions"] as? Int == 1 }
        _ = try await server.request(["op": "publish", "status": "answer", "operationId": id, "text": "Here is why."])
        try await eventually { states.last == "answered" }
        _ = try await server.request(["op": "release"])
        #expect(await send.value)
        #expect(states.last == "answered" && !client.hasPendingPrompt)
        #expect(await client.submitPrompt(requestId: id, threadId: id, text: "Explain."))
        #expect(try await server.request(["op": "state"])["submissions"] as? Int == 1)
    }

    @Test func rejectedCommentUnlocksDraftAndUncertainAdmissionDoesNotResubmit() async throws {
        for mode in ["rejected", "uncertain"] {
            let server = try LiveTestBridge(mode: mode); defer { server.stop() }
            let document = UUID()
            let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: document) { _ in LiveResult(status: "closed") }
            defer { client.stop() }
            client.start()
            try await eventually { client.status == "Agent connected" }
            client.prompt = "Keep this comment"
            await client.sendPrompt()
            #expect(client.prompt == "Keep this comment")
            if mode == "rejected" {
                #expect(!client.hasPendingPrompt && client.commentFieldEnabled)
                #expect(client.promptIssue != nil)
            } else {
                #expect(client.hasPendingPrompt && !client.canRetryPrompt)
                let message = client.status, other = UUID()
                client.bind(document: other)
                try await connected(server, document: other)
                client.bind(document: document)
                try await connected(server, document: document)
                #expect(!client.canRetryPrompt && client.status == message)
                await client.sendPrompt()
                let state = try await server.request(["op": "state"])
                #expect(state["submissions"] as? Int == 1)
            }
        }
    }

    @Test func nativeSelectionReconnectsOpenDocumentsAndRetiresClosedDocuments() async throws {
        _ = NSApplication.shared
        let server = try LiveTestBridge(); defer { server.stop() }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "First document"))
        let first = try #require(workspace.active)
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: workspace.id, document: workspace.liveDocumentID) { [weak workspace] command in
            await workspace?.handleLive(command) ?? LiveResult(status: "closed")
        }
        workspace.collaboration = client
        client.start()
        try await connected(server, document: first.id)
        workspace.add(DraftRecord(source: "Second document"))
        let second = try #require(workspace.active)
        try await connected(server, document: second.id)
        workspace.select(first)
        try await connected(server, document: first.id)
        #expect(!client.isClosed)
        #expect(try await server.request(["op": "read"])["source"] as? String == "First document")
        workspace.select(second)
        try await connected(server, document: second.id)
        await workspace.closeActive()
        try await connected(server, document: first.id)
        #expect(!client.isClosed && workspace.active === first)
        #expect(try await server.request(["op": "read"])["source"] as? String == "First document")
        let refused = try await server.request(["op": "connect", "workspace": workspace.id.uuidString, "document": second.id.uuidString])
        #expect(refused["status"] as? Int == 409)
        await workspace.closeViews()
    }

    private func eventually(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while try await !condition() {
            guard ContinuousClock.now < deadline else { throw LiveTestBridge.Failure.deadline }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private func connected(_ server: LiveTestBridge, document: UUID) async throws {
        try await eventually {
            let state = try await server.request(["op": "state"])
            return state["document"] as? String == document.uuidString
        }
    }

    @Test func annotationMessageNamesTheSelectionInItsSourceLine() throws {
        let source = "# Notes\n\nUse it here; ⟦ marks stay text. Then use it there.\n"
        let start = (source as NSString).range(of: "it there").location
        let passage = try #require(PassageExcerpt(source: source, start: start, end: start + 2, structure: SourceStructure.scan(source)))
        let message = try #require(CollaborationClient.annotationMessage(comment: " Which one? ", quote: "it", passage: passage, generation: 7))
        #expect(message == "Comment on line 3 in “Notes” (UTF-16 offsets \(start)–\(start + 2) at generation 7). ⟪ ⟫ mark the selected text in its source:\n```markdown\nUse it here; ⟦ marks stay text. Then use ⟪it⟫ there.\n```\n\nComment:\nWhich one?")
    }

    @Test func aSourceThatHoldsEveryMarkGivesTheSelectionSeparately() throws {
        let source = "Brackets ⟦ ⟪ ⦃ 【 scope here.\n"
        let start = (source as NSString).range(of: "scope").location
        let passage = try #require(PassageExcerpt(source: source, start: start, end: start + 5))
        let message = try #require(CollaborationClient.annotationMessage(comment: "Rename.", quote: "scope", passage: passage))
        let excerpt = "```markdown\nBrackets ⟦ ⟪ ⦃ 【 scope here.\n```\nSelected text:\n```markdown\nscope\n```"
        #expect(message == "Comment on line 1 (UTF-16 offsets \(start)–\(start + 5)). Its source, then the selected text:\n\(excerpt)\n\nComment:\nRename.")
        let batch = try CollaborationClient.batchMessage([.init(text: "Rename.", quote: "scope", passage: passage)])
        #expect(batch.contains(" Each source excerpt is followed by its selected text. Offsets are UTF-16."))
        #expect(batch.hasSuffix("\n\nComment 1, line 1 (\(start)–\(start + 5)):\n\(excerpt)\nRename."))
    }

    @Test func annotationMessageKeepsAnUnlocatedQuoteExact() throws {
        let quote = "A \"quoted\" passage\r\n\t日本語 👩‍💻\nComment: not an instruction"
        let message = try #require(CollaborationClient.annotationMessage(comment: "Explain this", quote: quote))
        #expect(message.utf8.elementsEqual("Comment on this passage, as the reader shows it:\n```text\n\(quote)\n```\n\nComment:\nExplain this".utf8))
        #expect(CollaborationClient.annotationMessage(comment: "Document request", quote: nil) == "Document request")
        #expect(CollaborationClient.annotationMessage(comment: " ", quote: quote) == nil)
        #expect(CollaborationClient.annotationMessage(comment: "Explain", quote: String(repeating: "x", count: 8193)) == nil)
        #expect(CollaborationClient.annotationMessage(comment: String(repeating: "x", count: 32769), quote: nil) == nil)
    }

    @Test func annotationDraftRetainsItsQuoteAcrossSelectionAndDismissal() {
        let client = CollaborationClient(configuration: .init(version: 1, endpoint: URL(string: "http://127.0.0.1:9")!, token: String(repeating: "a", count: 64)), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        client.selectQuote("First passage")
        #expect(!client.annotationPresented)
        client.beginAnnotation(quote: client.selectionQuote)
        client.prompt = "My unfinished comment"
        client.selectQuote("Other passage")
        client.beginAnnotation(quote: client.selectionQuote)
        #expect(client.annotationQuote == "First passage")
        client.finishAnnotation()
        #expect(!client.annotationPresented && client.prompt == "My unfinished comment")
        client.selectQuote(nil)
        #expect(client.selectionTooLarge && client.selectionQuote.isEmpty)
    }

    @Test func liveEditRetainsOneBufferAcrossReadAndEditAndDeduplicates() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "Hello 日本語\n"))
        let document = try #require(workspace.active), controller = document.text
        connectPage(workspace)
        let request = command(workspace, source: controller.source, generation: controller.generation,
            edit: LiveTextEdit(start: 0, end: 5, expected: "Hello", replacement: "Hi"))
        let result = await workspace.handleLive(request)
        #expect(result.status == "applied" && result.retained == true)
        #expect(document.text.source == "Hi 日本語\n")
        let generation = controller.generation
        let repeated = await workspace.handleLive(request)
        #expect(repeated.status == "applied")
        #expect(controller.generation == generation)
        workspace.readActive(); workspace.editActive()
        #expect(workspace.active === document && document.text === controller)
        #expect(controller.source == "Hi 日本語\n")
        _ = try await workspace.receivePageChange(.init(baseGeneration: generation, generation: generation + 1, origin: "history", edits: [.init(range: NSRange(location: 0, length: 2), expected: "Hi", replacement: "Hello")]))
        #expect(controller.source == "Hello 日本語\n")
        let record = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(record.liveReceipts?.first?.operationId == request.operationId)
        await workspace.closeViews()
    }

    @Test func staleWrongHandleAndInvalidUnicodeEditsPreserveSource() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "🌱 unchanged"))
        let document = try #require(workspace.active)
        connectPage(workspace)
        var request = command(workspace, source: "old", generation: 0, edit: .init(start: 0, end: 1, expected: "o", replacement: "x"))
        #expect(await workspace.handleLive(request).status == "stale")
        request.document = UUID().uuidString
        #expect(await workspace.handleLive(request).status == "closed")
        request = command(workspace, source: document.text.source, generation: 0, edit: .init(start: 1, end: 2, expected: "x", replacement: "y"))
        #expect(await workspace.handleLive(request).status == "error")
        #expect(document.text.source == "🌱 unchanged")
        await workspace.closeViews()
    }

    @Test func coalescedFilePersistenceNeedsNoSaveAction() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("live.md")
        try Data("before".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil, automaticallySaves: true)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        connectPage(workspace)
        _ = document.text.apply(range: NSRange(location: 0, length: 6), replacement: "after", selection: NSRange(location: 5, length: 0), actionName: "Edit")
        await document.persistenceTask?.value
        #expect(try String(contentsOf: file, encoding: .utf8) == "after")
        #expect(!document.session.isDirty)
        await workspace.closeViews()
    }

    @Test func automaticSaveDoesNotPublishPrivateDrafts() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = root.appendingPathComponent("store")
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: store.path, automaticallySaves: true)
        let base = StoredEditBase(root: store.path, storeId: String(repeating: "1", count: 32), document: "md-" + String(repeating: "2", count: 20), revision: 1, digest: Digest.sha256(Data("before".utf8)))
        for destination in [EditDestination.scratchpad, .copy(base)] {
            workspace.add(DraftRecord(source: "before", destination: destination))
            let draft = try #require(workspace.active)
            #expect(draft.text.apply(range: NSRange(location: 0, length: 6), replacement: "after", selection: nil, actionName: "Edit"))
            #expect(draft.persistenceTask == nil)
            await draft.persistenceTask?.value
            #expect(await draft.session.persist())
            #expect(draft.session.record.destination == destination)
            #expect(draft.session.record.pendingPublication == nil)
            let retained = try await workspace.drafts.load(id: draft.session.record.id, branch: draft.session.record.branch)
            #expect(retained.source == "after")
        }
        #expect(!FileManager.default.fileExists(atPath: store.path))
        await workspace.closeViews()
    }

    @Test func quickCloseSavesAnEditedFileBeforeTheDebounce() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("close.md")
        try Data("before".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil, automaticallySaves: true)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        #expect(document.text.apply(range: NSRange(location: 0, length: 6), replacement: "after", selection: nil, actionName: "Edit"))
        #expect(await workspace.prepareToClose())
        #expect(try Data(contentsOf: file) == Data("after".utf8))
        #expect(!document.session.isDirty)
        await workspace.closeViews()
    }

    @Test func closeRetainsTheConflictAndSavesTheOtherFile() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil, automaticallySaves: true)
        func editFile(_ name: String) throws -> (URL, WorkingDocument) {
            let file = root.appendingPathComponent(name)
            try Data("before".utf8).write(to: file)
            let opened = try LocalFileSave.open(file)
            workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
            let document = try #require(workspace.active)
            #expect(document.text.apply(range: NSRange(location: 0, length: 6), replacement: "after", selection: nil, actionName: "Edit"))
            return (file, document)
        }
        let (conflictedFile, conflicted) = try editFile("conflicted.md")
        try Data("outside".utf8).write(to: conflictedFile)
        await workspace.receiveExternalChange(conflicted)
        let conflict = try #require(conflicted.session.record.conflict)
        let (saveableFile, saveable) = try editFile("saveable.md")

        #expect(await workspace.prepareToClose())
        #expect(try Data(contentsOf: conflictedFile) == Data("outside".utf8))
        let retained = try await workspace.drafts.load(id: conflicted.session.record.id, branch: conflicted.session.record.branch)
        #expect(retained.source == "after")
        #expect(retained.conflict == conflict)
        #expect(try Data(contentsOf: saveableFile) == Data("after".utf8))
        #expect(!saveable.session.isDirty)
        await workspace.closeViews()
    }

    @Test func closeWithNoTimeForADestinationSaveKeepsARecoverableDraft() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("close.md")
        try Data("before".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil, automaticallySaves: true)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        #expect(document.text.apply(range: NSRange(location: 0, length: 6), replacement: "after", selection: nil, actionName: "Edit"))
        #expect(!(await workspace.prepareToClose(saveDeadline: .now())))
        #expect(!workspace.closing)
        #expect(workspace.notice?.contains("Your edits are in Drafts.") == true)
        #expect(try Data(contentsOf: file) == Data("before".utf8))
        let retained = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(retained.source == "after")
        await workspace.closeViews()
    }

    @Test func externalChangeWaitsForItsOwnDocument() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let firstFile = root.appendingPathComponent("first.md"), secondFile = root.appendingPathComponent("second.md")
        try Data("start\n".utf8).write(to: firstFile)
        try Data("start\n".utf8).write(to: secondFile)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        let firstOpened = try LocalFileSave.open(firstFile)
        workspace.add(DraftRecord(source: firstOpened.source, destination: .file(firstOpened.base), savedSource: firstOpened.source))
        let first = try #require(workspace.active)
        first.updates.stop()
        let secondOpened = try LocalFileSave.open(secondFile)
        workspace.add(DraftRecord(source: secondOpened.source, destination: .file(secondOpened.base), savedSource: secondOpened.source))
        let second = try #require(workspace.active)
        connectPage(workspace)
        try Data("start\nexternal\n".utf8).write(to: firstFile)
        await workspace.receiveExternalChange(first)
        #expect(first.session.record.destination == .file(firstOpened.base))
        #expect(second.text.source == "start\n")
        workspace.select(first)
        await workspace.receiveExternalChange(first)
        #expect(first.text.source == "start\nexternal\n")
        #expect(second.text.source == "start\n")
        await workspace.closeViews()
    }

    @Test func compatibleExternalTextJoinsTheLocalDraft() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("shared.md")
        try Data("first\nsecond\n".utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil)
        workspace.add(DraftRecord(source: opened.source, destination: .file(opened.base), savedSource: opened.source))
        let document = try #require(workspace.active)
        connectPage(workspace)
        _ = document.text.apply(range: NSRange(location: 0, length: 5), replacement: "human", selection: NSRange(location: 5, length: 0), actionName: "Edit")
        try Data("first\nagent\n".utf8).write(to: file)
        await workspace.receiveExternalChange(document)
        #expect(document.text.source == "human\nagent\n")
        #expect(document.session.record.savedSource == "first\nagent\n")
        #expect(document.session.record.conflict == nil)
        #expect(document.session.isDirty)

        await workspace.closeViews()
    }

    @Test func exactMergeSeparatesIndependentChangesAndConflicts() throws {
        guard case .merged(let edits) = LiveTextMerge.merge(base: "one two three", local: "ONE two three", remote: "one two THREE") else { Issue.record("Independent words did not merge"); return }
        var source = "ONE two three" as NSString
        for edit in edits.sorted(by: { $0.range.location > $1.range.location }) {
            source = source.replacingCharacters(in: edit.range, with: edit.replacement) as NSString
        }
        #expect(source as String == "ONE two THREE")
        guard case .conflict = LiveTextMerge.merge(base: "same", local: "human", remote: "agent") else { Issue.record("Overlapping replacement was accepted"); return }
        guard case .merged(let repeated) = LiveTextMerge.merge(base: "same", local: "shared", remote: "shared") else { Issue.record("Equal edits did not converge"); return }
        #expect(repeated.isEmpty)
    }

    @Test func failedRetentionRetriesReceiptWithoutAnotherMutation() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let drafts = root.appendingPathComponent("drafts")
        try Data("not a directory".utf8).write(to: drafts)
        let workspace = EditorWorkspace(directory: drafts, store: nil)
        workspace.add(DraftRecord(source: "before"))
        let document = try #require(workspace.active)
        connectPage(workspace)
        let request = command(workspace, source: "before", generation: 0,
            edit: .init(start: 0, end: 6, expected: "before", replacement: "after"))
        #expect(await workspace.handleLive(request).status == "error")
        let generation = document.text.generation
        #expect(document.text.source == "after")
        try FileManager.default.removeItem(at: drafts)
        #expect(await workspace.handleLive(request).status == "applied")
        #expect(document.text.generation == generation)
        let retained = try await workspace.drafts.load(id: document.session.record.id, branch: document.session.record.branch)
        #expect(retained.source == "after")
        #expect(retained.liveReceipts?.count == 1)
        await workspace.closeViews()
    }

    @Test func closedDocumentHandlesDoNotAddressAnEqualBuffer() async throws {
        _ = NSApplication.shared
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "same"))
        let first = try #require(workspace.active)
        workspace.add(DraftRecord(source: "same"))
        let request = command(workspace, source: "same", generation: 0,
            edit: .init(start: 0, end: 4, expected: "same", replacement: "wrong"))
        await workspace.closeActive()
        #expect(workspace.active === first)
        #expect(await workspace.handleLive(request).status == "closed")
        #expect(first.text.source == "same")
        #expect(await workspace.prepareToClose())
        #expect(workspace.closing)
        workspace.resumeEdits()
        #expect(!workspace.closing)
        await workspace.closeViews()
    }

    @Test func liveConfigurationIsPrivateLoopbackAndOneUse() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("connection.json")
        func write(_ endpoint: String) throws {
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "endpoint": endpoint, "token": String(repeating: "a", count: 64)])
            try data.write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        try write("http://127.0.0.1:43210")
        #expect(try CollaborationConfiguration.consume(file.path).endpoint.port == 43210)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(throws: (any Error).self) { try CollaborationConfiguration.consume(file.path) }
        try write("http://example.com:43210")
        #expect(throws: (any Error).self) { try CollaborationConfiguration.consume(file.path) }
        #expect(FileManager.default.fileExists(atPath: file.path))
        try write("http://127.0.0.1:43210")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        #expect(throws: (any Error).self) { try CollaborationConfiguration.consume(file.path) }
    }

    @Test func liveLaunchAcceptsOnlyOneScopedAbsoluteConfiguration() {
        let launch = NativeLaunch.parse(["--pane", "/store/opens/request.json", "--live", "/private/config.json"])
        #expect(launch.livePath == "/private/config.json")
        guard case .pane(.request("/store/opens/request.json")) = launch.mode else { Issue.record("Pane launch changed"); return }
        for arguments in [["--live", "/private/config.json"], ["--pane", "request", "--live", "relative"], ["--pane", "request", "--live", "/one", "--live", "/two"]] {
            guard case .usage = NativeLaunch.parse(arguments).mode else { Issue.record("Invalid live launch was accepted"); continue }
        }
    }

    @Test func askCheckTakesTheLiveConfigurationAndOneQuestion() {
        let document = "md-0123456789abcdef0123"
        let launch = NativeLaunch.parse(["--ask-check", "--store", "/store", "--text", "Explain it.", document, "--live", "/private/config.json"])
        #expect(launch.livePath == "/private/config.json")
        guard case .askCheck("/store", document, "Explain it.", 90, nil) = launch.mode else { Issue.record("Ask check changed"); return }
        for arguments in [["--ask-check", "--store", "/store", document], ["--ask-check", "--store", "/store", "--text", "Q", "--pin", "1", document],
                          ["--ask-check", "--store", "/store", "--text", "Q", "--seconds", "0", document]] {
            guard case .usage = LaunchMode.parse(arguments) else { Issue.record("Invalid ask check was accepted"); continue }
        }
    }
    @Test func pageReadinessBusyAndPersonHoldRefuseWithoutMutation() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "before after"))
        let document = try #require(workspace.active)
        let request = command(workspace, source: document.text.source, generation: 0,
            edit: .init(start: 0, end: 6, expected: "before", replacement: "changed"))
        #expect(await workspace.handleLive(request).status == "busy")
        connectPage(workspace)
        workspace.pageBusy = true
        #expect(await workspace.handleLive(request).status == "busy")
        var heldNotices = 0
        workspace.webHeldRefusal = { heldNotices += 1 }
        workspace.pageBusy = false; workspace.pageHeld = NSRange(location: 0, length: 6)
        let held = await workspace.handleLive(request)
        #expect(held.status == "busy" && held.reason == "held")
        #expect(heldNotices == 1)
        #expect(held.message?.contains("open for writing (UTF-16 0–6)") == true)
        #expect(document.text.source == "before after")
        workspace.pageHeld = nil
        workspace.webAgentApply = { _, _, _ in .refused(reason: "held", range: NSRange(location: 0, length: 6)) }
        #expect(await workspace.handleLive(request).reason == "held")
        #expect(document.text.source == "before after")
        await workspace.closeViews()
    }

    @Test func acceptedPageResultRequiresTheSameOperationInTheMirror() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "before"))
        let document = try #require(workspace.active)
        workspace.webReady = true
        workspace.webAgentApply = { operation, generation, edits in
            .accepted(.init(baseGeneration: generation, generation: generation + 1, origin: "agent", operationId: operation, edits: edits))
        }
        let request = command(workspace, source: "before", generation: 0,
            edit: .init(start: 0, end: 6, expected: "before", replacement: "after"))
        #expect(await workspace.handleLive(request).status == "uncertain")
        #expect(document.text.source == "before" && document.text.generation == 0)
        #expect(document.session.record.liveReceipts == nil)
        connectPage(workspace)
        #expect(await workspace.handleLive(request).status == "applied")
        var reused = request
        reused.edits = [.init(start: 0, end: 6, expected: "before", replacement: "other")]
        #expect(await workspace.handleLive(reused).status == "error")
        #expect(document.text.source == "after")
        await workspace.closeViews()
    }

    @Test func theBridgeAcceptsTheNativeReceiptForThePaintedClaim() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        let source = "before after"
        workspace.add(DraftRecord(source: source))
        connectPage(workspace)
        var painted: (id: String, expiresAt: Int64)?
        workspace.webClaim = { claim, _, _, expiresAt in painted = (claim, expiresAt) }
        let server = try LiveTestBridge(); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: workspace.id,
            document: workspace.liveDocumentID, handle: workspace.handleLive)
        defer { client.stop() }
        client.start()
        try await connected(server, document: workspace.liveDocumentID)
        let result = try await server.request(["op": "claim", "baseGeneration": 0, "baseDigest": Digest.sha256(Data(source.utf8)),
                                               "ranges": [["start": 0, "end": 6]]])
        let claim = try #require(painted)
        #expect(result["status"] as? String == "claimed")
        #expect(result["claimId"] as? String == claim.id)
        #expect(result["expiresAt"] as? Int64 == claim.expiresAt)
        await workspace.closeViews()
    }

    @Test func claimsExpireReleaseAndApplyClearsTheHandleClaims() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "before after"))
        connectPage(workspace)
        var paints: [String] = [], releases: [String] = []
        workspace.webClaim = { claim, _, label, _ in
            #expect(label == "Agent edit"); paints.append(claim)
        }
        workspace.webRelease = { releases.append($0) }
        var claim = LiveCommand(requestId: UUID().uuidString, workspace: workspace.id.uuidString,
            document: workspace.liveDocumentID.uuidString, op: "claim", baseGeneration: 0,
            baseDigest: Digest.sha256(Data("before after".utf8)), ranges: [.init(start: 0, end: 6)], label: "Agent edit")
        workspace.pageHeld = NSRange(location: 0, length: 6)
        #expect(await workspace.handleLive(claim).reason == "held")
        workspace.pageHeld = nil
        let first = await workspace.handleLive(claim)
        #expect(first.status == "claimed" && first.claimId == paints.first)
        let expiry = try #require(first.expiresAt)
        #expect(abs(expiry - Int64(Date().addingTimeInterval(90).timeIntervalSince1970 * 1000)) < 2000)
        workspace.expireClaims(now: Date().addingTimeInterval(91))
        #expect(releases == paints)
        let second = await workspace.handleLive(claim)
        claim.op = "release"; claim.claimId = second.claimId
        #expect(await workspace.handleLive(claim).status == "released")
        claim.op = "claim"
        let third = await workspace.handleLive(claim)
        let request = command(workspace, source: "before after", generation: 0,
            edit: .init(start: 0, end: 6, expected: "before", replacement: "after"))
        #expect(await workspace.handleLive(request).status == "applied")
        #expect(releases.contains(try #require(third.claimId)))
        #expect(workspace.liveClaims.isEmpty)
        await workspace.closeViews()
    }

    @Test func bridgePromptIdentitySurvivesTheRetryAndReportsState() async throws {
        let server = try LiveTestBridge(mode: "lost-receipt"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        var states: [(String, String)] = []
        client.onPromptState = { request, thread, state, _ in
            #expect(request == thread)
            states.append((request, state))
        }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let identity = UUID().uuidString
        let first = Task { await client.submitPrompt(requestId: identity, threadId: identity, text: "Exact comment", quote: "passage") }
        try await eventually { client.sending }
        _ = try await server.request(["op": "release"])
        #expect(!(await first.value))
        #expect(await client.submitPrompt(requestId: identity, threadId: identity, text: "Exact comment", quote: "passage"))
        #expect(await client.submitPrompt(requestId: identity, threadId: identity, text: "Exact comment", quote: "passage"))
        #expect(!(await client.submitPrompt(requestId: identity, threadId: identity, text: "Changed comment", quote: "passage")))
        let state = try await server.request(["op": "state"])
        let prompts = try #require(state["prompts"] as? [[String: String]])
        #expect(prompts.count == 2 && prompts[0] == prompts[1])
        #expect(prompts[0]["operationId"] == identity)
        #expect(states.allSatisfy { $0.0 == identity })
        #expect(states.contains { $0.1 == "unknown" })
        #expect(states.contains { $0.1 == "admitted" })
    }
    @Test func capturedFirstChangeCreatesOneCopyAndPreservesStoredSource() async throws {
        let fixture = try PaneRun(); defer { fixture.remove() }
        let root = URL(fileURLWithPath: fixture.store)
        let pointer = root.appendingPathComponent("documents/\(fixture.document)/document.json")
        var record = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: pointer)) as? [String: Any])
        record["kind"] = "response"
        try JSONSerialization.data(withJSONObject: record).write(to: pointer)
        let snapshots = root.appendingPathComponent("snapshots")
        try FileManager.default.createDirectory(at: snapshots, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: pointer.deletingLastPathComponent(),
            to: snapshots.appendingPathComponent(fixture.document))
        let identity = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("store.json"))) as? [String: Any])
        let storeID = try #require(identity["storeId"] as? String)
        let reference = DocumentReference.stored(root: fixture.store, storeId: storeID, document: fixture.document)
        let original = try DocumentLoader.load(reference)
        _ = NSApplication.shared
        let application = try PaneTestApplication(sourceBinary: PaneRun.binary)
        defer { application.remove() }
        let platform = ReaderPlatform(copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("test"), application: .failed("test")) })
        let host = ReaderModel(reference: reference, platform: platform, state: ReadingStateStore(directory: nil),
            webRoot: application.web)
        let workspace = EditorWorkspace(directory: fixture.root.appendingPathComponent("drafts"), store: fixture.store)
        workspace.webHostModel = host
        await workspace.openReading(reference)
        try #require(workspace.reading === host)
        let liveID = workspace.liveDocumentID
        connectPage(workspace)
        let request = command(workspace, source: original.source, generation: 0,
            edit: .init(start: 0, end: 0, expected: "", replacement: "Added\r\n"))
        #expect(await workspace.handleLive(request).status == "applied")
        let copy = try #require(workspace.active)
        guard case .copy(let base) = copy.session.record.destination else { Issue.record("Captured source did not create a copy"); return }
        #expect(base.document == fixture.document)
        #expect(workspace.liveDocumentID == liveID && copy.id == liveID)
        #expect(copy.text.source.utf8.elementsEqual(("Added\r\n" + original.source).utf8))
        #expect(try DocumentLoader.load(reference).source.utf8.elementsEqual(original.source.utf8))
        #expect(workspace.documents.count == 1)
        #expect(await workspace.handleLive(request).status == "applied")
        #expect(workspace.documents.count == 1 && copy.text.generation == 1)
        await workspace.closeViews()
        await host.close()
    }
    @Test func latePageChangeAfterUnknownDeliveryRetainsItsReplayReceipt() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "before"))
        let document = try #require(workspace.active)
        workspace.webReady = true
        workspace.webAgentApply = { _, _, _ in .refused(reason: "unknown") }
        let request = command(workspace, source: "before", generation: 0,
            edit: .init(start: 0, end: 6, expected: "before", replacement: "after"))
        #expect(await workspace.handleLive(request).status == "uncertain")
        let change = WebPageChange(baseGeneration: 0, generation: 1, origin: "agent", operationId: request.operationId,
            edits: [.init(range: NSRange(location: 0, length: 6), expected: "before", replacement: "after")])
        #expect(try await workspace.receivePageChange(change).recoveryRetained)
        #expect(await workspace.handleLive(request).status == "applied")
        #expect(document.text.generation == 1 && document.session.record.liveReceipts?.count == 1)
        await workspace.closeViews()
    }

    @Test func transportFailureAfterMirrorAcceptanceDoesNotLoseTheAppliedResult() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let workspace = EditorWorkspace(directory: root, store: nil)
        workspace.add(DraftRecord(source: "before"))
        workspace.webReady = true
        workspace.webAgentApply = { [weak workspace] operation, generation, edits in
            guard let workspace else { return .refused(reason: "closed") }
            _ = try? await workspace.receivePageChange(.init(baseGeneration: generation, generation: generation + 1,
                origin: "agent", operationId: operation, edits: edits))
            return .refused(reason: "unknown")
        }
        let request = command(workspace, source: "before", generation: 0,
            edit: .init(start: 0, end: 6, expected: "before", replacement: "after"))
        let result = await workspace.handleLive(request)
        #expect(result.status == "applied" && result.retained == true)
        #expect(workspace.active?.text.source == "after")
        #expect(await workspace.handleLive(request).status == "applied")
        await workspace.closeViews()
    }

    @Test func canonicallyEqualUnicodeStillAutosavesExactBytes() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("unicode.md")
        let original = "café", replacement = "cafe\u{301}"
        try Data(original.utf8).write(to: file)
        let opened = try LocalFileSave.open(file)
        let workspace = EditorWorkspace(directory: root.appendingPathComponent("drafts"), store: nil, automaticallySaves: true)
        workspace.add(DraftRecord(source: original, destination: .file(opened.base), savedSource: original))
        let document = try #require(workspace.active)
        let ack = try await workspace.receivePageChange(.init(baseGeneration: 0, generation: 1, origin: "person",
            edits: [.init(range: NSRange(location: 0, length: original.utf16.count), expected: original, replacement: replacement)]))
        #expect(ack.recoveryRetained && document.session.isDirty)
        await document.persistenceTask?.value
        #expect(try Data(contentsOf: file) == Data(replacement.utf8))
        #expect(!document.session.isDirty)
        await workspace.closeViews()
    }
    @Test func promptFollowupsNameTheirThreadAndUseNewRequestIdentities() async throws {
        let server = try LiveTestBridge(); defer { server.stop() }
        let document = UUID()
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: document) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        var states: [(request: String, thread: String, state: String, detail: String?)] = []
        client.onPromptState = { states.append(($0, $1, $2, $3)) }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let first = UUID().uuidString, followup = UUID().uuidString, other = UUID().uuidString
        #expect(await client.submitPrompt(requestId: first, threadId: first, text: "Explain", quote: "Original passage"))
        #expect(client.currentAdmittedThreadId(for: document) == first)
        #expect(await client.submitPrompt(requestId: followup, threadId: first, text: "Explain more", quote: "Changed selection"))
        #expect(client.currentAdmittedThreadId(for: document) == first)
        #expect(await client.submitPrompt(requestId: other, threadId: other, text: "Another thread"))
        #expect(client.currentAdmittedThreadId(for: document) == nil)
        let data = try await server.request(["op": "state"])
        let prompts = try #require(data["prompts"] as? [[String: String]])
        #expect(prompts.count == 3)
        #expect(prompts[0]["operationId"] == first && prompts[1]["operationId"] == followup)
        #expect(prompts[0]["text"]?.contains("Original passage") == true)
        #expect(prompts.map { $0["follows"] } == [nil, first, nil])
        #expect(prompts[1]["text"] == "Keep its passage as context.\n\nExplain more")
        _ = try await server.request(["op": "publish", "status": "answer", "text": "The actual answer.", "operationId": followup])
        try await eventually { states.contains { $0.request == followup && $0.state == "answered" } }
        #expect(states.contains { $0.thread == first && $0.detail == "The actual answer." })
        #expect(client.currentAdmittedThreadId(for: document) == other)
        #expect(!(await client.submitPrompt(requestId: UUID().uuidString, threadId: UUID().uuidString, text: "Unknown thread")))
    }

    @Test func untiedActivityDoesNotGuessBetweenAdmittedThreads() async throws {
        let server = try LiveTestBridge(mode: "unscoped"); defer { server.stop() }
        let client = CollaborationClient(configuration: try await server.configuration(), workspace: UUID(), document: UUID()) { _ in LiveResult(status: "closed") }
        defer { client.stop() }
        var answered = 0
        client.onPromptState = { _, _, state, _ in if state == "answered" { answered += 1 } }
        client.start()
        try await eventually { client.status == "Agent connected" }
        let first = UUID().uuidString, second = UUID().uuidString
        #expect(await client.submitPrompt(requestId: first, threadId: first, text: "First"))
        #expect(await client.submitPrompt(requestId: second, threadId: second, text: "Second"))
        _ = try await server.request(["op": "publish", "status": "answer", "text": "Untied activity", "operationId": first])
        // A completed command reaches the client after the answer has become available to its poll.
        _ = try await server.request(["op": "read"])
        _ = try await server.request(["op": "read"])
        #expect(answered == 0 && client.answer.isEmpty)
    }
}
