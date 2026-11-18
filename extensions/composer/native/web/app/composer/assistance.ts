(() => {
	type Token = { text: string; kind?: "command" | "shell" | "mention" | "path" };
	interface PathMatch { path: string; start: number; end: number }
	interface Recall { entries: string[]; index: number | null; text: string; base: string; selectionStart: number; selectionEnd: number }
	function completionTrigger(text: string, cursor: number): boolean {
		const head = text.slice(0, cursor);
		return /^\/[^\n]*$/u.test(head) || /(?:^|\s)@[^\s]*$/u.test(head);
	}
	function splitsPair(text: string, offset: number): boolean {
		const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
		return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
	}
	function completionEdit(before: string, result: string, cursor: number) {
		if (!Number.isInteger(cursor) || cursor < 0 || cursor > result.length || splitsPair(result, cursor)) return null;
		let start = 0, end = before.length, stop = result.length;
		while (start < end && start < stop && before[start] === result[start]) start++;
		if (splitsPair(before, start) || splitsPair(result, start)) start--;
		while (end > start && stop > start && before[end - 1] === result[stop - 1]) { end--; stop--; }
		if (splitsPair(before, end) || splitsPair(result, stop)) { end++; stop++; }
		return { start, end, text: result.slice(start, stop), cursor };
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A history step is valid only at the correct line and in an unchanged entry.
	function historyStep({ entries, index, text, base, selectionStart, selectionEnd }: Recall, direction: -1 | 1) {
		if (selectionStart !== selectionEnd || entries.length === 0) return null;
		if (index === null ? text !== "" : text !== entries[index]) return null;
		const candidate = (index ?? entries.length) + direction;
		if (candidate < 0 || candidate > entries.length) return null;
		const line = direction < 0 ? text.slice(0, selectionStart) : text.slice(selectionEnd);
		if (line.includes("\n") || candidate === entries.length && index === null) return null;
		return candidate === entries.length ? { index: null, text: base } : { index: candidate, text: entries[candidate] };
	}
	const image = /\.(?:png|jpe?g|gif|webp)$/iu;
	function pathMatches(text: string): PathMatch[] {
		const result: PathMatch[] = [];
		const matches = text.matchAll(/(?:^|(?<=\s))(?:(\/[^\n]+\.(?:png|jpe?g|gif|webp))(?=$|\n)|('(\/[^'\n]*(?:'\\''[^'\n]*)*)')|(\/[^\s'"<>]+))/gimu);
		for (const match of matches) {
			const path = match[1] ?? match[3]?.replaceAll("'\\''", "'") ?? match[4];
			if (path && path !== "/") result.push({ path, start: match.index, end: match.index + match[0].length });
		}
		return result;
	}
	function imagePaths(text: string): PathMatch[] { return pathMatches(text).filter(({ path }) => image.test(path)); }
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Prioritise the leading invocation over overlapping path spans.
	function syntaxParts(text: string): Token[] {
		const spans = pathMatches(text).map(({ start, end }) => ({ start, end, kind: "path" as NonNullable<Token["kind"]> }));
		const lead = /^(?:![^\s]*|\/[\w-]+(?=\s|$))/u.exec(text)?.[0];
		if (lead) spans.unshift({ start: 0, end: lead.length, kind: lead.startsWith("!") ? "shell" : "command" });
		for (const match of text.matchAll(/(?<!\S)@[^\s]+/gu)) spans.push({ start: match.index, end: match.index + match[0].length, kind: "mention" });
		spans.sort((a, b) => a.start - b.start);
		const parts: Token[] = [];
		let offset = 0;
		for (const { start, end, kind } of spans) {
			if (start < offset) continue;
			if (start > offset) parts.push({ text: text.slice(offset, start) });
			parts.push({ text: text.slice(start, end), kind });
			offset = end;
		}
		if (offset < text.length) parts.push({ text: text.slice(offset) });
		return parts;
	}
	(globalThis as typeof globalThis & { composerAssistance: object }).composerAssistance = {
		completionTrigger, completionEdit, historyStep, imagePaths, syntaxParts,
	};
})();
