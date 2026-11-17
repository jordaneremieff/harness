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
		let current: ReaderThread | null = null,
			visible = false,
			changeIndex = 0,
			operationId: string | null = null;
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
		function revealPassage(limit: number) {
			const rect = rangeFor(threadRange())?.getBoundingClientRect();
			if (!rect) return;
			const top = app.getBoundingClientRect().top + 64;
			if (rect.height > limit - top) {
				page.scrollTop += rect.top - top;
				return;
			}
			if (rect.bottom > limit) page.scrollTop += rect.bottom - limit;
			if (rect.top < top) page.scrollTop += rect.top - top;
		}
		function cardAnchorRect() {
			const anchor = current?.collapsed ? doc.querySelector(".inline-diff") : rangeFor(threadRange());
			return anchor?.getBoundingClientRect() ?? get("#b-ask").getBoundingClientRect();
		}
		function position() {
			if (!visible) return;
			const box = app.getBoundingClientRect();
			if (box.width < 560) {
				card.style.left = "";
				card.style.top = "";
				if (!current?.collapsed) revealPassage(card.getBoundingClientRect().top - 12);
				return;
			}
			const rect = cardAnchorRect();
			const width = card.offsetWidth,
				height = card.offsetHeight;
			card.style.left = `${Math.max(12, Math.min(rect.left - box.left, box.width - width - 12))}px`;
			const top = cardTop(rect, box, height);
			card.style.top = `${top}px`;
			// The collapsed card never covers the change panel it summarises; where no free
			// place exists it steps aside until the panel scrolls or closes.
			card.style.visibility = current?.collapsed && overlapsPanel(top + box.top, height) ? "hidden" : "";
		}
		function cardTop(rect: DOMRect, box: DOMRect, height: number) {
			let top = rect.bottom - box.top + 10;
			if (top + height > box.height - 12 && rect.top - box.top - height - 10 > 56)
				top = rect.top - box.top - height - 10;
			return Math.max(56, Math.min(top, box.height - height - 12));
		}
		function overlapsPanel(top: number, height: number) {
			const panel = doc.querySelector(".inline-diff")?.getBoundingClientRect();
			return !!panel && top < panel.bottom && top + height > panel.top;
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
				button(
					"Ask about the selection",
					"quote",
					() => {
						activity.hidePopover();
						ask.open(editor.selection());
					},
					{ className: "item" },
				),
				el("div", { class: "sep" }),
			);
			if (!threads.length) activity.append(el("div", { class: "sec" }, "Select a passage and choose Ask."));
			for (const thread of threads) {
				const b = button(
					"",
					"spark",
					() => {
						current = thread;
						visible = true;
						thread.collapsed = false;
						draw();
						activity.hidePopover();
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
			const head = el(
				"div",
				{ class: "ask-head" },
				el("span", { class: "kind" }, icon("spark")),
				el("span", { class: "who" }, thread.collapsed ? "Changes in this passage" : "Ask the agent"),
				button("Close question", "x", () => ask.close(), { iconOnly: true, key: "esc" }),
			);
			if (thread.collapsed)
				head.insertBefore(
					action("Question", () => {
						thread.collapsed = false;
						draw();
					}),
					head.lastChild,
				);
			return head;
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
				id = ops.at(-1)?.operationId;
			card.append(drawStatus(message, changeCount), drawMessages(thread));
			if (changeCount)
				card.append(
					el(
						"div",
						{ class: "ask-actions" },
						action("Show changes", () => ask.showChanges(id)),
						action("Undo", () => undo(id)),
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
			card.toggleAttribute("data-collapsed", thread.collapsed);
			card.setAttribute("data-open", "");
			card.append(drawHead(thread));
			if (thread.collapsed) {
				position();
				return;
			}
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
		async function sendMessage(retry?: ReaderAskMessage) {
			const thread = current;
			if (!thread) return;
			if (!retry && (!thread.draft.trim() || pending(thread))) return;
			const message = retry ?? {
				requestId: crypto.randomUUID(),
				text: thread.draft,
				state: "sending" as ReaderAskState,
			};
			if (!thread.threadId) thread.threadId = message.requestId;
			if (!retry) {
				thread.messages.push(message);
				thread.draft = "";
				payloads.set(message.requestId, promptPayload(thread, message));
			}
			message.state = "sending";
			draw();
			ask.refresh();
			await deliverMessage(message);
			ask.refresh();
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
		function undo(id?: string) {
			if (!id) return;
			const operation = controller.agentOperations.get(id),
				result = controller.undoAgent(id);
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
			for (const diff of doc.querySelectorAll(".inline-diff")) diff.remove();
			for (const block of doc.querySelectorAll(".has-diff,.diff-continuation"))
				block.classList.remove("has-diff", "diff-continuation");
		}
		function moveChange(delta: number, total: number) {
			changeIndex = (changeIndex + delta + total) % total;
			drawDiff();
			const diff = doc.querySelector(".inline-diff");
			if (diff) navigation.jumpElement(diff);
		}
		function diffBody(edit: { oldText: string; newText: string }) {
			const body = el("div", { class: "diff-words" });
			for (const part of api.uiLogic.diffWords(edit.oldText, edit.newText))
				body.append(
					el(
						({ removed: "del", added: "ins", same: "span" } as Record<string, keyof HTMLElementTagNameMap>)[
							part.kind
						] ?? "span",
						{},
						part.text,
					),
				);
			return body;
		}
		function changeBlocks(edit: ReaderRange) {
			const blocks = [...doc.children] as HTMLElement[];
			const first = blockAt(edit.start) ?? blocks.find((node) => Number(node.dataset.start) >= edit.start) ?? blocks.at(-1);
			if (!first) return [];
			return [first, ...blocks.filter((node) => node !== first && Number(node.dataset.start) < edit.end && Number(node.dataset.end) > edit.start)];
		}
		function diffTarget(operation: ReaderAgentOperation) {
			const edit = operation.edits[changeIndex];
			if (!edit || !controller.doc) return null;
			const blocks = changeBlocks(edit), block = blocks[0];
			if (!block) return null;
			const context = operation.conflicted ? null : api.uiLogic.changeContext(controller.doc.source, {
				start: Number(block.dataset.start), end: Number(blocks.at(-1)?.dataset.end),
			}, edit);
			return { blocks, block, context, edit };
		}
		function mountDiff(diff: HTMLElement, target: NonNullable<ReturnType<typeof diffTarget>>) {
			if (target.context) {
				target.block.classList.add("has-diff");
				for (const next of target.blocks.slice(1)) next.classList.add("diff-continuation");
			}
			target.block.append(diff);
		}
		// Redrawing replaces the panel's buttons; an unchanged panel stays in place, so a
		// redraw between a press and its release never swallows the click.
		function diffSignature(operation: ReaderAgentOperation, target: NonNullable<ReturnType<typeof diffTarget>>) {
			return JSON.stringify([operation.operationId, changeIndex, operation.conflicted, target.block.dataset.block, target.context ?? target.edit]);
		}
		function diffMounted(operation: ReaderAgentOperation, target: ReturnType<typeof diffTarget>) {
			const mounted = doc.querySelector<HTMLElement>(".inline-diff");
			return !!target && !!mounted && mounted.dataset.signature === diffSignature(operation, target) && target.block.contains(mounted);
		}
		function conflictWarning() {
			return el("p", { class: "diff-warning" }, "Original agent change. Later edits overlap this passage.");
		}
		function diffPanel(operation: ReaderAgentOperation, target: NonNullable<ReturnType<typeof diffTarget>>) {
			const diff = el("section", { class: "inline-diff", "data-reader-control": "", "aria-label": "Agent change" });
			const close = button(
				"Close changes",
				"x",
				() => {
					operationId = null;
					clearDiff();
				},
				{ iconOnly: true },
			);
			diff.append(
				el(
					"div",
					{ class: "diff-head" },
					el("span", {}, `Change ${changeIndex + 1} of ${operation.edits.length}`),
					action("Previous", () => moveChange(-1, operation.edits.length)),
					action("Next", () => moveChange(1, operation.edits.length)),
					action("Undo", () => undo(operation.operationId)),
					close,
				),
				diffBody(target.context ?? target.edit),
			);
			diff.dataset.signature = diffSignature(operation, target);
			diff.addEventListener("click", (event) => event.stopPropagation());
			if (operation.conflicted) diff.prepend(conflictWarning());
			return diff;
		}
		function drawDiff() {
			const operation = operationId ? controller.agentOperations.get(operationId) : undefined;
			if (!operation) {
				clearDiff();
				return;
			}
			changeIndex = Math.min(changeIndex, operation.edits.length - 1);
			const target = diffTarget(operation);
			if (diffMounted(operation, target)) return;
			clearDiff();
			if (!target) return;
			mountDiff(diffPanel(operation, target), target);
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
			open(selection) {
				current = {
					threadId: "",
					quote: selection?.text,
					range: selection ? { start: selection.start, end: selection.end } : undefined,
					draft: "",
					messages: [],
					collapsed: false,
				};
				threads.unshift(current);
				visible = true;
				draw();
				card.querySelector("textarea")?.focus({ preventScroll: true });
			},
			close() {
				if (!visible) return false;
				visible = false;
				card.removeAttribute("data-open");
				paintPassage();
				return true;
			},
			refresh() {
				drawActivity();
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
				operationId = id ?? [...controller.agentOperations.keys()].at(-1) ?? null;
				changeIndex = 0;
				if (!operationId) return;
				const operation = controller.agentOperations.get(operationId);
				if (!operation) return;
				editor.close();
				controller.markRead(operationId);
				get("#notices").querySelector(`[data-notice-id="${CSS.escape(`agent-${operationId}`)}"]`)?.remove();
				if (current && visible) current.collapsed = true;
				drawDiff();
				const diff = doc.querySelector(".inline-diff");
				if (diff) navigation.jumpElement(diff);
				draw();
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
				operationId = null;
				clearDiff();
			}),
		);
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
