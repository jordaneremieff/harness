import type { Json, ValueSchema } from "../../../../protocol.ts";
import { el } from "../ui/dom.ts";
import { type Control, chooser, type Form, json, singular, structured } from "./parts.ts";
import { jsonControl } from "./scalar.ts";
import { control } from "./structure.ts";
import { initialValue, parseValue } from "./value.ts";

export { setModelChoices } from "./parts.ts";
export { initialValue, parseValue } from "./value.ts";

type View = {
	node: HTMLElement;
	status: HTMLElement;
	body: HTMLElement;
	jsonText: HTMLTextAreaElement;
	watchers: (() => void)[];
	current: Control;
	mode: "form" | "json";
};
function showJson(view: View): void {
	const text = view.current.raw() ?? "null";
	let pretty = text;
	try {
		pretty = JSON.stringify(JSON.parse(text), null, 2);
	} catch {}
	view.jsonText.value = pretty;
	view.jsonText.rows = Math.min(24, Math.max(6, pretty.split("\n").length));
	view.mode = "json";
	view.watchers.length = 0;
	view.body.replaceChildren(view.jsonText);
}
/** The Form and JSON switch of a structured setting. JSON that does not parse keeps the JSON view. */
function viewSwitch(view: View, label: string, start: number, toForm: () => boolean, form: Form): HTMLElement {
	const toggle = el("div", undefined, "value-mode");
	const choice = chooser(["Form", "JSON"], start, `${label} view`, (index) => {
		if (index === 1) showJson(view);
		else if (!toForm()) {
			(toggle.querySelectorAll("input")[1] as HTMLInputElement).checked = true;
			return;
		}
		form.notify();
	});
	toggle.append(choice.node);
	return toggle;
}

/**
 * The editor of one setting: inputs that its schema describes, mapped back to the setting's exact JSON.
 * `raw` is a draft's JSON text, which may not parse yet; `seed` is the value to show without a draft.
 */
export function editor(
	schema: ValueSchema,
	seed: Json | undefined,
	raw: string | undefined,
	label: string,
	onChange: (raw: string, error?: string) => void,
	accessibleCaption = false,
): HTMLElement {
	const view: View = {
		node: el("div", undefined, "value-editor"),
		status: el("p", undefined, "field-help"),
		body: el("div", undefined, "value-body"),
		jsonText: el("textarea", undefined, "mono json-text"),
		watchers: [],
		current: { node: el("div"), raw: () => undefined },
		mode: "form",
	};
	view.status.setAttribute("aria-live", "polite");
	const form: Form = {
		notify: () => {
			const text = currentText(view);
			onChange(text, refresh(view, schema, text));
		},
		watch: (update) => view.watchers.push(update),
	};
	view.jsonText.spellcheck = false;
	view.jsonText.addEventListener("input", form.notify);
	const build = (value: Json | undefined) => {
		view.watchers.length = 0;
		view.current = control(schema, value, { label, optional: false, item: singular(label) }, form);
		view.body.replaceChildren(view.current.node);
		if (accessibleCaption) view.current.target?.setAttribute("aria-label", label);
	};
	const parsed = raw === undefined ? { value: seed } : parseRaw(raw);
	const wholeForm = schema.type !== "json" && structured(schema);
	const readable = "value" in parsed;
	if (wholeForm) view.node.append(viewSwitch(view, label, readable ? 0 : 1, () => toForm(view, build), form));
	if (readable) build(startValue(schema, parsed.value));
	else showText(view, raw ?? "", wholeForm, label, form);
	view.node.append(view.body, view.status);
	view.status.hidden = true;
	// A shown seed or draft reports its problems at once; a new empty value waits for an edit.
	if (raw !== undefined || seed !== undefined) refresh(view, schema, raw ?? currentText(view));
	return view.node;
}
function startValue(schema: ValueSchema, value: Json | undefined): Json | undefined {
	return value === undefined && schema.type !== "json" ? initialValue(schema) : value;
}
/** Returns from the JSON view to the form; JSON that does not parse keeps the JSON view. */
function toForm(view: View, build: (value: Json) => void): boolean {
	const parsed = parseRaw(view.jsonText.value);
	if (!("value" in parsed)) {
		view.status.textContent = "Correct the JSON before you return to the form.";
		view.status.hidden = false;
		return false;
	}
	view.mode = "form";
	build(parsed.value);
	return true;
}
function currentText(view: View): string {
	return view.mode === "json" ? view.jsonText.value : (view.current.raw() ?? "null");
}
/** Runs every field check, then reports the problem of the whole value, pointing at marked fields when there are some. */
function refresh(view: View, schema: ValueSchema, text: string): string | undefined {
	for (const update of view.watchers) update();
	const parsed = parseValue(text, schema);
	const error = "error" in parsed ? parsed.error : undefined;
	const marked = view.body.querySelector(".form-problem:not([hidden])");
	view.status.textContent = error ? (marked ? "Correct the marked fields before you save." : error) : "";
	view.status.hidden = !error;
	return error;
}
/** Draft text that is not JSON yet stays as text until it parses: in the JSON view of a structured setting. */
function showText(view: View, text: string, wholeForm: boolean, label: string, form: Form): void {
	if (wholeForm) {
		view.mode = "json";
		view.jsonText.value = text;
		view.jsonText.rows = Math.min(24, Math.max(6, text.split("\n").length));
		view.body.replaceChildren(view.jsonText);
		return;
	}
	view.current = jsonControl(json, undefined, { label, optional: false }, form);
	(view.current.target as HTMLTextAreaElement).value = text;
	view.body.replaceChildren(view.current.node);
}
function parseRaw(raw: string): { value: Json } | { error: true } {
	try {
		return { value: JSON.parse(raw) as Json };
	} catch {
		return { error: true };
	}
}

/** True when the schema's editor needs the full width of a row. */
export function wideEditor(schema: ValueSchema): boolean {
	return structured(schema) || (schema.type === "union" && schema.options.some(structured));
}
