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
			const state = activeMessage(thread)?.state;
			return !!state && !["answered", "failed"].includes(state);
		}
		function blockAt(start: number) {
			return [...doc.children].find(
				(n) => Number((n as HTMLElement).dataset.start) <= start && Number((n as HTMLElement).dataset.end) >= start,
			) as HTMLElement | undefined;
		}
		function rangeFor(range?: ReaderRange) {
			if (!range) return null;
			const start = blockAt(range.start);
			if (!start) return null;
			const r = document.createRange();
			r.selectNodeContents(start);
			return r;
		}
		function position() {
			if (!visible) return;
			const box = app.getBoundingClientRect();
			if (box.width < 560) {
				card.style.left = "";
				card.style.top = "";
				return;
			}
			const rect = rangeFor(current?.range)?.getBoundingClientRect() ?? get("#b-ask").getBoundingClientRect();
			const width = card.offsetWidth,
				height = card.offsetHeight;
			card.style.left = `${Math.max(12, Math.min(rect.left - box.left, box.width - width - 12))}px`;
			let top = rect.bottom - box.top + 10;
			if (top + height > box.height - 12 && rect.top - box.top - height - 10 > 56)
				top = rect.top - box.top - height - 10;
			card.style.top = `${Math.max(56, Math.min(top, box.height - height - 12))}px`;
		}
		function paintPassage() {
			const range = visible ? rangeFor(current?.range) : null;
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
				placeholder: followUp ? "Follow up in this conversation" : "Ask about this passage or ask for a change",
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
		function draw() {
			if (!current || !visible) {
				card.removeAttribute("data-open");
				paintPassage();
				return;
			}
			const thread = current,
				focused =
					document.activeElement instanceof HTMLTextAreaElement && card.contains(document.activeElement)
						? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
						: null;
			card.replaceChildren();
			card.dataset.state = activeMessage(thread)?.state ?? "draft";
			card.toggleAttribute("data-collapsed", thread.collapsed);
			card.setAttribute("data-open", "");
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
			card.append(head);
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
			const message = activeMessage(thread),
				ops = operations(thread),
				changeCount = ops.reduce((n, op) => n + op.edits.length, 0);
			if (message) {
				const status = el(
					"div",
					{ class: `ask-status${message.state === "failed" ? " fail" : ""}`, role: "status" },
					icon(message.state === "failed" ? "info" : message.state === "answered" ? "check" : "spark"),
					el(
						"span",
						{},
						changeCount
							? `Changed ${changeCount} ${changeCount === 1 ? "passage" : "passages"}`
							: api.uiLogic.promptLabel(message.state),
					),
				);
				card.append(status);
				const log = el("div", { class: "ask-messages" });
				for (const m of thread.messages) {
					log.append(el("div", { class: "ask-question" }, el("span", { class: "from" }, "You"), m.text));
					if (m.state === "answered" && m.detail)
						log.append(
							el("div", { class: "reply" }, el("span", { class: "from" }, "Agent · in the conversation"), m.detail),
						);
				}
				card.append(log);
				if (changeCount)
					card.append(
						el(
							"div",
							{ class: "ask-actions" },
							action("Show changes", () => ask.showChanges(ops.at(-1)?.operationId)),
							action("Undo", () => undo(ops.at(-1)?.operationId)),
						),
					);
				if (message.state === "failed") {
					card.append(
						el(
							"p",
							{ class: "send-failure" },
							"Not sent: the conversation did not accept the message. Your text is kept.",
						),
						action("Retry", () => void sendMessage(message)),
					);
				}
				if (message.state === "unknown")
					card.append(
						el(
							"p",
							{ class: "send-failure" },
							"Delivery is not confirmed. Your text is kept. The reader will not send it twice.",
						),
					);
			}
			card.append(composer(thread, !!message));
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
		async function sendMessage(retry?: ReaderAskMessage) {
			const thread = current;
			if (!thread || (!retry && !thread.draft.trim()) || (!retry && pending(thread))) return;
			const message = retry ?? {
				requestId: crypto.randomUUID(),
				text: thread.draft,
				state: "sending" as ReaderAskState,
			};
			if (!thread.threadId) thread.threadId = message.requestId;
			if (!retry) {
				thread.messages.push(message);
				thread.draft = "";
				payloads.set(message.requestId, {
					requestId: message.requestId,
					threadId: thread.threadId,
					text: message.text,
					...(thread.quote ? { quote: thread.quote } : {}),
					...(thread.range ? { quoteRange: thread.range } : {}),
					generation: controller.doc?.generation ?? 0,
				});
			}
			message.state = "sending";
			draw();
			ask.refresh();
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
			ask.refresh();
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
			for (const block of doc.querySelectorAll(".has-diff")) block.classList.remove("has-diff");
		}
		function drawDiff() {
			clearDiff();
			if (!operationId) return;
			const operation = controller.agentOperations.get(operationId);
			if (!operation) return;
			changeIndex = Math.min(changeIndex, operation.edits.length - 1);
			const edit = operation.edits[changeIndex],
				block = edit ? blockAt(edit.start) : undefined;
			if (!block || !edit) return;
			const diff = el("section", { class: "inline-diff", "data-reader-control": "", "aria-label": "Agent change" }),
				body = el("div", { class: "diff-words" });
			for (const part of api.uiLogic.diffWords(edit.oldText, edit.newText))
				body.append(el(part.kind === "removed" ? "del" : part.kind === "added" ? "ins" : "span", {}, part.text));
			diff.append(
				el(
					"div",
					{ class: "diff-head" },
					el("span", {}, `Change ${changeIndex + 1} of ${operation.edits.length}`),
					action("Previous", () => {
						changeIndex = (changeIndex - 1 + operation.edits.length) % operation.edits.length;
						drawDiff();
						const current = doc.querySelector(".inline-diff");
						if (current) navigation.jumpElement(current);
					}),
					action("Next", () => {
						changeIndex = (changeIndex + 1) % operation.edits.length;
						drawDiff();
						const current = doc.querySelector(".inline-diff");
						if (current) navigation.jumpElement(current);
					}),
					action("Undo", () => undo(operation.operationId)),
					button(
						"Close changes",
						"x",
						() => {
							operationId = null;
							clearDiff();
						},
						{ iconOnly: true },
					),
				),
				body,
			);
			diff.addEventListener("click", (event) => event.stopPropagation());
			block.classList.add("has-diff");
			block.append(diff);
		}
		function markers() {
			for (const marker of doc.querySelectorAll(".change-marker")) marker.remove();
			for (const op of controller.agentOperations.values()) {
				if (!op.unread) continue;
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
