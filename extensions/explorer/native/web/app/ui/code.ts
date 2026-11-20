(() => {
	const app = window.explorer;
	const { el, button } = app.dom;
	const model = app.model;

	// A note anchors where its quote still matches the shown text.
	function quoteAt(data: string[], start: number, end: number, quote: string) {
		return data.slice(start - 1, end).join("\n") === quote && start <= data.length;
	}

	function noteSpot(note: ExplorerNote, opts: ExplorerCodeOptions): ExplorerRange | null {
		if (note.path !== opts.path) return null;
		const data = note.side === "base" ? opts.base : opts.head;
		if (quoteAt(data, note.start, note.end, note.anchor.quote) && note.location !== "outdated")
			return { side: note.side, start: note.start, end: note.end };
		if (!opts.diff && note.location === "outdated") return null;
		return quoteAt(data, note.anchor.start, note.anchor.end, note.anchor.quote)
			? { side: note.side, start: note.anchor.start, end: note.anchor.end }
			: null;
	}

	// The widest line, with tabs counted at four columns.
	function longestOf(sources: string[][]) {
		let longest = 0;
		for (const source of sources)
			for (const line of source) {
				const spaces = line.includes("\t") ? line.replaceAll("\t", "    ").length : line.length;
				longest = Math.max(longest, spaces);
			}
		return longest;
	}

	function wrappedHeight(text: string, columns: number) {
		if (!text.includes("\t")) return Math.ceil(text.length / columns) || 1;
		let col = 0;
		for (const char of text) col += char === "\t" ? 4 - (col % 4) : 1;
		return Math.ceil(col / columns) || 1;
	}

	function wrappedCount(
		row: ExplorerCodeRow & { type: "line" },
		lines: (line: number, side: ExplorerSide) => string,
		split: boolean,
		cols: number,
	) {
		let height = 1;
		if (row.base !== undefined && (split || row.head === undefined))
			height = wrappedHeight(lines(row.base, "base"), cols);
		if (row.head !== undefined) height = Math.max(height, wrappedHeight(lines(row.head, "head"), cols));
		return height;
	}

	function cellWidth(width: number, opts: { split: boolean; diff: unknown }) {
		const half = opts.split ? (width - 1) / 2 : width;
		const gutter = opts.split || !opts.diff ? 68 : 112;
		return half - gutter;
	}

	// Expands the folded context rows that the view has unfolded.
	function diffRows(base: string[], head: string[], diff: ExplorerDiff, split: boolean, folds: Set<string>) {
		const rows: ExplorerCodeRow[] = [];
		for (const row of model.project(base, head, diff.hunks, split)) {
			rows.push(row);
			if (row.type === "fold" && folds.has(row.key))
				for (let offset = 0; offset < row.count; offset++)
					rows.push({ type: "line", kind: "context", base: row.base + offset, head: row.head + offset });
		}
		return rows;
	}

	function fileFor(side: ExplorerSide, opts: ExplorerCodeOptions | null) {
		if (side !== "base") return opts?.path;
		return opts?.diff?.oldPath ?? opts?.path;
	}

	function plainRow(syntax: ExplorerSpan[], matches: ExplorerMatch[], word: [number, number] | undefined) {
		return !syntax.length && !matches.length && !word;
	}

	function spanStyles(
		syntax: ExplorerSpan[],
		word: [number, number] | undefined,
		matches: ExplorerMatch[],
		current: ExplorerMatch | undefined,
	) {
		const styles = [...syntax];
		if (word && word[0] !== word[1]) styles.push({ start: word[0], end: word[1], role: "word" });
		for (const match of matches) styles.push({ ...match, role: match === current ? "find-current" : "find-match" });
		return styles;
	}

	function styleBoundaries(value: string, styles: ExplorerSpan[]) {
		return [...new Set([0, value.length, ...styles.flatMap((style) => [style.start, style.end])])].sort(
			(a, b) => a - b,
		);
	}

	// The syntax span that covers a segment start, then every overlay that spans it.
	function sliceClasses(syntax: ExplorerSpan[], scan: number, styles: ExplorerSpan[], from: number, to: number) {
		const active = syntax[scan];
		const cls = active && active.start <= from ? [`syn-${active.role}`] : [];
		for (let extra = syntax.length; extra < styles.length; extra++)
			if (styles[extra].start <= from && styles[extra].end >= to) cls.push(styles[extra].role);
		return cls;
	}

	app.code = function code(body) {
		let opts: ExplorerCodeOptions | null = null;
		let rows: ExplorerCodeRow[] = [];
		const folds = new Set<string>();
		let offsets = [0];
		const headIndex = new Map<number, number>(),
			baseIndex = new Map<number, number>();
		const headFolds: { start: number; end: number; row: number }[] = [],
			baseFolds: typeof headFolds = [];
		const gutterNotes = new Map<string, ExplorerNote[]>();
		const marked = new Map<string, ExplorerMatch[]>();
		let current: ExplorerMatch | undefined;
		let range: ExplorerRange | null = null;
		let gutterAnchor: ExplorerRange | null = null;
		let shown = new Map<number, HTMLElement>();
		let lineHeight = 24;
		let frame = 0;
		let width = 0;
		let longest = 0;
		let notePaint: ExplorerNote[] = [];
		let indexed: ExplorerNote[] = [];
		const syntaxBySource = new WeakMap<string[], { language: string; at: (line: number) => ExplorerSpan[] }>();
		function syntaxAt(source: string[], language: string, line: number) {
			let index = syntaxBySource.get(source);
			if (!index || index.language !== language) {
				index = { language, at: app.syntaxFile(source, language) };
				syntaxBySource.set(source, index);
			}
			return index.at(line - 1);
		}
		const top = el("div", "virtual-space");
		const bottom = el("div", "virtual-space");
		const list = el("div", "code-rows");
		const canvas = el("div", "code-canvas");
		canvas.append(top, list, bottom);

		function indexNotes(notes: ExplorerNote[]) {
			indexed = notes;
			notePaint = [];
			gutterNotes.clear();
			for (const note of notes) {
				const spot = opts ? noteSpot(note, opts) : null;
				if (!spot) continue;
				notePaint.push({ ...note, ...spot });
				const key = `${spot.side}:${spot.start}`;
				const entries = gutterNotes.get(key) ?? [];
				entries.push(note);
				gutterNotes.set(key, entries);
			}
		}

		function sourceLines(side: ExplorerSide) {
			return side === "base" ? (opts?.base ?? []) : (opts?.head ?? []);
		}
		function codeText(line: number, side: ExplorerSide) {
			return sourceLines(side)[line - 1] ?? "";
		}

		// Measures one row and records its line numbers and fold span.
		function measureRow(row: ExplorerCodeRow, index: number, cols: number) {
			if (row.type === "fold") {
				baseFolds.push({ start: row.base, end: row.base + row.count, row: index });
				headFolds.push({ start: row.head, end: row.head + row.count, row: index });
				return lineHeight;
			}
			if (row.type === "hunk") return lineHeight;
			return rowHeight(row, index, cols);
		}

		// Measures one line row and records its line numbers.
		function rowHeight(row: ExplorerCodeRow & { type: "line" }, index: number, cols: number) {
			if (row.base !== undefined) baseIndex.set(row.base, index);
			if (row.head !== undefined) headIndex.set(row.head, index);
			if (!opts?.wrap) return lineHeight;
			return lineHeight * wrappedCount(row, codeText, !!opts.split, cols);
		}

		function layout() {
			if (!opts) return;
			width = body.clientWidth;
			lineHeight = Math.ceil(opts.size * 1.5);
			body.style.setProperty("--code-size", `${opts.size}px`);
			body.style.setProperty("--row-h", `${lineHeight}px`);
			const cols = Math.max(5, Math.floor(cellWidth(width, opts) / (opts.size * 0.61)));
			offsets = [0];
			headIndex.clear();
			baseIndex.clear();
			headFolds.length = 0;
			baseFolds.length = 0;
			let total = 0;
			for (const [index, row] of rows.entries()) {
				total += measureRow(row, index, cols);
				offsets.push(total);
			}
			canvas.classList.toggle("wrap", opts.wrap);
			canvas.classList.toggle("split", opts.split);
			canvas.classList.toggle("unified", !!opts.diff && !opts.split);
			canvas.style.setProperty("--columns", String(Math.min(24000, longest)));
		}

		function rebuild() {
			if (!opts) return;
			rows = opts.diff
				? diffRows(opts.base, opts.head, opts.diff, opts.split, folds)
				: opts.head.map((_, index) => ({ type: "line", kind: "context", head: index + 1 }));
			layout();
			invalidate();
		}

		function rowIndex(y: number) {
			let lo = 0,
				hi = rows.length;
			while (lo < hi) {
				const mid = (lo + hi + 1) >>> 1;
				if (offsets[mid] <= y) lo = mid;
				else hi = mid - 1;
			}
			return Math.min(lo, Math.max(0, rows.length - 1));
		}

		function decorated(target: HTMLElement, line: number, side: ExplorerSide, word?: [number, number]) {
			const value = codeText(line, side);
			const syntax = syntaxAt(sourceLines(side), model.language(fileFor(side, opts) ?? "").id, line);
			const matches = marked.get(`${side}:${line}`) ?? [];
			if (plainRow(syntax, matches, word)) {
				target.textContent = value || "\u200b";
				return;
			}
			const styles = spanStyles(syntax, word, matches, current);
			appendStyledSegments(target, value, syntax, styles);
		}

		function appendStyledSegments(target: HTMLElement, value: string, syntax: ExplorerSpan[], styles: ExplorerSpan[]) {
			const boundaries = styleBoundaries(value, styles);
			let scan = 0;
			for (let index = 1; index < boundaries.length; index++) {
				const from = boundaries[index - 1],
					to = boundaries[index];
				while (scan < syntax.length && syntax[scan].end <= from) scan++;
				const cls = sliceClasses(syntax, scan, styles, from, to);
				const slice = value.slice(from, to);
				target.append(cls.length ? el("span", cls.join(" "), slice) : document.createTextNode(slice));
			}
		}

		// Extends a shift-click from the anchored gutter number to this one.
		function pickLines(event: MouseEvent, line: number, side: ExplorerSide) {
			const selected = { side, start: line, end: line };
			if (event.shiftKey && gutterAnchor?.side === side) {
				selected.start = Math.min(gutterAnchor.start, line);
				selected.end = Math.max(gutterAnchor.end, line);
			} else gutterAnchor = selected;
			window.getSelection()?.removeAllRanges();
			highlight(selected);
			opts?.onRange(selected);
		}

		// Adds the note marker for a gutter line that carries notes.
		function appendNoteDot(cell: HTMLElement, line: number, side: ExplorerSide) {
			const notes = gutterNotes.get(`${side}:${line}`);
			if (!notes?.length) return;
			const kind = notes.some((note) => note.state === "draft")
				? "draft"
				: notes.some((note) => note.author === "agent")
					? "agent"
					: "";
			const mark = button("", () => opts?.onNote(notes), `note-dot ${kind}`);
			mark.setAttribute("aria-label", `Open ${notes.length === 1 ? "note" : `${notes.length} notes`} on line ${line}`);
			cell.append(mark);
		}

		function gutter(line: number | undefined, side: ExplorerSide, signed: string) {
			const cell = el("div", `gutter ${side}`);
			if (!line) return cell;
			cell.dataset.line = String(line);
			cell.dataset.side = side;
			const pick = el("button", "line-number", String(line));
			pick.type = "button";
			pick.tabIndex = -1;
			pick.setAttribute("aria-label", `Select ${side === "base" ? "old " : ""}line ${line}`);
			pick.onclick = (event) => pickLines(event, line, side);
			cell.append(pick);
			appendNoteDot(cell, line, side);
			if (signed) cell.dataset.sign = signed;
			return cell;
		}

		function cell(line: number | undefined, side: ExplorerSide, signed: string, word?: [number, number]) {
			const part = el("div", "code-cell");
			if (signed) part.classList.add(signed === "+" ? "is-add" : "is-del");
			if (!line) return part;
			part.dataset.line = String(line);
			part.dataset.side = side;
			part.classList.add(...noteClasses(side, line));
			const sign = el("span", "sign", signed);
			sign.setAttribute("aria-hidden", "true");
			const text = el("code", "source");
			decorated(text, line, side, word);
			part.append(sign, text);
			return part;
		}

		// Folds and expands one run of unchanged lines under its own control.
		function toggleFold(row: ExplorerCodeRow & { type: "fold" }, node: HTMLElement, expanded: boolean) {
			const y = node.getBoundingClientRect().top - body.getBoundingClientRect().top;
			if (expanded) folds.delete(row.key);
			else folds.add(row.key);
			rebuild();
			const newIndex = rows.findIndex((candidate) => candidate.type === "fold" && candidate.key === row.key);
			body.scrollTop = offsets[newIndex] - y;
			paint();
			list.querySelector<HTMLButtonElement>(`[data-row="${newIndex}"] button`)?.focus({ preventScroll: true });
		}

		function paintRow(row: ExplorerCodeRow, index: number) {
			const node = el("div", `source-row ${row.type}`);
			node.dataset.row = String(index);
			node.style.height = `${offsets[index + 1] - offsets[index]}px`;
			if (row.type === "hunk") {
				node.append(el("span", "hunk-label", row.label));
				return node;
			}
			if (row.type === "fold") {
				const expanded = folds.has(row.key);
				const control = button(
					`${expanded ? "Hide" : "Show"} ${row.count.toLocaleString()} unchanged lines`,
					() => toggleFold(row, node, expanded),
					"fold-button",
				);
				control.setAttribute("aria-expanded", String(expanded));
				if (expanded) node.classList.add("expanded");
				node.append(control);
				return node;
			}
			appendLineCells(node, row);
			applyRange(node);
			return node;
		}

		// The sign shown beside each side of a changed line pair.
		function rowSigns(row: ExplorerCodeRow & { type: "line" }) {
			const base = row.kind === "del" || row.kind === "pair" ? "−" : "";
			const head = row.kind === "add" || row.kind === "pair" ? "+" : "";
			return { base, head };
		}

		function appendLineCells(node: HTMLElement, row: ExplorerCodeRow & { type: "line" }) {
			const signs = rowSigns(row);
			if (opts?.split) {
				node.append(
					gutter(row.base, "base", signs.base),
					cell(row.base, "base", signs.base, row.word?.base),
					gutter(row.head, "head", signs.head),
					cell(row.head, "head", signs.head, row.word?.head),
				);
				return;
			}
			unifiedCells(node, row, signs);
		}

		function unifiedCells(
			node: HTMLElement,
			row: ExplorerCodeRow & { type: "line" },
			signs: { base: string; head: string },
		) {
			if (opts?.diff) node.append(gutter(row.base, "base", signs.base));
			node.append(gutter(row.head, "head", signs.head));
			const side: ExplorerSide = row.head !== undefined ? "head" : "base";
			const line = row[side];
			if (line === undefined) return;
			node.append(cell(line, side, signs[side], row.word?.[side]));
		}

		function applyRange(node: HTMLElement) {
			for (const cell of node.querySelectorAll<HTMLElement>("[data-line]")) {
				const line = Number(cell.dataset.line);
				cell.classList.toggle(
					"range-picked",
					!!range && range.side === cell.dataset.side && range.start <= line && range.end >= line,
				);
			}
		}

		function pruneShown(start: number, end: number) {
			for (const [index, node] of shown) if (index < start || index >= end) node.remove();
		}

		function mountRange(start: number, end: number, next: Map<number, HTMLElement>) {
			let before = list.firstChild;
			for (let index = start; index < end; index++) {
				const node = shown.get(index) ?? paintRow(rows[index], index);
				if (before !== node) list.insertBefore(node, before);
				before = node.nextSibling;
				next.set(index, node);
			}
		}

		function paint() {
			if (!opts || !rows.length) return;
			const start = Math.max(0, rowIndex(body.scrollTop) - 36);
			const end = Math.min(rows.length, rowIndex(body.scrollTop + body.clientHeight) + 37);
			const next = new Map<number, HTMLElement>();
			top.style.height = `${offsets[start]}px`;
			bottom.style.height = `${(offsets.at(-1) ?? 0) - offsets[end]}px`;
			pruneShown(start, end);
			mountRange(start, end, next);
			shown = next;
		}

		function invalidate() {
			shown.clear();
			list.replaceChildren();
			paint();
		}
		function schedule() {
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					paint();
				});
		}
		function highlight(next: ExplorerRange | null) {
			range = next;
			for (const node of shown.values()) applyRange(node);
		}
		// The first visible row with a line number, kept with its scroll offsets.
		function spotAt(candidate: ExplorerCodeRow & { type: "line" | "fold" }, row: number) {
			if (candidate.head)
				return {
					line: candidate.head,
					side: "head" as const,
					offset: body.scrollTop - offsets[row],
					left: body.scrollLeft,
				};
			if (candidate.base)
				return {
					line: candidate.base,
					side: "base" as const,
					offset: body.scrollTop - offsets[row],
					left: body.scrollLeft,
				};
			return undefined;
		}

		function place() {
			const index = rowIndex(body.scrollTop);
			for (let row = index; row < rows.length; row++) {
				const candidate = rows[row];
				if (candidate.type !== "line" && candidate.type !== "fold") continue;
				const spot = spotAt(candidate, row);
				if (spot) return spot;
			}
			return { line: 1, side: "head" as const, offset: 0, left: body.scrollLeft };
		}

		function foldFor(line: number, side: ExplorerSide) {
			return (side === "head" ? headFolds : baseFolds).find((fold) => fold.start <= line && line < fold.end);
		}

		function indexAt(line: number, side: ExplorerSide, unfold: boolean) {
			const map = side === "head" ? headIndex : baseIndex;
			const found = map.get(line);
			if (found !== undefined || !unfold) return found;
			const fold = foldFor(line, side);
			if (!fold) return undefined;
			const row = rows[fold.row];
			if (row.type !== "fold") return undefined;
			folds.add(row.key);
			rebuild();
			return map.get(line);
		}
		function restore(saved: ReturnType<typeof place>) {
			const index = indexAt(saved.line, saved.side, true);
			body.scrollTop = index === undefined ? 0 : Math.max(0, offsets[index] + saved.offset);
			body.scrollLeft = saved.left;
			paint();
		}
		function jump(line: number, side: ExplorerSide = "head", nearTop = false) {
			const index = indexAt(Math.max(1, Math.min(sourceLines(side).length, line)), side, true);
			if (index === undefined) return;
			body.scrollTop = offsets[index] - (nearTop ? lineHeight * 4 : body.clientHeight * 0.26);
			paint();
			opts?.onScroll(line);
		}
		function rowAt(node: Node | null): ExplorerRange | null {
			const cell = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(
				"[data-line][data-side]",
			);
			const line = Number(cell?.dataset.line);
			const side = cell?.dataset.side;
			return line && (side === "base" || side === "head") ? { side, start: line, end: line } : null;
		}
		function anchor(region: ExplorerRange | null) {
			if (!region) return null;
			const a = indexAt(region.start, region.side, false),
				b = indexAt(region.end, region.side, false);
			if (a === undefined && b === undefined) return null;
			const box = body.getBoundingClientRect();
			const start = box.top + offsets[a ?? b ?? 0] - body.scrollTop;
			const end = box.top + offsets[(b ?? a ?? 0) + 1] - body.scrollTop;
			if (end < box.top || start > box.bottom) return null;
			const y = Math.max(start, box.top);
			return new DOMRect(box.left, y, box.width, Math.min(end, box.bottom) - y);
		}
		function selection() {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
			const dom = selection.getRangeAt(0);
			const first = rowAt(dom.startContainer),
				last = rowAt(dom.endContainer);
			if (!first || !last || first.side !== last.side) return null;
			const selected = {
				side: first.side,
				start: Math.min(first.start, last.start),
				end: Math.max(first.end, last.end),
			};
			return { range: selected, text: selection.toString(), rect: dom.getBoundingClientRect() };
		}
		// Unresolved notes painted over one line, in their stored order.
		function notesAt(side: ExplorerSide, line: number) {
			return notePaint.filter(
				(note) => note.side === side && note.state !== "resolved" && note.start <= line && line <= note.end,
			);
		}
		// Review comments, then agent notes, choose the tint of a marked line.
		function noteClasses(side: ExplorerSide, line: number) {
			const covering = notesAt(side, line);
			if (!covering.length) return [];
			if (covering.some((note) => note.state === "draft")) return ["has-note", "has-draft"];
			return covering.every((note) => note.author === "agent") ? ["has-note", "has-agent"] : ["has-note"];
		}
		function plainClick(event: MouseEvent) {
			return (
				event.button === 0 && event.detail <= 1 && !(event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
			);
		}
		function markedCell(event: MouseEvent) {
			if (!plainClick(event) || !window.getSelection()?.isCollapsed) return null;
			return event.target instanceof Element ? event.target.closest<HTMLElement>(".code-cell.has-note") : null;
		}
		// A plain click on a marked line opens its notes; a drag or a double-click keeps selecting text.
		function openMarked(event: MouseEvent) {
			const part = markedCell(event);
			if (!part?.dataset.line || !opts) return;
			const found = notesAt(part.dataset.side === "base" ? "base" : "head", Number(part.dataset.line));
			const ids = new Set(found.map((note) => note.id));
			const notes = indexed.filter((note) => ids.has(note.id));
			if (notes.length) opts.onNote(notes);
		}
		canvas.addEventListener("click", openMarked);
		body.addEventListener(
			"scroll",
			() => {
				schedule();
				if (opts) opts.onScroll(place().line);
			},
			{ passive: true },
		);
		new ResizeObserver(() => {
			if (!opts || width === body.clientWidth) {
				schedule();
				return;
			}
			const saved = place();
			layout();
			invalidate();
			restore(saved);
		}).observe(body);

		return {
			show(next) {
				const same = opts?.path === next.path && opts.diff?.path === next.diff?.path;
				if (!same) {
					folds.clear();
					range = null;
					gutterAnchor = null;
					marked.clear();
					current = undefined;
				}
				opts = next;
				longest = longestOf([next.base, next.head]);
				indexNotes(next.notes);
				if (!body.contains(canvas)) body.replaceChildren(canvas);
				rebuild();
			},
			clear() {
				opts = null;
				rows = [];
				offsets = [0];
				range = null;
				folds.clear();
				shown.clear();
				list.replaceChildren();
				body.replaceChildren();
			},
			jump,
			place,
			restore,
			highlight,
			anchor,
			rowAt,
			selection,
			marks(matches, next) {
				marked.clear();
				current = next;
				for (const match of matches) {
					const key = `${match.side}:${match.line}`;
					const list = marked.get(key) ?? [];
					list.push(match);
					marked.set(key, list);
				}
				invalidate();
			},
			updateNotes(notes) {
				if (opts) {
					indexNotes(notes);
					invalidate();
				}
			},
		};
	};
})();
