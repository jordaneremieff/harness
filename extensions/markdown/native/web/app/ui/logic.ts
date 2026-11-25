(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const commandFor = (table: Record<string, string>, key: string): ReaderUICommand | null =>
		table[key] ? { name: table[key] } : null;
	function keySignature(e: ReaderKey) {
		const modifiers = [e.ctrlKey ? "ctrl" : "", e.altKey ? "alt" : "", e.shiftKey ? "shift" : ""].filter(Boolean);
		return [...modifiers, e.key.toLowerCase()].join(":");
	}
	function editingKey(signature: string, writing: boolean): ReaderUICommand | null {
		if (writing) {
			const format: Record<string, string> = { b: "bold", i: "italic", k: "link", "shift:k": "code" };
			if (format[signature]) return { name: "format", args: { command: format[signature] } };
		}
		return commandFor(
			{ z: "undo", "shift:z": "redo", k: "open", r: "latest", i: "showDetails", a: "selectAll" },
			signature,
		);
	}
	function keyCommand(e: ReaderKey, context: { writing: boolean; input: boolean }): ReaderUICommand | null {
		if (e.isComposing) return null;
		if (e.key === "Escape") return { name: "escape" };
		if (!e.metaKey) return null;
		const signature = keySignature(e),
			command = commandFor(
				{
					f: "find",
					g: "findNext",
					"shift:g": "findPrevious",
					o: "open",
					e: "toggleLock",
					"=": "zoomIn",
					"+": "zoomIn",
					"shift:+": "zoomIn",
					"-": "zoomOut",
					"0": "zoomReset",
					"[": "back",
					"]": "forward",
					"ctrl:s": "toggleOutline",
					"alt:f": "replace",
					d: "askSelection",
					"alt:m": "askDocument",
					"alt:c": "copyPassage",
					"shift:c": "copyMarkdown",
				},
				signature,
			);
		if (command) return command;
		// A text field keeps its own Undo, Redo and Select All; the commands act on the focused field.
		if (context.input) return commandFor({ z: "undo", "shift:z": "redo", a: "selectAll" }, signature);
		return editingKey(signature, context.writing);
	}
	function promptTransition(old: ReaderAskState, next: ReaderAskState): ReaderAskState {
		if (old === "answered" || old === "unanswered") return old;
		if (next === "failed" || next === "unknown" || next === "answered" || next === "unanswered") return next;
		if (old === "failed" || old === "unknown") return next === "sending" ? next : old;
		const order: ReaderAskState[] = ["draft", "sending", "sent", "admitted", "working", "answered"];
		return order.indexOf(next) >= order.indexOf(old) ? next : old;
	}
	const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
	function sharedEdges(a: string[], b: string[]) {
		const limit = Math.min(a.length, b.length);
		let head = 0,
			tail = 0;
		while (head < limit && a[head] === b[head]) head++;
		while (tail < limit - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
		return { head, tail };
	}
	// Each cell counts the longest common subsequence of the two remaining word lists.
	function suffixLengths(a: string[], b: string[], stride: number) {
		const lengths = new Uint16Array((a.length + 1) * stride);
		for (let i = a.length - 1; i >= 0; i--)
			for (let j = b.length - 1; j >= 0; j--) {
				const k = i * stride + j;
				lengths[k] = a[i] === b[j] ? 1 + lengths[k + stride + 1] : Math.max(lengths[k + stride], lengths[k + 1]);
			}
		return lengths;
	}
	// If alignment would stall the reader, show both exact versions without guessing highlights.
	function wordAlignment(a: string[], b: string[]) {
		const stride = b.length + 1;
		if ((a.length + 1) * stride > 160_000) return null;
		const lengths = suffixLengths(a, b, stride),
			pairs: [number, number][] = [];
		let i = 0,
			j = 0;
		while (i < a.length && j < b.length) {
			const k = i * stride + j;
			if (a[i] === b[j]) pairs.push([i++, j++]);
			else if (lengths[k + stride] >= lengths[k + 1]) i++;
			else j++;
		}
		return pairs;
	}
	function diffWords(before: string, after: string): ReaderDiffPart[] | null {
		if (before === after) return [{ kind: "same", text: before }];
		if (!before) return [{ kind: "added", text: after }];
		if (!after) return [{ kind: "removed", text: before }];
		if (Math.max(before.length, after.length) > 32_768) return null;
		const words = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);
		const old = words(before),
			next = words(after),
			{ head, tail } = sharedEdges(old, next);
		const a = old.slice(head, old.length - tail),
			b = next.slice(head, next.length - tail);
		const pairs = wordAlignment(a, b);
		if (!pairs) return null;
		const parts: ReaderDiffPart[] = [];
		const add = (kind: ReaderDiffPart["kind"], text: string) => {
			if (!text) return;
			const last = parts.at(-1);
			if (last?.kind === kind) last.text += text;
			else parts.push({ kind, text });
		};
		add("same", old.slice(0, head).join(""));
		let i = 0,
			j = 0;
		for (const [x, y] of pairs) {
			add("removed", a.slice(i, x).join(""));
			add("added", b.slice(j, y).join(""));
			add("same", a[x]);
			i = x + 1;
			j = y + 1;
		}
		add("removed", a.slice(i).join(""));
		add("added", b.slice(j).join(""));
		add("same", old.slice(old.length - tail).join(""));
		return parts;
	}
	function changeContext(source: string, span: ReaderRange, edit: ReaderRange & { oldText: string; newText: string }) {
		if (edit.start < span.start || edit.end > span.end || source.slice(edit.start, edit.end) !== edit.newText)
			return null;
		return { prefix: source.slice(span.start, edit.start), suffix: source.slice(edit.end, span.end) };
	}
	function zoomStep(current: number, steps: readonly number[], direction: number | null) {
		if (direction === null) return 1;
		const valid = steps.filter((step) => Number.isFinite(step) && step > 0);
		if (direction > 0) return valid.find((step) => step > current) ?? valid.at(-1) ?? 1;
		return valid.findLast((step) => step < current) ?? valid[0] ?? 1;
	}
	// Prefer a side that fits the card. Cover the anchor if neither side has room for the controls.
	// The pane bounds exclude the bar and any space reserved for the batch tray.
	function cardPlacement(
		anchor: { top: number; bottom: number; left: number },
		card: { width: number; height: number; minHeight?: number },
		pane: { width: number; height: number; top: number },
	) {
		const gap = 10,
			margin = 12,
			minHeight = Math.max(120, card.minHeight ?? 0),
			low = pane.top + 6,
			high = pane.height - margin;
		const top = Math.min(Math.max(anchor.top, low), high),
			bottom = Math.max(Math.min(anchor.bottom, high), low);
		const below = high - (bottom + gap),
			above = top - gap - low;
		const left = Math.max(margin, Math.min(anchor.left, pane.width - card.width - margin));
		if (card.height <= below) return { left, top: bottom + gap, maxHeight: below, side: "below" as const };
		if (card.height <= above) return { left, top: top - gap - card.height, maxHeight: above, side: "above" as const };
		if (Math.max(below, above) < minHeight) {
			const height = Math.min(card.height, high - low);
			return { left, top: high - height, maxHeight: high - low, side: "over" as const };
		}
		return below >= above
			? { left, top: bottom + gap, maxHeight: below, side: "below" as const }
			: { left, top: low, maxHeight: above, side: "above" as const };
	}
	// The page's own context menu: the actions that apply where the person clicked, in groups.
	// Items that cannot run here are disabled when they belong to the standard set (Cut, Copy,
	// Paste), and left out otherwise. An empty result means no menu.
	const menuItem = (id: string, label: string, key = "", enabled = true): ReaderMenuEntry => ({
		id,
		label,
		key,
		enabled,
	});
	function inputGroups(t: ReaderMenuTarget) {
		return [
			[
				menuItem("cut", "Cut", "cmd+X", t.inputSelection && t.inputEditable),
				menuItem("copy", "Copy", "cmd+C", t.inputSelection),
				menuItem("paste", "Paste", "cmd+V", t.inputEditable),
			],
			[menuItem("selectAll", "Select All", "cmd+A")],
		];
	}
	function clipboardGroup(t: ReaderMenuTarget) {
		const passage = t.selection ? [menuItem("copyPassage", "Copy with Source", "cmd+option+C")] : [];
		if (t.lock === "reading") return t.selection ? [menuItem("copy", "Copy", "cmd+C"), ...passage] : [];
		return [
			menuItem("cut", "Cut", "cmd+X", t.selection),
			menuItem("copy", "Copy", "cmd+C", t.selection),
			menuItem("paste", "Paste", "cmd+V", t.editor || t.selection),
			...passage,
		];
	}
	function formatGroups(t: ReaderMenuTarget) {
		if (t.lock !== "writing" || !(t.editor || t.selectionInOneBlock)) return [];
		return [
			[
				menuItem("bold", "Bold", "cmd+B"),
				menuItem("italic", "Italic", "cmd+I"),
				menuItem("code", "Code", "cmd+shift+K"),
				menuItem("link", "Link", "cmd+K"),
			],
			[
				t.heading ? menuItem("bodyText", "Body Text") : menuItem("heading", "Heading"),
				menuItem("bulletList", "Bulleted List"),
				menuItem("numberedList", "Numbered List"),
				menuItem("taskList", "Task List"),
				menuItem("quote", "Quote"),
			],
		];
	}
	function linkItems(t: ReaderMenuTarget) {
		if (!t.link) return [];
		if (t.link.internal) return [menuItem("openLink", "Go to Link")];
		return [menuItem("openLink", "Open Link"), menuItem("copyLink", "Copy Link Address")];
	}
	function targetGroup(t: ReaderMenuTarget) {
		const image = t.image
			? [
					menuItem("inspectImage", "Inspect Image"),
					...(t.imageAlt ? [menuItem("copyImageText", "Copy Image Description")] : []),
				]
			: [];
		const rendered = t.editor
			? []
			: [
					...(t.code ? [menuItem("copyCode", "Copy Code")] : []),
					...(t.table ? [menuItem("copyTable", "Copy Table as Markdown")] : []),
				];
		return [...linkItems(t), ...image, ...rendered];
	}
	function documentGroup(t: ReaderMenuTarget) {
		const edit =
			t.block && !t.editor
				? [t.selection ? menuItem("editSelection", "Edit Selection") : menuItem("editHere", "Edit Here")]
				: [];
		return [
			...edit,
			menuItem("find", t.selection ? "Find Selection" : "Find…", "cmd+F"),
			menuItem("toggleLock", t.lock === "writing" ? "Done Editing" : "Edit Document", "cmd+E"),
		];
	}
	function documentGroups(t: ReaderMenuTarget) {
		const ask = t.selection
			? menuItem("ask", "Ask about this", "cmd+D")
			: menuItem("askDocument", "Ask about this document", "cmd+option+M");
		const mark = t.annotation
			? [menuItem("openAnnotation", t.annotation === "comment" ? "Open Comment" : "Open Question")]
			: [];
		return [[...mark, ask], clipboardGroup(t), ...formatGroups(t), targetGroup(t), documentGroup(t)];
	}
	function contextMenuItems(t: ReaderMenuTarget): ReaderMenuEntry[] {
		const groups = t.area === "input" ? inputGroups(t) : t.area === "document" ? documentGroups(t) : [];
		const entries: ReaderMenuEntry[] = [];
		for (const group of groups.filter((g) => g.length)) {
			if (entries.length) entries.push({ id: "", label: "", key: "", enabled: false, separator: true });
			entries.push(...group);
		}
		return entries;
	}
	// Opens the menu at the pointer, flipped left or up where it would leave the pane.
	function menuPlacement(
		point: { x: number; y: number },
		size: { width: number; height: number },
		pane: { width: number; height: number },
	) {
		const margin = 6;
		let left = point.x + 2,
			top = point.y + 2;
		if (left + size.width > pane.width - margin) left = Math.max(margin, point.x - size.width - 2);
		if (top + size.height > pane.height - margin) top = Math.max(margin, point.y - size.height - 2);
		return {
			left: Math.max(margin, Math.min(left, pane.width - size.width - margin)),
			top: Math.max(margin, Math.min(top, pane.height - size.height - margin)),
			maxHeight: pane.height - 2 * margin,
		};
	}
	// The selection strip sits above the selected lines, or below them when the bar leaves no
	// room above; it never covers them. Only a selection taller than the visible page leaves no
	// free side, and then the strip takes the side with more room, inside the page.
	function stripPlacement(
		selection: { top: number; bottom: number; left: number; right: number },
		strip: { width: number; height: number },
		pane: { width: number; height: number; top: number },
	) {
		const gap = 8,
			margin = 8;
		const above = selection.top - gap - strip.height,
			below = selection.bottom + gap;
		const aboveFits = above >= pane.top + margin,
			belowFits = below + strip.height <= pane.height - margin;
		const side =
			aboveFits || (!belowFits && selection.top - pane.top >= pane.height - selection.bottom)
				? ("above" as const)
				: ("below" as const);
		const top = side === "above" ? above : below;
		const centre = (selection.left + selection.right) / 2 - strip.width / 2;
		return {
			left: Math.max(margin, Math.min(centre, pane.width - strip.width - margin)),
			top: Math.max(pane.top + margin, Math.min(top, pane.height - strip.height - margin)),
			side,
		};
	}
	function uniqueStart(source: string, text: string) {
		const start = source.indexOf(text);
		return start >= 0 && source.indexOf(text, start + 1) < 0 ? start : undefined;
	}
	type Section = ReaderRange & { headings: string[] };
	function sections(source: string, view: ReaderPassageView): Section[] {
		if (!view.blocks.length) return [];
		const rows: Section[] = [{ start: 0, end: source.length, headings: [] }];
		const path: { level: number; title: string }[] = [];
		for (const block of view.blocks) {
			const match = /^heading([1-6])$/.exec(block.type);
			if (!match) continue;
			const level = Number(match[1]);
			while (path.length && path[path.length - 1].level >= level) path.pop();
			path.push({ level, title: source.slice(block.start, block.end) });
			rows[rows.length - 1].end = block.start;
			rows.push({ start: block.start, end: source.length, headings: path.map((entry) => entry.title) });
		}
		return rows;
	}
	const contains = (outer: ReaderRange, inner: ReaderRange) => outer.start <= inner.start && inner.end <= outer.end;
	function uniqueSection(rows: Section[], headings: string[]) {
		const matches = rows.filter(
			(row) => row.headings.length === headings.length && headings.every((title, i) => row.headings[i] === title),
		);
		return matches.length === 1 ? matches[0] : undefined;
	}
	// Delimiters and whitespace alone do not distinguish a quote from the same words elsewhere.
	const hasWording = (before: string, after: string) => /[\p{L}\p{N}\p{S}]/u.test(before + after);
	function contextsFor(source: string, range: ReaderRange, section: Section) {
		const within = source.slice(section.start, section.end);
		const before = source
			.slice(Math.max(section.start, range.start - 64), range.start)
			.replace(/^[\uDC00-\uDFFF]/u, "");
		const after = source.slice(range.end, Math.min(section.end, range.end + 64)).replace(/[\uD800-\uDBFF]$/u, "");
		const text = source.slice(range.start, range.end);
		const contexts: ReaderPassageAnchor["contexts"] = [];
		function remember(left: string, right: string) {
			if (!hasWording(left, right) || uniqueStart(within, left + text + right) === undefined) return false;
			if (!contexts.some((c) => c.before === left && c.after === right)) contexts.push({ before: left, after: right });
			return true;
		}
		// Independent witnesses survive edits on opposite sides. If neither side suffices alone,
		// their combination can still distinguish this occurrence from its neighbours.
		const left = before.slice(before.lastIndexOf("\n") + 1),
			right = after.split("\n", 1)[0];
		if (!remember(left, "")) remember(before, "");
		if (!remember("", right)) remember("", after);
		if (contexts.length < 2 && !remember(left, right)) remember(before, after);
		return contexts;
	}
	type Rendering = NonNullable<ReaderPassageAnchor["rendered"]>;
	function mappedRange(block: ReaderMappedBlock, boundaries: (number | null)[], left: number, right: number) {
		const start = boundaries[left],
			end = boundaries[right];
		if (start == null || end == null || start >= end || start < block.start || end > block.end) return undefined;
		// A gap or collapsed boundary cannot prove an exact source interval.
		for (let i = left + 1; i <= right; i++) {
			const current = boundaries[i],
				previous = boundaries[i - 1];
			if (current == null || previous == null || current <= previous) return undefined;
		}
		return { start, end };
	}
	function renderedRange(view: ReaderPassageView, section: Section, rendered: Rendering) {
		const paragraph = rendered.before + rendered.text + rendered.after;
		let result: ReaderRange | undefined;
		const paragraphs = view.blocks.filter((b) => b.type === "paragraph" && contains(section, b));
		for (const block of paragraphs) {
			const map = view.map?.(block);
			if (!map) return undefined;
			if (map.text !== paragraph) continue;
			if (result) return null;
			const left = rendered.before.length;
			const range = mappedRange(block, map.boundaries, left, left + rendered.text.length);
			if (!range) return null;
			result = range;
		}
		return result;
	}
	function captureRendered(range: ReaderRange, quote: string, view: ReaderPassageView, section: Section) {
		const block = view.blocks.find((b) => b.type === "paragraph" && contains(b, range));
		const map = block && view.map?.(block);
		if (!map) return undefined;
		const at = uniqueStart(map.text, quote);
		if (at === undefined || at > 256 || map.text.length - (at + quote.length) > 256) return undefined;
		const rendered = { before: map.text.slice(0, at), text: quote, after: map.text.slice(at + quote.length) };
		const original = renderedRange(view, section, rendered);
		return original?.start === range.start && original.end === range.end ? rendered : undefined;
	}
	function capturePassage(
		source: string,
		range?: ReaderRange,
		view?: ReaderPassageView,
		quote?: string,
	): ReaderPassageAnchor | undefined {
		if (!range) return undefined;
		const { start, end } = range;
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length || start >= end)
			return undefined;
		const text = source.slice(start, end);
		const rows = view ? sections(source, view) : [];
		const section = rows.find((row) => contains(row, range));
		if (!section || !uniqueSection(rows, section.headings) || section.headings.some((h) => h.length > 256))
			return { text, contexts: [] };
		const contexts = contextsFor(source, range, section);
		const rendered = view?.map && quote ? captureRendered(range, quote, view, section) : undefined;
		return { text, headings: section.headings, contexts, ...(rendered ? { rendered } : {}) };
	}
	function competingContext(content: string, anchor: ReaderPassageAnchor, start: number) {
		return anchor.contexts.some(({ before, after }) => {
			if (!hasWording(before, after)) return false;
			const witness = before + anchor.text + after;
			if (start >= before.length && content.startsWith(witness, start - before.length)) return false;
			return content.includes(witness);
		});
	}
	function sourceRange(source: string, anchor: ReaderPassageAnchor, section: Section) {
		const content = source.slice(section.start, section.end);
		let result: ReaderRange | undefined;
		for (const { before, after } of anchor.contexts) {
			if (!hasWording(before, after)) continue;
			const at = uniqueStart(content, before + anchor.text + after);
			if (at === undefined) continue;
			const start = section.start + at + before.length;
			if (result && result.start !== start) return null;
			result = { start, end: start + anchor.text.length };
		}
		if (result && competingContext(content, anchor, result.start - section.start)) return null;
		return result;
	}
	function corroboratedRender(source: string, anchor: ReaderPassageAnchor, view: ReaderPassageView, section: Section) {
		if (!view.map || !anchor.rendered) return undefined;
		const range = renderedRange(view, section, anchor.rendered);
		if (!range || hasWording(anchor.rendered.before, anchor.rendered.after)) return range;
		// A selection of the entire visible paragraph still needs independent surroundings.
		const matches = anchor.contexts.some(
			({ before, after }) =>
				hasWording(before, after) && source.endsWith(before, range.start) && source.startsWith(after, range.end),
		);
		return matches ? range : undefined;
	}
	function agreedRange(raw: ReaderRange | null | undefined, rendered: ReaderRange | null | undefined) {
		if (raw === null || rendered === null) return undefined;
		if (raw && rendered && (raw.start !== rendered.start || raw.end !== rendered.end)) return undefined;
		return raw ?? rendered;
	}
	function reanchorPassage(
		source: string,
		anchor?: ReaderPassageAnchor,
		view?: ReaderPassageView,
		within?: ReaderRange,
	): ReaderRange | undefined {
		if (!view || !anchor?.headings || !anchor.text) return undefined;
		const section = uniqueSection(sections(source, view), anchor.headings);
		if (!section) return undefined;
		const raw = sourceRange(source, anchor, section);
		const rendered = corroboratedRender(source, anchor, view, section);
		const result = agreedRange(raw, rendered);
		return result && (!within || contains(within, result)) ? result : undefined;
	}
	api.uiLogic = {
		stripPlacement,
		contextMenuItems,
		menuPlacement,
		cardPlacement,
		zoomStep,
		changeContext,
		keyCommand,
		promptTransition,
		diffWords,
		findStatus: (count, index) => (count ? `${Math.min(count, Math.max(1, index + 1))} of ${count}` : "No matches"),
		currentHeading: (rows, threshold) => {
			let index = rows.length ? 0 : -1;
			for (let i = 0; i < rows.length; i++) {
				if (rows[i].top > threshold) break;
				index = i;
			}
			return index;
		},
		capturePassage,
		reanchorPassage,
		promptLabel: (state) =>
			({
				draft: "Ask about this passage",
				sending: "Sending",
				sent: "Sent",
				admitted: "Received",
				working: "Working",
				answered: "Answered",
				unanswered: "No separate reply",
				failed: "Not sent",
				unknown: "Delivery not confirmed",
			})[state],
	};
})();
