(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, icon, get } = api.uiDOM;
	// The controls of fenced code blocks: a syntax choice on the language label, a rendered view for
	// Markdown, and copy. A choice changes how the page shows a block, never its source, and lasts
	// while the block's text is unchanged. The controls and the rendered view carry
	// data-reader-control, so the text index and the source offsets inside the block stay exact.
	type View = { syntax?: string; rendered?: boolean };
	// The bridge refuses a page message above 256 KiB; the margin holds the envelope.
	const RENDER_LIMIT = 255 * 1024;
	/** The menu item that a key moves to from the focused one, or null for another key. */
	function itemIndex(key: string, at: number, length: number) {
		if (!length) return null;
		if (key === "Home") return 0;
		if (key === "End") return length - 1;
		if (key === "ArrowDown") return (at + 1) % length;
		if (key === "ArrowUp") return at < 0 ? length - 1 : (at - 1 + length) % length;
		return null;
	}
	api.createCodeViews = (ctx, options = {}) => {
		const { doc, host, controller } = ctx;
		const menu = get("#codemenu");
		const views = new Map<string, View>();
		const pending = new WeakMap<HTMLElement, Promise<boolean>>();
		const off: (() => void)[] = [];
		// The syntax button whose menu is open, and the menu item that the keys reach.
		let opened: HTMLElement | null = null,
			active = -1;
		function listen(
			target: EventTarget,
			type: string,
			handler: EventListener,
			opts?: AddEventListenerOptions | boolean,
		) {
			target.addEventListener(type, handler, opts);
			off.push(() => target.removeEventListener(type, handler, opts));
		}
		const control = (figure: HTMLElement, role: string) =>
			figure.querySelector<HTMLElement>(`:scope > [data-role="code-bar"] [data-role="${role}"]`);
		const codeOf = (figure: HTMLElement) =>
			figure.querySelector(":scope > pre > code")?.textContent ??
			figure.querySelector(":scope > pre")?.textContent ??
			"";
		const labelOf = (figure: HTMLElement) =>
			figure.querySelector<HTMLElement>(":scope > figcaption")?.dataset.label ?? "";
		const choiceName = (key: string) => api.syntax.choices.find((choice) => choice.id === key)?.label ?? "";
		function viewOf(figure: HTMLElement): View {
			return views.get(figure.dataset.codeView ?? "") ?? {};
		}
		function setView(figure: HTMLElement, patch: View) {
			const key = figure.dataset.codeView;
			if (!key) return;
			const next = { ...viewOf(figure), ...patch };
			if (next.syntax === undefined) delete next.syntax;
			if (!next.rendered) delete next.rendered;
			if (Object.keys(next).length) views.set(key, next);
			else views.delete(key);
		}
		function copyButton(text: () => string) {
			const b = button(
				"Copy code",
				"copy",
				() => {
					const value = text().replace(/\n$/u, "");
					const source = controller.doc?.source ?? "";
					void ctx.hostCommand("copy", {
						text: source.includes("\r\n") && !/(?<!\r)\n/u.test(source) ? value.replaceAll("\n", "\r\n") : value,
					});
					ctx.toast("Copied code");
				},
				{ className: "copy code-copy" },
			);
			b.dataset.role = "code-copy";
			b.setAttribute("data-reader-control", "");
			b.addEventListener("click", (event) => event.stopPropagation());
			return b;
		}
		function viewButton(label: string, rendered: boolean, figure: HTMLElement) {
			const b = el("button", { type: "button", "aria-pressed": String(!rendered) }, label);
			b.dataset.role = rendered ? "code-show-rendered" : "code-show-source";
			b.addEventListener("click", (event) => {
				event.stopPropagation();
				void showRendered(figure, rendered);
			});
			return b;
		}
		// The bar sits over the caption row, and its syntax button shows the label in place of the
		// caption's drawn label.
		function build(figure: HTMLElement) {
			const label = labelOf(figure);
			const chooser = el(
				"button",
				{ type: "button", class: "code-syntax", "aria-haspopup": "menu", "aria-expanded": "false" },
				el("span", { class: "name" }, label),
				icon("chev"),
			);
			chooser.dataset.role = "code-syntax";
			chooser.addEventListener("click", (event) => {
				event.stopPropagation();
				if (opened === chooser && menu.matches(":popover-open")) closeMenu();
				else openMenu(figure, chooser);
			});
			const switcher = el(
				"div",
				{ class: "seg code-view", role: "group", "aria-label": "Markdown view", "data-role": "code-view" },
				viewButton("Source", false, figure),
				viewButton("Rendered", true, figure),
			);
			const bar = el(
				"div",
				{ class: "code-bar", "data-role": "code-bar", "data-reader-control": "" },
				chooser,
				switcher,
				copyButton(() => codeOf(figure)),
			);
			// A press on a control keeps the selection and any open block's caret.
			bar.addEventListener("pointerdown", (event) => event.preventDefault());
			figure.append(bar);
			figure.toggleAttribute("data-controls", true);
		}
		// Applies the block's view: its syntax colours, the label that names them, and the
		// rendered view, which only Markdown offers. A block that the page drew again gets its
		// rendered view again. Returns whether the colours changed, which replaces the text nodes
		// that find ranges hold. Each pass writes only what differs, as it runs after every render.
		function apply(figure: HTMLElement) {
			const view = viewOf(figure),
				code = figure.querySelector(":scope > pre > code"),
				before = code?.getAttribute("data-highlighted");
			const key = api.colourCode?.(figure, view.syntax) ?? "";
			nameSyntax(figure, view.syntax);
			const markdown = key === "markdown";
			const switcher = control(figure, "code-view");
			if (switcher && switcher.hidden === markdown) switcher.hidden = !markdown;
			if (!markdown && view.rendered) setView(figure, { rendered: false });
			const rendered = markdown && !!viewOf(figure).rendered;
			if (rendered && !figure.querySelector(':scope > [data-role="code-rendered"]')) void showRendered(figure, true);
			else display(figure, rendered);
			return code?.getAttribute("data-highlighted") !== before;
		}
		function attribute(node: Element | null, name: string, value: string | null) {
			if (!node || node.getAttribute(name) === value) return;
			if (value === null) node.removeAttribute(name);
			else node.setAttribute(name, value);
		}
		function syntaxName(figure: HTMLElement, syntax: string | undefined) {
			if (syntax === undefined) return labelOf(figure);
			return syntax ? choiceName(syntax) : "Plain text";
		}
		function nameSyntax(figure: HTMLElement, syntax: string | undefined) {
			const chooser = control(figure, "code-syntax"),
				label = chooser?.querySelector(".name");
			if (!chooser || !label) return;
			const shown = syntaxName(figure, syntax);
			if (label.textContent !== shown) label.textContent = shown;
			attribute(chooser, "aria-label", `Syntax: ${shown}`);
			attribute(chooser, "data-chosen", syntax === undefined ? null : "");
		}
		function display(figure: HTMLElement, rendered: boolean) {
			const preview = figure.querySelector<HTMLElement>(':scope > [data-role="code-rendered"]');
			const on = rendered && !!preview;
			attribute(figure, "data-rendered", on ? "" : null);
			if (preview && preview.hidden === on) preview.hidden = !on;
			attribute(control(figure, "code-show-source"), "aria-pressed", String(!on));
			attribute(control(figure, "code-show-rendered"), "aria-pressed", String(on));
		}
		async function showRendered(figure: HTMLElement, rendered: boolean) {
			setView(figure, { rendered });
			if (rendered && !(await preview(figure))) setView(figure, { rendered: false });
			if (figure.isConnected) display(figure, !!viewOf(figure).rendered);
		}
		// Native renders the block's text with the document's renderer, as text that belongs to no
		// file. The view is part of the document's page, so it takes no ids: they would shadow the
		// document's own anchors, and its fragment links therefore lead nowhere.
		function preview(figure: HTMLElement): Promise<boolean> {
			if (figure.querySelector(':scope > [data-role="code-rendered"]')) return Promise.resolve(true);
			const running = pending.get(figure);
			if (running) return running;
			const text = codeOf(figure);
			if (new TextEncoder().encode(JSON.stringify(text)).length > RENDER_LIMIT) {
				ctx.notice("This code block is too long to show rendered.", "warn");
				return Promise.resolve(false);
			}
			const request = render(figure, text);
			pending.set(figure, request);
			void request.then(() => pending.delete(figure));
			return request;
		}
		async function render(figure: HTMLElement, text: string) {
			try {
				const reply = (await host.request("query", { kind: "markdown", text })) as { html?: unknown } | undefined;
				if (typeof reply?.html !== "string") throw new Error("the reply held no HTML");
				const view = el("div", {
					class: "code-rendered",
					"data-role": "code-rendered",
					"data-reader-control": "",
					"data-reader-view": "",
					hidden: "",
				});
				api.setRenderedHTML(view, reply.html);
				for (const node of view.querySelectorAll("[id]")) node.removeAttribute("id");
				api.highlightCode?.(view);
				figure.append(view);
				return true;
			} catch (error) {
				ctx.notice(`The reader did not render this block: ${String(error)}`, "warn");
				return false;
			}
		}
		function menuItem(label: string, checked: boolean, choose: () => void, meta = "") {
			const item = el("button", {
				type: "button",
				class: "item",
				role: "menuitemradio",
				tabindex: "-1",
				"aria-checked": String(checked),
			});
			item.append(icon("check"), el("span", { class: "lbl" }, label));
			item.querySelector("svg")?.classList.add("tick");
			if (meta) item.append(el("span", { class: "meta" }, meta));
			// A press keeps the focus where it is, so an open block keeps its caret.
			item.addEventListener("pointerdown", (event) => event.preventDefault());
			item.addEventListener("pointermove", () => setActive(menuItems().indexOf(item)));
			item.addEventListener("click", () => {
				closeMenu();
				choose();
			});
			return item;
		}
		const menuItems = () => [...menu.querySelectorAll<HTMLButtonElement>("button.item")];
		function setActive(index: number) {
			if (index === active) return;
			active = index;
			for (const [i, item] of menuItems().entries()) item.toggleAttribute("data-active", i === index);
		}
		function choose(figure: HTMLElement, syntax: string | undefined) {
			setView(figure, { syntax });
			if (figure.isConnected && apply(figure)) options.onChange?.();
		}
		function openMenu(figure: HTMLElement, chooser: HTMLElement) {
			const view = viewOf(figure),
				automatic = api.syntax.canonical(labelOf(figure)) || api.syntax.detect(codeOf(figure));
			const items = [
				menuItem(
					"Automatic",
					view.syntax === undefined,
					() => choose(figure, undefined),
					automatic ? choiceName(automatic) : "Plain text",
				),
				menuItem("Plain text", view.syntax === "", () => choose(figure, "")),
				el("div", { class: "sep", role: "separator" }),
				...api.syntax.choices.map((choice) =>
					menuItem(choice.label, view.syntax === choice.id, () => choose(figure, choice.id)),
				),
			];
			menu.replaceChildren(...items);
			release();
			active = -1;
			chooser.style.setProperty("anchor-name", "--code-syntax");
			chooser.setAttribute("aria-expanded", "true");
			opened = chooser;
			if (!menu.matches(":popover-open")) menu.showPopover();
		}
		function release() {
			opened?.setAttribute("aria-expanded", "false");
			opened?.style.removeProperty("anchor-name");
			opened = null;
		}
		function closeMenu() {
			if (menu.matches(":popover-open")) menu.hidePopover();
			release();
		}
		// The menu is a manual popover, so a press on its own button toggles it. Like the page's context
		// menu, it takes no focus: keys reach it through a window listener while it is open, and a press
		// elsewhere, a scroll of the page, leaving the window, Escape, Tab or another key closes it. A
		// toggle event arrives after the change, when the menu can already be open again for another block.
		listen(menu, "toggle", ((event: ToggleEvent) => {
			if (event.newState !== "open" && !menu.matches(":popover-open")) release();
		}) as EventListener);
		listen(
			window,
			"pointerdown",
			((event: PointerEvent) => {
				const target = event.target as Node | null;
				if (opened && target && !menu.contains(target) && !opened.contains(target)) closeMenu();
			}) as EventListener,
			true,
		);
		listen(ctx.page, "scroll", () => opened && closeMenu(), { passive: true });
		listen(window, "blur", () => opened && closeMenu());
		/** Applies a key to the open menu; false when the key closes it and goes on to the page. */
		function menuKey(key: string) {
			const items = menuItems(),
				next = itemIndex(key, active, items.length);
			if (next !== null) {
				setActive(next);
				items[next].scrollIntoView({ block: "nearest" });
			} else if (key === "Enter" || key === " ") items[active]?.click();
			else {
				closeMenu();
				return key === "Escape" || key === "Tab";
			}
			return true;
		}
		listen(
			window,
			"keydown",
			((event: KeyboardEvent) => {
				if (!opened || event.isComposing || !menuKey(event.key)) return;
				event.preventDefault();
				event.stopImmediatePropagation();
			}) as EventListener,
			true,
		);
		// The rendered view has no source positions. Editing it opens its block at the first
		// character of the code, or at the block's start when no code text maps to the source.
		function codeStart(block: HTMLElement, data: ReaderMappedBlock, source: string, figure: HTMLElement) {
			const code = figure.querySelector(":scope > pre > code") ?? figure,
				first = api.sourceModel.textNodes(code)[0],
				at = first ? api.sourceModel.offset(block, first, 0) : null,
				exact = at === null ? null : api.sourceModel.map(data, source, block).boundaries[at];
			if (exact === null || exact === undefined) return 0;
			const map = new api.exact.LineMap(source.slice(data.start, data.end), api.exact.dominantEnding(source));
			return api.sourceModel.sourceToDisplay(map, exact - data.start);
		}
		function editView(target: Element, openOptions: { oneOff?: boolean }) {
			const figure = target.closest("[data-reader-view]")?.closest<HTMLElement>("figure.code"),
				block = figure?.closest<HTMLElement>("[data-block]"),
				data = controller.blocks.find((b) => b.key === block?.dataset.block),
				source = controller.doc?.source;
			if (!figure || !block || !data || source === undefined) return false;
			return ctx.editor.open(data.key, codeStart(block, data, source, figure), openOptions);
		}
		// The rendered view is never edited in place. Its web links open as document links do, after
		// the host asks; fragment links and task boxes do nothing. In Writing, a click elsewhere in it
		// opens its block, as a click on any other block does; a drag only selects.
		function followViewLink(event: MouseEvent, target: Element) {
			const link = target.closest("a[href]");
			if (!link && !target.closest("input")) return false;
			event.preventDefault();
			event.stopImmediatePropagation();
			const href = link?.getAttribute("href") ?? "";
			if (href && !href.startsWith("#")) void ctx.hostCommand("openLink", { href });
			return true;
		}
		listen(
			doc,
			"click",
			((event: MouseEvent) => {
				const target = event.target instanceof Element ? event.target : null;
				if (!target?.closest("[data-reader-view]") || followViewLink(event, target)) return;
				if (controller.lock !== "writing" || getSelection()?.isCollapsed === false) return;
				if (editView(target, {})) event.stopImmediatePropagation();
			}) as EventListener,
			true,
		);
		// Each fenced block of a document block gets its controls once; every pass applies its view.
		function decorateBlock(block: HTMLElement) {
			let recoloured = false;
			const figures = [...block.querySelectorAll<HTMLElement>("figure.code")].filter(
				(figure) => !figure.closest("[data-reader-control]"),
			);
			figures.forEach((figure, index) => {
				const key = `${block.dataset.block}:${index}`;
				if (figure.dataset.codeView !== key) figure.dataset.codeView = key;
				if (!figure.hasAttribute("data-controls")) build(figure);
				if (apply(figure)) recoloured = true;
			});
			return recoloured;
		}
		// Code that is not a fenced block, such as raw HTML shown as text, has copy alone.
		function copyOtherCode(block: HTMLElement) {
			for (const pre of block.querySelectorAll<HTMLElement>("pre")) {
				if (pre.closest("figure.code, [data-reader-control]") || pre.querySelector(':scope > [data-role="code-copy"]'))
					continue;
				const text = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
				pre.append(copyButton(() => text));
			}
		}
		return {
			decorate() {
				// A block drawn again takes the menu's button with it.
				if (opened && !opened.isConnected) closeMenu();
				const blocks = [...doc.querySelectorAll<HTMLElement>("[data-block]")].filter(
					(block) => block.dataset.role !== "block-editor",
				);
				for (const block of blocks) copyOtherCode(block);
				if (blocks.map(decorateBlock).some(Boolean)) options.onChange?.();
			},
			// A find match inside a block that shows its rendered view brings the source back first.
			reveal(node) {
				const figure = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
					"figure.code[data-rendered]",
				);
				if (!figure || node.parentElement?.closest("[data-reader-view]")) return;
				setView(figure, { rendered: false });
				display(figure, false);
			},
			edit: editView,
			copy(target) {
				const figure = (target.closest("[data-reader-view]") ?? target).closest("figure.code");
				const copy = figure?.querySelector<HTMLButtonElement>(
					':scope > [data-role="code-bar"] [data-role="code-copy"]',
				);
				copy?.click();
				return !!copy;
			},
			dispose() {
				for (const fn of off) fn();
				closeMenu();
			},
		};
	};
})();
