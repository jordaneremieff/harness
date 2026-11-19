(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, get, icon } = api.uiDOM;
	api.createAskUI = (ctx, navigation) => {
		const { controller, editor, host, app, doc, page } = ctx,
			card = get("#askcard"),
			activity = get("#activity"),
			tray = get("#ask-batch-tray"),
			batchList = get("#ask-batch-list");
		const batches = new Map<string, ReaderComment[]>(),
			localBatch: ReaderComment[] = [],
			batchLimit = 50,
			utf8 = new TextEncoder();
		let comments = localBatch;
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
			if (!current || current.comments) return undefined;
			return (current.pendingComment ?? current).range ?? operations(current).at(-1)?.edits[0];
		}
		function mapThread(thread: { range?: ReaderRange; quote?: string }, edits: ReaderEdit[]) {
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
		function passageRanges(items: ReaderComment[]) {
			return items.flatMap((item) => {
				const range = rangeFor(item.range);
				return range ? [range] : [];
			});
		}
		function paintPassage() {
			const range = visible ? rangeFor(threadRange()) : null;
			editor.highlight("comment", passageRanges(comments.filter((comment) => !visible || current?.pendingComment !== comment)));
			editor.highlight("passage", visible && current?.comments ? passageRanges(current.comments) : range ? [range] : []);
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
			if (comments.length)
				activity.append(button(`Pending batch · ${commentCount(comments.length)}`, "ask", () => {
					activity.hidePopover();
					openBatchList();
				}, { className: "item" }));
			else if (!threads.length) activity.append(el("div", { class: "sec" }, "Select a passage and choose Ask."));
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
		function composerActions(thread: ReaderThread, followUp: boolean) {
			const send = () => void sendMessage();
			if (followUp) return { primary: "Send", run: send, hint: "⌘↩ send" };
			if (thread.pendingComment) return { primary: "Done", run: () => ask.close(),
				secondary: `Send all ${comments.length}`, runSecondary: () => void sendBatch(), hint: "⌘↩ done · ⇧⌘↩ send" };
			const add = () => addComment(thread);
			if (!comments.length) return { primary: "Send", run: send, secondary: "Add to batch", runSecondary: add, hint: "⌘↩ send · ⇧⌘↩ add" };
			return { primary: "Add to batch", run: add, secondary: `Send all ${comments.length + 1}`,
				runSecondary: () => { if (add()) void sendBatch(); }, hint: "⌘↩ add · ⇧⌘↩ send" };
		}
		function composerField(thread: ReaderThread, followUp: boolean) {
			const field = el("textarea", {
				"aria-label": followUp ? "Follow-up message" : "Message to the agent",
				placeholder: followUp
					? "Follow up in this conversation"
					: thread.quote
						? "Ask about this passage or ask for a change"
						: "Ask about this document or ask for a change",
				rows: "2",
			});
			field.value = thread.pendingComment?.text ?? thread.draft;
			return field;
		}
		function composer(thread: ReaderThread, followUp: boolean) {
			const field = composerField(thread, followUp), comment = thread.pendingComment;
			const { primary: label, run, secondary: alternative, runSecondary, hint } = composerActions(thread, followUp);
			const primary = label === "Send"
				? button(label, "send", run, { iconOnly: true, key: "⌘↩", className: "ask-primary send" })
				: button(label, "", run, { className: "ask-primary batch-primary" });
			const secondary = alternative && runSecondary ? button(alternative, "", runSecondary, { className: "ask-secondary batch-secondary" }) : null;
			const remove = comment ? button("Remove", "", () => removeComment(comment), { className: "batch-secondary batch-remove" }) : null;
			function updateButtons() {
				primary.disabled = !comment && (!field.value.trim() || pending(thread));
				if (secondary) secondary.disabled = !field.value.trim();
			}
			updateButtons();
			field.addEventListener("input", () => {
				if (comment) comment.text = field.value;
				else thread.draft = field.value;
				updateButtons();
			});
			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && event.metaKey && !event.altKey && !event.ctrlKey && !event.isComposing) {
					event.preventDefault();
					event.stopPropagation();
					(event.shiftKey ? secondary : primary)?.click();
				}
			});
			return el(
				"div",
				{ class: `composer${followUp ? " follow-up" : ""}` },
				field,
				el("div", { class: "foot" }, remove, el("span", { class: "hint" }, hint), secondary, primary),
			);
		}
		function threadTitle(thread: ReaderThread) {
			if (thread.comments) return `Batch of ${commentCount(thread.comments.length)}`;
			if (thread.pendingComment) return "Edit batch comment";
			return thread.quote ? "Ask about this passage" : "Ask about this document";
		}
		function drawHead(thread: ReaderThread) {
			const comment = thread.pendingComment;
			return el(
				"div",
				{ class: "ask-head" },
				el("span", { class: "kind" }, icon("spark")),
				el("span", { class: "who" }, threadTitle(thread)),
				button(comment ? "Close comment" : "Close question", "x", () => ask.close(), { iconOnly: true, key: "esc" }),
			);
		}
		function commentCount(count: number) {
			return `${count} ${count === 1 ? "comment" : "comments"}`;
		}
		function commentNumber(index: number) {
			return el("span", { class: "batch-number" }, String(index + 1));
		}
		function commentPreview(comment: ReaderComment) {
			return el("span", { class: "batch-preview" },
				el("span", { class: "batch-quote" }, comment.quote ?? "Whole document"),
				el("span", { class: "batch-text" }, comment.text));
		}
		function drawBatchList() {
			const body = el("ol", { class: "batch-list-body", role: "list" });
			for (const [index, comment] of comments.entries()) {
				const open = button("", "", () => {
					batchList.hidePopover();
					const target = comment.range && blockAt(comment.range.start);
					if (target) navigation.jumpElement(target);
					openThread({ threadId: "", quote: comment.quote, pendingComment: comment, draft: "", messages: [] });
				}, { className: "batch-row-open batch-entry" });
				open.setAttribute("aria-label", `Edit comment ${index + 1}: ${comment.text}`);
				open.replaceChildren(commentNumber(index), commentPreview(comment));
				body.append(el("li", {}, open, button(`Remove comment ${index + 1}`, "x", () => removeComment(comment), { iconOnly: true, className: "btn-i batch-row-remove" })));
			}
			batchList.replaceChildren(el("h2", {}, "Pending batch"), body,
				el("div", { class: "batch-list-foot" },
					button("Remove all", "", removeAll, { className: "batch-secondary" }),
					button(`Send ${commentCount(comments.length)}`, "", () => void sendBatch(), { className: "batch-primary" })));
		}
		function openBatchList() {
			if (!comments.length) return;
			batchList.togglePopover();
		}
		const trayOpen = button("", "ask", openBatchList, { className: "batch-tray-open" });
		const trayCount = el("span");
		trayOpen.lastElementChild?.replaceWith(trayCount);
		trayOpen.id = "ask-batch-open";
		trayOpen.setAttribute("aria-controls", batchList.id);
		trayOpen.setAttribute("aria-expanded", "false");
		const traySend = button("Send", "send", () => void sendBatch(), { className: "batch-primary" });
		traySend.id = "ask-batch-send";
		tray.append(trayOpen, traySend);
		function refreshBatch() {
			if (!comments.length) batchList.hidePopover();
			tray.hidden = !comments.length;
			const label = commentCount(comments.length);
			trayOpen.setAttribute("aria-label", `Pending batch: ${label}`);
			trayCount.textContent = label;
			if (batchList.matches(":popover-open")) drawBatchList();
		}
		function discardEmptyComment() {
			const comment = current?.pendingComment;
			if (comment && !comment.text.trim()) {
				const index = comments.indexOf(comment);
				if (index >= 0) comments.splice(index, 1);
			}
		}
		function removeComment(comment: ReaderComment) {
			const index = comments.indexOf(comment);
			if (index < 0) return;
			comments.splice(index, 1);
			if (current?.pendingComment === comment) {
				current = null;
				visible = false;
			}
			ask.refresh();
			if (batchList.matches(":popover-open")) {
				const rows = batchList.querySelectorAll<HTMLButtonElement>(".batch-row-open");
				rows[Math.min(index, rows.length - 1)]?.focus({ preventScroll: true });
			}
		}
		function removeAll() {
			const batch = comments, removed = batch.splice(0), docAtRemoval = controller.doc;
			const generation = docAtRemoval?.generation;
			if (current?.pendingComment) {
				current = null;
				visible = false;
			}
			ask.refresh();
			ctx.toast(`Removed ${commentCount(removed.length)}.`, { label: "Undo", run: () => {
				if (!removed.length) return;
				const document = controller.doc;
				if (comments === batch && document && (docAtRemoval !== document || generation !== document.generation))
					reanchor(removed, document.source);
				batch.unshift(...removed.splice(0));
				ask.refresh();
			} });
		}
		function quoteFits(quote?: string) {
			if (quote && utf8.encode(quote).length > 8192) {
				ctx.notice("Select a shorter passage. The quote is too long.", "warn");
				return false;
			}
			return true;
		}
		function addComment(thread: ReaderThread) {
			if (!thread.draft.trim() || !quoteFits(thread.quote)) return false;
			if (comments.length >= batchLimit) {
				ctx.notice("The batch is full. Send it before adding another comment.", "warn");
				return false;
			}
			const range = thread.range;
			const sourceAnchor = range && controller.doc?.source.slice(range.start, range.end);
			comments.push({ text: thread.draft, quote: thread.quote, range, sourceAnchor });
			threads.splice(threads.indexOf(thread), 1);
			ctx.clearSelection?.();
			ask.close();
			current = null;
			return true;
		}
		function reanchor(items: ReaderComment[], source: string) {
			for (const comment of items) comment.range = api.uiLogic.reanchorPassage(source, comment.sourceAnchor, comment.range);
		}
		function batchPacket(id: string, items: ReaderComment[]) {
			return {
				requestId: id, threadId: id, generation: controller.doc?.generation ?? 0,
				annotations: items.map(({ text, quote, range }) => ({ text, ...(quote ? { quote } : {}), ...(range ? { quoteRange: range } : {}) })),
			};
		}
		function restoreBatch(batch: ReaderComment[], thread: ReaderThread, items: ReaderComment[], sourceAtSend: ReaderExactDocument | null) {
			const sourceNow = controller.doc;
			if (batch === comments && sourceAtSend !== sourceNow && sourceNow) reanchor(items, sourceNow.source);
			batch.unshift(...items);
			const index = threads.indexOf(thread);
			if (index >= 0) threads.splice(index, 1);
			if (current === thread) {
				current = null;
				visible = false;
			}
			const detail = activeMessage(thread)?.detail ?? "The conversation did not accept it.";
			if (batch === comments) ctx.notice(`Batch not sent. ${detail} Your comments are kept.`, "warn");
		}
		const sendingBatches = new Set<ReaderComment[]>();
		const retryBatch = new WeakMap<ReaderAskMessage, () => Promise<void>>();
		function batchReady() {
			if (current?.pendingComment && !current.pendingComment.text.trim()) ask.close();
			if (!comments.length) return false;
			if (sendingBatches.has(comments)) {
				ctx.notice("Wait for the current batch to reach the conversation before sending another.", "warn");
				return false;
			}
			if (comments.length > batchLimit) {
				ctx.notice("Remove comments until the batch fits, then send it.", "warn");
				return false;
			}
			return batchTextFits();
		}
		function batchTextFits() {
			const long = comments.findIndex(({ text }) => utf8.encode(text).length > 64 * 1024);
			if (long < 0) return true;
			ctx.notice(`Shorten comment ${long + 1} before sending the batch.`, "warn");
			return false;
		}
		async function sendBatch() {
			if (!batchReady()) return;
			const batch = comments, documentAtSend = controller.doc;
			const additions = [...batch], id = crypto.randomUUID(), payload = batchPacket(id, additions);
			if (utf8.encode(JSON.stringify(payload)).length > 256 * 1024 - 128) {
				ctx.notice("The batch is too long. Shorten or remove comments before sending it.", "warn");
				return;
			}
			const message: ReaderAskMessage = { requestId: id, text: `Batch of ${commentCount(additions.length)}`, state: "sending" };
			const thread: ReaderThread = { threadId: id, comments: additions, draft: "", messages: [message] };
			batch.length = 0;
			threads.unshift(thread);
			payloads.set(id, payload);
			openThread(thread, false);
			const attempt = () => deliverBatch(batch, thread, message, additions, documentAtSend);
			retryBatch.set(message, attempt);
			await attempt();
		}
		async function deliverBatch(batch: ReaderComment[], thread: ReaderThread, message: ReaderAskMessage,
			items: ReaderComment[], sourceAtSend: ReaderExactDocument | null) {
			sendingBatches.add(batch);
			await sendAttempt(message);
			sendingBatches.delete(batch);
			if (!(message.state === "unknown" && message.retryable)) {
				payloads.delete(message.requestId);
				retryBatch.delete(message);
			}
			if (message.state === "failed") restoreBatch(batch, thread, items, sourceAtSend);
			ask.refresh();
		}
		function drawStatus(message: ReaderAskMessage, changeCount: number) {
			const glyph = ({ failed: "info", unanswered: "info", answered: "check" } as Record<string, string>)[message.state] ?? "spark";
			let label = api.uiLogic.promptLabel(message.state);
			if (changeCount) label = `Changed ${changeCount} ${changeCount === 1 ? "passage" : "passages"}`;
			return el(
				"div",
				{ class: `ask-status${message.state === "failed" ? " fail" : ""}`, role: "status" },
				icon(glyph),
				el("span", {}, label),
			);
		}
		function sentComments(items: ReaderComment[]) {
			return el("ol", { class: "batch-sent", role: "list" }, ...items.map((item, index) =>
				el("li", { class: "batch-entry" }, commentNumber(index), commentPreview(item))));
		}
		function promptAnswer(message: ReaderAskMessage) {
			if (!message.detail) return null;
			if (message.state === "answered") return el("div", { class: "reply" }, el("span", { class: "from" }, "Agent"), message.detail);
			if (message.state === "unanswered") return el("p", { class: "send-failure" }, message.detail);
			return null;
		}
		function drawMessages(thread: ReaderThread) {
			const log = el("div", { class: "ask-messages" });
			for (const [index, m] of thread.messages.entries()) {
				const question = index === 0 && thread.comments ? sentComments(thread.comments) :
					el("div", { class: "ask-question" }, el("span", { class: "from" }, "You"), m.text);
				const answer = promptAnswer(m);
				log.append(question);
				if (answer) log.append(answer);
			}
			return log;
		}
		function deliveryMessage(message: ReaderAskMessage) {
			const batch = retryBatch.get(message);
			if (message.state === "failed" && !batch)
				card.append(
					el(
						"p",
						{ class: "send-failure" },
						`Not sent: ${message.detail || "the conversation did not accept the message."} Your text is kept.`,
					),
					action("Retry", () => void sendMessage(message)),
				);
			if (message.state !== "unknown") return;
			card.append(el("p", { class: "send-failure" }, message.retryable
				? "Delivery is not confirmed. Retry checks the same request."
				: "Delivery is not confirmed. Your text is kept. The reader will not send it twice."));
			if (message.retryable) card.append(action("Retry", () => void (batch ? batch() : sendMessage(message))));
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
			if (!thread.comments) card.append(
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
			if (message.state === msg.state) message.detail = msg.detail;
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
			if (!retry && (!thread.draft.trim() || pending(thread) || !quoteFits(thread.quote))) return;
			await sendAttempt(retry ?? newMessage(thread));
			ask.refresh();
		}
		async function sendAttempt(message: ReaderAskMessage) {
			message.state = "sending";
			message.retryable = false;
			// Sending a request is the person's consent to the agent's change: the open block, which
			// holds its passage against agent edits, closes before the request leaves.
			if (controller.doc?.active) editor.close();
			draw();
			ask.refresh();
			await deliverMessage(message);
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
		function receiveReceipt(message: ReaderAskMessage, value: unknown) {
			const receipt = value as { accepted: boolean; uncertain?: true; retryable?: boolean; detail?: string };
			const state = receipt.uncertain ? "unknown" : receipt.accepted ? "sent" : "failed";
			message.state = api.uiLogic.promptTransition(message.state, state);
			message.retryable = message.state === "unknown" && receipt.retryable === true;
			if (message.state === "failed" && state === "failed") message.detail = receipt.detail;
		}
		async function deliverMessage(message: ReaderAskMessage) {
			try {
				receiveReceipt(message, await host.request("prompt", payloads.get(message.requestId) ?? {}));
			} catch (error) {
				message.state = api.uiLogic.promptTransition(message.state, "unknown");
				if (message.state === "unknown") message.detail = String(error);
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
		function openThread(thread: ReaderThread, focus = true) {
			closeReview();
			if (current !== thread) discardEmptyComment();
			current = thread;
			visible = true;
			refreshBatch();
			draw();
			if (focus) card.querySelector("textarea")?.focus({ preventScroll: true });
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
				discardEmptyComment();
				if (current?.pendingComment) current = null;
				visible = false;
				card.removeAttribute("data-open");
				refreshBatch();
				paintPassage();
				return true;
			},
			refresh() {
				refreshBatch();
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
				if (current?.pendingComment) ask.close();
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
				for (const thread of threads) {
					mapThread(thread, change.edits);
					for (const item of thread.comments ?? []) mapThread(item, change.edits);
				}
				for (const item of comments) mapThread(item, change.edits);
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
				closeReview();
				ask.close();
				batchList.hidePopover();
				threads.length = 0;
				payloads.clear();
				current = null;
				heldThread = null;
				const key = controller.payload?.meta.documentId;
				if (typeof key === "string" && key) {
					comments = batches.get(key) ?? [];
					batches.set(key, comments);
				} else {
					localBatch.length = 0;
					comments = localBatch;
				}
				reanchor(comments, controller.doc?.source ?? "");
				refreshBatch();
			}),
		);
		const onBatchToggle = (event: ToggleEvent) => {
			const open = event.newState === "open";
			trayOpen.setAttribute("aria-expanded", String(open));
			if (open) drawBatchList();
		};
		batchList.addEventListener("beforetoggle", onBatchToggle);
		off.push(() => batchList.removeEventListener("beforetoggle", onBatchToggle));
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
