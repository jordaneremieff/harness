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
		if (old === "answered") return old;
		if (next === "failed" || next === "unknown" || next === "answered") return next;
		if (old === "failed" || old === "unknown") return next === "sending" ? next : old;
		const order: ReaderAskState[] = ["draft", "sending", "sent", "admitted", "working", "answered"];
		return order.indexOf(next) >= order.indexOf(old) ? next : old;
	}
	function diffWords(a: string, b: string) {
		const old = a.match(/\s+|[^\s]+/gu) ?? [],
			next = b.match(/\s+|[^\s]+/gu) ?? [];
		let start = 0,
			end = 0;
		while (start < old.length && start < next.length && old[start] === next[start]) start++;
		while (
			end < old.length - start &&
			end < next.length - start &&
			old[old.length - 1 - end] === next[next.length - 1 - end]
		)
			end++;
		const parts: { kind: "same" | "removed" | "added"; text: string }[] = [];
		const add = (kind: "same" | "removed" | "added", words: string[]) => {
			if (words.length) parts.push({ kind, text: words.join("") });
		};
		add("same", old.slice(0, start));
		add("removed", old.slice(start, old.length - end));
		add("added", next.slice(start, next.length - end));
		add("same", old.slice(old.length - end));
		return parts;
	}
	function changeContext(source: string, span: ReaderRange, edit: ReaderRange & { oldText: string; newText: string }) {
		if (edit.start < span.start || edit.end > span.end || source.slice(edit.start, edit.end) !== edit.newText) return null;
		return {
			oldText: source.slice(span.start, edit.start) + edit.oldText + source.slice(edit.end, span.end),
			newText: source.slice(span.start, span.end),
		};
	}
	function zoomStep(current: number, steps: readonly number[], direction: number | null) {
		if (direction === null) return 1;
		const valid = steps.filter((step) => Number.isFinite(step) && step > 0);
		if (direction > 0) return valid.find((step) => step > current) ?? valid.at(-1) ?? 1;
		return valid.findLast((step) => step < current) ?? valid[0] ?? 1;
	}
	api.uiLogic = {
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
		promptLabel: (state) =>
			({
				draft: "Ask about this passage",
				sending: "Sending",
				sent: "Sent",
				admitted: "Reading",
				working: "Editing",
				answered: "Answered",
				failed: "Not sent",
				unknown: "Delivery not confirmed",
			})[state],
	};
})();
