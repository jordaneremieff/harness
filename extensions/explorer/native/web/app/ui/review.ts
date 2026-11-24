(() => {
	const app = window.explorer;
	const { request, model } = app;
	const { el, get, button, icon, iconButton } = app.dom;
	const { lineLabel } = app.references;
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
		url: note.url,
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
	type CardMode = "ask" | "comment" | "note";
	type DraftAction = "keep" | "add" | "send" | "save" | "remove";
	// Distance of a moved card from the right edge of the pane and the top of the code viewport.
	type Offset = { right: number; top: number };
	type Card = {
		node: HTMLElement;
		head: HTMLElement;
		identity: HTMLElement;
		content: HTMLElement;
		actions: HTMLElement;
		tools: HTMLElement;
		range: ExplorerRange | null;
		root: string;
		focus: HTMLElement | null;
		kind: "card" | "tour";
		moved: Offset | null;
		rebuild?: () => void;
	};
	type Walk = { tour: ExplorerTour; index: number; serial: number; contents: boolean };

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
		let walkthrough: Walk | null = null;
		// Where the operator moved the walkthrough card; later stops keep it there.
		let tourOffset: Offset | null = null;
		let removeUndo: { notes: ExplorerNote[]; root: string } | null = null;
		let tourSerial = 0;
		let lastOpened: { key: string; index: number } | null = null;
		let trayStamp = "";
		const report = (promise: Promise<unknown>) => {
			void promise.catch((error) => ctx.notice(message(error)));
		};
		const here = () => ctx.root().path;
		const rangeKey = (range?: ExplorerRange | null) => (range ? `${range.side}:${range.start}-${range.end}` : "file");
		// Unsent card text belongs to its exact lines, or to the review comment it edits.
		const draftKey = (path: string, range?: ExplorerRange | null, noteId?: string) =>
			noteId ? `${here()}\0note\0${noteId}` : `${here()}\0${path}\0${rangeKey(range)}`;
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

		function frame() {
			return { body: codeBody.getBoundingClientRect(), main: get("main").getBoundingClientRect() };
		}

		// Places a card at viewport coordinates inside the pane and the code viewport, and marks the edges it touches.
		function placeAt(node: HTMLElement, left: number, top: number, body: DOMRect, main: DOMRect) {
			const width = node.offsetWidth,
				height = node.offsetHeight;
			const x = Math.max(main.left, Math.min(left, main.right - width));
			const y = Math.max(body.top, Math.min(top, body.bottom - height));
			node.style.left = `${x}px`;
			node.style.top = `${y}px`;
			node.classList.toggle("edge-right", x + width >= main.right - 0.5);
			node.classList.toggle("edge-bottom", y + height >= body.bottom - 0.5);
			return { x, y };
		}

		// A walkthrough card starts against the right and bottom edges; a moved card keeps its offset.
		function placeFree(current: Card, body: DOMRect, main: DOMRect) {
			const node = current.node;
			dock.hidden = true;
			node.style.maxHeight = `${Math.max(120, Math.min(560, body.height))}px`;
			const width = node.offsetWidth,
				height = node.offsetHeight;
			if (current.moved)
				placeAt(node, main.right - current.moved.right - width, body.top + current.moved.top, body, main);
			else placeAt(node, main.right - width, body.bottom - height, body, main);
		}

		// A walkthrough card is wider and may touch the pane edge; other cards keep a margin.
		function cardWidth(current: Card, main: DOMRect, free: boolean) {
			const limit = current.kind === "tour" ? 468 : 426;
			return Math.min(Math.max(main.width - (free ? 0 : 20), 0), limit);
		}

		function reposition() {
			if (!card) return;
			const node = card.node;
			const { body, main } = frame();
			const free = card.kind === "tour" || !!card.moved;
			const width = cardWidth(card, main, free);
			node.style.width = `${width}px`;
			if (!container.contains(node)) container.append(node);
			node.classList.remove("docked");
			if (free) return placeFree(card, body, main);
			node.classList.remove("edge-right", "edge-bottom");
			node.style.left = `${Math.max(main.left + 10, main.right - width - 12)}px`;
			node.style.maxHeight = `${cardLimit(body)}px`;
			const anchor = ctx.bounds(card.range);
			attachCard(node, body, anchor, Math.min(node.scrollHeight + 2, cardLimit(body)));
		}
		const cardResize = new ResizeObserver(() => {
			if (card && card.node.parentElement !== dock) reposition();
		});
		cardResize.observe(codeBody);

		// Dragging the header moves the card; a double-click returns it to its default place.
		function draggable(current: Card) {
			const handle = current.head;
			handle.classList.add("drag-handle");
			const interactive = (target: EventTarget | null) =>
				target instanceof Element && !!target.closest("button, a, input, textarea, select");
			handle.addEventListener("pointerdown", (event) => {
				if (event.button !== 0 || interactive(event.target)) return;
				event.preventDefault();
				const node = current.node;
				const rect = node.getBoundingClientRect();
				const grab = { x: event.clientX - rect.left, y: event.clientY - rect.top };
				if (node.parentElement === dock) {
					container.append(node);
					dock.hidden = true;
				}
				node.classList.remove("docked");
				node.classList.add("dragging");
				try {
					handle.setPointerCapture(event.pointerId);
				} catch {
					// A pointer that the page cannot capture still moves the card while it stays over the header.
				}
				const move = (next: PointerEvent) => {
					const { body, main } = frame();
					const { x, y } = placeAt(node, next.clientX - grab.x, next.clientY - grab.y, body, main);
					current.moved = { right: main.right - (x + node.offsetWidth), top: y - body.top };
					if (current.kind === "tour") tourOffset = current.moved;
				};
				const end = () => {
					node.classList.remove("dragging");
					handle.removeEventListener("pointermove", move);
					handle.removeEventListener("pointerup", end);
					handle.removeEventListener("pointercancel", end);
				};
				handle.addEventListener("pointermove", move);
				handle.addEventListener("pointerup", end);
				handle.addEventListener("pointercancel", end);
			});
			handle.addEventListener("dblclick", (event) => {
				if (interactive(event.target)) return;
				current.moved = null;
				if (current.kind === "tour") tourOffset = null;
				reposition();
			});
		}

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
		function makeCard(
			title: string,
			caption: string,
			range: ExplorerRange | null,
			agent = false,
			kind: Card["kind"] = "card",
		) {
			const focus = card?.focus ?? (document.activeElement as HTMLElement | null);
			closeCard(false);
			const node = el("section", `float-card${agent ? " agent-card" : ""}${kind === "tour" ? " tour-card" : ""}`);
			node.setAttribute("role", "dialog");
			node.setAttribute("aria-label", title);
			const header = el("div", "ask-head");
			const identity = el("div");
			identity.append(el("strong", "", title));
			if (caption) identity.append(el("small", "", caption));
			const tools = el("div", "card-tools");
			tools.append(
				iconButton("close", "Close (Esc)", () => {
					walkthrough = null;
					tourSerial++;
					closeCard();
				}),
			);
			header.append(identity, tools);
			const content = el("div", "card-content"),
				actions = el("div", "card-actions");
			node.append(header, content, actions);
			const next: Card = {
				node,
				head: header,
				identity,
				content,
				actions,
				tools,
				range,
				root: here(),
				focus,
				kind,
				moved: kind === "tour" ? tourOffset : null,
			};
			card = next;
			container.append(node);
			draggable(next);
			ctx.highlight(range);
			return next;
		}
		// A card that follows a link elsewhere stays where it is instead of following its old lines.
		function pinCard() {
			if (!card || card.moved || card.kind === "tour" || card.node.parentElement === dock) return;
			const { body, main } = frame();
			const rect = card.node.getBoundingClientRect();
			card.moved = { right: main.right - rect.right, top: rect.top - body.top };
		}
		// Card text as Markdown with links to the locations and commits it names.
		function rich(text: string, path?: string, side: ExplorerSide | null = null) {
			return app.rich.render(text, {
				path,
				open: (target) => {
					if (target.kind !== "url") pinCard();
					// Lines of the note's own file keep its side; other files open their current text.
					report(ctx.follow(target, target.kind === "lines" && target.path === path ? side : null));
				},
				changed: reposition,
			});
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
			let shownAnswer = "";
			current.rebuild = () => {
				progress.textContent = runMessage(run);
				progress.classList.toggle("card-error", failedRun(run));
				answer.hidden = run.last?.status !== "answer";
				const latest = answerText(run);
				if (latest !== shownAnswer) {
					shownAnswer = latest;
					answer.replaceChildren(latest ? rich(latest, run.item?.path) : "");
				}
				const ready = run.admission === "accepted";
				follow.hidden = submit.hidden = !ready;
				retry.hidden = !run.retryable;
				disableRunControls();
				reposition();
			};
			current.rebuild();
		}

		// The card title for each edit mode.
		function cardTitle(mode: CardMode, draft?: ExplorerNote) {
			if (draft || mode === "comment") return "Review comment";
			return mode === "note" ? "New note" : "Ask about this";
		}
		const placeholders: Record<CardMode, string> = {
			ask: "Ask about this code…",
			note: "Write a note…",
			comment: "Write a review comment…",
		};
		// The one action that the filled button on the right and Command-Return perform.
		function primaryAction(mode: CardMode, draft: boolean, lines: boolean): DraftAction {
			if (draft) return "save";
			if (mode !== "ask") return mode === "note" ? "keep" : "add";
			return ctx.live().connected || !lines ? "send" : "keep";
		}
		// The quieter actions shown to the left of the primary one.
		function secondaryActions(mode: CardMode, draft: boolean, lines: boolean, lead: DraftAction): DraftAction[] {
			if (draft) return ["remove", "send"];
			if (mode === "note") return [];
			if (mode === "comment") return ["keep", "send"];
			if (lead !== "send") return ["add"];
			return lines ? ["keep", "add"] : [];
		}
		function actionLabels(mode: CardMode, draft: boolean): Record<DraftAction, string> {
			return {
				keep: mode === "note" ? "Save note" : "Keep as note",
				add: "Add to review",
				send: draft || mode === "comment" ? "Send now" : "Send",
				save: "Save",
				remove: "Remove",
			};
		}
		const doneNotices: Record<DraftAction, string> = {
			keep: "Note saved",
			add: "Comment added to review",
			save: "Comment updated",
			remove: "Comment removed",
			send: "",
		};
		function cardRange(range: ExplorerRange | null, draft?: ExplorerNote, retained?: ExplorerCardDraft) {
			const kept = retained?.range ?? range;
			if (kept) return kept;
			return draft ? (anchorOf(draft) ?? undefined) : undefined;
		}
		function storedDraft(
			mode: CardMode,
			text: string,
			item: ExplorerExcerpt,
			range?: ExplorerRange,
			draft?: ExplorerNote,
		): ExplorerCardDraft {
			const quote = item.quote !== undefined && bytes(item.quote) <= 32000 ? item.quote : undefined;
			return { mode, text, range, noteId: draft?.id, quote, commit: item.commit };
		}
		// The note record that a sent comment refers to: the edited review comment, or a new one for lines.
		async function recordFor(text: string, item: ExplorerExcerpt, range?: ExplorerRange, draft?: ExplorerNote) {
			if (draft) {
				const result = await request("notes.write", { op: "update", id: draft.id, text });
				return result.note ?? { ...draft, text };
			}
			return range ? create({ ...item, text }, range.side, "draft") : null;
		}
		function checkMessageSize(item: ExplorerExcerpt, text: string) {
			if (bytes(bake([{ ...item, text }])) > 128 * 1024 - 40)
				throw new Error("This message exceeds 128 KB. Select fewer lines.");
		}
		function questionRun(item: ExplorerExcerpt, text: string, saved: ExplorerNote | null) {
			const quoted = saved ? excerptOf(saved) : { ...item, text };
			return runFor(bake([quoted]), text, saved ? [saved.id] : [], quoted);
		}
		function draftEditor(
			item: ExplorerExcerpt,
			range: ExplorerRange | null,
			mode: CardMode,
			draft?: ExplorerNote,
			retained?: ExplorerCardDraft,
		) {
			const storedRange = cardRange(range, draft, retained);
			const key = draftKey(item.path, storedRange, draft?.id);
			const current = makeCard(cardTitle(mode, draft), label(item), range);
			const field = textarea(placeholders[mode], retained?.text ?? draft?.text);
			field.maxLength = 16000;
			const fail = errorField();
			const hint = el("p", "shortcut-hint");
			const lead = primaryAction(mode, !!draft, !!storedRange);
			const labels = actionLabels(mode, !!draft);
			const controls = new Map<DraftAction, HTMLButtonElement>();
			let busy = false;
			function clearDraft() {
				unsaved.delete(key);
				report(ctx.saveDraft(item.path, null));
			}
			function saveDraft() {
				if (!field.value || field.value === draft?.text) return clearDraft();
				const data = storedDraft(mode, field.value, item, storedRange, draft);
				unsaved.set(key, data);
				report(ctx.saveDraft(item.path, data));
			}
			async function sendCardText(text: string) {
				checkMessageSize(item, text);
				const saved = await recordFor(text, item, storedRange, draft);
				if (current.root !== here()) return;
				const run = questionRun(item, text, saved);
				clearDraft();
				if (card === current) showRun(run, range);
				await send(run);
			}
			const writers: Record<Exclude<DraftAction, "send">, (text: string) => Promise<unknown>> = {
				keep: (text) => create({ ...item, text }, storedRange?.side ?? "head", "open"),
				add: (text) => create({ ...item, text }, storedRange?.side ?? "head", "draft"),
				save: (text) => request("notes.write", { op: "update", id: draft?.id ?? "", text }),
				remove: () => remove(draft ? [draft] : []),
			};
			async function applyAction(action: DraftAction, text: string) {
				if (action === "send") return sendCardText(text);
				await writers[action](text);
				await ctx.refresh();
				if (current.root !== here()) return;
				clearDraft();
				if (card === current) closeCard();
				ctx.notice(doneNotices[action]);
			}
			// Removing needs no text; every other action needs some.
			function refused(action: DraftAction) {
				return busy || current.root !== here() || (action !== "remove" && !field.value.trim());
			}
			async function write(action: DraftAction) {
				if (refused(action)) return;
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
			function addControl(action: DraftAction, style: string) {
				const node = ctl(labels[action], () => report(write(action)), style);
				controls.set(action, node);
				current.actions.append(node);
			}
			for (const action of secondaryActions(mode, !!draft, !!storedRange, lead))
				addControl(action, action === "remove" ? "quiet danger" : "quiet");
			addControl(lead, "primary");
			// Sending needs a live conversation; a secondary send hides without one.
			function paintControl(action: DraftAction, node: HTMLButtonElement, connected: boolean) {
				const offline = action === "send" && !connected;
				node.hidden = offline && action !== lead;
				disable(node, refused(action) || offline, offline ? reason() : undefined);
			}
			function update() {
				const connected = ctx.live().connected;
				for (const [action, node] of controls) paintControl(action, node, connected);
				hint.textContent = lead === "send" && !connected ? reason() : `cmd+return ${labels[lead]}`;
				reposition();
			}
			field.oninput = () => {
				saveDraft();
				update();
			};
			shortcuts(field, () => {
				if (controls.get(lead)?.disabled === false) report(write(lead));
			});
			drawQuote(current.content, item.quote);
			current.content.append(field, hint, fail);
			current.rebuild = update;
			update();
			field.focus({ preventScroll: true });
		}
		function ask(range: ExplorerRange | null, mode: CardMode = "ask") {
			const item = ctx.excerpt(range);
			if (!item) return;
			walkthrough = null;
			tourSerial++;
			const stored = unsaved.get(draftKey(item.path, range));
			if (stored) {
				restore(item.path, { ...stored, mode });
				return;
			}
			draftEditor(item, range, mode);
		}
		function restore(path: string, stored: ExplorerCardDraft) {
			unsaved.set(draftKey(path, stored.range, stored.noteId), stored);
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
			if (drafts.length) tray.append(copyReview());
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

		function authorName(author: ExplorerAuthor, by?: string) {
			if (author === "remote") return by ?? "Reviewer";
			return author === "agent" ? "Agent" : "You";
		}
		// A card shown on lines that hold the note's quote, such as a review's head, is not outdated there.
		function movedSuffix(note: ExplorerNote, shown: boolean) {
			if (note.location === "outdated") return shown ? "" : " · Outdated";
			if (note.location === "moved") return ` · Moved from L${note.movedFrom ?? note.anchor.start}`;
			return "";
		}
		function appendReplies(block: HTMLElement, note: ExplorerNote) {
			for (const reply of note.thread) {
				const response = el("div", `thread-reply by-${reply.author}`);
				response.append(el("strong", "", authorName(reply.author, reply.by)), rich(reply.text, note.path, note.side));
				block.append(response);
			}
		}
		// One note and its replies as a thread entry block.
		function threadEntry(note: ExplorerNote, shown: boolean) {
			const block = el("div", "thread-entry");
			block.append(
				el("p", "thread-meta", `${authorName(note.author, note.by)} · ${note.state}${movedSuffix(note, shown)}`),
				rich(note.text, note.path, note.side),
			);
			if (note.location === "moved" || (note.location === "outdated" && !shown)) drawQuote(block, note.anchor.quote);
			appendReplies(block, note);
			return block;
		}
		const isDraft = (note: ExplorerNote) => note.state === "draft" && note.author === "operator";
		// Each review comment opens alone in its editor; the other notes open together.
		function noteGroups(notes: ExplorerNote[]) {
			const others = notes.filter((note) => !isDraft(note));
			const groups = notes.filter(isDraft).map((note) => [note]);
			return others.length ? [...groups, others] : groups;
		}
		// Opening the same notes again while their card is open shows the next group.
		function groupIndex(key: string, count: number) {
			return card && lastOpened?.key === key ? (lastOpened.index + 1) % count : 0;
		}
		function thread(notes: ExplorerNote[], position?: ExplorerRange | null) {
			const fresh = currentNotes(notes);
			const groups = noteGroups(fresh);
			if (!groups.length) return;
			const key = fresh
				.map((note) => note.id)
				.sort()
				.join(",");
			const index = groupIndex(key, groups.length);
			const [first] = groups[index];
			walkthrough = null;
			tourSerial++;
			if (isDraft(first)) editComment(first, position === undefined ? anchorOf(first) : position);
			else threadCard(groups[index], position);
			lastOpened = { key, index };
		}
		function editComment(note: ExplorerNote, range: ExplorerRange | null) {
			const stored = unsaved.get(draftKey(note.path, anchorOf(note), note.id));
			draftEditor(excerptOf(note), range, "comment", note, stored);
		}
		function currentNotes(notes: ExplorerNote[]) {
			const byId = new Map(ctx.notes().map((note) => [note.id, note]));
			return notes.map((note) => byId.get(note.id) ?? note);
		}
		// The note's lines in the open view, including the original lines of a note the view still quotes.
		function shownRange(note: ExplorerNote) {
			const own = anchorOf(note);
			if (own) return own;
			const range = { side: note.side, start: note.anchor.start, end: note.anchor.end };
			const shown = ctx.excerpt(range);
			return shown?.path === note.path && shown.quote === note.anchor.quote ? range : null;
		}
		function threadTitle(notes: ExplorerNote[]) {
			if (notes.length > 1) return `${notes.length} notes`;
			return notes[0].author === "remote" ? "Discussion" : "Note";
		}
		function threadCard(notes: ExplorerNote[], position?: ExplorerRange | null) {
			const first = notes[0];
			const range = position === undefined ? shownRange(first) : position;
			const current = makeCard(
				first.title ?? threadTitle(notes),
				label(excerptOf(first)),
				range,
				first.author === "agent",
			);
			if (first.author === "remote") current.node.classList.add("remote-card");
			const own = () => {
				const latest = currentNotes([first])[0];
				return latest.author === "operator" && (latest.state === "draft" || latest.state === "open");
			};
			const entries = el("div", "thread-entries");
			const field = textarea("Write a reply…");
			field.hidden = true;
			const confirm = el("div", "card-confirm");
			confirm.hidden = true;
			const fail = errorField();
			let locked = false;
			let editing = false;
			let threadStamp = "";
			// A reply reaches the conversation when one is connected; otherwise it stays in the note.
			async function deliverReply(text: string) {
				await request("notes.write", { op: "reply", id: first.id, text, author: "operator" });
				if (field.value.trim() === text) field.value = "";
				await ctx.refresh();
				if (!ctx.live().connected || current.root !== here()) return ctx.notice("Reply saved in the note");
				const item = { ...excerptOf(currentNotes([first])[0]), text };
				const run = runFor(bake([item]), text, [], item);
				run.ids = [first.id];
				if (card === current) showRun(run, range);
				await send(run);
			}
			async function reply() {
				const text = field.value.trim();
				if (locked || !text || current.root !== here()) return;
				locked = true;
				announce(fail, "");
				try {
					await deliverReply(text);
				} catch (error) {
					announce(fail, message(error));
				} finally {
					locked = false;
				}
			}
			const replyLabel = () => (ctx.live().connected ? "Send reply" : "Save reply");
			const answer = ctl(
				"Reply",
				() => {
					if (field.hidden) {
						field.hidden = false;
						answer.textContent = replyLabel();
						reposition();
						field.focus({ preventScroll: true });
					} else report(reply());
				},
				"primary",
			);
			const state = ctl(
				"Resolve",
				() => {
					const latest = currentNotes([first])[0];
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
			// Rewrites the note text in place; only open notes of the operator accept it.
			function startEdit() {
				if (editing || !own()) return;
				editing = true;
				const latest = currentNotes([first])[0];
				const editor = textarea("Write a note…", latest.text);
				const save = ctl(
					"Save",
					() =>
						report(
							(async () => {
								const text = editor.value.trim();
								if (!text || current.root !== here()) return;
								await request("notes.write", { op: "update", id: first.id, text });
								editing = false;
								threadStamp = "";
								await ctx.refresh();
								card?.rebuild?.();
							})().catch((error) => announce(fail, message(error))),
						),
					"primary",
				);
				const cancel = ctl("Cancel", () => {
					editing = false;
					threadStamp = "";
					current.rebuild?.();
				});
				shortcuts(editor, () => save.click());
				entries.replaceChildren(editor);
				current.actions.replaceChildren(cancel, save);
				reposition();
				editor.focus({ preventScroll: true });
			}
			function askDelete() {
				confirm.replaceChildren(
					el("span", "", "Delete this note?"),
					ctl("Cancel", () => {
						confirm.hidden = true;
						reposition();
					}),
					ctl(
						"Delete",
						() =>
							report(
								(async () => {
									await request("notes.write", { op: "delete", id: first.id });
									if (card === current) closeCard();
									await ctx.refresh();
									ctx.notice("Note deleted");
								})().catch((error) => announce(fail, message(error))),
							),
						"quiet danger",
					),
				);
				confirm.hidden = false;
				reposition();
			}
			const editButton = iconButton("edit", "Edit note", startEdit);
			const deleteButton = iconButton("trash", "Delete note", askDelete);
			current.tools.prepend(editButton, deleteButton);
			const remoteUrl = first.url;
			if (remoteUrl)
				current.tools.prepend(
					iconButton("external", "Open the discussion in the browser", () =>
						report(request("link.open", { url: remoteUrl })),
					),
				);
			current.content.append(entries, field, confirm, fail);
			shortcuts(field, () => report(reply()));
			function refreshThreadState(latest: ExplorerNote) {
				state.textContent = latest.state === "resolved" ? "Reopen" : "Resolve";
				state.hidden = latest.state === "draft";
				const single = notes.length === 1 && latest.author !== "agent";
				editButton.hidden = !single || !own();
				deleteButton.hidden = !single;
				if (!field.hidden) answer.textContent = replyLabel();
			}
			current.rebuild = () => {
				if (editing) return;
				const visible = currentNotes(notes);
				const next = JSON.stringify([visible, ctx.live().connected]);
				if (next === threadStamp) return;
				threadStamp = next;
				entries.replaceChildren();
				for (const note of visible) entries.append(threadEntry(note, range !== null));
				current.actions.replaceChildren(state, answer);
				refreshThreadState(visible[0]);
				reposition();
			};
			current.rebuild();
		}
		function firstStop(tour: ExplorerTour) {
			return tour.summary ? -1 : 0;
		}
		function stopNote(tour: ExplorerTour, index: number) {
			return ctx.notes().find((note) => note.id === tour.stops[index]);
		}
		// The walkthrough header: its name, the position, the stop list toggle and a progress bar.
		function tourHead(current: Card, active: Walk) {
			const { tour, index } = active;
			const kicker = el("span", "tour-kicker");
			kicker.append(icon("tour"), el("span", "", "Walkthrough"));
			const name = el("span", "tour-name", tour.title);
			name.title = tour.title;
			current.identity.className = "tour-identity";
			current.identity.replaceChildren(kicker, name);
			const total = tour.stops.length;
			const position = index < 0 ? `${total} stop${total === 1 ? "" : "s"}` : `${index + 1} / ${total}`;
			const tools: HTMLElement[] = [el("span", "tour-count", position)];
			if (index >= 0) tools.push(contentsToggle(active));
			current.tools.prepend(...tools);
			const progress = el("div", "tour-progress");
			const fill = el("span");
			fill.style.width = `${index < 0 ? 0 : ((index + 1) / Math.max(total, 1)) * 100}%`;
			progress.append(fill);
			current.head.after(progress);
		}
		function contentsToggle(active: Walk) {
			const contents = iconButton("list", active.contents ? "Hide the stops" : "Show all stops", () => {
				active.contents = !active.contents;
				report(moveTour(active.index));
			});
			contents.setAttribute("aria-pressed", String(active.contents));
			return contents;
		}
		function stopList(active: Walk) {
			const list = el("ol", "tour-stops");
			for (const [order, id] of active.tour.stops.entries()) {
				const note = ctx.notes().find((item) => item.id === id);
				const open = button("", () => report(moveTour(order)), "tour-stop");
				if (order === active.index) open.setAttribute("aria-current", "step");
				const text = el("span", "tour-stop-text");
				text.append(
					el("strong", "", note?.title ?? note?.text.split("\n")[0] ?? "Unavailable stop"),
					el("small", "", note ? `${note.path} · ${lineLabel(note.start, note.end)}` : "The note is missing."),
				);
				open.append(el("span", "tour-stop-number", String(order + 1)), text);
				open.disabled = !note;
				const item = el("li");
				item.append(open);
				list.append(item);
			}
			return list;
		}
		function followLines(note: ExplorerNote, lines: ExplorerRange) {
			return ctx.follow({ kind: "lines", path: note.path, start: lines.start, end: lines.end }, lines.side);
		}
		// The stop's file, lines and commit as links.
		function stopPlace(note: ExplorerNote, range: ExplorerRange | null) {
			const place = el("div", "stop-place");
			const lines = range ?? { side: note.side, start: note.anchor.start, end: note.anchor.end };
			const file = button("", () => report(followLines(note, lines)), "place-chip place-file");
			const slash = note.path.lastIndexOf("/");
			file.append(icon("file"));
			// Marks keep the folder's trailing slash in place while the folder truncates from the left.
			if (slash >= 0) file.append(el("span", "place-dir", `\u200e${note.path.slice(0, slash + 1)}\u200e`));
			file.append(el("span", "place-name", note.path.slice(slash + 1)));
			file.title = `Go to ${note.path}`;
			const span = button(
				`${lines.side === "base" ? "Old " : ""}${lineLabel(lines.start, lines.end)}`,
				() => report(followLines(note, lines)),
				"place-chip place-lines",
			);
			span.title = `Go to ${lineLabel(lines.start, lines.end)}`;
			place.append(file, span);
			const commit = note.anchor.commit;
			if (commit) {
				const chip = button(
					commit.slice(0, 7),
					() => report(ctx.follow({ kind: "commit", commit }, null)),
					"place-chip place-commit",
				);
				chip.title = `Review commit ${commit}`;
				place.append(chip);
			}
			if (!range) place.append(el("span", "place-chip place-warn", "Outdated"));
			return place;
		}
		function reviewed(note: ExplorerNote, range: ExplorerRange | null) {
			const lines = range ?? anchorOf(note);
			if (!lines) return undefined;
			return ctx
				.drafts()
				.find(
					(draft) =>
						draft.path === note.path &&
						draft.side === lines.side &&
						draft.start === lines.start &&
						draft.end === lines.end,
				);
		}
		function tourNavigation(current: Card, active: Walk) {
			const previous = ctl("Previous", () => report(moveTour(active.index - 1)), "quiet");
			previous.disabled = active.index <= firstStop(active.tour);
			previous.title = "Previous stop (←)";
			const next = ctl("Next", () => report(moveTour(active.index + 1)), "secondary");
			next.disabled = active.index >= active.tour.stops.length - 1;
			next.title = "Next stop (→)";
			current.actions.append(previous, next, el("span", "grow"));
		}
		// Turns the stop into a review comment on the same lines, starting from the stop's text.
		function adoptStop(current: Card, active: Walk, note: ExplorerNote, range: ExplorerRange | null) {
			const item = (range && ctx.excerpt(range)) || excerptOf(note);
			const box = el("div", "stop-comment");
			const field = textarea("Write a review comment…", note.text);
			field.maxLength = 16000;
			const fail = errorField();
			box.append(el("p", "stop-comment-label", "Review comment"), field, fail);
			current.content.append(box);
			let busy = false;
			const add = ctl("Add to review", () => report(save()), "primary");
			const cancel = ctl("Cancel", () => report(moveTour(active.index)), "quiet");
			current.actions.replaceChildren(cancel, el("span", "grow"), add);
			async function save() {
				const text = field.value.trim();
				if (busy || !text || current.root !== here()) return;
				busy = true;
				add.disabled = true;
				try {
					await create({ ...item, text }, range?.side ?? note.side, "draft");
					await ctx.refresh();
					ctx.notice("Comment added to review");
					if (walkthrough === active) await moveTour(active.index);
				} catch (error) {
					announce(fail, message(error));
					busy = false;
					add.disabled = false;
				}
			}
			field.oninput = () => disable(add, busy || !field.value.trim());
			shortcuts(field, () => report(save()));
			reposition();
			field.focus({ preventScroll: true });
			field.setSelectionRange(field.value.length, field.value.length);
		}
		// Sends a reply about the stop to the conversation, or keeps it in the note without one.
		function replyToStop(current: Card, note: ExplorerNote, control: HTMLButtonElement) {
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
			control.replaceWith(ctl("Send reply", sendReply, "agent-button"));
			field.focus({ preventScroll: true });
			reposition();
		}
		function showStop(active: Walk, note: ExplorerNote, range: ExplorerRange | null) {
			const current = makeCard(note.title ?? `Stop ${active.index + 1}`, "", range, true, "tour");
			tourHead(current, active);
			current.content.append(el("h3", "stop-title", note.title ?? `Stop ${active.index + 1}`), stopPlace(note, range));
			current.content.append(rich(note.text, note.path, range?.side ?? note.side));
			if (note.thread.length) {
				const replies = el("div", "stop-replies");
				appendReplies(replies, note);
				current.content.append(replies);
			}
			const adopted = reviewed(note, range);
			if (adopted) current.content.append(el("p", "stop-adopted", "In your review"));
			if (active.contents) current.content.append(stopList(active));
			tourNavigation(current, active);
			const reply = ctl("Reply", () => replyToStop(current, note, reply), "quiet");
			const comment = ctl(
				adopted ? "Comment again" : "Comment",
				() => adoptStop(current, active, note, range),
				"agent-button",
			);
			comment.title = "Add this stop to your review as a comment";
			current.actions.append(reply, comment);
			reposition();
		}
		function showOverview(active: Walk) {
			const { tour } = active;
			const current = makeCard(tour.title, "", null, true, "tour");
			tourHead(current, active);
			current.content.append(el("h3", "stop-title", tour.title));
			const url = tour.url;
			if (url) {
				const place = el("div", "stop-place");
				const link = button("", () => report(request("link.open", { url })), "place-chip place-url");
				link.append(icon("external"), el("span", "", url.replace(/^https?:\/\//u, "")));
				link.title = `Open ${url}`;
				place.append(link);
				current.content.append(place);
			}
			if (tour.summary) current.content.append(rich(tour.summary));
			current.content.append(el("p", "tour-section", "Stops"), stopList(active));
			const start = ctl("Start", () => report(moveTour(0)), "primary");
			start.title = "First stop (→)";
			current.actions.append(el("span", "grow"), start);
			reposition();
		}
		function showMissingStop(active: Walk) {
			const current = makeCard(`Stop ${active.index + 1}`, "", null, true, "tour");
			tourHead(current, active);
			current.content.append(
				el("h3", "stop-title", `Stop ${active.index + 1} is unavailable`),
				el("p", "card-error", "Its note was deleted or could not be read."),
			);
			tourNavigation(current, active);
			reposition();
		}
		// The summary page opens over the first stop's file, so the change is in view.
		async function overview(active: Walk, serial: number) {
			const first = stopNote(active.tour, 0);
			if (first) await ctx.go(first, active.tour);
			if (walkthrough === active && serial === tourSerial) showOverview(active);
		}
		async function moveTour(index: number) {
			const active = walkthrough;
			if (!active || index < firstStop(active.tour) || index >= active.tour.stops.length) return;
			active.index = index;
			const serial = ++tourSerial;
			if (index < 0) return overview(active, serial);
			const note = stopNote(active.tour, index);
			if (!note) return showMissingStop(active);
			const range = await ctx.go(note, active.tour);
			if (walkthrough !== active || serial !== tourSerial) return;
			showStop(active, note, range);
		}
		async function tour(tour: ExplorerTour) {
			walkthrough = { tour, index: firstStop(tour), serial: ++tourSerial, contents: false };
			await moveTour(walkthrough.index);
		}
		function step(direction: number) {
			if (!walkthrough) return false;
			report(moveTour(walkthrough.index + direction));
			return true;
		}
		return {
			ask,
			restore,
			thread,
			tour,
			step,
			refresh,
			prompt,
			reposition,
			escape: dismiss,
			range: () => card?.range ?? null,
		};
	};
})();
