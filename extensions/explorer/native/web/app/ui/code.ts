(() => {
	const app = window.explorer;
	const { el, button } = app.dom;
	const model = app.model;

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

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function noteRange(note: ExplorerNote): ExplorerRange | null {
			if (!opts || note.path !== opts.path) return null;
			const data = note.side === "base" ? opts.base : opts.head;
			const exact = (start: number, end: number) =>
				data.slice(start - 1, end).join("\n") === note.anchor.quote && start <= data.length;
			if (exact(note.start, note.end) && note.location !== "outdated") return note;
			if (exact(note.anchor.start, note.anchor.end) && (opts.diff || note.location !== "outdated"))
				return { side: note.side, start: note.anchor.start, end: note.anchor.end };
			return null;
		}

		function indexNotes(notes: ExplorerNote[]) {
			notePaint = [];
			gutterNotes.clear();
			for (const note of notes) {
				const spot = noteRange(note);
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

		function textWidth(text: string, columns: number) {
			if (!text.includes("\t")) return Math.ceil(text.length / columns) || 1;
			let col = 0;
			for (const char of text) col += char === "\t" ? 4 - (col % 4) : 1;
			return Math.ceil(col / columns) || 1;
		}

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function layout() {
			if (!opts) return;
			width = body.clientWidth;
			lineHeight = Math.ceil(opts.size * 1.5);
			body.style.setProperty("--code-size", `${opts.size}px`);
			body.style.setProperty("--row-h", `${lineHeight}px`);
			const cellWidth = (opts.split ? (width - 1) / 2 : width) - (opts.split || !opts.diff ? 68 : 112);
			const cols = Math.max(5, Math.floor(cellWidth / (opts.size * 0.61)));
			offsets = [0];
			headIndex.clear();
			baseIndex.clear();
			headFolds.length = 0;
			baseFolds.length = 0;
			let total = 0;
			for (const [index, row] of rows.entries()) {
				let height = lineHeight;
				if (row.type === "line") {
					if (row.base !== undefined) baseIndex.set(row.base, index);
					if (row.head !== undefined) headIndex.set(row.head, index);
					if (opts.wrap) {
						const a =
							row.base !== undefined && (opts.split || row.head === undefined)
								? textWidth(codeText(row.base, "base"), cols)
								: 1;
						const b = row.head !== undefined ? textWidth(codeText(row.head, "head"), cols) : 1;
						height *= Math.max(a, b);
					}
				} else if (row.type === "fold") {
					baseFolds.push({ start: row.base, end: row.base + row.count, row: index });
					headFolds.push({ start: row.head, end: row.head + row.count, row: index });
				}
				total += height;
				offsets.push(total);
			}
			canvas.classList.toggle("wrap", opts.wrap);
			canvas.classList.toggle("split", opts.split);
			canvas.classList.toggle("unified", !!opts.diff && !opts.split);
			canvas.style.setProperty("--columns", String(Math.min(24000, longest)));
		}

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function rebuild() {
			if (!opts) return;
			if (opts.diff) {
				rows = [];
				for (const row of model.project(opts.base, opts.head, opts.diff.hunks, opts.split)) {
					rows.push(row);
					if (row.type === "fold" && folds.has(row.key))
						for (let offset = 0; offset < row.count; offset++)
							rows.push({ type: "line", kind: "context", base: row.base + offset, head: row.head + offset });
				}
			} else rows = opts.head.map((_, index) => ({ type: "line", kind: "context", head: index + 1 }));
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

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function decorated(target: HTMLElement, line: number, side: ExplorerSide, word?: [number, number]) {
			const value = codeText(line, side);
			const file = side === "base" ? (opts?.diff?.oldPath ?? opts?.path) : opts?.path;
			const syntax = syntaxAt(sourceLines(side), model.language(file ?? "").id, line);
			const matches = marked.get(`${side}:${line}`) ?? [];
			if (!syntax.length && !matches.length && !word) {
				target.textContent = value || "\u200b";
				return;
			}
			const styles = [...syntax];
			if (word && word[0] !== word[1]) styles.push({ start: word[0], end: word[1], role: "word" });
			for (const match of matches) styles.push({ ...match, role: match === current ? "find-current" : "find-match" });
			const boundaries = [...new Set([0, value.length, ...styles.flatMap((style) => [style.start, style.end])])].sort(
				(a, b) => a - b,
			);
			let scan = 0;
			for (let index = 1; index < boundaries.length; index++) {
				const from = boundaries[index - 1],
					to = boundaries[index];
				while (scan < syntax.length && syntax[scan].end <= from) scan++;
				const cls = syntax[scan] && syntax[scan].start <= from ? [`syn-${syntax[scan].role}`] : [];
				for (let extra = syntax.length; extra < styles.length; extra++)
					if (styles[extra].start <= from && styles[extra].end >= to) cls.push(styles[extra].role);
				const slice = value.slice(from, to);
				target.append(cls.length ? el("span", cls.join(" "), slice) : document.createTextNode(slice));
			}
		}

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function gutter(line: number | undefined, side: ExplorerSide, signed: string) {
			const cell = el("div", `gutter ${side}`);
			if (!line) return cell;
			cell.dataset.line = String(line);
			cell.dataset.side = side;
			const pick = el("button", "line-number", String(line));
			pick.type = "button";
			pick.tabIndex = -1;
			pick.setAttribute("aria-label", `Select ${side === "base" ? "old " : ""}line ${line}`);
			pick.onclick = (event) => {
				const selected = { side, start: line, end: line };
				if (event.shiftKey && gutterAnchor?.side === side) {
					selected.start = Math.min(gutterAnchor.start, line);
					selected.end = Math.max(gutterAnchor.end, line);
				} else gutterAnchor = selected;
				window.getSelection()?.removeAllRanges();
				highlight(selected);
				opts?.onRange(selected);
			};
			cell.append(pick);
			const notes = gutterNotes.get(`${side}:${line}`);
			if (notes?.length) {
				const mark = button(
					"",
					() => opts?.onNote(notes),
					`note-dot ${notes.some((note) => note.author === "agent") ? "agent" : ""}`,
				);
				mark.setAttribute(
					"aria-label",
					`Open ${notes.length === 1 ? "note" : `${notes.length} notes`} on line ${line}`,
				);
				cell.append(mark);
			}
			if (signed) cell.dataset.sign = signed;
			return cell;
		}

		function cell(line: number | undefined, side: ExplorerSide, signed: string, word?: [number, number]) {
			const part = el("div", "code-cell");
			if (signed) part.classList.add(signed === "+" ? "is-add" : "is-del");
			if (!line) return part;
			part.dataset.line = String(line);
			part.dataset.side = side;
			if (
				notePaint.some(
					(note) => note.side === side && note.state !== "resolved" && note.start <= line && line <= note.end,
				)
			)
				part.classList.add("has-note");
			const sign = el("span", "sign", signed);
			sign.setAttribute("aria-hidden", "true");
			const text = el("code", "source");
			decorated(text, line, side, word);
			part.append(sign, text);
			return part;
		}

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
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
					() => {
						const y = node.getBoundingClientRect().top - body.getBoundingClientRect().top;
						if (expanded) folds.delete(row.key);
						else folds.add(row.key);
						rebuild();
						const newIndex = rows.findIndex((candidate) => candidate.type === "fold" && candidate.key === row.key);
						body.scrollTop = offsets[newIndex] - y;
						paint();
						list.querySelector<HTMLButtonElement>(`[data-row="${newIndex}"] button`)?.focus({ preventScroll: true });
					},
					"fold-button",
				);
				control.setAttribute("aria-expanded", String(expanded));
				if (expanded) node.classList.add("expanded");
				node.append(control);
				return node;
			}
			const baseSign = row.kind === "del" || row.kind === "pair" ? "−" : "";
			const headSign = row.kind === "add" || row.kind === "pair" ? "+" : "";
			if (opts?.split)
				node.append(
					gutter(row.base, "base", baseSign),
					cell(row.base, "base", baseSign, row.word?.base),
					gutter(row.head, "head", headSign),
					cell(row.head, "head", headSign, row.word?.head),
				);
			else {
				if (opts?.diff) node.append(gutter(row.base, "base", baseSign));
				node.append(gutter(row.head, "head", headSign));
				if (row.head !== undefined) node.append(cell(row.head, "head", headSign, row.word?.head));
				else if (row.base !== undefined) node.append(cell(row.base, "base", baseSign, row.word?.base));
			}
			applyRange(node);
			return node;
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

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function paint() {
			if (!opts || !rows.length) return;
			const start = Math.max(0, rowIndex(body.scrollTop) - 36);
			const end = Math.min(rows.length, rowIndex(body.scrollTop + body.clientHeight) + 37);
			const next = new Map<number, HTMLElement>();
			top.style.height = `${offsets[start]}px`;
			bottom.style.height = `${(offsets.at(-1) ?? 0) - offsets[end]}px`;
			for (const [index, node] of shown) if (index < start || index >= end) node.remove();
			let before = list.firstChild;
			for (let index = start; index < end; index++) {
				const node = shown.get(index) ?? paintRow(rows[index], index);
				if (before !== node) list.insertBefore(node, before);
				before = node.nextSibling;
				next.set(index, node);
			}
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
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function place() {
			const index = rowIndex(body.scrollTop);
			for (let row = index; row < rows.length; row++) {
				const candidate = rows[row];
				if (candidate.type === "line" || candidate.type === "fold") {
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
				}
			}
			return { line: 1, side: "head" as const, offset: 0, left: body.scrollLeft };
		}
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
		function indexAt(line: number, side: ExplorerSide, unfold: boolean) {
			const map = side === "head" ? headIndex : baseIndex;
			const found = map.get(line);
			if (found !== undefined || !unfold) return found;
			const fold = (side === "head" ? headFolds : baseFolds).find((fold) => fold.start <= line && line < fold.end);
			if (fold) {
				const row = rows[fold.row];
				if (row.type === "fold") {
					folds.add(row.key);
					rebuild();
					return map.get(line);
				}
			}
			return undefined;
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
			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep virtual row or fold coordinates consistent with the DOM for this render pass.
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
				longest = 0;
				for (const source of [next.base, next.head])
					for (const line of source) {
						const spaces = line.includes("\t") ? line.replaceAll("\t", "    ").length : line.length;
						longest = Math.max(longest, spaces);
					}
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
