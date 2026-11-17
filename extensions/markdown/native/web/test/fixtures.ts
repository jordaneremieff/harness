(() => {
	interface FixtureAPI {
		render(source: string, generation?: number): ReaderMappedBlock[];
		document(source?: string): ReaderCoreDocument;
		large(bytes?: number): string;
	}
	const api = (globalThis as unknown as { reader: ReaderCoreAPI & { fixtures: FixtureAPI } }).reader;
	const escapeHTML = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	function blockType(raw: string) {
		const heading = /^(#{1,6}) /.exec(raw);
		if (heading) return `heading${heading[1].length}`;
		return /^- /.test(raw) ? "list" : "paragraph";
	}
	function tokenHTML(text: string, kind: string) {
		const escaped = escapeHTML(text);
		if (kind.includes("bold")) return `<strong>${escaped}</strong>`;
		if (kind.includes("italic")) return `<em>${escaped}</em>`;
		return escaped;
	}
	function appendMap(map: [number, number, number, number][], segment: [number, number, number, number]) {
		const previous = map.at(-1);
		if (
			previous &&
			previous[1] === previous[3] &&
			segment[1] === segment[3] &&
			previous[0] + previous[1] === segment[0] &&
			previous[2] + previous[3] === segment[2]
		) {
			previous[1] += segment[1];
			previous[3] += segment[3];
		} else map.push(segment);
	}
	function body(raw: string, start: number, type: string) {
		const line = new api.exact.LineMap(raw),
			tokens = api.sourceModel.tokens(line.display, type),
			map: [number, number, number, number][] = [];
		let html = "",
			offset = 0,
			rendered = 0;
		for (const token of tokens) {
			if (token.kind !== "mark" && token.kind !== "prefix") {
				html += tokenHTML(token.text, token.kind);
				for (let i = 0; i < token.text.length; i++)
					appendMap(map, [
						rendered + i,
						1,
						start + line.toSource(offset + i),
						line.toSource(offset + i + 1) - line.toSource(offset + i),
					]);
				rendered += token.text.length;
			}
			offset += token.text.length;
		}
		return { html, map };
	}
	function key(raw: string, seen: Map<string, number>) {
		let hash = 2166136261;
		for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
		const base = String(hash >>> 0),
			n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return `${base}-${n}`;
	}
	// Fixture grammar only. The host's cmark parser owns production block boundaries.
	function render(source: string): ReaderMappedBlock[] {
		const result: ReaderMappedBlock[] = [],
			seen = new Map<string, number>();
		const pattern = /[^\r\n]+(?:(?:\r\n|\r|\n)(?![\r\n])[^\r\n]+)*/g;
		for (const match of source.matchAll(pattern)) {
			const raw = match[0],
				start = match.index ?? 0,
				type = blockType(raw),
				content = body(raw, start, type);
			const tag = type.startsWith("heading") ? `h${type.at(-1)}` : "p";
			const html = type === "list" ? `<ul><li>${content.html}</li></ul>` : `<${tag}>${content.html}</${tag}>`;
			result.push({ key: key(raw, seen), start, end: start + raw.length, type, html, map: content.map });
		}
		return result;
	}
	function documentPayload(
		source = "A paragraph with **bold words**, *italic words* and `code`.\r\n\r\n## A heading\r\n\r\n- A list item\r\n\r\nremote",
	): ReaderCoreDocument {
		return {
			source,
			generation: 0,
			meta: {
				documentId: "fixture",
				kind: "published",
				title: "Fixture",
				shortId: "fixture",
				revision: 1,
				revisions: [{ n: 1, createdAt: "2026-01-01", current: true }],
				digest: "fixture",
				provenance: {},
				capturedSource: false,
			},
			blocks: render(source),
			headings: [],
			settings: {
				lock: "reading",
				textSize: 1,
				textSizeSteps: [0.8, 0.9, 1, 1.1, 1.2, 1.4],
				codeWrap: true,
				appearance: "system",
				outlineWidth: 240,
				outlineOpen: true,
			},
			chrome: "pane",
			live: true,
		};
	}
	function large(bytes = 500000) {
		let s =
			"A paragraph with **bold words**, *italic words* and `code`.\r\n\r\n## A heading\r\n\r\n- A list item\r\n\r\n";
		while (s.length < bytes)
			s +=
				"A quiet paragraph with **clear ideas**, *small observations* and exact source. 😀\r\nThe page keeps all untouched bytes.\r\n\r\n";
		return s;
	}
	api.fixtures = { render, document: documentPayload, large };
})();
