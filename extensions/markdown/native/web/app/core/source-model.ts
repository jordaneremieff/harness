(() => {
	const root = globalThis as unknown as { reader: ReaderCoreAPI };
	const api = root.reader ?? ({} as ReaderCoreAPI);
	root.reader = api;
	function walk(node: Node, visit: (node: Node) => boolean | undefined): void {
		if (node instanceof Element && node.matches("[data-reader-control]")) return;
		if (visit(node) === false || node.nodeType === 3) return;
		for (const child of node.childNodes) walk(child, visit);
	}
	function textNodes(root: Node): Text[] {
		const result: Text[] = [];
		walk(root, (node) => {
			if (node.nodeType === 3) result.push(node as Text);
			return undefined;
		});
		return result;
	}
	function textLength(root: Node): number {
		return textNodes(root).reduce((length, node) => length + node.length, 0);
	}
	function localOffset(node: Node, position: number): number | null {
		if (!Number.isSafeInteger(position) || position < 0) return null;
		if (node.nodeType === 3) return position <= (node as Text).length ? position : null;
		if (position > node.childNodes.length) return null;
		return Array.from(node.childNodes)
			.slice(0, position)
			.reduce((length, child) => length + textLength(child), 0);
	}
	function offset(root: Node, target: Node, position: number): number | null {
		let length = 0;
		let result: number | null = null;
		walk(root, (node) => {
			if (result !== null) return false;
			if (node === target) {
				const local = localOffset(node, position);
				if (local !== null) result = length + local;
				return false;
			}
			if (node.nodeType === 3) length += (node as Text).length;
			return undefined;
		});
		return result;
	}
	function point(root: Node, position: number): ReaderTextPoint {
		const nodes = textNodes(root);
		for (const node of nodes) {
			if (position <= node.length) return { node, offset: Math.max(0, position) };
			position -= node.length;
		}
		const last = nodes.at(-1);
		return last ? { node: last, offset: last.length } : { node: root, offset: 0 };
	}
	function validSegment(segment: [number, number, number, number], block: ReaderMappedBlock, length: number) {
		const [r, n, s, m] = segment;
		return (
			segment.every((value) => Number.isSafeInteger(value) && value >= 0) &&
			s >= block.start &&
			s + m <= block.end &&
			r + n <= length
		);
	}
	function segmentBoundary(i: number, n: number, s: number, m: number) {
		if (n === m) return s + i;
		return s + (i * 2 < n ? 0 : m);
	}
	function fillSegment(boundaries: (number | null)[], [r, n, s, m]: [number, number, number, number]) {
		for (let i = 0; i <= n; i++) boundaries[r + i] = segmentBoundary(i, n, s, m);
	}
	function literalBoundaries(block: ReaderMappedBlock, source: string, text: string, boundaries: (number | null)[]) {
		if (block.map || source.slice(block.start, block.end) !== text) return;
		for (let i = 0; i <= text.length; i++) boundaries[i] = block.start + i;
	}
	// Unequal segments represent atomic rendered characters; uncovered boundaries refuse edits.
	function map(block: ReaderMappedBlock, source: string, element: HTMLElement) {
		const text = textNodes(element)
			.map((node) => node.data)
			.join("");
		const boundaries: (number | null)[] = Array(text.length + 1).fill(null);
		for (const segment of block.map ?? []) {
			if (!validSegment(segment, block, text.length)) continue;
			fillSegment(boundaries, segment);
		}
		literalBoundaries(block, source, text, boundaries);
		return { text, boundaries };
	}
	function sourceToDisplay(map: ReaderLineMap, position: number) {
		let lo = 0,
			hi = map.display.length;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (map.toSource(mid) <= position) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}
	type Token = { text: string; kind: string };
	// Styling is cosmetic. Every run retains its exact Markdown characters.
	class Tokenizer {
		text: string;
		kinds: string[];
		constructor(text: string) {
			this.text = text;
			this.kinds = Array<string>(text.length).fill("plain");
		}
		paint(a: number, b: number, kind: string) {
			for (let i = a; i < b; i++) this.kinds[i] = kind;
		}
		escaped(position: number) {
			let count = 0;
			while (position > 0 && this.text[position - 1] === "\\") {
				count++;
				position--;
			}
			return count % 2 === 1;
		}
		close(mark: string, start: number, end: number) {
			let position = this.text.indexOf(mark, start);
			while (position >= 0 && position < end) {
				if (!this.escaped(position)) return position;
				position = this.text.indexOf(mark, position + mark.length);
			}
			return -1;
		}
		balanced(start: number, opening: string, closing: string, end: number) {
			let depth = 1;
			for (let i = start + 1; i < end; i++) {
				if (this.escaped(i)) continue;
				if (this.text[i] === opening) depth++;
				if (this.text[i] !== closing) continue;
				depth--;
				if (depth === 0) return i;
			}
			return -1;
		}
		run(position: number, char: string) {
			let count = 1;
			while (this.text[position + count] === char) count++;
			return count;
		}
		code(position: number, end: number) {
			const width = this.run(position, "`");
			let close = this.text.indexOf("`".repeat(width), position + width);
			while (close >= 0 && close < end) {
				if (this.text[close - 1] !== "`" && this.text[close + width] !== "`") {
					this.paint(position, position + width, "mark");
					this.paint(position + width, close, "code");
					this.paint(close, close + width, "mark");
					return close + width;
				}
				close = this.text.indexOf("`".repeat(width), close + width);
			}
			return position + width;
		}
		linkSuffix(position: number, end: number) {
			const opening = this.text[position];
			if (opening !== "(" && opening !== "[") return position;
			const close = this.balanced(position, opening, opening === "(" ? ")" : "]", end);
			return close >= 0 ? close + 1 : position;
		}
		link(position: number, end: number, depth: number) {
			const bracket = this.text[position] === "!" ? position + 1 : position;
			if (this.text[bracket] !== "[") return position;
			const close = this.balanced(bracket, "[", "]", end);
			if (close < 0) return position;
			const suffix = this.linkSuffix(close + 1, end);
			this.paint(position, bracket + 1, "mark");
			this.inline(bracket + 1, close, "link", depth + 1);
			this.paint(close, suffix, "mark");
			return suffix;
		}
		autolink(position: number, end: number) {
			const close = this.text.indexOf(">", position + 1);
			if (close < 0 || close >= end) return position;
			if (!/^(?:[a-z][a-z\d+.-]*:|[^\s<>]+@)[^\s<>]*$/i.test(this.text.slice(position + 1, close))) return position;
			this.paint(position, position + 1, "mark");
			this.paint(position + 1, close, "link");
			this.paint(close, close + 1, "mark");
			return close + 1;
		}
		emphasisClose(position: number, width: number, end: number) {
			const char = this.text[position],
				previous = this.text[position - 1] ?? " ",
				next = this.text[position + width] ?? " ";
			if (char === "_" && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next)) return -1;
			if (/\s/.test(next)) return -1;
			return this.close(char.repeat(width), position + width, end);
		}
		emphasis(position: number, end: number, style: string, depth: number) {
			const char = this.text[position],
				count = this.run(position, char);
			const width = char === "~" ? 2 : Math.min(count, 3);
			const close = this.emphasisClose(position, width, end);
			if (close <= position + width || /\s/.test(this.text[close - 1])) return position + count;
			const kind = this.emphasisKind(char, width);
			this.paint(position, position + width, "mark");
			this.inline(position + width, close, style === "plain" ? kind : `${style} ${kind}`, depth + 1);
			this.paint(close, close + width, "mark");
			return close + width;
		}
		emphasisKind(char: string, width: number) {
			if (char === "~") return "strike";
			if (width === 3) return "bold italic";
			return width === 2 ? "bold" : "italic";
		}
		next(position: number, end: number, style: string, depth: number): number {
			const char = this.text[position];
			if (
				char === "\\" &&
				position + 1 < end &&
				/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(this.text[position + 1])
			) {
				this.paint(position, position + 1, "mark");
				return position + 2;
			}
			if (char === "`") return this.code(position, end);
			if (char === "[" || char === "!") return this.link(position, end, depth);
			if (char === "<") return this.autolink(position, end);
			if (char === "*" || char === "_" || (char === "~" && this.text[position + 1] === "~"))
				return this.emphasis(position, end, style, depth);
			return position;
		}
		inline(a: number, b: number, style = "plain", depth = 0): void {
			if (depth > 32) return;
			this.paint(a, b, style);
			for (let i = a; i < b; ) i = Math.max(i + 1, this.next(i, b, style, depth));
		}
		result(): Token[] {
			this.inline(0, this.text.length);
			// Each container line has its own gutter prefix. Task marks remain source.
			const prefix = /^(?:[ \t]*(?:>{1}[ \t]?|#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+))+/gm;
			for (const match of this.text.matchAll(prefix)) this.paint(match.index, match.index + match[0].length, "prefix");
			const out: Token[] = [];
			for (let i = 0; i < this.text.length; ) {
				let j = i + 1;
				while (j < this.text.length && this.kinds[j] === this.kinds[i]) j++;
				out.push({ text: this.text.slice(i, j), kind: this.kinds[i] });
				i = j;
			}
			return out.length ? out : [{ text: "", kind: "plain" }];
		}
	}
	function tokens(text: string, type = "paragraph"): Token[] {
		if (type === "code" || type === "html" || type === "table")
			return [{ text, kind: type === "code" ? "code" : "plain" }];
		return new Tokenizer(text).result();
	}
	api.sourceModel = { textNodes, offset, point, map, sourceToDisplay, tokens };
})();
