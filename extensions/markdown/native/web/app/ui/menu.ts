(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el } = api.uiDOM;
	// The reader's own context menu. The page never lets WebKit show its menu: a secondary click
	// on the page opens this menu, or nothing where no action applies. It does not take focus, so
	// an open block keeps its caret and selection; keys reach it through a window listener.
	api.createContextMenu = (ctx, run) => {
		const { app, page, doc, controller, editor } = ctx;
		const menu = el("div", { class: "context-menu", role: "menu", "data-role": "context-menu", hidden: "" });
		app.append(menu);
		let entries: ReaderMenuEntry[] = [],
			active = -1,
			context: ReaderMenuContext | null = null;
		const off: (() => void)[] = [];
		function listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions | boolean) {
			target.addEventListener(type, handler, options);
			off.push(() => target.removeEventListener(type, handler, options));
		}
		function inputTarget(target: Element) {
			const field = target.closest<HTMLInputElement | HTMLTextAreaElement>("textarea, input");
			if (!field || (field instanceof HTMLInputElement && !["text", "search", ""].includes(field.type))) return null;
			return field;
		}
		function describeInput(field: HTMLInputElement | HTMLTextAreaElement, x: number, y: number): ReaderMenuContext {
			return {
				point: { x, y },
				input: field,
				selection: null,
				block: null,
				link: null,
				image: null,
				target: menuTarget({
					area: "input",
					inputSelection: (field.selectionEnd ?? 0) > (field.selectionStart ?? 0),
					inputEditable: !field.readOnly && !field.disabled,
				}),
			};
		}
		// A document link, not the reader's own image and code action addresses. A rendered view of
		// a code block has no anchors, so its fragment links lead nowhere.
		function documentLink(target: Element) {
			const link = target.closest<HTMLAnchorElement>("a[href]"),
				href = link?.getAttribute("href") ?? "";
			if (!link || href.startsWith("reader-action:")) return null;
			return href.startsWith("#") && link.closest("[data-reader-view]") ? null : link;
		}
		function blockType(block: HTMLElement | null) {
			if (!block) return "";
			return controller.blocks.find((b) => b.key === block.dataset.block)?.type ?? block.dataset.type ?? "";
		}
		function documentTarget(target: Element, selection: ReaderSelection | null, block: HTMLElement | null) {
			const link = documentLink(target),
				image = target.closest<HTMLElement>("[data-image]"),
				inEditor = block?.dataset.role === "block-editor",
				type = blockType(block),
				internal = (link?.getAttribute("href") ?? "").startsWith("#");
			return menuTarget({
				area: "document",
				selection: !!selection,
				selectionInOneBlock: !!selection && controller.blocks.some((b) => b.start <= selection.start && b.end >= selection.end),
				editor: inEditor && editor.hasCaret(),
				block: !!block,
				heading: type.startsWith("heading"),
				link: link && !inEditor ? { internal } : undefined,
				image: !!image,
				imageAlt: !!(image?.getAttribute("alt") || image?.getAttribute("aria-label")),
				code: type === "code",
				table: type === "table",
			});
		}
		function describe(target: Element, x: number, y: number): ReaderMenuContext | null {
			const field = inputTarget(target);
			if (field) return describeInput(field, x, y);
			// Controls have no menu; a rendered view of a block is read like the block itself.
			if (!doc.contains(target) || target.closest("[data-reader-control]:not([data-reader-view])")) return null;
			const selection = editor.selection(),
				block = target.closest<HTMLElement>("[data-block]"),
				link = documentLink(target);
			return {
				point: { x, y },
				input: null,
				selection,
				block,
				link: block?.dataset.role === "block-editor" ? null : link,
				image: target.closest<HTMLElement>("[data-image]"),
				target: documentTarget(target, selection, block),
			};
		}
		function menuTarget(partial: Partial<ReaderMenuTarget>): ReaderMenuTarget {
			return {
				area: "other",
				lock: controller.lock,
				selection: false,
				selectionInOneBlock: false,
				editor: false,
				block: false,
				heading: false,
				image: false,
				imageAlt: false,
				code: false,
				table: false,
				inputSelection: false,
				inputEditable: false,
				...partial,
			};
		}
		function draw() {
			menu.replaceChildren(
				...entries.map((entry, index) => {
					if (entry.separator) return el("div", { class: "sep", role: "separator" });
					const item = el(
						"button",
						{
							type: "button",
							class: "item",
							role: "menuitem",
							"data-id": entry.id,
							"aria-disabled": String(!entry.enabled),
						},
						el("span", { class: "lbl" }, entry.label),
						el("span", { class: "key" }, entry.key),
					);
					item.tabIndex = -1;
					item.toggleAttribute("data-active", index === active);
					item.addEventListener("pointermove", () => setActive(index));
					item.addEventListener("click", () => choose(index));
					return item;
				}),
			);
		}
		function setActive(index: number) {
			if (index === active) return;
			active = index;
			for (const [i, node] of [...menu.children].entries()) node.toggleAttribute("data-active", i === active);
		}
		function step(delta: number) {
			const usable = entries.map((e, i) => (e.enabled && !e.separator ? i : -1)).filter((i) => i >= 0);
			if (!usable.length) return;
			const position = usable.indexOf(active);
			const next = position < 0 ? (delta > 0 ? 0 : usable.length - 1) : (position + delta + usable.length) % usable.length;
			setActive(usable[next]);
		}
		function choose(index: number) {
			const entry = entries[index];
			if (!entry || entry.separator || !entry.enabled || !context) return;
			const current = context;
			close();
			void run(entry.id, current);
		}
		function open(next: ReaderMenuContext) {
			entries = api.uiLogic.contextMenuItems(next.target);
			if (!entries.length) {
				close();
				return;
			}
			context = next;
			active = -1;
			draw();
			menu.hidden = false;
			const box = app.getBoundingClientRect();
			const place = api.uiLogic.menuPlacement(
				{ x: next.point.x - box.left, y: next.point.y - box.top },
				{ width: menu.offsetWidth, height: menu.scrollHeight },
				{ width: box.width, height: box.height },
			);
			menu.style.maxHeight = `${place.maxHeight}px`;
			menu.style.left = `${place.left}px`;
			menu.style.top = `${place.top}px`;
			ctx.onMenuOpen?.();
		}
		function close() {
			if (menu.hidden) return false;
			menu.hidden = true;
			context = null;
			active = -1;
			return true;
		}
		listen(
			document,
			"contextmenu",
			((event: MouseEvent) => {
				// WebKit's own menu never appears; where no page action applies, nothing opens.
				event.preventDefault();
				const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
				if (!target || menu.contains(target)) return;
				const next = describe(target, event.clientX, event.clientY);
				if (next) open(next);
				else close();
			}) as EventListener,
			true,
		);
		listen(
			window,
			"keydown",
			((event: KeyboardEvent) => {
				if (menu.hidden || event.isComposing) return;
				const keys: Record<string, () => void> = {
					ArrowDown: () => step(1),
					ArrowUp: () => step(-1),
					Home: () => {
						setActive(-1);
						step(1);
					},
					End: () => {
						setActive(-1);
						step(-1);
					},
					Enter: () => choose(active),
					" ": () => choose(active),
					Escape: () => close(),
					Tab: () => close(),
				};
				const action = keys[event.key];
				if (!action) {
					close();
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				action();
			}) as EventListener,
			true,
		);
		listen(
			window,
			"pointerdown",
			((event: PointerEvent) => {
				if (menu.hidden) return;
				if (menu.contains(event.target as Node)) {
					event.preventDefault();
					return;
				}
				if (event.button !== 2) close();
			}) as EventListener,
			true,
		);
		listen(page, "scroll", () => close(), { passive: true });
		listen(window, "resize", () => close());
		listen(window, "blur", () => close());
		return {
			isOpen: () => !menu.hidden,
			close,
			dispose() {
				for (const fn of off) fn();
				menu.remove();
			},
		};
	};
})();
