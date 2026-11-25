import AppKit
import EditorFeature
import MarkdownCore
import ReaderFeature

extension Context {
    /// An open published draft follows a broad rewrite and resolves reused image names against the new revision.
    func storedDraftImages(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "hosted-draft-follows-stored-images"
        do {
            let id = VerifyStore.newId(), reference = store.reference(id)
            func publish(_ revision: Int, heading: String, widths: [Int], marker: String) throws -> String {
                var items: [[String: Any]] = [], files: [String: Data] = [:], links: [String] = []
                for (index, width) in widths.enumerated() {
                    let image = "chart-\(index).svg"
                    let bytes = Data("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(width)\" height=\"16\"><rect width=\"10\" height=\"10\"/></svg>".utf8)
                    let digest = VerifyStore.digest(bytes), file = "\(digest.dropFirst(7)).svg"
                    files[file] = bytes
                    items.append(["reference": image, "kind": "image", "state": "retained", "file": "assets/\(file)",
                                  "mediaType": "image/svg+xml", "bytes": bytes.count, "digest": digest])
                    links.append("![Chart \(index)](\(image))")
                }
                let stations = (0..<80).map { station in
                    "Station \(station): " + (0..<20).map { "berth-\(marker)\($0)" }.joined(separator: " ")
                }
                let source = (["# " + heading] + links + stations).joined(separator: "\n\n") + "\n"
                try store.write(id, revision: revision, source: source,
                                references: ["state": "inspected", "items": items, "omitted": 0], assets: files)
                return source
            }
            let old = try publish(1, heading: "Old chart", widths: [16], marker: "a")
            let snapshot = try DocumentLoader.load(reference, revision: 1)
            let root = FileAccess.canonicalPath(store.root.path)
            let base = StoredEditBase(root: root, storeId: store.storeId, document: id, revision: 1, digest: snapshot.digest)
            let state = ReadingStateStore(directory: nil)
            let model = ReaderModel(reference: reference, platform: CheckRunner.platform(), state: state)
            let editor = EditorWorkspace(directory: workspace.appendingPathComponent("stored-images-drafts"), store: root, automaticallySaves: true)
            let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
            defer { withExtendedLifetime(surface) {} }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            editor.add(DraftRecord(title: snapshot.title, source: old, destination: .published(base), savedSource: old), resolver: snapshot.resolver)
            let draft = try await prepareActiveDraft(editor, on: model, source: old)
            let handle = editor.liveDocumentID
            guard draft.previewIsHost, await wait(seconds: 3, until: {
                await js(model, "return document.querySelector('#doc img')?.naturalWidth === 16") as? Bool == true
            }) else { throw CheckRunner.CheckError.unavailable("The hosted draft did not display the original SVG.") }
            let observed = await js(model, """
            const doc = document.querySelector('#doc'), state = { first: null, applies: 0 };
            window.chartCheck = state;
            const receive = reader.receive;
            reader.receive = function(event) {
                if (event.type === 'agentApply') state.applies++;
                return receive.apply(this, arguments);
            };
            const observer = new MutationObserver(() => {
                if (doc.querySelector('h1')?.textContent.trim() !== 'New chart') return;
                state.first = doc.querySelectorAll('img').length;
                observer.disconnect();
            });
            observer.observe(doc, { subtree: true, childList: true, characterData: true });
            return true;
            """) as? Bool == true
            let updated = try publish(2, heading: "New chart", widths: [40, 41, 42, 43, 44], marker: "b")
            let decoded = await wait(seconds: 6) {
                await js(model, "return [...document.querySelectorAll('#doc img')].map(i => i.naturalWidth).join(',') === '40,41,42,43,44'") as? Bool == true
            }
            let counts = await js(model, "return [window.chartCheck.first ?? -1, window.chartCheck.applies]") as? [Int]
            let view = editor.livePaneView
            let pass = observed && counts == [5, 0] && decoded && editor.active === draft && editor.liveDocumentID == handle
                && view.revision == 2 && view.follows && !view.dirty && !view.conflict && draft.text.source == updated
            await editor.closeViews()
            await model.close()
            return .init(name: name, pass: pass, detail: "first image count and edit deliveries: \(counts ?? []); new SVG widths decoded: \(decoded); revision: \(view.revision ?? 0)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }
}
