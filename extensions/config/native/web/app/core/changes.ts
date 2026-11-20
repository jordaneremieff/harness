import type { Json, ValueSchema } from "../../../../protocol.ts";
import { display } from "./state.ts";

const LIMIT = 12;
type Node = ValueSchema | undefined;
const object = (value: Json | undefined): value is Record<string, Json> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function same(left: Json, right: Json): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
/** The schema of one member: a declared property, or the value schema of a map. */
function member(schema: Node, key: string): Node {
	if (schema?.type === "object") return Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
	if (schema?.type === "map") return schema.values;
}
/** The label of one member: a declared property's label, or the key of a map entry. */
function memberLabel(schema: Node, key: string): string {
	return schema?.type === "object" && Object.hasOwn(schema.properties, key)
		? (schema.properties[key].label ?? key)
		: key;
}
/** One value in a line of the summary: a choice's label, or the value itself shortened to one line. */
function show(value: Json, schema: Node): string {
	if (schema?.type === "enum") {
		const index = schema.choices.findIndex((choice) => same(choice, value));
		const label = index < 0 ? undefined : schema.labels?.[index];
		if (label) return label;
	}
	if (typeof value === "boolean") return value ? "On" : "Off";
	const text = display(value).replaceAll("\n", " · ");
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
function listChanges(before: Json[], after: Json[], schema: Node, at: string, lines: string[]): void {
	const items = schema?.type === "array" ? schema.items : undefined;
	const scalar = (value: Json) => value === null || typeof value !== "object";
	if (![...before, ...after].every(scalar)) {
		lines.push(`${at}: changed`);
		return;
	}
	const added = after.filter((item) => !before.some((other) => same(other, item)));
	const removed = before.filter((item) => !after.some((other) => same(other, item)));
	for (const item of added) lines.push(`${at}: added ${show(item, items)}`);
	for (const item of removed) lines.push(`${at}: removed ${show(item, items)}`);
	if (!added.length && !removed.length) lines.push(`${at}: new order`);
}
function objectChanges(
	before: Record<string, Json>,
	after: Record<string, Json>,
	schema: Node,
	at: string,
	lines: string[],
): void {
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const label = memberLabel(schema, key);
		walk(before[key], after[key], member(schema, key), at ? `${at} › ${label}` : label, lines);
	}
}
/** A new structure lists its parts, so that a review shows what it holds. */
function added(after: Json | undefined, schema: Node, at: string, lines: string[]): void {
	const name = at || "Value";
	if (object(after) && Object.keys(after).length) objectChanges({}, after, schema, at, lines);
	else if (after === undefined || object(after)) lines.push(`${name}: added`);
	else lines.push(`${name}: added ${show(after, schema)}`);
}
function walk(before: Json | undefined, after: Json | undefined, schema: Node, at: string, lines: string[]): void {
	const name = at || "Value";
	if (before === undefined) {
		added(after, schema, at, lines);
		return;
	}
	if (after === undefined) {
		lines.push(`${name}: removed`);
		return;
	}
	if (same(before, after)) return;
	if (object(before) && object(after)) objectChanges(before, after, schema, at, lines);
	else if (Array.isArray(before) && Array.isArray(after)) listChanges(before, after, schema, name, lines);
	else lines.push(`${name}: ${show(before, schema)} → ${show(after, schema)}`);
}
/**
 * The changes from a saved structured value to a draft, one line per changed part, for review before a save.
 * Returns no lines when either side is not structured, so the caller shows the whole value instead.
 */
export function describeChanges(before: Json | undefined, after: Json, schema?: ValueSchema): string[] {
	const structured = (value: Json | undefined) => object(value) || Array.isArray(value);
	if (!structured(before) || !structured(after)) return [];
	const lines: string[] = [];
	walk(before, after, schema, "", lines);
	return lines.length > LIMIT ? [...lines.slice(0, LIMIT - 1), `${lines.length - LIMIT + 1} more changes`] : lines;
}
