import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { actionLabel } from "./controls.ts";
import { TextArea, TextField } from "./field.ts";
import { HitMap, type HitRegion } from "./hits.ts";
import { fitLine, plainLine, wrap } from "./text.ts";
import type { Action, KeyHint, Notice, OperatorView, ViewHost } from "./view.ts";

export interface Choice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export type FieldSpec =
	| { readonly kind: "text"; readonly id: string; readonly label: string; readonly value?: string; readonly placeholder?: string; readonly hint?: string }
	| { readonly kind: "area"; readonly id: string; readonly label: string; readonly value?: string; readonly rows?: number; readonly hint?: string }
	| {
			readonly kind: "choice";
			readonly id: string;
			readonly label: string;
			readonly value?: string;
			/** Fixed choices, or choices that follow other staged values (for example levels of the staged model). */
			readonly choices: readonly Choice[] | ((values: Readonly<Record<string, string>>) => readonly Choice[]);
			/** A visible filter field narrows long lists as you type. */
			readonly filter?: boolean;
			readonly rows?: number;
			readonly hint?: string;
	  }
	| {
			readonly kind: "info";
			readonly id: string;
			readonly label: string;
			/** Fixed text, or text that follows the staged values, such as the exact instant a deadline names. */
			readonly value: string | ((values: Readonly<Record<string, string>>) => string);
	  };

export interface FormResult {
	/** Leave the form after success. */
	readonly close?: boolean;
	readonly notice?: Notice;
}

export interface FormOptions {
	readonly title: string;
	/** First line, naming the effect and its target. */
	readonly heading: string;
	/** What Apply does and what it never does. */
	readonly intro?: string;
	readonly fields: readonly FieldSpec[];
	/** The labelled submit action, named for its effect: "Apply", "Pick up", "Approve". */
	readonly action: { readonly label: string; readonly tone?: "accent" | "danger" };
	readonly cancelLabel?: string;
	readonly host: Pick<ViewHost, "theme" | "signal" | "requestRender" | "notify" | "back">;
	/** Validate staged values before submission; a message keeps the form open. */
	validate?(values: Readonly<Record<string, string>>): string | undefined;
	/** The single owner call. A rejection keeps every staged field and shows the reason. */
	submit(values: Readonly<Record<string, string>>, signal: AbortSignal): Promise<FormResult | undefined>;
	/** Every staged change, for owners that retain drafts across openings. */
	change?(values: Readonly<Record<string, string>>): void;
	/** Cancel sends nothing; owners may clear retained drafts here. */
	cancel?(): void;
}

const LABEL_COLUMNS = 14;

interface ChoiceState {
	readonly spec: Extract<FieldSpec, { kind: "choice" }>;
	value: string;
	highlight: number;
	readonly filter?: TextField;
	top: number;
	/** True after a wheel turn: the list keeps its scroll until the keyboard or a filter moves it. */
	manual: boolean;
}

type FieldState =
	| { readonly kind: "text"; readonly spec: Extract<FieldSpec, { kind: "text" }>; readonly field: TextField }
	| { readonly kind: "area"; readonly spec: Extract<FieldSpec, { kind: "area" }>; readonly field: TextArea }
	| { readonly kind: "choice"; readonly spec: Extract<FieldSpec, { kind: "choice" }>; readonly state: ChoiceState }
	| { readonly kind: "info"; readonly spec: Extract<FieldSpec, { kind: "info" }> };

/** One field's rows for this render: the lines, where its caret or highlight sits, and its pointer targets. */
interface FieldLayout {
	readonly lines: string[];
	readonly caret?: number;
	readonly hits: readonly HitRegion[];
}

/** One field's rows inside the body: where it starts, and its own layout. */
interface LaidField {
	readonly start: number;
	readonly layout: FieldLayout;
}

function choicesOf(state: ChoiceState, values: Readonly<Record<string, string>>): readonly Choice[] {
	return typeof state.spec.choices === "function" ? state.spec.choices(values) : state.spec.choices;
}

function filtered(state: ChoiceState, values: Readonly<Record<string, string>>): readonly Choice[] {
	const all = choicesOf(state, values);
	const query = state.filter?.value.trim().toLocaleLowerCase() ?? "";
	if (!query) return all;
	const terms = query.split(/\s+/);
	return all.filter((choice) => {
		const text = `${choice.value} ${choice.label} ${choice.description ?? ""}`.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}

/**
 * A staged form: every field laid out in one body that scrolls to keep the focused field's caret
 * or highlighted choice visible; the heading stays at the top and the hint, pending and error
 * rows at the bottom. Enter moves to the next field and submits from the last one (a multi-line
 * field takes the newline keys for line breaks); Tab moves between fields. Cancel and Escape run
 * the same cancel and send nothing.
 */
export class Form implements OperatorView {
	readonly title: string;
	focused = false;
	private readonly options: FormOptions;
	private readonly fields: FieldState[];
	private index = 0;
	private error?: string;
	private pending = false;
	private readonly hits = new HitMap();
	/** Top row of the field body's window; the wheel moves it, focus and typing recentre it. */
	private top = 0;
	private manual = false;

	constructor(options: FormOptions) {
		this.options = options;
		this.title = options.title;
		const changed = () => this.changed();
		this.fields = options.fields.map((spec): FieldState => {
			if (spec.kind === "text") return { kind: "text", spec, field: new TextField(spec.label, spec.value ?? "", changed) };
			if (spec.kind === "area")
				return { kind: "area", spec, field: new TextArea(spec.label, options.host.theme, () => options.host.requestRender(), spec.value ?? "", spec.rows ?? 4, changed) };
			if (spec.kind === "choice") {
				const state: ChoiceState = {
					spec,
					value: spec.value ?? "",
					highlight: 0,
					top: 0,
					manual: false,
					...(spec.filter ? { filter: new TextField("Filter", "", () => this.refilter(state)) } : {}),
				};
				return { kind: "choice", spec, state };
			}
			return { kind: "info", spec };
		});
		this.reconcileChoices();
		this.index = Math.max(0, this.fields.findIndex((field) => field.kind !== "info"));
	}

	/** A choice whose list no longer contains its staged value takes the first available choice. */
	private reconcileChoices(): void {
		for (const field of this.fields) {
			if (field.kind !== "choice") continue;
			const state = field.state;
			const list = choicesOf(state, this.values());
			const index = list.findIndex((choice) => choice.value === state.value);
			if (index < 0) state.value = list[0]?.value ?? "";
			const shown = filtered(state, this.values());
			state.highlight = Math.max(0, shown.findIndex((choice) => choice.value === state.value));
		}
	}

	get busy(): boolean {
		return this.pending;
	}

	values(): Record<string, string> {
		const values: Record<string, string> = {};
		for (const field of this.fields) {
			if (field.kind === "text" || field.kind === "area") values[field.spec.id] = field.field.value;
			else if (field.kind === "choice") values[field.spec.id] = field.state.value;
			else if (typeof field.spec.value === "string") values[field.spec.id] = field.spec.value;
		}
		return values;
	}

	/** Show an owner refusal or validation problem; the staged fields stay. */
	setError(text: string | undefined): void {
		this.error = text;
	}

	private changed(): void {
		this.error = undefined;
		this.reconcileChoices();
		this.options.change?.(this.values());
	}

	private refilter(state: ChoiceState): void {
		const list = filtered(state, this.values());
		const current = list.findIndex((choice) => choice.value === state.value);
		state.highlight = current >= 0 ? current : 0;
		const first = list[state.highlight];
		if (first) state.value = first.value;
		state.top = 0;
		state.manual = false;
		this.changed();
	}

	private focusable(index: number): boolean {
		return this.fields[index]?.kind !== "info";
	}

	private applyFocus(): void {
		this.fields.forEach((field, index) => {
			const active = this.focused && index === this.index;
			if (field.kind === "text" || field.kind === "area") field.field.focused = active;
			if (field.kind === "choice" && field.state.filter) field.state.filter.focused = active;
		});
	}

	/** Focus moved: the window and every choice list reveal their highlight again. */
	private revealFocus(): void {
		this.manual = false;
		for (const field of this.fields) if (field.kind === "choice") field.state.manual = false;
	}

	focusNext(backward: boolean): boolean {
		let next = this.index;
		do next += backward ? -1 : 1;
		while (next >= 0 && next < this.fields.length && !this.focusable(next));
		if (next < 0 || next >= this.fields.length) return false;
		this.index = next;
		this.revealFocus();
		return true;
	}

	focusEdge(backward: boolean): void {
		const order = this.fields.map((_, index) => index).filter((index) => this.focusable(index));
		this.index = (backward ? order.at(-1) : order[0]) ?? 0;
		this.revealFocus();
	}

	/** True when Enter submits now: on the last field, or in a form without fields. */
	private atLast(): boolean {
		for (let next = this.index + 1; next < this.fields.length; next++) if (this.focusable(next)) return false;
		return true;
	}

	/**
	 * Submit carries Enter while Enter submits; before the last field it stays reachable in More,
	 * and the footer shows Enter as "next". Cancel carries Escape.
	 */
	actions(): readonly Action[] {
		return [
			{
				id: "submit",
				label: this.pending ? `${this.options.action.label}…` : this.options.action.label,
				...(this.atLast() ? { key: "enter" } : {}),
				primary: true,
				tone: this.options.action.tone ?? "accent",
				disabled: this.pending ? "The request is still running" : undefined,
				run: () => void this.submit(),
			},
			{ id: "cancel", label: this.options.cancelLabel ?? "Cancel", key: "escape", primary: true, run: () => this.cancel() },
		];
	}

	/** True while a text field or a choice filter has focus, so letters are text. */
	editing(): boolean {
		const field = this.fields[this.index];
		if (!field) return false;
		return field.kind === "text" || field.kind === "area" || (field.kind === "choice" && field.state.filter !== undefined);
	}

	/**
	 * The focused field's keys for the footer. Enter shows as "next" until the last field; there,
	 * while a text field has focus and the frame shows no action keys, it shows the submit label.
	 */
	keys(): readonly KeyHint[] {
		const field = this.fields[this.index];
		const hints: KeyHint[] = [];
		if (field?.kind === "choice") hints.push({ keys: ["up", "down"], label: "choose" });
		if (!this.atLast()) hints.push({ keys: ["enter"], label: "next" });
		else if (this.editing()) hints.push({ keys: ["enter"], label: actionLabel(this.options.action) });
		if (field?.kind === "area") {
			const newline = getKeybindings().getKeys("tui.input.newLine");
			if (newline.length) hints.push({ keys: newline, label: "newline" });
		}
		if (this.fields.filter((_, index) => this.focusable(index)).length > 1) hints.push({ keys: ["tab"], label: "field" });
		return hints;
	}

	cancel(): void {
		this.options.cancel?.();
		this.options.host.back();
	}

	escape(): boolean {
		return false;
	}

	async submit(): Promise<void> {
		if (this.pending) return;
		const values = this.values();
		const problem = this.options.validate?.(values);
		if (problem) {
			this.error = problem;
			this.options.host.requestRender();
			return;
		}
		this.pending = true;
		this.error = undefined;
		this.options.host.requestRender();
		try {
			const result = await this.options.submit(values, this.options.host.signal);
			if (this.options.host.signal.aborted) return;
			if (result?.notice) this.options.host.notify(result.notice.text, result.notice.kind);
			if (result?.close) this.options.host.back();
		} catch (error) {
			if (this.options.host.signal.aborted) return;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.pending = false;
			if (!this.options.host.signal.aborted) this.options.host.requestRender();
		}
	}

	handleInput(data: string): boolean {
		const field = this.fields[this.index];
		// A form without fields leaves Enter to the frame, which runs Submit by its key.
		if (!field || field.kind === "info") return false;
		if (this.pending) return true;
		this.manual = false;
		// The newline keys come first: a legacy terminal sends Ctrl+J as the same byte as Enter.
		if (field.kind === "area" && getKeybindings().matches(data, "tui.input.newLine")) return field.field.handleInput(data);
		if (matchesKey(data, "enter")) return this.advance();
		if (field.kind === "choice") return this.choiceInput(field.state, data);
		return field.field.handleInput(data);
	}

	/** Enter moves to the next field; on the last field it submits, the same call as the Submit control. */
	private advance(): boolean {
		if (this.atLast()) void this.submit();
		else this.focusNext(false);
		return true;
	}

	private choiceInput(state: ChoiceState, data: string): boolean {
		const list = filtered(state, this.values());
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			state.manual = false;
			state.highlight = Math.max(0, Math.min(list.length - 1, state.highlight + (matchesKey(data, "up") ? -1 : 1)));
			const choice = list[state.highlight];
			if (choice) {
				state.value = choice.value;
				this.changed();
			}
			return true;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			if (state.filter) return state.filter.handleInput(data);
			return this.choiceInput(state, matchesKey(data, "left") ? "\u001b[A" : "\u001b[B");
		}
		if (state.filter) return state.filter.handleInput(data);
		return false;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.hits.handle(event);
	}

	private layoutChoice(field: Extract<FieldState, { kind: "choice" }>, index: number, width: number, theme: Theme): FieldLayout {
		const state = field.state;
		const active = this.focused && index === this.index;
		const labelColumns = Math.min(LABEL_COLUMNS, Math.max(6, Math.floor(width / 4)));
		const label = fitLine(theme.fg(active ? "accent" : "muted", plainLine(field.spec.label)), labelColumns);
		const current = choicesOf(state, this.values()).find((choice) => choice.value === state.value);
		const lines: string[] = [];
		const hits: HitRegion[] = [];
		lines.push(label + fitLine(theme.bold(plainLine(current?.label ?? state.value ?? "")), Math.max(1, width - labelColumns)));
		hits.push({ x: 0, y: 0, width, height: 1, click: () => this.focusField(index) });
		if (!active) return { lines, hits };
		if (state.filter) {
			lines.push(" ".repeat(labelColumns) + state.filter.render(Math.max(1, width - labelColumns), theme, 8, "type to narrow"));
			hits.push({ x: labelColumns, y: 1, width: width - labelColumns, height: 1, click: (event) => state.filter?.handleMouse(event, 8) });
		}
		const list = filtered(state, this.values());
		const rows = Math.max(1, Math.min(field.spec.rows ?? 6, list.length || 1));
		state.top = Math.max(0, Math.min(Math.max(0, list.length - rows), state.top));
		// A wheel turn keeps the window; the keyboard, a click or a filter change reveals the highlight.
		if (!state.manual) {
			if (state.highlight < state.top) state.top = state.highlight;
			if (state.highlight >= state.top + rows) state.top = state.highlight - rows + 1;
		}
		const listY = lines.length;
		if (!list.length) lines.push(" ".repeat(labelColumns) + theme.fg("dim", "No match"));
		list.slice(state.top, state.top + rows).forEach((choice, offset) => {
			const at = state.top + offset;
			const chosen = choice.value === state.value;
			const text = `${chosen ? theme.fg("accent", "●") : theme.fg("dim", "○")} ${plainLine(choice.label)}${choice.description ? theme.fg("muted", `  ${plainLine(choice.description)}`) : ""}`;
			const line = " ".repeat(labelColumns) + fitLine(text, Math.max(1, width - labelColumns));
			lines.push(at === state.highlight ? theme.bg("selectedBg", line) : line);
			hits.push({
				x: labelColumns,
				y: listY + offset,
				width: width - labelColumns,
				height: 1,
				click: () => {
					state.manual = false;
					state.highlight = at;
					state.value = choice.value;
					this.changed();
					return { handled: true, focus: true };
				},
			});
		});
		hits.push({
			x: labelColumns,
			y: listY,
			width: width - labelColumns,
			height: rows,
			wheel: (delta) => {
				state.manual = true;
				state.top = Math.max(0, Math.min(Math.max(0, list.length - rows), state.top + delta));
			},
		});
		return { lines, hits, ...(state.highlight >= state.top && state.highlight < state.top + rows ? { caret: listY + state.highlight - state.top } : {}) };
	}

	private focusField(index: number): TuiMouseEventResult {
		this.index = index;
		this.revealFocus();
		return { handled: true, focus: true };
	}

	private layoutField(field: FieldState, index: number, width: number, theme: Theme): FieldLayout {
		const labelColumns = Math.min(LABEL_COLUMNS, Math.max(6, Math.floor(width / 4)));
		if (field.kind === "info") {
			const label = fitLine(theme.fg("muted", plainLine(field.spec.label)), labelColumns);
			const value = typeof field.spec.value === "function" ? field.spec.value(this.values()) : field.spec.value;
			return {
				lines: wrap(plainLine(value), Math.max(1, width - labelColumns)).map(
					(line, row) => (row === 0 ? label : " ".repeat(labelColumns)) + fitLine(line, Math.max(1, width - labelColumns)),
				),
				hits: [],
			};
		}
		if (field.kind === "choice") return this.layoutChoice(field, index, width, theme);
		if (field.kind === "text") {
			const line = field.field.render(width, theme, labelColumns, field.spec.placeholder ?? "");
			return {
				lines: [line],
				hits: [{ x: 0, y: 0, width, height: 1, click: (event) => ({ ...field.field.handleMouse(event, labelColumns), ...this.focusField(index) }) }],
				...(this.focused && index === this.index ? { caret: field.field.caretRow } : {}),
			};
		}
		const lines = field.field.render(width, theme);
		return {
			lines,
			hits: [
				{
					x: 0,
					y: 0,
					width,
					height: lines.length,
					click: (event) => {
						this.focusField(index);
						if (event.y > 0) field.field.handleMouse({ ...event, x: Math.max(0, event.x - 1), y: event.y - 1, width: Math.max(1, width - 2), height: lines.length - 1 });
						return { handled: true, focus: true };
					},
				},
			],
			...(field.field.caretRow !== undefined ? { caret: field.field.caretRow } : {}),
		};
	}

	private hint(field: FieldState | undefined): string | undefined {
		if (!field || field.kind === "info") return undefined;
		return field.spec.hint;
	}

	/**
	 * The heading on the first row, a window of the field body under it, and the hint, pending and
	 * error rows at the bottom. The window keeps the focused field's caret or highlighted choice
	 * visible and shows as much of that field as fits; the wheel moves it and the next focus change
	 * or key press reveals the caret again. Pointer targets are registered only for visible rows.
	 */
	render(width: number, height: number): string[] {
		const theme = this.options.host.theme;
		this.hits.begin(width, height);
		this.applyFocus();
		this.addBodyWheel(width, height);
		const { body, laid } = this.layoutBody(width, theme);
		const shown = this.visibleStatus(this.statusRows(width, theme), height, width, theme);
		const windowRows = Math.max(1, height - 1 - shown.length);
		this.scrollTo(windowRows, body.length, laid[this.index]);
		const rows = [fitLine(theme.bold(plainLine(this.options.heading)), width)];
		for (let row = 0; row < windowRows; row++) rows.push(fitLine(body[this.top + row] ?? "", width));
		this.registerHits(laid, windowRows);
		return [...rows, ...shown].slice(0, Math.max(1, height));
	}

	/** The body's wheel moves the whole field window; a choice list claims the wheel over its rows. */
	private addBodyWheel(width: number, height: number): void {
		this.hits.add({
			x: 0,
			y: 0,
			width,
			height: Math.max(1, height),
			wheel: (delta) => {
				this.manual = true;
				this.top += delta;
			},
		});
	}

	/** Every field row in one body, with the row each field starts on and its pointer targets. */
	private layoutBody(width: number, theme: Theme): { body: string[]; laid: LaidField[] } {
		const body: string[] = [];
		if (this.options.intro) for (const line of wrap(plainLine(this.options.intro), width)) body.push(fitLine(theme.fg("muted", line), width));
		body.push("");
		const laid = this.fields.map((field, index) => {
			const start = body.length;
			const layout = this.layoutField(field, index, width, theme);
			for (const line of layout.lines) body.push(fitLine(line, width));
			return { start, layout };
		});
		return { body, laid };
	}

	/** The hint, pending and error rows, which stay at the bottom of the body. */
	private statusRows(width: number, theme: Theme): string[] {
		const status: string[] = [];
		const hint = this.hint(this.fields[this.index]);
		if (hint && this.focused) status.push(fitLine(theme.fg("dim", plainLine(hint)), width));
		if (this.pending) status.push(fitLine(theme.fg("warning", "Sending… the form stays until the owner answers."), width));
		if (this.error) for (const line of wrap(plainLine(this.error), width)) status.push(fitLine(theme.fg("error", line), width));
		return status;
	}

	/** A short body keeps the first error line; the heading and status rows never scroll away. */
	private visibleStatus(status: readonly string[], height: number, width: number, theme: Theme): string[] {
		if (status.length <= Math.max(0, height - 2)) return [...status];
		return this.error ? [fitLine(theme.fg("error", plainLine(this.error)), width)] : status.slice(-1);
	}

	/** A wheel position stays until a focus change or a key press; otherwise the caret or highlight is shown. */
	private scrollTo(windowRows: number, bodyLength: number, focused: LaidField | undefined): void {
		const limit = Math.max(0, bodyLength - windowRows);
		this.top = Math.max(0, Math.min(limit, this.top));
		if (this.manual || !focused) return;
		const caret = focused.layout.caret === undefined ? focused.start : focused.start + focused.layout.caret;
		const top = caret >= focused.start + windowRows ? caret - windowRows + 1 : focused.start;
		this.top = Math.max(0, Math.min(limit, top));
	}

	/** Pointer targets only for the rows the window shows, at their screen rows. */
	private registerHits(laid: readonly LaidField[], windowRows: number): void {
		for (const { start, layout } of laid) {
			for (const region of layout.hits) {
				const y = 1 + start + region.y - this.top;
				if (y >= 1 && y < 1 + windowRows) this.hits.add({ ...region, y });
			}
		}
	}

	invalidate(): void {
		this.hits.clear();
	}

	dispose(): void {
		this.hits.clear();
	}
}
