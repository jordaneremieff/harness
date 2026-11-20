(() => {
	const encoder = new TextEncoder();
	const byteLength = (value: string) => encoder.encode(value).length;
	const limit = 2 * 1024 * 1024;
	const normalise = (text: string) => text.replace(/\r\n?/g, "\n");
	function lineEnding(text: string): ExplorerLineEnding {
		const endings = { lf: 0, crlf: 0, cr: 0 };
		for (const match of text.matchAll(/\r\n|\r|\n/g))
			endings[match[0] === "\r\n" ? "crlf" : match[0] === "\r" ? "cr" : "lf"]++;
		if (endings.crlf > endings.lf && endings.crlf >= endings.cr) return "crlf";
		return endings.cr > endings.lf ? "cr" : "lf";
	}
	function restore(text: string, ending: ExplorerLineEnding) {
		return ending === "lf" ? text : text.replaceAll("\n", ending === "crlf" ? "\r\n" : "\r");
	}
	const indentOf = (line: string) => /^[\t ]*/.exec(line)?.[0] ?? "";
	function spaceIndent(indents: string[]) {
		const steps = new Map<number, number>();
		let previous = 0;
		for (const indent of indents) {
			const width = indent.startsWith("\t") ? 0 : indent.length;
			const delta = width - previous;
			if (delta > 0 && delta <= 8) steps.set(delta, (steps.get(delta) ?? 0) + 1);
			previous = width;
		}
		return [...steps].sort(([a, ac], [b, bc]) => bc - ac || a - b)[0]?.[0] ?? 2;
	}
	function indentUnit(text: string) {
		const indents = text
			.split("\n", 5000)
			.filter((line) => line.trim())
			.map(indentOf);
		const tabs = indents.filter((indent) => indent.startsWith("\t")).length;
		const spaces = indents.filter((indent) => indent.startsWith(" ")).length;
		return tabs > spaces ? "\t" : " ".repeat(spaceIndent(indents));
	}
	function indentPatch(line: string, unit: string, outdent: boolean) {
		if (!outdent) return { text: unit + line, delta: unit.length };
		const removed = line.startsWith("\t")
			? 1
			: Math.min(unit === "\t" ? 4 : unit.length, /^ */.exec(line)?.[0].length ?? 0);
		return { text: line.slice(removed), delta: -removed };
	}
	function offsetDelta(point: number, lineStart: number, delta: number) {
		if (point < lineStart) return 0;
		return delta >= 0 ? delta : Math.max(delta, lineStart - point);
	}
	function indentLines(text: string, start: number, end: number, unit: string, outdent: boolean) {
		const from = start ? text.lastIndexOf("\n", start - 1) + 1 : 0;
		const boundary = text.indexOf("\n", end > start ? end - 1 : end);
		const to = boundary < 0 ? text.length : boundary;
		let offset = 0,
			left = start,
			right = end;
		const value = text
			.slice(from, to)
			.split("\n")
			.map((line) => {
				const position = from + offset;
				offset += line.length + 1;
				const patch = indentPatch(line, unit, outdent);
				left += offsetDelta(start, position, patch.delta);
				right += offsetDelta(end, position, patch.delta);
				return patch.text;
			})
			.join("\n");
		return { from, to, value, start: left, end: right };
	}
	function nextIndent(text: string, offset: number) {
		const start = offset ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
		return indentOf(text.slice(start, offset));
	}
	function validNewPath(path: string) {
		return (
			byteLength(path) <= 4096 &&
			!/[\x00-\x1f]/.test(path) &&
			path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git") &&
			!/[^/]\.(?:png|jpe?g|gif|webp|svg)$/i.test(path)
		);
	}
	const tools: ExplorerEditing = {
		limit,
		byteLength,
		normalise,
		lineEnding,
		restore,
		indentUnit,
		indentLines,
		nextIndent,
		validNewPath,
	};
	window.explorer.editing = tools;
})();
