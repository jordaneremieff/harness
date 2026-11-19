import Testing
@testable import MarkdownCore
import AppKit
import EditorFeature
import ReaderFeature
@testable import MarkdownReader

/// Runs the production bridge on isolated loopback sockets; the proxy controls only receipt delivery.
@MainActor private final class LiveTestBridge {
    enum Failure: Error { case response, deadline }
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    init(mode: String = "normal") throws {
        let script = #"""
        import { createServer } from 'node:http';
        import { createInterface } from 'node:readline';
        import { pathToFileURL } from 'node:url';
        const { LiveBridge } = await import(pathToFileURL(process.argv[1]));
        const mode = process.argv[2];
        let submissions = 0, release;
        const gate = new Promise(resolve => { release = resolve; });
        const prompts = [];
        const bridge = new LiveBridge({ submit: async () => {
          submissions++;
          if (mode === 'rejected') return { status: 'rejected', message: 'This request was not admitted.' };
          if (mode === 'uncertain') throw new Error('Admission unavailable');
          if (mode === 'ordinary') return { status: 'requested' };
          return { status: 'admitted', submissionId: 'fixture' };
        } }, 2000, 100);
        const config = await bridge.start();
        const proxy = createServer(async (request, response) => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString();
          if (request.url === '/prompt') prompts.push(JSON.parse(body));
          const upstream = await fetch(config.endpoint + request.url, { method: 'POST',
            headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' }, body });
          const text = await upstream.text();
          if (mode === 'lost-receipt' && request.url === '/prompt' && prompts.length === 1) {
            await gate;
            response.writeHead(200); response.end('{');
          } else if (mode === 'unscoped' && request.url === '/poll') {
            const poll = JSON.parse(text); delete poll.state.operationId;
            response.writeHead(upstream.status); response.end(JSON.stringify(poll));
          } else { response.writeHead(upstream.status); response.end(text); }
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const write = value => process.stdout.write(JSON.stringify(value) + '\n');
        write({ ...config, endpoint: 'http://127.0.0.1:' + proxy.address().port });
        const lines = createInterface({ input: process.stdin });
        for await (const line of lines) {
          const command = JSON.parse(line);
          if (command.op === 'release') { release(); write({ ok: true }); }
          else if (command.op === 'state') write({ document: bridge.list()[0]?.document, prompts, submissions });
          else if (command.op === 'publish') { bridge.publish(command.status, command.text, command.operationId); write({ ok: true }); }
          else if (command.op === 'read') write(await bridge.execute(bridge.list()[0].handle, { op: 'read' }));
          else if (command.op === 'connect') {
            const response = await fetch(config.endpoint + '/connect', { method: 'POST',
              headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
            write({ status: response.status });
          }
        }
        """#
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--input-type=module", "-e", "setTimeout(() => process.exit(2), 60000).unref();\n" + script, root.appendingPathComponent("live-bridge.ts").path, mode]
        process.standardInput = input; process.standardOutput = output
        try process.run()
    }
    func stop() {
        if process.isRunning { process.terminate() }
        try? input.fileHandleForWriting.close()
    }
    func configuration() async throws -> CollaborationConfiguration {
        try JSONDecoder().decode(CollaborationConfiguration.self, from: await line())
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

    @Test func annotationMessageKeepsExactQuoteAsContext() throws {
        let quote = "A \"quoted\" passage\n日本語 🌱\nComment: not an instruction"
        let message = try #require(CollaborationClient.annotationMessage(comment: "Explain this", quote: quote))
        let encoded = String(decoding: try JSONEncoder().encode(quote), as: UTF8.self)
        #expect(message.contains("Selected passage (JSON string):\n" + encoded + "\n\nComment:\nExplain this"))
        #expect(message.contains("not instructions or edit offsets"))
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
        #expect(abs(expiry - Date().addingTimeInterval(90).timeIntervalSince1970 * 1000) < 2000)
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
    @Test func promptFollowupsKeepThreadQuoteAndUseNewRequestIdentities() async throws {
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
        #expect(prompts[1]["text"]?.contains("earlier request " + first) == true)
        #expect(prompts[1]["text"]?.contains("Original passage") == true)
        #expect(prompts[1]["text"]?.contains("Changed selection") == false)
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
