import type { Json, ValueSchema } from "../../../../protocol.ts";
import { el } from "../ui/dom.ts";
import {
	addButton,
	type Control,
	choiceLabel,
	chooser,
	type Form,
	field,
	fragment,
	icon,
	iconButton,
	json,
	LISTS,
	noun,
	type Options,
	plural,
	quietButton,
	showProblem,
	singular,
	structured,
	upper,
	wrap,
} from "./parts.ts";
import { booleanControl, choiceControl, jsonControl, numberControl, textControl } from "./scalar.ts";
import {
	type Alternatives,
	type Dictionary,
	equal,
	initialValue,
	type List,
	lower,
	object,
	problem,
	repeats,
	type Shape,
	stringProblem,
} from "./value.ts";

function fits(schema: ValueSchema, value: Json | undefined): boolean {
	if (value === undefined) return true;
	switch (schema.type) {
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "number":
		case "integer":
			return typeof value === "number";
		case "array":
			return Array.isArray(value);
		case "object":
		case "map":
			return object(value);
		default:
			return true;
	}
}
/** The input that a schema describes; a value that does not fit it stays editable as JSON. */
export function control(schema: ValueSchema, value: Json | undefined, options: Options, form: Form): Control {
	if (!fits(schema, value)) return jsonControl(schema, value, options, form);
	switch (schema.type) {
		case "boolean":
			return booleanControl(schema, value as boolean | undefined, options, form);
		case "string":
			return textControl(schema, value as string | undefined, options, form);
		case "number":
		case "integer":
			return numberControl(schema, value as number | undefined, options, form);
		case "enum":
			return choiceControl(schema, value, options, form);
		case "array":
			return listControl(schema, value as Json[] | undefined, options, form);
		case "object":
			return shapeControl(schema, value as Record<string, Json> | undefined, options, form);
		case "map":
			return dictionaryControl(schema, value as Record<string, Json> | undefined, options, form);
		case "union":
			return schema.options.length
				? unionControl(schema, value, options, form)
				: jsonControl(schema, value, options, form);
		case "json":
			return jsonControl(schema, value, options, form);
	}
}

/**
 * An optional structure: absent until the operator adds it, then removable as a whole. The add and remove
 * actions share one place beside the field's label. An empty list or map stays distinct from an absent one.
 */
function optionalStructure(present: boolean, options: Options, form: Form, build: () => Control): Control {
	if (!options.optional) return build();
	const node = el("div", undefined, "form-optional");
	const actions = el("span", undefined, "form-actions");
	const name = lower(options.label);
	let inner: Control | undefined;
	const show = () => {
		inner = build();
		actions.replaceChildren(quietButton("Remove", remove, `Remove ${name}`));
		node.replaceChildren(inner.node);
		node.hidden = false;
	};
	const hide = () => {
		inner = undefined;
		actions.replaceChildren(addButton("Add", add, `Add ${name}`));
		node.replaceChildren();
		node.hidden = true;
	};
	const add = () => {
		show();
		form.notify();
		node.querySelector<HTMLElement>("input, select, textarea")?.focus();
	};
	const remove = () => {
		hide();
		form.notify();
	};
	if (present) show();
	else hide();
	return { node, wide: true, actions, raw: () => inner?.raw() };
}

type Item = { row: HTMLElement; control: Control };
type Names = { noun: string; label: string };
function listRow(schema: List, value: Json, names: Names, form: Form, act: (item: Item, step: number) => void): Item {
	const cards = structured(schema.items) || schema.items.type === "union";
	const row = el("div", undefined, cards ? "form-card" : "form-row");
	const slot = el("span", undefined, "form-card-slot");
	const item: Item = {
		row,
		control: control(schema.items, value, { label: names.label, optional: false, heading: slot }, form),
	};
	const actions = el("div", undefined, "form-actions");
	actions.append(
		iconButton("up", `Move ${names.noun} up`, () => act(item, -1), "move"),
		iconButton("down", `Move ${names.noun} down`, () => act(item, 1), "move"),
		iconButton("remove", `Remove ${names.noun}`, () => act(item, 0)),
	);
	if (cards) {
		const head = el("div", undefined, "form-card-head");
		head.append(el("span", undefined, "form-card-title"), slot, actions);
		row.append(head, item.control.node);
	} else {
		item.control.target?.setAttribute("aria-label", names.label);
		row.append(item.control.node, actions);
	}
	const read = item.control.problem;
	if (read) {
		const issue = el("p", undefined, "form-problem");
		row.append(issue);
		showProblem(form, issue, () => read());
	}
	return item;
}
function listProblem(schema: List, raw: string, label: string, itemNoun: string): string | undefined {
	let value: Json[];
	try {
		value = JSON.parse(raw) as Json[];
	} catch {
		return;
	}
	if (schema.unique && repeats(value)) return `${label} lists the same ${itemNoun} twice.`;
	if (schema.minItems !== undefined && value.length < schema.minItems)
		return `${label} needs at least ${schema.minItems} ${plural(itemNoun)}.`;
}
function listBody(schema: List, values: Json[], options: Options, form: Form): Control {
	const node = el("div", undefined, "form-list");
	const rows = el("div", undefined, "form-rows");
	const items: Item[] = [];
	const itemNoun = noun(schema.items, options.item ?? singular(options.label));
	const names = { noun: itemNoun, label: schema.items.label ?? upper(itemNoun) };
	const empty = el("p", `No ${plural(itemNoun)}.`, "form-empty");
	const order = () => {
		for (const [index, item] of items.entries()) {
			const title = item.row.querySelector(":scope > .form-card-head > .form-card-title");
			if (title) title.textContent = `${names.label} ${index + 1}`;
			const [up, down] = item.row.querySelectorAll<HTMLButtonElement>(".move");
			up.disabled = index === 0;
			down.disabled = index === items.length - 1;
		}
		more.disabled = schema.maxItems !== undefined && items.length >= schema.maxItems;
		empty.hidden = items.length > 0;
	};
	// Step -1 or 1 moves an item; step 0 removes it.
	const act = (item: Item, step: number) => {
		const index = items.indexOf(item);
		if (step === 0) {
			items.splice(index, 1);
			item.row.remove();
		} else {
			const target = index + step;
			if (target < 0 || target >= items.length) return;
			items.splice(index, 1);
			items.splice(target, 0, item);
			rows.replaceChildren(...items.map((other) => other.row));
		}
		order();
		form.notify();
	};
	const add = (value: Json) => {
		const item = listRow(schema, value, names, form, act);
		items.push(item);
		rows.append(item.row);
		return item;
	};
	const more = addButton(`Add ${itemNoun}`, () => {
		const item = add(initialValue(schema.items));
		order();
		form.notify();
		(item.control.target ?? item.row.querySelector<HTMLElement>("input, select, textarea"))?.focus();
	});
	for (const value of values) add(value);
	const issue = el("p", undefined, "form-problem");
	node.append(empty, rows, more, issue);
	order();
	const raw = () => `[${items.map(({ control: item }) => fragment(item.raw() ?? "null")).join(", ")}]`;
	showProblem(form, issue, () => listProblem(schema, raw(), options.label, itemNoun));
	return { node, wide: true, raw };
}
function listControl(schema: List, values: Json[] | undefined, options: Options, form: Form): Control {
	return optionalStructure(values !== undefined, options, form, () => listBody(schema, values ?? [], options, form));
}

/** A key that the shape does not declare stays visible and editable as JSON until the operator removes it. */
function extraField(
	schema: Shape,
	key: string,
	value: Json,
	form: Form,
	remove: (node: HTMLElement) => void,
): Control & { field: HTMLElement } {
	const item = jsonControl(json, value, { label: key, optional: false }, form);
	const actions = el("span", undefined, "form-actions");
	const node = field({ ...item, actions }, key, schema.additional ? undefined : "This key is not allowed here.", form);
	actions.append(quietButton("Remove", () => remove(node), `Remove ${key}`));
	return { ...item, field: node };
}
function shapeBody(schema: Shape, current: Record<string, Json>, form: Form): Control {
	const node = el("div", undefined, "form-grid");
	const fields = new Map<string, Control>();
	const order = Object.keys(current);
	for (const [key, child] of Object.entries(schema.properties)) {
		const label = child.label ?? key;
		const optional = !schema.required?.includes(key);
		const item = control(child, Object.hasOwn(current, key) ? current[key] : undefined, { label, optional }, form);
		if (!order.includes(key)) order.push(key);
		fields.set(key, item);
		node.append(field(item, label, child.help, form));
	}
	for (const key of Object.keys(current).filter((name) => !Object.hasOwn(schema.properties, name))) {
		const extra = extraField(schema, key, current[key], form, (wrapper) => {
			fields.delete(key);
			wrapper.remove();
			form.notify();
		});
		fields.set(key, extra);
		node.append(extra.field);
	}
	const raw = () => {
		const parts: string[] = [];
		for (const key of order) {
			const text = fields.get(key)?.raw();
			if (text !== undefined) parts.push(`${JSON.stringify(key)}: ${fragment(text)}`);
		}
		return `{${parts.join(", ")}}`;
	};
	return { node, wide: true, raw };
}
function shapeControl(schema: Shape, value: Record<string, Json> | undefined, options: Options, form: Form): Control {
	return optionalStructure(value !== undefined, options, form, () =>
		shapeBody(schema, value ?? (initialValue(schema) as Record<string, Json>), form),
	);
}

/** One part of a closed record's summary: an identity, a choice, a number or a switch. */
function summaryPart(schema: ValueSchema, value: Json, label: string): string | undefined {
	if (schema.type === "enum") {
		const index = schema.choices.findIndex((choice) => equal(choice, value));
		return index < 0 ? undefined : choiceLabel(schema, index);
	}
	if (schema.type === "string" && typeof value === "string" && value && (schema.format || schema.pattern)) return value;
	if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") return `${label} ${value}`;
	if (schema.type === "boolean" && typeof value === "boolean") return `${label} ${value ? "on" : "off"}`;
}
/** A short line that identifies a record while its card is closed. */
export function summaryOf(schema: Shape, raw: string | undefined): string {
	let value: Json;
	try {
		value = JSON.parse(raw ?? "null") as Json;
	} catch {
		return "";
	}
	if (!object(value)) return "";
	const parts: string[] = [];
	for (const [key, child] of Object.entries(schema.properties)) {
		const part = Object.hasOwn(value, key) ? summaryPart(child, value[key], child.label ?? key) : undefined;
		if (part && parts.length < 3) parts.push(part);
	}
	return parts.join(" · ");
}

type Entry = { row: HTMLElement; key: HTMLInputElement; control: Control };
type Book = {
	schema: Dictionary;
	form: Form;
	keyLabel: string;
	valueLabel: string;
	itemNoun: string;
	nameProblem(entry: Entry): string | undefined;
	remove(entry: Entry): void;
};
function keyInput(book: Book, key: string): HTMLInputElement {
	const keys = book.schema.keys;
	const name = el("input", undefined, "form-key");
	name.type = "text";
	name.value = key;
	name.spellcheck = false;
	name.autocomplete = "off";
	name.placeholder = book.keyLabel;
	if (keys?.format && keys.format !== "path") name.setAttribute("list", LISTS[keys.format]);
	if (keys?.format || keys?.pattern) name.classList.add("mono");
	name.addEventListener("input", book.form.notify);
	return name;
}
/** A named record, such as an execution preset: a card that opens in place and shows a summary while closed. */
function record(book: Book, shape: Shape, key: string, item: Json, open: boolean): Entry {
	const card = el("details", undefined, "form-card form-record");
	card.open = open;
	const summary = el("summary", undefined, "form-record-head");
	const title = el("span", undefined, "form-record-name");
	const brief = el("span", undefined, "form-record-summary");
	summary.append(icon("open"), title, brief);
	const name = keyInput(book, key);
	const child = control(shape, item, { label: book.valueLabel, optional: false }, book.form);
	const entry: Entry = { row: card, key: name, control: child };
	const body = el("div", undefined, "form-record-body");
	const naming: Control = {
		node: wrap(name),
		target: name,
		raw: () => JSON.stringify(name.value),
		problem: () => book.nameProblem(entry),
	};
	body.append(
		field(naming, book.keyLabel, book.schema.keys?.help, book.form),
		child.node,
		quietButton(`Remove ${book.itemNoun}`, () => book.remove(entry), `Remove ${book.itemNoun} ${key}`),
	);
	card.append(summary, body);
	if (book.schema.keys?.pattern || book.schema.keys?.format) title.classList.add("mono");
	book.form.watch(() => {
		title.textContent = name.value || `New ${book.itemNoun}`;
		brief.textContent = summaryOf(shape, child.raw());
		// A record with a problem stays open so that the marked field is visible.
		if (body.querySelector(".form-problem:not([hidden])")) card.open = true;
	});
	return entry;
}
/** A named value in one table row, or in a card when the value has parts of its own. */
function namedRow(book: Book, key: string, item: Json): Entry {
	const values = book.schema.values;
	const cards = structured(values) || values.type === "union";
	const name = keyInput(book, key);
	name.setAttribute("aria-label", book.keyLabel);
	const slot = el("span", undefined, "form-card-slot");
	const child = control(values, item, { label: book.valueLabel, optional: false, heading: slot }, book.form);
	const row = el("div", undefined, cards ? "form-card" : "form-row form-table-row");
	const entry: Entry = { row, key: name, control: child };
	const remove = iconButton("remove", `Remove ${book.itemNoun}`, () => book.remove(entry));
	if (cards) {
		const top = el("div", undefined, "form-card-head");
		name.classList.add("title");
		top.append(name, slot, remove);
		row.append(top, child.node);
	} else {
		child.target?.setAttribute("aria-label", `${book.valueLabel} for ${key || `the new ${book.itemNoun}`}`);
		row.append(name, child.node, remove);
	}
	const issue = el("p", undefined, "form-problem");
	row.append(issue);
	showProblem(book.form, issue, () => book.nameProblem(entry) ?? child.problem?.(), name);
	return entry;
}
function nameProblem(schema: Dictionary, entries: Entry[], entry: Entry, keyLabel: string): string | undefined {
	const key = entry.key.value;
	if (key === "") return `Enter a ${lower(keyLabel)}.`;
	if (entries.some((other) => other !== entry && other.key.value === key))
		return `${keyLabel} ${JSON.stringify(key)} appears twice.`;
	if (!schema.keys) return;
	const issue = stringProblem(key, schema.keys, keyLabel);
	return issue && (schema.keys.format === "model" ? issue : `${keyLabel} ${JSON.stringify(key)} is not allowed.`);
}
function dictionaryRaw(entries: Entry[]): string {
	const seen = new Set<string>();
	return `{${entries
		.map(({ key, control: child }) => {
			const name = key.value;
			// Leave duplicate keys invalid instead of letting JSON.parse discard an entry.
			const encoded = seen.has(name) ? `${JSON.stringify(name)} /* Duplicate key */` : JSON.stringify(name);
			seen.add(name);
			return `${encoded}: ${fragment(child.raw() ?? "null")}`;
		})
		.join(", ")}}`;
}
function dictionaryBody(schema: Dictionary, value: Record<string, Json>, form: Form): Control {
	const values = schema.values;
	const shape = values.type === "object" ? values : undefined;
	const entries: Entry[] = [];
	const keyLabel = schema.keys?.label ?? "Name";
	const book: Book = {
		schema,
		form,
		keyLabel,
		valueLabel: values.label ?? "Value",
		itemNoun: shape ? noun(values, "entry") : noun(schema.keys ?? values, "entry"),
		nameProblem: (entry) => nameProblem(schema, entries, entry, keyLabel),
		remove: (entry) => {
			entries.splice(entries.indexOf(entry), 1);
			entry.row.remove();
			refresh();
			form.notify();
		},
	};
	const table = !shape && !structured(values) && values.type !== "union";
	const rows = el("div", undefined, table ? "form-rows form-table" : "form-rows");
	const head = el("div", undefined, "form-table-head");
	head.append(el("span", keyLabel), el("span", book.valueLabel), el("span"));
	if (table) rows.append(head);
	const empty = el("p", `No ${book.itemNoun === "entry" ? "entries" : plural(book.itemNoun)}.`, "form-empty");
	const add = (key: string, item: Json, open: boolean) => {
		const entry = shape ? record(book, shape, key, item, open) : namedRow(book, key, item);
		entries.push(entry);
		rows.append(entry.row);
		refresh();
		return entry;
	};
	const more = addButton(`Add ${book.itemNoun}`, () => {
		add("", initialValue(values), true).key.focus();
		form.notify();
	});
	const refresh = () => {
		empty.hidden = entries.length > 0;
		head.hidden = entries.length === 0;
		more.disabled = schema.maxEntries !== undefined && entries.length >= schema.maxEntries;
	};
	for (const [key, item] of Object.entries(value)) add(key, item, false);
	refresh();
	const node = el("div", undefined, "form-list");
	node.append(empty, rows, more);
	return { node, wide: true, raw: () => dictionaryRaw(entries) };
}
function dictionaryControl(
	schema: Dictionary,
	value: Record<string, Json> | undefined,
	options: Options,
	form: Form,
): Control {
	return optionalStructure(value !== undefined, options, form, () => dictionaryBody(schema, value ?? {}, form));
}

function formLabel(schema: ValueSchema, single: boolean): string {
	if (schema.label) return schema.label;
	if (single) return schema.type === "number" || schema.type === "integer" ? "Number" : "Value";
	if (schema.help && schema.help.length <= 40) return schema.help.replace(/\.$/, "");
	const names: Partial<Record<ValueSchema["type"], string>> = {
		string: "Text",
		number: "Number",
		integer: "Number",
		object: "With options",
		map: "With options",
		array: "List",
	};
	return names[schema.type] ?? "Value";
}
type Constant = { value: Json; label: string; note?: string };
type Alternative = { label: string; constant?: Json; schema?: ValueSchema };
function alternatives(schema: Alternatives): { constants: Constant[]; open: ValueSchema[] } {
	const constants: Constant[] = [];
	const open: ValueSchema[] = [];
	for (const choice of schema.options) {
		if (choice.type === "boolean") constants.push({ value: true, label: "On" }, { value: false, label: "Off" });
		else if (choice.type === "enum")
			for (const [index, item] of choice.choices.entries())
				constants.push({ value: item, label: choiceLabel(choice, index), note: choice.notes?.[index] });
		else open.push(choice);
	}
	return { constants, open };
}
function matchForm(forms: Alternative[], value: Json | undefined, label: string): number {
	if (value === undefined) return -1;
	return forms.findIndex((item) =>
		item.schema ? !problem(value, item.schema, label) : equal(item.constant as Json, value),
	);
}
/** Constants and open forms in one choice; the chosen open form shows its own inputs below the choice. */
function formsControl(forms: Alternative[], value: Json | undefined, options: Options, form: Form): Control {
	const offset = options.optional ? 1 : 0;
	const found = matchForm(forms, value, options.label);
	// A stored value that matches no form stays selectable as JSON, so the form maps it back unchanged.
	const stray = value !== undefined && found < 0;
	const labels = [
		...(options.optional ? ["Not set"] : []),
		...forms.map((item) => item.label),
		...(stray ? ["Current value"] : []),
	];
	const strayIndex = labels.length - 1;
	const selected = value === undefined ? 0 : stray ? strayIndex : found + offset;
	const panel = el("div", undefined, "form-union-panel");
	const built = new Map<number, Control>();
	const formAt = (index: number): Control | undefined => {
		const chosen = forms[index - offset];
		const schema = stray && index === strayIndex ? json : chosen?.schema;
		if (!schema) return;
		if (!built.has(index)) {
			const seed = index === selected && value !== undefined ? value : initialValue(schema);
			built.set(index, control(schema, seed, { label: options.label, optional: false }, form));
		}
		return built.get(index);
	};
	const show = (index: number) => {
		const item = formAt(index);
		item?.target?.setAttribute("aria-label", options.label);
		panel.replaceChildren(...(item ? [item.node] : []));
		panel.hidden = !item;
	};
	const pick = chooser(labels, selected, `${options.label} form`, (index) => {
		show(index);
		form.notify();
	});
	show(selected);
	const node = el("div", undefined, "form-union");
	(options.heading ?? node).append(pick.node);
	node.append(panel);
	const active = (): Pick<Control, "raw" | "problem"> => {
		const index = pick.index();
		const chosen = forms[index - offset];
		if (chosen && !chosen.schema && !(stray && index === strayIndex))
			return { raw: () => JSON.stringify(chosen.constant) };
		return formAt(index) ?? { raw: () => undefined };
	};
	return {
		node,
		target: options.heading ? undefined : pick.target,
		wide: forms.some((item) => item.schema && structured(item.schema)),
		raw: () => active().raw(),
		problem: () => active().problem?.(),
	};
}
/** Constants and at most one open form become one choice; with more open forms the operator chooses a form first. */
function unionControl(schema: Alternatives, value: Json | undefined, options: Options, form: Form): Control {
	const { constants, open } = alternatives(schema);
	if (open.length === 0) {
		const choices = { type: "enum" as const, choices: constants.map((item) => item.value), default: schema.default };
		const labels = constants.map((item) => item.label);
		const notes = constants.map((item) => item.note);
		return choiceControl({ ...choices, labels, notes }, value, options, form);
	}
	const single = open.length === 1 && constants.length > 0;
	const forms: Alternative[] = [
		...constants.map((item) => ({ label: item.label, constant: item.value })),
		...open.map((choice) => ({ label: formLabel(choice, single), schema: choice })),
	];
	return formsControl(forms, value, options, form);
}
