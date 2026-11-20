import type { Json, TextSchema, ValueSchema } from "../../../../protocol.ts";
import { display } from "../core/state.ts";
import { el, option } from "../ui/dom.ts";
import {
	type Chooser,
	type Control,
	chooser,
	choiceLabel,
	type Form,
	LISTS,
	nextId,
	type Options,
	unsetLabel,
} from "./parts.ts";
import { type Enum, equal, lower, type Numeric, parseValue, problem, stringProblem } from "./value.ts";

/** Enough rows to show most text without scrolling; long text scrolls inside its box. */
function textRows(text: string): number {
	const lines = text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 90)), 0);
	return Math.min(10, Math.max(3, lines));
}
function textPlaceholder(schema: TextSchema & { default?: Json }, optional: boolean): string {
	if (optional) return typeof schema.default === "string" ? `Default: ${schema.default}` : "Not set";
	return schema.format === "model" ? "provider/model" : "";
}
/** Offers the host's identities for model and provider text, and a schema's examples for other text. */
function suggest(input: HTMLInputElement, node: HTMLElement, schema: TextSchema): void {
	if (schema.format && schema.format !== "path") {
		input.setAttribute("list", LISTS[schema.format]);
		return;
	}
	if (!schema.examples?.length) return;
	const list = el("datalist");
	list.id = nextId();
	list.append(...schema.examples.map((example) => option(example, example)));
	node.append(list);
	input.setAttribute("list", list.id);
}
export function textControl(
	schema: TextSchema & { default?: Json },
	value: string | undefined,
	options: Options,
	form: Form,
): Control {
	const multiline = schema.multiline === true || /[\r\n]/.test(value ?? "");
	const node = el("div", undefined, "form-input");
	const input = multiline ? el("textarea") : el("input");
	node.append(input);
	input.value = value ?? "";
	input.spellcheck = false;
	if (input instanceof HTMLTextAreaElement) input.rows = textRows(input.value);
	else {
		input.type = "text";
		suggest(input, node, schema);
	}
	if (schema.format || schema.pattern || schema.path) input.classList.add("mono");
	input.placeholder = textPlaceholder(schema, options.optional);
	input.autocomplete = "off";
	input.addEventListener("input", form.notify);
	const empty = () => options.optional && input.value === "";
	return {
		node,
		target: input,
		wide: multiline,
		raw: () => (empty() ? undefined : JSON.stringify(input.value)),
		problem: () => (empty() ? undefined : stringProblem(input.value, schema, options.label)),
	};
}

function rangeText(schema: Numeric): string {
	const { minimum, maximum } = schema;
	if (minimum !== undefined && maximum !== undefined && maximum < 1e15) return `${minimum} to ${maximum}`;
	if (minimum !== undefined) return `At least ${minimum}`;
	if (maximum !== undefined && maximum < 1e15) return `At most ${maximum}`;
	return "";
}
function numberPlaceholder(schema: Numeric, optional: boolean): string {
	const range = rangeText(schema);
	if (!optional) return range;
	const unset = typeof schema.default === "number" ? `Default ${schema.default}` : "Not set";
	return range ? `${unset} · ${range}` : unset;
}
export function numberControl(schema: Numeric, value: number | undefined, options: Options, form: Form): Control {
	const input = el("input");
	input.type = "text";
	input.inputMode = schema.type === "integer" ? "numeric" : "decimal";
	input.value = value === undefined ? "" : String(value);
	input.autocomplete = "off";
	input.placeholder = numberPlaceholder(schema, options.optional);
	input.addEventListener("input", form.notify);
	const node = el("div", undefined, "form-input number");
	node.append(input);
	const text = () => input.value.trim();
	const unset = () => options.optional && text() === "";
	return {
		node,
		target: input,
		raw: () => (unset() ? undefined : text()),
		problem: () => {
			if (unset()) return;
			const parsed = parseValue(text() || "x", schema);
			if (!("error" in parsed)) return;
			return /complete JSON/.test(parsed.error)
				? `Enter a number for ${lower(options.label)}.`
				: parsed.error.replace(/^Value/, options.label);
		},
	};
}

type Choice = { value?: Json; none?: true };
/** The labels of a choice control: the unset choice, each declared choice, and a stored value outside them. */
function choiceLabels(schema: Enum, value: Json | undefined, optional: boolean) {
	const labels = schema.choices.map((_, index) => choiceLabel(schema, index));
	const labelOf = (item: Json) => {
		const index = schema.choices.findIndex((choice) => equal(choice, item));
		return index < 0 ? undefined : labels[index];
	};
	const known = value === undefined ? -1 : schema.choices.findIndex((choice) => equal(choice, value));
	// A stored value outside the choices stays selectable, so the form maps it back unchanged.
	const stray = value !== undefined && known < 0;
	const all = [
		...(optional ? [unsetLabel(schema, labelOf)] : []),
		...labels,
		...(stray ? [`${display(value)} (not allowed)`] : []),
	];
	const offset = optional ? 1 : 0;
	const selected = value === undefined ? 0 : stray ? all.length - 1 : known + offset;
	return { all, stray, offset, selected };
}
export function choiceControl(schema: Enum, value: Json | undefined, options: Options, form: Form): Control {
	const { all, stray, offset, selected } = choiceLabels(schema, value, options.optional);
	const note = el("p", undefined, "form-help choice-note");
	const showNote = (index: number) => {
		const text = schema.notes?.[index - offset];
		note.textContent = text ?? "";
		note.hidden = !text;
	};
	const pick: Chooser = chooser(all, selected, options.label, (index) => {
		showNote(index);
		form.notify();
	});
	showNote(selected);
	const node = el("div", undefined, "form-choice");
	node.append(pick.node, note);
	const current = (): Choice => {
		const index = pick.index();
		if (options.optional && index === 0) return { none: true };
		if (stray && index === all.length - 1) return { value: value as Json };
		return { value: schema.choices[index - offset] };
	};
	return {
		node,
		target: pick.target,
		raw: () => {
			const chosen = current();
			return chosen.none ? undefined : JSON.stringify(chosen.value ?? null);
		},
		problem: () => {
			const chosen = current();
			return chosen.none || chosen.value === undefined ? undefined : problem(chosen.value, schema, options.label);
		},
	};
}

export function booleanControl(schema: ValueSchema, value: boolean | undefined, options: Options, form: Form): Control {
	if (options.optional)
		return choiceControl({ type: "enum", choices: [true, false], default: schema.default }, value, options, form);
	const input = el("input");
	input.type = "checkbox";
	input.setAttribute("role", "switch");
	input.checked = value === true;
	const state = el("span", input.checked ? "On" : "Off", "switch-state");
	input.addEventListener("change", () => {
		state.textContent = input.checked ? "On" : "Off";
		form.notify();
	});
	const node = el("label", undefined, "switch");
	node.append(input, state);
	return { node, target: input, raw: () => JSON.stringify(input.checked) };
}

export function jsonControl(schema: ValueSchema, value: Json | undefined, options: Options, form: Form): Control {
	const input = el("textarea", undefined, "mono");
	input.value = value === undefined ? "" : JSON.stringify(value, null, 2);
	input.rows = Math.min(10, Math.max(3, input.value.split("\n").length));
	input.placeholder = options.optional ? "Not set" : "JSON value";
	input.spellcheck = false;
	input.addEventListener("input", form.notify);
	const node = el("div", undefined, "form-input");
	node.append(input);
	if (schema.type === "json" && schema.unsupported?.length)
		node.append(el("p", `Not checked here: ${schema.unsupported.join(", ")}.`, "form-help"));
	const empty = () => options.optional && input.value.trim() === "";
	return {
		node,
		target: input,
		wide: true,
		raw: () => (empty() ? undefined : input.value),
		problem: () => {
			if (empty()) return;
			const parsed = parseValue(input.value, schema);
			return "error" in parsed ? parsed.error.replace(/^Value/, options.label) : undefined;
		},
	};
}
