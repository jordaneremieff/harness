(() => {
	// Code locations and Git revisions that card text names in prose or inline code.
	const pathToken = String.raw`[\w@+-][\w.@+-]*(?:/[\w.@+-]+)*`;
	const lineSuffix = String.raw`(?::(?<colonStart>\d+)(?:\s?[-–]\s?(?<colonEnd>\d+))?|#L(?<hashStart>\d+)(?:-L?(?<hashEnd>\d+))?)`;
	const pattern = new RegExp(
		[
			String.raw`(?<range>\b[0-9a-f]{7,64}\.\.[0-9a-f]{7,64}\b)`,
			`(?<located>${pathToken}${lineSuffix})`,
			String.raw`(?<file>${pathToken}/[\w@+-][\w@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}\b)`,
			String.raw`(?<lines>\b[Ll]ines?\s+(?<wordStart>\d+)(?:\s*(?:[-–]|to)\s*(?<wordEnd>\d+))?\b)`,
			String.raw`(?<short>\bL(?<shortStart>\d+)(?:\s?[-–]\s?L?(?<shortEnd>\d+))?\b)`,
			String.raw`(?<commit>\b[0-9a-f]{7,64}\b)`,
		].join("|"),
		"gu",
	);

	function count(value: string | undefined) {
		if (value === undefined) return undefined;
		const number = Number(value);
		return Number.isSafeInteger(number) && number >= 1 ? number : null;
	}

	// A line span, or null when the numbers are not ordered positive integers.
	function span(first: string | undefined, last: string | undefined) {
		const start = count(first),
			end = count(last) ?? start;
		if (!start || !end || end < start) return null;
		return { start, end };
	}

	// A path is relative, inside the root and outside Git metadata.
	function relative(path: string) {
		const parts = path.split("/");
		return parts.every((part) => part && part !== "." && part !== "..") && !parts.includes(".git");
	}

	// A path must carry a file extension or a folder to count as one.
	function plausiblePath(path: string) {
		return relative(path) && (path.includes("/") || /\.[A-Za-z][A-Za-z0-9]{0,9}$/u.test(path));
	}

	// Hexadecimal words count as commits only when they mix digits and letters.
	function commitLike(value: string) {
		return /\d/u.test(value) && /[a-f]/u.test(value);
	}

	function located(groups: Record<string, string | undefined>): ExplorerReference | null {
		const text = groups.located ?? "";
		const path = text.replace(/(?::\d+(?:\s?[-–]\s?\d+)?|#L\d+(?:-L?\d+)?)$/u, "");
		if (!plausiblePath(path)) return null;
		const lines = span(groups.colonStart ?? groups.hashStart, groups.colonEnd ?? groups.hashEnd);
		return lines ? { kind: "lines", path, ...lines } : null;
	}

	function range(text: string): ExplorerReference | null {
		const [base, head] = text.split("..");
		return commitLike(base) && commitLike(head) ? { kind: "range", base, head } : null;
	}

	// Line spans of the current file, written in prose or as L12-L20.
	function currentLines(groups: Record<string, string | undefined>): ExplorerReference | null {
		const lines = groups.lines ? span(groups.wordStart, groups.wordEnd) : span(groups.shortStart, groups.shortEnd);
		return lines && { kind: "lines", ...lines };
	}

	function file(path: string): ExplorerReference | null {
		return plausiblePath(path) ? { kind: "file", path } : null;
	}

	function commit(value: string): ExplorerReference | null {
		return commitLike(value) ? { kind: "commit", commit: value } : null;
	}

	function reference(match: RegExpMatchArray): ExplorerReference | null {
		const groups = match.groups ?? {};
		if (groups.range) return range(groups.range);
		if (groups.located) return located(groups);
		if (groups.file) return file(groups.file);
		if (groups.lines || groups.short) return currentLines(groups);
		return groups.commit ? commit(groups.commit) : null;
	}

	// Finds non-overlapping references in order of appearance.
	function find(text: string): ExplorerReferenceSpan[] {
		const found: ExplorerReferenceSpan[] = [];
		for (const match of text.matchAll(pattern)) {
			const ref = reference(match);
			if (!ref) continue;
			const start = match.index ?? 0;
			// A match that continues a URL, path or word is part of something else.
			if (start > 0 && /[\w/.:#@-]/u.test(text[start - 1])) continue;
			found.push({ start, end: start + match[0].length, ref });
		}
		return found;
	}

	// Short label for a line span.
	function lineLabel(start: number, end: number) {
		return start === end ? `L${start}` : `L${start}–${end}`;
	}

	window.explorer.references = { find, lineLabel };
})();
