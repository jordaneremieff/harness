import {
	CURSOR_MARKER,
	Input,
	matchesKey,
	type SelectItem,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { type Action, type KeyHint, keyMatches, plainLine, type View, type ViewHost } from "./frame.ts";
import { CHOOSE, Choices, PAGE, wrap } from "./view-parts.ts";

interface TextField {
	readonly kind: "text";
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly placeholder?: string;
}
interface ChoiceField {
	readonly kind: "choice";
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly choices: readonly SelectItem[] | ((values: Values) => readonly SelectItem[]);
	readonly filter?: boolean;
	readonly rows?: number;
	readonly hint?: string;
}
type Values = Readonly<Record<string, string>>;
type Field =
	| { spec: TextField; input: Input; value: string }
	| { spec: ChoiceField; list: Choices; filter?: Input; value: string };

interface Options {
	readonly title: string;
	readonly heading: string;
	readonly intro: string;
	readonly host: ViewHost;
	readonly fields: readonly (TextField | ChoiceField)[];
	readonly action: { readonly label: string };
	change?(values: Values): void;
	validate?(values: Values): string | undefined;
	submit(values: Values, signal: AbortSignal): Promise<{ notice: { text: string; kind: "success" } } | undefined>;
}

interface Region {
	readonly index: number;
	readonly top: number;
	readonly lines: string[];
	readonly listRow?: number;
	readonly inputRow?: number;
}

/** Arguments, placement, model and reasoning are staged until the labelled action runs. */
export class Form implements View {
	readonly title: string;
	focused = false;
	private readonly fields: Field[];
	private index = 0;
	private textActive = true;
	private pending = false;
	private error?: string;
	private offset = 0;
	private manual = false;
	private regions: Region[] = [];
	private area = { start: 0, rows: 0, total: 0 };

	private readonly options: Options;

	constructor(options: Options) {
		this.options = options;
		this.title = options.title;
		this.fields = options.fields.map((spec): Field => {
			if (spec.kind === "text") {
				const input = new Input({ prompt: "  ", placeholder: spec.placeholder });
				input.setValue(spec.value);
				return { spec, input, value: spec.value };
			}
			const filter = spec.filter ? new Input({ prompt: "  Filter  ", placeholder: "type to narrow" }) : undefined;
			const field = {
				spec,
				filter,
				value: spec.value,
				list: new Choices(options.host.theme, (value) => {
					field.value = value;
					this.changed();
				}),
			};
			return field;
		});
		this.reconcile();
	}

	private values(): Values {
		return Object.fromEntries(this.fields.map((field) => [field.spec.id, field.value]));
	}

	private reconcile(fromFilter?: Field): void {
		for (const field of this.fields) {
			if (!("list" in field)) continue;
			const spec = field.spec;
			const all = typeof spec.choices === "function" ? spec.choices(this.values()) : spec.choices;
			const words = field.filter?.getValue().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
			const shown = all.filter((choice) => {
				const text = `${choice.value} ${choice.label} ${choice.description ?? ""}`.toLowerCase();
				return words.every((word) => text.includes(word));
			});
			if (!all.some((choice) => choice.value === field.value)) field.value = all[0]?.value ?? "";
			if (field === fromFilter && !shown.some((choice) => choice.value === field.value))
				field.value = shown[0]?.value ?? field.value;
			field.list.set([...shown], field.value);
		}
	}

	private changed(fromFilter?: Field): void {
		this.error = undefined;
		this.manual = false;
		this.reconcile(fromFilter);
		this.options.change?.(this.values());
	}

	private input(field = this.fields[this.index]): Input | undefined {
		return "input" in field ? field.input : field.filter;
	}

	editing(): boolean {
		return this.textActive && this.input() !== undefined;
	}

	escape(): boolean {
		if (!this.editing()) return false;
		this.textActive = false;
		return true;
	}

	private focus(index: number): void {
		if (this.pending) return;
		this.index = index;
		this.textActive = true;
		this.manual = false;
	}

	focusStep(backward: boolean): void {
		const count = this.fields.length;
		this.focus((this.index + (backward ? -1 : 1) + count) % count);
	}

	private last(): boolean {
		return this.index === this.fields.length - 1;
	}

	private label(): string {
		const label = this.options.action.label;
		return `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
	}

	keys(): readonly KeyHint[] {
		const field = this.fields[this.index];
		const hints: KeyHint[] = [];
		if (!this.last() || this.editing()) hints.push({ keys: ["enter"], label: this.last() ? this.label() : "next" });
		if ("list" in field) hints.push(CHOOSE);
		if (this.input() && !this.editing()) hints.push({ keys: ["/"], label: "edit" });
		if (this.fields.length > 1) hints.push({ keys: ["tab"], label: "field", priority: 2 });
		if (this.area.total > this.area.rows) hints.push(PAGE);
		if (this.editing()) hints.push({ keys: ["escape"], label: "leave edit" });
		return hints;
	}

	actions(): readonly Action[] {
		return [
			{
				id: "submit",
				label: this.pending ? `${this.options.action.label}…` : this.options.action.label,
				key: this.last() ? "enter" : undefined,
				disabled: this.pending ? "The request is still running" : undefined,
				run: () => void this.submit(),
			},
			{ id: "cancel", label: "Cancel", key: "escape", run: () => this.options.host.back() },
		];
	}

	private async submit(): Promise<void> {
		const { host } = this.options;
		if (this.pending || host.signal.aborted) return;
		const values = this.values();
		this.error = this.options.validate?.(values);
		if (this.error) {
			host.requestRender();
			return;
		}
		this.pending = true;
		host.requestRender();
		try {
			const result = await this.options.submit(values, host.signal);
			if (!host.signal.aborted && result) host.notify(result.notice.text, result.notice.kind);
		} catch (error) {
			this.error = plainLine(error instanceof Error ? error.message : String(error));
		} finally {
			this.pending = false;
			host.requestRender();
		}
	}

	private textInput(field: Field, data: string): boolean {
		const input = this.input(field);
		if (!input) return false;
		const before = input.getValue();
		input.handleInput(data);
		if (before !== input.getValue()) {
			if ("input" in field) field.value = input.getValue();
			this.changed(field);
		}
		return true;
	}

	handleInput(data: string): boolean {
		const field = this.fields[this.index];
		if (this.pending) return true;
		if (matchesKey(data, "enter")) this.advance();
		else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.scroll((matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, this.area.rows - 1));
		} else if ("list" in field && (matchesKey(data, "up") || matchesKey(data, "down"))) field.list.handleInput(data);
		else if (this.editing()) return this.textInput(field, data);
		else if (keyMatches(data, "/") && this.input()) this.focus(this.index);
		else return false;
		return true;
	}

	private advance(): void {
		if (this.last()) void this.submit();
		else this.focus(this.index + 1);
	}

	private scroll(delta: number): void {
		this.manual = true;
		this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, this.area.total - this.area.rows)));
	}

	private fieldRows(field: Field, index: number, width: number, height: number, top: number): Region {
		const theme = this.options.host.theme;
		const active = this.focused && this.index === index;
		const lines = [theme.fg(active ? "accent" : "muted", field.spec.label)];
		const input = this.input(field);
		if (input) {
			input.focused = active && this.textActive && !this.manual;
			lines.push(...input.render(width));
		}
		const listRow = "list" in field ? lines.length : undefined;
		if ("list" in field) {
			lines.push(...field.list.render(width, Math.max(1, Math.min(field.spec.rows ?? 4, height)), active));
			if (field.spec.hint) lines.push(theme.fg("dim", field.spec.hint));
		}
		return { index, top, lines, listRow, inputRow: input ? 1 : undefined };
	}

	private reveal(rows: number, total: number): void {
		if (!this.manual) {
			const field = this.regions[this.index];
			const caret = field.lines.findIndex((line) => line.includes(CURSOR_MARKER));
			const anchor = field.top + (caret < 0 ? (field.listRow ?? field.inputRow ?? 0) : caret);
			this.offset = Math.min(field.top, Math.max(this.offset, anchor - rows + 1));
			if (anchor >= this.offset + rows) this.offset = anchor - rows + 1;
		}
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - rows)));
	}

	render(width: number, height: number): string[] {
		const theme = this.options.host.theme;
		const heading = [
			theme.bold(this.options.heading),
			...wrap(this.options.intro, width).map((line) => theme.fg("muted", line)),
		].slice(0, Math.max(1, height - 3));
		const status = this.pending
			? [theme.fg("warning", "Applying…")]
			: wrap(this.error ?? "", width)
					.filter(Boolean)
					.map((line) => theme.fg("error", line));
		const tail = status.slice(0, Math.max(0, height - heading.length - 1));
		const rows = Math.max(0, height - heading.length - tail.length);
		const body: string[] = [];
		this.regions = this.fields.map((field, index) => {
			const region = this.fieldRows(field, index, width, rows - 2, body.length);
			body.push(...region.lines);
			return region;
		});
		this.area = { start: heading.length, rows, total: body.length };
		this.reveal(rows, body.length);
		const visible = body.slice(this.offset, this.offset + rows);
		return [...heading, ...visible, ...Array<string>(rows - visible.length).fill(""), ...tail];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.pending) return undefined;
		const row = event.y - this.area.start;
		if (row < 0 || row >= this.area.rows) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			this.scroll(event.wheelDelta);
			return { handled: true };
		}
		return this.clickField(event, row + this.offset);
	}

	private clickField(event: TuiMouseEvent, row: number): TuiMouseEventResult | undefined {
		const region = this.regions.find(
			(candidate) => row >= candidate.top && row < candidate.top + candidate.lines.length,
		);
		if (event.type !== "click" || !region) return undefined;
		const field = this.fields[region.index];
		const local = row - region.top;
		this.focus(region.index);
		if (local === region.inputRow) this.input(field)?.handleMouse({ ...event, y: 0, height: 1 });
		if ("list" in field && region.listRow !== undefined && local >= region.listRow)
			field.list.handleMouse({ ...event, y: local - region.listRow, height: region.lines.length - region.listRow });
		return { handled: true };
	}
}
