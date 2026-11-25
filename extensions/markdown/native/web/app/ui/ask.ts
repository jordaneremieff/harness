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
		let session = sessions.shown,
			disposed = false,
			localSource = false;
		const receiptJobs = new Set<Promise<void>>();
		// The reason the last send from the open card did not leave the page. The card shows it under
		// the composer until the person types, sends or opens another card.
		let refusal: { thread: ReaderThread; text: string } | null = null;
		function revision() {
			const value = controller.payload?.meta.revision;
			return typeof value === "number" && value > 0 ? value : undefined;
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
		const warnings = new WeakMap<ReaderAskDocument, { text: string; action: { label: string; run(): void } }>();
		const recovering = api.createAskRecovery<ReaderAskDocument>(host, {
			snapshot: sessions.snapshot,
			apply: restorePending,
			warn(owner, text, action) {
				warnings.set(owner, { text, action });
				if (owner === session) showRecoveryWarning(owner);
			},
			clear(owner) {
				warnings.delete(owner);
				if (owner === session) ctx.removeNotice("batch-recovery");
			},
		});
		function unfinishedInput() {
			return disposed || !!controller.compositionTarget || delayedDestinations.length > 0;
		}
		api.flushReviewDrafts = async () => {
			if (unfinishedInput()) return false;
			// A native receipt can put a definitely refused batch back before the window closes.
			do {
				if (!(await recovering.flush())) return false;
				if (!receiptJobs.size) return !unfinishedInput();
				await Promise.allSettled(receiptJobs);
			} while (!disposed);
			return false;
		};
		function showRecoveryWarning(owner: ReaderAskDocument) {
			if (disposed) return;
			const warning = warnings.get(owner);
			if (owner === session && warning) ctx.notice(warning.text, "warn", [warning.action], "batch-recovery");
		}
		function restorePending(owner: ReaderAskDocument, draft?: ReaderReviewDraft) {
			if (disposed) return;
			if (owner.current?.pendingComment) {
				owner.current = null;
				owner.visible = false;
			}
			owner.comments = draft?.comments ?? [];
			owner.overall = draft?.overall ?? "";
			owner.overallRevision = draft?.overallRevision;
			owner.parked = draft?.parked;
			sessions.restoreRanges(owner);
			if (owner === session) {
				syncOverallField();
				ask.refresh();
			}
		}
		function hasPendingPassages(owner: ReaderAskDocument) {
			return owner.comments.length > 0 || (owner.parked?.some((item) => item.comment) ?? false);
		}
		function pendingChanged(owner: ReaderAskDocument) {
			recovering.changed(owner);
		}
		function hasPendingBatch() {
			return session.comments.length > 0 || hasText(session.overall);
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
		type Parked = ReaderParkedComment;
		const privateClosed = new WeakMap<ReaderThread, Set<number>>();
		let collection: ReaderCommentState = "open",
			inspected: ReaderReviewComment | Parked | null = null;
		const saved = api.createReviewCollection(
			host,
			() => {
				const payload = controller.payload;
				return payload?.live && typeof payload.meta.documentKey === "string" ? payload.meta.documentKey : null;
			},
			() => {
				if (saved.readState === "failed")
					ctx.notice("The reader could not refresh saved comments.", "warn", [], "saved-comments-read");
				else ctx.removeNotice("saved-comments-read");
				refreshReview();
			},
			(text) => ctx.notice(text, "warn"),
		);
		function parkedItems() {
			session.parked ??= [];
			return session.parked;
		}
		function park(comment?: ReaderComment) {
			if (!comment) return parkOverallDraft();
			const index = session.comments.indexOf(comment);
			if (index < 0) return;
			parkedItems().push({ comment, text: comment.text, index });
			session.comments.splice(index, 1);
			if (session.current?.pendingComment === comment) {
				session.current = null;
				session.visible = false;
			}
			pendingChanged(session);
			ask.refresh();
		}
		function parkOverallDraft() {
			const text = session.overall;
			if (!hasText(text)) return;
			parkedItems().push({ text, index: -1, authoredRevision: session.overallRevision });
			setOverall("");
			pendingChanged(session);
			ask.refresh();
		}
		function restoreParked(item: Parked) {
			if (!item.comment) {
				if (session.overall) return "Close or remove the current overall comment before reopening this one.";
				session.overall = item.text;
				session.overallRevision = item.authoredRevision;
				return;
			}
			if (session.comments.length >= batchLimit) return "The batch is full. Make room before reopening this comment.";
			session.comments.splice(Math.min(item.index, session.comments.length), 0, item.comment);
		}
		function unpark(item: Parked) {
			const items = parkedItems(),
				i = items.indexOf(item);
			if (i < 0) return;
			const problem = restoreParked(item);
			if (problem) return ctx.notice(problem, "warn");
			items.splice(i, 1);
			inspected = null;
			pendingChanged(session);
			ask.refresh();
		}
		function savedRow(thread: ReaderThread, ordinal: number) {
			return saved.rows.get(`${thread.threadId.toLowerCase()}:${ordinal}`);
		}
		function closed(thread: ReaderThread, ordinal: number) {
			const row = savedRow(thread, ordinal);
			return row ? row.commentState === "closed" : !!privateClosed.get(thread)?.has(ordinal);
		}
		function toggleLocal(thread: ReaderThread, ordinal: number) {
			const set = privateClosed.get(thread) ?? new Set<number>();
			privateClosed.set(thread, set);
			if (!set.delete(ordinal)) {
				set.add(ordinal);
				if (!thread.messages.length && session.current === thread) {
					session.visible = false;
					session.current = null;
				}
			}
			refreshReview();
			if (!thread.messages.length) draw();
		}
		function unavailableReason(thread: ReaderThread, row?: ReaderReviewComment) {
			if (pending(thread)) return "Wait for delivery confirmation.";
			if (thread.messages.length && saved.readState === "pending") return "Wait for saved comments to load.";
			if (thread.messages.length && saved.readState === "failed")
				return "Refresh saved comments before changing their status.";
			if (!row && !saved.privateOnly && thread.messages.some((m) => m.state !== "failed"))
				return "No saved comment is available yet.";
			return "";
		}
		function revisionLabel(revision?: number) {
			return revision ? `Made on revision ${revision}` : "";
		}
		function itemRevision(thread: ReaderThread, ordinal: number) {
			if (ordinal) return thread.comments?.[ordinal - 1]?.authoredRevision;
			return (
				thread.messages[0]?.authoredRevision ??
				thread.pendingComment?.authoredRevision ??
				thread.authoredRevision ??
				thread.draftRevision
			);
		}
		function stateControl(thread: ReaderThread, ordinal: number) {
			const row = savedRow(thread, ordinal),
				state = closed(thread, ordinal) ? "open" : "closed";
			const label = state === "open" ? "Reopen comment" : "Close comment";
			const reason = unavailableReason(thread, row);
			const b = action(row || reason ? label : `${label} in pane`, () => {
				if (row) void saved.set(row, state);
				else toggleLocal(thread, ordinal);
			});
			b.disabled = !!reason;
			b.title = reason || b.textContent || label;
			return el(
				"span",
				{ class: "comment-state" },
				el("small", {}, revisionLabel(row?.madeOnRevision ?? itemRevision(thread, ordinal))),
				b,
			);
		}
		function refreshReview() {
			if (activity.matches(":popover-open")) drawActivity();
			if (session.visible && session.current) {
				const batch = card.querySelector(".batch-request");
				if (batch) batch.replaceWith(sentBatch(session.current));
				const control = card.querySelector(".single-comment-state");
				if (control) control.replaceChildren(stateControl(session.current, 0));
				position();
			}
			paintPassage();
		}
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
		let rendered: { blocks: ReaderMappedBlock[]; view: ReaderPassageView } | undefined;
		function currentView() {
			return rendered?.blocks === controller.blocks ? rendered.view : undefined;
		}
		function installBlocks(blocks: ReaderMappedBlock[]) {
			const source = controller.doc?.source;
			if (source === undefined) return;
			const nodes = new Map(
				Array.from(doc.children, (element) => [(element as HTMLElement).dataset.block, element as HTMLElement]),
			);
			const maps = new Map<string, ReturnType<ReaderSourceModelAPI["map"]>>();
			const view: ReaderPassageView = {
				blocks,
				map(block) {
					const node = nodes.get(block.key);
					if (!node?.isConnected || node.dataset.role === "block-editor") return undefined;
					let map = maps.get(block.key);
					if (!map) {
						map = api.sourceModel.map(block, source, node);
						maps.set(block.key, map);
					}
					return map;
				},
			};
			rendered = { blocks, view };
			if (sessions.render(view)) pendingChanged(session);
			paintPassage();
			position();
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
			if (!session.current || session.current.comments || closed(session.current, 0)) return undefined;
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
		function position() {
			if (!session.visible) return;
			const body = card.querySelector<HTMLElement>(".ask-body");
			if (!body) return;
			const box = app.getBoundingClientRect(),
				bar = get(".bar").getBoundingClientRect(),
				log = body.querySelector<HTMLElement>(".ask-messages"),
				bodyScroll = body.scrollTop,
				logScroll = log?.scrollTop ?? 0;
			const rect = cardAnchorRect();
			// Measure before the placement cap shrinks the body. Restore its scroll offsets after layout.
			card.style.maxHeight = "";
			const height = card.offsetHeight;
			const place = api.uiLogic.cardPlacement(
				{ top: rect.top - box.top, bottom: rect.bottom - box.top, left: rect.left - box.left },
				{ width: card.offsetWidth, height, minHeight: height - Math.max(0, body.offsetHeight - 64) },
				{
					width: box.width,
					height: tray.hidden ? box.height : tray.getBoundingClientRect().top - box.top,
					top: bar.bottom - box.top,
				},
			);
			card.style.maxHeight = `${place.maxHeight}px`;
			card.style.left = `${place.left}px`;
			card.style.top = `${place.top}px`;
			card.dataset.side = place.side;
			body.scrollTop = bodyScroll;
			if (log) log.scrollTop = logScroll;
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
			owner: ReaderComment | ReaderThread | ReaderReviewComment;
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
			if (thread.comments) return passageRanges(thread.comments.filter((_, i) => !closed(thread, i + 1)));
			if (closed(thread, 0)) return [];
			const range = rangeFor(thread.range);
			return range ? [range] : [];
		}
		function askedMark(thread: ReaderThread): Mark[] {
			// A question that the conversation refused was not asked; the Ask menu still lists its card.
			if (!thread.messages.some((message) => message.state !== "failed")) return [];
			if (thread.comments)
				return thread.comments.flatMap((comment, i) => {
					const ordinal = i + 1;
					const r = !closed(thread, ordinal) && rangeFor(comment.range);
					return r
						? [{ kind: "asked", owner: comment, ranges: [r], open: () => openThread(thread, true, ordinal) }]
						: [];
				});
			const ranges = threadRanges(thread);
			return ranges.length ? [{ kind: "asked", owner: thread, ranges, open: () => openThread(thread) }] : [];
		}
		function isOpen(mark: Mark) {
			const selectedOrdinal = session.current && selectionByThread.get(session.current);
			return (
				session.visible &&
				!!session.current &&
				(mark.owner === session.current ||
					mark.owner === session.current.pendingComment ||
					(typeof selectedOrdinal === "number" && mark.owner === session.current.comments?.[selectedOrdinal - 1]))
			);
		}
		function activePassages(range: Range | null) {
			const thread = session.current;
			if (!session.visible || !thread?.comments) return range ? [range] : [];
			const selectedOrdinal = selectionByThread.get(thread);
			if (selectedOrdinal === undefined) return threadRanges(thread);
			return passageRanges(thread.comments.filter((_, i) => i + 1 === selectedOrdinal && !closed(thread, i + 1)));
		}
		function paintPassage() {
			const range = session.visible ? rangeFor(threadRange()) : null;
			// In the order that clicks open them: comments as listed, then questions, newest first.
			marks = [...session.comments.flatMap(commentMark), ...session.threads.flatMap(askedMark), ...restoredMarks()];
			const shown = marks.filter((mark) => !isOpen(mark));
			for (const kind of ["comment", "asked"])
				editor.highlight(
					kind,
					shown.filter((mark) => mark.kind === kind).flatMap((mark) => mark.ranges),
				);
			editor.highlight("passage", activePassages(range));
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
		function restoredRows() {
			const local = new Set(session.threads.map((t) => t.threadId.toLowerCase()));
			return [...saved.rows.values()].filter((row) => !local.has(row.threadId.toLowerCase()));
		}
		function restoredMarks(): Mark[] {
			return restoredRows().flatMap((row) => {
				const range = rangeFor(api.reviewMarkRange(sessions, session, row));
				return range
					? [
							{
								kind: "asked",
								owner: row,
								ranges: [range],
								open: () => {
									activity.showPopover();
									collection = "open";
									inspected = row;
									drawActivity();
								},
							},
						]
					: [];
			});
		}
		function entryButton(title: string, detail: string, open: () => void) {
			const b = button("", "spark", open, { className: "thread" });
			b.append(el("span", { class: "tx" }, el("b", {}, title), el("span", {}, detail)));
			return b;
		}
		function inspectButton(item: ReaderReviewComment | Parked) {
			return () => {
				inspected = item;
				drawActivity();
			};
		}
		function detailHead(text: string, quote?: string) {
			activity.replaceChildren(
				action("Back to comments", () => {
					inspected = null;
					drawActivity();
				}),
				el("p", { class: "sec" }, text),
			);
			if (quote) activity.append(el("blockquote", {}, quote));
		}
		function drawSavedInspection(row: ReaderReviewComment) {
			const open = row.commentState === "open";
			detailHead(
				[open ? "Open" : "Closed", row.kind, revisionLabel(row.madeOnRevision)].filter(Boolean).join(" · "),
				row.quote,
			);
			const toggle = action(
				open ? "Close comment" : "Reopen comment",
				() => void saved.set(row, open ? "closed" : "open"),
			);
			toggle.disabled = saved.readState !== "ready";
			activity.append(
				el("p", { class: "review-text" }, row.text),
				el("p", { class: "sec" }, "Read the reply in the original conversation."),
				toggle,
			);
		}
		function drawInspection(item: ReaderReviewComment | Parked) {
			if ("commentId" in item) {
				const row = saved.rows.get(item.commentId);
				if (!row) return false;
				drawSavedInspection(row);
			} else {
				if (!parkedItems().includes(item)) return false;
				detailHead(
					["Closed draft", revisionLabel(item.comment?.authoredRevision ?? item.authoredRevision)]
						.filter(Boolean)
						.join(" · "),
					item.comment?.quote,
				);
				activity.append(
					el("p", { class: "review-text" }, item.text),
					action("Reopen comment", () => unpark(item)),
				);
			}
			return true;
		}
		type ActivityEntry = { state: ReaderCommentState; title: string; detail: string; open: () => void };
		function liveEntry(thread: ReaderThread, ordinal: number, title: string): ActivityEntry {
			return {
				state: closed(thread, ordinal) ? "closed" : "open",
				title,
				detail: [
					latestState(thread),
					revisionLabel(savedRow(thread, ordinal)?.madeOnRevision ?? itemRevision(thread, ordinal)),
				]
					.filter(Boolean)
					.join(" · "),
				open: () => {
					activity.hidePopover();
					openThread(thread, true, ordinal);
				},
			};
		}
		function threadEntries(thread: ReaderThread) {
			if (!thread.comments) return [liveEntry(thread, 0, thread.messages[0]?.text ?? (thread.draft || "New question"))];
			const entries = thread.comments.map((item, i) => liveEntry(thread, i + 1, `${i + 1}. ${item.text}`));
			if (thread.overall) entries.unshift(liveEntry(thread, 0, `Overall: ${thread.overall}`));
			return entries;
		}
		function activityEntries(): ActivityEntry[] {
			const entries = session.threads.flatMap(threadEntries);
			for (const row of restoredRows())
				entries.push({
					state: row.commentState,
					title: row.text,
					detail: revisionLabel(row.madeOnRevision) || row.kind,
					open: inspectButton(row),
				});
			for (const item of parkedItems())
				entries.push({
					state: "closed",
					title: item.text,
					detail: item.comment ? "Pending comment" : "Pending overall",
					open: inspectButton(item),
				});
			return entries;
		}
		function drawFilters(entries: ActivityEntry[]) {
			const nClosed = entries.filter((e) => e.state === "closed").length;
			if (!nClosed) collection = "open";
			if (nClosed)
				activity.append(
					el(
						"div",
						{ class: "review-filters" },
						...(["open", "closed"] as const).map((state) => {
							const b = action(state === "open" ? "Open" : `Closed (${nClosed})`, () => {
								collection = state;
								drawActivity();
							});
							b.setAttribute("aria-pressed", String(collection === state));
							return b;
						}),
					),
				);
		}
		function drawActivity() {
			if (inspected && drawInspection(inspected)) return;
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
			const entries = activityEntries();
			drawFilters(entries);
			if (collection === "open" && hasPendingBatch())
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
			else if (!entries.length) activity.append(el("div", { class: "sec" }, "Select a passage and choose Ask."));
			for (const entry of entries.filter((e) => e.state === collection))
				activity.append(entryButton(entry.title, entry.detail, entry.open));
		}
		function composerActions(thread: ReaderThread, followUp: boolean) {
			const send = () => {
				if (thread === session.current) void sendMessage();
			};
			if (followUp) return { primary: "Send", run: send, hint: "⌘↩ send" };
			if (thread.pendingComment)
				return {
					primary: "Done",
					run: () => ask.close(),
					secondary: `Send all ${session.comments.length}`,
					runSecondary: () => void sendBatch(),
					hint: "⌘↩ done · ⇧⌘↩ send",
				};
			const add = () => addComment(thread);
			if (!session.comments.length)
				return {
					primary: "Send",
					run: send,
					secondary: "Add to batch",
					runSecondary: add,
					hint: "⌘↩ send · ⇧⌘↩ add",
				};
			return {
				primary: "Add to batch",
				run: add,
				secondary: `Send all ${session.comments.length + 1}`,
				runSecondary: () => {
					if (add()) void sendBatch();
				},
				hint: "⌘↩ add · ⇧⌘↩ send",
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
			// A send that waits for an earlier message stays enabled, so a click explains the wait.
			function updateButtons() {
				primary.disabled = !comment && !field.value.trim();
				if (secondary) secondary.disabled = !field.value.trim();
			}
			updateButtons();
			field.addEventListener("input", () => {
				if (comment) {
					comment.text = field.value;
					pendingChanged(session);
				} else {
					if (!hasText(thread.draft) && hasText(field.value)) thread.draftRevision = revision();
					thread.draft = field.value;
				}
				if (refusal?.thread === thread) clearRefusal();
				updateButtons();
			});
			field.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" || !event.metaKey || event.altKey || event.ctrlKey || event.isComposing) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.shiftKey) pressKey(thread, field, secondary, alternative);
				else pressKey(thread, field, primary, label);
			});
			return el(
				"div",
				{ class: `composer${followUp ? " follow-up" : ""}` },
				field,
				el("div", { class: "foot" }, remove, el("span", { class: "hint" }, hint), secondary, primary),
			);
		}
		// A shortcut for a button that is not available yet says why instead of doing nothing.
		function pressKey(
			thread: ReaderThread,
			field: HTMLTextAreaElement,
			target: HTMLButtonElement | null,
			name?: string,
		) {
			if (!target) return;
			if (target.disabled) refuse(textProblem(field.value, name === "Add to batch"), thread);
			else target.click();
		}
		function threadTitle(thread: ReaderThread) {
			if (thread.comments) return `Batch of ${commentCount(thread.comments.length)}`;
			if (thread.pendingComment) return "Edit batch comment";
			return thread.quote ? "Ask about this passage" : "Ask about this document";
		}
		function drawHead(thread: ReaderThread) {
			return el(
				"div",
				{ class: "ask-head" },
				el("span", { class: "kind" }, icon("spark")),
				el("span", { class: "who" }, threadTitle(thread)),
				button("Dismiss card", "x", () => ask.close(), { iconOnly: true, key: "esc" }),
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
			listFoot = el("div", { class: "batch-list-foot" }),
			listRefusal = el("p", { class: "send-failure ask-refused", role: "alert" });
		listRefusal.hidden = true;
		const parkOverall = action("Close overall comment", () => park());
		batchList.replaceChildren(
			el("h2", {}, "Pending batch"),
			el("label", { class: "batch-overall" }, el("span", {}, "Overall comment"), overallField),
			parkOverall,
			listBody,
			listRefusal,
			listFoot,
		);
		overallField.addEventListener("input", () => {
			listRefusal.hidden = true;
			// Input that arrives while the list is closed, such as a late paste after a document
			// switch, belongs to no visible batch.
			if (!batchList.matches(":popover-open")) {
				overallField.value = session.overall;
				return;
			}
			setOverall(overallField.value);
			pendingChanged(session);
			parkOverall.hidden = !hasText(overallField.value);
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
			parkOverall.hidden = !hasText(session.overall);
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
						action("Close", () => park(comment)),
						button(`Remove comment ${index + 1}`, "x", () => removeComment(comment), {
							iconOnly: true,
							className: "btn-i batch-row-remove",
						}),
					),
				);
			}
			listFoot.replaceChildren(
				button("Remove all", "", removeAll, { className: "batch-secondary" }),
				...(session.comments.length
					? [
							button(`Send ${commentCount(session.comments.length)}`, "", () => void sendBatch(), {
								className: "batch-primary",
							}),
						]
					: [el("span", { class: "hint" }, "Add a passage comment to send this batch.")]),
			);
		}
		function openBatchList() {
			if (!session.comments.length && !hasText(session.overall)) return;
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
			tray.hidden = !session.comments.length && !hasText(session.overall);
			traySend.disabled = !session.comments.length;
			const count = commentCount(session.comments.length);
			const described = hasText(session.overall) ? `${count} and an overall comment` : count;
			trayOpen.setAttribute("aria-label", `Pending batch: ${described}`);
			trayCount.textContent = batchLabel();
		}
		function refreshBatch() {
			if (!session.comments.length && !hasText(session.overall)) batchList.hidePopover();
			refreshTray();
			if (batchList.matches(":popover-open")) drawBatchList();
		}
		function discardEmptyComment() {
			const comment = session.current?.pendingComment;
			if (comment && !comment.text.trim()) {
				const index = session.comments.indexOf(comment);
				if (index >= 0) {
					session.comments.splice(index, 1);
					pendingChanged(session);
				}
			}
		}
		// A question card closed before anything was typed or sent leaves no entry in the Ask menu.
		function discardEmptyQuestion() {
			const thread = session.current;
			if (
				!thread ||
				closed(thread, 0) ||
				thread.pendingComment ||
				thread.comments ||
				thread.messages.length ||
				thread.draft.trim()
			)
				return;
			const index = session.threads.indexOf(thread);
			if (index >= 0) session.threads.splice(index, 1);
			session.current = null;
		}
		function removeComment(comment: ReaderComment) {
			const index = session.comments.indexOf(comment);
			if (index < 0) return;
			session.comments.splice(index, 1);
			pendingChanged(session);
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
			if (controller.compositionTarget || !currentVersion()) return;
			const owner = session,
				presentation = controller.payload?.presentation;
			void prepareBatch(
				owner,
				() => controller.payload?.presentation === presentation,
				() => removedBatch(owner),
				() => {
					if (owner === session && !warnings.has(owner))
						ctx.toast("The batch did not change. Check the pending comments before you try again.");
				},
			);
		}
		async function prepareBatch(
			owner: ReaderAskDocument,
			current: () => boolean,
			commit: () => void,
			refused: () => void,
		) {
			const stillCurrent = () => !disposed && session === owner && !controller.compositionTarget && current();
			const completed = await recovering.prepare(owner, sessions.snapshot(owner, true), stillCurrent, commit);
			if (completed || disposed) return;
			if (owner === session && warnings.has(owner)) showRecoveryWarning(owner);
			refused();
		}
		function removedBatch(owner: ReaderAskDocument) {
			const removed = owner.comments.splice(0),
				overall = owner.overall,
				authoredRevision = owner.overallRevision,
				atRemoval = version();
			let restored = false;
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
					if (restored || disposed) return;
					restored = true;
					undoRemove(owner, removed, overall, authoredRevision, atRemoval);
				},
			});
		}
		function sameVersion(owner: ReaderAskDocument, base: ReaderPromptVersion) {
			return (
				owner === session &&
				version().presentation === base.presentation &&
				controller.doc?.generation === base.generation
			);
		}
		function undoRemove(
			owner: ReaderAskDocument,
			items: ReaderComment[],
			overall: string,
			authoredRevision: number | undefined,
			base: ReaderPromptVersion,
		) {
			if (!sameVersion(owner, base)) for (const item of items) item.range = undefined;
			owner.comments.unshift(...items.splice(0));
			restoreOverall(overall, authoredRevision, owner);
			const view = currentView();
			if (owner === session && view) sessions.render(view);
			pendingChanged(owner);
			if (owner === session) ask.refresh();
		}
		// Every refused send says why: in the open card when it belongs to that card, otherwise in a
		// notice. The text the person wrote stays where it was.
		function refuse(text: string, thread = session.visible ? session.current : null): false {
			if (disposed) return false;
			// The open batch list lies above the card, so a refusal from it shows in the list.
			if (batchList.matches(":popover-open")) {
				listRefusal.textContent = text;
				listRefusal.hidden = false;
				return false;
			}
			if (thread && thread === session.current && session.visible) {
				refusal = { thread, text };
				ctx.removeNotice("ask-refused");
				draw();
			} else ctx.notice(text, "warn", [], "ask-refused");
			return false;
		}
		function clearRefusal() {
			refusal = null;
			card.querySelector(".ask-refused")?.remove();
		}
		function quoteProblem(quote?: string) {
			return quote && utf8.encode(quote).length > 8192 ? "Select a shorter passage. The quote is too long." : "";
		}
		function textProblem(text: string, adding = false) {
			if (utf8.encode(text).length > 64 * 1024) return "Shorten the comment before sending it. Your text is kept.";
			if (hasText(text)) return "";
			return adding ? "Write a comment before you add it to the batch." : "Write a message before you send it.";
		}
		function addComment(thread: ReaderThread) {
			if (thread !== session.current || !session.threads.includes(thread))
				return refuse("This comment is no longer open. Select the passage and ask again.");
			const problem =
				textProblem(thread.draft, true) ||
				quoteProblem(thread.quote) ||
				(session.comments.length >= batchLimit ? "The batch is full. Send it before adding another comment." : "");
			if (problem) return refuse(problem, thread);
			session.comments.push({
				text: thread.draft,
				quote: thread.quote,
				range: thread.range,
				sourceAnchor: thread.sourceAnchor,
				authoredRevision: thread.authoredRevision ?? thread.draftRevision,
			});
			pendingChanged(session);
			session.threads.splice(session.threads.indexOf(thread), 1);
			ctx.clearSelection?.();
			ask.close();
			session.current = null;
			return true;
		}
		function followUpDraft(thread: ReaderThread): ReaderThread | null {
			return thread.draft
				? { threadId: "", draft: thread.draft, draftRevision: thread.draftRevision, messages: [] }
				: null;
		}
		function restoreFollowUp(owner: ReaderAskDocument, thread: ReaderThread) {
			const next = followUpDraft(thread);
			if (next) owner.threads.unshift(next);
			if (owner.heldThread === thread) owner.heldThread = null;
			if (owner.current === thread) {
				owner.current = next;
				owner.visible &&= !!next;
			}
			return next;
		}
		function restoreBatch(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			const index = owner.threads.indexOf(thread);
			if (index < 0 || !thread.comments) return;
			owner.threads.splice(index, 1);
			owner.comments.unshift(...thread.comments);
			restoreOverall(thread.overall, message.authoredRevision, owner);
			const next = restoreFollowUp(owner, thread);
			sessions.forget(message);
			pendingChanged(owner);
			const detail = message.detail ?? "The conversation did not accept it.";
			if (owner === session)
				ctx.notice(
					`Batch not sent. ${detail} Your comments are kept.${next ? " Your follow-up is a separate draft." : ""}`,
					"warn",
				);
		}
		const sendingBatches = new Set<ReaderAskDocument>(),
			preparingBatches = new Set<ReaderAskDocument>();
		const retryBatch = new WeakMap<ReaderAskMessage, () => Promise<void>>();
		function batchProblem() {
			if (session.current?.pendingComment && !session.current.pendingComment.text.trim()) ask.close();
			if (!session.comments.length)
				return hasText(session.overall)
					? "Add a comment on a passage before you send the batch. The overall comment goes with it."
					: "The batch has no comments to send.";
			if (sendingBatches.has(session) || preparingBatches.has(session))
				return "Wait for the current batch to reach the conversation before sending another.";
			return batchSizeProblem();
		}
		function batchSizeProblem() {
			if (session.comments.length > batchLimit) return "Remove comments until the batch fits, then send it.";
			if (utf8.encode(session.overall).length > 64 * 1024)
				return "Shorten the overall comment before sending the batch.";
			const long = session.comments.findIndex(({ text }) => utf8.encode(text).length > 64 * 1024);
			return long < 0 ? "" : `Shorten comment ${long + 1} before sending the batch.`;
		}
		async function sendBatch() {
			if (!currentVersion()) return refuse(notShown);
			const problem = batchProblem();
			if (problem) return refuse(problem);
			if (!releaseEditor()) return;
			const owner = session,
				base = version(),
				thread = batchThread(owner),
				message = thread.messages[0];
			const packet = sessions.packet(thread, message, base);
			if (utf8.encode(JSON.stringify(packet)).length > 256 * 1024 - 128)
				return refuse("The batch is too long. Shorten or remove comments before sending it.");
			preparingBatches.add(owner);
			try {
				await prepareBatch(
					owner,
					() => sameVersion(owner, base),
					() => submitBatch(owner, thread, message),
					() => batchNotSent(owner),
				);
			} finally {
				preparingBatches.delete(owner);
			}
		}
		function batchNotSent(owner: ReaderAskDocument) {
			if (owner !== session)
				ctx.notice("The batch was not sent because another document opened. Its comments stay with it.", "warn");
			else if (warnings.has(owner))
				refuse(
					"The batch was not sent because the reader could not confirm its saved copy. Your comments are kept. Check the saved batch, then send again.",
				);
			else
				refuse(
					"The batch was not sent because the document or its comments changed while the reader prepared it. Your comments are kept. Send it again.",
				);
		}
		function batchThread(owner: ReaderAskDocument): ReaderThread {
			const id = crypto.randomUUID();
			const message: ReaderAskMessage = {
				requestId: id,
				text: `Batch of ${commentCount(owner.comments.length)}`,
				state: "sending",
				authoredRevision: owner.overallRevision,
			};
			return {
				threadId: id,
				comments: [...owner.comments],
				overall: hasText(owner.overall) ? owner.overall : undefined,
				draft: "",
				messages: [message],
			};
		}
		function submitBatch(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			owner.comments.length = 0;
			setOverall("", owner);
			owner.threads.unshift(thread);
			sessions.register(owner, thread, message);
			const attempt = () => {
				const job = deliverBatch(owner, thread, message);
				receiptJobs.add(job);
				return job.finally(() => receiptJobs.delete(job));
			};
			retryBatch.set(message, attempt);
			openThread(thread, false);
			void attempt();
		}
		// A batch that never left the page returns its comments; a retry that cannot start says why.
		function batchUnsent(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage, detail: string) {
			if (message.state !== "sending") {
				refuse(detail, thread);
				return;
			}
			message.state = "failed";
			message.detail = detail;
			retryBatch.delete(message);
			restoreBatch(owner, thread, message);
			if (owner === session) ask.refresh();
		}
		async function deliverBatch(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			if (disposed) return;
			const unsent = (detail: string) => batchUnsent(owner, thread, message, detail);
			if (owner !== session) return unsent("Another document opened before the batch was sent.");
			if (sendingBatches.has(owner)) return unsent("The batch is already on its way to the conversation.");
			sendingBatches.add(owner);
			let outcome: ReaderAskSubmission;
			try {
				outcome = await sendAttempt(owner, thread, message);
			} finally {
				sendingBatches.delete(owner);
			}
			if (outcome !== "attempted") unsent(submissionProblem(outcome, message));
			else batchReceipt(owner, thread, message);
		}
		function batchReceipt(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			if (!(message.state === "unknown" && message.retryable)) retryBatch.delete(message);
			if (message.state === "failed") restoreBatch(owner, thread, message);
			if (owner === session) ask.refresh();
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
		function sentComments(thread: ReaderThread) {
			return el(
				"ol",
				{ class: "batch-sent", role: "list" },
				...(thread.comments ?? []).flatMap((item, index) => {
					const ordinal = index + 1;
					if (closed(thread, ordinal) && selectionByThread.get(thread) !== ordinal) return [];
					return [
						el(
							"li",
							{ class: "batch-entry", "data-comment-ordinal": String(ordinal) },
							commentNumber(index),
							commentPreview(item),
							stateControl(thread, ordinal),
						),
					];
				}),
			);
		}
		// A sent batch shows its overall comment above the numbered comments, in the order the agent reads them.
		function sentBatch(thread: ReaderThread) {
			const list = sentComments(thread);
			if (!thread.overall || (closed(thread, 0) && selectionByThread.get(thread) !== 0))
				return el("div", { class: "batch-request" }, list);
			return el(
				"div",
				{ class: "batch-request" },
				el(
					"div",
					{ class: "ask-question batch-overall-sent", "data-comment-ordinal": "0" },
					el("span", { class: "from" }, "Overall comment", stateControl(thread, 0)),
					thread.overall,
				),
				list,
			);
		}
		// An answer is Markdown. Native renders it with the document's renderer, as text that belongs
		// to no file; the plain text shows until the rendering arrives and stays if it fails. Renderings
		// are kept by text, so a card that redraws shows them at once.
		const renderedAnswers = new Map<string, string>(),
			renderingAnswers = new Set<string>(),
			answerText = new WeakMap<HTMLElement, string>();
		const blockParents = new Set(["DIV", "UL", "OL", "BLOCKQUOTE", "FIGURE", "TABLE", "THEAD", "TBODY", "TR"]);
		function fillAnswer(body: HTMLElement, html: string) {
			api.setRenderedHTML(body, html.trim());
			// Line breaks between the renderer's block elements are layout, not answer text.
			const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
			const breaks: Text[] = [];
			for (let node = walker.nextNode(); node; node = walker.nextNode())
				if (!node.nodeValue?.trim() && blockParents.has(node.parentElement?.tagName ?? "")) breaks.push(node as Text);
			for (const node of breaks) node.remove();
			for (const node of body.querySelectorAll("[id]")) node.removeAttribute("id");
			api.highlightCode?.(body);
			body.classList.remove("plain");
		}
		function rememberAnswer(text: string, html: string) {
			renderedAnswers.set(text, html);
			if (renderedAnswers.size > 40) renderedAnswers.delete(renderedAnswers.keys().next().value as string);
		}
		function showRenderedAnswer(text: string, html: string) {
			rememberAnswer(text, html);
			const log = card.querySelector<HTMLElement>(".ask-messages");
			if (!log) return;
			const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
			const bodies = [...log.querySelectorAll<HTMLElement>('[data-role="ask-answer"].plain')].filter(
				(body) => answerText.get(body) === text,
			);
			for (const body of bodies) fillAnswer(body, html);
			if (atEnd || bodies.some((body) => body.parentElement === log.lastElementChild)) showNewest(log);
		}
		async function renderAnswer(text: string) {
			renderingAnswers.add(text);
			try {
				const reply = (await host.request("query", { kind: "markdown", text })) as { html?: unknown } | undefined;
				if (typeof reply?.html === "string") showRenderedAnswer(text, reply.html);
			} catch {
				// The plain text stays.
			} finally {
				renderingAnswers.delete(text);
			}
		}
		function answerBody(text: string) {
			const body = el("div", { class: "reply-md plain", "data-role": "ask-answer" });
			answerText.set(body, text);
			const html = renderedAnswers.get(text);
			if (html !== undefined) fillAnswer(body, html);
			else {
				body.textContent = text;
				if (!renderingAnswers.has(text)) void renderAnswer(text);
			}
			body.addEventListener("click", (event) => {
				const link = (event.target as Element).closest("a[href]");
				if (!link) return;
				event.preventDefault();
				const href = link.getAttribute("href") ?? "";
				if (!href.startsWith("#")) void ctx.hostCommand("openLink", { href });
			});
			return body;
		}
		// The page takes the card's place; the answer stays in the card for the next opening.
		async function openAnswerPage(text: string) {
			let html = renderedAnswers.get(text);
			if (html === undefined) {
				const reply = (await host.request("query", { kind: "markdown", text })) as { html?: unknown } | undefined;
				if (typeof reply?.html !== "string") throw new Error("the reply held no HTML");
				html = reply.html;
				rememberAnswer(text, html);
			}
			ask.close();
			ctx.showAnswer?.(html);
		}
		function answerHead(text: string) {
			const head = el("div", { class: "from" }, el("span", {}, "Agent"));
			// A long answer also opens as a page of its own, at the document's width and type.
			if (text.length > 480 || /\n(#|```|\||\s*[-*] |\s*\d+\. )/.test(text))
				head.append(
					button(
						"Open answer as a page",
						"expand",
						() => void openAnswerPage(text).catch(() => ctx.notice("The reader did not render this answer.", "warn")),
						{ iconOnly: true },
					),
				);
			return head;
		}
		function promptAnswer(message: ReaderAskMessage) {
			if (!message.detail) return null;
			if (message.state === "answered")
				return el("div", { class: "reply" }, answerHead(message.detail), answerBody(message.detail));
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
		function deliveryMessage(body: HTMLElement, message: ReaderAskMessage) {
			const batch = retryBatch.get(message);
			if (message.state === "failed" && !batch)
				body.append(
					el(
						"p",
						{ class: "send-failure" },
						`Not sent: ${message.detail || "the conversation did not accept the message."} Your text is kept.`,
					),
					action("Retry", () => void sendMessage(message)),
				);
			if (message.state !== "unknown") return;
			body.append(
				el(
					"p",
					{ class: "send-failure" },
					message.retryable
						? "Delivery is not confirmed. Retry checks the same request."
						: "Delivery is not confirmed. Your text is kept. The reader will not send it twice.",
				),
			);
			if (message.retryable) body.append(action("Retry", () => void (batch ? batch() : sendMessage(message))));
		}
		function drawConversation(body: HTMLElement, thread: ReaderThread) {
			const message = activeMessage(thread);
			if (!message) return;
			const ops = operations(thread),
				changeCount = ops.reduce((n, op) => n + op.edits.length, 0),
				latest = ops.at(-1);
			body.append(drawStatus(message, changeCount), drawMessages(thread));
			if (latest)
				body.append(
					el(
						"div",
						{ class: "ask-actions" },
						action("Show changes", () => ask.showChanges(ops[0].operationId)),
						action(undoLabel(latest, ops.length > 1), () => undo(latest.operationId)),
					),
				);
			deliveryMessage(body, message);
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
			const messages = card.querySelector<HTMLElement>(".ask-messages");
			if (messages) showNewest(messages);
		}
		// The newest exchange ends the list. An answer taller than the list shows from its start, so it
		// reads from the top.
		function showNewest(log: HTMLElement) {
			log.scrollTop = log.scrollHeight;
			const last = log.lastElementChild;
			if (!(last instanceof HTMLElement) || !last.classList.contains("reply") || last.offsetHeight <= log.clientHeight)
				return;
			log.scrollTop += last.getBoundingClientRect().top - log.getBoundingClientRect().top;
		}
		function drawQuote(body: HTMLElement, thread: ReaderThread) {
			if (!thread.comments)
				body.append(
					el(
						"div",
						{ class: "quote" },
						el("span", {}, thread.quote ?? `About ${String(controller.payload?.meta.title ?? "this document")}`),
					),
				);
		}
		function drawCardBody(thread: ReaderThread) {
			const body = el("div", { class: "ask-body" });
			drawQuote(body, thread);
			drawConversation(body, thread);
			if (!thread.comments)
				body.append(
					thread.pendingComment
						? action("Close pending comment", () => park(thread.pendingComment))
						: el("div", { class: "single-comment-state" }, stateControl(thread, 0)),
				);
			if (!thread.messages.length && closed(thread, 0)) body.append(el("p", { class: "review-text" }, thread.draft));
			if (refusal?.thread === thread)
				body.append(el("p", { class: "send-failure ask-refused", role: "alert" }, refusal.text));
			return body;
		}
		function cardIsComposing() {
			const target = controller.compositionTarget;
			return target instanceof Node && card.contains(target);
		}
		function renderCard(thread: ReaderThread) {
			const message = activeMessage(thread);
			const body = drawCardBody(thread);
			card.dataset.state = message?.state ?? "draft";
			card.setAttribute("data-open", "");
			card.replaceChildren(drawHead(thread), body);
			if (message || !closed(thread, 0)) card.append(composer(thread, !!message));
			position();
			revealLatest(thread);
			if (refusal?.thread === thread) body.scrollTop = body.scrollHeight;
		}
		function draw() {
			if (!session.current || !session.visible) {
				card.removeAttribute("data-open");
				paintPassage();
				return;
			}
			if (cardIsComposing()) return;
			const focused = focusedComposer();
			renderCard(session.current);
			paintPassage();
			if (focused) {
				const field = card.querySelector("textarea");
				field?.focus({ preventScroll: true });
				field?.setSelectionRange(focused.start, focused.end);
			}
		}
		function currentVersion() {
			if (!controller.doc || controller.payload?.meta.documentKey !== session.documentKey) return undefined;
			return version();
		}
		const delivery = api.createAskDelivery(
			sessions,
			currentVersion,
			async (packet) => (await host.request("prompt", packet)) as ReaderPromptReceipt,
		);
		function receivePrompt(value: unknown) {
			const result = delivery.update(value as ReaderPromptEvent);
			if (!result) return;
			const { owner, thread, message } = result;
			if (message.state === "failed" && thread.comments && thread.messages[0] === message) {
				retryBatch.delete(message);
				restoreBatch(owner, thread, message);
			}
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
		function releaseEditor(thread?: ReaderThread) {
			// Closing an open block can commit an edit. Capture its generation only afterwards.
			if (!controller.compositionTarget && (!controller.doc?.active || editor.close())) return true;
			return refuse("Finish typing in the document first, then send again. Your text is kept.", thread);
		}
		const notShown =
			"The reader did not send this because the page has not finished showing the document. Your text is kept. Send it again.";
		function sendProblem(thread: ReaderThread, retry?: ReaderAskMessage) {
			const last = activeMessage(thread);
			if (retry) return retry === last ? "" : "A newer message follows this one, so the reader does not retry it.";
			return (last && waitProblem(last)) || textProblem(thread.draft) || quoteProblem(thread.quote);
		}
		function waitProblem(last: ReaderAskMessage) {
			if (last.state === "sending")
				return "Your last message is still on its way. Send this one after it arrives. Your text is kept.";
			if (last.state !== "unknown") return "";
			return last.retryable
				? "The reader has not confirmed your last message. Retry it before you send another. Your text is kept."
				: "The reader has not confirmed your last message and will not send it twice. Send this one after the conversation answers. Your text is kept.";
		}
		function submissionProblem(outcome: ReaderAskSubmission, message: ReaderAskMessage) {
			if (outcome === "inFlight") return "The reader is already sending this message.";
			if (outcome === "stale") return notShown;
			if (outcome === "unregistered")
				return "This question is no longer in the Ask list, so the reader did not send it. Ask again.";
			return message.state === "unknown"
				? "The reader will not send this message twice while its delivery is not confirmed."
				: "This message already reached the conversation.";
		}
		// A message that never left the page goes back into the composer as it was.
		function takeBack(thread: ReaderThread, message: ReaderAskMessage) {
			const index = thread.messages.indexOf(message);
			if (index < 0 || message.state !== "sending") return;
			thread.messages.splice(index, 1);
			sessions.forget(message);
			if (!thread.messages.length && thread.threadId === message.requestId) thread.threadId = "";
			thread.draft = message.text + thread.draft;
			thread.draftRevision = message.authoredRevision;
		}
		function readyToSend(owner: ReaderAskDocument, thread: ReaderThread, retry?: ReaderAskMessage) {
			const problem = sendProblem(thread, retry);
			if (problem) return refuse(problem, thread);
			if (!releaseEditor(thread)) return false;
			if (owner !== session || session.current !== thread)
				return refuse("Another card opened before your message was sent. Your text is kept in its own card.");
			return !!currentVersion() || refuse(notShown, thread);
		}
		async function sendMessage(retry?: ReaderAskMessage) {
			const owner = session,
				thread = owner.current;
			if (!thread) {
				refuse("Open the question again, then send it.");
				return;
			}
			if (!readyToSend(owner, thread, retry)) return;
			const message = retry ?? newMessage(thread);
			const outcome = await sendAttempt(owner, thread, message);
			if (outcome !== "attempted") stayedInPage(thread, message, outcome, !retry);
			if (thread === session.current) ask.refresh();
		}
		function stayedInPage(
			thread: ReaderThread,
			message: ReaderAskMessage,
			outcome: ReaderAskSubmission,
			created: boolean,
		) {
			if (created) takeBack(thread, message);
			refuse(submissionProblem(outcome, message), thread);
		}
		async function sendAttempt(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage) {
			if (refusal?.thread === thread) refusal = null;
			const pending = delivery.submit(owner, thread, message);
			if (owner === session) ask.refresh();
			return pending;
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
			void sendAttempt(session, thread, message).then((outcome) => {
				if (outcome !== "attempted") {
					thread.messages.splice(thread.messages.indexOf(message), 1);
					sessions.forget(message);
					refuse(submissionProblem(outcome, message), thread);
				}
				if (thread === session.current) ask.refresh();
			});
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
		const selectionByThread = new WeakMap<ReaderThread, number>();
		function openThread(thread: ReaderThread, focus = true, ordinal?: number) {
			if (ordinal === undefined) selectionByThread.delete(thread);
			else selectionByThread.set(thread, ordinal);
			closeReview();
			if (session.current !== thread) {
				discardEmptyComment();
				discardEmptyQuestion();
				refusal = null;
			}
			session.current = thread;
			session.visible = true;
			refreshBatch();
			draw();
			if (focus) card.querySelector("textarea")?.focus({ preventScroll: true });
			if (ordinal !== undefined && thread.comments) {
				const log = card.querySelector(".ask-messages"),
					item = card.querySelector(`[data-comment-ordinal="${ordinal}"]`);
				if (log && item) log.scrollTop += item.getBoundingClientRect().top - log.getBoundingClientRect().top;
			}
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
						selection && controller.doc
							? api.uiLogic.capturePassage(controller.doc.source, selection, currentView(), selection.text)
							: undefined,
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
				refusal = null;
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
				disposed = true;
				for (const fn of off) fn();
				saved.dispose();
				observer.disconnect();
			},
		};
		off.push(
			host.on("beforeDocument", () => !delayedDestinations.length),
			host.on("promptState", receivePrompt),
			controller.on("blocks", installBlocks),
			controller.on("change", (change) => {
				if (!controller.doc) return;
				sessions.change(change.edits, controller.doc.source);
				if (hasPendingPassages(session)) pendingChanged(session);
			}),
			controller.on("ack", onAck),
			controller.on("documentMetadata", onDestination),
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
			controller.on("document", (payload) => installSession(payload, payload.source, payload.meta.digest)),
		);
		function onAck(ack: Record<string, unknown>) {
			const { payload, doc } = controller;
			if (!payload || !doc || delayedDestinations.length) return;
			const digest = ack.generation === doc.generation ? ack.digest : undefined;
			if (payload.meta.documentKey !== session.documentKey) installSession(payload, doc.source, digest);
			updateDigest(digest);
		}
		function updateDigest(digest: unknown) {
			if (typeof digest !== "string" || session.digest === digest) return;
			session.digest = digest;
			if (hasPendingPassages(session)) pendingChanged(session);
			paintPassage();
		}
		function showOwner(owner: ReaderAskDocument) {
			syncOverallField();
			void recovering.open(owner).then(() => showRecoveryWarning(owner));
			void saved.refresh();
			ask.refresh();
		}
		function clearOwnerControls() {
			inspected = null;
			collection = "open";
			ctx.removeNotice("batch-recovery");
		}
		function leaveOwner() {
			clearOwnerControls();
			batchList.hidePopover();
			activity.hidePopover();
			if (document.activeElement instanceof HTMLElement && card.contains(document.activeElement))
				document.activeElement.blur();
		}
		function privateSource(meta: ReaderCoreDocument["meta"]) {
			return meta.kind === "draft" || meta.kind === "localFile";
		}
		function installSession(payload: ReaderCoreDocument, source: string, digest: unknown) {
			closeReview();
			if (session.documentKey !== payload.meta.documentKey) leaveOwner();
			session = sessions.show(payload.meta.documentKey, source, typeof digest === "string" ? digest : undefined);
			localSource = privateSource(payload.meta);
			showOwner(session);
		}
		// Save As replaces the destination of this buffer, not its source editor. Finish a marked
		// Ask input in its original field before carrying any definitely unsent text to the new key.
		const delayedDestinations: ReaderDocumentMetadata[] = [];
		function composingAsk() {
			const target = controller.compositionTarget;
			return target instanceof Node && (card.contains(target) || batchList.contains(target));
		}
		function onDestination(change: ReaderDocumentMetadata) {
			delayedDestinations.push(change);
			if (!composingAsk()) finishDestinations();
		}
		function finishDestinations() {
			if (composingAsk()) return;
			for (const change of delayedDestinations.splice(0)) updateDestination(change);
		}
		function destinationSource(change: ReaderDocumentMetadata) {
			if (
				controller.payload?.presentation === change.presentation &&
				session.documentKey === change.previousDocumentKey
			)
				return controller.doc?.source;
			return undefined;
		}
		function updateDestination(change: ReaderDocumentMetadata) {
			const source = destinationSource(change),
				{ meta } = change;
			if (source === undefined) return;
			const previous = session,
				carry = localSource;
			if (carry) clearOwnerControls();
			else leaveOwner();
			session = sessions.show(meta.documentKey, source, previous.digest);
			if (carry) carryUnsent(previous);
			localSource = privateSource(meta);
			const fresh = currentView();
			if (fresh) sessions.render(fresh);
			showOwner(session);
		}
		function carryUnsent(previous: ReaderAskDocument) {
			const hadBatch = previous.comments.length || previous.parked?.length || previous.overall;
			sessions.moveUnsent(previous, session);
			if (!hadBatch) return;
			pendingChanged(previous);
			pendingChanged(session);
		}
		// The final input event commits marked text before the postponed card redraw.
		let compositionFrame = 0;
		const finishCardInput = () => {
			cancelAnimationFrame(compositionFrame);
			compositionFrame = requestAnimationFrame(() => {
				finishDestinations();
				ask.refresh();
			});
		};
		card.addEventListener("compositionend", finishCardInput);
		batchList.addEventListener("compositionend", finishCardInput);
		off.push(() => {
			card.removeEventListener("compositionend", finishCardInput);
			batchList.removeEventListener("compositionend", finishCardInput);
			cancelAnimationFrame(compositionFrame);
		});
		off.push(host.on("reviewChanged", () => void saved.refresh()));
		if (controller.payload) void saved.refresh();
		const onBatchToggle = (event: ToggleEvent) => {
			const open = event.newState === "open";
			trayOpen.setAttribute("aria-expanded", String(open));
			listRefusal.hidden = true;
			if (open) drawBatchList();
		};
		batchList.addEventListener("beforetoggle", onBatchToggle);
		off.push(() => batchList.removeEventListener("beforetoggle", onBatchToggle));
		const onToggle = (event: ToggleEvent) => {
			if (event.newState === "open") {
				inspected = null;
				collection = "open";
				drawActivity();
			}
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
		observer.observe(tray);
		ask.refresh();
		return ask;
	};
})();
