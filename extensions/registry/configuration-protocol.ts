import { isAbsolute } from "node:path";

const VALUE_MAX_BYTES = 131072;
export const PUBLICATION_MAX_BYTES = 262144;
export const SETTINGS_MAX_FIELDS = 128;
export const SETTINGS_MAX_SLICES = 64;
export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Origin = "env" | "file" | "default";
export type SettingType = "string" | "path" | "integer" | "number" | "boolean" | "enum" | "json";

function textValid(value: unknown): value is string {
	return typeof value === "string" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
	version: 1;
	slice: string;
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
function plainObject(value: unknown): value is Record<string, unknown> {
	if (!object(value)) return false;
	return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
function jsonValue(value: unknown): value is Json {
	let nodes = 0;
	function visit(item: unknown, depth: number): boolean {
		if (++nodes > 10000 || depth > 32) return false;
		if (item === null || typeof item === "boolean") return true;
		if (typeof item === "number") return Number.isFinite(item);
		if (typeof item === "string") return item.length <= VALUE_MAX_BYTES && !/[\u0000\ud800-\udfff]/u.test(item);
		if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
		if (!plainObject(item)) return false;
		return Object.entries(item).every(
			([key, child]) => textValid(key) && key.length <= 4096 && visit(child, depth + 1),
		);
	}
	try {
		return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= VALUE_MAX_BYTES;
	} catch {
		return false;
	}
}
export type SettingsBus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};
function boundedText(value: unknown, max: number): value is string {
	return textValid(value) && value.length <= max;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && choices.includes(value as T);
}
function publicationSource(input: unknown): Source {
	if (!object(input) || !boundedText(input.path, 4096) || !isAbsolute(input.path))
		throw new Error("Invalid source path");
	if (!oneOf(input.status, ["loaded", "missing", "invalid", "unavailable"]) || !boundedText(input.observedAt, 64))
		throw new Error("Invalid source state");
	if (input.digest !== null && (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)))
		throw new Error("Invalid source digest");
	return { path: input.path, status: input.status, observedAt: input.observedAt, digest: input.digest };
}
function recordHeader(input: unknown, slice: string): SettingRecord {
	if (!object(input) || !identifier(input.key) || input.name !== `${slice}.${input.key}`)
		throw new Error("Invalid record identity");
	if (
		!oneOf(input.type, ["string", "path", "integer", "number", "boolean", "enum", "json"]) ||
		!boundedText(input.description, 2048)
	)
		throw new Error("Invalid record metadata");
	if (!boundedText(input.env, 128) || !/^PI_[A-Z][A-Z0-9_]*$/.test(input.env) || typeof input.secret !== "boolean")
		throw new Error("Invalid record environment");
	if (!oneOf(input.origin, ["env", "file", "default"]) || !oneOf(input.status, ["valid", "unset", "invalid"]))
		throw new Error("Invalid record status");
	return {
		name: input.name as string,
		key: input.key,
		type: input.type,
		description: input.description,
		env: input.env,
		secret: input.secret,
		origin: input.origin,
		status: input.status,
	};
}
function validSecretRecord(input: Record<string, unknown>, record: SettingRecord): boolean {
	if (record.type !== "string" || Object.hasOwn(input, "value") || !oneOf(input.secretState, ["set", "unset"]))
		return false;
	if (input.secretState === "set" && record.origin !== "env") return false;
	if (record.status === "valid" && input.secretState !== "set") return false;
	return record.status !== "unset" || input.secretState === "unset";
}
function validPublishedValue(type: SettingType, value: Json): boolean {
	switch (type) {
		case "string":
		case "enum":
			return textValid(value);
		case "path":
			return textValid(value) && isAbsolute(value);
		case "integer":
			return typeof value === "number" && Number.isSafeInteger(value);
		case "number":
			return typeof value === "number";
		case "boolean":
			return typeof value === "boolean";
		case "json":
			return true;
	}
}
function recordValue(input: Record<string, unknown>, record: SettingRecord): void {
	if (Object.hasOwn(input, "secretState")) throw new Error("Nonsecret record has secret state");
	const hasValue = Object.hasOwn(input, "value");
	if ((record.status === "valid" && !hasValue) || (record.status === "unset" && hasValue))
		throw new Error("Value/status mismatch");
	if (!hasValue) return;
	if (!jsonValue(input.value) || !validPublishedValue(record.type, input.value))
		throw new Error("Invalid published value");
	record.value = structuredClone(input.value);
}
function publicationRecord(input: unknown, slice: string): SettingRecord {
	const record = recordHeader(input, slice);
	if (!object(input)) throw new Error("Invalid record");
	if (record.secret) {
		if (!validSecretRecord(input, record)) throw new Error("Invalid secret record");
		record.secretState = input.secretState as "set" | "unset";
	} else recordValue(input, record);
	return record;
}
function publicationDiagnostic(input: unknown): Diagnostic {
	if (
		!object(input) ||
		!boundedText(input.field, 256) ||
		!oneOf(input.source, ["env", "file", "default"]) ||
		!oneOf(input.code, ["document", "unknown", "secret", "invalid", "coverage", "relation"])
	)
		throw new Error("Invalid diagnostic");
	// Messages come from this contract, not from untrusted exception text.
	return diagnostic(input.field, input.source, input.code);
}
export function parseSettingsPublication(input: unknown): SettingsPublication | undefined {
	try {
		if (!object(input) || input.version !== 1 || !identifier(input.slice)) return;
		if (!Array.isArray(input.records) || !Array.isArray(input.diagnostics)) return;
		if (input.records.length > SETTINGS_MAX_FIELDS || input.diagnostics.length > SETTINGS_MAX_FIELDS * 3 + 1) return;
		const source = publicationSource(input.source);
		const slice = input.slice;
		const records = input.records.map((record) => publicationRecord(record, slice));
		if (new Set(records.map((record) => record.key)).size !== records.length) return;
		const diagnostics = input.diagnostics.map(publicationDiagnostic);
		const publication: SettingsPublication = { version: 1, slice, source, records, diagnostics };
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
				bus.emit(SETTINGS_REQUEST, { version: 1 });
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
