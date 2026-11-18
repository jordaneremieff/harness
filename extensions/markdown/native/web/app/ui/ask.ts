(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, get, icon } = api.uiDOM;
	api.createAskUI = (ctx, navigation) => {
		const { controller, editor, host, app, doc, page } = ctx,
			card = get("#askcard"),
			activity = get("#activity");
		const threads: ReaderThread[] = [],
			payloads = new Map<string, Record<string, unknown>>();
		const off: (() => void)[] = [];
		type ReviewEntry = { operation: ReaderAgentOperation; edit: ReaderAgentOperation["edits"][number] };
		let mounted: { panel: HTMLElement; entry: ReviewEntry; target: DiffTarget; conflicted: boolean } | null = null;
		let current: ReaderThread | null = null,
			visible = false,
			changeIndex = 0,
			review: ReviewEntry[] = [];
		function operations(thread = current) {
			return [...controller.agentOperations.values()].filter((op) => !thread || op.threadId === thread.threadId);
		}
		function activeMessage(thread: ReaderThread) {
			return thread.messages.at(-1);
		}
		function pending(thread: ReaderThread) {
			// A follow-up waits only while the conversation has not taken the last message.
			const state = activeMessage(thread)?.state;
			return state === "sending" || state === "unknown";
		}
		function blockAt(start: number) {
			return [...doc.children].find(
				(n) => Number((n as HTMLElement).dataset.start) <= start && Number((n as HTMLElement).dataset.end) >= start,
			) as HTMLElement | undefined;
		}
		function passagePoint(offset: number) {
			const node = blockAt(offset),
				block = controller.blocks.find((block) => block.key === node?.dataset.block),
				source = controller.doc?.source;
			if (!node || !block || source === undefined) return null;
			let display: number;
			if (controller.doc?.active?.blockId === block.key)
				display = api.sourceModel.sourceToDisplay(
					new api.exact.LineMap(source.slice(block.start, block.end)),
					offset - block.start,
				);
			else {
				const map = api.sourceModel.map(block, source, node);
				display = map.boundaries.findIndex((position) => position !== null && position >= offset);
				if (display < 0) display = map.text.length;
			}
			return api.sourceModel.point(node, display);
		}
		function threadRange() {
			if (!current) return undefined;
			return current.range ?? operations(current).at(-1)?.edits[0];
		}
		function mapThread(thread: ReaderThread, edits: ReaderEdit[]) {
			if (!thread.range) return;
			try {
				const [mapped] = api.exact.mapEdits(
					[{ ...thread.range, expected: thread.quote ?? "", text: thread.quote ?? "" }],
					edits,
				);
				thread.range = { start: mapped.start, end: mapped.end };
			} catch {
				thread.range = undefined;
			}
		}
		function rangeFor(range?: ReaderRange) {
			if (!range) return null;
			const start = passagePoint(range.start),
				end = passagePoint(range.end);
			if (!start || !end) return null;
			const result = document.createRange();
			result.setStart(start.node, start.offset);
			result.setEnd(end.node, end.offset);
			return result;
		}
		function cardAnchorRect() {
			const anchor = rangeFor(threadRange());
			return anchor?.getBoundingClientRect() ?? get("#b-ask").getBoundingClientRect();
		}
		// The card floats beside its passage at every width and follows it while the page scrolls;
		// opening it, redraws and agent changes never scroll the page.
		function position() {
			if (!visible) return;
			const box = app.getBoundingClientRect(),
				bar = get(".bar").getBoundingClientRect();
			const rect = cardAnchorRect();
			card.style.maxHeight = "";
			const place = api.uiLogic.cardPlacement(
				{ top: rect.top - box.top, bottom: rect.bottom - box.top, left: rect.left - box.left },
				{ width: card.offsetWidth, height: card.scrollHeight },
				{ width: box.width, height: box.height, top: bar.bottom - box.top },
			);
			card.style.maxHeight = `${place.maxHeight}px`;
			card.style.left = `${place.left}px`;
			card.style.top = `${place.top}px`;
			card.dataset.side = place.side;
		}
		function paintPassage() {
			const range = visible ? rangeFor(threadRange()) : null;
			editor.highlight("passage", range ? [range] : []);
		}
		function action(label: string, run: () => void) {
			return button(label, "", run, { className: "link agent" });
		}
		function latestState(thread: ReaderThread) {
			const msg = activeMessage(thread);
			return msg ? api.uiLogic.promptLabel(msg.state) : "New question";
		}
		function selectionAction() {
			const selection = editor.selection(), documentAtOpen = controller.doc, generation = documentAtOpen?.generation;
			const item = button("Ask about the selection", "quote", () => {
				activity.hidePopover();
				if (selection && documentAtOpen === controller.doc && generation === controller.doc?.generation) ask.open(selection);
				else ctx.toast("Select text to ask about it.");
			}, { className: "item" });
			item.disabled = !selection;
			return item;
		}
		function drawActivity() {
			activity.replaceChildren(
				button(
					"Ask about this document",
					"ask",
					() => {
						activity.hidePopover();
						ask.open();
					},
					{ className: "item" },
				),
				selectionAction(),
				el("div", { class: "sep" }),
			);
			if (!threads.length) activity.append(el("div", { class: "sec" }, "Select a passage and choose Ask."));
			for (const thread of threads) {
				const b = button(
					"",
					"spark",
					() => {
						activity.hidePopover();
						openThread(thread);
					},
					{ className: "thread" },
				);
				b.append(
					el(
						"span",
						{ class: "tx" },
						el("b", {}, thread.messages[0]?.text ?? "New question"),
						el("span", {}, latestState(thread)),
					),
				);
				activity.append(b);
			}
		}
		function composer(thread: ReaderThread, followUp: boolean) {
			const field = el("textarea", {
				"aria-label": followUp ? "Follow-up message" : "Message to the agent",
				placeholder: followUp
					? "Follow up in this conversation"
					: thread.quote
						? "Ask about this passage or ask for a change"
						: "Ask about this document or ask for a change",
				rows: "2",
			});
			field.value = thread.draft;
			const send = button("Send", "send", () => void sendMessage(), { iconOnly: true, className: "send" });
			delete send.dataset.tip;
			send.disabled = !thread.draft.trim() || pending(thread);
			field.addEventListener("input", () => {
				thread.draft = field.value;
				send.disabled = !thread.draft.trim() || pending(thread);
			});
			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && event.metaKey && !event.isComposing) {
					event.preventDefault();
					event.stopPropagation();
					if (!send.disabled) void sendMessage();
				}
			});
			return el(
				"div",
				{ class: `composer${followUp ? " follow-up" : ""}` },
				field,
				el("div", { class: "foot" }, el("span", { class: "hint" }, "⌘↩ to send"), send),
			);
		}
		function drawHead(thread: ReaderThread) {
			return el(
				"div",
				{ class: "ask-head" },
				el("span", { class: "kind" }, icon("spark")),
				el("span", { class: "who" }, thread.quote ? "Ask about this passage" : "Ask about this document"),
				button("Close question", "x", () => ask.close(), { iconOnly: true, key: "esc" }),
			);
		}
		function drawStatus(message: ReaderAskMessage, changeCount: number) {
			const glyph = ({ failed: "info", answered: "check" } as Record<string, string>)[message.state] ?? "spark";
			let label = api.uiLogic.promptLabel(message.state);
			if (changeCount) label = `Changed ${changeCount} ${changeCount === 1 ? "passage" : "passages"}`;
			return el(
				"div",
				{ class: `ask-status${message.state === "failed" ? " fail" : ""}`, role: "status" },
				icon(glyph),
				el("span", {}, label),
			);
		}
		function drawMessages(thread: ReaderThread) {
			const log = el("div", { class: "ask-messages" });
			for (const m of thread.messages) {
				log.append(el("div", { class: "ask-question" }, el("span", { class: "from" }, "You"), m.text));
				if (m.state === "answered" && m.detail)
					log.append(
						el("div", { class: "reply" }, el("span", { class: "from" }, "Agent · in the conversation"), m.detail),
					);
			}
			return log;
		}
		function deliveryMessage(message: ReaderAskMessage) {
			if (message.state === "failed")
				card.append(
					el(
						"p",
						{ class: "send-failure" },
						"Not sent: the conversation did not accept the message. Your text is kept.",
					),
					action("Retry", () => void sendMessage(message)),
				);
			if (message.state === "unknown")
				card.append(
					el(
						"p",
						{ class: "send-failure" },
						"Delivery is not confirmed. Your text is kept. The reader will not send it twice.",
					),
				);
		}
		function drawConversation(thread: ReaderThread) {
			const message = activeMessage(thread);
			if (!message) return;
			const ops = operations(thread),
				changeCount = ops.reduce((n, op) => n + op.edits.length, 0),
				latest = ops.at(-1);
			card.append(drawStatus(message, changeCount), drawMessages(thread));
			if (latest)
				card.append(
					el(
						"div",
						{ class: "ask-actions" },
						action("Show changes", () => ask.showChanges(ops[0].operationId)),
						action(undoLabel(latest, ops.length > 1), () => undo(latest.operationId)),
					),
				);
			deliveryMessage(message);
		}
		function focusedComposer() {
			const field = document.activeElement;
			if (!(field instanceof HTMLTextAreaElement) || !card.contains(field)) return null;
			return { start: field.selectionStart, end: field.selectionEnd };
		}
		// A new message, state or answer brings the end of the conversation into view.
		let shownLatest = "";
		function revealLatest(thread: ReaderThread) {
			const message = activeMessage(thread);
			const latest = `${thread.threadId}:${thread.messages.length}:${message?.state}:${message?.detail?.length ?? 0}`;
			if (latest === shownLatest) return;
			shownLatest = latest;
			// The message list scrolls on its own inside the card; both end at the newest exchange.
			const messages = card.querySelector<HTMLElement>(".ask-messages");
			if (messages) messages.scrollTop = messages.scrollHeight;
			card.scrollTop = card.scrollHeight;
		}
		function draw() {
			if (!current || !visible) {
				card.removeAttribute("data-open");
				paintPassage();
				return;
			}
			const thread = current,
				focused = focusedComposer();
			card.replaceChildren();
			card.dataset.state = activeMessage(thread)?.state ?? "draft";
			card.setAttribute("data-open", "");
			card.append(drawHead(thread));
			card.append(
				el(
					"div",
					{ class: "quote" },
					el("span", {}, thread.quote ?? `About ${String(controller.payload?.meta.title ?? "this document")}`),
				),
			);
			drawConversation(thread);
			card.append(composer(thread, !!activeMessage(thread)));
			revealLatest(thread);
			position();
			paintPassage();
			if (focused) {
				const field = card.querySelector("textarea");
				field?.focus({ preventScroll: true });
				field?.setSelectionRange(focused.start, focused.end);
			}
		}
		function receivePrompt(value: unknown) {
			const msg = value as { requestId: string; threadId?: string; state: ReaderAskState; detail?: string };
			const thread = threads.find(
				(t) => t.threadId === msg.threadId || t.messages.some((m) => m.requestId === msg.requestId),
			);
			const message = thread?.messages.find((m) => m.requestId === msg.requestId);
			if (!thread || !message) return;
			message.state = api.uiLogic.promptTransition(message.state, msg.state);
			if (msg.detail) message.detail = msg.detail;
			ask.refresh();
		}
		function promptPayload(thread: ReaderThread, message: ReaderAskMessage) {
			return {
				requestId: message.requestId,
				threadId: thread.threadId,
				text: message.text,
				...(thread.quote ? { quote: thread.quote } : {}),
				...(thread.range ? { quoteRange: thread.range } : {}),
				generation: controller.doc?.generation ?? 0,
			};
		}
		function newMessage(thread: ReaderThread) {
			const message: ReaderAskMessage = { requestId: crypto.randomUUID(), text: thread.draft, state: "sending" };
			if (!thread.threadId) thread.threadId = message.requestId;
			thread.messages.push(message);
			thread.draft = "";
			payloads.set(message.requestId, promptPayload(thread, message));
			return message;
		}
		async function sendMessage(retry?: ReaderAskMessage) {
			const thread = current;
			if (!thread) return;
			if (!retry && (!thread.draft.trim() || pending(thread))) return;
			const message = retry ?? newMessage(thread);
			message.state = "sending";
			// Sending a request is the person's consent to the agent's change: the open block, which
			// holds its passage against agent edits, closes before the request leaves.
			if (controller.doc?.active) editor.close();
			draw();
			ask.refresh();
			await deliverMessage(message);
			ask.refresh();
		}
		// The thread whose request was working when the agent was held back by the open block.
		let heldThread: ReaderThread | null = null;
		function noteHeld() {
			heldThread = [...threads].reverse().find((t) => {
				const state = activeMessage(t)?.state;
				return !!state && ["sending", "sent", "admitted", "working"].includes(state);
			}) ?? heldThread;
		}
		// Let it releases the passage. If the held request has already ended, the agent is asked in
		// the same thread to make the change now; while it still works, its own retry lands.
		function letAgentChange() {
			editor.releaseHold();
			const thread = heldThread;
			heldThread = null;
			const state = thread ? activeMessage(thread)?.state : undefined;
			if (!thread || !state) {
				ctx.toast("The passage is free. Ask the agent again to change it.");
				return;
			}
			if (!["answered", "failed"].includes(state)) return;
			openThread(thread);
			thread.draft = "I closed the passage I had open. Please make the change now.";
			void sendMessage();
		}
		async function deliverMessage(message: ReaderAskMessage) {
			try {
				const receipt = (await host.request("prompt", payloads.get(message.requestId) ?? {})) as {
					accepted: boolean;
					detail?: string;
				};
				if (receipt.accepted) {
					message.state = api.uiLogic.promptTransition(message.state, "sent");
				} else {
					message.state = api.uiLogic.promptTransition(message.state, "failed");
					message.detail = receipt.detail;
				}
			} catch (error) {
				message.state = api.uiLogic.promptTransition(message.state, "unknown");
				message.detail = String(error);
			}
		}
		function undoLabel(op: ReaderAgentOperation, latest = false) {
			if (op.edits.length === 1) return latest ? "Undo latest change" : "Undo";
			return latest ? `Undo latest ${op.edits.length} changes` : `Undo ${op.edits.length} changes`;
		}
		function undo(id?: string) {
			if (!id) return;
			const operation = controller.agentOperations.get(id),
				result = controller.undoAgent(id);
			if (result?.status === "ok" && review[changeIndex]?.operation === operation) closeReview();
			if (result?.status === "blocked" || result?.status === "refused") {
				const old = operation?.edits.map((e) => e.oldText).join("\n\n") ?? "";
				ctx.notice("A later edit overlaps this change. The document stays as it is.", "warn", [
					{
						label: "Copy old wording",
						run: () => {
							void ctx.hostCommand("copy", { text: old });
						},
					},
				]);
			}
		}
		function clearDiff() {
			if (!mounted) return;
			mounted.panel.remove();
			for (const block of mounted.target.blocks) block.classList.remove("has-diff", "diff-continuation");
			mounted = null;
		}
		function closeReview() {
			review = [];
			clearDiff();
		}
		function openThread(thread: ReaderThread) {
			closeReview();
			current = thread;
			visible = true;
			draw();
			card.querySelector("textarea")?.focus({ preventScroll: true });
		}
		function visitChange(index: number, focusLabel?: string) {
			changeIndex = index;
			const { operation } = review[index];
			if (operation.unread) controller.markRead(operation.operationId);
			get("#notices").querySelector(`[data-notice-id="${CSS.escape(`agent-${operation.operationId}`)}"]`)?.remove();
			drawDiff();
			const panel = mounted?.panel;
			if (!panel) return;
			const rect = panel.getBoundingClientRect();
			if (rect.top < get(".bar").getBoundingClientRect().bottom || rect.bottom > page.getBoundingClientRect().bottom)
				navigation.jumpElement(panel);
			const focus = focusLabel && panel.querySelector<HTMLButtonElement>(`button[aria-label="${focusLabel}"]`);
			(focus || panel).focus({ preventScroll: true });
		}
		type DiffTarget = NonNullable<ReturnType<typeof diffTarget>>;
		function appendVersion(words: HTMLElement, parts: ReaderDiffPart[], side: "removed" | "added") {
			const tag = side === "added" ? "ins" : "del";
			for (const part of parts) {
				if (part.kind === "same") words.append(part.text);
				else if (part.kind === side) words.append(el(tag, {}, part.text));
			}
		}
		function diffRow(label: string, side: "removed" | "added", target: DiffTarget, parts: ReaderDiffPart[] | null) {
			const exact = side === "added" ? target.edit.newText : target.edit.oldText;
			const words = el("div", { class: "diff-words", dir: "auto" }, target.context?.prefix);
			if (parts) appendVersion(words, parts, side);
			else words.append(exact);
			words.append(target.context?.suffix ?? "");
			return el("div", { class: `diff-row ${side}` }, el("span", { class: "diff-label" }, label), words);
		}
		function diffBody(target: DiffTarget) {
			const body = el("div", { class: "diff-body" }), { oldText, newText } = target.edit;
			const parts = api.uiLogic.diffWords(oldText, newText);
			const before = newText ? "Before" : "Removed", after = oldText ? "After" : "Added";
			if (oldText) body.append(diffRow(before, "removed", target, parts));
			if (newText) body.append(diffRow(after, "added", target, parts));
			if (!parts) body.append(el("p", { class: "diff-note" }, "Long edit. Both versions are shown without word highlights."));
			return body;
		}
		function changeBlocks(edit: ReaderRange) {
			const blocks = Array.from(doc.querySelectorAll<HTMLElement>(":scope > [data-block]"));
			const first = blockAt(edit.start) ?? blocks.find((node) => Number(node.dataset.start) >= edit.start) ?? blocks.at(-1);
			if (!first) return [];
			return [first, ...blocks.filter((node) => node !== first && Number(node.dataset.start) < edit.end && Number(node.dataset.end) > edit.start)];
		}
		function diffTarget({ operation, edit }: ReviewEntry) {
			if (!controller.doc) return null;
			const blocks = changeBlocks(edit), block = blocks[0] ?? doc;
			const context = !blocks.length || operation.conflicted ? null : api.uiLogic.changeContext(controller.doc.source, {
				start: Number(block.dataset.start), end: Number(blocks.at(-1)?.dataset.end),
			}, edit);
			return { blocks, block, context, edit };
		}
		function mountDiff(diff: HTMLElement, target: DiffTarget) {
			if (target.context) {
				target.block.classList.add("has-diff");
				for (const next of target.blocks.slice(1)) next.classList.add("diff-continuation");
			}
			target.block.append(diff);
		}
		// Redrawing replaces the panel's buttons; an unchanged panel stays in place, so a
		// redraw between a press and its release never swallows the click.
		function diffMounted(entry: ReviewEntry, target: DiffTarget) {
			if (!mounted || mounted.entry !== entry || mounted.panel.parentElement !== target.block) return false;
			const previous = mounted.target;
			return mounted.conflicted === entry.operation.conflicted && previous.context?.prefix === target.context?.prefix &&
				previous.context?.suffix === target.context?.suffix && previous.blocks.length === target.blocks.length &&
				target.blocks.every((block, i) => block === previous.blocks[i]);
		}
		function conflictWarning() {
			return el("p", { class: "diff-warning" }, "Original agent wording. Later edits overlap this change.");
		}
		function diffPanel(operation: ReaderAgentOperation, target: DiffTarget) {
			const diff = el("section", { class: "inline-diff", "data-reader-control": "", "aria-label": "Agent change", tabindex: "-1" });
			const head = el("div", { class: "diff-head" }, el("span", { class: "diff-title" }, icon("spark"), "Passage change"));
			if (review.length > 1) {
				const turn = (delta: number) => visitChange((changeIndex + delta + review.length) % review.length,
					delta < 0 ? "Previous change" : "Next change");
				head.append(button("Previous change", "back", () => turn(-1), { iconOnly: true }),
					el("span", { class: "diff-count" }, `${changeIndex + 1} of ${review.length}`),
					button("Next change", "forward", () => turn(1), { iconOnly: true }));
			}
			head.append(button("Close changes", "x", closeReview, { iconOnly: true, key: "esc" }));
			const foot = el("div", { class: "diff-actions" });
			const thread = operation.threadId && threads.find((t) => t.threadId === operation.threadId);
			if (thread) foot.append(button("Back to question", "ask", () => openThread(thread), { className: "link agent" }));
			foot.append(button(undoLabel(operation), "undo", () => undo(operation.operationId), { className: "link" }));
			diff.append(head, diffBody(target), foot);
			diff.addEventListener("click", (event) => event.stopPropagation());
			if (operation.conflicted) diff.prepend(conflictWarning());
			return diff;
		}
		function drawDiff() {
			const entry = review[changeIndex];
			if (!entry) return;
			const target = diffTarget(entry);
			if (target && diffMounted(entry, target)) return;
			clearDiff();
			if (!target) return;
			const panel = diffPanel(entry.operation, target);
			mountDiff(panel, target);
			mounted = { panel, target, entry, conflicted: entry.operation.conflicted };
		}
		function markers() {
			for (const marker of doc.querySelectorAll(".change-marker")) marker.remove();
			for (const op of [...controller.agentOperations.values()].filter((op) => op.unread)) {
				const block = blockAt(op.edits[0]?.start ?? -1);
				if (!block || block.dataset.role === "block-editor") continue;
				const marker = button("Show changes", "spark", () => ask.showChanges(op.operationId), {
					iconOnly: true,
					className: "pin change-marker",
				});
				marker.setAttribute("data-reader-control", "");
				marker.addEventListener("click", (event) => event.stopPropagation());
				block.append(marker);
			}
			drawDiff();
		}
		const ask: ReaderAskUI = {
			noteHeld,
			letAgentChange,
			open(selection) {
				const thread: ReaderThread = {
					threadId: "",
					quote: selection?.text,
					range: selection ? { start: selection.start, end: selection.end } : undefined,
					draft: "",
					messages: [],
				};
				threads.unshift(thread);
				openThread(thread);
			},
			close() {
				if (review.length) {
					closeReview();
					return true;
				}
				if (!visible) return false;
				visible = false;
				card.removeAttribute("data-open");
				paintPassage();
				return true;
			},
			refresh() {
				if (activity.matches(":popover-open")) drawActivity();
				const count = [...controller.agentOperations.values()]
						.filter((op) => op.unread)
						.reduce((n, op) => n + op.edits.length, 0),
					b = get("#b-ask");
				b.querySelector(".dot")?.remove();
				b.querySelector(".change-count")?.remove();
				if (threads.some(pending)) b.append(el("span", { class: "dot", "aria-hidden": "true" }));
				if (count)
					b.append(el("span", { class: "change-count", "aria-label": `${count} unseen changes` }, String(count)));
				b.setAttribute("aria-label", `Ask the agent${count ? `, ${count} unseen changes` : ""}`);
				draw();
				markers();
			},
			showChanges(id) {
				const all = [...controller.agentOperations.values()];
				const selected = id ? controller.agentOperations.get(id) : all.at(-1);
				if (!selected) return;
				const group = selected.threadId ? all.filter((op) => op.threadId === selected.threadId) : [selected];
				editor.close();
				visible = false;
				draw();
				review = group.flatMap((operation) => operation.edits.map((edit) => ({ operation, edit })));
				visitChange(review.findIndex((entry) => entry.operation === selected));
			},
			dispose() {
				for (const fn of off) fn();
				observer.disconnect();
			},
		};
		off.push(
			host.on("promptState", receivePrompt),
			controller.on("change", (change) => {
				for (const thread of threads) mapThread(thread, change.edits);
			}),
			controller.on("agentOperations", () => ask.refresh()),
			controller.on("view", () => {
				markers();
				position();
				paintPassage();
			}),
			controller.on("agentChange", (change) => {
				const id = change.operationId ?? change.id,
					operation = controller.agentOperations.get(id);
				if (operation)
					ctx.notice(
						`The agent changed ${operation.edits.length} ${operation.edits.length === 1 ? "passage" : "passages"}`,
						"agent",
						[
							{ label: "Show changes", run: () => ask.showChanges(id) },
							{ label: "Undo", run: () => undo(id) },
						],
						`agent-${id}`,
					);
			}),
			controller.on("document", () => {
				ask.close();
				threads.length = 0;
				payloads.clear();
				current = null;
				closeReview();
			}),
		);
		const onToggle = (event: ToggleEvent) => { if (event.newState === "open") drawActivity(); };
		activity.addEventListener("beforetoggle", onToggle);
		off.push(() => activity.removeEventListener("beforetoggle", onToggle));
		const scroll = () => position();
		page.addEventListener("scroll", scroll, { passive: true });
		off.push(() => page.removeEventListener("scroll", scroll));
		const observer = new ResizeObserver(position);
		observer.observe(app);
		observer.observe(card);
		ask.refresh();
		return ask;
	};
})();
