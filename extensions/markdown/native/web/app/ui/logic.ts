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
			{ z: "undo", "shift:z": "redo", k: "open", r: "latest", d: "showReview", i: "showDetails", a: "selectAll" },
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
					"alt:m": "askDocument",
					"alt:c": "copyPassage",
					"shift:m": "askSelection",
					"shift:c": "copyMarkdown",
				},
				signature,
			);
		if (command) return command;
		if (context.input) return null;
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
		let head = 0, tail = 0;
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
		const lengths = suffixLengths(a, b, stride), pairs: [number, number][] = [];
		let i = 0, j = 0;
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
		const old = words(before), next = words(after), { head, tail } = sharedEdges(old, next);
		const a = old.slice(head, old.length - tail), b = next.slice(head, next.length - tail);
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
		let i = 0, j = 0;
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
	// Places the ask card beside its anchor inside the pane without covering the anchor: below it
	// when the card fits, otherwise above it, otherwise on the larger side with a capped height.
	// Coordinates are relative to the pane; top is the bottom edge of the bar.
	function cardPlacement(
		anchor: { top: number; bottom: number; left: number },
		card: { width: number; height: number },
		pane: { width: number; height: number; top: number },
	) {
		const gap = 10,
			margin = 12,
			minHeight = 120,
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
				menuItem("cut", "Cut", "⌘X", t.inputSelection && t.inputEditable),
				menuItem("copy", "Copy", "⌘C", t.inputSelection),
				menuItem("paste", "Paste", "⌘V", t.inputEditable),
			],
			[menuItem("selectAll", "Select All", "⌘A")],
		];
	}
	function clipboardGroup(t: ReaderMenuTarget) {
		const passage = t.selection ? [menuItem("copyPassage", "Copy with Source", "⌥⌘C")] : [];
		if (t.lock === "reading") return t.selection ? [menuItem("copy", "Copy", "⌘C"), ...passage] : [];
		return [
			menuItem("cut", "Cut", "⌘X", t.selection),
			menuItem("copy", "Copy", "⌘C", t.selection),
			menuItem("paste", "Paste", "⌘V", t.editor || t.selection),
			...passage,
		];
	}
	function formatGroups(t: ReaderMenuTarget) {
		if (t.lock !== "writing" || !(t.editor || t.selectionInOneBlock)) return [];
		return [
			[
				menuItem("bold", "Bold", "⌘B"),
				menuItem("italic", "Italic", "⌘I"),
				menuItem("code", "Code", "⇧⌘K"),
				menuItem("link", "Link", "⌘K"),
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
			menuItem("find", t.selection ? "Find Selection" : "Find…", "⌘F"),
			menuItem("toggleLock", t.lock === "writing" ? "Done Editing" : "Edit Document", "⌘E"),
		];
	}
	function documentGroups(t: ReaderMenuTarget) {
		const ask = t.selection
			? menuItem("ask", "Ask about this", "⇧⌘M")
			: menuItem("askDocument", "Ask about this document", "⌥⌘M");
		return [[ask], clipboardGroup(t), ...formatGroups(t), targetGroup(t), documentGroup(t)];
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
			aboveFits || (!belowFits && selection.top - pane.top >= pane.height - selection.bottom) ? ("above" as const) : ("below" as const);
		const top = side === "above" ? above : below;
		const centre = (selection.left + selection.right) / 2 - strip.width / 2;
		return {
			left: Math.max(margin, Math.min(centre, pane.width - strip.width - margin)),
			top: Math.max(pane.top + margin, Math.min(top, pane.height - strip.height - margin)),
			side,
		};
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
		reanchorQuote(source, quote, range) {
			if (!quote) return undefined;
			if (range && source.slice(range.start, range.end) === quote) return range;
			const start = source.indexOf(quote);
			return start < 0 || source.indexOf(quote, start + 1) >= 0 ? undefined : { start, end: start + quote.length };
		},
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
