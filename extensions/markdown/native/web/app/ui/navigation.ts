(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, get } = api.uiDOM;
	api.createNavigation = (ctx) => {
		const { app, page, doc, controller, editor } = ctx,
			toc = get("#outline");
		const filter = el("input", {
			placeholder: "Filter headings",
			"aria-label": "Filter headings",
			autocomplete: "off",
		});
		const count = el("span", { class: "count" }),
			rows = el("div", { class: "toc" });
		toc.append(
			el("div", { class: "outline-head" }, el("span", { class: "label" }, "Contents"), count),
			el("label", { class: "filter" }, api.uiDOM.icon("search"), filter),
			rows,
		);
		const field = el("input", {
			"data-role": "find-field",
			placeholder: "Find in document",
			"aria-label": "Find in document",
			autocomplete: "off",
			spellcheck: "false",
		});
		const status = el("span", { class: "count", "data-role": "find-status", "aria-live": "polite" });
		const replacement = el("input", { placeholder: "Replace with", "aria-label": "Replace with", autocomplete: "off" });
		const findbar = el(
			"div",
			{ class: "find", role: "search" },
			el("label", { class: "field" }, api.uiDOM.icon("search"), field, status),
			button("Previous match", "up", () => nav.findNext(-1), { iconOnly: true, key: "⇧⌘G" }),
			button("Next match", "down", () => nav.findNext(1), { iconOnly: true, key: "⌘G" }),
			button(
				"Replace",
				"replace",
				() => {
					app.toggleAttribute("data-replace");
					controller.state();
				},
				{ iconOnly: true, key: "⌥⌘F" },
			),
			el(
				"label",
				{ class: "field replace" },
				replacement,
				button("Replace all", "", () => nav.replace()),
			),
			button("Close find", "x", () => nav.closeFind(), { iconOnly: true, key: "esc" }),
		);
		get(".bar").append(findbar);
		let matches: ReturnType<ReaderEditor["find"]> = [],
			index = 0,
			findOpen = false,
			hover = false;
		let pendingPosition: { blockStart: number; offsetY: number } | null = null;
		let history: { blockStart: number; offsetY: number; scrollTop: number }[] = [],
			cursor = -1;
		const off: (() => void)[] = [];
		function listen(target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions) {
			target.addEventListener(type, fn, options);
			off.push(() => target.removeEventListener(type, fn, options));
		}
		function narrow() {
			return app.clientWidth < 720;
		}
		let blockElements = new Map<number, HTMLElement>();
		function block(start: number) {
			return blockElements.get(start) ?? [...blockElements.values()].find((node) => Number(node.dataset.end) >= start);
		}
		function overlayBody() {
			return get("#overlay").querySelector<HTMLElement>(".review-doc,.source-text");
		}
		function overlayMatches(query: string) {
			const root = overlayBody();
			if (!root || !query) return [];
			const source = api.sourceModel
					.textNodes(root)
					.map((node) => node.data)
					.join(""),
				text = source.toLocaleLowerCase(),
				needle = query.toLocaleLowerCase(),
				found: ReturnType<ReaderEditor["find"]> = [];
			let at = text.indexOf(needle);
			while (at >= 0) {
				const start = api.sourceModel.point(root, at),
					end = api.sourceModel.point(root, at + needle.length),
					range = document.createRange();
				range.setStart(start.node, start.offset);
				range.setEnd(end.node, end.offset);
				found.push({ key: "overlay", start: at, end: at + needle.length, ranges: [range] });
				at = text.indexOf(needle, at + needle.length);
			}
			return found;
		}
		function findScroll(range: Range) {
			if (overlayBody()) {
				range.startContainer.parentElement?.scrollIntoView({ block: "center" });
				return;
			}
			saveJump();
			const rect = range.getBoundingClientRect();
			page.scrollTop += rect.top - page.getBoundingClientRect().top - page.clientHeight * 0.35;
			finishJump();
		}
		function position() {
			const top = page.getBoundingClientRect().top + 46;
			const node = [...doc.children].find((n) => n.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
			return {
				blockStart: Number(node?.dataset.start ?? 0),
				offsetY: (node?.getBoundingClientRect().top ?? top) - top,
				scrollTop: page.scrollTop,
			};
		}
		function restore(p: { blockStart: number; offsetY: number; scrollTop: number }) {
			const target = block(p.blockStart);
			if (target)
				page.scrollTop += target.getBoundingClientRect().top - page.getBoundingClientRect().top - 46 - p.offsetY;
			else page.scrollTop = p.scrollTop;
			nav.updateCurrent();
		}
		function saveJump() {
			const p = position();
			if (cursor < 0) {
				history = [p];
				cursor = 0;
			} else {
				history[cursor] = p;
				history = history.slice(0, cursor + 1);
			}
		}
		function finishJump() {
			history.push(position());
			if (history.length > 21) history.shift();
			cursor = history.length - 1;
			drawBack();
		}
		function drawBack() {
			controller.state({ canBack: cursor > 0, canForward: cursor >= 0 && cursor < history.length - 1 });
			const root = get("#jumps");
			root.replaceChildren();
			if (cursor > 0) root.append(button("Back", "back", () => nav.back(), { className: "back" }));
			if (cursor >= 0 && cursor < history.length - 1)
				root.append(button("Forward", "forward", () => nav.back(true), { className: "back" }));
		}
		function sectionHits() {
			const counts = new Map<number, number>(),
				hs = ctx.headings(),
				byKey = new Map(controller.blocks.map((b) => [b.key, b]));
			for (const match of matches) {
				const b = byKey.get(match.key);
				if (!b) continue;
				const h = hs.findLast((h) => h.start <= b.start);
				if (h) counts.set(h.start, (counts.get(h.start) ?? 0) + 1);
			}
			return counts;
		}
		function hitCounts() {
			const counts = sectionHits();
			for (const row of rows.querySelectorAll<HTMLElement>("[data-heading-start]")) {
				const hits = counts.get(Number(row.dataset.headingStart));
				const num = row.querySelector(".n");
				if (num) num.textContent = findOpen && hits ? String(hits) : "";
				row.toggleAttribute("data-hits", findOpen && !!hits);
			}
		}
		function publishFind() {
			controller.state({
				findOpen,
				...(findOpen ? { find: { query: field.value, count: matches.length, index } } : { find: undefined }),
			});
		}
		function paintFind(scroll = false) {
			editor.highlight(
				"find",
				matches.flatMap((m) => m.ranges),
			);
			editor.highlight("find-current", matches[index]?.ranges ?? []);
			status.textContent = field.value ? api.uiLogic.findStatus(matches.length, index) : "";
			status.classList.toggle("none", !!field.value && !matches.length);
			hitCounts();
			publishFind();
			if (scroll && matches[index]) {
				const range = matches[index].ranges[0];
				if (range) {
					findScroll(range);
				}
			}
		}
		function setWidth(width: number, save = true) {
			const value = Math.min(460, Math.max(120, width));
			app.style.setProperty("--outline-w", `${value}px`);
			get("#grip").setAttribute("aria-valuenow", String(value));
			if (save)
				void ctx.hostCommand("saveSettings", {
					patch: { outlineWidth: value, outlineOpen: app.dataset.outline !== "closed" },
				});
		}
		function outlineLink(h: ReaderHeading, minimum: number) {
			const a = el(
				"a",
				{ href: `#${h.anchor}`, "data-heading-start": String(h.start), "data-level": String(h.level - minimum + 1) },
				el("span", { class: "t" }, h.text),
				el("span", { class: "n" }),
			);
			a.style.setProperty("--lvl", String(h.level - minimum));
			a.addEventListener("click", (event) => {
				event.preventDefault();
				nav.jump(h.start);
				nav.closeSheet();
			});
			return a;
		}
		function setCurrentRow(row: HTMLElement, current: boolean) {
			row.toggleAttribute("aria-current", current);
			row.toggleAttribute("data-role", current);
			if (!current) return;
			row.setAttribute("aria-current", "true");
			row.dataset.role = "outline-current";
			if (hover) return;
			const r = row.getBoundingClientRect(),
				box = rows.getBoundingClientRect();
			if (r.top < box.top || r.bottom > box.bottom) row.scrollIntoView({ block: "nearest" });
		}
		function toggleSheet() {
			app.dataset.sheet = app.dataset.sheet === "open" ? "closed" : "open";
			if (app.dataset.sheet === "open") filter.focus({ preventScroll: true });
			return app.dataset.sheet === "open";
		}
		function toggleDock() {
			app.dataset.outline = app.dataset.outline === "closed" ? "open" : "closed";
			void ctx.hostCommand("saveSettings", { patch: { outlineOpen: app.dataset.outline === "open" } });
			return app.dataset.outline === "open";
		}
		function sourceEdit(match: ReturnType<ReaderEditor["find"]>[number], source: string): ReaderEdit | null {
			const b = controller.blocks.find((b) => b.key === match.key);
			if (!b) return null;
			const node = block(b.start);
			if (!node) return null;
			let start: number | null, end: number | null;
			if (controller.doc?.active?.blockId === b.key) {
				const map = new api.exact.LineMap(source.slice(b.start, b.end));
				start = b.start + map.toSource(match.start);
				end = b.start + map.toSource(match.end);
			} else {
				const map = api.sourceModel.map(b, source, node);
				start = map.boundaries[match.start];
				end = map.boundaries[match.end];
			}
			if (start == null || end == null) return null;
			return { start, end, text: replacement.value, expected: source.slice(start, end) };
		}
		function replacementEdits(source: string) {
			const edits: ReaderEdit[] = [];
			for (const match of matches) {
				const edit = sourceEdit(match, source);
				if (!edit) {
					ctx.notice("The rendered match has no exact source range. Open its block to replace it.", "warn");
					return null;
				}
				edits.push(edit);
			}
			return edits;
		}
		function outlineSettings(patch: Record<string, unknown>) {
			if (typeof patch.outlineWidth === "number") setWidth(patch.outlineWidth, false);
			if (typeof patch.outlineOpen === "boolean") app.dataset.outline = patch.outlineOpen ? "open" : "closed";
		}
		const nav: ReaderNavigation = {
			rebuild() {
				blockElements = new Map(
					[...doc.children].map((node) => [Number((node as HTMLElement).dataset.start), node as HTMLElement]),
				);
				const headings = ctx.headings(),
					minimum = Math.min(6, ...headings.map((h) => h.level)),
					query = filter.value.trim().toLocaleLowerCase();
				rows.replaceChildren();
				count.textContent = headings.length ? String(headings.length) : "";
				for (const h of headings.filter((h) => h.text.toLocaleLowerCase().includes(query)))
					rows.append(outlineLink(h, minimum));
				if (!rows.children.length)
					rows.append(
						el("div", { class: "empty" }, headings.length ? "No matching headings" : "This document has no headings"),
					);
				hitCounts();
				nav.updateCurrent();
			},
			updateCurrent() {
				const headings = ctx.headings(),
					positions = headings.map((h) => ({
						start: h.start,
						top: block(h.start)?.getBoundingClientRect().top ?? Infinity,
					}));
				const at = api.uiLogic.currentHeading(positions, page.getBoundingClientRect().top + 74),
					start = headings[at]?.start;
				for (const row of rows.querySelectorAll<HTMLElement>("[data-heading-start]")) {
					setCurrentRow(row, Number(row.dataset.headingStart) === start);
				}
			},
			toggleOutline() {
				get("#b-outline").setAttribute("aria-pressed", String(narrow() ? toggleSheet() : toggleDock()));
			},
			closeSheet() {
				if (app.dataset.sheet !== "open") return false;
				app.dataset.sheet = "closed";
				get("#b-outline").setAttribute("aria-pressed", "false");
				return true;
			},
			find(args = {}) {
				findOpen = true;
				app.setAttribute("data-find", "");
				if (args.replace && !app.dataset.overlay) app.setAttribute("data-replace", "");
				if (typeof args.query === "string") field.value = args.query;
				else {
					const selection = editor.selection();
					if (selection && selection.text.length < 80 && !selection.text.includes("\n")) field.value = selection.text;
				}
				nav.refreshFind();
				field.focus({ preventScroll: true });
				field.select();
			},
			closeFind() {
				if (!findOpen) return false;
				findOpen = false;
				app.removeAttribute("data-find");
				app.removeAttribute("data-replace");
				editor.highlight("find", []);
				editor.highlight("find-current", []);
				hitCounts();
				publishFind();
				return true;
			},
			findNext(delta) {
				if (!findOpen) nav.find();
				if (!matches.length) return;
				index = (index + delta + matches.length) % matches.length;
				paintFind(true);
			},
			refreshFind() {
				if (!findOpen) return;
				matches = overlayBody() ? overlayMatches(field.value) : editor.find(field.value);
				const replace = findbar.querySelector<HTMLButtonElement>('[aria-label="Replace"]');
				if (replace) replace.disabled = !!app.dataset.overlay;
				if (app.dataset.overlay) app.removeAttribute("data-replace");
				index = Math.min(index, Math.max(0, matches.length - 1));
				paintFind();
			},
			replace() {
				if (!matches.length || !controller.doc || app.dataset.overlay) return;
				const edits = replacementEdits(controller.doc.source);
				if (!edits?.length) return;
				editor.close();
				controller.setLock("writing");
				controller.doc.seal();
				const result = controller.change(edits);
				controller.doc.seal();
				if (result.status === "ok") ctx.toast(`Replaced ${edits.length} ${edits.length === 1 ? "match" : "matches"}`);
			},
			jump(start) {
				const target = block(start);
				if (target) nav.jumpElement(target);
			},
			jumpElement(target) {
				saveJump();
				page.scrollTop += target.getBoundingClientRect().top - page.getBoundingClientRect().top - 70;
				nav.updateCurrent();
				finishJump();
			},
			back(forward = false) {
				if (cursor < 0) return;
				const next = cursor + (forward ? 1 : -1);
				if (next < 0 || next >= history.length) return;
				history[cursor] = position();
				cursor = next;
				restore(history[cursor]);
				drawBack();
			},
			dispose() {
				for (const fn of off) fn();
			},
		};
		listen(filter, "input", () => nav.rebuild());
		listen(filter, "keydown", ((e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				const start = rows.querySelector<HTMLElement>("[data-heading-start]")?.dataset.headingStart;
				if (start !== undefined) {
					nav.jump(Number(start));
					nav.closeSheet();
				}
			}
		}) as EventListener);
		listen(toc, "pointerenter", () => {
			hover = true;
		});
		listen(toc, "pointerleave", () => {
			hover = false;
		});
		listen(field, "input", () => {
			index = 0;
			nav.refreshFind();
		});
		listen(field, "keydown", ((e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				nav.findNext(e.shiftKey ? -1 : 1);
			}
		}) as EventListener);
		listen(get("#scrim"), "click", () => nav.closeSheet());
		listen(
			page,
			"scroll",
			() => {
				app.toggleAttribute("data-scrolled", page.scrollTop > 2);
				nav.updateCurrent();
				const { blockStart, offsetY } = position();
				controller.state({ scroll: { blockStart, offsetY } });
			},
			{ passive: true },
		);
		const grip = get("#grip");
		let width = 252;
		listen(grip, "pointerdown", ((e: PointerEvent) => {
			grip.setPointerCapture(e.pointerId);
			app.setAttribute("data-resizing", "");
		}) as EventListener);
		listen(grip, "pointermove", ((e: PointerEvent) => {
			if (!grip.hasPointerCapture(e.pointerId)) return;
			width = e.clientX - app.getBoundingClientRect().left;
			app.dataset.outline = width < 120 ? "closed" : "open";
			setWidth(Math.min(width, app.clientWidth * 0.45), false);
		}) as EventListener);
		const endResize = () => {
			app.removeAttribute("data-resizing");
			setWidth(width);
		};
		listen(grip, "pointerup", endResize);
		listen(grip, "pointercancel", endResize);
		listen(grip, "dblclick", () => setWidth(252));
		listen(grip, "keydown", ((e: KeyboardEvent) => {
			if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
			e.preventDefault();
			width = Number(grip.getAttribute("aria-valuenow")) + (e.key === "ArrowRight" ? 16 : -16);
			app.dataset.outline = width < 120 ? "closed" : "open";
			setWidth(width);
		}) as EventListener);
		off.push(
			controller.on("document", (payload) => {
				outlineSettings(payload.settings);
				pendingPosition = (payload.position as { blockStart: number; offsetY: number } | undefined) ?? null;
				history = [];
				cursor = -1;
				drawBack();
				nav.closeFind();
				filter.value = "";
			}),
			controller.on("view", () => {
				nav.rebuild();
				nav.refreshFind();
				if (pendingPosition) {
					const restored = pendingPosition;
					pendingPosition = null;
					restore({ ...restored, scrollTop: 0 });
					const { blockStart, offsetY } = position();
					controller.state({ scroll: { blockStart, offsetY } });
				}
			}),
			controller.on("settings", outlineSettings),
		);
		return nav;
	};
})();
