import { isAbsolute } from "node:path";
import { types } from "node:util";

const VALUE_MAX_BYTES = 131072;
const VALUE_MAX_DEPTH = 32;
const VALUE_MAX_NODES = 10000;
const SCHEMA_MAX_BYTES = 32768;
export const PUBLICATION_MAX_BYTES = 262144;
export const SETTINGS_MAX_FIELDS = 128;
export const SETTINGS_MAX_SLICES = 64;
export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Origin = "env" | "file" | "default";
export type SettingType = "string" | "path" | "integer" | "number" | "boolean" | "enum" | "json";

const settingTypes = ["string", "path", "integer", "number", "boolean", "enum", "json"] as const;
export const applicationTimings = ["use", "reload", "restart"] as const;
const numericBounds = ["min", "max"] as const;
const textBounds = ["minLength", "maxLength"] as const;
const fieldKeys = [
	"type",
	"env",
	"description",
	"apply",
	"default",
	"defaultText",
	"secret",
	"absolute",
	...numericBounds,
	...textBounds,
	"choices",
	"schema",
];

export type SettingConstraints = {
	absolute?: boolean;
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	choices?: string[];
};
export type SettingField = SettingConstraints & {
	type: SettingType;
	env: string;
	description: string;
	apply: (typeof applicationTimings)[number];
	default?: Json;
	defaultText?: string;
	secret?: boolean;
	schema?: Record<string, Json>;
};
export type Declaration = { slice: string; fields: Record<string, SettingField> };

function plainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function enumerableData(input: object, key: PropertyKey): PropertyDescriptor | undefined {
	const property = Object.getOwnPropertyDescriptor(input, key);
	if (property && (!property.enumerable || !Object.hasOwn(property, "value"))) {
		throw new Error("Expected enumerable plain data");
	}
	return property;
}
function projection(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!plainObject(input)) throw new Error("Expected plain object");
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = enumerableData(input, key);
		if (descriptor) result[key] = descriptor.value;
	}
	return result;
}
function boundedArray<T>(input: unknown, max: number, parse: (item: unknown, index: number) => T): T[] {
	if (
		types.isProxy(input) ||
		!Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Array.prototype ||
		input.length > max ||
		Reflect.ownKeys(input).length !== input.length + 1
	) {
		throw new Error("Expected bounded plain array");
	}
	return Array.from({ length: input.length }, (_, index) => {
		const element = enumerableData(input, index);
		if (!element) throw new Error("Expected dense array");
		return parse(element.value, index);
	});
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-zA-Z0-9]*$/.test(value) && value.length <= 64;
}
export type Diagnostic = {
	field: string;
	source: Origin;
	code: "document" | "unknown" | "secret" | "invalid" | "coverage" | "relation";
	message: string;
};
export type Source = {
	path: string;
	status: "loaded" | "missing" | "invalid" | "unavailable";
	digest: string | null;
	observedAt: string;
};
export type SettingRecord = {
	name: string;
	key: string;
	type: SettingType;
	description: string;
	env: string;
	secret: boolean;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	value?: Json;
	secretState?: "set" | "unset";
};
export type SettingsPublication = {
	version: 2;
	slice: string;
	declaration: Declaration;
	source: Source;
	records: SettingRecord[];
	diagnostics: Diagnostic[];
};
function diagnostic(field: string, source: Origin, code: Diagnostic["code"]): Diagnostic {
	const messages = {
		document: "Configuration document is invalid or unavailable.",
		unknown: "Unknown setting in this section.",
		secret: "Secret settings are environment-only; document input was rejected.",
		invalid: "Selected input is invalid; the safe default is in effect.",
		coverage: "Additional diagnostics were omitted at the diagnostic limit.",
		relation: "Effective settings violate an owning cross-field constraint; values are unchanged.",
	};
	return { field, source, code, message: messages[code] };
}
// Charge bytes before retaining each copied node. No publisher getters or serializers run.
function copyJson(
	value: unknown,
	maxBytes: number,
	{ maxDepth = VALUE_MAX_DEPTH, maxNodes = VALUE_MAX_NODES } = {},
): { value: Json; bytes: number } {
	let nodes = 0;
	let bytes = 0;
	function charge(amount: number): void {
		bytes += amount;
		if (bytes > maxBytes) throw new Error("JSON exceeds its byte limit");
	}
	function visit(item: unknown, depth: number): Json {
		if (++nodes > maxNodes || depth > maxDepth || types.isProxy(item)) throw new Error("JSON exceeds its data limits");
		if (
			item === null ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item)) ||
			(typeof item === "string" && item.length <= VALUE_MAX_BYTES && !/[\u0000\ud800-\udfff]/u.test(item))
		) {
			charge(Buffer.byteLength(JSON.stringify(item)));
			return item;
		}
		if (Array.isArray(item)) {
			charge(2 + Math.max(0, item.length - 1));
			return boundedArray(item, maxNodes - nodes, (child) => visit(child, depth + 1));
		}
		if (!plainObject(item)) throw new Error("Expected plain JSON");
		const keys = Reflect.ownKeys(item);
		if (keys.length > maxNodes - nodes) throw new Error("Too many JSON keys");
		charge(2 + Math.max(0, keys.length - 1));
		return Object.fromEntries(
			keys.map((key) => {
				if (!boundedText(key, 4096)) throw new Error("Invalid JSON key");
				charge(Buffer.byteLength(JSON.stringify(key)) + 1);
				return [key, visit(enumerableData(item, key)?.value, depth + 1)];
			}),
		);
	}
	const result = visit(value, 0);
	return { value: result, bytes };
}
export type SettingsBus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};
function boundedText(value: unknown, max: number, min = 0): value is string {
	return (
		typeof value === "string" &&
		value.length >= min &&
		value.length <= max &&
		!/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value)
	);
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && choices.includes(value as T);
}
function sha256Hex(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
}
function snakeName(value: string): string {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toUpperCase();
}
function publicationSource(value: unknown): Source {
	const input = projection(value, ["path", "status", "observedAt", "digest"]);
	if (!boundedText(input.path, 4096) || !isAbsolute(input.path)) throw new Error("Invalid source path");
	if (!oneOf(input.status, ["loaded", "missing", "invalid", "unavailable"]) || !boundedText(input.observedAt, 64))
		throw new Error("Invalid source state");
	if (input.digest !== null && !sha256Hex(input.digest)) throw new Error("Invalid source digest");
	return { path: input.path, status: input.status, observedAt: input.observedAt, digest: input.digest };
}
function validFieldBounds(field: Record<string, unknown>): boolean {
	const { type, min, max, minLength, maxLength } = field;
	const numeric = type === "integer" || type === "number";
	const text = type === "string" || type === "path";
	return (
		numericBounds.every((key) => !Object.hasOwn(field, key) || (numeric && typeof field[key] === "number")) &&
		textBounds.every((key) => {
			const bound = field[key];
			return (
				!Object.hasOwn(field, key) || (text && typeof bound === "number" && Number.isSafeInteger(bound) && bound >= 0)
			);
		}) &&
		!(typeof min === "number" && typeof max === "number" && min > max) &&
		!(typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength)
	);
}
function validFieldOptions(field: Record<string, unknown>): boolean {
	const { type, absolute, secret, defaultText } = field;
	const hasDefault = Object.hasOwn(field, "default");
	const hasDefaultText = Object.hasOwn(field, "defaultText");
	return (
		(!Object.hasOwn(field, "absolute") || (type === "path" && typeof absolute === "boolean")) &&
		(!Object.hasOwn(field, "secret") || typeof secret === "boolean") &&
		(!hasDefaultText || (!hasDefault && boundedText(defaultText, 2048, 1))) &&
		(!secret || (type === "string" && !hasDefault && !hasDefaultText)) &&
		validFieldChoices(field) &&
		validFieldSchema(field)
	);
}
function validFieldSchema(field: Record<string, unknown>): boolean {
	if (field.type !== "json") return !Object.hasOwn(field, "schema");
	// The declaration has already been copied as bounded plain JSON.
	return plainObject(field.schema) && Buffer.byteLength(JSON.stringify(field.schema)) <= SCHEMA_MAX_BYTES;
}
function validFieldChoices(field: Record<string, unknown>): boolean {
	if (field.type !== "enum") return !Object.hasOwn(field, "choices");
	return (
		Array.isArray(field.choices) &&
		field.choices.length > 0 &&
		field.choices.every((choice) => boundedText(choice, 4096, 1)) &&
		new Set(field.choices).size === field.choices.length
	);
}
function publicationDeclaration(input: Json, slice: string): Declaration {
	if (!plainObject(input) || input.slice !== slice || !plainObject(input.fields) || Object.keys(input).length !== 2) {
		throw new Error("Invalid declaration identity");
	}
	const fields = Object.entries(input.fields);
	if (fields.length > SETTINGS_MAX_FIELDS) throw new Error("Too many declared fields");
	const envs = new Set<string>();
	for (const [key, field] of fields) {
		if (
			!identifier(key) ||
			!plainObject(field) ||
			Object.keys(field).some((name) => !fieldKeys.includes(name)) ||
			!oneOf(field.type, settingTypes) ||
			!oneOf(field.apply, applicationTimings) ||
			!boundedText(field.description, 2048, 1) ||
			!boundedText(field.env, 128) ||
			field.env !== `PI_${snakeName(slice)}_${snakeName(key)}` ||
			envs.has(field.env) ||
			!validFieldBounds(field) ||
			!validFieldOptions(field)
		) {
			throw new Error("Invalid field declaration");
		}
		if (Object.hasOwn(field, "default")) {
			if (!validSettingValue(field as SettingField, field.default as Json, false))
				throw new Error("Invalid declared default");
			if (field.type === "json") copyJson(field.default, VALUE_MAX_BYTES);
		}
		envs.add(field.env);
	}
	return input as Declaration;
}
function validSecretRecord(input: Record<string, unknown>, record: SettingRecord): boolean {
	if (record.type !== "string" || Object.hasOwn(input, "value") || !oneOf(input.secretState, ["set", "unset"]))
		return false;
	if (input.secretState === "set" && record.origin !== "env") return false;
	if (record.status === "valid" && input.secretState !== "set") return false;
	return record.status !== "unset" || input.secretState === "unset";
}
function validSettingValue(field: SettingField, value: Json, effective: boolean): boolean {
	switch (field.type) {
		case "string":
			return boundedText(value, field.maxLength ?? 4096, field.minLength ?? 0);
		case "enum":
			return typeof value === "string" && field.choices?.includes(value) === true;
		case "path":
			// Path length constraints apply before the owner resolves a relative value.
			return effective
				? boundedText(value, VALUE_MAX_BYTES, 1) && isAbsolute(value)
				: boundedText(value, field.maxLength ?? 4096, Math.max(1, field.minLength ?? 0)) &&
						(!field.absolute || isAbsolute(value));
		case "integer":
		case "number":
			return (
				typeof value === "number" &&
				(field.type === "number" || Number.isSafeInteger(value)) &&
				value >= (field.min ?? -Infinity) &&
				value <= (field.max ?? Infinity)
			);
		case "boolean":
			return typeof value === "boolean";
		case "json":
			return true;
	}
}
function publicationRecord(
	value: unknown,
	slice: string,
	[key, field]: [string, SettingField],
	budget: { remaining: number },
): SettingRecord {
	const input = projection(value, [
		"name",
		"key",
		"type",
		"description",
		"env",
		"secret",
		"origin",
		"status",
		"value",
		"secretState",
	]);
	const name = `${slice}.${key}`;
	const secret = field.secret === true;
	if (
		input.name !== name ||
		input.key !== key ||
		input.type !== field.type ||
		input.description !== field.description ||
		input.env !== field.env ||
		input.secret !== secret
	) {
		throw new Error("Record does not match declared field");
	}
	if (!oneOf(input.origin, ["env", "file", "default"]) || !oneOf(input.status, ["valid", "unset", "invalid"]))
		throw new Error("Invalid record status");
	const record: SettingRecord = {
		name,
		key,
		type: field.type,
		description: field.description,
		env: field.env,
		secret,
		origin: input.origin,
		status: input.status,
	};
	if (secret) {
		if (!validSecretRecord(input, record)) throw new Error("Invalid secret record");
		record.secretState = input.secretState as "set" | "unset";
		return record;
	}
	if (Object.hasOwn(input, "secretState")) throw new Error("Nonsecret record has secret state");
	const hasValue = Object.hasOwn(input, "value");
	if ((record.status === "valid" && !hasValue) || (record.status === "unset" && hasValue))
		throw new Error("Value/status mismatch");
	if (hasValue) {
		const copied = copyJson(input.value, Math.min(VALUE_MAX_BYTES, budget.remaining));
		if (!validSettingValue(field, copied.value, true)) throw new Error("Invalid published value");
		budget.remaining -= copied.bytes;
		record.value = copied.value;
	}
	return record;
}
function publicationDiagnostic(value: unknown): Diagnostic {
	const input = projection(value, ["field", "source", "code"]);
	if (
		!boundedText(input.field, 256) ||
		!oneOf(input.source, ["env", "file", "default"]) ||
		!oneOf(input.code, ["document", "unknown", "secret", "invalid", "coverage", "relation"])
	)
		throw new Error("Invalid diagnostic");
	// Messages come from this contract, not from untrusted exception text.
	return diagnostic(input.field, input.source, input.code);
}
export function parseSettingsPublication(value: unknown): SettingsPublication | undefined {
	try {
		const input = projection(value, ["version", "slice", "declaration", "source", "records", "diagnostics"]);
		const { slice } = input;
		if (input.version !== 2 || !identifier(slice) || slice === "version") return;
		const source = publicationSource(input.source);
		// A default value is three edges below the declaration root.
		const copied = copyJson(input.declaration, PUBLICATION_MAX_BYTES, {
			maxDepth: VALUE_MAX_DEPTH + 3,
			maxNodes: PUBLICATION_MAX_BYTES,
		});
		const declaration = publicationDeclaration(copied.value, slice);
		const fields = Object.entries(declaration.fields);
		const budget = { remaining: PUBLICATION_MAX_BYTES - copied.bytes };
		const records = boundedArray(input.records, fields.length, (record, index) =>
			publicationRecord(record, slice, fields[index], budget),
		);
		if (records.length !== fields.length) return;
		const diagnostics = boundedArray(input.diagnostics, SETTINGS_MAX_FIELDS * 3 + 1, publicationDiagnostic);
		const publication: SettingsPublication = { version: 2, slice, declaration, source, records, diagnostics };
		if (Buffer.byteLength(JSON.stringify(publication)) > PUBLICATION_MAX_BYTES) return;
		return publication;
	} catch {
		return;
	}
}

export type SettingsCoverage = {
	status: "available" | "unavailable" | "disposed";
	slices: string[];
	malformed: number;
	omitted: number;
};
export function collectSettings(bus: SettingsBus): {
	snapshots: () => SettingsPublication[];
	coverage: () => SettingsCoverage;
	refresh: () => void;
	dispose: () => void;
} {
	const publications = new Map<string, SettingsPublication>();
	let disposed = false;
	let status: SettingsCoverage["status"] = "available";
	let malformed = 0;
	let omitted = 0;
	const unsubscribe = bus.on(SETTINGS_PUBLISH, (input) => {
		if (disposed) return;
		const publication = parseSettingsPublication(input);
		if (!publication) {
			malformed = Math.min(Number.MAX_SAFE_INTEGER, malformed + 1);
			return;
		}
		if (!publications.has(publication.slice) && publications.size >= SETTINGS_MAX_SLICES) {
			omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
			return;
		}
		publications.set(publication.slice, publication);
	});
	const refresh = () => {
		if (!disposed) {
			publications.clear();
			malformed = 0;
			omitted = 0;
			status = "available";
			try {
				bus.emit(SETTINGS_REQUEST, { version: 2 });
			} catch (error) {
				status = "unavailable";
				throw error;
			}
		}
	};
	try {
		refresh();
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return {
		snapshots: () => structuredClone([...publications.values()].sort((a, b) => a.slice.localeCompare(b.slice))),
		coverage: () => ({ status, slices: [...publications.keys()].sort(), malformed, omitted }),
		refresh,
		dispose: () => {
			if (!disposed) {
				disposed = true;
				status = "disposed";
				unsubscribe();
				publications.clear();
			}
		},
	};
}
