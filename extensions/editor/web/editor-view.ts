import { lineIndex, lineOffsets, type Splice, spliceBetween } from "./draft.ts";
import { type Language, type Lexer, type LexState, languageFor, lexerFor, sameLexState, type Token } from "./syntax.ts";
import type { DraftBuffer, ThreadHeader } from "./types.ts";

const PAD_TOP = 9;
const PAD_LEFT = 14;
const ROW = 22;
const LEX_BUDGET_MS = 4;
const LEX_CHUNK_COLUMNS = 2048;

interface Options {
	active(): DraftBuffer | undefined;
	anchors(draft: DraftBuffer): ThreadHeader[];
	openThread(id: string): void;
	position(language: string, cursor: string): void;
}

interface KnownTail {
	start: number;
	shift: number;
	states: LexState[];
}

function unchangedTail(offsets: number[], previous: number[], splice: Splice, states: LexState[]): KnownTail | null {
	const nextEnd = splice.start + splice.text.length;
	const delta = nextEnd - splice.end;
	let row = lineIndex(offsets, nextEnd);
	if (offsets[row] < nextEnd) row++;
	while (row < offsets.length) {
		const offset = offsets[row] - delta;
		const prior = lineIndex(previous, offset);
		if (previous[prior] === offset) {
			return prior + 1 < states.length ? { start: row, shift: prior - row, states } : null;
		}
		row++;
	}
	return null;
}

class Highlighting {
	readonly language: Language;
	text: string;
	offsets: number[];
	#lexer: Lexer | null;
	#states: LexState[] = [null];
	#tail: KnownTail | null = null;
	#inProgress: ReturnType<Lexer["scan"]> | undefined;
	#tokens = new Map<number, Token[]>();

	constructor(language: Language, text: string) {
		this.language = language;
		this.#lexer = language === "Plain text" ? null : lexerFor(language);
		this.text = text;
		this.offsets = lineOffsets(text);
	}

	get through(): number {
		return this.#lexer ? this.#states.length - 1 : this.offsets.length;
	}

	update(text: string): void {
		const previous = this.offsets;
		const splice = this.#lexer ? spliceBetween(this.text, text) : null;
		this.text = text;
		this.offsets = lineOffsets(text);
		if (!splice) return;
		const row = lineIndex(previous, splice.start);
		// Retain a suffix only once its incoming lexical state matches again.
		this.#tail = unchangedTail(this.offsets, previous, splice, this.#states);
		this.#states = this.#states.slice(0, row + 1);
		this.#inProgress = undefined;
		this.#tokens.clear();
	}

	line(row: number): string {
		return this.text.slice(
			this.offsets[row],
			row + 1 < this.offsets.length ? this.offsets[row + 1] - 1 : this.text.length,
		);
	}

	#reuseTail(row: number): boolean {
		const tail = this.#tail;
		if (!tail || row < tail.start) return false;
		const oldRow = row + tail.shift;
		if (oldRow + 1 >= tail.states.length) {
			this.#tail = null;
			return false;
		}
		if (!sameLexState(this.#states[row], tail.states[oldRow])) return false;
		this.#states = this.#states.concat(tail.states.slice(oldRow + 1));
		this.#tail = null;
		return true;
	}

	advance(from: number, to: number): void {
		if (!this.#lexer) return;
		const deadline = performance.now() + LEX_BUDGET_MS;
		while (this.through < to) {
			this.#advanceRow(this.through, from);
			if (performance.now() >= deadline) break;
		}
		if (this.#tokens.size <= 300) return;
		for (const row of this.#tokens.keys()) {
			if (row < from || row >= to) this.#tokens.delete(row);
		}
	}

	#advanceRow(row: number, from: number): void {
		if (!this.#lexer || this.#reuseTail(row)) return;
		if (!this.#inProgress) {
			const line = this.line(row);
			// Large physical lines remain readable without creating thousands of spans.
			this.#inProgress = this.#lexer.scan(line, this.#states[row], row >= from && line.length <= LEX_CHUNK_COLUMNS);
		}
		const result = this.#inProgress.advance(LEX_CHUNK_COLUMNS);
		if (!result) return;
		if (result[0].length > 0) this.#tokens.set(row, result[0]);
		this.#states.push(result[1]);
		this.#inProgress = undefined;
	}

	tokens(row: number, line: string): readonly Token[] {
		if (!this.#lexer || row >= this.through || line.length > LEX_CHUNK_COLUMNS) return [];
		const cached = this.#tokens.get(row);
		if (cached) return cached;
		const [tokens] = this.#lexer(line, this.#states[row]);
		this.#tokens.set(row, tokens);
		return tokens;
	}
}

function inkLine(view: Highlighting, row: number): HTMLDivElement {
	const line = view.line(row);
	const drawing = document.createElement("div");
	drawing.className = "paint-line";
	drawing.dataset.row = String(row);
	let offset = 0;
	for (const [start, end, kind] of view.tokens(row, line)) {
		if (start > offset) drawing.append(line.slice(offset, start));
		const span = document.createElement("span");
		span.className = `t-${kind}`;
		span.textContent = line.slice(start, end);
		drawing.append(span);
		offset = end;
	}
	if (offset < line.length) drawing.append(line.slice(offset));
	return drawing;
}

function gutterLine(row: number, thread: string | undefined, openThread: Options["openThread"]): HTMLDivElement {
	const element = document.createElement("div");
	element.className = "paint-line";
	if (!thread) {
		element.textContent = String(row + 1);
		return element;
	}
	element.classList.add("anchored");
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = `${row + 1}•`;
	button.setAttribute("aria-label", `Thread at line ${row + 1}`);
	button.onclick = () => openThread(thread);
	element.append(button);
	return element;
}

class Rows {
	#key = "";
	#elements: HTMLElement[] = [];
	#from = 0;
	#top: number | undefined;
	#left: number | undefined;
	#host: HTMLElement;

	constructor(host: HTMLElement) {
		this.#host = host;
	}

	show(key: string, from: number, to: number, make: (row: number) => HTMLElement): void {
		if (key === this.#key || this.#host.contains(document.activeElement)) return;
		this.#key = key;
		this.#from = from;
		this.#top = this.#left = undefined;
		this.#elements = Array.from({ length: to - from }, (_, index) => make(from + index));
		this.#host.replaceChildren(...this.#elements);
	}

	move(top: number, left?: number): void {
		if (top === this.#top && left === this.#left) return;
		for (let i = 0; i < this.#elements.length; i++) {
			const style = this.#elements[i].style;
			if (top !== this.#top) style.top = `${PAD_TOP + (this.#from + i) * ROW - top}px`;
			if (left !== undefined && left !== this.#left) style.left = `${PAD_LEFT - left}px`;
		}
		this.#top = top;
		this.#left = left;
	}
}

function visibleMarks(view: Highlighting, marks: ThreadHeader[], from: number, to: number): Map<number, string> {
	const byLine = new Map<number, string>();
	const first = view.offsets[from];
	const last = view.offsets[to] ?? view.text.length + 1;
	for (const { id, start } of marks) {
		if (start < first || start >= last) continue;
		const row = lineIndex(view.offsets, start);
		if (!byLine.has(row)) byLine.set(row, id);
	}
	return byLine;
}

function pointOffset(ink: HTMLElement, offsets: number[], x: number, y: number): number | undefined {
	const hit = document.caretPositionFromPoint?.(x, y);
	const fallback = hit ? null : document.caretRangeFromPoint?.(x, y);
	const container = hit?.offsetNode ?? fallback?.startContainer;
	const offset = hit?.offset ?? fallback?.startOffset;
	const host = container instanceof Element ? container : container?.parentElement;
	const drawing = host?.closest<HTMLElement>("[data-row]");
	if (!container || offset === undefined || !drawing || !ink.contains(drawing)) return;
	const range = document.createRange();
	range.setStart(drawing, 0);
	range.setEnd(container, offset);
	return offsets[Number(drawing.dataset.row)] + range.toString().length;
}

export function mountEditor(source: HTMLTextAreaElement, ink: HTMLElement, gutter: HTMLElement, options: Options) {
	const inkRows = new Rows(ink);
	const gutterRows = new Rows(gutter);
	let frame: number | null = null;
	let revision = 0;
	let doc: string | undefined;
	let view: Highlighting | undefined;
	let oldDraft: DraftBuffer | undefined;

	function sync(draft: DraftBuffer): Highlighting {
		if (view && oldDraft === draft && doc === draft.doc && view.text === draft.text) return view;
		const language = languageFor(draft.doc, draft.text);
		if (view && oldDraft === draft && doc === draft.doc && view.language === language) view.update(draft.text);
		else view = new Highlighting(language, draft.text);
		oldDraft = draft;
		doc = draft.doc;
		revision++;
		return view;
	}

	function paint(): void {
		frame = null;
		const draft = options.active();
		if (!draft || source.offsetWidth === 0) {
			options.position("", "");
			return;
		}
		const view = sync(draft);
		const caret = source.selectionEnd;
		const row = lineIndex(view.offsets, caret);
		options.position(view.language, `Ln ${row + 1}, Col ${caret - view.offsets[row] + 1}`);
		const top = source.scrollTop;
		const from = Math.min(view.offsets.length - 1, Math.max(0, Math.floor((top - PAD_TOP) / ROW) - 1));
		const to = Math.min(view.offsets.length, from + Math.ceil(source.clientHeight / ROW) + 4);
		view.advance(from, to);
		const marks = visibleMarks(view, options.anchors(draft), from, to);
		const range = `${revision}:${from}:${to}`;
		const coloured = Math.max(from, Math.min(view.through, to));
		inkRows.show(`${range}:${coloured}`, from, to, (at) => inkLine(view, at));
		inkRows.move(top, source.scrollLeft);
		gutterRows.show(`${range}:${JSON.stringify([...marks])}`, from, to, (at) =>
			gutterLine(at, marks.get(at), options.openThread),
		);
		gutterRows.move(top);
		if (view.through < to) request();
	}

	function request(): void {
		if (frame === null) frame = requestAnimationFrame(paint);
	}

	function setRange(start: number, end = start, focus = true): void {
		const draft = options.active();
		if (!draft) return;
		const view = sync(draft);
		source.setSelectionRange(start, end);
		const y = PAD_TOP + lineIndex(view.offsets, start) * ROW;
		if (y < source.scrollTop || y + ROW > source.scrollTop + source.clientHeight)
			source.scrollTop = Math.max(0, y - source.clientHeight / 3);
		if (focus) source.focus({ preventScroll: true });
		request();
	}

	function jump(line: number): void {
		const draft = options.active();
		if (!draft) return;
		const { offsets } = sync(draft);
		setRange(offsets[Math.min(offsets.length - 1, Math.max(0, line - 1))]);
	}

	function point(x: number, y: number): number {
		const draft = options.active();
		if (!draft) return 0;
		const view = sync(draft);
		if (frame !== null) cancelAnimationFrame(frame);
		paint();
		ink.style.pointerEvents = "auto";
		source.style.pointerEvents = "none";
		try {
			const exact = pointOffset(ink, view.offsets, x, y);
			if (exact !== undefined) return exact;
		} finally {
			ink.style.pointerEvents = "";
			source.style.pointerEvents = "";
		}
		const box = source.getBoundingClientRect();
		const row = Math.max(
			0,
			Math.min(view.offsets.length - 1, Math.floor((y - box.top + source.scrollTop - PAD_TOP) / ROW)),
		);
		return view.offsets[row] + (x <= box.left + PAD_LEFT - source.scrollLeft ? 0 : view.line(row).length);
	}

	new ResizeObserver(request).observe(source);
	return {
		request,
		jump,
		setRange,
		point,
		offsets: () => {
			const draft = options.active();
			return draft ? sync(draft).offsets : (view?.offsets ?? [0]);
		},
	};
}
