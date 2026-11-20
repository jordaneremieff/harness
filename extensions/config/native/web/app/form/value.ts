import type { Json, TextSchema, ValueSchema } from "../../../../protocol.ts";

export type Parsed = { value: Json } | { error: string };
export type Enum = Extract<ValueSchema, { type: "enum" }>;
export type List = Extract<ValueSchema, { type: "array" }>;
export type Shape = Extract<ValueSchema, { type: "object" }>;
export type Dictionary = Extract<ValueSchema, { type: "map" }>;
export type Numeric = Extract<ValueSchema, { type: "number" | "integer" }>;
export type Alternatives = Extract<ValueSchema, { type: "union" }>;

export const object = (value: Json | undefined): value is Record<string, Json> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
export const lower = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

export function equal(left: Json, right: Json): boolean {
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
export function repeats(values: Json[]): boolean {
	return values.some((item, index) => values.findIndex((other) => equal(other, item)) < index);
}
function matches(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern, "u").test(value);
	} catch {
		return true;
	}
}
const join = (label: string, part: string) => `${label} › ${part}`;

export function problem(value: Json, schema: ValueSchema, label: string): string | undefined {
	switch (schema.type) {
		case "boolean":
			return typeof value !== "boolean" ? `${label} must be true or false.` : undefined;
		case "string":
			return stringProblem(value, schema, label);
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
			return shapeProblem(value, schema, label);
		case "map":
			return dictionaryProblem(value, schema, label);
		case "union":
			return schema.options.some((choice) => !problem(value, choice, label))
				? undefined
				: `${label} does not match any allowed form.`;
		case "json":
			return;
	}
}
function lengthProblem(length: number, schema: TextSchema, label: string): string | undefined {
	if (schema.minLength !== undefined && length < schema.minLength)
		return length === 0 ? `Enter ${lower(label)}.` : `${label} must contain at least ${schema.minLength} characters.`;
	if (schema.maxLength !== undefined && length > schema.maxLength)
		return `${label} must contain at most ${schema.maxLength} characters.`;
}
export function stringProblem(value: Json, schema: TextSchema, label: string): string | undefined {
	if (typeof value !== "string") return `${label} must be text.`;
	const length = lengthProblem([...value].length, schema, label);
	if (length) return length;
	if (schema.path === "absolute" && !value.startsWith("/")) return `${label} must start with /.`;
	if (schema.pattern !== undefined && !matches(schema.pattern, value))
		return schema.format === "model"
			? `${label} must be a model identity such as provider/model.`
			: `${label} does not have the required form.`;
}
function numberProblem(value: Json, schema: Numeric, label: string): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return `${label} must be a finite number.`;
	if (schema.type === "integer" && !Number.isInteger(value)) return `${label} must be a whole number.`;
	if (schema.minimum !== undefined && value < schema.minimum) return `${label} must be at least ${schema.minimum}.`;
	if (schema.maximum !== undefined && value > schema.maximum) return `${label} must be at most ${schema.maximum}.`;
}
function countProblem(count: number, schema: List, label: string): string | undefined {
	if (schema.minItems !== undefined && count < schema.minItems)
		return `${label} must contain at least ${schema.minItems} items.`;
	if (schema.maxItems !== undefined && count > schema.maxItems)
		return `${label} must contain at most ${schema.maxItems} items.`;
}
function arrayProblem(value: Json, schema: List, label: string): string | undefined {
	if (!Array.isArray(value)) return `${label} must be an array.`;
	const count = countProblem(value.length, schema, label);
	if (count) return count;
	if (schema.unique && repeats(value)) return `${label} lists the same item twice.`;
	for (const [index, item] of value.entries()) {
		const issue = problem(item, schema.items, join(label, `item ${index + 1}`));
		if (issue) return issue;
	}
}
function shapeProblem(value: Json, schema: Shape, label: string): string | undefined {
	if (!object(value)) return `${label} must be an object.`;
	const missing = schema.required?.find((key) => !Object.hasOwn(value, key));
	if (missing !== undefined) return `${label} requires ${JSON.stringify(missing)}.`;
	for (const [key, item] of Object.entries(value)) {
		const child = ownProperty(schema.properties, key);
		if (!child && !schema.additional) return `${label} does not allow ${JSON.stringify(key)}.`;
		const issue = child && problem(item, child, join(label, child.label ?? key));
		if (issue) return issue;
	}
}
function keyProblem(key: string, schema: Dictionary, label: string): string | undefined {
	if (key === "") return `${label} has an entry without a name.`;
	const keys = schema.keys;
	if (!keys) return;
	const issue = stringProblem(key, keys, keys.label ?? "The name");
	return issue && `${label}: ${JSON.stringify(key.slice(0, 80))} is not an allowed name. ${issue}`;
}
function dictionaryProblem(value: Json, schema: Dictionary, label: string): string | undefined {
	if (!object(value)) return `${label} must be an object.`;
	const entries = Object.entries(value);
	if (schema.maxEntries !== undefined && entries.length > schema.maxEntries)
		return `${label} must contain at most ${schema.maxEntries} entries.`;
	for (const [key, item] of entries) {
		const issue = keyProblem(key, schema, label) ?? problem(item, schema.values, join(label, key));
		if (issue) return issue;
	}
}
export function ownProperty(properties: Record<string, ValueSchema>, key: string): ValueSchema | undefined {
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
		case "string":
			return schema.path === "absolute" ? "/" : "";
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
function initialNumber(schema: Numeric): number {
	const floor = schema.minimum ?? Number.NEGATIVE_INFINITY;
	const ceiling = schema.maximum ?? Number.POSITIVE_INFINITY;
	const value = Math.max(
		schema.type === "integer" ? Math.ceil(floor) : floor,
		Math.min(0, schema.type === "integer" ? Math.floor(ceiling) : ceiling),
	);
	return Number.isFinite(value) ? value : 0;
}
