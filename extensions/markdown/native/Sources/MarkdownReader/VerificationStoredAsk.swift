import AppKit
import Foundation
import MarkdownCore
import ReaderFeature

extension Context {
    /// A pane that a live tool opens shows a stored document in Reading inside a live workspace. Each
    /// Ask send from it either reaches native or says in the page why it stayed there.
    func askStoredPane(keep: inout [NSWindow]) async -> Verification.Check {
        let name = "ask-sends-from-stored-live-pane"
        do {
            let id = VerifyStore.newId()
            let source = "# Stored ask\n\nFirst stored passage.\n\nSecond stored passage.\n"
            try store.write(id, revision: 1, source: source)
            let state = ReadingStateStore(directory: nil)
            let model = ReaderModel(reference: store.reference(id), platform: CheckRunner.platform(), state: state)
            model.followsLatest = true
            let editor = EditorWorkspace(directory: workspace.appendingPathComponent("stored-ask-drafts"),
                                         store: FileAccess.canonicalPath(store.root.path), automaticallySaves: true)
            editor.reading = model
            // A loopback port that refuses connections: native answers the prompt without any request leaving the machine.
            editor.startCollaboration(CollaborationConfiguration(version: 1, endpoint: URL(string: "http://127.0.0.1:1")!,
                                                                 token: "check", conversation: "ordinary:check"))
            defer { editor.collaboration?.stop() }
            let surface = ReaderSurface(model: model, state: state, chrome: "pane", workspace: editor)
            defer { withExtendedLifetime(surface) {} }
            keep.append(CheckRunner.offscreenWindow(page: model.page, width: 800, height: 700))
            // The first prompt goes through the surface to native. The second waits until released, as a
            // slow conversation does; later prompts are accepted.
            let forward = model.page.onMessage
            var prompts: [[String: Any]] = [], held = true
            model.page.onMessage = { message in
                nonisolated(unsafe) let body = message
                guard message["type"] as? String == "prompt" else { return try await forward?(body) ?? [:] }
                prompts.append(message)
                if prompts.count == 1 { return try await forward?(body) ?? [:] }
                if prompts.count == 2 { while held { try await Task.sleep(for: .milliseconds(30)) } }
                return ["accepted": true]
            }
            await model.open(revision: nil, digest: nil, origin: nil)
            guard await wait(seconds: 5, until: { model.page.documentReady && model.phase == .ready }) else {
                throw CheckRunner.CheckError.unavailable("The stored document did not open.")
            }
            try await CheckRunner.preparePageForCheck(model)
            let askPassage = """
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            const passage = [...document.querySelectorAll('[data-role="document"] p')].find(p => p.textContent === quote);
            if (!passage) return false;
            const range = document.createRange(); range.selectNodeContents(passage);
            getSelection().removeAllRanges(); getSelection().addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            passage.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            await new Promise(r => setTimeout(r, 60));
            [...document.querySelectorAll('[data-role="selection-strip"] button')].find(b => b.textContent.trim() === 'Ask')?.click();
            const card = document.querySelector('.ask-card[data-open]');
            const field = card?.querySelector('textarea');
            if (!field) return false;
            field.value = text;
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            const button = card.querySelector(selector);
            if (!button || button.disabled) return false;
            button.click();
            return true;
            """
            let cardText = "return document.querySelector('.ask-card[data-open]')?.textContent ?? '';"

            // (1) A question from the stored Reading page reaches native, and native's refusal shows in the card.
            let asked = await js(model, askPassage, ["quote": "First stored passage.", "text": "Explain this.", "selector": ".ask-primary"]) as? Bool == true
            let reached = await wait(seconds: 6) {
                (await js(model, cardText) as? String ?? "").contains("Not sent: The selected document did not connect.")
            }

            // (2) While a message is on its way, a follow-up send says that it waits and keeps the text.
            let second = await js(model, """
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.getElementById('b-ask').click();
            await new Promise(r => setTimeout(r, 30));
            [...document.querySelectorAll('#activity button')].find(b => b.textContent.includes('Ask about this document'))?.click();
            await new Promise(r => setTimeout(r, 30));
            const field = document.querySelector('.ask-card[data-open] textarea');
            if (!field) return false;
            field.value = 'Summarise the document.';
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
            const send = document.querySelector('.ask-card[data-open] .send');
            if (!send || send.disabled) return false;
            send.click();
            return true;
            """) as? Bool == true
            let holding = await wait(seconds: 3) { prompts.count == 2 }
            let waits = await js(model, """
            const field = document.querySelector('.ask-card[data-open] textarea');
            if (!field) return 'no follow-up field';
            field.value = 'And list its sections.';
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
            const send = document.querySelector('.ask-card[data-open] .send');
            if (!send || send.disabled) return 'send unavailable';
            send.click();
            await new Promise(r => setTimeout(r, 50));
            const reason = document.querySelector('.ask-card[data-open] .ask-refused')?.textContent ?? 'no reason';
            const kept = document.querySelector('.ask-card[data-open] textarea')?.value;
            return `${reason} | ${kept}`;
            """) as? String ?? "script failed"
            let waitShown = waits == "Your last message is still on its way. Send this one after it arrives. Your text is kept. | And list its sections."
            held = false
            let followUp = await wait(seconds: 3) {
                await js(model, """
                const card = document.querySelector('.ask-card[data-open]');
                if (!card || card.dataset.state !== 'sent') return false;
                card.querySelector('.send')?.click();
                return true;
                """) as? Bool == true
            }
            let followUpSent = await wait(seconds: 3) { prompts.count == 3 }
                && prompts[2]["text"] as? String == "And list its sections."

            // (3) After a followed revision, a batch from the tray reaches native.
            try store.write(id, revision: 2, source: source + "\nThird stored passage.\n")
            let followed = await wait(seconds: 8) { model.snapshot?.revision == 2 && model.page.documentReady }
            let added = await js(model, askPassage, ["quote": "Second stored passage.", "text": "Tighten this.", "selector": ".ask-secondary"]) as? Bool == true
            _ = await js(model, "document.getElementById('ask-batch-send')?.click(); return true;")
            let batchSent = await wait(seconds: 3) { prompts.count == 4 }
                && (prompts[3]["annotations"] as? [[String: Any]])?.first?["text"] as? String == "Tighten this."

            // (4) An overall comment without comments on passages says in the batch list what it still needs.
            let overallOnly = await js(model, """
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            const list = document.getElementById('ask-batch-list');
            const field = list.querySelector('textarea');
            list.showPopover();
            field.value = 'Keep it short.';
            field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
            field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 50));
            const reason = list.querySelector('.ask-refused:not([hidden])')?.textContent ?? 'no reason';
            list.hidePopover();
            return reason;
            """) as? String ?? ""
            let overallExplained = overallOnly == "Add a comment on a passage before you send the batch. The overall comment goes with it." && prompts.count == 4
            await model.close()
            let pass = asked && reached && second && holding && waitShown && followUp && followUpSent && followed && added && batchSent && overallExplained
            return .init(name: name, pass: pass, detail: "question reached native \(asked && reached); follow-up while sending explained: \(waits); follow-up sent after confirmation \(followUp && followUpSent); batch after followed revision \(followed && added && batchSent); overall-only batch explained \(overallExplained) (\(overallOnly.prefix(160))); prompts \(prompts.count)")
        } catch { return .init(name: name, pass: false, detail: String(describing: error)) }
    }
}
