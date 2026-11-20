import type { EntryGroup, Json, Saved } from "./protocol.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!isObject(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
export function printable(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.length <= max && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}

/** Checks the JSON bounds of the extension configuration contract. */
export function boundedJson(input: unknown, maxBytes = 131072): input is Json {
	let nodes = 0;
	const visit = (value: unknown, depth: number): boolean => {
		if (++nodes > 10000 || depth > 32) return false;
		if (value === null || typeof value === "boolean") return true;
		if (typeof value === "number") return Number.isFinite(value);
		if (typeof value === "string") return value.length <= 131072 && !/[\u0000\ud800-\udfff]/u.test(value);
		if (Array.isArray(value)) return value.every((item) => visit(item, depth + 1));
		if (!isPlainObject(value)) return false;
		return Object.entries(value).every(([key, item]) => printable(key) && visit(item, depth + 1));
	};
	try {
		return visit(input, 0) && Buffer.byteLength(JSON.stringify(input)) <= maxBytes;
	} catch {
		return false;
	}
}

export function jsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left))
		return Array.isArray(right) && left.length === right.length && left.every((item, i) => jsonEqual(item, right[i]));
	if (isObject(left) && isObject(right)) {
		const keys = Object.keys(left);
		if (keys.length !== Object.keys(right).length) return false;
		return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
	}
	return false;
}
export function savedEqual(left: Saved, right: Saved): boolean {
	return left.present === right.present && (!left.present || jsonEqual(left.value, (right as { value: Json }).value));
}

/** RFC 6901 escaping, so dots, slashes and nested paths never collapse into one another. */
export function pointer(path: readonly string[]): string {
	return path.map((segment) => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}
export function parsePointer(text: string): string[] {
	if (text === "") return [];
	if (!text.startsWith("/")) throw new Error("A JSON pointer starts with /.");
	return text
		.slice(1)
		.split("/")
		.map((segment) => {
			if (/~[^01]|~$/.test(segment)) throw new Error("A JSON pointer escapes ~ as ~0 and / as ~1.");
			return segment.replace(/~1/g, "/").replace(/~0/g, "~");
		});
}
export function entryId(group: EntryGroup, path: readonly string[]): string {
	return `${group}:${pointer(path)}`;
}
export function parseEntryId(id: string): { group: EntryGroup; path: string[] } {
	const match = /^(pi|harness|custom):(\/.*)$/su.exec(id);
	if (!match || !printable(id, 8192)) throw new Error(`Unknown setting id ${JSON.stringify(id.slice(0, 200))}.`);
	const path = parsePointer(match[2]);
	if (!path.length || path.some((segment) => !segment.length))
		throw new Error(`Setting id ${JSON.stringify(id.slice(0, 200))} has an empty path segment.`);
	return { group: match[1] as EntryGroup, path };
}

export function getAt(root: unknown, path: readonly string[]): Saved {
	let current: unknown = root;
	for (const segment of path) {
		if (!isObject(current) || !Object.hasOwn(current, segment)) return { present: false };
		current = current[segment];
	}
	return { present: true, value: current as Json };
}
/** Sets a value, creating missing parent objects. Refuses to replace a non-object parent. */
export function setAt(root: Record<string, unknown>, path: readonly string[], value: Json): void {
	let current: Record<string, unknown> = root;
	for (const segment of path.slice(0, -1)) {
		if (!Object.hasOwn(current, segment)) current[segment] = {};
		const next = current[segment];
		if (!isObject(next)) throw new Error(`${pointer(path)} cannot be stored because a parent value is not an object.`);
		current = next;
	}
	current[path[path.length - 1]] = structuredClone(value);
}
export function unsetAt(root: Record<string, unknown>, path: readonly string[]): boolean {
	let current: unknown = root;
	for (const segment of path.slice(0, -1)) {
		if (!isObject(current) || !Object.hasOwn(current, segment)) return false;
		current = current[segment];
	}
	const last = path[path.length - 1];
	if (!isObject(current) || !Object.hasOwn(current, last)) return false;
	delete current[last];
	return true;
}

export function humanize(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : key;
}

export function preview(value: unknown, max = 120): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "undefined";
	} catch {
		text = String(value);
	}
	text = text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
