import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAt, humanize, isObject, jsonEqual } from "./json.ts";
import type { Json, ValueSchema } from "./protocol.ts";

/** Keywords whose meaning Config applies when it builds forms and checks values. */
const HANDLED = new Set([
	"$schema",
	"$id",
	"$comment",
	"$defs",
	"$ref",
	"type",
	"description",
	"default",
	"deprecated",
	"enum",
	"const",
	"anyOf",
	"properties",
	"patternProperties",
	"additionalProperties",
	"required",
	"items",
	"minItems",
	"maxItems",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"title",
]);
type Raw = Record<string, unknown>;

export type DocRow = { section: string; type: string; defaultText: string; description: string };
export type PiLeaf = {
	path: string[];
	schema: Raw;
	value: ValueSchema;
	description: string;
	deprecated: boolean;
	documented: boolean;
	category: string;
	globalOnly: boolean;
	/** Lists that Pi's resource loader combines from both files. */
	combined: boolean;
	default?: { value?: Json; text?: string };
};
export type PiSchema = {
	digest: string;
	path: string;
	docs: { path: string; available: boolean };
	root: Raw;
	leaves: PiLeaf[];
	/** Paths of schema objects whose own keys are known, for unregistered-key discovery. */
	objects: string[][];
	problems: string[];
};

const cache = new Map<string, PiSchema>();

/** Reads the schema and settings reference that belong to the selected Pi installation. */
export function loadPiSchema(packageDir: string): PiSchema {
	const schemaPath = join(packageDir, "schemas", "settings.schema.json");
	const docsPath = join(packageDir, "docs", "settings.md");
	const schemaText = readFileSync(schemaPath, "utf8");
	let docsText = "";
	try {
		docsText = readFileSync(docsPath, "utf8");
	} catch {}
	const digest = createHash("sha256").update(schemaText).update("\0").update(docsText).digest("hex");
	const key = `${schemaPath}\0${digest}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const root: unknown = JSON.parse(schemaText);
	if (!isObject(root) || !isObject(root.properties)) throw new Error(`${schemaPath} is not an object schema.`);
	const rows = parseReference(docsText);
	const problems: string[] = [];
	const leaves: PiLeaf[] = [];
	const objects: string[][] = [[]];
	const visit = (path: string[], raw: Raw, inheritedSection?: string) => {
		const node = resolveRef(root, raw);
		const dotted = path.join(".");
		const row = rows.get(dotted);
		const section = row?.section ?? inheritedSection;
		if (node.type === "object" && isObject(node.properties) && !isObject(node.patternProperties)) {
			objects.push(path);
			for (const [child, value] of Object.entries(node.properties))
				if (isObject(value)) visit([...path, child], value, section ?? humanize(path[0]));
			return;
		}
		const unsupported = unsupportedKeywords(root, node);
		if (unsupported.length)
			problems.push(`${dotted} uses schema keywords ${unsupported.join(", ")} that Config does not check.`);
		leaves.push(leafOf(root, path, raw, node, row, section));
	};
	for (const [key, value] of Object.entries(root.properties)) if (isObject(value)) visit([key], value);
	const result: PiSchema = {
		digest,
		path: schemaPath,
		docs: { path: docsPath, available: rows.size > 0 },
		root,
		leaves,
		objects,
		problems,
	};
	cache.clear();
	cache.set(key, result);
	return result;
}

/** Reads the leaf's default from the schema node or the settings reference's text. */
function leafDefault(node: Raw, row: DocRow | undefined): PiLeaf["default"] {
	if (Object.hasOwn(node, "default")) return { value: node.default as Json };
	if (row?.defaultText && row.defaultText !== "None") return { text: row.defaultText };
}
/** True when the reference marks the setting as readable only from agent-directory settings. */
function globalOnlySetting(description: string, row: DocRow | undefined): boolean {
	return (
		/\bglobal(?: setting)? only\b/i.test(description) ||
		/can only be set in agent-directory settings/i.test(row?.description ?? "")
	);
}
/** Builds one declared leaf from its schema node and its settings-reference row. */
function leafOf(
	root: Raw,
	path: string[],
	raw: Raw,
	node: Raw,
	row: DocRow | undefined,
	section: string | undefined,
): PiLeaf {
	const description = (typeof node.description === "string" ? node.description : "") || row?.description || "";
	return {
		path,
		schema: node,
		value: normalize(root, node),
		description,
		deprecated: node.deprecated === true || (isObject(raw) && raw.deprecated === true),
		documented: row !== undefined,
		category: section ?? (path.length > 1 ? humanize(path[0]) : "Other"),
		globalOnly: globalOnlySetting(description, row),
		combined: section === "Resources" && node.type === "array",
		default: leafDefault(node, row),
	};
}

/** Reads the installed settings reference: section headings and `| \`key\` | type | default | description |` rows. */
export function parseReference(text: string): Map<string, DocRow> {
	const rows = new Map<string, DocRow>();
	let section = "";
	for (const line of text.split("\n")) {
		const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
		if (heading) {
			section = heading[1].trim();
			continue;
		}
		const row = /^\|\s*`([A-Za-z0-9_.$-]+)`\s*\|(.*)\|\s*$/.exec(line);
		if (!row || !section) continue;
		const cells = splitCells(row[2]);
		if (cells.length < 3) continue;
		rows.set(row[1], {
			section,
			type: cleanCell(cells[0]),
			defaultText: cleanCell(cells[1]),
			description: cleanCell(cells.slice(2).join(" | ")),
		});
	}
	return rows;
}
function splitCells(text: string): string[] {
	const cells: string[] = [];
	let current = "";
	let code = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\\" && text[i + 1] === "|") {
			current += "|";
			i++;
		} else if (char === "`") {
			code = !code;
			current += char;
		} else if (char === "|" && !code) {
			cells.push(current);
			current = "";
		} else current += char;
	}
	cells.push(current);
	return cells.map((cell) => cell.trim());
}
function cleanCell(text: string): string {
	return text
		.replace(/\*\*/g, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.trim();
}

export function resolveRef(root: Raw, node: Raw, depth = 0): Raw {
	if (typeof node.$ref !== "string" || depth > 8) return node;
	const match = /^#\/\$defs\/(.+)$/.exec(node.$ref);
	const defs = isObject(root.$defs) ? root.$defs : {};
	const target = match ? defs[match[1]] : undefined;
	if (!isObject(target)) return node;
	const { $ref: _ref, ...rest } = node;
	return { ...resolveRef(root, target, depth + 1), ...rest };
}
function unsupportedKeywords(root: Raw, node: Raw, seen = new Set<Raw>()): string[] {
	if (seen.has(node)) return [];
	seen.add(node);
	const found = new Set(Object.keys(node).filter((key) => !HANDLED.has(key)));
	const children: unknown[] = [
		...(Array.isArray(node.anyOf) ? node.anyOf : []),
		...(isObject(node.properties) ? Object.values(node.properties) : []),
		...(isObject(node.patternProperties) ? Object.values(node.patternProperties) : []),
		...(isObject(node.items) ? [node.items] : []),
		...(isObject(node.additionalProperties) ? [node.additionalProperties] : []),
	];
	for (const child of children)
		if (isObject(child)) for (const key of unsupportedKeywords(root, resolveRef(root, child), seen)) found.add(key);
	return [...found].sort();
}

function normalizeAnyOf(root: Raw, options: readonly unknown[]): ValueSchema {
	const resolved = options.filter(isObject).map((option) => resolveRef(root, option));
	const live = resolved.filter((option) => option.deprecated !== true);
	const chosen = live.length ? live : resolved;
	if (chosen.every((option) => Object.hasOwn(option, "const")))
		return { type: "enum", choices: chosen.map((option) => option.const as Json) };
	const normalized = chosen.map((option) => normalize(root, option));
	return normalized.length === 1 ? normalized[0] : { type: "union", options: normalized };
}
function normalizeObject(root: Raw, node: Raw): ValueSchema {
	if (isObject(node.patternProperties)) {
		const values = Object.values(node.patternProperties).filter(isObject);
		return { type: "map", values: values.length === 1 ? normalize(root, values[0]) : { type: "json" } };
	}
	const properties: Record<string, ValueSchema> = {};
	if (isObject(node.properties))
		for (const [key, value] of Object.entries(node.properties))
			if (isObject(value)) properties[key] = normalize(root, value);
	return {
		type: "object",
		properties,
		...(Array.isArray(node.required) ? { required: node.required.filter((key) => typeof key === "string") } : {}),
		additional: node.additionalProperties !== false,
	};
}
function scalarSchema(node: Raw): ValueSchema | undefined {
	switch (node.type) {
		case "boolean":
			return { type: "boolean" };
		case "string":
			return {
				type: "string",
				...(typeof node.minLength === "number" ? { minLength: node.minLength } : {}),
				...(typeof node.maxLength === "number" ? { maxLength: node.maxLength } : {}),
			};
		case "number":
		case "integer":
			return {
				type: node.type,
				...(typeof node.minimum === "number" ? { minimum: node.minimum } : {}),
				...(typeof node.maximum === "number" ? { maximum: node.maximum } : {}),
			};
		case "array":
			return {
				type: "array",
				items: isObject(node.items) ? normalize(node as Raw, node.items) : { type: "json" },
				...(typeof node.minItems === "number" ? { minItems: node.minItems } : {}),
			};
	}
}
/** Builds a form descriptor. Constructs it cannot express become a JSON editor that names them. */
export function normalize(root: Raw, raw: Raw): ValueSchema {
	const node = resolveRef(root, raw);
	if (Array.isArray(node.enum)) return { type: "enum", choices: node.enum as Json[] };
	if (Object.hasOwn(node, "const")) return { type: "enum", choices: [node.const as Json] };
	if (Array.isArray(node.anyOf)) return normalizeAnyOf(root, node.anyOf);
	if (node.type === "object") return normalizeObject(root, node);
	const scalar = scalarSchema(node);
	if (scalar) return scalar;
	const unsupported = unsupportedKeywords(root, node);
	return unsupported.length ? { type: "json", unsupported } : { type: "json" };
}

/** Reports an anyOf failure, naming the allowed constants when every option is one. */
function anyOfProblems(root: Raw, options: readonly unknown[], value: unknown, at: string, problems: string[]): void {
	const declared = options.filter(isObject);
	if (declared.some((option) => validateValue(root, option, value, at).length === 0)) return;
	const consts = declared.map((option) => resolveRef(root, option)).filter((option) => Object.hasOwn(option, "const"));
	problems.push(
		consts.length === declared.length
			? `${at} must be one of ${consts.map((option) => JSON.stringify(option.const)).join(", ")}.`
			: `${at} does not match any allowed form.`,
	);
}
function numericProblems(node: Raw, value: number, at: string, problems: string[]): void {
	if (typeof node.minimum === "number" && value < node.minimum)
		problems.push(`${at} must be at least ${node.minimum}.`);
	if (typeof node.maximum === "number" && value > node.maximum) problems.push(`${at} must be at most ${node.maximum}.`);
}
function textualProblems(node: Raw, value: string, at: string, problems: string[]): void {
	if (typeof node.minLength === "number" && value.length < node.minLength)
		problems.push(`${at} must have at least ${node.minLength} characters.`);
	if (typeof node.maxLength === "number" && value.length > node.maxLength)
		problems.push(`${at} must have at most ${node.maxLength} characters.`);
}
function arrayProblems(root: Raw, node: Raw, value: unknown[], at: string, problems: string[]): void {
	if (typeof node.minItems === "number" && value.length < node.minItems)
		problems.push(`${at} must have at least ${node.minItems} items.`);
	if (typeof node.maxItems === "number" && value.length > node.maxItems)
		problems.push(`${at} must have at most ${node.maxItems} items.`);
	if (isObject(node.items))
		value.forEach((item, index) => {
			problems.push(...validateValue(root, node.items as Raw, item, `${at}[${index}]`));
		});
}
/** Checks one object member that no declared property covers. */
function looseMemberProblems(root: Raw, node: Raw, key: string, item: unknown, at: string, problems: string[]): void {
	const pattern = isObject(node.patternProperties)
		? Object.entries(node.patternProperties).find(([source]) => safeTest(source, key))
		: undefined;
	if (pattern && isObject(pattern[1])) problems.push(...validateValue(root, pattern[1], item, `${at}.${key}`));
	else if (node.additionalProperties === false) problems.push(`${at}.${key} is not allowed.`);
	else if (isObject(node.additionalProperties))
		problems.push(...validateValue(root, node.additionalProperties, item, `${at}.${key}`));
}
function objectProblems(root: Raw, node: Raw, value: Record<string, unknown>, at: string, problems: string[]): void {
	const properties = isObject(node.properties) ? node.properties : {};
	if (Array.isArray(node.required))
		for (const key of node.required)
			if (typeof key === "string" && !Object.hasOwn(value, key)) problems.push(`${at}.${key} is required.`);
	for (const [key, item] of Object.entries(value)) {
		const property = properties[key];
		if (isObject(property)) {
			problems.push(...validateValue(root, property, item, `${at}.${key}`));
			continue;
		}
		looseMemberProblems(root, node, key, item, at, problems);
	}
}
/** Checks a value against the installed schema node. Returns problems in plain words. */
export function validateValue(root: Raw, raw: Raw, value: unknown, at: string): string[] {
	const node = resolveRef(root, raw);
	const problems: string[] = [];
	if (Array.isArray(node.enum) && !node.enum.some((choice) => jsonEqual(choice, value)))
		problems.push(`${at} must be one of ${node.enum.map((choice) => JSON.stringify(choice)).join(", ")}.`);
	if (Object.hasOwn(node, "const") && !jsonEqual(node.const, value))
		problems.push(`${at} must be ${JSON.stringify(node.const)}.`);
	if (Array.isArray(node.anyOf)) anyOfProblems(root, node.anyOf, value, at, problems);
	if (typeof node.type === "string" && !typeMatches(node.type, value)) {
		problems.push(`${at} must be ${article(node.type)}.`);
		return problems;
	}
	if (typeof value === "number") numericProblems(node, value, at, problems);
	if (typeof value === "string") textualProblems(node, value, at, problems);
	if (Array.isArray(value)) arrayProblems(root, node, value, at, problems);
	if (isObject(value)) objectProblems(root, node, value, at, problems);
	return problems.slice(0, 20);
}
function safeTest(source: string, key: string): boolean {
	try {
		return new RegExp(source, "u").test(key);
	} catch {
		return false;
	}
}
function typeMatches(type: string, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isSafeInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return isObject(value);
		case "null":
			return value === null;
		default:
			return true;
	}
}
function article(type: string): string {
	return type === "integer" || type === "object" || type === "array" ? `an ${type}` : `a ${type}`;
}

/** Finds the schema node for a path below a top-level property, through objects and maps. */
export function schemaAt(root: Raw, path: readonly string[]): Raw | undefined {
	let node: Raw = root;
	for (const segment of path) {
		node = resolveRef(root, node);
		const properties = isObject(node.properties) ? node.properties : undefined;
		if (properties && isObject(properties[segment])) {
			node = properties[segment] as Raw;
			continue;
		}
		const patterns = isObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
		const match = patterns.find(([source]) => safeTest(source, segment));
		if (match && isObject(match[1])) {
			node = match[1];
			continue;
		}
		return undefined;
	}
	return resolveRef(root, node);
}

export function savedAt(document: Record<string, unknown> | undefined, path: readonly string[]) {
	return document ? getAt(document, path) : ({ present: false } as const);
}
