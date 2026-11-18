(() => {
	interface Edit { start: number; end: number; text: string; cursor?: number }
	interface Match { path: string; start: number; end: number }
	interface Item { value: string; label: string; description?: string }
	interface Assistance {
		completionTrigger(text: string, cursor: number): boolean;
		completionEdit(before: string, result: string, cursor: number): Edit | null;
		historyStep(context: { entries: string[]; index: number | null; text: string; base: string; selectionStart: number; selectionEnd: number }, direction: -1 | 1): { index: number | null; text: string } | null;
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
	interface Model { provider: string; id: string; name: string; current?: boolean }
	const root = globalThis as typeof globalThis & { composerAssistance: Assistance; mountComposerControls?: typeof mount };
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
		node.addEventListener("click", () => { action(); });
		return node;
	}
	function mount(host: Host) {
		const { input, request, edit, notice, icon, preferences } = host;
		const assist = root.composerAssistance;
		const menu = get("menu"), backdrop = get("highlight"), images = get("images"), queued = get("queued");
		const model = get<HTMLButtonElement>("model"), thinking = get<HTMLButtonElement>("thinking"), add = get<HTMLButtonElement>("add");
		const anchors = [add, model, thinking];
		const recovery = get<HTMLButtonElement>("recovery");
		const editQueued = get<HTMLButtonElement>("edit-queued");
		const imageCache = new Map<string, string | null>();
		let current: State = {}, connected = false, entries: string[] = [], recalled: number | null = null;
		let mode = "", selected = 0, options: HTMLButtonElement[] = [], epoch = 0, timer: ReturnType<typeof setTimeout> | undefined;
		let queueKey = "";
		let menuAnchor: HTMLElement | undefined;
		let recoveryLabel = "", recovering = false;
		let imageTimer: ReturnType<typeof setTimeout> | undefined;
		const fail = (error: unknown) => notice(error instanceof Error ? error.message : String(error));
		const removeSelection = () => ({ start: input.selectionStart, end: input.selectionEnd });
		const whole = (text: string) => edit({ start: 0, end: input.value.length, text });

		function closeMenu(focus = false) {
			epoch++;
			clearTimeout(timer);
			menu.hidden = true;
			menu.replaceChildren();
			mode = "";
			input.removeAttribute("aria-controls");
			for (const control of anchors) control.setAttribute("aria-expanded", "false");
			if (focus) input.focus({ preventScroll: true });
		}
		function openMenu(kind: string, title: string, anchor?: HTMLElement) {
			menu.replaceChildren();
			menu.dataset.kind = kind;
			menu.hidden = false;
			mode = kind;
			selected = 0;
			options = [];
			if (kind !== "model") {
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
		function placeCompletion(line: DOMRect, naturalHeight: number) {
			const editor = input.getBoundingClientRect();
			const above = line.top - 12;
			const below = innerHeight - line.bottom - 12;
			const placeBelow = below >= naturalHeight || above < 38;
			const available = placeBelow ? below : above;
			if (line.bottom <= editor.top || line.top >= editor.bottom || available < 38) { closeMenu(); return; }
			menu.style.maxHeight = `${available}px`;
			menu.style.top = `${placeBelow ? line.bottom + 6 : line.top - menu.offsetHeight - 6}px`;
		}
		function positionMenu() {
			if (menu.hidden) return;
			const rect = menuAnchor?.getBoundingClientRect() ?? caretLine();
			if (!rect) { closeMenu(); return; }
			menu.style.left = `${Math.max(6, Math.min(rect.left, innerWidth - menu.offsetWidth - 6))}px`;
			menu.style.removeProperty("max-height");
			if (mode === "completion") { placeCompletion(rect, menu.offsetHeight); return; }
			const height = menu.offsetHeight;
			const beside = rect.bottom + 12 + height <= innerHeight ? rect.bottom + 6 : rect.top - height - 6;
			menu.style.top = `${Math.max(6, Math.min(beside, innerHeight - height - 6))}px`;
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
			} catch (error) { fail(error); }
		}
		function complete(force = false) {
			clearTimeout(timer);
			const version = ++epoch, text = input.value, cursor = input.selectionEnd;
			if (!connected || input.readOnly || (!force && !assist.completionTrigger(text, cursor))) {
				if (mode === "completion") closeMenu();
				return;
			}
			timer = setTimeout(() => {
				// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Discard stale replies before constructing menu rows.
				void request("complete", { text, cursor, force }).then((result) => {
					if (version !== epoch || input.value !== text || input.selectionEnd !== cursor) return;
					const items = result.items as Item[] | undefined;
					const prefix = typeof result.prefix === "string" ? result.prefix : "";
					if (!items?.length) { if (mode === "completion") closeMenu(); return; }
					openMenu("completion", text.startsWith("/") ? "Pi commands" : "Pi completions");
					for (const item of items.slice(0, 50)) row(item.label, item.description ?? "", () => apply(item, prefix, text, cursor));
					positionMenu();
					options[0]?.classList.add("current");
				}, () => { if (force && version === epoch) notice("Pi did not return completions."); });
			}, force ? 0 : 80);
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered guards preserve menu and caret state.
		function addPaths(paths: unknown) {
			if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path.startsWith("/"))) return;
			if (paths.length === 0) return;
			const range = removeSelection(), shell = input.value.startsWith("!");
			const separator = range.start > 0 && !/\s$/u.test(input.value.slice(0, range.start)) ? (shell ? " " : "\n") : "";
			const value = paths.map((path: string) => shell ? `'${path.replaceAll("'", "'\\''")}'` : path).join(shell ? " " : "\n");
			edit({ ...range, text: separator + value });
		}
		async function addFiles(type: string, fields?: Record<string, unknown>) {
			try { addPaths((await request(type, fields)).paths); } catch (error) { fail(error); }
		}
		function openAdd() {
			closeMenu();
			openMenu("add", "Add to message", add);
			row("Image or file…", "", () => { closeMenu(true); void addFiles("pick"); });
			if (connected) row("Mention a file", "@", () => { closeMenu(true); edit({ ...removeSelection(), text: "@" }); complete(true); });
			if (connected) row("Pi commands", "/", () => {
				closeMenu(true);
				if (input.value.length === 0) whole("/");
				complete(true);
			});
			if (entries.length > 0) row("Recent messages", "", openHistory);
			row("Send key", preferences().sendKey === "command" ? "⌘⏎" : "⏎", () => { preferences().toggleSendKey(); openAdd(); });
			const sizes = document.createElement("div"), value = document.createElement("span");
			sizes.className = "size-actions";
			value.textContent = `${Math.round(preferences().size)} pt`;
			for (const [glyph, label, step] of [["smaller", "Smaller text", -1], ["reset", "Reset text size", 0], ["larger", "Larger text", 1]] as const) {
				sizes.append(iconButton(glyph, label, () => {
					preferences().resize(step);
					value.textContent = `${Math.round(preferences().size)} pt`;
				}));
			}
			sizes.append(value);
			menu.append(sizes);
			positionMenu();
		}
		function openHistory() {
			openMenu("history", "Recent messages", add);
			for (const entry of entries.slice().reverse()) row(entry.split("\n")[0], "", () => {
				closeMenu(true);
				const index = entries.lastIndexOf(entry);
				if (whole(entry)) recalled = index;
			});
			positionMenu();
		}
		function openThinking() {
			closeMenu();
			openMenu("thinking", "Thinking level", thinking);
			for (const level of current.thinkingLevels ?? []) {
				const selected = level === current.thinking;
				const choice = row(level, selected ? "✓ Current" : "", () => selectThinking(level));
				choice.setAttribute("aria-pressed", String(selected));
			}
			positionMenu();
			(options.find((choice) => choice.getAttribute("aria-pressed") === "true") ?? options[0])?.focus({ preventScroll: true });
		}
		async function selectThinking(level: string) {
			closeMenu(true);
			try {
				const result = await request("setThinking", { level });
				if (typeof result.level === "string") paintModel(current.model?.name, result.level);
			} catch (error) { fail(error); }
		}
		async function openModels() {
			closeMenu();
			openMenu("model", "Choose model", model);
			const version = epoch;
			const filter = document.createElement("input");
			filter.type = "search";
			filter.placeholder = "Filter models…";
			filter.setAttribute("aria-label", "Filter models");
			const list = document.createElement("div");
			list.className = "model-list";
			list.textContent = "Loading models…";
			menu.append(filter, list);
			positionMenu();
			filter.focus({ preventScroll: true });
			try {
				const data = await request("models");
				if (version !== epoch) return;
				const models = (data.models as Model[] | undefined) ?? [];
				const paint = () => {
					modelRows(list, models, filter.value);
					positionMenu();
				};
				filter.addEventListener("input", paint);
				paint();
			} catch (error) { if (version === epoch) { closeMenu(true); fail(error); } }
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered guards preserve menu and caret state.
		function modelRows(list: HTMLElement, models: Model[], filter: string) {
			list.replaceChildren();
			options = [];
			const query = filter.toLowerCase().trim();
			const filtered = models.filter((entry) => `${entry.provider} ${entry.name} ${entry.id}`.toLowerCase().includes(query));
			for (const provider of new Set(filtered.map((entry) => entry.provider))) {
				const heading = document.createElement("div");
				heading.className = "menu-group";
				heading.textContent = provider;
				list.append(heading);
				for (const entry of filtered.filter((item) => item.provider === provider)) row(entry.name, entry.current ? "✓ Current" : "", () => selectModel(entry), list);
			}
			if (options.length === 0) list.textContent = "No matching models";
			else options[0].classList.add("current");
			list.scrollTop = 0;
			selected = 0;
		}
		async function selectModel(entry: Model) {
			closeMenu(true);
			try {
				const result = await request("setModel", { provider: entry.provider, id: entry.id });
				if (result.applied !== true) notice(String(result.message ?? "Pi did not select this model."));
			} catch (error) { fail(error); }
		}
		function showRecovery() {
			recovery.hidden = !recoveryLabel || Boolean(input.value) || recovering;
			recovery.textContent = `Restore unsent draft (${recoveryLabel})`;
		}
		function paintModel(name = "Model", level = "") {
			get("model-full").textContent = name;
			get("model-short").textContent = name.replace(/^(Anthropic|Claude|OpenAI|Google)\s+/iu, "");
			get("model-level").textContent = level;
			model.setAttribute("aria-label", `Choose model: ${name}`);
			thinking.setAttribute("aria-label", level ? `Choose thinking level: ${level}` : "Choose thinking level");
		}
		function sync(next: State, connection: string) {
			current = next;
			connected = connection === "connected";
			model.disabled = !connected;
			thinking.disabled = !connected || !next.thinkingLevels?.length;
			paintModel(next.model?.name, next.thinking);
			const messages = next.queued ?? [], signature = JSON.stringify(messages);
			if (signature !== queueKey) {
				queueKey = signature;
				queued.replaceChildren();
				if (messages.length) drawQueue(messages);
			}
			queued.hidden = !messages.length;
			editQueued.hidden = !connected || !messages.length;
			get("queued-count").textContent = `(${messages.length})`;
			positionMenu();
			if (!connected && mode && mode !== "add" && mode !== "history") closeMenu();
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
				const takeBack = iconButton("close", "Take back queued messages", () => { void request("dequeue").catch(fail); });
				line.append(icon(message.behavior === "steer" ? "steer" : "queue"), tag, text, takeBack);
				queued.append(line);
			}
		}
		function colour() {
			const spans = assist.syntaxParts(input.value).map((part) => {
				const node = document.createElement("span");
				node.textContent = part.text;
				if (part.kind) node.dataset.syntax = part.kind;
				return node;
			});
			backdrop.replaceChildren(...spans, "\u200b");
			backdrop.scrollTop = input.scrollTop;
			backdrop.scrollLeft = input.scrollLeft;
		}
		function imageStrip() {
			const matches = assist.imagePaths(input.value).slice(0, 12);
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
			void request("thumbnail", { path }).then((result) => {
				if (typeof result.url === "string" && result.url.startsWith("data:image/png;base64,")) {
					imageCache.set(path, result.url);
					imageStrip();
				}
			}, () => {});
		}
		function imageTile(match: Match, url: string) {
			const tile = document.createElement("div"), image = document.createElement("img");
			tile.className = "thumbnail";
			image.src = url;
			image.alt = match.path.split("/").at(-1) ?? "Image";
			const remove = iconButton("close", `Remove ${image.alt}`, () => {
				const latest = assist.imagePaths(input.value).find((item) => item.path === match.path && item.start === match.start);
				if (latest) edit({ ...latest, text: "" });
			});
			tile.append(image, remove);
			return tile;
		}
		function updated(person = false) {
			if (person && recalled !== null && input.value !== entries[recalled]) recalled = null;
			colour();
			showRecovery();
			clearTimeout(imageTimer);
			if (images.children.length) imageStrip();
			else imageTimer = setTimeout(imageStrip, 170);
			if (person && (!mode || mode === "completion")) complete();
		}
		function historyKey(event: KeyboardEvent) {
			if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.metaKey || event.altKey || event.shiftKey) return false;
			const next = assist.historyStep({ entries, index: recalled, text: input.value, base: "", selectionStart: input.selectionStart, selectionEnd: input.selectionEnd }, event.key === "ArrowUp" ? -1 : 1);
			if (!next) return false;
			if (whole(next.text)) recalled = next.index;
			return true;
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered guards preserve menu and caret state.
		function key(event: KeyboardEvent) {
			if (event.isComposing) return false;
			if (mode && event.key === "Escape") { closeMenu(true); return true; }
			if (input.readOnly || (mode && event.target instanceof HTMLButtonElement) || (event.key === "Tab" && mode && mode !== "completion")) return false;
			if (mode && event.key === "ArrowUp") { move(selected - 1); return true; }
			if (mode && event.key === "ArrowDown") { move(selected + 1); return true; }
			if (mode && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && options[selected]) { options[selected].click(); return true; }
			if (event.key === "Tab" && !event.shiftKey && document.activeElement === input && connected) { complete(true); return true; }
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
		menu.addEventListener("keydown", (event) => { if (key(event)) event.preventDefault(); });
		document.addEventListener("pointerdown", (event) => {
			const target = event.target as Node;
			if (mode && !menu.contains(target) && !anchors.some((control) => control.contains(target))) closeMenu();
		});
		input.addEventListener("scroll", () => { colour(); if (mode === "completion") positionMenu(); });
		input.addEventListener("select", () => { if (mode === "completion") positionMenu(); });
		new ResizeObserver(() => { colour(); positionMenu(); }).observe(input);
		document.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
		document.addEventListener("drop", drop);
		window.addEventListener("resize", positionMenu);
		input.addEventListener("paste", (event) => {
			if (event.clipboardData?.types.includes("Files") || !event.clipboardData?.getData("text/plain")) {
				event.preventDefault();
				void addFiles("pasteFiles");
			}
		});
		add.addEventListener("click", () => { if (mode === "add") closeMenu(true); else openAdd(); });
		model.addEventListener("click", () => { if (mode === "model") closeMenu(true); else void openModels(); });
		thinking.addEventListener("click", () => { if (mode === "thinking") closeMenu(true); else openThinking(); });
		editQueued.addEventListener("click", () => { void request("dequeue").catch(fail); });
		recovery.addEventListener("click", async () => {
			try {
				const result = await request("restore");
				if (!input.value && typeof result.text === "string" && whole(result.text)) { recovering = true; showRecovery(); }
			} catch (error) { fail(error); }
		});
		return {
			key, sync, updated, paste: (paths: unknown) => addPaths(paths),
			history(next: string[]) { entries = next; recalled = null; },
			recovery(label: string) { recoveryLabel = label; showRecovery(); },
			models: openModels,
			get mode() { return mode; },
		};
	}
	root.mountComposerControls = mount;
})();
