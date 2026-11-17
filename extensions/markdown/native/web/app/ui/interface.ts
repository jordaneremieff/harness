(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, get, icon } = api.uiDOM;
	api.createUI = (host, controller, editor) => {
		const app = get("#app"),
			page = get("#page"),
			doc = get("#doc"),
			bar = get(".bar"),
			notices = get("#notices"),
			strip = get("#seltools");
		const off: (() => void)[] = [];
		let linkAnchor: { top: number; scrollTop: number } | null = null;
		let toastTimer: ReturnType<typeof setTimeout> | undefined,
			tipTimer: ReturnType<typeof setTimeout> | undefined,
			selection: ReaderSelection | null = null,
			disposed = false;
		const title = button("Document menu", "", () => get("#docmenu").togglePopover(), { className: "title" });
		title.id = "b-title";
		title.setAttribute("aria-haspopup", "menu");
		title.setAttribute("aria-controls", "docmenu");
		const glyph = el("span", { class: "kind", id: "kind", "data-kind": "published" }, icon("doc")),
			name = el("span", { class: "name", id: "doc-title" }, "Markdown Reader");
		title.replaceChildren(glyph, name, icon("chev"));
		const lock = button("Edit", "pen", () => command("toggleLock"), { className: "edit-lock" });
		lock.id = "b-edit";
		lock.dataset.role = "lock";
		lock.setAttribute("aria-pressed", "false");
		lock.lastElementChild?.classList.add("edit-word");
		const outline = button("Contents", "outline", () => command("toggleOutline"), { iconOnly: true, key: "⌃⌘S" });
		outline.id = "b-outline";
		outline.setAttribute("aria-controls", "outline");
		outline.setAttribute("aria-pressed", "true");
		const status = el(
			"span",
			{ class: "status", "data-role": "status", "data-state": "saved", "aria-live": "polite" },
			"Saved",
		);
		const undo = button("Undo", "undo", () => command("undo"), { iconOnly: true, key: "⌘Z" }),
			redo = button("Redo", "redo", () => command("redo"), { iconOnly: true, key: "⇧⌘Z" });
		undo.id = "b-undo";
		redo.id = "b-redo";
		const history = el("span", { class: "history-controls" }, undo, redo);
		const find = button("Find", "search", () => command("find"), { iconOnly: true, key: "⌘F" });
		find.id = "b-find";
		const appearance = button("Text and appearance", "text", () => get("#viewpanel").togglePopover(), {
			iconOnly: true,
			className: "btn-i hide-narrow",
		});
		appearance.id = "b-view";
		const askButton = button("Ask the agent", "ask", () => get("#activity").togglePopover(), {
			iconOnly: true,
			key: "⌥⌘M",
			className: "btn-i agent",
		});
		askButton.id = "b-ask";
		bar.append(
			outline,
			title,
			el("span", { class: "spacer" }),
			status,
			history,
			lock,
			find,
			appearance,
			askButton,
			button("Close", "x", () => void hostCommand("close"), { iconOnly: true }),
		);
		function listen(
			target: EventTarget,
			type: string,
			handler: EventListener,
			options?: AddEventListenerOptions | boolean,
		) {
			target.addEventListener(type, handler, options);
			off.push(() => target.removeEventListener(type, handler, options));
		}
		let headingBlocks: ReaderMappedBlock[] | undefined,
			headingRows: ReaderHeading[] = [];
		function sourceHeadingText(block: ReaderMappedBlock) {
			return controller.doc?.source.slice(block.start, block.end).replace(/^#{1,6}\s+|\s+#+$/gu, "") ?? "";
		}
		function headingRow(block: ReaderMappedBlock): ReaderHeading[] {
			const matches = /^heading([1-6])$/.exec(block.type);
			if (!matches) return [];
			const node = doc.querySelector<HTMLElement>(`[data-block="${CSS.escape(block.key)}"]`);
			const heading = node?.querySelector("h1,h2,h3,h4,h5,h6");
			return [
				{
					level: Number(matches[1]),
					text: heading?.textContent ?? sourceHeadingText(block),
					anchor: heading?.id ?? block.key,
					start: block.start,
				},
			];
		}
		function headings(): ReaderHeading[] {
			if (headingBlocks === controller.blocks) return headingRows;
			headingBlocks = controller.blocks;
			headingRows = controller.blocks.flatMap(headingRow);
			return headingRows;
		}
		async function hostCommand(name: string, args: Record<string, unknown> = {}) {
			try {
				return await host.request("command", { name, args });
			} catch (error) {
				notice(`The action did not complete: ${String(error)}`, "warn");
				return undefined;
			}
		}
		function toast(text: string, action?: { label: string; run: () => void }) {
			clearTimeout(toastTimer);
			const box = get("#toast");
			box.replaceChildren(el("span", {}, text));
			if (action) box.append(button(action.label, "", action.run));
			box.hidden = false;
			if (!document.documentElement.hasAttribute("data-check-mode"))
				toastTimer = setTimeout(() => {
					box.hidden = true;
				}, 2000);
		}
		function removeNotice(id?: string) {
			for (const child of [...notices.children]) if ((child as HTMLElement).dataset.noticeId === id) child.remove();
		}
		function notice(text: string, tone = "info", actions: { label: string; run: () => void }[] = [], id?: string) {
			if (id) removeNotice(id);
			const item = el(
				"div",
				{ class: "notice", "data-role": "notice", "data-tone": tone === "warning" ? "warn" : tone, role: "status" },
				icon({ agent: "spark", draft: "pen" }[tone] ?? "info"),
				el("span", { class: "tx" }, text),
			);
			if (id) item.dataset.noticeId = id;
			const controls = el("span", { class: "acts" });
			for (const action of actions.slice(0, 2))
				controls.append(
					button(action.label, "", () => {
						action.run();
						item.remove();
					}),
				);
			controls.append(button("Dismiss notice", "x", () => item.remove(), { iconOnly: true }));
			item.append(controls);
			notices.append(item);
		}
		const context: ReaderUIContext = {
			host,
			controller,
			editor,
			app,
			page,
			doc,
			headings,
			command,
			hostCommand,
			toast,
			notice,
		};
		const navigation = api.createNavigation(context),
			ask = api.createAskUI(context, navigation),
			views = api.createViewsUI(context, navigation);
		const findbar = get(".find");
		bar.insertBefore(findbar, bar.querySelector(".spacer"));
		function showKind() {
			const meta = controller.payload?.meta;
			if (!meta) return;
			const copy = meta.capturedSource && controller.lock === "writing",
				kind = copy ? "draft" : String(meta.kind ?? "published");
			const title = String(meta.title ?? "Untitled");
			name.textContent = title + (copy ? " (copy)" : "");
			document.title = title;
			glyph.dataset.kind = { localFile: "file" }[kind] ?? kind;
			glyph.replaceChildren(
				icon({ draft: "pen", file: "file", localFile: "file", response: "response", published: "doc" }[kind] ?? "doc"),
			);
			app.toggleAttribute("data-copy", !!copy);
			copyNotice(!!copy);
		}
		function copyNotice(copy: boolean) {
			if (copy)
				notice(
					"You are writing in a copy. The captured source stays as it was.",
					"draft",
					[
						{
							label: "Show original",
							run: () => {
								views.show("review", { against: "base" });
							},
						},
					],
					"captured-copy",
				);
			else removeNotice("captured-copy");
		}
		function saveStatus(state: string) {
			const label =
				(
					{ saving: "Saving", saved: "Saved", retrying: "Kept on this Mac", conflict: "Kept on this Mac" } as Record<
						string,
						string
					>
				)[state] ?? "Saved";
			status.dataset.state = state;
			status.replaceChildren(icon(state === "saved" ? "check" : "info"), el("span", { class: "save-word" }, label));
			status.setAttribute("aria-label", label);
		}
		function lockState() {
			const writing = controller.lock === "writing";
			app.dataset.mode = controller.lock;
			lock.setAttribute("aria-pressed", String(writing));
			lock.setAttribute("aria-label", writing ? "Done" : "Edit");
			const word = lock.querySelector(".edit-word");
			if (word) word.textContent = writing ? "Done" : "Edit";
			showKind();
			hideSelection();
		}
		function historyLabel(description: { origin: "person" | "agent" | "history"; blockStart: number } | null, verb: string) {
			if (!description) return verb;
			const section = headings().findLast((h) => h.start <= description.blockStart)?.text ?? "this passage";
			const change = description.origin === "agent" ? "the agent's change" : description.origin === "person" ? "your edit" : "the change";
			return `${verb} ${change} in ${section}`;
		}
		function historyState() {
			const next = controller.nextHistory();
			undo.disabled = !next.undo;
			redo.disabled = !next.redo;
			undo.dataset.tip = historyLabel(next.undo, "Undo");
			redo.dataset.tip = historyLabel(next.redo, "Redo");
			undo.setAttribute("aria-label", undo.dataset.tip);
			redo.setAttribute("aria-label", redo.dataset.tip);
			history.hidden = controller.lock === "reading" && !next.undo && !next.redo;
		}
		function copyPassage() {
			const selected = editor.selection() ?? selection;
			if (!selected || !controller.doc) {
				toast("Select a passage first");
				return;
			}
			const meta = controller.payload?.meta ?? { capturedSource: false },
				source = controller.doc.source,
				first = source.slice(0, selected.start).split(/\r\n|\r|\n/u).length,
				last = source.slice(0, selected.end).split(/\r\n|\r|\n/u).length,
				section = headings()
					.filter((h) => h.start <= selected.start)
					.map((h) => h.text)
					.join(" › ");
			const ref = `Source: ${String(meta.documentId ?? meta.shortId ?? "document")}, revision ${String(meta.revision ?? "draft")}, digest ${String(meta.digest ?? "not supplied")}\n${section ? `${section}\n` : ""}Source lines ${first}–${last}; UTF-16 ${selected.start}–${selected.end}`;
			void hostCommand("copy", { text: `${selected.text}\n\n${ref}` });
			toast("Copied passage with source");
		}
		function hideSelection() {
			strip.removeAttribute("data-open");
		}
		function editSelection(format?: string) {
			const selected = editor.selection() ?? selection;
			if (!selected) return false;
			const block = controller.blocks.find((b) => b.start <= selected.start && b.end >= selected.start);
			if (!block) return false;
			const oneOff = controller.lock === "reading";
			controller.setLock("writing");
			const map = new api.exact.LineMap(controller.doc?.source.slice(block.start, block.end) ?? "");
			const at = api.sourceModel.sourceToDisplay(map, selected.start - block.start);
			const opened = editor.open(block.key, at, { oneOff, selection: { start: selected.start, end: selected.end } });
			if (format && opened) editor.format(format);
			hideSelection();
			return opened;
		}
		function selectionButtons(selected: ReaderSelection) {
			strip.replaceChildren(
				button("Ask", "spark", () => ask.open(selected), { className: "ask" }),
				el("span", { class: "sep" }),
				button("Copy with source", "copy", copyPassage, { className: "copy-selection" }),
			);
			if (controller.lock === "reading") {
				strip.append(button("Edit", "pen", () => editSelection(), { className: "selection-edit" }));
				return;
			}
			if (!controller.blocks.some((b) => b.start <= selected.start && b.end >= selected.end)) return;
			for (const [format, key] of [
				["bold", "⌘B"],
				["italic", "⌘I"],
				["code", "⇧⌘K"],
				["link", "⌘K"],
			])
				strip.append(
					button(format[0].toUpperCase() + format.slice(1), format, () => editSelection(format), {
						iconOnly: true,
						key,
					}),
				);
		}
		function selectionTools(selected: ReaderSelection | null) {
			selection = selected;
			if (!selected) {
				hideSelection();
				return;
			}
			const s = getSelection();
			if (!s?.rangeCount || !doc.contains(s.getRangeAt(0).commonAncestorContainer)) return;
			const range = s.getRangeAt(0),
				rect = range.getBoundingClientRect(),
				box = app.getBoundingClientRect();
			if (rect.bottom < box.top + 46 || rect.top > box.bottom) {
				hideSelection();
				return;
			}
			selectionButtons(selected);
			strip.setAttribute("data-open", "");
			strip.dataset.ctx = controller.blocks.some((b) => b.start <= selected.start && b.end >= selected.end)
				? "rendered"
				: "multi";
			strip.style.left = `${Math.max(8, Math.min(rect.left - box.left + rect.width / 2 - strip.offsetWidth / 2, box.width - strip.offsetWidth - 8))}px`;
			strip.style.top = `${Math.max(50, rect.top - box.top - strip.offsetHeight - 10)}px`;
		}
		function command(name: string, args: Record<string, unknown> = {}) {
			const local: Record<string, () => void> = {
				toggleLock: () =>
					controller.setLock(
						args.lock === "writing"
							? "writing"
							: args.lock === "reading"
								? "reading"
								: controller.lock === "reading"
									? "writing"
									: "reading",
					),
				toggleOutline: () => navigation.toggleOutline(),
				find: () => navigation.find(args),
				replace: () => navigation.find({ ...args, replace: true }),
				findNext: () => navigation.findNext(1),
				findPrevious: () => navigation.findNext(-1),
				undo: () => {
					const result = controller.undo();
					if (result?.status === "blocked")
						notice("A later edit overlaps this change. The document stays as it is.", "warn");
				},
				redo: () => { controller.redo(); },
				format: () => {
					if (controller.lock === "writing") editor.format(args as { command: string; level?: number });
				},
				askSelection: () => ask.open(editor.selection()),
				askDocument: () => ask.open(),
				copyMarkdown: () => {
					void hostCommand("copy", { text: controller.doc?.source ?? "", markdown: true });
					toast("Copied Markdown");
				},
				copyPassage,
				open: () => views.open(),
				showReview: () =>
					views.show("review", {
						against:
							args.against ??
							(controller.payload?.meta.kind === "draft" || controller.payload?.meta.capturedSource
								? "base"
								: "previous"),
					}),
				showDetails: () => views.show("details"),
				showSource: () => views.show("source"),
				showLibrary: () => views.show("library"),
				inspectImage: () => views.show("image", args),
				imageZoom: () => views.imageZoom(String(args.mode ?? "fit")),
				zoomIn: () => views.textZoom(0.05),
				zoomOut: () => views.textZoom(-0.05),
				zoomReset: () => views.textZoom(null),
				back: () => navigation.back(),
				forward: () => navigation.back(true),
				latest: () => {
					void hostCommand("showRevision", { n: "latest" });
				},
				selectAll: () => {
					const range = document.createRange();
					range.selectNodeContents(doc);
					const selected = getSelection();
					selected?.removeAllRanges();
					selected?.addRange(range);
				},
				escape: () => {
					if (controller.doc?.active) {
						editor.close();
						get("#linkcard").hidden = true;
						return;
					}
					for (const layer of document.querySelectorAll<HTMLElement>("[popover]:popover-open")) {
						layer.hidePopover();
						return;
					}
					if (views.close() || ask.close() || navigation.closeSheet() || navigation.closeFind()) return;
					void hostCommand("returnFocus");
				},
			};
			local[name]?.();
		}
		function codeControls() {
			for (const block of doc.querySelectorAll<HTMLElement>("[data-block]")) {
				if (block.dataset.role === "block-editor") continue;
				const pre = block.querySelector("pre");
				if (!pre || block.querySelector('[data-role="code-copy"]')) continue;
				const code = pre.querySelector("code"),
					text = code?.textContent ?? pre.textContent ?? "";
				const b = button(
					"Copy code",
					"copy",
					() => {
						const value = text.replace(/\n$/u, "");
						const source = controller.doc?.source ?? "";
						void hostCommand("copy", {
							text: source.includes("\r\n") && !/(?<!\r)\n/u.test(source) ? value.replaceAll("\n", "\r\n") : value,
						});
						toast("Copied code");
					},
					{ className: "copy code-copy" },
				);
				b.dataset.role = "code-copy";
				b.dataset.blockStart = block.dataset.start;
				b.setAttribute("data-reader-control", "");
				b.addEventListener("click", (event) => event.stopPropagation());
				pre.append(b);
			}
		}
		function claims() {
			for (const node of doc.querySelectorAll<HTMLElement>("[data-claim-label]")) {
				node.removeAttribute("data-claim-label");
				node.classList.remove("agent-claimed");
			}
			const ranges: Range[] = [];
			for (const claim of controller.claims.values())
				ranges.push(...claim.ranges.flatMap((range) => paintClaim(range, claim.label)));
			editor.highlight("agent-claim", ranges);
		}
		function paintClaim(range: ReaderRange, label?: string): Range[] {
			const block = [...doc.children].find(
				(n) =>
					Number((n as HTMLElement).dataset.start) <= range.start &&
					Number((n as HTMLElement).dataset.end) >= range.start,
			) as HTMLElement | undefined;
			if (!block || block.dataset.role === "block-editor") return [];
			block.classList.add("agent-claimed");
			block.dataset.claimLabel = label ?? "Agent is working here";
			const painted = document.createRange();
			painted.selectNodeContents(block);
			return [painted];
		}
		listen(strip, "pointerdown", (event) => event.preventDefault());
		listen(
			document,
			"keydown",
			((event: KeyboardEvent) => {
				if (event.defaultPrevented) return;
				const target = event.target as HTMLElement | null,
					input = !!target?.closest("input,textarea,select");
				const found = api.uiLogic.keyCommand(event, { writing: controller.lock === "writing", input });
				if (!found) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				command(found.name, found.args);
			}) as EventListener,
			true,
		);
		listen(
			page,
			"scroll",
			() => {
				hideSelection();
				const card = get("#linkcard");
				if (card.hidden || !linkAnchor) return;
				const top = linkAnchor.top + linkAnchor.scrollTop - page.scrollTop;
				card.hidden = top < 50 || top + card.offsetHeight > app.clientHeight - 8;
				card.style.top = `${top}px`;
			},
			{ passive: true },
		);
		listen(
			doc,
			"click",
			((event: MouseEvent) => {
				const target = event.target as Element,
					image = target.closest<HTMLImageElement>("img");
				if (image && !target.closest("a")) {
					event.preventDefault();
					event.stopImmediatePropagation();
					const images = [...doc.querySelectorAll("img")];
					views.show("image", { index: images.indexOf(image) });
				}
				const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
				if (link && controller.lock === "reading") {
					event.preventDefault();
					event.stopImmediatePropagation();
					const id = decodeURIComponent(link.hash.slice(1)),
						element = document.getElementById(id);
					if (element) navigation.jumpElement(element);
				}
			}) as EventListener,
			true,
		);
		listen(document, "pointerover", ((event: PointerEvent) => {
			const target = (event.target as Element).closest<HTMLElement>("[data-tip]");
			if (!target) return;
			clearTimeout(tipTimer);
			tipTimer = setTimeout(
				() => {
					const tip = get("#tip"),
						r = target.getBoundingClientRect();
					tip.replaceChildren(el("span", {}, target.dataset.tip ?? ""));
					if (target.dataset.key) tip.append(el("kbd", {}, target.dataset.key));
					tip.hidden = false;
					tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8))}px`;
					tip.style.top = `${Math.min(innerHeight - tip.offsetHeight - 8, r.bottom + 7)}px`;
				},
				document.documentElement.hasAttribute("data-check-mode") ? 0 : 550,
			);
		}) as EventListener);
		listen(document, "pointerout", () => {
			clearTimeout(tipTimer);
			get("#tip").hidden = true;
		});
		off.push(
			controller.on("lock", () => {
				lockState();
				historyState();
			}),
			controller.on("history", historyState),
			controller.on("change", (change) => {
				get("#linkcard").hidden = true;
				if (!change.historyAction) return;
				const description = { origin: change.origin, blockStart: change.edits[0]?.start ?? 0 };
				toast(historyLabel(description, change.historyAction === "redo" ? "Redid" : "Undid"));
			}),
			controller.on("selection", selectionTools),
			controller.on("view", () => {
				codeControls();
				claims();
			}),
			controller.on("claims", claims),
			controller.on("ack", showKind),
			controller.on("command", (m) => command(m.name, m.args)),
			controller.on("error", (error) => notice(`The reader did not complete the change: ${String(error)}`, "warn")),
			controller.on("notice", (m) =>
				notice(
					m.text,
					m.tone,
					m.actions?.map((action) => ({
						label: action.label,
						run: () => {
							if (action.id === "releaseHold") editor.releaseHold();
							else void hostCommand(action.id);
						},
					})),
				),
			),
			controller.on("document", () => {
				get("#linkcard").hidden = true;
				linkAnchor = null;
				notices.replaceChildren();
				selection = null;
				saveStatus("saved");
				codeControls();
			}),
		);
		off.push(
			host.on("saveState", (value) => {
				const msg = value as { state: string; detail?: string };
				saveStatus(msg.state);
				if (msg.state === "conflict")
					notice(
						msg.detail ?? "The file changed where you edited. Your version is kept; the other version is a draft.",
						"warn",
						[{ label: "Show other version", run: () => views.open() }],
						"conflict",
					);
			}),
			controller.on("link", (value) => {
				if (!value.href) return;
				const card = get("#linkcard");
				card.replaceChildren(
					el("span", {}, value.href),
					button("Open", "", () => {
						void hostCommand("openLink", { href: value.href });
					}),
				);
				const r = value.element.getBoundingClientRect(),
					box = app.getBoundingClientRect();
				card.hidden = false;
				card.style.left = `${Math.max(12, Math.min(r.left - box.left, box.width - card.offsetWidth - 12))}px`;
				const top = Math.max(50, r.top - box.top - card.offsetHeight - 8);
				linkAnchor = { top, scrollTop: page.scrollTop };
				card.style.top = `${top}px`;
			}),
		);
		historyState();
		return {
			command,
			dispose() {
				if (disposed) return;
				disposed = true;
				for (const fn of off) fn();
				navigation.dispose();
				ask.dispose();
				views.dispose();
				clearTimeout(toastTimer);
				clearTimeout(tipTimer);
			},
		};
	};
})();
