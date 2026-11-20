import type { Json, ModelChoice, ValueSchema } from "../../../../protocol.ts";
import { display } from "../core/state.ts";
import { button, el, option } from "../ui/dom.ts";
import { type Enum, lower } from "./value.ts";

/** One editor's change and check cycle: controls report edits and register the checks they show. */
export type Form = { notify(): void; watch(update: () => void): void };
export type Control = {
	node: HTMLElement;
	/** JSON text of the value; undefined when an optional input is left empty, so its key is omitted. */
	raw(): string | undefined;
	/** The control's own problem; containers report their children through the children's fields. */
	problem?(): string | undefined;
	/** The input that the field's label names. */
	target?: HTMLElement;
	/** Spans the whole row of a form grid. */
	wide?: boolean;
	/** Actions that belong beside the field's label, such as adding or removing an optional structure. */
	actions?: HTMLElement;
};
export type Options = {
	label: string;
	optional: boolean;
	/** A card heading where a control can place its compact form chooser. */
	heading?: HTMLElement;
	/** The noun for one item of a list, when the list's own schema names none. */
	item?: string;
};
export const json = { type: "json" } as const;
let serial = 0;
export const nextId = () => `form-${++serial}`;

const ICONS = {
	remove: "M6 6l12 12M18 6 6 18",
	up: "M12 19V5M6 11l6-6 6 6",
	down: "M12 5v14M6 13l6 6 6-6",
	add: "M12 5v14M5 12h14",
	open: "M9 6l6 6-6 6",
} as const;
export function icon(name: keyof typeof ICONS): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	for (const [key, value] of Object.entries({
		viewBox: "0 0 24 24",
		"aria-hidden": "true",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "1.8",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
	}))
		svg.setAttribute(key, value);
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", ICONS[name]);
	svg.append(path);
	return svg;
}
export function iconButton(name: keyof typeof ICONS, label: string, run: () => void, cls = ""): HTMLButtonElement {
	const node = button("", run, `form-icon ${cls}`.trim());
	node.append(icon(name));
	node.setAttribute("aria-label", label);
	node.title = label;
	return node;
}
export function addButton(label: string, run: () => void, aria?: string): HTMLButtonElement {
	const node = button("", run, "form-add");
	node.append(icon("add"), document.createTextNode(label));
	if (aria) node.setAttribute("aria-label", aria);
	return node;
}
export function quietButton(label: string, run: () => void, aria?: string): HTMLButtonElement {
	const node = button(label, run, "form-quiet");
	if (aria) node.setAttribute("aria-label", aria);
	return node;
}

export const upper = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);
/** The singular of a plain English label, for naming one entry of a list. */
export function singular(text: string): string {
	const word = lower(text);
	if (/ies$/.test(word)) return word.replace(/ies$/, "y");
	if (/[^s]s$/.test(word)) return word.slice(0, -1);
	return word;
}
export function plural(text: string): string {
	if (/[^aeiou]y$/.test(text)) return text.replace(/y$/, "ies");
	return /(s|x|ch|sh)$/.test(text) ? `${text}es` : `${text}s`;
}
export function noun(schema: ValueSchema, fallback: string): string {
	if (schema.label) return lower(schema.label);
	if (schema.type === "string" && schema.format) return schema.format;
	return fallback;
}
export function choiceLabel(schema: Enum, index: number): string {
	const label = schema.labels?.[index];
	if (label) return label;
	const choice = schema.choices[index];
	if (typeof choice === "boolean") return choice ? "On" : "Off";
	// A plain lowercase word reads as a choice; other text shows exactly as stored.
	if (typeof choice === "string" && /^[a-z][a-z0-9-]*$/.test(choice)) return upper(choice);
	return display(choice).replaceAll("\n", " · ");
}
/** The choice that stands for an absent optional value: its default when the schema names one. */
export function unsetLabel(schema: ValueSchema, labelOf: (value: Json) => string | undefined): string {
	if (schema.default === undefined) return "Not set";
	const text = labelOf(schema.default);
	return text ? `Default (${text})` : "Default";
}
export const structured = (schema: ValueSchema) =>
	schema.type === "object" || schema.type === "map" || schema.type === "array" || schema.type === "json";

/** Shows a control's problem in `issue` whenever the form checks its fields. */
export function showProblem(form: Form, issue: HTMLElement, read: () => string | undefined, input?: HTMLElement): void {
	issue.hidden = true;
	const update = () => {
		const text = read();
		issue.textContent = text ?? "";
		issue.hidden = !text;
		input?.setAttribute("aria-invalid", String(Boolean(text)));
	};
	form.watch(update);
	update();
}

/** A labelled field with its help and its own problem. */
export function field(control: Control, label: string, help: string | undefined, form: Form): HTMLElement {
	const node = el("div", undefined, `form-field${control.wide ? " wide" : ""}`);
	const head = el("div", undefined, "form-field-head");
	const caption = el(control.target ? "label" : "span", label, "form-label");
	if (control.target) {
		control.target.id ||= nextId();
		(caption as HTMLLabelElement).htmlFor = control.target.id;
	} else {
		caption.id = nextId();
		if (!control.node.hasAttribute("role")) control.node.setAttribute("role", "group");
		control.node.setAttribute("aria-labelledby", caption.id);
	}
	head.append(caption);
	if (control.actions) head.append(control.actions);
	node.append(head);
	if (help) node.append(el("p", help, "form-help"));
	node.append(control.node);
	const issue = el("p", undefined, "form-problem");
	node.append(issue);
	const read = control.problem;
	if (read) showProblem(form, issue, () => read(), control.target);
	else issue.hidden = true;
	return node;
}

export type Chooser = { node: HTMLElement; index(): number; target?: HTMLElement };
function segments(labels: string[], selected: number, name: string, onChange: (index: number) => void): Chooser {
	const node = el("div", undefined, "segmented");
	const group = nextId();
	const inputs = labels.map((label, index) => {
		const item = el("label", undefined, "segment");
		const input = el("input");
		input.type = "radio";
		input.name = group;
		input.checked = index === selected;
		input.addEventListener("change", () => onChange(index));
		item.append(input, el("span", label));
		node.append(item);
		return input;
	});
	node.setAttribute("role", "radiogroup");
	node.setAttribute("aria-label", name);
	return { node, index: () => inputs.findIndex((input) => input.checked) };
}
/** Buttons in one row for a few short choices; a menu for the rest. */
export function chooser(labels: string[], selected: number, name: string, onChange: (index: number) => void): Chooser {
	if (labels.length <= 4 && labels.every((label) => label.length <= 18))
		return segments(labels, selected, name, onChange);
	const select = el("select");
	for (const [index, label] of labels.entries()) select.append(option(String(index), label));
	select.selectedIndex = selected;
	select.addEventListener("change", () => onChange(select.selectedIndex));
	const node = el("div", undefined, "form-input");
	node.append(select);
	return { node, index: () => select.selectedIndex, target: select };
}

/** Model and provider suggestions for text in those formats, shared by every editor on the page. */
export const LISTS = { model: "config-models", provider: "config-providers" } as const;
function fillList(id: string, rows: [string, string | undefined][]): void {
	let list = document.getElementById(id) as HTMLDataListElement | null;
	if (!list) {
		list = el("datalist");
		list.id = id;
		document.body.append(list);
	}
	list.replaceChildren(
		...rows.map(([value, label]) => {
			const node = el("option");
			node.value = value;
			if (label) node.label = label;
			return node;
		}),
	);
}
export function setModelChoices(models: readonly ModelChoice[]): void {
	fillList(
		LISTS.model,
		models.map((model) => [model.id, model.name]),
	);
	const providers = [...new Set(models.map((model) => model.id.slice(0, model.id.indexOf("/"))))].sort();
	fillList(
		LISTS.provider,
		providers.map((provider) => [provider, undefined]),
	);
}

/** Wraps an invalid child so that it cannot turn into siblings or disappear when its parent is composed. */
export function fragment(text: string): string {
	try {
		JSON.parse(text);
		return text;
	} catch {
		return `(${text})`;
	}
}
export function wrap(input: HTMLElement): HTMLElement {
	const node = el("div", undefined, "form-input");
	node.append(input);
	return node;
}
