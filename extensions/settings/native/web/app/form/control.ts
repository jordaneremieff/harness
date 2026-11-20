import type { Json, ValueSchema } from "../../../../protocol.ts";
import { display } from "../core/state.ts";
import { button, el, option } from "../ui/dom.ts";

type Parsed = { value: Json } | { error: string };
const object = (value: Json): value is Record<string, Json> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function equal(left: Json, right: Json): boolean {
	if (left === right) return true;
	if (Array.isArray(left))
		return Array.isArray(right) && left.length === right.length && left.every((item, i) => equal(item, right[i]));
	return (
		object(left) &&
		object(right) &&
		Object.keys(left).length === Object.keys(right).length &&
		Object.entries(left).every(([key, val]) => Object.hasOwn(right, key) && equal(val, right[key]))
	);
}

function problem(value: Json, schema: ValueSchema, label: string): string | undefined {
	switch (schema.type) {
		case "boolean":
			return typeof value !== "boolean" ? `${label} must be true or false.` : undefined;
		case "string": {
			return stringProblem(value, schema, label);
		}
		case "number":
		case "integer":
			return numberProblem(value, schema, label);
		case "enum":
			return schema.choices.some((choice) => equal(choice, value))
				? undefined
				: `${label} must be one of the listed choices.`;
		case "array":
			return arrayProblem(value, schema, label);
		case "object":
		case "map":
			return recordProblem(value, schema, label);
		case "union":
			return schema.options.some((choice) => !problem(value, choice, label))
				? undefined
				: `${label} does not match any allowed type.`;
		case "json":
			return;
	}
}

function stringProblem(
	value: Json,
	schema: Extract<ValueSchema, { type: "string" }>,
	label: string,
): string | undefined {
	if (typeof value !== "string") return `${label} must be text.`;
	const length = [...value].length;
	if (schema.minLength !== undefined && length < schema.minLength)
		return `${label} must contain at least ${schema.minLength} characters.`;
	if (schema.maxLength !== undefined && length > schema.maxLength)
		return `${label} must contain at most ${schema.maxLength} characters.`;
	if (schema.path === "absolute" && !value.startsWith("/")) return `${label} must start with /.`;
	return;
}

function numberProblem(
	value: Json,
	schema: Extract<ValueSchema, { type: "number" | "integer" }>,
	label: string,
): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return `${label} must be a finite number.`;
	if (schema.type === "integer" && !Number.isInteger(value)) return `${label} must be a whole number.`;
	if (schema.minimum !== undefined && value < schema.minimum) return `${label} must be at least ${schema.minimum}.`;
	if (schema.maximum !== undefined && value > schema.maximum) return `${label} must be at most ${schema.maximum}.`;
	return;
}

function arrayProblem(value: Json, schema: Extract<ValueSchema, { type: "array" }>, label: string): string | undefined {
	if (!Array.isArray(value)) return `${label} must be an array.`;
	if (schema.minItems !== undefined && value.length < schema.minItems)
		return `${label} must contain at least ${schema.minItems} items.`;
	for (const [index, item] of value.entries()) {
		const issue = problem(item, schema.items, `${label}, item ${index + 1}`);
		if (issue) return issue;
	}
	return;
}

function recordProblem(
	value: Json,
	schema: Extract<ValueSchema, { type: "object" | "map" }>,
	label: string,
): string | undefined {
	if (!object(value)) return `${label} must be an object.`;
	if (schema.type === "object") {
		const missing = schema.required?.find((key) => !Object.hasOwn(value, key));
		if (missing !== undefined) return `${label} requires ${JSON.stringify(missing)}.`;
	}
	for (const [key, item] of Object.entries(value)) {
		const child = schema.type === "map" ? schema.values : ownProperty(schema.properties, key);
		if (!child && schema.type === "object" && !schema.additional)
			return `${label} does not allow ${JSON.stringify(key)}.`;
		const issue = child && problem(item, child, `${label}, ${JSON.stringify(key)}`);
		if (issue) return issue;
	}
	return;
}

function ownProperty(properties: Record<string, ValueSchema>, key: string): ValueSchema | undefined {
	return Object.hasOwn(properties, key) ? properties[key] : undefined;
}

function finite(value: Json): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(finite);
	return !object(value) || Object.values(value).every(finite);
}

export function parseValue(raw: string, schema: ValueSchema): Parsed {
	let value: Json;
	try {
		value = JSON.parse(raw) as Json;
	} catch {
		return { error: "Enter a complete JSON value." };
	}
	const error = finite(value) ? problem(value, schema, "Value") : "JSON numbers must be finite.";
	return error ? { error } : { value };
}

export function initialValue(schema: ValueSchema): Json {
	switch (schema.type) {
		case "boolean":
			return false;
		case "string": {
			const prefix = schema.path === "absolute" ? "/" : "";
			return prefix.padEnd(Math.min(schema.minLength ?? 0, 256), "a");
		}
		case "number":
		case "integer":
			return initialNumber(schema);
		case "enum":
			return schema.choices[0] ?? null;
		case "array":
			return Array.from({ length: Math.min(schema.minItems ?? 0, 32) }, () => initialValue(schema.items));
		case "object":
			return Object.fromEntries(
				(schema.required ?? []).flatMap((key) => {
					const child = ownProperty(schema.properties, key);
					return child ? [[key, initialValue(child)]] : [];
				}),
			);
		case "map":
			return {};
		case "union":
			return schema.options[0] ? initialValue(schema.options[0]) : null;
		case "json":
			return null;
	}
}

function initialNumber(schema: Extract<ValueSchema, { type: "number" | "integer" }>): number {
	const lower = schema.minimum ?? Number.NEGATIVE_INFINITY;
	const upper = schema.maximum ?? Number.POSITIVE_INFINITY;
	const value = Math.max(
		schema.type === "integer" ? Math.ceil(lower) : lower,
		Math.min(0, schema.type === "integer" ? Math.floor(upper) : upper),
	);
	return Number.isFinite(value) ? value : 0;
}

type Control = { node: HTMLElement; raw: () => string };
type Notify = () => void;
const json = { type: "json" } as const;

function group(label: string): HTMLFieldSetElement {
	const node = el("fieldset", undefined, "structure");
	node.append(el("legend", label));
	return node;
}

function textControl(
	label: string,
	text: string,
	read: (text: string) => string,
	multiline: boolean,
	notify: Notify,
): Control {
	const node = el("label", label, "field");
	const input = multiline ? el("textarea") : el("input");
	input.value = text;
	input.addEventListener("input", notify);
	node.append(input);
	return { node, raw: () => read(input.value) };
}

function rawControl(schema: ValueSchema, label: string, text: string, notify: Notify): Control {
	const control = textControl(`${label} (JSON)`, text, (value) => value, true, notify);
	if (schema.type === "json" && schema.unsupported?.length)
		control.node.append(el("span", `Not checked here: ${schema.unsupported.join(", ")}.`, "muted"));
	return control;
}

function control(schema: ValueSchema, value: Json, label: string, notify: Notify): Control {
	switch (schema.type) {
		case "boolean":
			if (typeof value === "boolean") return booleanControl(value, label, notify);
			break;
		case "string":
			if (typeof value === "string")
				return textControl(label, value, JSON.stringify, schema.multiline === true || /[\r\n]/.test(value), notify);
			break;
		case "number":
		case "integer":
			if (typeof value === "number") return numberControl(label, String(value), notify);
			break;
		case "enum":
			return enumControl(schema, value, label, notify);
		case "array":
			if (Array.isArray(value)) return listControl(schema.items, value, label, notify);
			break;
		case "object":
		case "map":
			if (object(value)) return recordControl(schema, value, label, notify);
			break;
		case "union":
			if (schema.options.length) return unionControl(schema.options, value, label, notify);
			break;
		case "json":
			break;
	}
	return rawControl(schema, label, JSON.stringify(value, null, 2), notify);
}

function booleanControl(value: boolean, label: string, notify: Notify): Control {
	const node = el("label", undefined, "check");
	const input = el("input");
	input.type = "checkbox";
	input.checked = value;
	input.addEventListener("change", notify);
	node.append(input, label);
	return { node, raw: () => JSON.stringify(input.checked) };
}

function enumControl(
	schema: Extract<ValueSchema, { type: "enum" }>,
	value: Json,
	label: string,
	notify: Notify,
): Control {
	const index = schema.choices.findIndex((choice) => equal(choice, value));
	if (index < 0) return rawControl(schema, label, JSON.stringify(value, null, 2), notify);
	const node = el("label", label, "field");
	const input = el("select");
	for (const [i, choice] of schema.choices.entries())
		input.append(option(String(i), display(choice).replaceAll("\n", " · ")));
	input.selectedIndex = index;
	input.addEventListener("change", notify);
	node.append(input);
	return { node, raw: () => JSON.stringify(schema.choices[input.selectedIndex]) };
}

function numberControl(label: string, text: string, notify: Notify): Control {
	const field = textControl(label, text, (value) => value, false, notify);
	field.node.querySelector("input")?.setAttribute("inputmode", "decimal");
	return field;
}

// An invalid child must not turn into siblings or disappear when composed.
const fragment = (field: Control) => {
	const raw = field.raw();
	return "error" in parseValue(raw, json) ? `(${raw})` : raw;
};

function listControl(schema: ValueSchema, values: Json[], label: string, notify: Notify): Control {
	const node = group(label);
	const rows = el("div");
	const fields: Control[] = [];
	const add = (value: Json) => {
		const row = group("Item");
		const field = control(schema, value, "Value", notify);
		fields.push(field);
		row.append(
			field.node,
			button("Remove item", () => {
				fields.splice(fields.indexOf(field), 1);
				row.remove();
				notify();
			}),
		);
		rows.append(row);
	};
	for (const value of values) add(value);
	node.append(
		rows,
		button("Add item", () => {
			add(initialValue(schema));
			notify();
		}),
	);
	return { node, raw: () => `[${fields.map(fragment).join(", ")}]` };
}

function recordControl(
	schema: Extract<ValueSchema, { type: "map" | "object" }>,
	values: Record<string, Json>,
	label: string,
	notify: Notify,
): Control {
	const node = group(label);
	const rows = el("div");
	const fields = new Map<HTMLElement, { key: () => string; field: Control }>();
	const missing = new Map<string, HTMLButtonElement>();
	const addProperty = (key: string, child: ValueSchema, value: Json) => {
		const required = schema.type === "object" && schema.required?.includes(key);
		const field = control(child, value, key, notify);
		const row = el("div", undefined, "field");
		row.append(field.node);
		fields.set(row, { key: () => key, field });
		if (!required)
			row.append(
				button(`Remove ${key}`, () => {
					fields.delete(row);
					row.remove();
					offerProperty(key, child);
					notify();
				}),
			);
		rows.append(row);
	};
	const offerProperty = (key: string, child: ValueSchema) => {
		const offer = button(`Add ${key}`, () => {
			offer.remove();
			missing.delete(key);
			addProperty(key, child, initialValue(child));
			notify();
		});
		missing.set(key, offer);
		rows.append(offer);
	};
	const addKey = (key: string, value: Json) => {
		const row = group("Entry");
		const name = textControl("Key", key, (text) => text, false, notify);
		const field = control(schema.type === "map" ? schema.values : json, value, "Value", notify);
		fields.set(row, { key: name.raw, field });
		row.append(
			name.node,
			field.node,
			button("Remove entry", () => {
				fields.delete(row);
				row.remove();
				notify();
			}),
		);
		rows.append(row);
	};
	for (const [key, value] of Object.entries(values)) {
		const child = schema.type === "object" && ownProperty(schema.properties, key);
		if (child) addProperty(key, child, value);
		else addKey(key, value);
	}
	if (schema.type === "object")
		for (const [key, child] of Object.entries(schema.properties)) {
			if (!Object.hasOwn(values, key)) offerProperty(key, child);
		}
	node.append(rows);
	if (schema.type === "map" || schema.additional)
		node.append(
			button("Add entry", () => {
				const keys = new Set([...fields.values()].map(({ key }) => key()));
				for (const key of missing.keys()) keys.add(key);
				let key = "newKey";
				for (let suffix = 2; keys.has(key); suffix++) key = `newKey${suffix}`;
				addKey(key, initialValue(schema.type === "map" ? schema.values : json));
				notify();
			}),
		);
	return {
		node,
		raw: () => {
			const keys = new Set<string>();
			return `{${[...fields.values()]
				.map(({ key, field }) => {
					const name = key();
					// Leave duplicate keys invalid instead of letting JSON.parse discard an entry.
					const encoded = keys.has(name) ? `${JSON.stringify(name)} /* Duplicate key */` : JSON.stringify(name);
					keys.add(name);
					return `${encoded}: ${fragment(field)}`;
				})
				.join(", ")}}`;
		},
	};
}

function unionControl(options: ValueSchema[], value: Json, label: string, notify: Notify): Control {
	const node = group(label);
	const type = el("label", "Value type");
	const select = el("select");
	const index = options.findIndex((choice) => !problem(value, choice, label));
	if (index < 0) select.append(option("", "Choose a type"));
	for (const [i, schema] of options.entries()) select.append(option(String(i), `${i + 1}. ${schema.type}`));
	select.value = index < 0 ? "" : String(index);
	type.append(select);
	const fields = el("div");
	let active =
		index < 0
			? rawControl(json, "Value", JSON.stringify(value, null, 2), notify)
			: control(options[index], value, "Value", notify);
	const branches = new Map<number, Control>([[index, active]]);
	fields.append(active.node);
	select.addEventListener("change", () => {
		const choice = select.value === "" ? -1 : Number(select.value);
		active = branches.get(choice) ?? control(options[choice], initialValue(options[choice]), "Value", notify);
		branches.set(choice, active);
		fields.replaceChildren(active.node);
		notify();
	});
	node.append(type, fields);
	return { node, raw: () => active.raw() };
}

function hideCaption(field: HTMLElement): void {
	const caption = field.querySelector(":scope > legend");
	if (caption) caption.classList.add("visually-hidden");
	if (field.tagName !== "LABEL") return;
	for (const child of field.childNodes) {
		if (child.nodeType !== Node.TEXT_NODE) continue;
		child.replaceWith(el("span", child.textContent ?? "", "visually-hidden"));
		break;
	}
}

export function editor(
	schema: ValueSchema,
	seed: Json | undefined,
	raw: string | undefined,
	label: string,
	onChange: (raw: string, error?: string) => void,
	accessibleCaption = false,
): HTMLElement {
	const node = el("div", undefined, "value-editor");
	const status = el("p", undefined, "field-help");
	status.setAttribute("aria-live", "polite");
	const notify = () => {
		const text = field.raw();
		const error = showIssue(text);
		onChange(text, error);
	};
	const showIssue = (text: string) => {
		const parsed = parseValue(text, schema);
		const error = "error" in parsed ? parsed.error : undefined;
		status.textContent = error ?? "";
		status.hidden = !error;
		return error;
	};
	let field: Control;
	if (raw === undefined) field = control(schema, seed === undefined ? initialValue(schema) : seed, label, notify);
	else if (schema.type === "json") field = rawControl(schema, label, raw, notify);
	else if (schema.type === "integer" || schema.type === "number") field = numberControl(label, raw, notify);
	else {
		const parsed = parseValue(raw, json);
		field = "value" in parsed ? control(schema, parsed.value, label, notify) : rawControl(schema, label, raw, notify);
	}
	if (raw === undefined && seed === undefined) status.hidden = true;
	else showIssue(raw ?? field.raw());
	if (accessibleCaption) hideCaption(field.node);
	node.append(field.node, status);
	return node;
}
