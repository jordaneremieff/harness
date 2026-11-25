(() => {
	interface Edit {
		start: number;
		end: number;
		text: string;
		cursor?: number;
	}
	interface Selection {
		start: number;
		end: number;
		direction: HTMLTextAreaElement["selectionDirection"];
	}
	interface Point {
		left: number;
		top: number;
	}
	const menuGap = 6,
		menuInset = 6,
		menuMaxHeight = 360;
	interface Match {
		path: string;
		start: number;
		end: number;
	}
	interface Item {
		value: string;
		label: string;
		description?: string;
	}
	interface Assistance {
		completionTrigger(text: string, cursor: number): boolean;
		completionEdit(before: string, result: string, cursor: number): Edit | null;
		historyIndexAfterUpdate(entries: string[], index: number | null, text: string, next: string[]): number | null;
		historyStep(
			context: {
				entries: string[];
				index: number | null;
				text: string;
				base: string;
				selectionStart: number;
				selectionEnd: number;
			},
			direction: -1 | 1,
		): { index: number | null; text: string } | null;
		imagePaths(text: string): Match[];
		syntaxParts(text: string): { text: string; kind?: string }[];
	}
	interface Host {
		input: HTMLTextAreaElement;
		request(type: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>>;
		edit(change: Edit): boolean;
		notice(message: string): void;
		icon(name: string): SVGSVGElement;
		preferences(): { size: number; sendKey: string; resize(step: number): void; toggleSendKey(): void };
	}
	interface State {
		model?: { name: string };
		thinking?: string;
		thinkingLevels?: string[];
		queued?: { behavior: string; text: string }[];
		since?: number;
	}
	interface Model {
		provider: string;
		id: string;
		name: string;
		current?: boolean;
	}
	const root = globalThis as typeof globalThis & {
		composerAssistance: Assistance;
		mountComposerControls?: typeof mount;
	};
	function get<T extends HTMLElement = HTMLElement>(id: string): T {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing composer control: ${id}`);
		return node as T;
	}
	function button(text: string, action: () => unknown, name?: string): HTMLButtonElement {
		const node = document.createElement("button");
		node.type = "button";
		node.textContent = text;
		if (name) node.setAttribute("aria-label", name);
		node.addEventListener("click", () => {
			action();
		});
		return node;
	}
	function mount(host: Host) {
		const { input, request, edit, notice, icon, preferences } = host;
		const assist = root.composerAssistance;
		const pane = get("composer"),
			menu = get("menu"),
			backdrop = get("highlight"),
			images = get("images"),
			queued = get("queued");
		const model = get<HTMLButtonElement>("model"),
			add = get<HTMLButtonElement>("add");
		const anchors = [add, model];
		const imageCache = new Map<string, string | null>();
		let current: State = {},
			connected = false,
			entries: string[] = [],
			recalled: number | null = null;
		let mode = "",
			selected = 0,
			options: HTMLButtonElement[] = [],
			epoch = 0,
			timer: ReturnType<typeof setTimeout> | undefined;
		let queueKey = "";
		let menuAnchor: HTMLElement | undefined, contextPoint: Point | undefined;
		let wantedAbove = 0,
			appliedAbove = 0,
			overlayRevision = 0;
		let pendingAbove: number | undefined;
		let placement: { bottom: number; left: number; height: number; base: number } | undefined;
		let modelCache: Model[] | undefined,
			fetching: Promise<void> | undefined,
			prefetched = false;
		let cachedHeight = menuMaxHeight;
		let recoveryLabel = "",
			recovering = false;
		let imageSignature = "";
		let imageTimer: ReturnType<typeof setTimeout> | undefined;
		const fail = (error: unknown) => notice(error instanceof Error ? error.message : String(error));
		const removeSelection = () => ({ start: input.selectionStart, end: input.selectionEnd });
		const whole = (text: string) => edit({ start: 0, end: input.value.length, text });

		function askOverlay(above: number, force = false) {
			if (!force && above === wantedAbove) return;
			wantedAbove = above;
			pendingAbove = above;
			const revision = ++overlayRevision;
			void request("overlay", { above }).then(
				(reply) => {
					if (revision !== overlayRevision) return;
					pendingAbove = undefined;
					if (typeof reply.above === "number" && Number.isFinite(reply.above) && reply.above >= 0)
						viewport(reply.above);
				},
				(error) => {
					if (revision !== overlayRevision) return;
					pendingAbove = undefined;
					if (mode) {
						closeMenu();
						fail(error);
					}
				},
			);
		}
		function resetMenu() {
			epoch++;
			clearTimeout(timer);
			menu.replaceChildren();
			for (const control of anchors) control.setAttribute("aria-expanded", "false");
			selected = 0;
			options = [];
		}
		function closeMenu() {
			if (!mode) return;
			mode = "";
			placement = undefined;
			menu.hidePopover();
			menu.hidden = true;
			resetMenu();
			input.removeAttribute("aria-controls");
			input.focus({ preventScroll: true });
			// The host clips the window as soon as it reads the request, so the request waits until a
			// frame without the menu has been painted. A hidden page paints no frames; the timer covers it.
			// A menu that opens meanwhile keeps its extension.
			const revision = overlayRevision;
			let asked = false;
			const release = () => {
				if (asked) return;
				asked = true;
				if (!mode && revision === overlayRevision) askOverlay(0, true);
			};
			requestAnimationFrame(() => requestAnimationFrame(release));
			setTimeout(release, 100);
		}
		function openMenu(kind: string, title: string, anchor?: HTMLElement) {
			if (kind !== mode && menu.matches(":popover-open")) {
				menu.hidePopover();
				menu.hidden = true;
			}
			resetMenu();
			menu.style.height = "";
			menu.dataset.kind = kind;
			mode = kind;
			if (kind !== "model" && kind !== "context") {
				const heading = document.createElement("div");
				heading.className = "menu-heading";
				heading.textContent = title;
				menu.append(heading);
			}
			menu.setAttribute("aria-label", title);
			input.setAttribute("aria-controls", menu.id);
			anchor?.setAttribute("aria-expanded", "true");
			menuAnchor = anchor;
		}
		function showMenu() {
			const opening = menu.hidden || !menu.matches(":popover-open");
			menu.hidden = false;
			if (opening) menu.showPopover();
			menu.style.maxHeight = `${menuMaxHeight}px`;
			if (mode === "completion") menu.style.setProperty("--editor-width", `${input.clientWidth}px`);
			positionMenu(opening);
			if (opening && mode === "model") menu.querySelector("input")?.focus({ preventScroll: true });
		}
		function caretLine() {
			// The highlight mirror shares the textarea's font, wrapping, size and scroll offset.
			const nodes = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT);
			let offset = input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
			for (let node = nodes.nextNode() as Text | null; node; node = nodes.nextNode() as Text | null) {
				if (offset < node.length) return lineAt(node, offset);
				offset -= node.length;
			}
		}
		function lineAt(node: Text, offset: number) {
			const range = document.createRange();
			range.setStart(node, offset);
			range.collapse(true);
			const rect = range.getBoundingClientRect();
			if (rect.height === 0) return;
			const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
			return new DOMRect(rect.x, rect.y + (rect.height - lineHeight) / 2, 0, lineHeight);
		}
		function revealCaret() {
			if (document.activeElement !== input) return;
			backdrop.scrollTop = input.scrollTop;
			const line = caretLine(),
				box = input.getBoundingClientRect();
			if (!line) return;
			if (line.bottom > box.bottom) input.scrollTop += Math.ceil(line.bottom - box.bottom);
			else if (line.top < box.top) input.scrollTop -= Math.ceil(box.top - line.top);
		}
		function protectCaret(scroll: boolean) {
			const area = backdrop.parentElement;
			if (!area || document.activeElement !== input || input.scrollHeight <= input.clientHeight) return;
			backdrop.scrollTop = input.scrollTop;
			const line = caretLine();
			if (!line) return;
			fitCaretBetweenFades(line, area, scroll);
		}
		function fitCaretBetweenFades(line: DOMRect, area: HTMLElement, scroll: boolean) {
			const box = input.getBoundingClientRect();
			const visible = line.bottom > box.top && line.top < box.bottom;
			const top = visible && line.top < box.top + line.height && input.scrollTop > 1;
			const bottom =
				visible &&
				line.bottom > box.bottom - line.height &&
				input.scrollTop + input.clientHeight < input.scrollHeight - 1;
			// Leave a context row at the active edge. In very short panes, protect the caret instead.
			if (scroll && box.height >= 3 * line.height && (top || bottom)) {
				input.scrollTop += bottom ? line.height : -line.height;
			}
			area.toggleAttribute("data-caret-top", top);
			area.toggleAttribute("data-caret-bottom", bottom);
		}
		function anchorPoint(): Point | undefined {
			if (menuAnchor) return menuAnchor.getBoundingClientRect();
			const editor = input.getBoundingClientRect();
			if (mode === "context" && contextPoint)
				return { left: editor.left + contextPoint.left, top: editor.top + contextPoint.top };
			const line = caretLine();
			if (line && line.bottom > editor.top && line.top < editor.bottom)
				return { left: editor.left, top: Math.max(line.top, editor.top) };
		}
		function menuHeight() {
			// Only the list scrolls between the filter and the level selector.
			const list = menu.querySelector<HTMLElement>(".model-list");
			const listOverflow = list ? list.scrollHeight - list.clientHeight : 0;
			return Math.min(menuMaxHeight, menu.scrollHeight + menu.offsetHeight - menu.clientHeight + listOverflow);
		}
		function positionMenu(opening = false) {
			if (!mode || menu.hidden) return;
			const point = anchorPoint();
			if (!point) {
				closeMenu();
				return;
			}
			const height = menu.style.height ? parseFloat(menu.style.height) : menuHeight();
			const paper = pane.getBoundingClientRect();
			const bottom = paper.bottom - point.top + menuGap;
			const left = Math.max(menuInset, Math.min(point.left, innerWidth - menu.offsetWidth - menuInset));
			const base = paper.height;
			placement = { bottom, left, height, base };
			const above = Math.max(0, Math.ceil(height + bottom + menuInset - base));
			askOverlay(above, opening);
			paintMenu(pendingAbove ?? appliedAbove);
		}
		function paintMenu(above: number) {
			if (!mode || !placement) return;
			const { bottom, left, height, base } = placement;
			const available = Math.floor(base + above - bottom - menuInset);
			menu.style.maxHeight = `${Math.max(0, Math.min(height, available))}px`;
			menu.style.bottom = `${bottom}px`;
			menu.style.left = `${left}px`;
			menu.toggleAttribute("data-no-space", available < 12);
		}
		function viewport(above: number) {
			appliedAbove = above;
			positionMenu();
		}
		function iconButton(glyph: string, label: string, action: () => unknown) {
			const node = button("", action, label);
			node.className = "tool square";
			node.dataset.tip = label;
			node.append(icon(glyph));
			return node;
		}

		function row(label: string, secondary: string, action: () => unknown, target = menu) {
			const node = button("", action);
			node.className = "menu-row";
			const name = document.createElement("span");
			name.textContent = label;
			node.append(name);
			if (secondary) {
				const detail = document.createElement("small");
				detail.textContent = secondary;
				node.append(detail);
			}
			node.addEventListener("pointerdown", (event) => event.preventDefault());
			options.push(node);
			target.append(node);
			return node;
		}
		function move(index: number) {
			if (options.length === 0) return;
			options[selected]?.classList.remove("current");
			selected = (index + options.length) % options.length;
			const next = options[selected];
			next.classList.add("current");
			next.scrollIntoView({ block: "nearest" });
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered guards preserve menu and caret state.
		async function apply(item: Item, prefix: string, text: string, cursor: number) {
			closeMenu();
			if (text !== input.value || cursor !== input.selectionEnd) return;
			try {
				const result = await request("applyCompletion", { text, cursor, prefix, item });
				if (text !== input.value || cursor !== input.selectionEnd) return;
				if (typeof result.text !== "string" || typeof result.cursor !== "number") return;
				const change = assist.completionEdit(text, result.text, result.cursor);
				if (change) edit(change);
			} catch (error) {
				fail(error);
			}
		}
		function completionName(item: Item, prefix: string) {
			const marker = prefix[0];
			if ((marker === "@" || marker === "/") && !item.label.startsWith(marker)) return marker + item.label;
			return item.label;
		}
		function complete(force = false) {
			clearTimeout(timer);
			const version = ++epoch,
				text = input.value,
				cursor = input.selectionEnd;
			if (!connected || input.readOnly || (!force && !assist.completionTrigger(text, cursor))) {
				if (mode === "completion") closeMenu();
				return;
			}
			timer = setTimeout(
				() => {
					void request("complete", { text, cursor, force }).then(
						// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Discard stale replies before constructing menu rows.
						(result) => {
							if (version !== epoch || input.value !== text || input.selectionEnd !== cursor) return;
							const items = result.items as Item[] | undefined;
							const prefix = typeof result.prefix === "string" ? result.prefix : "";
							if (!items?.length) {
								if (mode === "completion") closeMenu();
								return;
							}
							openMenu("completion", text.startsWith("/") ? "Pi commands" : "Pi completions");
							for (const item of items.slice(0, 50))
								row(completionName(item, prefix), item.description ?? "", () => apply(item, prefix, text, cursor));
							showMenu();
							options[0]?.classList.add("current");
						},
						() => {
							if (force && version === epoch) notice("Pi did not return completions.");
						},
					);
				},
				force ? 0 : 80,
			);
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered guards preserve menu and caret state.
		function addPaths(paths: unknown) {
			if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path.startsWith("/"))) return;
			if (paths.length === 0) return;
			const range = removeSelection(),
				shell = input.value.startsWith("!");
			const separator = range.start > 0 && !/\s$/u.test(input.value.slice(0, range.start)) ? (shell ? " " : "\n") : "";
			const value = paths
				.map((path: string) => (shell ? `'${path.replaceAll("'", "'\\''")}'` : path))
				.join(shell ? " " : "\n");
			edit({ ...range, text: separator + value });
		}
		async function addFiles(type: string, fields?: Record<string, unknown>) {
			try {
				addPaths((await request(type, fields)).paths);
			} catch (error) {
				fail(error);
			}
		}
		function mentionFile() {
			closeMenu();
			if (edit({ ...removeSelection(), text: "@" })) complete(true);
		}
		function openAdd() {
			openMenu("add", "Add to message", add);
			if (offerRestore()) row(`Restore draft from ${recoveryLabel}`, "", restore);
			row("Image or file…", "", () => {
				closeMenu();
				void addFiles("pick");
			});
			if (connected) row("Mention a file", "@", mentionFile);
			if (connected)
				row("Pi commands", "/", () => {
					closeMenu();
					if (input.value.length === 0) whole("/");
					complete(true);
				});
			if (entries.length > 0) row("Recent messages", "", openHistory);
			row("Send key", preferences().sendKey === "command" ? "⌘⏎" : "⏎", () => {
				preferences().toggleSendKey();
				openAdd();
			});
			menu.append(sizeActions());
			showMenu();
		}
		function restoreSelection(selection: Selection) {
			input.setSelectionRange(selection.start, selection.end, selection.direction);
		}
		async function pasteText(selection: Selection, value: string) {
			try {
				const { text } = await request("pasteText");
				if (typeof text !== "string" || !text || input.readOnly || mode || document.activeElement !== input) return;
				if (value === input.value && selection.start === input.selectionStart && selection.end === input.selectionEnd)
					edit({ ...selection, text });
			} catch (error) {
				fail(error);
			}
		}
		function clipboardCommand(command: "cut" | "copy") {
			// Run in the menu gesture so WebKit grants clipboard access and keeps cut in its undo stack.
			if (!document.execCommand(command)) notice(`The editor could not ${command} the selection.`);
		}
		function openContext(event: MouseEvent) {
			event.preventDefault();
			const selection = { ...removeSelection(), direction: input.selectionDirection };
			const value = input.value,
				editable = !input.readOnly,
				selectedText = selection.start !== selection.end;
			const editor = input.getBoundingClientRect();
			const point =
				event.clientX || event.clientY ? { left: event.clientX, top: event.clientY } : (caretLine() ?? editor);
			contextPoint = { left: point.left - editor.left, top: Math.max(0, point.top - editor.top) };
			input.focus({ preventScroll: true });
			restoreSelection(selection);
			openMenu("context", "Edit message");
			const action = (label: string, shortcut: string, enabled: boolean, run: () => unknown) => {
				row(label, shortcut, () => {
					closeMenu();
					if (value !== input.value) return;
					restoreSelection(selection);
					run();
				}).disabled = !enabled;
			};
			action("Cut", "⌘X", editable && selectedText, () => clipboardCommand("cut"));
			action("Copy", "⌘C", selectedText, () => clipboardCommand("copy"));
			action("Paste", "⌘V", editable, () => pasteText(selection, value));
			action("Select All", "⌘A", value.length > 0, () => input.select());
			menu.append(document.createElement("hr"));
			action("Add image or file…", "", editable, () => addFiles("pick"));
			action("Mention a file", "@", editable && connected, mentionFile);
			options = options.filter((option) => !option.disabled);
			options[0]?.classList.add("current");
			showMenu();
		}
		function sizeActions() {
			const sizes = document.createElement("div"),
				value = document.createElement("span");
			sizes.className = "size-actions";
			value.textContent = `${Math.round(preferences().size)} pt`;
			for (const [glyph, label, step] of [
				["smaller", "Smaller text", -1],
				["reset", "Reset text size", 0],
				["larger", "Larger text", 1],
			] as const) {
				sizes.append(
					iconButton(glyph, label, () => {
						preferences().resize(step);
						value.textContent = `${Math.round(preferences().size)} pt`;
					}),
				);
			}
			sizes.append(value);
			return sizes;
		}
		function openHistory() {
			openMenu("history", "Recent messages", add);
			for (const entry of entries.slice().reverse())
				row(entry.split("\n")[0], "", () => {
					closeMenu();
					const index = entries.lastIndexOf(entry);
					if (whole(entry)) recalled = index;
				});
			showMenu();
		}
		function thinkingChoices() {
			const group = document.createElement("div");
			group.className = "thinking-choices";
			const label = document.createElement("div");
			label.className = "menu-heading";
			label.textContent = "Thinking";
			const levels = document.createElement("div");
			levels.className = "thinking-segments";
			levels.setAttribute("role", "group");
			levels.setAttribute("aria-label", "Thinking level");
			group.append(label, levels);
			for (const level of current.thinkingLevels ?? []) {
				const choice = row(level, "", () => selectThinking(level), levels);
				choice.setAttribute("aria-pressed", String(level === current.thinking));
			}
			if (!current.thinkingLevels?.length) levels.append("Not available");
			return group;
		}
		async function selectThinking(level: string) {
			try {
				const result = await request("setThinking", { level });
				if (typeof result.level === "string") {
					current = { ...current, thinking: result.level };
					paintModel(current.model?.name, result.level);
				}
			} catch (error) {
				fail(error);
			}
		}
		function loadModels() {
			fetching ??= request("models")
				.then((result) => {
					if (!Array.isArray(result.models)) throw Error("Pi did not return models.");
					const next = result.models as Model[];
					if (JSON.stringify(next) !== JSON.stringify(modelCache)) modelCache = next;
				})
				.finally(() => {
					fetching = undefined;
				});
			return fetching;
		}
		function prefetch() {
			if (prefetched) return;
			prefetched = true;
			void loadModels().catch(() => {});
		}
		function openModels() {
			openMenu("model", "Model", model);
			const version = epoch;
			const filter = document.createElement("input");
			filter.type = "search";
			filter.placeholder = "Filter models…";
			filter.setAttribute("aria-label", "Filter models");
			const list = document.createElement("div");
			list.className = "model-list";
			const heading = document.createElement("div");
			heading.className = "menu-heading";
			heading.textContent = "Model";
			const results = document.createElement("div");
			results.className = "model-results";
			list.append(heading, results);
			menu.append(filter, list, thinkingChoices());
			const paint = () => {
				if (modelCache) modelRows(results, modelCache, filter.value);
				else results.textContent = "Loading models…";
				options.push(...menu.querySelectorAll<HTMLButtonElement>(".thinking-choices button"));
			};
			const previous = modelCache;
			paint();
			if (!previous) menu.style.height = `${cachedHeight}px`;
			showMenu();
			cachedHeight = placement?.height ?? cachedHeight;
			// Reserve this opening's height. Background changes scroll inside the model list.
			menu.style.height = `${cachedHeight}px`;
			filter.addEventListener("input", () => {
				paint();
				list.scrollTop = 0;
			});
			void loadModels().then(
				() => {
					if (version === epoch && previous !== modelCache) paint();
				},
				(error) => {
					if (version === epoch && !modelCache) {
						closeMenu();
						fail(error);
					}
				},
			);
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered guards preserve menu and caret state.
		function modelRows(list: HTMLElement, models: Model[], filter: string) {
			list.replaceChildren();
			options = [];
			const query = filter.toLowerCase().trim();
			const filtered = models.filter((entry) =>
				`${entry.provider} ${entry.name} ${entry.id}`.toLowerCase().includes(query),
			);
			for (const provider of new Set(filtered.map((entry) => entry.provider))) {
				const heading = document.createElement("div");
				heading.className = "menu-group";
				heading.textContent = provider;
				list.append(heading);
				for (const entry of filtered.filter((item) => item.provider === provider))
					row(entry.name, entry.current ? "✓ Current" : "", () => selectModel(entry), list);
			}
			if (options.length === 0) list.textContent = "No matching models";
			else options[0].classList.add("current");
			selected = 0;
		}
		async function selectModel(entry: Model) {
			closeMenu();
			try {
				const result = await request("setModel", { provider: entry.provider, id: entry.id });
				if (result.applied !== true) notice(String(result.message ?? "Pi did not select this model."));
			} catch (error) {
				fail(error);
			}
		}
		function offerRestore() {
			return recoveryLabel && !input.value && !recovering;
		}
		async function restore() {
			closeMenu();
			if (input.value || recovering || !recoveryLabel) return;
			recovering = true;
			try {
				const result = await request("restore");
				if (!input.value && recoveryLabel && typeof result.text === "string" && whole(result.text)) recoveryLabel = "";
			} catch (error) {
				fail(error);
			} finally {
				recovering = false;
			}
		}
		function paintModel(name = "Model", level = "") {
			get("model-name").textContent = name;
			get("thinking-level").textContent = level;
			for (const choice of menu.querySelectorAll(".thinking-segments button")) {
				choice.setAttribute("aria-pressed", String(choice.textContent === level));
			}
			model.setAttribute("aria-label", ["Choose model and thinking level", name, level].filter(Boolean).join(": "));
		}
		function sync(next: State, connection: string) {
			current = next;
			connected = connection === "connected";
			model.disabled = !connected;
			paintModel(next.model?.name, next.thinking);
			const messages = next.queued ?? [],
				signature = JSON.stringify(messages);
			if (signature !== queueKey) {
				queueKey = signature;
				queued.replaceChildren();
				if (messages.length) drawQueue(messages);
			}
			queued.hidden = !messages.length;
			if (!connected && (mode === "model" || mode === "completion")) closeMenu();
			else positionMenu();
		}
		function drawQueue(messages: NonNullable<State["queued"]>) {
			for (const message of messages) {
				const line = document.createElement("div");
				line.className = "queue-row";
				line.dataset.behavior = message.behavior;
				const tag = document.createElement("b");
				tag.textContent = message.behavior === "steer" ? "Steer" : "Queue";
				const text = document.createElement("span");
				text.textContent = message.text;
				const takeBack = iconButton("edit", "Edit queued messages", () => {
					void request("dequeue").catch(fail);
				});
				line.append(icon(message.behavior === "steer" ? "steer" : "queue"), tag, text, takeBack);
				queued.append(line);
			}
		}
		let coloured: string | undefined;
		function updateSpan(span: HTMLElement, part: { text: string; kind?: string }) {
			if (span.textContent !== part.text) span.textContent = part.text;
			if (span.dataset.syntax !== part.kind) {
				if (part.kind) span.dataset.syntax = part.kind;
				else delete span.dataset.syntax;
			}
			if (!span.parentNode) backdrop.insertBefore(span, backdrop.lastChild);
		}
		function colour() {
			if (coloured === input.value) return;
			coloured = input.value;
			// Keep unchanged spans (and WebKit's line boxes) when typing at the end of a draft.
			const parts = assist.syntaxParts(coloured);
			let node = backdrop.firstElementChild;
			for (const part of parts) {
				const span = (node as HTMLElement | null) ?? document.createElement("span");
				node = span.nextElementSibling;
				updateSpan(span, part);
			}
			while (node) {
				const next = node.nextElementSibling;
				node.remove();
				node = next;
			}
			if (backdrop.lastChild?.nodeType !== Node.TEXT_NODE) backdrop.append("\u200b");
		}
		function imageStrip() {
			const matches = assist.imagePaths(input.value).slice(0, 12);
			const signature = JSON.stringify(matches.map(({ path, start }) => [path, start, Boolean(imageCache.get(path))]));
			if (signature === imageSignature) return;
			imageSignature = signature;
			images.replaceChildren();
			for (const match of matches) {
				const url = imageCache.get(match.path);
				if (url) images.append(imageTile(match, url));
				else if (url === undefined) fetchThumbnail(match.path);
			}
		}
		function fetchThumbnail(path: string) {
			if (imageCache.size > 80) imageCache.clear();
			imageCache.set(path, null);
			void request("thumbnail", { path }).then(
				(result) => {
					if (typeof result.url === "string" && result.url.startsWith("data:image/png;base64,")) {
						imageCache.set(path, result.url);
						imageStrip();
					}
				},
				() => {},
			);
		}
		function imageTile(match: Match, url: string) {
			const tile = document.createElement("div"),
				image = document.createElement("img");
			tile.className = "thumbnail";
			image.src = url;
			image.alt = match.path.split("/").at(-1) ?? "Image";
			const remove = iconButton("close", `Remove ${image.alt}`, () => {
				const latest = assist
					.imagePaths(input.value)
					.find((item) => item.path === match.path && item.start === match.start);
				if (latest) edit({ ...latest, text: "" });
			});
			tile.append(image, remove);
			return tile;
		}
		function updated(person = false) {
			if (person && recalled !== null && input.value !== entries[recalled]) recalled = null;
			colour();
			if (mode === "add") openAdd();
			clearTimeout(imageTimer);
			if (images.childElementCount) imageStrip();
			else imageTimer = setTimeout(imageStrip, 170);
			if (person && (!mode || mode === "completion")) complete();
		}
		function historyKey(event: KeyboardEvent) {
			if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.metaKey || event.altKey || event.shiftKey)
				return false;
			const next = assist.historyStep(
				{
					entries,
					index: recalled,
					text: input.value,
					base: "",
					selectionStart: input.selectionStart,
					selectionEnd: input.selectionEnd,
				},
				event.key === "ArrowUp" ? -1 : 1,
			);
			if (!next) return false;
			if (whole(next.text)) recalled = next.index;
			return true;
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered guards preserve menu and caret state.
		function key(event: KeyboardEvent) {
			if (event.isComposing) return false;
			if (mode && event.key === "Escape") {
				closeMenu();
				return true;
			}
			if (
				(input.readOnly && mode !== "context") ||
				(mode && event.target instanceof HTMLButtonElement) ||
				(event.key === "Tab" && mode && mode !== "completion")
			)
				return false;
			if (mode && event.key === "ArrowUp") {
				move(selected - 1);
				return true;
			}
			if (mode && event.key === "ArrowDown") {
				move(selected + 1);
				return true;
			}
			if (mode && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && options[selected]) {
				options[selected].click();
				return true;
			}
			if (event.key === "Tab" && !event.shiftKey && document.activeElement === input && connected) {
				complete(true);
				return true;
			}
			return document.activeElement === input && historyKey(event);
		}
		function drop(event: DragEvent) {
			const files = [...(event.dataTransfer?.files ?? [])];
			if (files.length === 0) return;
			event.preventDefault();
			void Promise.all(files.map(readImage)).then((results) => addPaths(results.flat()), fail);
		}
		async function readImage(file: File): Promise<string[]> {
			if (!file.type.startsWith("image/")) throw new Error("Use Add → Image or file to insert this file's path.");
			if (file.size > 20 * 1024 * 1024) throw new Error("The image exceeds 20 MiB.");
			const data = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onerror = () => reject(Error("The image could not be read."));
				reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
				reader.readAsDataURL(file);
			});
			return ((await request("image", { data })).paths as string[]) ?? [];
		}
		menu.addEventListener("keydown", (event) => {
			if (key(event)) event.preventDefault();
		});
		function contextGesture(event: MouseEvent) {
			return event.button === 2 || (event.button === 0 && event.ctrlKey);
		}
		input.addEventListener("pointerdown", (event) => {
			if (contextGesture(event)) event.preventDefault();
		});
		input.addEventListener("contextmenu", openContext);
		document.addEventListener("pointerdown", (event) => {
			const target = event.target as Node;
			if (!mode || menu.contains(target) || anchors.some((control) => control.contains(target))) return;
			if (target === input && contextGesture(event)) return;
			if (!pane.contains(target)) event.preventDefault();
			closeMenu();
		});
		input.addEventListener("selectionchange", () => protectCaret(true));
		input.addEventListener("scroll", () => {
			backdrop.scrollLeft = input.scrollLeft;
			backdrop.scrollTop = input.scrollTop;
			protectCaret(false);
			if (mode === "completion") positionMenu();
		});
		input.addEventListener("select", () => {
			if (mode === "completion") positionMenu();
		});
		new ResizeObserver(() => {
			protectCaret(true);
			positionMenu();
		}).observe(input);
		document.addEventListener("dragover", (event) => {
			if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
		});
		document.addEventListener("drop", drop);
		window.addEventListener("resize", () => positionMenu());
		input.addEventListener("paste", (event) => {
			if (event.clipboardData?.types.includes("Files") || !event.clipboardData?.getData("text/plain")) {
				event.preventDefault();
				void addFiles("pasteFiles");
			}
		});
		add.addEventListener("click", () => {
			if (mode === "add") closeMenu();
			else openAdd();
		});
		model.addEventListener("click", () => {
			if (mode === "model") closeMenu();
			else void openModels();
		});
		return {
			key,
			sync,
			updated,
			viewport,
			revealCaret,
			prefetch,
			paste: (paths: unknown) => addPaths(paths),
			history(next: string[]) {
				recalled = assist.historyIndexAfterUpdate(entries, recalled, input.value, next);
				entries = next;
			},
			recovery(label: string) {
				recoveryLabel = label;
				if (mode === "add") openAdd();
			},
			models: openModels,
			get mode() {
				return mode;
			},
		};
	}
	root.mountComposerControls = mount;
})();
