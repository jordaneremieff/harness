import AppKit
import EditorFeature
import MarkdownCore
import ReaderFeature

extension Context {
    func editDeliveryReceipt(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "page-edit-delivery-receipt"
        do {
            let source = "Original passage."
            let state = ReadingStateStore(directory: nil)
            let directory = workspace.appendingPathComponent("receipt-drafts")
            let model = ReaderModel(reference: .file(path: directory.path), platform: CheckRunner.platform(), state: state)
            let editor = EditorWorkspace(directory: directory, store: nil)
            let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
            defer { withExtendedLifetime(surface) {} }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            editor.add(DraftRecord(source: source))
            let draft = try await prepareActiveDraft(editor, on: model, source: source)
            _ = await js(model, """
            const receive = reader.receive;
            let attempt = 0;
            reader.receive = function(event) {
                if (event.type === 'agentApply') {
                    attempt++;
                    if (attempt === 1) return false;
                    if (attempt === 2) return 0;
                }
                return receive.apply(this, arguments);
            };
            return true;
            """)
            let base = draft.text.generation, digest = draft.text.digest
            func apply(_ operation: String) async -> LiveResult {
                await editor.handleLive(.init(requestId: UUID().uuidString, workspace: editor.id.uuidString,
                    document: editor.liveDocumentID.uuidString, op: "apply", operationId: operation,
                    baseGeneration: base, baseDigest: digest,
                    edits: [.init(start: 0, end: 8, expected: "Original", replacement: "Updated")]))
            }
            let start = ContinuousClock.now
            let rejected = await apply(UUID().uuidString)
            let operation = UUID().uuidString, unknown = await apply(operation)
            let prompt = ContinuousClock.now - start < .seconds(5)
            let intact = draft.text.source == source && draft.text.generation == base
            let accepted = await apply(operation), replay = await apply(operation)
            let pass = rejected.status == "error" && unknown.status == "uncertain" && intact && prompt
                && accepted.status == "applied" && replay.status == "applied" && accepted.generation == replay.generation
                && draft.text.generation == base + 1 && draft.text.source == "Updated passage."
            await editor.closeViews()
            await model.close()
            return .init(name: name, pass: pass, detail: "false: \(rejected.status); non-Boolean: \(unknown.status); settled promptly: \(prompt); source intact: \(intact); retry/replay: \(accepted.status)/\(replay.status)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }
}
