(() => {
	const app = window.explorer;
	const { request, model } = app;
	const { el, get, button, icon, iconButton } = app.dom;
	const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
	const bytes = (text: string) => new TextEncoder().encode(text).length;
	const anchorOf = (note: ExplorerNote): ExplorerRange | null =>
		note.location === "outdated" ? null : { side: note.side, start: note.start, end: note.end };
	const excerptOf = (note: ExplorerNote): ExplorerExcerpt => ({
		path: note.path,
		start: note.anchor.start,
		end: note.anchor.end,
		quote: note.anchor.quote,
		commit: note.anchor.commit,
		text: note.text,
		id: note.id,
	});
	const label = (item: ExplorerExcerpt) =>
		item.start === undefined
			? item.path
			: `Line${item.start === item.end ? "" : "s"} ${item.start}${item.start === item.end ? "" : `–${item.end}`} · ${item.commit?.slice(0, 7) ?? "working tree"}`;
	type Run = {
		packet: ExplorerPacket;
		root: string;
		ids: string[];
		item: ExplorerExcerpt | null;
		question: string;
		last?: ExplorerPromptState;
		admission: "pending" | "accepted" | "failed";
		error?: string;
		retryable?: boolean;
		noteWrite: Promise<void>;
		batch: boolean;
		recorded: Set<string>;
	};
	type Card = {
		node: HTMLElement;
		content: HTMLElement;
		actions: HTMLElement;
		range: ExplorerRange | null;
		root: string;
		focus: HTMLElement | null;
		rebuild?: () => void;
	};

	app.review = (ctx): ExplorerReviewUI => {
		const container = get("floating");
		const codeBody = get("view-body");
		const dock = get("comment-dock");
		const tray = get("review-dock");
		const commands = el("div", "review-list");
		commands.hidden = true;
		container.append(commands);
		const flights = new Map<string, Run>();
		const pending = new Set<string>();
		const unsaved = new Map<string, ExplorerCardDraft>();
		let card: Card | null = null;
		let shownRun: Run | null = null;
		let walkthrough: { tour: ExplorerTour; index: number; serial: number } | null = null;
		let removeUndo: { notes: ExplorerNote[]; root: string } | null = null;
		let tourSerial = 0;
		let trayStamp = "";
		const report = (promise: Promise<unknown>) => {
			void promise.catch((error) => ctx.notice(message(error)));
		};
		const here = () => ctx.root().path;
		const currentDrafts = () => ctx.drafts().filter((note) => !pending.has(note.id));
		const reason = () => ctx.live().reason ?? "There is no live conversation.";
		const destination = () => ctx.live().label ?? "conversation";
		const senderLabel = () => `Send to ${destination()}`;
		const bake = (items: ExplorerExcerpt[]) => model.excerpt(ctx.root().name, ctx.scope(), items);
		const flashCopy = (text: string) =>
			report(request("clipboard.write", { text }).then(() => ctx.notice("Review copied")));
		const ctl = (text: string, fn: () => void, cls = "secondary") => button(text, fn, cls);
		const errorField = () => {
			const node = el("p", "card-error");
			node.hidden = true;
			node.setAttribute("role", "status");
			return node;
		};
		const announce = (field: HTMLElement, text: string) => {
			field.hidden = !text;
			field.textContent = text;
		};
		const disable = (control: HTMLButtonElement, disabled: boolean, description?: string) => {
			control.disabled = disabled;
			control.title = description ?? "";
		};

		// Height limit for a floating card within the code viewport.
		function cardLimit(body: DOMRect) {
			return Math.max(120, Math.min(465, body.height - 16));
		}

		// Space below and above the anchored lines.
		function anchorSpace(body: DOMRect, anchor: DOMRect | null) {
			const bottom = anchor ? body.bottom - anchor.bottom - 12 : body.height - 16;
			const top = anchor ? anchor.top - body.top - 12 : 0;
			return { bottom, top };
		}

		// Attaches the card beside its lines when a side fits, or docks it.
		function attachCard(node: HTMLElement, body: DOMRect, anchor: DOMRect | null, desired: number) {
			const space = anchorSpace(body, anchor);
			if (desired <= space.bottom || !anchor) {
				const top = anchor ? anchor.bottom + 8 : Math.max(body.top + 8, body.bottom - desired - 8);
				node.style.top = `${top}px`;
				dock.hidden = true;
				return;
			}
			if (desired <= space.top) {
				node.style.top = `${anchor.top - desired - 8}px`;
				dock.hidden = true;
				return;
			}
			dockCard(node, body, space);
		}

		function dockCard(node: HTMLElement, body: DOMRect, space: { bottom: number; top: number }) {
			const cap = Math.max(0, Math.min(260, Math.max(space.top, space.bottom)));
			node.classList.add("docked");
			if (cap >= 155) {
				node.style.maxHeight = `${cap}px`;
				node.style.top = `${space.bottom >= space.top ? body.bottom - cap - 5 : body.top + 5}px`;
				dock.hidden = true;
				return;
			}
			// The dock changes only the lower edge of the code viewport, never its scroll offset.
			dock.hidden = false;
			dock.append(node);
			node.style.maxHeight = `${Math.min(260, Math.max(165, body.height * 0.34))}px`;
		}

		function reposition() {
			if (!card) return;
			const node = card.node;
			const body = codeBody.getBoundingClientRect();
			const main = get("main").getBoundingClientRect();
			const anchor = ctx.bounds(card.range);
			const width = Math.min(Math.max(main.width - 20, 0), 426);
			node.style.width = `${width}px`;
			node.style.left = `${Math.max(main.left + 10, main.right - width - 12)}px`;
			if (!container.contains(node)) container.append(node);
			node.classList.remove("docked");
			node.style.maxHeight = `${cardLimit(body)}px`;
			attachCard(node, body, anchor, Math.min(node.scrollHeight + 2, cardLimit(body)));
		}
		const cardResize = new ResizeObserver(() => {
			if (card && card.node.parentElement !== dock) reposition();
		});
		cardResize.observe(codeBody);

		function closeCard(restore = true) {
			const current = card;
			card = null;
			shownRun = null;
			if (current) {
				current.node.remove();
				if (restore) current.focus?.focus({ preventScroll: true });
			}
			dock.hidden = true;
			ctx.highlight(null);
		}
		function dismiss() {
			if (!commands.hidden) {
				commands.hidden = true;
				return true;
			}
			if (!card && !walkthrough) return false;
			walkthrough = null;
			tourSerial++;
			closeCard();
			return true;
		}
		function makeCard(title: string, caption: string, range: ExplorerRange | null, agent = false) {
			const focus = card?.focus ?? (document.activeElement as HTMLElement | null);
			closeCard(false);
			const node = el("section", `float-card${agent ? " agent-card" : ""}`);
			node.setAttribute("role", "dialog");
			node.setAttribute("aria-label", title);
			const header = el("div", "ask-head");
			const identity = el("div");
			identity.append(el("strong", "", title));
			if (caption) identity.append(el("small", "", caption));
			header.append(
				identity,
				iconButton("close", "Close (Esc)", () => {
					walkthrough = null;
					tourSerial++;
					closeCard();
				}),
			);
			const content = el("div", "card-content"),
				actions = el("div", "card-actions");
			node.append(header, content, actions);
			const next = { node, content, actions, range, root: here(), focus };
			card = next;
			container.append(node);
			ctx.highlight(range);
			return next as Card;
		}
		function textarea(name: string, value = "") {
			const field = el("textarea");
			field.setAttribute("aria-label", name);
			field.placeholder = name;
			field.value = value;
			field.maxLength = 32000;
			return field;
		}
		function shortcuts(field: HTMLTextAreaElement, action: (shift: boolean) => void) {
			field.onkeydown = (event) => {
				if (event.isComposing || event.key !== "Enter" || !event.metaKey) return;
				event.preventDefault();
				event.stopPropagation();
				action(event.shiftKey);
			};
		}
		function drawQuote(parent: HTMLElement, quote?: string) {
			if (quote !== undefined) parent.append(el("pre", "quoted-lines", quote));
		}
		function truncateReply(text: string) {
			if (bytes(text) <= 32000) return text;
			let target = text.slice(0, 8000);
			if (/[\uD800-\uDBFF]$/.test(target)) target = target.slice(0, -1);
			return target;
		}
		function noteData(item: ExplorerExcerpt, side: ExplorerSide, state: ExplorerCreateNote["state"]) {
			if (item.start === undefined || item.end === undefined || item.quote === undefined)
				throw new Error("Select a line before you keep a note.");
			return {
				path: item.path,
				start: item.start,
				end: item.end,
				commit: item.commit,
				quote: item.quote,
				side,
				state,
				author: "operator",
				text: item.text,
			} satisfies ExplorerCreateNote;
		}
		async function create(item: ExplorerExcerpt, side: ExplorerSide, state: ExplorerCreateNote["state"]) {
			if (bytes(item.text) > 32768 || bytes(item.quote ?? "") > 65536)
				throw new Error("Select fewer lines or shorten your comment.");
			const result = await request("notes.write", { op: "create", note: noteData(item, side, state) });
			if (!result.note) throw new Error("Explorer did not receive the saved note.");
			return result.note;
		}
		function runFor(
			content: string,
			question: string,
			ids: string[],
			item: ExplorerExcerpt | null,
			batch = false,
			threadId?: string,
		): Run {
			if (bytes(content) > 128 * 1024)
				throw new Error("This message exceeds 128 KB. Send fewer comments or select fewer lines.");
			const requestId = crypto.randomUUID();
			const run: Run = {
				packet: { requestId, threadId: threadId ?? requestId, text: content, ...(ids.length ? { noteIds: ids } : {}) },
				root: here(),
				ids,
				item,
				question,
				admission: "pending",
				noteWrite: Promise.resolve(),
				batch,
				recorded: new Set(),
			};
			flights.set(requestId, run);
			return run;
		}
		function paintRun(run: Run) {
			if (shownRun === run && card?.root === here()) card.rebuild?.();
		}
		// The answer of a run that the host accepted and owes note replies.
		function answeredRun(run: Run) {
			const answer = run.last;
			if (answer?.status !== "answer") return false;
			return run.admission === "accepted" && run.ids.length > 0 ? answer : false;
		}
		function replyText(answer: ExplorerPromptState) {
			const retained = truncateReply(answer.text || "The agent returned no text.");
			return `${retained}${answer.truncated || retained.length < answer.text.length ? "\n\nRead the rest in the conversation." : ""}`;
		}
		function unresolvedIds(run: Run) {
			return run.packet.noteIds?.filter((id) => ctx.notes().find((note) => note.id === id)?.state !== "resolved");
		}
		// Writes the agent answer back into the notes that asked for it.
		async function writeAnswer(run: Run, answer: ExplorerPromptState) {
			if (run.root !== here()) return;
			for (const id of run.ids) {
				if (run.recorded.has(id)) continue;
				await request("notes.write", {
					op: "reply",
					id,
					text: replyText(answer),
					author: "agent",
					requestId: run.packet.requestId,
				});
				run.recorded.add(id);
			}
			const ids = unresolvedIds(run);
			if (ids?.length)
				await request("notes.write", { op: "state", ids, state: "answered", requestId: run.packet.requestId });
			await ctx.refresh();
		}
		function syncReply(run: Run) {
			const answer = answeredRun(run);
			if (!answer) return;
			run.noteWrite = run.noteWrite
				.then(() => writeAnswer(run, answer))
				.catch((error) => ctx.notice(`The answer did not save: ${message(error)}`));
		}
		// Restores the card state after the host refuses a prompt.
		function failSend(run: Run, error: unknown) {
			const issue = error as { code?: string; retryable?: boolean };
			run.admission = "failed";
			run.error = message(error);
			run.retryable = issue.retryable === true || issue.code === undefined;
			releasePending(run, issue);
			refresh();
			paintRun(run);
		}
		function releasePending(run: Run, issue: { code?: string }) {
			if (issue.code === "uncertain" || issue.code === undefined) return;
			for (const id of run.ids) pending.delete(id);
		}
		function markSent(run: Run, ids: string[]) {
			return request("notes.write", {
				op: "state",
				ids,
				state: "sent",
				requestId: run.packet.requestId,
			});
		}
		// Records the sent state and finishes the batch once the host accepts.
		async function settleSend(run: Run, finish: () => Promise<void>) {
			if (run.packet.noteIds?.length) await markSent(run, run.packet.noteIds);
			if (run.batch) await finish();
			await ctx.refresh();
		}
		function releaseIds(run: Run) {
			for (const id of run.ids) pending.delete(id);
			refresh();
		}
		function deliverSend(run: Run, finish: () => Promise<void>) {
			run.noteWrite = settleSend(run, finish)
				.catch((error) => ctx.notice(`The message was sent, but its review state did not save: ${message(error)}`))
				.finally(() => releaseIds(run));
		}
		async function send(run: Run) {
			if (run.root !== here()) return;
			const finish = ctx.finish();
			run.admission = "pending";
			run.error = undefined;
			run.retryable = false;
			for (const id of run.ids) pending.add(id);
			refresh();
			paintRun(run);
			try {
				await request("prompt", run.packet);
			} catch (error) {
				failSend(run, error);
				return;
			}
			run.admission = "accepted";
			paintRun(run);
			if (run.root !== here()) return;
			deliverSend(run, finish);
			syncReply(run);
		}
		function prompt(event: ExplorerPromptState) {
			const run = flights.get(event.requestId);
			if (!run || run.packet.threadId !== event.threadId || (run.last?.sequence ?? -1) >= event.sequence) return;
			run.last = event;
			paintRun(run);
			syncReply(run);
		}
		function errorText(run: Run) {
			const answer = run.last;
			if (answer?.status !== "error") return undefined;
			return answer.text || "The conversation reports an error.";
		}
		function statusMessage(run: Run) {
			const failed = errorText(run);
			if (failed !== undefined) return failed;
			if (run.last?.status === "working") return "The agent is working…";
			if (run.last?.status === "queued") return "Queued in the conversation…";
			return undefined;
		}
		function runMessage(run: Run) {
			if (run.error) return run.error;
			if (run.last?.status === "answer") return "Agent reply";
			const status = statusMessage(run);
			if (status !== undefined) return status;
			return run.admission === "accepted" ? "Sent to the conversation…" : "Sending…";
		}
		// The retained agent answer shown under a run.
		function answerBody(answer: ExplorerPromptState) {
			const body = answer.text || "The agent returned no text.";
			const tail = answer.truncated ? "\n\nRead the rest in the conversation." : "";
			return `${body}${tail}`;
		}
		function answerText(run: Run) {
			const answer = run.last;
			if (!answer) return "";
			if (answer.status !== "answer") return "";
			return answerBody(answer);
		}
		function failedRun(run: Run) {
			return !!run.error || run.last?.status === "error";
		}
		function showRun(run: Run, range: ExplorerRange | null = null) {
			const current = makeCard(
				run.batch ? "Review" : "Ask about this",
				run.item ? label(run.item) : destination(),
				range,
			);
			shownRun = run;
			const progress = el("div", "prompt-progress");
			progress.setAttribute("role", "status");
			const answer = el("div", "thread-reply");
			const follow = textarea("Write a follow-up");
			const followable = (text: string) => {
				if (!text) return false;
				if (!ctx.live().connected) return false;
				return card === current;
			};
			const later = () => {
				const text = follow.value.trim();
				if (!followable(text)) return;
				sendFollowUp(run, current, text);
			};
			const submit = ctl("Send follow-up", later, "primary");
			const retry = ctl("Retry", () => report(send(run)), "secondary");
			current.content.append(el("p", "note-text question", run.question));
			drawQuote(current.content, run.item?.quote);
			current.content.append(progress, answer, follow);
			current.actions.append(retry, submit);
			shortcuts(follow, later);
			follow.oninput = () => disable(submit, !ctx.live().connected || !follow.value.trim());
			// Follows up the same thread with the text from the reply field.
			function followRun(run: Run, text: string) {
				const item = run.item ? { ...run.item, text } : null;
				return runFor(item ? bake([item]) : text, text, [], item, false, run.packet.threadId);
			}
			function sendFollowUp(run: Run, current: Card, text: string) {
				try {
					const next = followRun(run, text);
					showRun(next, current.range);
					report(send(next));
				} catch (error) {
					ctx.notice(message(error));
				}
			}
			function disableRunControls() {
				disable(retry, !ctx.live().connected, reason());
				disable(submit, !ctx.live().connected || !follow.value.trim(), ctx.live().connected ? undefined : reason());
			}
			current.rebuild = () => {
				progress.textContent = runMessage(run);
				progress.classList.toggle("card-error", failedRun(run));
				answer.hidden = run.last?.status !== "answer";
				answer.textContent = answerText(run);
				const ready = run.admission === "accepted";
				follow.hidden = submit.hidden = !ready;
				retry.hidden = !run.retryable;
				disableRunControls();
				reposition();
			};
			current.rebuild();
		}

		// The card title for each edit mode.
		function cardTitle(mode: "ask" | "comment" | "note", draft?: ExplorerNote) {
			if (draft) return "Edit review comment";
			if (mode === "note") return "Keep a note";
			if (mode === "comment") return "Comment on code";
			return "Ask about this";
		}
		function draftEditor(
			item: ExplorerExcerpt,
			range: ExplorerRange | null,
			mode: "ask" | "comment" | "note",
			draft?: ExplorerNote,
			retained?: ExplorerCardDraft,
		) {
			const key = `${here()}\0${item.path}`;
			const storedRange = retained?.range ?? range ?? undefined;
			const current = makeCard(cardTitle(mode, draft), label(item), range);
			const field = textarea(
				mode === "ask" ? "Ask about this code…" : "Write a comment…",
				retained?.text ?? draft?.text,
			);
			field.maxLength = 16000;
			function clearDraft() {
				unsaved.delete(key);
				report(ctx.saveDraft(item.path, null));
			}
			function saveDraft() {
				if (!field.value) {
					clearDraft();
					return;
				}
				const quote = item.quote !== undefined && bytes(item.quote) <= 32000 ? item.quote : undefined;
				const data: ExplorerCardDraft = {
					mode,
					text: field.value,
					range: storedRange,
					noteId: draft?.id,
					quote,
					commit: item.commit,
				};
				unsaved.set(key, data);
				report(ctx.saveDraft(item.path, data));
			}
			const fail = errorField();
			const hint = el("p", "shortcut-hint");
			let busy = false;
			// The card refuses writes while busy, empty or left behind by navigation.
			function blocked() {
				return busy || !field.value.trim() || current.root !== here();
			}
			type DraftAction = "keep" | "add" | "send" | "batch";
			function createCardNote(action: DraftAction, text: string) {
				const state = action === "keep" ? "open" : "draft";
				return create({ ...item, text }, storedRange?.side ?? "head", state);
			}
			function afterKeep(action: DraftAction) {
				clearDraft();
				if (card === current) closeCard();
				ctx.notice(keptNotice(action));
				if (action === "batch") return sendBatch();
			}
			function keptNotice(action: DraftAction) {
				if (action === "keep") return "Note saved";
				return draft ? "Comment updated" : "Comment added to review";
			}
			function checkPromptSize(text: string) {
				if (bytes(bake([{ ...item, text }])) > 128 * 1024 - 40)
					throw new Error("This message exceeds 128 KB. Select fewer lines.");
			}
			function cardRun(saved: ExplorerNote | null, text: string) {
				const quoted = saved ? excerptOf(saved) : { ...item, text };
				return runFor(bake([quoted]), text, saved ? [saved.id] : [], quoted);
			}
			function clearAfterSend(saved: ExplorerNote | null, run: Run) {
				if (saved) return;
				if (run.admission !== "accepted" || current.root !== here()) return;
				clearDraft();
			}
			function prepareCardRun(saved: ExplorerNote | null, text: string) {
				const run = cardRun(saved, text);
				if (card === current) showRun(run, range);
				if (saved) clearDraft();
				return run;
			}
			function persistNote(action: DraftAction, text: string) {
				if (draft) return request("notes.write", { op: "update", id: draft.id, text });
				if (action !== "send") return createCardNote(action, text);
			}
			async function sendCardText(text: string) {
				checkPromptSize(text);
				const saved = storedRange ? await create({ ...item, text }, storedRange.side, "draft") : null;
				if (current.root !== here()) return;
				const run = prepareCardRun(saved, text);
				await send(run);
				clearAfterSend(saved, run);
			}
			async function applyAction(action: DraftAction, text: string) {
				const saved = persistNote(action, text);
				if (saved) {
					await saved;
					await ctx.refresh();
				}
				if (current.root !== here()) return;
				if (action === "send") return sendCardText(text);
				return afterKeep(action);
			}
			async function write(action: DraftAction) {
				if (blocked()) return;
				busy = true;
				field.readOnly = true;
				announce(fail, "");
				update();
				try {
					await applyAction(action, field.value.trim());
				} catch (error) {
					announce(fail, message(error));
				} finally {
					busy = false;
					field.readOnly = false;
					update();
				}
			}

			function keepStyle() {
				return mode === "note" || draft ? "primary" : "quiet";
			}
			// The primary save control for the card.
			function keepControl() {
				const text = draft ? "Save comment" : "Keep as note";
				const action = draft ? "add" : "keep";
				return ctl(text, () => report(write(action)), keepStyle());
			}
			const keep = keepControl();
			const add = ctl("Add to review", () => report(write("add")));
			const sendNow = ctl("Send now", () => report(write("send")), "primary");
			function keepHidden() {
				return !draft && !storedRange;
			}
			function sendHidden() {
				return mode === "note" || !!draft;
			}
			// The add action needs selected lines, a new note and a live conversation.
			function addable(live: ExplorerLive) {
				if (!storedRange || draft || mode === "note") return false;
				return live.connected;
			}
			function unavailable() {
				return busy || !field.value.trim();
			}
			function disableControls(live: ExplorerLive) {
				const blocked = unavailable();
				disable(keep, blocked);
				disable(add, blocked);
				disable(sendNow, blocked || !live.connected, live.connected ? senderLabel() : reason());
			}
			function batchHint(inBatch: boolean) {
				return inBatch && !!range;
			}
			// The keyboard hint shown under the card field.
			function hintText(live: ExplorerLive, inBatch: boolean) {
				if (!live.connected) return reason();
				if (sendHidden()) return "⌘↩ Save";
				if (batchHint(inBatch)) return "⌘↩ Add · ⇧⌘↩ Add and send";
				return "⌘↩ Send now";
			}
			function update() {
				const live = ctx.live();
				const inBatch = !!currentDrafts().length;
				keep.hidden = keepHidden();
				add.hidden = !addable(live);
				sendNow.hidden = sendHidden();
				disableControls(live);
				hint.textContent = hintText(live, inBatch);
				reposition();
			}
			field.oninput = () => {
				saveDraft();
				update();
			};
			function offlineCard() {
				return !ctx.live().connected && !!storedRange;
			}
			function simpleCard() {
				return !!draft || mode === "note";
			}
			function keepCurrent() {
				if (draft) report(write("add"));
				else report(write("keep"));
			}
			function cardShortcut(shift: boolean) {
				if (currentDrafts().length && storedRange) return shift ? "batch" : "add";
				return "send";
			}
			// The Enter shortcut picks the action the current card state allows.
			function submitCard(shift: boolean) {
				if (simpleCard() || offlineCard()) {
					keepCurrent();
					return;
				}
				if (!ctx.live().connected) return;
				report(write(cardShortcut(shift)));
			}
			shortcuts(field, submitCard);
			drawQuote(current.content, item.quote);
			current.content.append(field, hint, fail);
			current.actions.append(keep, add, sendNow);
			current.rebuild = update;
			update();
			field.focus({ preventScroll: true });
		}
		function ask(range: ExplorerRange | null, mode: "ask" | "comment" | "note" = "ask") {
			const item = ctx.excerpt(range);
			if (!item) return;
			walkthrough = null;
			tourSerial++;
			const stored = unsaved.get(`${here()}\0${item.path}`);
			if (stored) {
				restore(item.path, stored);
				return;
			}
			draftEditor(item, range, !ctx.live().connected && mode === "comment" ? "note" : mode);
		}
		function restore(path: string, stored: ExplorerCardDraft) {
			unsaved.set(`${here()}\0${path}`, stored);
			const note = ctx.notes().find((note) => note.id === stored.noteId && note.state === "draft");
			const mark = stored.range ?? null;
			const source = ctx.excerpt(mark);
			const matches = !mark || (!!source && (stored.quote === undefined || source.quote === stored.quote));
			const item: ExplorerExcerpt = {
				path,
				start: mark?.start,
				end: mark?.end,
				quote: stored.quote ?? source?.quote,
				commit: stored.commit ?? source?.commit ?? null,
				text: "",
			};
			draftEditor(item, matches ? mark : null, stored.mode, note, stored);
			if (!matches) ctx.notice("The draft keeps its quote because these lines changed.");
		}
		async function sendBatch() {
			if (!ctx.live().connected) return;
			const notes = currentDrafts();
			if (!notes.length) return;
			const text = bake(notes.map(excerptOf));
			const run = runFor(
				text,
				`${notes.length} review comment${notes.length === 1 ? "" : "s"}`,
				notes.map((note) => note.id),
				null,
				true,
			);
			commands.hidden = true;
			showRun(run);
			await send(run);
		}
		async function remove(notes: ExplorerNote[]) {
			const root = here();
			const removed: ExplorerNote[] = [];
			try {
				for (const note of notes) {
					if (here() !== root) return;
					await request("notes.write", { op: "delete", id: note.id });
					removed.push(note);
				}
			} finally {
				if (here() === root) {
					removeUndo = { notes: removed, root };
					await ctx.refresh();
				}
			}
		}
		function restoreUndo(removed: { notes: ExplorerNote[]; root: string }) {
			if (removed.notes.length) removeUndo = removed;
			return ctx.refresh();
		}
		async function undo() {
			if (!removeUndo || removeUndo.root !== here()) return;
			const removed = removeUndo;
			removeUndo = null;
			try {
				while (removed.notes.length && here() === removed.root) {
					const note = removed.notes[0];
					await create(excerptOf(note), note.side, "draft");
					removed.notes.shift();
				}
			} finally {
				if (here() === removed.root) await restoreUndo(removed);
			}
		}

		function renderDraftList(drafts: ExplorerNote[]) {
			commands.replaceChildren();
			const header = el("div", "ask-head");
			header.append(
				el("strong", "", "Review comments"),
				iconButton("close", "Close comments", () => {
					commands.hidden = true;
				}),
			);
			commands.append(header);
			const items = el("ol", "pending-list");
			for (const [index, note] of drafts.entries()) {
				const row = el("li");
				const jump = ctl(
					"",
					() => {
						commands.hidden = true;
						report(ctx.go(note).then(() => thread([note])));
					},
					"pending-open",
				);
				jump.append(el("strong", "", `${note.path}:${note.start}`), el("span", "", note.text));
				const edit = iconButton("edit", "Edit comment", () => {
					commands.hidden = true;
					report(ctx.go(note).then(() => draftEditor(excerptOf(note), anchorOf(note), "comment", note)));
				});
				row.append(
					el("span", "ordinal", String(index + 1)),
					jump,
					edit,
					iconButton("close", "Remove comment", () => report(remove([note]))),
				);
				items.append(row);
			}
			if (!drafts.length) items.append(el("li", "", "No comments in this review."));
			const actions = el("div", "card-actions");
			const clear = ctl("Remove all", () => report(remove(drafts)), "quiet danger");
			clear.disabled = !drafts.length;
			actions.append(clear);
			if (removeUndo?.root === here() && removeUndo.notes.length) actions.append(ctl("Undo", () => report(undo())));
			commands.append(items, actions);
		}
		function undoShown() {
			return removeUndo?.root === here() && !!removeUndo?.notes.length;
		}
		// The tray state that decides whether its controls need repainting.
		function trayStampFor(drafts: ExplorerNote[], undoVisible: boolean, connected: boolean) {
			return JSON.stringify([
				here(),
				drafts.map((note) => [note.id, note.text, note.start]),
				undoVisible,
				connected,
				destination(),
				reason(),
			]);
		}
		function toggleDraftList() {
			commands.hidden = !commands.hidden;
			if (commands.hidden) return;
			renderDraftList(currentDrafts());
			commands.querySelector("button")?.focus({ preventScroll: true });
		}
		// The tray button that opens and closes the draft list.
		function trayCount(drafts: ExplorerNote[]) {
			const count = ctl(`${drafts.length} comment${drafts.length === 1 ? "" : "s"}`, toggleDraftList, "tray-count");
			count.prepend(icon("list"));
			return count;
		}
		function copyReview() {
			return ctl("Copy review", () => flashCopy(bake(currentDrafts().map(excerptOf))));
		}
		// The send control for the review tray.
		function traySend(drafts: ExplorerNote[], connected: boolean) {
			const send = ctl(connected ? senderLabel() : "Send", () => report(sendBatch()), "primary");
			disable(send, !drafts.length || !connected, connected ? undefined : reason());
			return send;
		}
		// Rebuilds the review tray controls from the current draft list.
		function renderTray(drafts: ExplorerNote[], undoVisible: boolean, connected: boolean) {
			const count = trayCount(drafts);
			const send = traySend(drafts, connected);
			tray.replaceChildren(count);
			if (undoVisible) tray.append(ctl("Undo remove", () => report(undo())));
			if (!connected && drafts.length) tray.append(copyReview());
			tray.append(send);
			if (!commands.hidden) renderDraftList(drafts);
		}
		function refresh() {
			const drafts = currentDrafts();
			const undoVisible = undoShown();
			const connected = ctx.live().connected;
			tray.hidden = !drafts.length && !undoVisible;
			const stamp = trayStampFor(drafts, undoVisible, connected);
			if (trayStamp !== stamp) {
				trayStamp = stamp;
				renderTray(drafts, undoVisible, connected);
			}
			card?.rebuild?.();
		}

		function authorName(author: string) {
			return author === "agent" ? "Agent" : "You";
		}
		function movedSuffix(note: ExplorerNote) {
			if (note.location === "outdated") return " · Outdated";
			if (note.location === "moved") return ` · Moved from L${note.movedFrom ?? note.anchor.start}`;
			return "";
		}
		function appendReplies(block: HTMLElement, note: ExplorerNote) {
			for (const reply of note.thread) {
				const response = el("div", "thread-reply");
				response.append(el("strong", "", authorName(reply.author)), el("p", "", reply.text));
				block.append(response);
			}
		}
		// One note and its replies as a thread entry block.
		function threadEntry(note: ExplorerNote) {
			const block = el("div", "thread-entry");
			block.append(
				el("p", "thread-meta", `${authorName(note.author)} · ${note.state}${movedSuffix(note)}`),
				el("p", "note-text", note.text),
			);
			if (note.location !== "same") drawQuote(block, note.anchor.quote);
			appendReplies(block, note);
			return block;
		}
		function thread(notes: ExplorerNote[], position?: ExplorerRange | null) {
			const first = notes[0];
			if (!first) return;
			walkthrough = null;
			tourSerial++;
			const current = makeCard(
				first.title ?? (notes.length > 1 ? `${notes.length} notes` : "Note thread"),
				label(excerptOf(first)),
				position === undefined ? anchorOf(first) : position,
				first.author === "agent",
			);
			const entries = el("div", "thread-entries");
			const field = textarea("Write a reply…");
			field.hidden = true;
			const fail = errorField();
			let locked = false;
			let threadStamp = "";
			const save = async () => {
				const text = field.value.trim();
				if (locked || !text || current.root !== here()) return;
				locked = true;
				announce(fail, "");
				try {
					await request("notes.write", { op: "reply", id: first.id, text, author: "operator" });
					if (field.value.trim() === text) field.value = "";
					await ctx.refresh();
				} catch (error) {
					announce(fail, message(error));
				} finally {
					locked = false;
				}
			};
			const reveal = ctl(
				"Reply",
				() => {
					if (field.hidden) {
						field.hidden = false;
						reveal.textContent = "Save reply";
						reposition();
						field.focus({ preventScroll: true });
					} else report(save());
				},
				"primary",
			);
			const state = ctl(
				"Resolve",
				() => {
					const latest = ctx.notes().find((note) => note.id === first.id) ?? first;
					report(
						request("notes.write", {
							op: "state",
							ids: [first.id],
							state: latest.state === "resolved" ? "open" : "resolved",
						}).then(ctx.refresh),
					);
				},
				"quiet",
			);
			current.content.append(entries, field, fail);
			current.actions.append(state, reveal);
			shortcuts(field, () => report(save()));
			function currentNotes(notes: ExplorerNote[]) {
				const byId = new Map(ctx.notes().map((note) => [note.id, note]));
				return notes.map((note) => byId.get(note.id) ?? note);
			}
			function refreshThreadState(first: ExplorerNote) {
				state.textContent = first.state === "resolved" ? "Reopen" : "Resolve";
				state.hidden = first.state === "draft";
			}
			current.rebuild = () => {
				const visible = currentNotes(notes);
				const next = JSON.stringify(visible);
				if (next === threadStamp) return;
				threadStamp = next;
				entries.replaceChildren();
				for (const note of visible) entries.append(threadEntry(note));
				refreshThreadState(visible[0]);
				reposition();
			};
			current.rebuild();
		}
		async function moveTour(index: number) {
			const active = walkthrough;
			if (!active || index < 0 || index >= active.tour.stops.length) return;
			const note = ctx.notes().find((note) => note.id === active.tour.stops[index]);
			if (!note) {
				ctx.notice("This stop is not available.");
				return;
			}
			active.index = index;
			const serial = ++tourSerial;
			await ctx.go(note);
			if (walkthrough !== active || serial !== tourSerial) return;
			const current = makeCard(note.title ?? active.tour.title, label(excerptOf(note)), anchorOf(note), true);
			const count = el("div", "tour-meta");
			count.append(el("span", "", "AGENT WALKTHROUGH"), el("span", "", `${index + 1} of ${active.tour.stops.length}`));
			current.node.prepend(count);
			const wording = el("p", "note-text", note.text);
			current.content.append(wording);
			const previous = ctl("Previous", () => report(moveTour(index - 1)));
			previous.disabled = index === 0;
			const next = ctl("Next", () => report(moveTour(index + 1)));
			next.disabled = index >= active.tour.stops.length - 1;
			const reply = ctl(
				"Reply",
				() => {
					if (!ctx.live().connected) {
						thread([note]);
						return;
					}
					const item = excerptOf(note);
					const field = textarea("Write a reply…");
					const sendReply = () => {
						const question = field.value.trim();
						if (!question) return;
						report(
							(async () => {
								if (current.root !== here()) return;
								await request("notes.write", { op: "reply", id: note.id, text: question, author: "operator" });
								const run = runFor(bake([{ ...item, text: question }]), question, [], item);
								run.ids = [note.id];
								showRun(run, current.range);
								await send(run);
							})(),
						);
					};
					current.content.append(field);
					shortcuts(field, sendReply);
					reply.textContent = "Send reply";
					const submit = ctl("Send reply", sendReply, "agent-button");
					reply.replaceWith(submit);
					field.focus({ preventScroll: true });
					reposition();
				},
				"agent-button",
			);
			current.actions.append(previous, next, el("span", "grow"), reply);
			reposition();
		}
		async function tour(tour: ExplorerTour) {
			walkthrough = { tour, index: 0, serial: ++tourSerial };
			await moveTour(0);
		}
		function step(direction: number) {
			if (!walkthrough) return false;
			report(moveTour(walkthrough.index + direction));
			return true;
		}
		return { ask, restore, thread, tour, step, refresh, prompt, reposition, escape: dismiss };
	};
})();
