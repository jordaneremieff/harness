(() => {
	const app = window.explorer;
	const { request, model } = app;
	const { el, get, button, icon, iconButton } = app.dom;
	const { lineLabel } = app.references;
	const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
	const bytes = (text: string) => new TextEncoder().encode(text).length;
	const anchorOf = (note: ExplorerLineNote): ExplorerRange | null =>
		note.location === "outdated" ? null : { side: note.side, start: note.start, end: note.end };
	const excerptOf = (note: ExplorerLineNote): ExplorerExcerpt => ({
		path: note.path,
		start: note.anchor.start,
		end: note.anchor.end,
		quote: note.anchor.quote,
		commit: note.anchor.commit,
		text: note.text,
		id: note.id,
		url: note.url,
	});
	const targetLabel = (target: ExplorerNoteTarget): string => {
		switch (target.kind) {
			case "file":
				return target.path;
			case "commit":
				return `Commit ${target.commit.slice(0, 7)}`;
			case "review":
				return "Review";
		}
	};
	const contextOf = (note: ExplorerNote): ExplorerExcerpt =>
		note.target
			? {
					path: targetLabel(note.target),
					commit: note.target.kind === "commit" ? note.target.commit : null,
					id: note.id,
					url: note.url,
					text: note.text,
				}
			: excerptOf(note);
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
		noteId?: string;
		moved: Offset | null;
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
		let noteOffset: Offset | null = null;
		let removeUndo: { notes: ExplorerLineNote[]; root: string } | null = null;
		let cardSerial = 0;
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

		// An unanchored note starts against the right and bottom edges.
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

		function cardWidth(current: Card, main: DOMRect, free: boolean) {
			const limit = current.noteId ? 468 : 426;
			return Math.min(Math.max(main.width - (free ? 0 : 20), 0), limit);
		}

		function reposition() {
			if (!card) return;
			const node = card.node;
			const { body, main } = frame();
			const free = !!card.moved || (!!card.noteId && !card.range);
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
					if (current.noteId) noteOffset = current.moved;
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
				if (current.noteId) noteOffset = null;
				reposition();
			});
		}

		function closeCard(restore = true) {
			const current = card;
			cardSerial++;
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
			if (!card) return false;
			closeCard();
			return true;
		}
		function makeCard(title: string, caption: string, range: ExplorerRange | null, agent = false, noteId?: string) {
			const focus = card?.focus ?? (document.activeElement as HTMLElement | null);
			closeCard(false);
			const node = el("section", `float-card${agent ? " agent-card" : ""}${noteId ? " note-card" : ""}`);
			node.setAttribute("role", "dialog");
			node.setAttribute("aria-label", title);
			const header = el("div", "ask-head");
			const identity = el("div");
			identity.append(el("strong", "", title));
			if (caption) identity.append(el("small", "", caption));
			const tools = el("div", "card-tools");
			tools.append(iconButton("close", "Close (Esc)", () => closeCard()));
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
				noteId,
				moved: noteId ? noteOffset : null,
			};
			card = next;
			container.append(node);
			draggable(next);
			ctx.highlight(range);
			return next;
		}
		// A card that follows a link elsewhere stays where it is instead of following its old lines.
		function pinCard() {
			if (!card || card.moved || (!card.range && card.noteId) || card.node.parentElement === dock) return;
			const { body, main } = frame();
			const rect = card.node.getBoundingClientRect();
			card.moved = { right: main.right - rect.right, top: rect.top - body.top };
		}
		// Card text as Markdown with links to the locations and commits it names.
		function rich(text: string, path?: string, side: ExplorerSide | null | undefined = null) {
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
			if (!result.note || result.note.target) throw new Error("Explorer did not receive the saved line note.");
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
		function cardTitle(mode: CardMode, draft?: ExplorerLineNote) {
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
		function cardRange(range: ExplorerRange | null, draft?: ExplorerLineNote, retained?: ExplorerCardDraft) {
			const kept = retained?.range ?? range;
			if (kept) return kept;
			return draft ? (anchorOf(draft) ?? undefined) : undefined;
		}
		function storedDraft(
			mode: CardMode,
			text: string,
			item: ExplorerExcerpt,
			range?: ExplorerRange,
			draft?: ExplorerLineNote,
		): ExplorerCardDraft {
			const quote = item.quote !== undefined && bytes(item.quote) <= 32000 ? item.quote : undefined;
			return { mode, text, range, noteId: draft?.id, quote, commit: item.commit };
		}
		// The note record that a sent comment refers to: the edited review comment, or a new one for lines.
		async function recordFor(text: string, item: ExplorerExcerpt, range?: ExplorerRange, draft?: ExplorerLineNote) {
			if (draft) {
				return updateDraft(draft, text);
			}
			return range ? create({ ...item, text }, range.side, "draft") : null;
		}
		async function updateDraft(draft: ExplorerLineNote | undefined, text: string) {
			if (!draft) throw new Error("The comment is not available.");
			const result = await request("notes.write", {
				op: "update",
				id: draft.id,
				text,
				expectedUpdatedAt: draft.updatedAt,
			});
			return result.note && !result.note.target ? result.note : { ...draft, text };
		}
		function checkMessageSize(item: ExplorerExcerpt, text: string) {
			if (bytes(bake([{ ...item, text }])) > 128 * 1024 - 40)
				throw new Error("This message exceeds 128 KB. Select fewer lines.");
		}
		function questionRun(item: ExplorerExcerpt, text: string, saved: ExplorerLineNote | null) {
			const quoted = saved ? excerptOf(saved) : { ...item, text };
			return runFor(bake([quoted]), text, saved ? [saved.id] : [], quoted);
		}
		function draftEditor(
			item: ExplorerExcerpt,
			range: ExplorerRange | null,
			mode: CardMode,
			draft?: ExplorerLineNote,
			retained?: ExplorerCardDraft,
		) {
			const storedRange = cardRange(range, draft, retained);
			const key = draftKey(item.path, storedRange, draft?.id);
			const current = makeCard(cardTitle(mode, draft), label(item), range, false, draft?.id);
			const paintSwitcher = draft && addSwitcher(current, draft.id);
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
				save: (text) => updateDraft(draft, text),
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
				paintSwitcher?.();
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
			const stored = unsaved.get(draftKey(item.path, range));
			if (stored) {
				restore(item.path, { ...stored, mode });
				return;
			}
			draftEditor(item, range, mode);
		}
		function restore(path: string, stored: ExplorerCardDraft) {
			unsaved.set(draftKey(path, stored.range, stored.noteId), stored);
			const note = ctx
				.notes()
				.find((note): note is ExplorerLineNote => !note.target && note.id === stored.noteId && note.state === "draft");
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
		async function remove(notes: ExplorerLineNote[]) {
			const root = here();
			const removed: ExplorerLineNote[] = [];
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
		function restoreUndo(removed: { notes: ExplorerLineNote[]; root: string }) {
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

		function renderDraftList(drafts: ExplorerLineNote[]) {
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
		function trayStampFor(drafts: ExplorerLineNote[], undoVisible: boolean, connected: boolean) {
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
		function trayCount(drafts: ExplorerLineNote[]) {
			const count = ctl(`${drafts.length} comment${drafts.length === 1 ? "" : "s"}`, toggleDraftList, "tray-count");
			count.prepend(icon("list"));
			return count;
		}
		function copyReview() {
			return ctl("Copy review", () => flashCopy(bake(currentDrafts().map(excerptOf))));
		}
		// The send control for the review tray.
		function traySend(drafts: ExplorerLineNote[], connected: boolean) {
			const send = ctl(connected ? senderLabel() : "Send", () => report(sendBatch()), "primary");
			disable(send, !drafts.length || !connected, connected ? undefined : reason());
			return send;
		}
		// Rebuilds the review tray controls from the current draft list.
		function renderTray(drafts: ExplorerLineNote[], undoVisible: boolean, connected: boolean) {
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
			tray.hidden = !ctx.inReview() || (!drafts.length && !undoVisible);
			if (!ctx.inReview()) commands.hidden = true;
			const stamp = trayStampFor(drafts, undoVisible, connected);
			if (trayStamp !== stamp) {
				trayStamp = stamp;
				renderTray(drafts, undoVisible, connected);
			}
			if (card?.noteId && (card.root !== here() || !findNote(card.noteId))) closeCard();
			else card?.rebuild?.();
		}

		function authorName(author: ExplorerAuthor, by?: string) {
			if (author === "remote") return by ?? "Reviewer";
			return author === "agent" ? "Agent" : "You";
		}
		function findNote(id: string) {
			return ctx.notes().find((note) => note.id === id && ctx.shows(note));
		}
		function visibleNotes(notes: ExplorerNote[]) {
			return notes.flatMap(({ id }) => {
				const note = findNote(id);
				return note ? [note] : [];
			});
		}
		function thread(notes: ExplorerNote[], position?: ExplorerRange | null) {
			const visible = visibleNotes(notes);
			if (!visible.length) return;
			const active = visible.findIndex(({ id }) => id === card?.noteId);
			if (visible.length === 1 && active === 0) return closeCard();
			openNote(visible[(active + 1) % visible.length], position);
		}
		function openNote(note: ExplorerNote, position?: ExplorerRange | null) {
			const range = position === undefined ? shownRange(note) : position;
			if (!note.target && note.author === "operator" && note.state === "draft") {
				const stored = unsaved.get(draftKey(note.path, anchorOf(note), note.id));
				draftEditor(excerptOf(note), range, "comment", note, stored);
				return;
			}
			noteCard(note, range);
		}
		function shownRange(note: ExplorerNote): ExplorerRange | null {
			if (note.target) return null;
			for (const spot of [anchorOf(note), { side: note.side, start: note.anchor.start, end: note.anchor.end }]) {
				if (!spot) continue;
				const shown = ctx.excerpt(spot);
				if (shown?.path === note.path && shown.quote === note.anchor.quote) return spot;
			}
			return null;
		}
		function sequenceAt(id: string) {
			const notes = ctx.sequence();
			return { notes, index: notes.findIndex((note) => note.id === id) };
		}
		function step(direction: number) {
			if (!card?.noteId) return false;
			const { notes, index } = sequenceAt(card.noteId);
			if (index < 0 || notes.length < 2) return false;
			const next = notes[index + direction];
			if (next) report(switchNote(next));
			return true;
		}
		async function switchNote(note: ExplorerNote) {
			const serial = ++cardSerial;
			const range = await ctx.go(note);
			if (serial !== cardSerial) return;
			const latest = findNote(note.id);
			if (latest) openNote(latest, range);
		}
		function addSwitcher(current: Card, id: string) {
			const box = el("div", "note-switcher");
			const count = el("span", "note-position");
			const prev = button("←", () => step(-1), "note-arrow");
			const next = button("→", () => step(1), "note-arrow");
			prev.title = "Previous note (←)";
			next.title = "Next note (→)";
			prev.setAttribute("aria-label", "Previous note");
			next.setAttribute("aria-label", "Next note");
			box.append(prev, count, next);
			current.tools.prepend(box);
			return () => {
				const { notes, index } = sequenceAt(id);
				box.hidden = index < 0 || notes.length < 2;
				count.textContent = `${index + 1} of ${notes.length}`;
				prev.disabled = index <= 0;
				next.disabled = index >= notes.length - 1;
			};
		}
		function follow(target: ExplorerRichTarget, side: ExplorerSide | null | undefined = null) {
			if (target.kind !== "url") pinCard();
			report(ctx.follow(target, side ?? null));
		}
		function fileChip(path: string, open: () => void) {
			const chip = button("", open, "place-chip place-file");
			const slash = path.lastIndexOf("/");
			chip.append(icon("file"));
			if (slash >= 0) chip.append(el("span", "place-dir", `\u200e${path.slice(0, slash + 1)}\u200e`));
			chip.append(el("span", "place-name", path.slice(slash + 1)));
			chip.title = `Go to ${path}`;
			return chip;
		}
		function commitChip(commit: string) {
			const chip = button(commit.slice(0, 7), () => follow({ kind: "commit", commit }), "place-chip place-commit");
			chip.title = `Review commit ${commit}`;
			return chip;
		}
		function lineChips(place: HTMLElement, note: ExplorerLineNote, range: ExplorerRange | null) {
			const { path, side } = note;
			const { start, end } = range ?? note.anchor;
			const lines = () => follow({ kind: "lines", path, start, end }, side);
			place.append(
				fileChip(path, lines),
				button(`${side === "base" ? "Old " : ""}${lineLabel(start, end)}`, lines, "place-chip place-lines"),
			);
			if (note.anchor.commit) place.append(commitChip(note.anchor.commit));
			if (!range && note.location === "outdated") place.append(el("span", "place-chip place-warn", "Outdated"));
		}
		function targetChip(note: ExplorerTargetNote) {
			const { target } = note;
			switch (target.kind) {
				case "commit":
					return commitChip(target.commit);
				case "file":
					return fileChip(target.path, () => follow({ kind: "file", path: target.path }, target.side));
				case "review": {
					const review = target.review;
					if (review.kind === "commit") return commitChip(review.commit);
					if (review.kind !== "range") return el("span", "place-chip", "Working tree review");
					const { base, head } = review;
					const chip = button(
						`${base.slice(0, 7)}..${head.slice(0, 7)}`,
						() => follow({ kind: "range", base, head }),
						"place-chip place-commit",
					);
					chip.title = `Review ${base}..${head}`;
					return chip;
				}
			}
		}
		function notePlace(note: ExplorerNote, range: ExplorerRange | null) {
			const place = el("div", "note-place");
			if (note.target) place.append(targetChip(note));
			else lineChips(place, note, range);
			if (note.url) {
				const url = note.url;
				const link = button("Source", () => follow({ kind: "url", url }), "place-chip place-url");
				link.prepend(icon("external"));
				link.title = url;
				place.append(link);
			}
			return place;
		}
		function notePath(note: ExplorerNote) {
			return note.target ? (note.target.kind === "file" ? note.target.path : undefined) : note.path;
		}
		function noteSide(note: ExplorerNote) {
			return note.target ? (note.target.kind === "file" ? note.target.side : undefined) : note.side;
		}
		function noteBody(note: ExplorerNote, range: ExplorerRange | null) {
			const block = el("div", "thread-entry");
			const path = notePath(note);
			const side = noteSide(note);
			block.append(notePlace(note, range), rich(note.text, path, side));
			if (!note.target && (note.location === "moved" || (note.location === "outdated" && !range)))
				drawQuote(block, note.anchor.quote);
			for (const reply of note.thread) {
				const response = el("div", `thread-reply by-${reply.author}`);
				response.append(el("strong", "", authorName(reply.author, reply.by)), rich(reply.text, path, side));
				block.append(response);
			}
			return block;
		}
		function noteTitle(note: ExplorerNote) {
			return note.title ?? (note.author === "remote" ? "Discussion" : "Note");
		}
		function noteCard(note: ExplorerNote, range: ExplorerRange | null) {
			const current = makeCard(noteTitle(note), "", range, note.author === "agent", note.id);
			current.node.classList.toggle("remote-card", note.author === "remote");
			const switcher = addSwitcher(current, note.id);
			const entries = el("div", "thread-entries");
			const replyField = textarea("Write a reply…");
			replyField.hidden = true;
			const confirm = el("div", "card-confirm");
			confirm.hidden = true;
			const fail = errorField();
			let latest = note;
			let editing = false;
			let stamp = "";
			const relevant = () => current.root === here() && card === current;
			const write = (fn: () => Promise<void>) => {
				if (!relevant()) return;
				announce(fail, "");
				report(
					fn().catch((error) => {
						announce(fail, message(error));
						reposition();
					}),
				);
			};
			const replyLabel = () => (ctx.live().connected ? "Send reply" : "Save reply");
			const reply = ctl(
				"Reply",
				() => {
					if (!replyField.hidden) return write(saveReply);
					replyField.hidden = false;
					reply.textContent = replyLabel();
					reposition();
					replyField.focus({ preventScroll: true });
				},
				"primary",
			);
			async function saveReply() {
				const text = replyField.value.trim();
				if (!text || replyField.readOnly) return;
				replyField.readOnly = true;
				try {
					await request("notes.write", { op: "reply", id: note.id, text, author: "operator" });
					replyField.value = "";
					replyField.hidden = true;
					await ctx.refresh();
					if (!ctx.live().connected || !relevant()) return ctx.notice("Reply saved in the note");
					const item = { ...contextOf(latest), text };
					const run = runFor(bake([item]), text, [], item);
					run.ids = [note.id];
					showRun(run, range);
					await send(run);
				} finally {
					replyField.readOnly = false;
				}
			}
			const state = ctl(
				"Resolve",
				() =>
					write(async () => {
						await request("notes.write", {
							op: "state",
							ids: [note.id],
							state: latest.state === "resolved" ? "open" : "resolved",
						});
						await ctx.refresh();
					}),
				"quiet",
			);
			const adopt = ctl(
				"Comment",
				() => {
					if (!latest.target) adoptNote(current, latest, range);
				},
				"secondary",
			);
			function endEdit() {
				editing = false;
				stamp = "";
				current.rebuild?.();
			}
			function startEdit() {
				if (editing) return;
				editing = true;
				editNoteForm(current, entries, latest, write, endEdit);
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
							write(async () => {
								await request("notes.write", { op: "delete", id: note.id });
								if (relevant()) closeCard();
								await ctx.refresh();
								ctx.notice("Note deleted");
							}),
						"quiet danger",
					),
				);
				confirm.hidden = false;
				reposition();
			}
			const edit = iconButton("edit", "Edit note", startEdit);
			edit.hidden = note.author === "remote";
			current.tools.prepend(edit, iconButton("trash", "Delete note", askDelete));
			current.content.append(entries, replyField, confirm, fail);
			shortcuts(replyField, () => write(saveReply));
			function paintBody() {
				const title = noteTitle(latest);
				current.node.setAttribute("aria-label", title);
				const caption = `${authorName(latest.author, latest.by)} · ${latest.state}`;
				current.identity.replaceChildren(el("strong", "", title), el("small", "", caption));
				entries.replaceChildren(noteBody(latest, range));
				state.textContent = latest.state === "resolved" ? "Reopen" : "Resolve";
				current.actions.replaceChildren(state, adopt, reply);
			}
			current.rebuild = () => {
				latest = findNote(note.id) ?? latest;
				switcher();
				if (editing) return;
				const value = JSON.stringify(latest);
				if (value !== stamp) {
					stamp = value;
					paintBody();
				}
				adopt.hidden = !ctx.inReview() || !!latest.target || latest.author === "operator";
				reply.textContent = replyField.hidden ? "Reply" : replyLabel();
				reposition();
			};
			current.rebuild();
		}
		function editNoteForm(
			current: Card,
			entries: HTMLElement,
			note: ExplorerNote,
			write: (fn: () => Promise<void>) => void,
			end: () => void,
		) {
			const title = el("input", "note-title-input");
			title.value = note.title ?? "";
			title.placeholder = "Note title (optional)";
			title.setAttribute("aria-label", "Note title");
			title.maxLength = 200;
			const field = textarea("Write a note…", note.text);
			field.maxLength = 16000;
			const save = ctl(
				"Save",
				() =>
					write(async () => {
						const text = field.value.trim();
						if (!text || save.disabled) return;
						save.disabled = true;
						try {
							await request("notes.write", {
								op: "update",
								id: note.id,
								text,
								title: title.value.trim() || null,
								expectedUpdatedAt: note.updatedAt,
							});
							await ctx.refresh();
							end();
						} finally {
							save.disabled = false;
						}
					}),
				"primary",
			);
			shortcuts(field, () => save.click());
			entries.replaceChildren(title, field);
			current.actions.replaceChildren(ctl("Cancel", end), save);
			reposition();
			field.focus({ preventScroll: true });
		}
		function adoptNote(current: Card, note: ExplorerLineNote, range: ExplorerRange | null) {
			const item = (range && ctx.excerpt(range)) || excerptOf(note);
			const field = textarea("Write a review comment…", note.text);
			field.maxLength = 16000;
			const box = el("div", "note-comment");
			const fail = errorField();
			box.append(el("p", "note-comment-label", "Review comment"), field, fail);
			current.content.append(box);
			const rebuild = current.rebuild;
			current.rebuild = undefined;
			const cancel = () => {
				if (card !== current) return;
				box.remove();
				current.rebuild = rebuild;
				current.rebuild?.();
			};
			const add = ctl("Add to review", () => report(save()), "primary");
			current.actions.replaceChildren(ctl("Cancel", cancel), add);
			async function save() {
				const text = field.value.trim();
				if (add.disabled || !text || current.root !== here()) return;
				add.disabled = true;
				try {
					await create({ ...item, text }, range?.side ?? note.side, "draft");
					await ctx.refresh();
					ctx.notice("Comment added to review");
					if (card === current) openNote(findNote(note.id) ?? note, range);
				} catch (error) {
					announce(fail, message(error));
					add.disabled = false;
					reposition();
				}
			}
			shortcuts(field, () => report(save()));
			reposition();
			field.focus({ preventScroll: true });
		}
		return {
			ask,
			restore,
			thread,
			step,
			refresh,
			prompt,
			reposition,
			escape: dismiss,
			range: () => card?.range ?? null,
		};
	};
})();
