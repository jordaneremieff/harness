(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, get, icon } = api.uiDOM;
	api.createAskUI = (ctx, navigation) => {
		const { controller, editor, host, app, doc, page } = ctx,
			card = get("#askcard"),
			activity = get("#activity"),
			tray = get("#ask-batch-tray"),
			batchList = get("#ask-batch-list");
		const sessions = api.createAskSessions(),
			batchLimit = 50,
			utf8 = new TextEncoder();
		let session = sessions.shown;
		function revision() {
			const value = controller.payload?.meta.revision;
			return typeof value === "number" ? value : undefined;
		}
		function version(): ReaderPromptVersion {
			const payload = controller.payload,
				doc = controller.doc;
			if (!payload || !doc || payload.meta.documentKey !== session.documentKey)
				throw new Error("No document is ready for this question.");
			return { documentKey: session.documentKey, presentation: payload.presentation, generation: doc.generation };
		}
		// The native side counts U+0085 as white space, which JavaScript's trim keeps.
		function hasText(text: string) {
			return /[^\s\u0085]/u.test(text);
		}
		function setOverall(text: string, owner = session) {
			if (!hasText(text)) owner.overallRevision = undefined;
			else if (!hasText(owner.overall)) owner.overallRevision = revision();
			owner.overall = text;
		}
		// Text returned to a batch joins the text written since, so no overall comment is lost.
		function restoreOverall(text: string | undefined, authoredRevision: number | undefined, owner: ReaderAskDocument) {
			if (!text || !hasText(text)) return;
			const newer = owner.overall;
			owner.overall = hasText(newer) && newer !== text ? `${text}\n\n${newer}` : text;
			owner.overallRevision = authoredRevision;
		}
		function batchLabel() {
			const count = commentCount(session.comments.length);
			return hasText(session.overall) ? `${count} + overall` : count;
		}
		const off: (() => void)[] = [];
		type ReviewEntry = { operation: ReaderAgentOperation; edit: ReaderAgentOperation["edits"][number] };
		let mounted: { panel: HTMLElement; entry: ReviewEntry; target: DiffTarget; conflicted: boolean } | null = null;
		let changeIndex = 0,
			review: ReviewEntry[] = [];
		function operations(thread = session.current) {
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
			if (!session.current || session.current.comments) return undefined;
			return (session.current.pendingComment ?? session.current).range ?? operations(session.current).at(-1)?.edits[0];
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
			if (!session.visible) return;
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
		// Each pending comment and each question that the conversation did not refuse keeps a mark on
		// its passage; a click on a mark in Reading opens its card again. The open card's own mark gives
		// way to the passage highlight.
		type Mark = {
			kind: "comment" | "asked";
			owner: ReaderComment | ReaderThread;
			ranges: Range[];
			open: () => void;
		};
		let marks: Mark[] = [],
			hovered: Mark | null = null;
		function commentMark(comment: ReaderComment): Mark[] {
			const range = rangeFor(comment.range);
			return range ? [{ kind: "comment", owner: comment, ranges: [range], open: () => editComment(comment) }] : [];
		}
		function threadRanges(thread: ReaderThread) {
			if (thread.comments) return passageRanges(thread.comments);
			const range = rangeFor(thread.range);
			return range ? [range] : [];
		}
		function askedMark(thread: ReaderThread): Mark[] {
			// A question that the conversation refused was not asked; the Ask menu still lists its card.
			if (!thread.messages.some((message) => message.state !== "failed")) return [];
			const ranges = threadRanges(thread);
			return ranges.length ? [{ kind: "asked", owner: thread, ranges, open: () => openThread(thread) }] : [];
		}
		function isOpen(mark: Mark) {
			return (
				session.visible &&
				!!session.current &&
				(mark.owner === session.current || mark.owner === session.current.pendingComment)
			);
		}
		function paintPassage() {
			const range = session.visible ? rangeFor(threadRange()) : null;
			// In the order that clicks open them: comments as listed, then questions, newest first.
			marks = [...session.comments.flatMap(commentMark), ...session.threads.flatMap(askedMark)];
			const shown = marks.filter((mark) => !isOpen(mark));
			for (const kind of ["comment", "asked"])
				editor.highlight(
					kind,
					shown.filter((mark) => mark.kind === kind).flatMap((mark) => mark.ranges),
				);
			editor.highlight(
				"passage",
				session.visible && session.current?.comments ? passageRanges(session.current.comments) : range ? [range] : [],
			);
			// The hover highlights paint after the marks they strengthen.
			hovered = null;
			paintHover();
		}
		function covers(range: Range, x: number, y: number) {
			return Array.from(range.getClientRects()).some(
				(rect) => rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
			);
		}
		// The mark that a click at a point opens. Where marks overlap, each click opens the one after
		// the open card, so every card stays reachable; the open card's own passage opens nothing.
		function markAt(x: number, y: number) {
			const hits = marks.filter((mark) => mark.ranges.some((range) => covers(range, x, y)));
			const open = hits.findIndex(isOpen);
			if (open >= 0 && hits.length === 1) return null;
			return hits[(open + 1) % hits.length] ?? null;
		}
		function paintHover() {
			doc.toggleAttribute("data-over-mark", !!hovered);
			for (const kind of ["comment", "asked"])
				editor.highlight(`${kind}-hover`, hovered?.kind === kind ? hovered.ranges : []);
		}
		function hover(mark: Mark | null) {
			if (mark === hovered) return;
			hovered = mark;
			paintHover();
		}
		function action(label: string, run: () => void) {
			return button(label, "", run, { className: "link agent" });
		}
		function latestState(thread: ReaderThread) {
			const msg = activeMessage(thread);
			return msg ? api.uiLogic.promptLabel(msg.state) : "New question";
		}
		function selectionAction() {
			const selection = editor.selection(),
				documentAtOpen = controller.doc,
				generation = documentAtOpen?.generation;
			const item = button(
				"Ask about the selection",
				"quote",
				() => {
					activity.hidePopover();
					if (selection && documentAtOpen === controller.doc && generation === controller.doc?.generation)
						ask.open(selection);
					else ctx.toast("Select text to ask about it.");
				},
				{ className: "item" },
			);
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
			if (session.comments.length)
				activity.append(
					button(
						`Pending batch · ${batchLabel()}`,
						"ask",
						() => {
							activity.hidePopover();
							openBatchList();
						},
						{ className: "item" },
					),
				);
			else if (!session.threads.length)
				activity.append(el("div", { class: "sec" }, "Select a passage and choose Ask."));
			for (const thread of session.threads) {
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
			if (followUp) return { primary: "Send", run: send, hint: "cmd+return send" };
			if (thread.pendingComment)
				return {
					primary: "Done",
					run: () => ask.close(),
					secondary: `Send all ${session.comments.length}`,
					runSecondary: () => void sendBatch(),
					hint: "cmd+return done · cmd+shift+return send",
				};
			const add = () => addComment(thread);
			if (!session.comments.length)
				return {
					primary: "Send",
					run: send,
					secondary: "Add to batch",
					runSecondary: add,
					hint: "cmd+return send · cmd+shift+return add",
				};
			return {
				primary: "Add to batch",
				run: add,
				secondary: `Send all ${session.comments.length + 1}`,
				runSecondary: () => {
					if (add()) void sendBatch();
				},
				hint: "cmd+return add · cmd+shift+return send",
			};
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
			const field = composerField(thread, followUp),
				comment = thread.pendingComment;
			const { primary: label, run, secondary: alternative, runSecondary, hint } = composerActions(thread, followUp);
			const primary =
				label === "Send"
					? button(label, "send", run, { iconOnly: true, key: "cmd+return", className: "ask-primary send" })
					: button(label, "", run, { className: "ask-primary batch-primary" });
			const secondary =
				alternative && runSecondary
					? button(alternative, "", runSecondary, { className: "ask-secondary batch-secondary" })
					: null;
			const remove = comment
				? button("Remove", "", () => removeComment(comment), { className: "batch-secondary batch-remove" })
				: null;
			function updateButtons() {
				primary.disabled = !comment && (!field.value.trim() || pending(thread));
				if (secondary) secondary.disabled = !field.value.trim();
			}
			updateButtons();
			field.addEventListener("input", () => {
				if (comment) comment.text = field.value;
				else {
					if (!hasText(thread.draft) && hasText(field.value)) thread.draftRevision = revision();
					thread.draft = field.value;
				}
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
			return el(
				"span",
				{ class: "batch-preview" },
				el("span", { class: "batch-quote" }, comment.quote ?? "Whole document"),
				el("span", { class: "batch-text" }, comment.text),
			);
		}
		// The overall comment field stays in place while the list redraws, so a redraw never takes
		// its focus or caret.
		const overallField = el("textarea", {
			class: "batch-overall-field",
			placeholder: "Direction or a perspective for every comment (optional)",
			rows: "2",
		});
		const listBody = el("ol", { class: "batch-list-body", role: "list" }),
			listFoot = el("div", { class: "batch-list-foot" });
		batchList.replaceChildren(
			el("h2", {}, "Pending batch"),
			el("label", { class: "batch-overall" }, el("span", {}, "Overall comment"), overallField),
			listBody,
			listFoot,
		);
		overallField.addEventListener("input", () => {
			// Input that arrives while the list is closed, such as a late paste after a document
			// switch, belongs to no visible batch.
			if (!batchList.matches(":popover-open")) {
				overallField.value = session.overall;
				return;
			}
			setOverall(overallField.value);
			refreshTray();
		});
		// Text returned ahead of the text being typed keeps the caret on the same characters.
		function syncOverallField() {
			if (controller.compositionTarget === overallField) return;
			const text = session.overall,
				before = overallField.value;
			if (before === text) return;
			const { selectionStart: start, selectionEnd: end } = overallField,
				kept = document.activeElement === overallField && text.endsWith(before);
			overallField.value = text;
			if (kept) overallField.setSelectionRange(start + text.length - before.length, end + text.length - before.length);
		}
		overallField.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && event.metaKey && !event.altKey && !event.ctrlKey && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				void sendBatch();
			}
		});
		function drawBatchList() {
			syncOverallField();
			listBody.replaceChildren();
			for (const [index, comment] of session.comments.entries()) {
				const open = button(
					"",
					"",
					() => {
						batchList.hidePopover();
						const target = comment.range && blockAt(comment.range.start);
						if (target) navigation.jumpElement(target);
						editComment(comment);
					},
					{ className: "batch-row-open batch-entry" },
				);
				open.setAttribute("aria-label", `Edit comment ${index + 1}: ${comment.text}`);
				open.replaceChildren(commentNumber(index), commentPreview(comment));
				listBody.append(
					el(
						"li",
						{},
						open,
						button(`Remove comment ${index + 1}`, "x", () => removeComment(comment), {
							iconOnly: true,
							className: "btn-i batch-row-remove",
						}),
					),
				);
			}
			listFoot.replaceChildren(
				button("Remove all", "", removeAll, { className: "batch-secondary" }),
				button(`Send ${commentCount(session.comments.length)}`, "", () => void sendBatch(), {
					className: "batch-primary",
				}),
			);
		}
		function openBatchList() {
			if (!session.comments.length) return;
			batchList.togglePopover();
		}
		function editComment(comment: ReaderComment) {
			openThread({ threadId: "", quote: comment.quote, pendingComment: comment, draft: "", messages: [] });
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
		function refreshTray() {
			tray.hidden = !session.comments.length;
			const count = commentCount(session.comments.length);
			const described = hasText(session.overall) ? `${count} and an overall comment` : count;
			trayOpen.setAttribute("aria-label", `Pending batch: ${described}`);
			trayCount.textContent = batchLabel();
		}
		function refreshBatch() {
			if (!session.comments.length) batchList.hidePopover();
			refreshTray();
			if (batchList.matches(":popover-open")) drawBatchList();
		}
		function discardEmptyComment() {
			const comment = session.current?.pendingComment;
			if (comment && !comment.text.trim()) {
				const index = session.comments.indexOf(comment);
				if (index >= 0) session.comments.splice(index, 1);
			}
		}
		// A question card closed before anything was typed or sent leaves no entry in the Ask menu.
		function discardEmptyQuestion() {
			const thread = session.current;
			if (!thread || thread.pendingComment || thread.comments || thread.messages.length || thread.draft.trim()) return;
			const index = session.threads.indexOf(thread);
			if (index >= 0) session.threads.splice(index, 1);
			session.current = null;
		}
		function removeComment(comment: ReaderComment) {
			const index = session.comments.indexOf(comment);
			if (index < 0) return;
			session.comments.splice(index, 1);
			if (session.current?.pendingComment === comment) {
				session.current = null;
				session.visible = false;
			}
			ask.refresh();
			if (batchList.matches(":popover-open")) {
				const rows = batchList.querySelectorAll<HTMLButtonElement>(".batch-row-open");
				rows[Math.min(index, rows.length - 1)]?.focus({ preventScroll: true });
			}
		}
		function removeAll() {
			const owner = session,
				removed = owner.comments.splice(0),
				overall = owner.overall,
				authoredRevision = owner.overallRevision,
				atRemoval = version();
			setOverall("", owner);
			if (owner.current?.pendingComment) {
				owner.current = null;
				owner.visible = false;
			}
			ask.refresh();
			const also = hasText(overall) ? " and the overall comment" : "";
			ctx.toast(`Removed ${commentCount(removed.length)}${also}.`, {
				label: "Undo",
				run: () => {
					if (!removed.length) return;
					if (owner !== session) owner.digest = undefined;
					if (
						owner === session &&
						(atRemoval.presentation !== controller.payload?.presentation ||
							atRemoval.generation !== controller.doc?.generation)
					)
						for (const item of removed)
							item.range = api.uiLogic.reanchorPassage(controller.doc?.source ?? "", item.sourceAnchor);
					owner.comments.unshift(...removed.splice(0));
					restoreOverall(overall, authoredRevision, owner);
					if (owner === session) ask.refresh();
				},
			});
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
			if (session.comments.length >= batchLimit) {
				ctx.notice("The batch is full. Send it before adding another comment.", "warn");
				return false;
			}
			session.comments.push({
				text: thread.draft,
				quote: thread.quote,
				range: thread.range,
				sourceAnchor: thread.sourceAnchor,
				authoredRevision: thread.authoredRevision ?? thread.draftRevision,
			});
			session.threads.splice(session.threads.indexOf(thread), 1);
			ctx.clearSelection?.();
			ask.close();
			session.current = null;
			return true;
		}
		function restoreBatch(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			owner.comments.unshift(...(thread.comments ?? []));
			restoreOverall(thread.overall, message.authoredRevision, owner);
			const index = owner.threads.indexOf(thread);
			if (index >= 0) owner.threads.splice(index, 1);
			const next: ReaderThread | null = thread.draft
				? { threadId: "", draft: thread.draft, draftRevision: thread.draftRevision, messages: [] }
				: null;
			if (next) owner.threads.unshift(next);
			if (owner.heldThread === thread) owner.heldThread = null;
			if (owner.current === thread) {
				owner.current = next;
				owner.visible &&= !!next;
			}
			sessions.forget(message);
			const detail = message.detail ?? "The conversation did not accept it.";
			if (owner === session)
				ctx.notice(
					`Batch not sent. ${detail} Your comments are kept.${next ? " Your follow-up is a separate draft." : ""}`,
					"warn",
				);
		}
		const sendingBatches = new Set<ReaderAskDocument>();
		const retryBatch = new WeakMap<ReaderAskMessage, () => Promise<void>>();
		function batchReady() {
			if (session.current?.pendingComment && !session.current.pendingComment.text.trim()) ask.close();
			if (!session.comments.length) return false;
			if (sendingBatches.has(session)) {
				ctx.notice("Wait for the current batch to reach the conversation before sending another.", "warn");
				return false;
			}
			if (session.comments.length > batchLimit) {
				ctx.notice("Remove comments until the batch fits, then send it.", "warn");
				return false;
			}
			return batchTextFits();
		}
		function batchTextFits() {
			if (utf8.encode(session.overall).length > 64 * 1024) {
				ctx.notice("Shorten the overall comment before sending the batch.", "warn");
				return false;
			}
			const long = session.comments.findIndex(({ text }) => utf8.encode(text).length > 64 * 1024);
			if (long < 0) return true;
			ctx.notice(`Shorten comment ${long + 1} before sending the batch.`, "warn");
			return false;
		}
		async function sendBatch() {
			if (!batchReady() || !releaseEditor()) return;
			const owner = session,
				additions = [...owner.comments],
				overall = hasText(owner.overall) ? owner.overall : undefined,
				id = crypto.randomUUID();
			const message: ReaderAskMessage = {
				requestId: id,
				text: `Batch of ${commentCount(additions.length)}`,
				state: "sending",
				authoredRevision: owner.overallRevision,
			};
			const thread: ReaderThread = { threadId: id, comments: additions, overall, draft: "", messages: [message] };
			const packet = sessions.packet(thread, message, version());
			if (utf8.encode(JSON.stringify(packet)).length > 256 * 1024 - 128) {
				ctx.notice("The batch is too long. Shorten or remove comments before sending it.", "warn");
				return;
			}
			owner.comments.length = 0;
			setOverall("", owner);
			owner.threads.unshift(thread);
			sessions.register(owner, thread, message);
			openThread(thread, false);
			const attempt = async () => {
				if (owner !== session || sendingBatches.has(owner)) return;
				sendingBatches.add(owner);
				await sendAttempt(owner, thread, message);
				sendingBatches.delete(owner);
				if (!(message.state === "unknown" && message.retryable)) retryBatch.delete(message);
				if (message.state === "failed") restoreBatch(owner, thread, message);
				if (owner === session) ask.refresh();
			};
			retryBatch.set(message, attempt);
			await attempt();
		}
		function drawStatus(message: ReaderAskMessage, changeCount: number) {
			const glyph =
				({ failed: "info", unanswered: "info", answered: "check" } as Record<string, string>)[message.state] ?? "spark";
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
			return el(
				"ol",
				{ class: "batch-sent", role: "list" },
				...items.map((item, index) => el("li", { class: "batch-entry" }, commentNumber(index), commentPreview(item))),
			);
		}
		// A sent batch shows its overall comment above the numbered comments, in the order the agent reads them.
		function sentBatch(thread: ReaderThread) {
			const list = sentComments(thread.comments ?? []);
			if (!thread.overall) return list;
			return el(
				"div",
				{ class: "batch-request" },
				el(
					"div",
					{ class: "ask-question batch-overall-sent" },
					el("span", { class: "from" }, "Overall comment"),
					thread.overall,
				),
				list,
			);
		}
		function promptAnswer(message: ReaderAskMessage) {
			if (!message.detail) return null;
			if (message.state === "answered")
				return el("div", { class: "reply" }, el("span", { class: "from" }, "Agent"), message.detail);
			if (message.state === "unanswered") return el("p", { class: "send-failure" }, message.detail);
			return null;
		}
		function drawMessages(thread: ReaderThread) {
			const log = el("div", { class: "ask-messages" });
			for (const [index, m] of thread.messages.entries()) {
				const question =
					index === 0 && thread.comments
						? sentBatch(thread)
						: el("div", { class: "ask-question" }, el("span", { class: "from" }, "You"), m.text);
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
			card.append(
				el(
					"p",
					{ class: "send-failure" },
					message.retryable
						? "Delivery is not confirmed. Retry checks the same request."
						: "Delivery is not confirmed. Your text is kept. The reader will not send it twice.",
				),
			);
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
			if (!session.current || !session.visible) {
				card.removeAttribute("data-open");
				paintPassage();
				return;
			}
			const target = controller.compositionTarget;
			if (target instanceof Node && card.contains(target)) return;
			const thread = session.current,
				focused = focusedComposer();
			card.replaceChildren();
			card.dataset.state = activeMessage(thread)?.state ?? "draft";
			card.setAttribute("data-open", "");
			card.append(drawHead(thread));
			if (!thread.comments)
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
			const msg = value as {
				documentKey?: string;
				requestId: string;
				threadId: string;
				state: ReaderAskState;
				detail?: string;
			};
			const delivery = sessions.delivery(msg.requestId, msg.threadId);
			if (!delivery || (msg.documentKey !== undefined && msg.documentKey !== delivery.owner.documentKey)) return;
			const { owner, message } = delivery;
			// Admission evidence from the original request resolves an earlier transport uncertainty.
			if (message.state === "unknown" && ["sent", "admitted", "working"].includes(msg.state)) message.state = msg.state;
			else message.state = api.uiLogic.promptTransition(message.state, msg.state);
			if (message.state === msg.state) message.detail = msg.detail;
			if (owner === session) ask.refresh();
		}
		function newMessage(thread: ReaderThread) {
			const authoredRevision =
				(!thread.messages.length ? thread.authoredRevision : undefined) ?? thread.draftRevision ?? revision();
			const message: ReaderAskMessage = {
				requestId: crypto.randomUUID(),
				text: thread.draft,
				state: "sending",
				authoredRevision,
			};
			if (!thread.threadId) thread.threadId = message.requestId;
			thread.messages.push(message);
			thread.draft = "";
			thread.draftRevision = undefined;
			sessions.register(session, thread, message);
			return message;
		}
		function releaseEditor() {
			// Closing an open block can commit an edit. Capture its generation only afterwards.
			if (!controller.doc?.active || editor.close()) return true;
			ctx.notice("Finish the composition before sending the question.", "warn");
			return false;
		}
		async function sendMessage(retry?: ReaderAskMessage) {
			const thread = session.current;
			if (!thread || (!retry && (!thread.draft.trim() || pending(thread) || !quoteFits(thread.quote)))) return;
			if (!releaseEditor()) return;
			await sendAttempt(session, thread, retry ?? newMessage(thread));
			if (thread === session.current) ask.refresh();
		}
		async function sendAttempt(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			message.state = "sending";
			message.retryable = false;
			ask.refresh();
			for (let attempt = 0; attempt < 2; attempt++) {
				const packet = sessions.packet(thread, message, version());
				try {
					const receipt = (await host.request("prompt", packet)) as {
						accepted: boolean;
						uncertain?: true;
						retryable?: boolean;
						fresh?: true;
						detail?: string;
					};
					if (receipt.fresh) {
						// Native confirmed that this request never entered the conversation. Only then is a new base safe.
						sessions.releasePacket(message);
						if (
							!attempt &&
							owner === session &&
							(packet.presentation !== controller.payload?.presentation ||
								packet.generation !== controller.doc?.generation)
						)
							continue;
					}
					receiveReceipt(message, receipt);
					if (receipt.accepted) sessions.releasePacket(message);
				} catch (error) {
					if (message.state === "sending") {
						message.state = "unknown";
						message.retryable = true;
						message.detail = String(error);
					}
				}
				break;
			}
		}
		// The held request belongs to the document where the passage was open.
		function noteHeld() {
			session.heldThread =
				[...session.threads].reverse().find((t) => {
					const state = activeMessage(t)?.state;
					return !!state && ["sending", "sent", "admitted", "working"].includes(state);
				}) ?? session.heldThread;
		}
		// Let it releases the passage. If the held request has already ended, the agent is asked in
		// the same thread to make the change now; while it still works, its own retry lands.
		function letAgentChange() {
			editor.releaseHold();
			const thread = session.heldThread;
			session.heldThread = null;
			const state = thread ? activeMessage(thread)?.state : undefined;
			if (!thread || !state) {
				ctx.toast("The passage is free. Ask the agent again to change it.");
				return;
			}
			if (!["answered", "failed"].includes(state)) return;
			openThread(thread);
			if (!releaseEditor()) return;
			const message: ReaderAskMessage = {
				requestId: crypto.randomUUID(),
				text: "I closed the passage I had open. Please make the change now.",
				state: "sending",
				authoredRevision: revision(),
			};
			thread.messages.push(message);
			sessions.register(session, thread, message);
			void sendAttempt(session, thread, message).then(() => {
				if (thread === session.current) ask.refresh();
			});
		}
		function receiveReceipt(message: ReaderAskMessage, value: unknown) {
			const receipt = value as { accepted: boolean; uncertain?: true; retryable?: boolean; detail?: string };
			const state = receipt.uncertain ? "unknown" : receipt.accepted ? "sent" : "failed";
			// A delayed transport receipt must not undo proven admission or progress.
			if ((state === "unknown" || state === "failed") && ["sent", "admitted", "working"].includes(message.state))
				return;
			message.state = api.uiLogic.promptTransition(message.state, state);
			message.retryable = message.state === "unknown" && receipt.retryable === true;
			if (message.state === "failed" && state === "failed") message.detail = receipt.detail;
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
			if (session.current !== thread) {
				discardEmptyComment();
				discardEmptyQuestion();
			}
			session.current = thread;
			session.visible = true;
			refreshBatch();
			draw();
			if (focus) card.querySelector("textarea")?.focus({ preventScroll: true });
		}
		function visitChange(index: number, focusLabel?: string) {
			changeIndex = index;
			const { operation } = review[index];
			if (operation.unread) controller.markRead(operation.operationId);
			get("#notices")
				.querySelector(`[data-notice-id="${CSS.escape(`agent-${operation.operationId}`)}"]`)
				?.remove();
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
			const body = el("div", { class: "diff-body" }),
				{ oldText, newText } = target.edit;
			const parts = api.uiLogic.diffWords(oldText, newText);
			const before = newText ? "Before" : "Removed",
				after = oldText ? "After" : "Added";
			if (oldText) body.append(diffRow(before, "removed", target, parts));
			if (newText) body.append(diffRow(after, "added", target, parts));
			if (!parts)
				body.append(el("p", { class: "diff-note" }, "Long edit. Both versions are shown without word highlights."));
			return body;
		}
		function changeBlocks(edit: ReaderRange) {
			const blocks = Array.from(doc.querySelectorAll<HTMLElement>(":scope > [data-block]"));
			const first =
				blockAt(edit.start) ?? blocks.find((node) => Number(node.dataset.start) >= edit.start) ?? blocks.at(-1);
			if (!first) return [];
			return [
				first,
				...blocks.filter(
					(node) => node !== first && Number(node.dataset.start) < edit.end && Number(node.dataset.end) > edit.start,
				),
			];
		}
		function diffTarget({ operation, edit }: ReviewEntry) {
			if (!controller.doc) return null;
			const blocks = changeBlocks(edit),
				block = blocks[0] ?? doc;
			const context =
				!blocks.length || operation.conflicted
					? null
					: api.uiLogic.changeContext(
							controller.doc.source,
							{
								start: Number(block.dataset.start),
								end: Number(blocks.at(-1)?.dataset.end),
							},
							edit,
						);
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
			return (
				mounted.conflicted === entry.operation.conflicted &&
				previous.context?.prefix === target.context?.prefix &&
				previous.context?.suffix === target.context?.suffix &&
				previous.blocks.length === target.blocks.length &&
				target.blocks.every((block, i) => block === previous.blocks[i])
			);
		}
		function conflictWarning() {
			return el("p", { class: "diff-warning" }, "Original agent wording. Later edits overlap this change.");
		}
		function diffPanel(operation: ReaderAgentOperation, target: DiffTarget) {
			const diff = el("section", {
				class: "inline-diff",
				"data-reader-control": "",
				"aria-label": "Agent change",
				tabindex: "-1",
			});
			const head = el(
				"div",
				{ class: "diff-head" },
				el("span", { class: "diff-title" }, icon("spark"), "Passage change"),
			);
			if (review.length > 1) {
				const turn = (delta: number) =>
					visitChange(
						(changeIndex + delta + review.length) % review.length,
						delta < 0 ? "Previous change" : "Next change",
					);
				head.append(
					button("Previous change", "back", () => turn(-1), { iconOnly: true }),
					el("span", { class: "diff-count" }, `${changeIndex + 1} of ${review.length}`),
					button("Next change", "forward", () => turn(1), { iconOnly: true }),
				);
			}
			head.append(button("Close changes", "x", closeReview, { iconOnly: true, key: "esc" }));
			const foot = el("div", { class: "diff-actions" });
			const thread = operation.threadId && session.threads.find((t) => t.threadId === operation.threadId);
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
			annotationAt(x, y) {
				const mark = markAt(x, y);
				return mark ? (mark.kind === "comment" ? "comment" : "question") : null;
			},
			openAt(x, y) {
				const mark = markAt(x, y);
				mark?.open();
				return !!mark;
			},
			open(selection) {
				if (!controller.doc || !session.documentKey) return;
				const thread: ReaderThread = {
					threadId: "",
					quote: selection?.text,
					range: selection ? { start: selection.start, end: selection.end } : undefined,
					sourceAnchor:
						selection && controller.doc ? api.uiLogic.capturePassage(controller.doc.source, selection) : undefined,
					authoredRevision: selection ? revision() : undefined,
					draft: "",
					messages: [],
				};
				session.threads.unshift(thread);
				openThread(thread);
			},
			close() {
				if (review.length) {
					closeReview();
					return true;
				}
				if (!session.visible) return false;
				discardEmptyComment();
				discardEmptyQuestion();
				if (session.current?.pendingComment) session.current = null;
				session.visible = false;
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
				if (session.threads.some(pending)) b.append(el("span", { class: "dot", "aria-hidden": "true" }));
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
				if (session.current?.pendingComment) ask.close();
				discardEmptyQuestion();
				session.visible = false;
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
				if (controller.doc) sessions.change(change.edits, controller.doc.source);
			}),
			controller.on("ack", (ack) => {
				const { payload, doc } = controller;
				if (!payload || !doc) return;
				if (payload.meta.documentKey !== session.documentKey) installSession(payload, doc.source);
				if (ack.generation === doc.generation && typeof ack.digest === "string") session.digest = ack.digest;
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
			controller.on("document", (payload) => installSession(payload, payload.source)),
		);
		function installSession(payload: ReaderCoreDocument, source: string) {
			closeReview();
			if (session.documentKey !== payload.meta.documentKey) {
				batchList.hidePopover();
				activity.hidePopover();
				// Never carry a focused field or its selection to a different document.
				if (document.activeElement instanceof HTMLElement && card.contains(document.activeElement))
					document.activeElement.blur();
			}
			session = sessions.show(
				payload.meta.documentKey,
				source,
				typeof payload.meta.digest === "string" ? payload.meta.digest : undefined,
			);
			syncOverallField();
			ask.refresh();
		}
		// The final input event commits marked text before the postponed card redraw.
		let compositionFrame = 0;
		const finishCardInput = () => {
			cancelAnimationFrame(compositionFrame);
			compositionFrame = requestAnimationFrame(() => ask.refresh());
		};
		card.addEventListener("compositionend", finishCardInput);
		off.push(() => {
			card.removeEventListener("compositionend", finishCardInput);
			cancelAnimationFrame(compositionFrame);
		});
		const onBatchToggle = (event: ToggleEvent) => {
			const open = event.newState === "open";
			trayOpen.setAttribute("aria-expanded", String(open));
			if (open) drawBatchList();
		};
		batchList.addEventListener("beforetoggle", onBatchToggle);
		off.push(() => batchList.removeEventListener("beforetoggle", onBatchToggle));
		const onToggle = (event: ToggleEvent) => {
			if (event.newState === "open") drawActivity();
		};
		activity.addEventListener("beforetoggle", onToggle);
		off.push(() => activity.removeEventListener("beforetoggle", onToggle));
		const scroll = () => position();
		page.addEventListener("scroll", scroll, { passive: true });
		off.push(() => page.removeEventListener("scroll", scroll));
		// A plain click on a mark in Reading opens its card. A drag, a selection, a link and a
		// modified click keep their own meaning, and in Writing a click edits the text.
		function plainReadingClick(event: MouseEvent) {
			const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
			if (event.defaultPrevented || event.button !== 0 || modified) return false;
			if (controller.lock !== "reading" || getSelection()?.isCollapsed === false) return false;
			const target = event.target instanceof Element ? event.target : null;
			return !target?.closest("a[href], img, button, input, textarea, [data-reader-control]");
		}
		const openClickedMark = (event: MouseEvent) => {
			const mark = plainReadingClick(event) ? markAt(event.clientX, event.clientY) : null;
			if (!mark) return;
			event.preventDefault();
			mark.open();
		};
		let hoverFrame = 0;
		const trackHover = (event: PointerEvent) => {
			cancelAnimationFrame(hoverFrame);
			if (controller.lock !== "reading" || !marks.length) {
				hover(null);
				return;
			}
			const { clientX, clientY } = event;
			hoverFrame = requestAnimationFrame(() => hover(markAt(clientX, clientY)));
		};
		const endHover = () => {
			cancelAnimationFrame(hoverFrame);
			hover(null);
		};
		doc.addEventListener("click", openClickedMark);
		doc.addEventListener("pointermove", trackHover, { passive: true });
		doc.addEventListener("pointerleave", endHover);
		off.push(() => {
			cancelAnimationFrame(hoverFrame);
			doc.removeEventListener("click", openClickedMark);
			doc.removeEventListener("pointermove", trackHover);
			doc.removeEventListener("pointerleave", endHover);
		});
		const observer = new ResizeObserver(position);
		observer.observe(app);
		observer.observe(card);
		ask.refresh();
		return ask;
	};
})();
