import { boundedJson, humanize, isObject, jsonEqual } from "./json.ts";
import type { Json, TextFormat, ValueSchema } from "./protocol.ts";

/** A JSON Schema node as read from Pi's installed schema or from an owner's declaration. */
export type Raw = Record<string, unknown>;

/** Keywords whose meaning Config applies when it builds forms and checks values. */
const HANDLED = new Set([
	"$schema",
	"$id",
	"$comment",
	"$defs",
	"$ref",
	"type",
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"enum",
	"const",
	"anyOf",
	"properties",
	"patternProperties",
	"additionalProperties",
	"propertyNames",
	"required",
	"minProperties",
	"maxProperties",
	"items",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"pattern",
	"format",
]);
const FORMATS: readonly TextFormat[] = ["model", "provider", "path"];
const LABEL_MAX = 120;
const HELP_MAX = 2048;

export function resolveRef(root: Raw, node: Raw, depth = 0): Raw {
	if (typeof node.$ref !== "string" || depth > 8) return node;
	const match = /^#\/\$defs\/(.+)$/.exec(node.$ref);
	const defs = isObject(root.$defs) ? root.$defs : {};
	const target = match ? defs[match[1]] : undefined;
	if (!isObject(target)) return node;
	const { $ref: _ref, ...rest } = node;
	return { ...resolveRef(root, target, depth + 1), ...rest };
}

function childNodes(node: Raw): unknown[] {
	return [
		...(Array.isArray(node.anyOf) ? node.anyOf : []),
		...(isObject(node.properties) ? Object.values(node.properties) : []),
		...(isObject(node.patternProperties) ? Object.values(node.patternProperties) : []),
		...(isObject(node.items) ? [node.items] : []),
		...(isObject(node.additionalProperties) ? [node.additionalProperties] : []),
		...(isObject(node.propertyNames) ? [node.propertyNames] : []),
	];
}

/** Lists keywords anywhere below `node` that Config neither renders nor checks. */
export function unsupportedKeywords(root: Raw, node: Raw, seen = new Set<Raw>()): string[] {
	if (seen.has(node)) return [];
	seen.add(node);
	const found = new Set(Object.keys(node).filter((key) => !HANDLED.has(key)));
	for (const child of childNodes(node))
		if (isObject(child)) for (const key of unsupportedKeywords(root, resolveRef(root, child), seen)) found.add(key);
	return [...found].sort();
}

function text(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return;
	const line = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
	return line ? line.slice(0, max) : undefined;
}
/** The label, help and default that a node's annotations supply. */
function annotations(node: Raw): { label?: string; help?: string; default?: Json } {
	const label = text(node.title, LABEL_MAX);
	const help = text(node.description, HELP_MAX);
	return {
		...(label ? { label } : {}),
		...(help ? { help } : {}),
		...(Object.hasOwn(node, "default") && boundedJson(node.default) ? { default: node.default } : {}),
	};
}
function constants(options: Raw[]): ValueSchema {
	const labels = options.map((option) => text(option.title, LABEL_MAX));
	const notes = options.map((option) => text(option.description, HELP_MAX));
	return {
		type: "enum",
		choices: options.map((option) => option.const as Json),
		...(labels.some(Boolean) ? { labels } : {}),
		...(notes.some(Boolean) ? { notes } : {}),
	};
}
function normalizeAnyOf(root: Raw, options: readonly unknown[]): ValueSchema {
	const resolved = options.filter(isObject).map((option) => resolveRef(root, option));
	const live = resolved.filter((option) => option.deprecated !== true);
	const chosen = live.length ? live : resolved;
	if (chosen.length && chosen.every((option) => Object.hasOwn(option, "const"))) return constants(chosen);
	const normalized = chosen.map((option) => normalize(root, option));
	return normalized.length === 1 ? normalized[0] : { type: "union", options: normalized };
}
/** The key schema of a map: `propertyNames`, else the single key pattern. */
function keySchema(root: Raw, node: Raw, pattern: string | undefined): Extract<ValueSchema, { type: "string" }> {
	const names = isObject(node.propertyNames) ? resolveRef(root, node.propertyNames) : undefined;
	const named = names ? { ...stringSchema(names), ...annotations(names) } : { type: "string" as const };
	return pattern !== undefined && named.pattern === undefined ? { ...named, pattern } : named;
}
/** An object without declared properties is a map: one key pattern, or any name with a value schema. */
function mapShape(root: Raw, node: Raw): ValueSchema | undefined {
	const patterns = isObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
	const maxEntries = typeof node.maxProperties === "number" ? { maxEntries: node.maxProperties } : {};
	const [pattern, values] = patterns.length === 1 ? patterns[0] : [undefined, node.additionalProperties];
	if (patterns.length > 1) return { type: "map", values: { type: "json" }, ...maxEntries };
	if (!isObject(values)) return;
	return { type: "map", values: normalize(root, values), keys: keySchema(root, node, pattern), ...maxEntries };
}
function normalizeObject(root: Raw, node: Raw): ValueSchema {
	const properties = isObject(node.properties) ? Object.entries(node.properties) : [];
	const map = properties.length ? undefined : mapShape(root, node);
	if (map) return map;
	const shaped: Record<string, ValueSchema> = {};
	for (const [key, value] of properties)
		if (isObject(value)) {
			const child = normalize(root, value);
			shaped[key] = child.label ? child : { ...child, label: humanize(key) };
		}
	return {
		type: "object",
		properties: shaped,
		...(Array.isArray(node.required) ? { required: node.required.filter((key) => typeof key === "string") } : {}),
		additional: node.additionalProperties !== false,
	};
}
function stringSchema(node: Raw): Extract<ValueSchema, { type: "string" }> {
	const examples = Array.isArray(node.examples)
		? node.examples.filter((item): item is string => typeof item === "string").slice(0, 32)
		: [];
	return {
		type: "string",
		...(typeof node.minLength === "number" ? { minLength: node.minLength } : {}),
		...(typeof node.maxLength === "number" ? { maxLength: node.maxLength } : {}),
		...(typeof node.pattern === "string" && compiles(node.pattern) ? { pattern: node.pattern } : {}),
		...(FORMATS.includes(node.format as TextFormat) ? { format: node.format as TextFormat } : {}),
		...(examples.length ? { examples } : {}),
		// Long free text gets several lines; identities, paths and patterned text stay on one.
		...(typeof node.maxLength === "number" &&
		node.maxLength > 400 &&
		node.pattern === undefined &&
		node.format === undefined
			? { multiline: true }
			: {}),
	};
}
function scalarSchema(root: Raw, node: Raw): ValueSchema | undefined {
	switch (node.type) {
		case "boolean":
			return { type: "boolean" };
		case "string":
			return stringSchema(node);
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
				items: isObject(node.items) ? normalize(root, node.items) : { type: "json" },
				...(typeof node.minItems === "number" ? { minItems: node.minItems } : {}),
				...(typeof node.maxItems === "number" ? { maxItems: node.maxItems } : {}),
				...(node.uniqueItems === true ? { unique: true } : {}),
			};
	}
}
function shape(root: Raw, node: Raw): ValueSchema {
	if (Array.isArray(node.enum)) return { type: "enum", choices: node.enum as Json[] };
	if (Object.hasOwn(node, "const")) return constants([node]);
	if (Array.isArray(node.anyOf)) return normalizeAnyOf(root, node.anyOf);
	if (node.type === "object") return normalizeObject(root, node);
	const scalar = scalarSchema(root, node);
	if (scalar) return scalar;
	const unsupported = unsupportedKeywords(root, node);
	return unsupported.length ? { type: "json", unsupported } : { type: "json" };
}
/** Builds a form descriptor. Constructs it cannot express become a JSON editor that names them. */
export function normalize(root: Raw, raw: Raw): ValueSchema {
	const node = resolveRef(root, raw);
	return { ...shape(root, node), ...annotations(node) };
}
/** The descriptor of a whole setting: its row already shows its own label, description and default. */
export function settingShape(root: Raw, raw: Raw): ValueSchema {
	const { label: _label, help: _help, default: _default, ...rest } = normalize(root, raw);
	return rest as ValueSchema;
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
	const length = [...value].length;
	if (typeof node.minLength === "number" && length < node.minLength)
		problems.push(`${at} must have at least ${node.minLength} characters.`);
	if (typeof node.maxLength === "number" && length > node.maxLength)
		problems.push(`${at} must have at most ${node.maxLength} characters.`);
	if (typeof node.pattern === "string" && !safeTest(node.pattern, value))
		problems.push(`${at} does not have the required form.`);
}
function arrayProblems(root: Raw, node: Raw, value: unknown[], at: string, problems: string[]): void {
	if (typeof node.minItems === "number" && value.length < node.minItems)
		problems.push(`${at} must have at least ${node.minItems} items.`);
	if (typeof node.maxItems === "number" && value.length > node.maxItems)
		problems.push(`${at} must have at most ${node.maxItems} items.`);
	if (
		node.uniqueItems === true &&
		value.some((item, index) => value.findIndex((other) => jsonEqual(other, item)) < index)
	)
		problems.push(`${at} must not repeat an item.`);
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
function memberCountProblems(node: Raw, value: Record<string, unknown>, at: string, problems: string[]): void {
	const count = Object.keys(value).length;
	if (typeof node.minProperties === "number" && count < node.minProperties)
		problems.push(`${at} must have at least ${node.minProperties} entries.`);
	if (typeof node.maxProperties === "number" && count > node.maxProperties)
		problems.push(`${at} must have at most ${node.maxProperties} entries.`);
	if (Array.isArray(node.required))
		for (const key of node.required)
			if (typeof key === "string" && !Object.hasOwn(value, key)) problems.push(`${at}.${key} is required.`);
}
function objectProblems(root: Raw, node: Raw, value: Record<string, unknown>, at: string, problems: string[]): void {
	const properties = isObject(node.properties) ? node.properties : {};
	memberCountProblems(node, value, at, problems);
	const names = isObject(node.propertyNames) ? node.propertyNames : undefined;
	for (const [key, item] of Object.entries(value)) {
		if (names && validateValue(root, names, key, at).length)
			problems.push(`${at} has a name that is not allowed: ${JSON.stringify(key.slice(0, 80))}.`);
		const property = properties[key];
		if (isObject(property)) {
			problems.push(...validateValue(root, property, item, `${at}.${key}`));
			continue;
		}
		looseMemberProblems(root, node, key, item, at, problems);
	}
}
/** Checks a value against a schema node. Returns problems in plain words. */
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
function compiles(source: string): boolean {
	try {
		new RegExp(source, "u");
		return true;
	} catch {
		return false;
	}
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
		if (isObject(node.additionalProperties)) {
			node = node.additionalProperties;
			continue;
		}
		return undefined;
	}
	return resolveRef(root, node);
}
