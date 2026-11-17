(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;

	interface EditorToken {
		text: string;
		kind: string;
	}

	const MARKER_MARKS: Record<string, string> = { bold: "**", italic: "*", code: "`" };
	const FORMAT_KEYS: Record<string, string> = { b: "bold", i: "italic" };

	// The span classes (plain, mark, prefix, bold, italic, code, link, strike)
	// are the stable styling contract: cosmetic colour, weight, and font size
	// belong to UI CSS. Only structural geometry (moving prefix marks out of the
	// text flow so caret geometry matches the plain text) is set inline here.
	function buildSpans(owner: Document, tokens: EditorToken[]) {
		const fragment = owner.createDocumentFragment();
		for (const token of tokens) {
			const span = owner.createElement("span");
			span.className = token.kind;
			span.textContent = token.text;
			if (token.kind === "prefix") {
				span.style.position = "absolute";
				span.style.transform = "translateX(-100%)";
				span.style.whiteSpace = "pre";
			}
			fragment.append(span);
		}
		return { tokens, fragment };
	}

	function tokensFor(model: ReaderSourceModelAPI, text: string, type: string | undefined, plain: boolean) {
		const tokens: EditorToken[] = plain ? [{ text, kind: "plain" }] : model.tokens(text, type);
		return tokens;
	}

	// A restyle is skipped when the existing flat span structure already matches
	// the token list exactly; this keeps typing cheap and the DOM stable.
	function sameSpanStructure(el: HTMLElement, tokens: EditorToken[]) {
		if (el.childNodes.length !== tokens.length) return false;
		return tokens.every((token, i) => {
			const node = el.childNodes[i];
			if (node.nodeType !== 1) return false;
			const span = node as HTMLElement;
			return (
				span.tagName === "SPAN" &&
				span.className === token.kind &&
				span.textContent === token.text &&
				((span.childNodes.length === 0 && token.text === "") ||
					(span.childNodes.length === 1 && span.firstChild?.nodeType === 3))
			);
		});
	}

	function caretRangeFromPoint(owner: Document, x: number, y: number) {
		const document = owner as Document & { caretRangeFromPoint(x: number, y: number): Range | null };
		return document.caretRangeFromPoint?.(x, y);
	}

	type FormatPlan = {
		start: number;
		end: number;
		value: string;
		selectionStart: number;
		selectionEnd: number;
	};

	function planMarkerFormat(name: string, source: string, a: number, b: number): FormatPlan {
		const old = source.slice(a, b);
		let mark = MARKER_MARKS[name];
		if (name === "code") {
			const ticks = [...old.matchAll(/`+/g)].map((m) => m[0].length);
			mark = "`".repeat(Math.max(0, ...ticks) + 1);
		}
		if (source.slice(a - mark.length, a) === mark && source.slice(b, b + mark.length) === mark) {
			// The selection already carries the marker pair, so unwrap it.
			return {
				start: a - mark.length,
				end: b + mark.length,
				value: old,
				selectionStart: a - mark.length,
				selectionEnd: a - mark.length + old.length,
			};
		}
		const white = name === "code" ? null : /^(\s*)([\s\S]*?)(\s*)$/.exec(old);
		const left = white?.[1] ?? "";
		const body = white?.[2] ?? old;
		const right = white?.[3] ?? "";
		return {
			start: a,
			end: b,
			value: left + mark + body + mark + right,
			selectionStart: a + left.length + mark.length,
			selectionEnd: a + left.length + mark.length + body.length,
		};
	}

	function planLinkFormat(source: string, a: number, b: number): FormatPlan {
		const old = source.slice(a, b);
		return {
			start: a,
			end: b,
			value: `[${old}](https://)`,
			selectionStart: a + old.length + 3,
			selectionEnd: a + old.length + 3 + 8,
		};
	}

	function linePrefixFor(name: string, command: string | { command: string; level?: number }): string | null {
		const level = typeof command === "string" ? undefined : command.level;
		switch (name) {
			case "heading":
				return Number.isInteger(level) && level !== undefined && level >= 0 && level <= 6
					? "#".repeat(level) + (level ? " " : "")
					: null;
			case "bulletList":
				return "- ";
			case "numberedList":
				return "1. ";
			case "taskList":
				return "- [ ] ";
			case "quote":
				return "> ";
			case "indent":
				return "  ";
			case "outdent":
				return "";
			default:
				return null;
		}
	}

	function planLineFormat(
		name: string,
		command: string | { command: string; level?: number },
		source: string,
		a: number,
		b: number,
	): FormatPlan | null {
		const prefix = linePrefixFor(name, command);
		if (prefix === null) return null;
		let start = a;
		while (start > 0 && !/[\r\n]/.test(source[start - 1])) start--;
		let end = b;
		while (end < source.length && !/[\r\n]/.test(source[end])) end++;
		const value = source
			.slice(start, end)
			.replace(/(^|\r\n|\r|\n)([^\r\n]*)/g, (_all, breaks: string, line: string) => {
				if (name === "indent") return breaks + prefix + line;
				if (name === "outdent") return breaks + line.replace(/^(?: {1,2}|\t)/, "");
				return (
					breaks +
					prefix +
					line.replace(/^(?:#{1,6}[ \t]+|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/, "")
				);
			});
		return { start, end, value, selectionStart: start, selectionEnd: start + value.length };
	}

	function planFormat(
		name: string,
		command: string | { command: string; level?: number },
		source: string,
		a: number,
		b: number,
	): FormatPlan | null {
		if (Object.hasOwn(MARKER_MARKS, name)) return planMarkerFormat(name, source, a, b);
		if (name === "link") return planLinkFormat(source, a, b);
		return planLineFormat(name, command, source, a, b);
	}

	function attachedWindow(owner: Document) {
		const view = owner.defaultView;
		if (!view) throw new Error("The editor requires a document with an attached window.");
		return view;
	}

	api.createEditor = (controller, root, options = {}) => {
		const model = api.sourceModel,
			host = controller.host,
			owner = root.ownerDocument;
		const win = attachedWindow(owner);
		const nodes = new Map<string, HTMLElement>();
		const html = new WeakMap<HTMLElement, string>();
		const off: (() => void)[] = [];
		root.dataset.role = "document";
		type ActiveBlock = {
			key: string;
			el: HTMLElement;
			map: ReaderLineMap;
			shown: string;
			originalStyle: string | null;
			type: string;
		};
		let active: ActiveBlock | null = null;
		let composing = false,
			committing = false,
			disposed = false,
			oneOff = false;
		let pointer: {
			x: number;
			y: number;
			dragged: boolean;
			anchorSource: number | null;
			crossed: boolean;
		} | null = null;
		let pendingPatch = false,
			pendingDocument = false,
			pendingClose = false,
			pendingDispose = false;
		let pendingOpen: { position: number; generation: number; oneOff: boolean } | null = null;
		let renderedSelection: { anchor: number; focus: number } | null = null;
		let anchor: { el: HTMLElement; top: number } | null = null;

		function listen(target: EventTarget, type: string, fn: EventListener) {
			target.addEventListener(type, fn);
			off.push(() => target.removeEventListener(type, fn));
		}
		function blockFor(el: HTMLElement) {
			return controller.blocks.find((b) => b.key === el.dataset.block);
		}
		function scope() {
			return controller.doc?.active ?? undefined;
		}
		function caret() {
			const s = win.getSelection();
			if (!active || !s?.anchorNode || !s.focusNode) return null;
			const a = model.offset(active.el, s.anchorNode, s.anchorOffset),
				f = model.offset(active.el, s.focusNode, s.focusOffset);
			return a === null || f === null ? null : { anchor: a, focus: f };
		}
		function select(a: number, b = a) {
			if (!active) return;
			const max = active.shown.length;
			const x = model.point(active.el, Math.max(0, Math.min(max, a))),
				y = model.point(active.el, Math.max(0, Math.min(max, b)));
			win.getSelection()?.setBaseAndExtent(x.node, x.offset, y.node, y.offset);
		}
		function restyle() {
			if (!active || composing) return;
			const tokens = tokensFor(model, active.shown, active.type, !!options.plainSource);
			if (sameSpanStructure(active.el, tokens)) return;
			const selection = caret();
			active.el.replaceChildren(buildSpans(owner, tokens).fragment);
			editor.restyles++;
			if (selection) select(selection.anchor, selection.focus);
		}
		function refreshActive() {
			if (!active || composing || committing || !controller.doc) return;
			const range = scope();
			if (!range) return;
			const doc = controller.doc;
			const map = new api.exact.LineMap(
				doc.source.slice(range.start, range.end),
				api.exact.dominantEnding(doc.source),
			);
			active.el.dataset.start = String(range.start);
			active.el.dataset.end = String(range.end);
			active.map = map;
			if (active.shown === map.display) return;
			const selection = caret();
			active.shown = map.display;
			restyle();
			if (selection) select(selection.anchor, selection.focus);
		}
		function holdStart() {
			if (anchor) return;
			const top = options.scroll?.getBoundingClientRect().top ?? 0;
			const el = [...root.children].find((n) => n.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
			if (el) anchor = { el, top: el.getBoundingClientRect().top };
		}
		function adjustScroll(delta: number) {
			if (!delta) return;
			if (options.scroll) options.scroll.scrollTop += delta;
			else win.scrollBy(0, delta);
		}
		function holdEnd() {
			if (!anchor || composing) return;
			const before = anchor;
			anchor = null;
			if (!before.el.isConnected) return;
			adjustScroll(before.el.getBoundingClientRect().top - before.top);
		}
		function setBody(el: HTMLElement, body: string) {
			if (html.get(el) === body) return;
			api.setRenderedHTML(el, body);
			html.set(el, body);
		}
		function ensureBlockElement(block: ReaderMappedBlock) {
			let el = nodes.get(block.key);
			if (!el) {
				el = owner.createElement("div");
				el.dataset.block = block.key;
				el.className = "reader-block";
				nodes.set(block.key, el);
			}
			el.dataset.start = String(block.start);
			el.dataset.end = String(block.end);
			el.dataset.type = block.type;
			setBody(el, block.html ?? "");
			return el;
		}
		function removeUnkeptBlocks(kept: Set<string>) {
			for (const [key, el] of nodes)
				if (!kept.has(key)) {
					el.remove();
					nodes.delete(key);
				}
		}
		// Blocks overlapping the open editor's range are replaced by the single
		// active editor element.
		function blockHeldByEditor(block: ReaderMappedBlock, range: ReaderRange | undefined) {
			return !!range && (api.exact.overlaps(block, range) || block.key === active?.key);
		}
		// Disjoint blocks are patched by key only, so their DOM identity survives
		// while the editor is open.
		function orderedElements(range: ReaderRange | undefined) {
			const current = active;
			if (!current) return controller.blocks.map(ensureBlockElement);
			const elements = controller.blocks.map((block) =>
				blockHeldByEditor(block, range) ? current.el : ensureBlockElement(block),
			);
			if (!elements.includes(current.el)) elements.push(current.el);
			return [...new Set(elements)];
		}
		function placeBlocks(range: ReaderRange | undefined) {
			const elements = orderedElements(range);
			removeUnkeptBlocks(new Set(elements.map((el) => el.dataset.block ?? "")));
			let next: HTMLElement | null = null;
			for (const el of elements.toReversed()) {
				// Never detach the active element: that also removes its selection.
				if (el !== active?.el && (el.parentNode !== root || el.nextSibling !== next)) root.insertBefore(el, next);
				next = el;
			}
		}
		function patch() {
			if (disposed) return;
			if (composing) {
				pendingPatch = true;
				return;
			}
			holdStart();
			placeBlocks(scope());
			refreshActive();
			holdEnd();
			restoreRenderedSelection();
			controller.emit("view", null);
		}
		function activeBlockSourceOffset(offset: number) {
			if (!active) return null;
			const r = scope();
			if (!r || offset < 0 || offset > active.map.display.length) return null;
			return r.start + active.map.toSource(offset);
		}
		function staticBlockSourceOffset(el: HTMLElement, offset: number) {
			const b = blockFor(el);
			if (!b || !controller.doc) return null;
			return model.map(b, controller.doc.source, el).boundaries[offset] ?? null;
		}
		function sourcePoint(node: Node, p: number): number | null {
			const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>("[data-block]");
			if (!el || !root.contains(el)) return null;
			const offset = model.offset(el, node, p);
			if (offset === null) return null;
			if (active?.el === el) return activeBlockSourceOffset(offset);
			return staticBlockSourceOffset(el, offset);
		}
		// Snap a source position inside a mapped entry to a rendered offset:
		// a fully crossed entry keeps the distance, otherwise the nearer edge wins.
		function mapEntryOffset(n: number, s: number, m: number, position: number) {
			if (n === m) return position - s;
			return position - s < m / 2 ? 0 : n;
		}
		function mappedEntry(map: NonNullable<ReaderMappedBlock["map"]>, position: number) {
			let nearest: (typeof map)[number] | undefined;
			let distance = Infinity;
			for (const entry of map) {
				const start = entry[2],
					end = start + entry[3],
					delta = Math.max(start - position, position - end, 0);
				if (delta >= distance) continue;
				nearest = entry;
				distance = delta;
				if (delta === 0) break;
			}
			return nearest;
		}
		function pointInBlock(block: ReaderMappedBlock, position: number): ReaderTextPoint | null {
			const el = nodes.get(block.key);
			if (!el) return null;
			const entry = block.map && mappedEntry(block.map, position);
			if (entry) {
				const [r, n, s, m] = entry;
				// Source-only marks collapse to the nearest native-mapped edge.
				const mappedPosition = Math.max(s, Math.min(s + m, position));
				return model.point(el, r + mapEntryOffset(n, s, m, mappedPosition));
			}
			if (block.map || !controller.doc) return null;
			const offset = model.map(block, controller.doc.source, el).boundaries.indexOf(position);
			return offset < 0 ? null : model.point(el, offset);
		}
		function renderedPoint(position: number): ReaderTextPoint | null {
			for (const block of controller.blocks) {
				if (position < block.start || position > block.end) continue;
				const point = pointInBlock(block, position);
				if (point) return point;
			}
			return null;
		}
		function restoreRenderedSelection() {
			if (!renderedSelection) return;
			const a = renderedPoint(renderedSelection.anchor),
				b = renderedPoint(renderedSelection.focus);
			if (a && b) win.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
		}
		function sourceAt(x: number, y: number) {
			const range = caretRangeFromPoint(owner, x, y);
			return range ? sourcePoint(range.startContainer, range.startOffset) : null;
		}
		function eventElement(event: Event) {
			const node = event.target as Node | null;
			return node?.nodeType === 1 ? (node as Element) : node?.parentElement;
		}
		function externalInput(event: Event) {
			const el = eventElement(event);
			if (el?.closest("[data-reader-control],input,textarea")) return true;
			return !!el?.closest("[contenteditable]") && !active?.el.contains(el);
		}
		function selection() {
			if (composing) return null;
			const s = win.getSelection();
			if (!s?.rangeCount || !s.anchorNode || !s.focusNode || s.isCollapsed) return null;
			const a = sourcePoint(s.anchorNode, s.anchorOffset),
				f = sourcePoint(s.focusNode, s.focusOffset);
			if (a === null || f === null) return null;
			return { text: s.toString(), start: Math.min(a, f), end: Math.max(a, f), anchor: a, focus: f };
		}
		function readDisplayedText(el: HTMLElement) {
			// WebKit normally keeps flat spans. A platform block insertion uses innerText
			// to retain its breaks and returns to the same plain-source representation.
			const unsupported = !!el.querySelector(":scope > :not(span), span > *");
			return unsupported ? el.innerText : (el.textContent ?? "");
		}
		function applyDisplayEdit(display: string) {
			if (!active || !controller.doc) return false;
			const range = scope();
			if (!range) return false;
			const map = new api.exact.LineMap(active.map.source, api.exact.dominantEnding(controller.doc.source));
			const local = map.toSourceEdit(api.exact.diff(active.shown, display));
			committing = true;
			try {
				const result = controller.change(
					[{ ...local, start: local.start + range.start, end: local.end + range.start }],
					{ blockId: active.key },
				);
				if (result?.status !== "ok") throw new Error("The source refused an input edit.");
				const next = scope();
				if (!next) return false;
				active.map = new api.exact.LineMap(
					controller.doc.source.slice(next.start, next.end),
					api.exact.dominantEnding(controller.doc.source),
				);
				active.shown = active.map.display;
			} finally {
				committing = false;
			}
			return true;
		}
		function input() {
			if (!active || composing || !controller.doc) return;
			const display = readDisplayedText(active.el);
			if (display !== active.shown && !applyDisplayEdit(display)) return;
			restyle();
			controller.state();
		}
		function insert(text: string) {
			const selected = caret();
			const s = win.getSelection();
			if (!selected || !active || !s) return;
			const range = s.getRangeAt(0),
				p = Math.min(selected.anchor, selected.focus);
			range.deleteContents();
			range.insertNode(owner.createTextNode(text));
			const a = model.point(active.el, p + text.length);
			s.setBaseAndExtent(a.node, a.offset, a.node, a.offset);
			input();
		}
		function closeForReplacement(selected: ReaderRange) {
			const range = scope();
			if (!active || (range && selected.start >= range.start && selected.end <= range.end)) return false;
			const returnToReading = oneOff;
			editor.close();
			if (returnToReading) controller.setLock("writing");
			return returnToReading;
		}
		function replaceSelection(text: string) {
			const selected = selection(),
				doc = controller.doc;
			if (!selected || !doc || controller.lock !== "writing" || composing) return false;
			const returnToReading = closeForReplacement(selected);
			renderedSelection = null;
			const value = text.replace(/\r\n|\r|\n/g, api.exact.dominantEnding(doc.source));
			doc.seal();
			const r = controller.change(
				[
					{
						start: selected.start,
						end: selected.end,
						text: value,
						expected: doc.source.slice(selected.start, selected.end),
					},
				],
				{ blockId: active?.key },
			);
			if (returnToReading) controller.setLock("reading");
			if (r?.status === "ok") {
				doc.seal();
				win.getSelection()?.removeAllRanges();
				controller.emit("selection", null);
				return true;
			}
			return false;
		}
		// A text-formatting edit only applies while the editor holds an open block
		// in writing mode outside composition.
		function editReady() {
			return !composing && controller.lock === "writing" && !!controller.doc;
		}
		function applyFormatPlan(plan: FormatPlan, scopeRange: ReaderRange, source: string) {
			const r = controller.change(
				[
					{
						start: plan.start + scopeRange.start,
						end: plan.end + scopeRange.start,
						text: plan.value,
						expected: source.slice(plan.start, plan.end),
					},
				],
				{ blockId: active?.key },
			);
			return r?.status === "ok";
		}
		function formatTarget() {
			if (active) return caret();
			const selected = selection();
			if (!selected) return null;
			const block = controller.blocks.find((b) => selected.start >= b.start && selected.end <= b.end);
			if (!block || !editor.open(block.key, 0, { selection: selected })) return null;
			const target = caret();
			return target && selected.anchor > selected.focus ? { anchor: target.focus, focus: target.anchor } : target;
		}
		function formatContext() {
			if (!editReady()) return null;
			const selected = formatTarget(),
				range = scope(),
				doc = controller.doc;
			return selected && range && doc && active ? { selected, range, doc, current: active } : null;
		}
		function applyFormat(command: string | { command: string; level?: number }) {
			const context = formatContext();
			if (!context) return false;
			const { selected, range, doc, current } = context;
			const source = doc.source.slice(range.start, range.end),
				name = typeof command === "string" ? command : command.command;
			const a = current.map.toSource(Math.min(selected.anchor, selected.focus)),
				b = current.map.toSource(Math.max(selected.anchor, selected.focus));
			const plan = planFormat(name, command, source, a, b);
			if (!plan) return false;
			doc.seal();
			if (!applyFormatPlan(plan, range, source)) return false;
			doc.seal();
			selectSourceRange(current.map, plan.selectionStart, plan.selectionEnd, selected.anchor > selected.focus);
			return true;
		}
		function selectSourceRange(map: ReaderLineMap, a: number, b: number, backward = false) {
			const start = model.sourceToDisplay(map, a),
				end = model.sourceToDisplay(map, b);
			if (backward) select(end, start);
			else select(start, end);
		}
		function measurePadding(el: HTMLElement, first: Text | undefined) {
			if (!first) return 0;
			const r = owner.createRange();
			r.setStart(first, 0);
			r.setEnd(first, 1);
			return r.getBoundingClientRect().left - el.getBoundingClientRect().left;
		}
		// Resolve a clicked point to a source offset inside the block. The click
		// must land inside the block and map to a real source boundary.
		function resolveClickTarget(el: HTMLElement, block: ReaderMappedBlock, at: { x: number; y: number }) {
			const range = caretRangeFromPoint(owner, at.x, at.y);
			if (!range || !el.contains(range.startContainer)) return null;
			const clickedTop = range.getBoundingClientRect().top;
			const n = model.offset(el, range.startContainer, range.startOffset);
			if (n === null || !controller.doc) return null;
			const exact = model.map(block, controller.doc.source, el).boundaries[n];
			if (exact === null || exact === undefined) return null;
			return { sourceOffset: exact - block.start, clickedTop };
		}
		function applyEditorChrome(el: HTMLElement, style: CSSStyleDeclaration, padding: number) {
			el.style.fontFamily = style.fontFamily;
			el.style.fontSize = style.fontSize;
			el.style.lineHeight = style.lineHeight;
			el.style.fontWeight = style.fontWeight;
			el.style.paddingLeft = `${padding}px`;
			el.style.position = "relative";
			el.style.whiteSpace = "pre-wrap";
			el.style.outline = "none";
			el.dataset.role = "block-editor";
			el.contentEditable = "plaintext-only";
			el.setAttribute("role", "textbox");
			el.setAttribute("aria-multiline", "true");
			el.setAttribute("aria-label", "Markdown block");
		}
		// After the caret is placed from a click, scroll so the clicked visual line
		// stays where the reader expects it, preserving the reading anchor.
		function restoreClickedTop(clickedTop: number) {
			const selection = win.getSelection();
			if (!selection?.rangeCount) return;
			const range = selection.getRangeAt(0);
			adjustScroll(range.getBoundingClientRect().top - clickedTop);
		}
		function blockStyle(el: HTMLElement, first: Text | undefined) {
			const parent = first?.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,li,pre,td,th,blockquote");
			return win.getComputedStyle(parent && el.contains(parent) ? parent : el);
		}
		// Open the block as a plaintext editor: measure the rendered line so the
		// caret metrics match, then swap in token spans and take focus.
		function beginEdit(el: HTMLElement, block: ReaderMappedBlock, oneOffFlag: boolean): ReaderLineMap | null {
			const doc = controller.doc;
			if (!doc) return null;
			const map = new api.exact.LineMap(
				doc.source.slice(block.start, block.end),
				api.exact.dominantEnding(doc.source),
			);
			const first = model.textNodes(el).find((n) => n.length > 0),
				style = blockStyle(el, first);
			active = { key: block.key, el, map, shown: map.display, originalStyle: el.getAttribute("style"), type: block.type };
			oneOff = oneOffFlag;
			applyEditorChrome(el, style, measurePadding(el, first));
			controller.activate(block.key);
			el.replaceChildren(buildSpans(owner, tokensFor(model, map.display, block.type, !!options.plainSource)).fragment);
			el.focus({ preventScroll: true });
			return map;
		}
		function placeCaret(
			map: ReaderLineMap,
			block: ReaderMappedBlock,
			at: number | { x: number; y: number },
			clicked: { sourceOffset: number } | null,
			selectionRange: ReaderRange | undefined,
		) {
			select(typeof at === "number" ? at : model.sourceToDisplay(map, clicked ? clicked.sourceOffset : 0));
			if (selectionRange)
				select(
					model.sourceToDisplay(map, selectionRange.start - block.start),
					model.sourceToDisplay(map, selectionRange.end - block.start),
				);
		}
		function offsetAtPoint(el: HTMLElement, at: number | { x: number; y: number }) {
			if (typeof at === "number") return at;
			const range = caretRangeFromPoint(owner, at.x, at.y);
			return range ? model.offset(el, range.startContainer, range.startOffset) : null;
		}
		function reopenActive(key: string, at: number | { x: number; y: number }, selectionRange?: ReaderRange) {
			if (active?.key !== key || controller.lock !== "writing") return false;
			const range = scope();
			if (range && !validSelection(range, selectionRange)) return false;
			if (selectionRange && range) {
				selectSourceRange(active.map, selectionRange.start - range.start, selectionRange.end - range.start);
				return true;
			}
			return selectAtPoint(active.el, at);
		}
		function selectAtPoint(el: HTMLElement, at: number | { x: number; y: number }) {
			const offset = offsetAtPoint(el, at);
			if (offset === null) return false;
			select(offset);
			return true;
		}
		function beginOpen(key: string) {
			if (controller.lock !== "writing" || composing || !controller.doc) return null;
			const el = nodes.get(key),
				block = controller.blocks.find((b) => b.key === key);
			if (!el || !block) return null;
			return { el, block };
		}
		function validSelection(block: ReaderRange, selected?: ReaderRange) {
			return !selected || (selected.start >= block.start && selected.end >= selected.start && selected.end <= block.end);
		}
		function resolveOpen(key: string, at: number | { x: number; y: number }) {
			const ready = beginOpen(key);
			if (!ready) return null;
			if (typeof at === "number") return { ...ready, clicked: null };
			const clicked = resolveClickTarget(ready.el, ready.block, at);
			return clicked ? { ...ready, clicked } : null;
		}
		// Activate the block element: resolve the click target, swap in the editor
		// chrome and token spans, and place the initial caret or selection.
		function startEdit(
			key: string,
			at: number | { x: number; y: number },
			openOptions: { oneOff?: boolean; selection?: ReaderRange },
		) {
			const ready = resolveOpen(key, at);
			if (!ready) return false;
			const { clicked } = ready;
			if (!validSelection(ready.block, openOptions.selection)) return false;
			renderedSelection = null;
			const map = beginEdit(ready.el, ready.block, !!openOptions.oneOff);
			if (!map) return false;
			placeCaret(map, ready.block, at, clicked, openOptions.selection);
			if (clicked) restoreClickedTop(clicked.clickedTop);
			controller.emit("active", scope() ?? null);
			return true;
		}
		function openBlock(
			key: string,
			at: number | { x: number; y: number },
			openOptions: { oneOff?: boolean; selection?: ReaderRange },
		) {
			if (disposed || composing) return false;
			pendingOpen = null;
			if (reopenActive(key, at, openOptions.selection)) {
				oneOff ||= !!openOptions.oneOff;
				return true;
			}
			if (active && !editor.close()) return false;
			return unlockAndOpen(key, at, openOptions);
		}
		function unlockAndOpen(
			key: string,
			at: number | { x: number; y: number },
			openOptions: { oneOff?: boolean; selection?: ReaderRange },
		) {
			const unlock = !!openOptions.oneOff && controller.lock === "reading";
			if (unlock) controller.setLock("writing");
			const opened = startEdit(key, at, openOptions);
			if (!opened && unlock) controller.setLock("reading");
			return opened;
		}
		const editor: ReaderEditor = {
			restyles: 0,
			open(key, at = 0, openOptions = {}) {
				return openBlock(key, at, openOptions);
			},
			close() {
				pendingOpen = null;
				if (!active) return true;
				if (composing) {
					pendingClose = true;
					return false;
				}
				input();
				const a = active;
				active = null;
				a.el.removeAttribute("contenteditable");
				a.el.removeAttribute("data-role");
				a.el.removeAttribute("role");
				a.el.removeAttribute("aria-multiline");
				a.el.removeAttribute("aria-label");
				if (a.originalStyle === null) a.el.removeAttribute("style");
				else a.el.setAttribute("style", a.originalStyle);
				html.delete(a.el);
				controller.activate(null);
				patch();
				controller.requestRender();
				if (oneOff) {
					oneOff = false;
					controller.setLock("reading");
				}
				return true;
			},
			releaseHold() {
				return editor.close();
			},
			dispose() {
				if (disposed) return;
				if (composing) {
					pendingDispose = true;
					return;
				}
				if (active) editor.close();
				disposed = true;
				for (const fn of off) fn();
			},
			selection,
			replaceSelection,
			format(command) {
				return applyFormat(command);
			},
			toggleTask(key, offset = 0) {
				if (controller.lock !== "writing" || composing || !controller.doc) return false;
				const block = controller.blocks.find((b) => b.key === key);
				if (!block) return false;
				const source = controller.doc.source.slice(block.start, block.end),
					matches = [...source.matchAll(/^(?:[ \t]*>[ \t]*)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/gm)];
				const m = matches[offset];
				if (!m) return false;
				const start = block.start + (m.index ?? 0) + m[0].lastIndexOf("[") + 1;
				return (
					controller.change([{ start, end: start + 1, expected: m[1], text: m[1] === " " ? "x" : " " }], {
						blockId: key,
					})?.status === "ok"
				);
			},
			index() {
				return [...root.children].map((node) => {
					const el = node as HTMLElement,
						key = el.dataset.block ?? "",
						b = blockFor(el),
						r = active?.el === el ? scope() : b;
					const text = model
						.textNodes(el)
						.map((n) => n.data)
						.join("");
					return {
						key,
						text,
						start: r?.start ?? 0,
						end: r?.end ?? 0,
						ranges: (a: number, b: number) => {
							const x = model.point(el, a),
								y = model.point(el, b),
								range = owner.createRange();
							range.setStart(x.node, x.offset);
							range.setEnd(y.node, y.offset);
							return [range];
						},
					};
				});
			},
			find(query) {
				if (!query) return [];
				const needle = query.toLocaleLowerCase();
				const results: { key: string; start: number; end: number; ranges: Range[] }[] = [];
				for (const item of editor.index()) {
					const haystack = item.text.toLocaleLowerCase();
					let p = haystack.indexOf(needle);
					while (p >= 0) {
						results.push({ key: item.key, start: p, end: p + query.length, ranges: item.ranges(p, p + query.length) });
						p = haystack.indexOf(needle, p + query.length);
					}
				}
				return results;
			},
			highlight(name, ranges) {
				const w = win as unknown as {
					CSS: { highlights: Map<string, unknown> };
					Highlight: new (...ranges: Range[]) => unknown;
				};
				w.CSS.highlights.set(name, new w.Highlight(...ranges));
			},
		};
		function documentTarget(event: Event) {
			const target = eventElement(event);
			return target?.closest("[data-reader-control]") ? null : target;
		}
		function pointerAnchor(target: Node, x: number, y: number) {
			return active?.el.contains(target) ? sourceAt(x, y) : null;
		}
		function closeOutside(target: Element) {
			if (!active || active.el.contains(target)) return;
			const block = target.closest<HTMLElement>("[data-block]"),
				top = block?.getBoundingClientRect().top;
			if (!editor.close()) return;
			if (block?.isConnected && top !== undefined) adjustScroll(block.getBoundingClientRect().top - top);
		}
		listen(owner, "pointerdown", ((event: PointerEvent) => {
			if (event.defaultPrevented || event.button !== 0) return;
			const target = documentTarget(event);
			if (!target) return;
			pendingOpen = null;
			renderedSelection = null;
			pointer = {
				x: event.clientX,
				y: event.clientY,
				dragged: false,
				anchorSource: pointerAnchor(target, event.clientX, event.clientY),
				crossed: false,
			};
			closeOutside(target);
		}) as EventListener);
		listen(owner, "pointermove", ((event: PointerEvent) => {
			if (event.defaultPrevented || !pointer || !event.buttons || composing) return;
			if (Math.abs(event.clientX - pointer.x) + Math.abs(event.clientY - pointer.y) > 3) pointer.dragged = true;
			if (!pointer.dragged || pointer.anchorSource === null) return;
			if (active?.el.contains(event.target as Node)) return;
			dragSelectionAcrossBlocks(event, pointer.anchorSource);
		}) as EventListener);
		// A drag that leaves the open block closes the editor and keeps the
		// selection alive in rendered coordinates until the pointer is released.
		function dragSelectionAcrossBlocks(event: PointerEvent, anchorSource: number) {
			const focus = sourceAt(event.clientX, event.clientY);
			if (focus === null) return;
			renderedSelection = { anchor: anchorSource, focus };
			if (pointer) pointer.crossed = true;
			editor.close();
			restoreRenderedSelection();
			event.preventDefault();
		}
		listen(owner, "pointerup", () => {
			if (pointer?.crossed) restoreRenderedSelection();
		});
		listen(root, "input", (event) => {
			if (!event.defaultPrevented && !externalInput(event)) input();
		});
		listen(root, "compositionstart", (event) => {
			if (!active || externalInput(event)) return;
			composing = true;
			if (controller.doc) controller.doc.composing = true;
			controller.state();
		});
		function resetDocument() {
			active = null;
			oneOff = false;
			pendingOpen = null;
			renderedSelection = null;
			anchor = null;
			nodes.clear();
			root.replaceChildren();
		}
		listen(root, "compositionend", () => {
			if (!composing) return;
			composing = false;
			if (controller.doc) controller.doc.composing = false;
			if (pendingDocument) {
				pendingDocument = false;
				resetDocument();
			} else input();
			flushComposition();
			controller.state();
		});
		function flushComposition() {
			if (pendingPatch) {
				pendingPatch = false;
				patch();
			}
			if (pendingClose) {
				pendingClose = false;
				editor.close();
			}
			if (pendingDispose) editor.dispose();
		}
		function handleHistoryInput(event: InputEvent) {
			if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
			event.preventDefault();
			if (!composing) controller[event.inputType === "historyUndo" ? "undo" : "redo"]();
			return true;
		}
		function insertBreakText(event: InputEvent) {
			const line = event.inputType === "insertParagraph" || event.inputType === "insertLineBreak";
			const text = event.data ?? event.dataTransfer?.getData("text/plain");
			if (line) {
				event.preventDefault();
				insert("\n");
				return;
			}
			if (typeof text === "string" && /[\r\n]/.test(text)) {
				event.preventDefault();
				insert(text.replace(/\r\n|\r/g, "\n"));
			}
		}
		listen(root, "beforeinput", ((event: InputEvent) => {
			if (event.defaultPrevented || externalInput(event)) return;
			if (handleHistoryInput(event)) return;
			if (composing || event.isComposing || !active) return;
			insertBreakText(event);
		}) as EventListener);
		listen(owner, "selectionchange", () => {
			if (controller.doc) controller.doc.caretPresent = !!caret() && owner.activeElement === active?.el;
			const selected = selection();
			controller.emit("selection", selected);
			controller.state({ hasSelection: !!selected, selection: selected ?? undefined });
		});
		listen(root, "focusout", () => {
			if (controller.doc) controller.doc.caretPresent = false;
			controller.state();
		});
		function handleLinkClick(event: MouseEvent, target: Element) {
			const link = target.closest("a");
			if (!link) return false;
			event.preventDefault();
			if (controller.lock === "reading" || event.metaKey) {
				void host.request("command", { name: "openLink", args: { href: link.getAttribute("href") } });
				return true;
			}
			controller.emit("link", { href: link.getAttribute("href"), element: link });
			return false;
		}
		function toggleClickedCheckbox(event: MouseEvent, el: HTMLElement, target: Element) {
			event.preventDefault();
			const key = el.dataset.block;
			if (!key) return;
			const boxes = [...el.querySelectorAll("input[type=checkbox]")];
			editor.toggleTask(key, boxes.indexOf(target));
		}
		// Checkboxes never activate the editor: in reading mode they are inert, in
		// writing mode a click toggles the task mark in the source.
		function handleCheckboxClick(event: MouseEvent, el: HTMLElement, target: Element) {
			if (!target.matches("input[type=checkbox]")) return false;
			if (controller.lock === "reading") {
				event.preventDefault();
				return true;
			}
			if (controller.lock === "writing") toggleClickedCheckbox(event, el, target);
			return true;
		}
		// A plain click (not a drag, not an existing selection) opens the clicked
		// block, keeping the clicked line and reading anchor intact.
		function openClickedBlock(event: MouseEvent, el: HTMLElement) {
			if (pointer?.dragged || win.getSelection()?.isCollapsed === false || active?.el === el) return;
			const key = el.dataset.block;
			if (key) editor.open(key, { x: event.clientX, y: event.clientY });
		}
		function clickedBlock(event: MouseEvent) {
			if (event.defaultPrevented) return null;
			const target = documentTarget(event);
			const el = target?.closest<HTMLElement>("[data-block]");
			return target && el ? { target, el } : null;
		}
		listen(root, "click", ((event: MouseEvent) => {
			const clicked = clickedBlock(event);
			if (!clicked) return;
			const { target, el } = clicked;
			if (handleLinkClick(event, target)) return;
			if (handleCheckboxClick(event, el, target)) return;
			if (controller.lock !== "writing") return;
			openClickedBlock(event, el);
		}) as EventListener);
		listen(owner, "paste", ((event: ClipboardEvent) => {
			if (event.defaultPrevented || externalInput(event) || controller.lock !== "writing" || composing) return;
			if (active && caret()) {
				event.preventDefault();
				insert((event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n|\r/g, "\n"));
			} else if (selection()) {
				event.preventDefault();
				replaceSelection(event.clipboardData?.getData("text/plain") ?? "");
			}
		}) as EventListener);
		listen(owner, "cut", ((event: ClipboardEvent) => {
			const selected = selection();
			if (event.defaultPrevented || externalInput(event) || !selected || controller.lock !== "writing" || composing) return;
			event.preventDefault();
			event.clipboardData?.setData("text/plain", selected.text);
			replaceSelection("");
		}) as EventListener);
		function handleEscapeKey(event: KeyboardEvent) {
			if (event.key !== "Escape" || !active) return false;
			event.preventDefault();
			editor.close();
			return true;
		}
		function handleHistoryKeys(event: KeyboardEvent) {
			if (!event.metaKey || event.altKey || event.key.toLowerCase() !== "z") return false;
			event.preventDefault();
			controller[event.shiftKey ? "redo" : "undo"]();
			return true;
		}
		function handleFormatKeys(event: KeyboardEvent) {
			if (!event.metaKey || event.altKey || !active) return false;
			const key = event.key.toLowerCase();
			const name = key === "k" ? (event.shiftKey ? "code" : "link") : (FORMAT_KEYS[key] ?? null);
			if (!name) return false;
			event.preventDefault();
			editor.format(name);
			return true;
		}
		function deleteSelectedText(event: KeyboardEvent) {
			const single = event.key.length === 1;
			if (caret() || !selection() || (event.key !== "Backspace" && event.key !== "Delete" && !single)) return false;
			event.preventDefault();
			replaceSelection(single ? event.key : "");
			return true;
		}
		function previousBlock(range: ReaderRange) {
			return controller.blocks.findLast((b) => b.end <= range.start && b.key !== active?.key);
		}
		function reopenPending() {
			const pending = pendingOpen,
				doc = controller.doc;
			if (!pending || !doc || composing) return;
			pendingOpen = null;
			if (doc.generation !== pending.generation) return;
			const block = controller.blocks.find((b) => b.start <= pending.position && b.end >= pending.position);
			if (!block) return;
			const map = new api.exact.LineMap(doc.source.slice(block.start, block.end));
			editor.open(block.key, model.sourceToDisplay(map, pending.position - block.start), { oneOff: pending.oneOff });
		}
		function joinPreviousOnBackspace(event: KeyboardEvent, current: ActiveBlock, range: ReaderRange) {
			if (event.key !== "Backspace") return false;
			const previous = previousBlock(range),
				doc = controller.doc;
			if (!previous || !doc) return false;
			// Only the native ranges define the gap. Never remove an unmapped prefix.
			const expected = doc.source.slice(previous.end, range.start);
			if (!/^[\r\n]+$/.test(expected)) return false;
			event.preventDefault();
			doc.seal();
			const result = controller.change(
				[{ start: previous.end, end: range.start, text: "", expected }],
				{ blockId: current.key },
			);
			if (result.status !== "ok") return true;
			const returnToReading = oneOff;
			editor.close();
			// Reopen only after native returns the merged block's authoritative range.
			pendingOpen = { position: previous.end, generation: doc.generation, oneOff: returnToReading };
			return true;
		}
		function edgeTarget(event: KeyboardEvent, current: ActiveBlock, caretAt: number) {
			const range = scope();
			if (!range) return null;
			if ((event.key === "ArrowLeft" || event.key === "ArrowUp") && caretAt === 0)
				return { block: previousBlock(range), end: true };
			if ((event.key === "ArrowRight" || event.key === "ArrowDown") && caretAt === current.shown.length)
				return { block: controller.blocks.find((b) => b.start >= range.end && b.key !== current.key), end: false };
			return null;
		}
		function navigateEdge(event: KeyboardEvent, current: ActiveBlock, caretAt: number) {
			const target = edgeTarget(event, current, caretAt),
				doc = controller.doc;
			if (!target?.block || !doc) return;
			event.preventDefault();
			const block = target.block,
				at = target.end ? new api.exact.LineMap(doc.source.slice(block.start, block.end)).display.length : 0,
				returnToReading = oneOff;
			if (editor.close()) editor.open(block.key, at, { oneOff: returnToReading });
		}
		function insertEnter(event: KeyboardEvent) {
			if (event.key !== "Enter" || !active || !caret()) return false;
			event.preventDefault();
			insert("\n");
			return true;
		}
		function modifiedKey(event: KeyboardEvent) {
			return event.metaKey || event.ctrlKey || event.altKey;
		}
		function edgeContext(event: KeyboardEvent) {
			const current = active,
				selected = caret(),
				range = scope();
			if (!current || !selected || !range || selected.anchor !== selected.focus || event.shiftKey) return null;
			return { current, selected, range };
		}
		function handleEditingKeys(event: KeyboardEvent) {
			if (controller.lock !== "writing" || modifiedKey(event)) return;
			if (insertEnter(event) || deleteSelectedText(event)) return;
			const context = edgeContext(event);
			if (!context) return;
			const { current, selected, range } = context;
			if (selected.anchor === 0 && joinPreviousOnBackspace(event, current, range)) return;
			navigateEdge(event, current, selected.anchor);
		}
		listen(owner, "keydown", ((event: KeyboardEvent) => {
			// Meta-key shortcuts and Escape are ignored while the event comes from
			// another input surface or has already been handled elsewhere.
			if (event.defaultPrevented || externalInput(event) || composing || event.isComposing) return;
			if (handleEscapeKey(event) || handleHistoryKeys(event) || handleFormatKeys(event)) return;
			handleEditingKeys(event);
		}) as EventListener);
		off.push(
			controller.on("document", () => {
				if (composing) pendingDocument = true;
				else resetDocument();
			}),
			controller.on("blocks", () => {
				patch();
				reopenPending();
			}),
			controller.on("lock", (lock) => {
				if (lock === "reading") editor.close();
			}),
			controller.on("beforeBlocks", holdStart),
			controller.on("beforeChange", holdStart),
			controller.on("change", () => {
				refreshActive();
				holdEnd();
			}),
			controller.on("command", (message) => {
				if (message.name === "format" && typeof message.args?.command === "string")
					editor.format({
						command: message.args.command,
						level: typeof message.args.level === "number" ? message.args.level : undefined,
					});
				else if (message.name === "escape") editor.close();
			}),
		);
		if (controller.doc) patch();
		return editor;
	};
})();
