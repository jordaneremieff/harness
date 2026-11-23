import AppKit
import EditorFeature
import Foundation
import MarkdownCore
import ReaderFeature
import Testing
@testable import MarkdownReader

@MainActor @Suite(.serialized) struct ReaderSurfaceTests {
    private static var fixtureSource: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("ReaderFeatureTests/Fixtures/ReaderHost", isDirectory: true)
    }

    private static var worktreeRoot: URL {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        return root
    }

    private func stageWebRoot() throws -> URL {
        let root = Self.worktreeRoot.appendingPathComponent(".build/fixture-root/\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            for (source, destination) in [("index.html", "index.html"), ("host.css", "host.css"), ("host.ts", "host.js")] {
                try FileManager.default.copyItem(at: Self.fixtureSource.appendingPathComponent(source),
                                                 to: root.appendingPathComponent(destination))
            }
            return root
        } catch {
            try? FileManager.default.removeItem(at: root)
            throw error
        }
    }

    private func withSurface(_ body: @MainActor (ReaderSurface, ReaderModel, URL) async throws -> Void) async throws {
        _ = NSApplication.shared
        let webRoot = try stageWebRoot()
        defer { try? FileManager.default.removeItem(at: webRoot) }
        let directory = Self.worktreeRoot.appendingPathComponent(".build/reader-surface-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = ReadingStateStore(directory: nil)
        let platform = ReaderPlatform(copyText: { _ in }, openExternal: { _ in false }, reveal: { _ in },
            returnToTerminal: { _ in TerminalReturnResult(pane: .unavailable("test"), application: .failed("test")) })
        let model = ReaderModel(reference: .file(path: directory.appendingPathComponent("document.md").path),
                                platform: platform, state: state, webRoot: webRoot)
        let drafts = directory.appendingPathComponent("drafts", isDirectory: true)
        let surface = ReaderSurface(model: model, state: state, chrome: "pane", draftDirectory: drafts)
        do {
            try await model.page.load()
            try await body(surface, model, drafts)
            if let workspace = surface.workspace { _ = await workspace.retainAll(); await workspace.closeViews() }
            await model.close()
        } catch {
            if let workspace = surface.workspace { _ = await workspace.retainAll(); await workspace.closeViews() }
            await model.close()
            throw error
        }
    }

    /// Waits for native receipt through WebKit's reply promise, not a delay or a private handler.
    private func request(_ type: String, fields: [String: Any], to model: ReaderModel) async throws -> [String: Any] {
        let message = fields.merging(["v": 1, "type": type, "id": UUID().uuidString]) { _, envelope in envelope }
        let result = try await model.page.callJavaScript(
            "return await window.webkit.messageHandlers.reader.postMessage(message);", arguments: ["message": message])
        return try #require(result as? [String: Any])
    }

    private func post(_ type: String, fields: [String: Any], to model: ReaderModel) async throws {
        let reply = try await request(type, fields: fields, to: model)
        #expect(reply["ok"] as? Bool == true)
    }

    private func reportState(to model: ReaderModel, lock: String = "reading", undo: Bool = false,
                             redo: Bool = false, selected: Bool = false, activeBlock: Bool = false,
                             back: Bool = false, forward: Bool = false) async throws {
        var fields: [String: Any] = ["lock": lock, "canUndo": undo, "canRedo": redo,
            "canBack": back, "canForward": forward,
            "hasSelection": selected, "findOpen": false, "scroll": ["blockStart": 0, "offsetY": 0]]
        if activeBlock { fields["activeBlock"] = ["start": 0, "end": 4] }
        try await post("state", fields: fields, to: model)
    }

    @Test func nativeMenuCommandsReachThePageWithTheirArguments() async throws {
        try await withSurface { surface, model, _ in
            _ = try await model.page.callJavaScript("""
            window.surfaceCommands = [];
            const receive = window.reader.receive;
            window.reader.receive = message => {
                const result = receive(message);
                if (message.type === 'command') {
                    window.surfaceCommands.push(message);
                    document.dispatchEvent(new CustomEvent('surface-command', { detail: message }));
                }
                return result;
            };
            return true;
            """)
            let commands: [(String, [String: Any])] = [
                ("undo", [:]), ("redo", [:]), ("back", [:]), ("forward", [:]), ("find", ["query": "日本語"]),
                ("findNext", [:]), ("findPrevious", [:]), ("format", ["command": "bold"]),
                ("askSelection", [:]), ("copyPassage", [:]), ("toggleLock", [:]),
                ("zoomIn", [:]), ("selectAll", [:]),
            ]
            for (name, args) in commands {
                surface.sendCommand(name, args: args)
                let value = try await model.page.callJavaScript("""
                const existing = window.surfaceCommands.find(message => message.name === name);
                if (existing) return existing;
                return await new Promise((resolve, reject) => {
                    const finish = event => {
                        if (event.detail.name !== name) return;
                        clearTimeout(deadline);
                        document.removeEventListener('surface-command', finish);
                        resolve(event.detail);
                    };
                    const deadline = setTimeout(() => {
                        document.removeEventListener('surface-command', finish);
                        reject(new Error('Native command did not reach the page: ' + name));
                    }, 3000);
                    document.addEventListener('surface-command', finish);
                });
                """, arguments: ["name": name])
                let envelope = try #require(value as? [String: Any])
                #expect(envelope["v"] as? Int == 1)
                #expect(envelope["type"] as? String == "command")
                #expect(envelope["name"] as? String == name)
                let receivedArgs = try #require(envelope["args"] as? [String: Any])
                #expect(NSDictionary(dictionary: receivedArgs).isEqual(to: args))
            }
            #expect(try await model.page.callJavaScript("return window.surfaceCommands.length;") as? Int == commands.count)
        }
    }

    @Test func nativeMenuEnablementFollowsTheReportedPageState() async throws {
        try await withSurface { surface, model, _ in
            try await reportState(to: model)
            #expect(!surface.commandEnabled("undo"))
            #expect(!surface.commandEnabled("redo"))
            #expect(!surface.commandEnabled("back"))
            #expect(!surface.commandEnabled("forward"))
            #expect(!surface.commandEnabled("askSelection"))
            #expect(!surface.commandEnabled("copyPassage"))

            try await reportState(to: model, lock: "reading", undo: true, activeBlock: true, back: true)
            #expect(surface.commandEnabled("undo"))
            #expect(surface.commandEnabled("back"))
            #expect(!surface.commandEnabled("forward"))
            #expect(!surface.commandEnabled("redo"))
            #expect(!surface.commandEnabled("format"))

            try await reportState(to: model, lock: "writing", redo: true, forward: true)
            #expect(!surface.commandEnabled("undo"))
            #expect(!surface.commandEnabled("back"))
            #expect(surface.commandEnabled("forward"))
            #expect(surface.commandEnabled("redo"))
            #expect(!surface.commandEnabled("format"))

            try await reportState(to: model, lock: "writing", selected: true, activeBlock: true)
            #expect(surface.commandEnabled("format"))
            #expect(surface.commandEnabled("askSelection"))
            #expect(surface.commandEnabled("copyPassage"))

            try await reportState(to: model)
            #expect(!surface.commandEnabled("format"))
            #expect(!surface.commandEnabled("askSelection"))
            #expect(!surface.commandEnabled("copyPassage"))
        }
    }

    @Test func draftLibraryReferencesOpenOnlyTheirRetainedDocument() async throws {
        try await withSurface { surface, model, drafts in
            let workspace = EditorWorkspace(directory: drafts, store: nil)
            surface.setWorkspace(workspace)
            workspace.add(DraftRecord(title: "Existing document", source: "Keep this document unchanged.\n"))
            let initial = try #require(workspace.active)
            let retained = DraftRecord(title: "Retained document", source: "Exact 日本語\r\nretained source.\n")
            try await workspace.drafts.save(retained)

            let listing = try await request("query", fields: ["kind": "library", "collection": "drafts", "query": "Retained"], to: model)
            #expect(listing["ok"] as? Bool == true)
            let rows = try #require(listing["rows"] as? [[String: Any]])
            #expect(rows.count == 1)
            let row = try #require(rows.first)
            #expect(Set(row.keys) == ["ref", "kind", "title", "subtitle", "age"])
            #expect(row["title"] as? String == retained.title)
            #expect(row["kind"] as? String == "draft")
            let token = try #require(row["ref"] as? String)
            #expect(!token.isEmpty)
            #expect(!token.contains("/"))
            #expect(!token.contains("\\"))
            #expect(token != retained.id.uuidString && token != retained.branch.uuidString)
            let payload = String(decoding: try JSONSerialization.data(withJSONObject: listing, options: [.withoutEscapingSlashes]), as: UTF8.self)
            #expect(!payload.contains(drafts.path))
            #expect(!payload.contains(drafts.deletingLastPathComponent().path))
            #expect(workspace.active === initial)

            let fabricated = "unissued-" + UUID().uuidString
            let refused = try await request("command", fields: ["name": "open", "args": ["ref": fabricated]], to: model)
            #expect(refused["ok"] as? Bool == false)
            #expect(workspace.selected == initial.id)
            #expect(workspace.active === initial)
            #expect(initial.text.source == "Keep this document unchanged.\n")
            #expect(workspace.documents.count == 1)

            try await post("command", fields: ["name": "open", "args": ["ref": token]], to: model)
            let opened = try #require(workspace.active)
            #expect(opened.session.record.id == retained.id)
            #expect(opened.session.record.parentBranch == retained.branch)
            #expect(opened.text.source.utf8.elementsEqual(retained.source.utf8))
            #expect(workspace.selected == opened.id)
            #expect(workspace.documents.count == 2)

            let generation = opened.text.generation
            let branch = opened.session.record.branch
            let again = try await request("command", fields: ["name": "open", "args": ["ref": fabricated]], to: model)
            #expect(again["ok"] as? Bool == false)
            #expect(workspace.selected == opened.id)
            #expect(workspace.active === opened)
            #expect(opened.session.record.branch == branch)
            #expect(opened.text.generation == generation)
            #expect(opened.text.source.utf8.elementsEqual(retained.source.utf8))
            #expect(workspace.documents.count == 2)
        }
    }

    @Test func thePageReceivesConflictAndRepeatedWorkspaceNotices() async throws {
        try await withSurface { surface, model, drafts in
            let workspace = EditorWorkspace(directory: drafts, store: nil)
            surface.setWorkspace(workspace)
            try await post("command", fields: ["name": "newDraft"], to: model)
            let document = try #require(workspace.active)
            _ = try await model.page.callJavaScript("""
            window.statusEvents = [];
            const receive = reader.receive;
            reader.receive = message => {
                window.statusEvents.push(message);
                document.dispatchEvent(new Event('surface-status'));
                return receive(message);
            };
            window.waitForStatus = (type, field, value, count) => new Promise((resolve, reject) => {
                const check = () => {
                    const seen = window.statusEvents.filter(m => m.type === type && m[field] === value);
                    if (seen.length < count) return;
                    clearTimeout(timer); document.removeEventListener('surface-status', check); resolve(seen.at(-1));
                };
                const timer = setTimeout(() => { document.removeEventListener('surface-status', check); reject(Error(type)); }, 3000);
                document.addEventListener('surface-status', check); check();
            });
            return true;
            """)
            func wait(_ type: String, _ field: String, _ value: String, count: Int = 1) async throws -> [String: Any] {
                let received = try await model.page.callJavaScript("return await window.waitForStatus(type, field, value, count);",
                    arguments: ["type": type, "field": field, "value": value, "count": count])
                return try #require(received as? [String: Any])
            }
            let conflict = "Save stopped because the same passage changed."
            document.session.setConflict(.init(message: conflict))
            let state = try await wait("saveState", "state", "conflict")
            #expect(state["detail"] as? String == conflict && state["presentation"] as? String == model.page.presentation)
            for count in 1...2 {
                workspace.notice = "Finish your edit first."
                _ = try await wait("notice", "text", "Finish your edit first.", count: count)
            }
            let events = try await model.page.callJavaScript("return window.statusEvents.filter(m => m.state === 'conflict').length;")
            #expect(events as? Int == 1)
        }
    }

    @Test func asksUseTheInstalledReadingTextAcrossDraftSwitches() async throws {
        let server = try LiveTestBridge(); defer { server.stop() }
        try await withSurface { surface, model, drafts in
            let workspace = EditorWorkspace(directory: drafts, store: nil)
            surface.setWorkspace(workspace)
            let file = drafts.deletingLastPathComponent().appendingPathComponent("reading.md")
            let source = "# Visible section\n\nAn exact quote in its paragraph.\n"
            try source.write(to: file, atomically: true, encoding: .utf8)
            let reference = DocumentReference.file(path: file.path)
            await workspace.openReading(reference)
            workspace.startCollaboration(try await server.configuration())
            defer { workspace.collaboration?.stop() }
            func waitForBinding() async throws {
                let deadline = ContinuousClock.now + .seconds(5)
                while true {
                    let state = try await server.request(["op": "state"])
                    if state["document"] as? String == workspace.liveDocumentID.uuidString { return }
                    if ContinuousClock.now >= deadline { throw LiveTestBridge.Failure.deadline }
                    await Task.yield()
                }
            }
            try await waitForBinding()
            let key = try #require(model.page.documentKey), presentation = try #require(model.page.presentation)
            let requestId = UUID().uuidString, range = (source as NSString).range(of: "exact quote")
            let annotation: [String: Any] = ["text": "Explain this.", "quote": "exact quote",
                "quoteRange": ["start": range.location, "end": NSMaxRange(range)]]
            let first = annotation.merging(["requestId": requestId, "threadId": requestId, "presentation": presentation,
                "documentKey": key, "generation": 0]) { _, new in new }
            let accepted = try await request("prompt", fields: first, to: model)
            #expect(accepted["accepted"] as? Bool == true)
            #expect(workspace.documents.isEmpty)

            try await post("command", fields: ["name": "newDraft"], to: model)
            let draft = try #require(workspace.active)
            let wrongDocument = try await request("prompt", fields: first, to: model)
            #expect(wrongDocument["accepted"] as? Bool == false)
            #expect(wrongDocument["fresh"] as? Bool == true)
            await workspace.openReading(reference)
            try await waitForBinding()
            let current = try #require(model.page.presentation)
            #expect(current != presentation && model.page.documentKey == key)
            #expect(workspace.active == nil && workspace.documents.contains(where: { $0 === draft }))
            let receipt = try await request("prompt", fields: first, to: model)
            #expect(receipt["accepted"] as? Bool == true)
            let id = UUID().uuidString
            var batch: [String: Any] = ["requestId": id, "threadId": id, "presentation": presentation,
                "documentKey": key, "annotations": [annotation], "generation": 0]
            let stale = try await request("prompt", fields: batch, to: model)
            #expect(stale["fresh"] as? Bool == true && stale["accepted"] as? Bool == false)
            try await post("edits", fields: ["presentation": presentation, "origin": "person", "baseGeneration": 0,
                "generation": 1, "edits": [["start": 0, "end": 0, "text": "old", "expected": ""]]], to: model)
            #expect(model.page.presentation == current && model.source == source && workspace.active == nil)
            batch["presentation"] = current
            let refreshed = try await request("prompt", fields: batch, to: model)
            #expect(refreshed["accepted"] as? Bool == true)
            let state = try await server.request(["op": "state"])
            let prompts = try #require(state["prompts"] as? [[String: Any]])
            #expect(prompts.count == 2)
            for prompt in prompts {
                let text = try #require(prompt["text"] as? String)
                #expect(text.contains("in its paragraph."))
            }
        }
    }

    @Test func metadataLockWithoutCopyDoesNotCreateAnEditWorkspace() async throws {
        try await withSurface { surface, model, drafts in
            #expect(surface.workspace == nil)
            #expect(!FileManager.default.fileExists(atPath: drafts.path))
            try await post("lock", fields: ["lock": "writing", "copy": false], to: model)
            #expect(model.lock == .writing)
            #expect(surface.workspace == nil)
            #expect(!FileManager.default.fileExists(atPath: drafts.path))
            try await post("lock", fields: ["lock": "reading", "copy": false], to: model)
            #expect(model.lock == .reading)
            #expect(surface.workspace == nil)
            #expect(!FileManager.default.fileExists(atPath: drafts.path))
        }
    }
}
