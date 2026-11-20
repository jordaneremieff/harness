import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { boundedJson, isPlainObject, printable } from "./json.ts";
import type { Json } from "./protocol.ts";

/**
 * Local copies of the extension configuration contract's version 2 shapes. Settings reads
 * owners only through these public events; it never imports an owner's module.
 */
export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";
const PUBLICATION_MAX_BYTES = 262144;
const MAX_RECORDS = 128;
const MAX_DIAGNOSTICS = 385;
const MAX_SLICES = 64;

export type Origin = "env" | "file" | "default";
export type FieldType = "string" | "path" | "integer" | "number" | "boolean" | "enum" | "json";
export type Apply = "use" | "reload" | "restart";
export type Field = {
	type: FieldType;
	env: string;
	description: string;
	apply: Apply;
	default?: Json;
	defaultText?: string;
	secret?: boolean;
	absolute?: boolean;
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	choices?: string[];
};
export type Declaration = { slice: string; fields: Record<string, Field> };
export type Diagnostic = {
	field: string;
	source: Origin;
	code: "document" | "unknown" | "secret" | "invalid" | "coverage" | "relation";
	message: string;
};
export type SettingRecord = {
	name: string;
	key: string;
	type: FieldType;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	secret: boolean;
	value?: Json;
	secretState?: "set" | "unset";
};
export type Publication = {
	slice: string;
	schema: string;
	declaration: Declaration;
	source: { path: string; status: "loaded" | "missing" | "invalid" | "unavailable"; digest: string | null };
	records: SettingRecord[];
	diagnostics: Diagnostic[];
};
export type Bus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};

const TYPES: readonly FieldType[] = ["string", "path", "integer", "number", "boolean", "enum", "json"];
const APPLY: readonly Apply[] = ["use", "reload", "restart"];
const CODES: readonly Diagnostic["code"][] = ["document", "unknown", "secret", "invalid", "coverage", "relation"];
const MESSAGES: Record<Diagnostic["code"], string> = {
	document: "Configuration document is invalid or unavailable.",
	unknown: "Unknown setting in this section.",
	secret: "Secret settings are environment-only; document input was rejected.",
	invalid: "Selected input is invalid; the safe default is in effect.",
	coverage: "Additional diagnostics were omitted at the diagnostic limit.",
	relation: "Effective settings violate an owning cross-field constraint; values are unchanged.",
};
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-zA-Z0-9]{0,63}$/.test(value);
}
function oneOf<T>(value: unknown, choices: readonly T[]): value is T {
	return choices.includes(value as T);
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
/** Reads the optional parts of a field; every violation is a "field" error. */
function applyFieldOptions(input: Record<string, unknown>, field: Field): void {
	if (Object.hasOwn(input, "default")) {
		if (!boundedJson(input.default)) throw new Error("field");
		field.default = structuredClone(input.default);
	}
	if (input.defaultText !== undefined) {
		if (!printable(input.defaultText, 4096)) throw new Error("field");
		field.defaultText = input.defaultText;
	}
}
function applyFieldFlags(input: Record<string, unknown>, field: Field): void {
	for (const flag of ["secret", "absolute"] as const)
		if (input[flag] !== undefined) {
			if (typeof input[flag] !== "boolean") throw new Error("field");
			field[flag] = input[flag];
		}
}
function applyFieldBounds(input: Record<string, unknown>, field: Field): void {
	for (const bound of ["min", "max", "minLength", "maxLength"] as const)
		if (input[bound] !== undefined) {
			if (!finite(input[bound])) throw new Error("field");
			field[bound] = input[bound];
		}
}
function applyFieldChoices(input: Record<string, unknown>, field: Field): void {
	if (input.choices === undefined) return;
	if (
		!Array.isArray(input.choices) ||
		input.choices.length > 256 ||
		!input.choices.every((choice) => printable(choice))
	)
		throw new Error("field");
	field.choices = [...input.choices];
}
function parseField(input: unknown): Field {
	if (!isPlainObject(input)) throw new Error("field");
	const { type, env, description, apply } = input;
	if (!oneOf(type, TYPES) || !printable(env, 128) || !/^PI_[A-Z][A-Z0-9_]*$/.test(env)) throw new Error("field");
	if (!printable(description, 4096) || !oneOf(apply, APPLY)) throw new Error("field");
	const field: Field = { type, env, description, apply };
	applyFieldOptions(input, field);
	applyFieldFlags(input, field);
	applyFieldBounds(input, field);
	applyFieldChoices(input, field);
	return field;
}
function parseDeclaration(input: unknown, slice: string): Declaration {
	if (!isPlainObject(input) || input.slice !== slice || !isPlainObject(input.fields)) throw new Error("declaration");
	const keys = Object.keys(input.fields);
	if (keys.length > MAX_RECORDS) throw new Error("declaration");
	const fields: Record<string, Field> = {};
	for (const key of keys) {
		if (!identifier(key)) throw new Error("declaration");
		fields[key] = parseField(input.fields[key]);
	}
	return { slice, fields };
}
/** Reads the value or secret state of one record; every violation is a "record" error. */
function applyRecordPayload(input: Record<string, unknown>, record: SettingRecord): void {
	if (input.secret) {
		if (Object.hasOwn(input, "value") || !oneOf(input.secretState, ["set", "unset"] as const))
			throw new Error("record");
		record.secretState = input.secretState;
	} else if (Object.hasOwn(input, "value")) {
		if (!boundedJson(input.value)) throw new Error("record");
		record.value = structuredClone(input.value);
	}
}
function parseRecord(input: unknown, slice: string, declaration?: Declaration): SettingRecord {
	if (!isPlainObject(input) || !identifier(input.key) || input.name !== `${slice}.${input.key}`)
		throw new Error("record");
	if (!oneOf(input.type, TYPES) || !oneOf(input.origin, ["env", "file", "default"] as const)) throw new Error("record");
	if (!oneOf(input.status, ["valid", "unset", "invalid"] as const) || typeof input.secret !== "boolean")
		throw new Error("record");
	const field = declaration?.fields[input.key];
	if (declaration && (!field || field.type !== input.type || Boolean(field.secret) !== input.secret))
		throw new Error("record");
	const record: SettingRecord = {
		name: input.name as string,
		key: input.key,
		type: input.type,
		origin: input.origin,
		status: input.status,
		secret: input.secret,
	};
	applyRecordPayload(input, record);
	return record;
}
function parseDiagnostic(input: unknown): Diagnostic {
	if (
		!isPlainObject(input) ||
		!printable(input.field, 256) ||
		!oneOf(input.source, ["env", "file", "default"] as const)
	)
		throw new Error("diagnostic");
	if (!oneOf(input.code, CODES)) throw new Error("diagnostic");
	return { field: input.field, source: input.source, code: input.code, message: MESSAGES[input.code] };
}
function parseRecords(input: unknown, slice: string, declaration?: Declaration) {
	if (!isPlainObject(input) || !Array.isArray(input.records) || !Array.isArray(input.diagnostics))
		throw new Error("records");
	if (input.records.length > MAX_RECORDS || input.diagnostics.length > MAX_DIAGNOSTICS) throw new Error("records");
	return {
		records: input.records.map((record) => parseRecord(record, slice, declaration)),
		diagnostics: input.diagnostics.map(parseDiagnostic),
	};
}
export function parsePublication(input: unknown): Publication | undefined {
	try {
		if (!isPlainObject(input) || input.version !== 2 || !identifier(input.slice)) return;
		if (Buffer.byteLength(JSON.stringify(input)) > PUBLICATION_MAX_BYTES) return;
		const declaration = parseDeclaration(input.declaration, input.slice);
		const source = input.source;
		if (!isPlainObject(source) || !printable(source.path) || !isAbsolute(source.path)) return;
		if (!oneOf(source.status, ["loaded", "missing", "invalid", "unavailable"] as const)) return;
		const digest = typeof source.digest === "string" && /^[a-f0-9]{64}$/.test(source.digest) ? source.digest : null;
		const { records, diagnostics } = parseRecords(input, input.slice, declaration);
		if (new Set(records.map((record) => record.key)).size !== records.length) return;
		return {
			slice: input.slice,
			schema: createHash("sha256").update(JSON.stringify(input.declaration)).digest("hex"),
			declaration,
			source: { path: source.path, status: source.status, digest },
			records,
			diagnostics,
		};
	} catch {
		return;
	}
}

export type Collection = { publications: Map<string, Publication>; malformed: number; omitted: number };

/** Collects the publications that loaded owners emit in answer to one request. */
export function collectPublications(bus: Bus): Collection {
	const publications = new Map<string, Publication>();
	let malformed = 0;
	let omitted = 0;
	const off = bus.on(SETTINGS_PUBLISH, (input) => {
		const publication = parsePublication(input);
		if (!publication) {
			malformed++;
			return;
		}
		if (!publications.has(publication.slice) && publications.size >= MAX_SLICES) {
			omitted++;
			return;
		}
		publications.set(publication.slice, publication);
	});
	try {
		bus.emit(SETTINGS_REQUEST, { version: 2 });
	} finally {
		off();
	}
	return { publications, malformed, omitted };
}

export type Judgement = {
	/** Publications that read the candidate document, keyed by slice. */
	candidate: Map<string, Publication>;
	/** Publications of the current document with the same environment names removed. */
	baseline: Map<string, Publication>;
	/** Slices whose publication did not read the candidate document. */
	unread: string[];
};
/**
 * Asks every loaded owner for its ordinary publication of a candidate document. For one
 * synchronous step the environment names the candidate through PI_HARNESS_FILE and omits
 * `unmask`, so each owner judges the stored values themselves; publishers read the current
 * environment for every publication. A final ordinary request leaves every consumer with
 * publications of the real document. Owners implement nothing for this.
 */
export function judgeCandidate(
	bus: Bus,
	env: Record<string, string | undefined>,
	candidatePath: string,
	unmask: readonly string[],
	slices: readonly string[],
): Judgement {
	const saved = new Map<string, string | undefined>(
		["PI_HARNESS_FILE", ...unmask].map((name) => [name, env[name]] as const),
	);
	const restore = () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete env[name];
			else env[name] = value;
		}
	};
	let baseline: Collection;
	let candidate: Collection;
	try {
		for (const name of unmask) delete env[name];
		baseline = collectPublications(bus);
		env.PI_HARNESS_FILE = candidatePath;
		candidate = collectPublications(bus);
	} finally {
		restore();
		collectPublications(bus);
	}
	const unread = slices.filter((slice) => candidate.publications.get(slice)?.source.path !== candidatePath);
	return { candidate: candidate.publications, baseline: baseline.publications, unread };
}
