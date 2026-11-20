import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const settings = {
	slice: "config",
	fields: {
		app: {
			type: "path",
			env: "PI_CONFIG_APP",
			defaultText: "<agentDir>/config-app/Config.app",
			description: "Installed native Config application that /config opens.",
			apply: "use",
		},
		custom: {
			type: "json",
			env: "PI_CONFIG_CUSTOM",
			default: {},
			description:
				"User-created settings: an object keyed by setting name, each entry {value?, description?, type?}. type is string, number, integer, boolean, array, object or json. The Config app and the config tools read and change these entries; they add no behaviour to Pi or another extension.",
			apply: "use",
		},
	},
} as const;

const DOCUMENT_MAX_BYTES = 131072;
const PUBLICATION_MAX_BYTES = 262144;
export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";
export const CUSTOM_TYPES = ["string", "number", "integer", "boolean", "array", "object", "json"] as const;
export const CUSTOM_MAX_ENTRIES = 512;
export const CUSTOM_KEY_MAX = 256;
export const CUSTOM_DESCRIPTION_MAX = 1024;
export type Environment = Readonly<Record<string, string | undefined>>;
export type Origin = "env" | "file" | "default";
export type ReadOptions = { agentDir: string; env?: Environment };
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type CustomType = (typeof CUSTOM_TYPES)[number];
export type CustomEntry = { value?: Json; description?: string; type?: CustomType };
type Key = keyof typeof settings.fields;
type Values = { app: string; custom: Record<string, CustomEntry> };
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
	type: "path" | "json";
	description: string;
	env: string;
	secret: boolean;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	value?: Json;
};
export type SettingsPublication = {
	version: 2;
	slice: string;
	declaration: typeof settings;
	source: Source;
	records: SettingRecord[];
	diagnostics: Diagnostic[];
};
export type Snapshot = Omit<SettingsPublication, "declaration"> & { values: Values };

function textValid(value: unknown): value is string {
	return typeof value === "string" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}
function unknownField(key: string): string {
	const suffix = textValid(key) ? key.slice(0, 64) : "<invalid-key>";
	return `${settings.slice}.${/[\ud800-\udbff]$/.test(suffix) ? suffix.slice(0, -1) : suffix}`;
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function plainObject(value: unknown): value is Record<string, unknown> {
	if (!object(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function settingsPath({ agentDir, env = process.env }: ReadOptions): string {
	if (!isAbsolute(agentDir) || !textValid(agentDir) || agentDir.length > 4096)
		throw new Error("agentDir must be an absolute directory path");
	const override = env.PI_HARNESS_FILE;
	if (override !== undefined && (!textValid(override) || !override.length || override.length > 4096))
		throw new Error("PI_HARNESS_FILE must be a nonempty path");
	const path = resolve(agentDir, override ?? "harness.json");
	if (path.length > 4096) throw new Error("Configuration path exceeds length limit");
	return path;
}
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
function boundedRead(fd: number): Buffer {
	const bytes = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
	let length = 0;
	while (length < bytes.length) {
		const count = readSync(fd, bytes, length, bytes.length - length, length);
		if (!count) break;
		length += count;
	}
	return bytes.subarray(0, length);
}
function readDocument(options: ReadOptions): {
	source: Source;
	document?: Record<string, unknown>;
	diagnostics: Diagnostic[];
} {
	const source: Source = {
		path: settingsPath({ agentDir: options.agentDir, env: {} }),
		status: "unavailable",
		digest: null,
		observedAt: new Date().toISOString(),
	};
	try {
		source.path = settingsPath(options);
	} catch {
		return { source, diagnostics: [diagnostic("PI_HARNESS_FILE", "env", "document")] };
	}
	let fd: number | undefined;
	let readComplete = false;
	try {
		fd = openSync(source.path, constants.O_RDONLY | constants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) throw new Error("Nonregular source");
		const content = boundedRead(fd);
		readComplete = true;
		if (content.length > DOCUMENT_MAX_BYTES) throw new Error("Oversized document");
		source.digest = createHash("sha256").update(content).digest("hex");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content));
		if (!object(value) || value.version !== 1) throw new Error("Invalid document envelope");
		source.status = "loaded";
		return { source, document: value, diagnostics: [] };
	} catch (error) {
		if (object(error) && error.code === "ENOENT") return { source: { ...source, status: "missing" }, diagnostics: [] };
		source.status = readComplete ? "invalid" : "unavailable";
		return { source, diagnostics: [diagnostic("document", "file", "document")] };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Bounds every `json` value before the structural validator runs. */
export function boundedJson(input: unknown): input is Json {
	let nodes = 0;
	const visit = (value: unknown, depth: number): boolean => {
		if (++nodes > 10000 || depth > 32) return false;
		if (value === null || typeof value === "boolean") return true;
		if (typeof value === "number") return Number.isFinite(value);
		if (typeof value === "string") return value.length <= 131072 && !/[\u0000\ud800-\udfff]/u.test(value);
		if (Array.isArray(value)) return value.every((item) => visit(item, depth + 1));
		if (!plainObject(value)) return false;
		return Object.entries(value).every(([key, item]) => textValid(key) && key.length <= 4096 && visit(item, depth + 1));
	};
	try {
		return visit(input, 0) && Buffer.byteLength(JSON.stringify(input)) <= 131072;
	} catch {
		return false;
	}
}
export function customValueMatches(type: CustomType, value: Json): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isSafeInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return plainObject(value);
		case "json":
			return true;
	}
}
function customKeyProblem(key: string): string | undefined {
	if (!textValid(key) || !key.length || key.length > CUSTOM_KEY_MAX)
		return `A setting name has 1 to ${CUSTOM_KEY_MAX} printable characters.`;
}
function customFieldProblem(entry: Record<string, unknown>): string | undefined {
	for (const name of Object.keys(entry))
		if (name !== "value" && name !== "description" && name !== "type")
			return "An entry holds only value, description and type.";
	if (entry.description !== undefined) {
		const description = entry.description;
		if (!textValid(description) || description.length > CUSTOM_DESCRIPTION_MAX)
			return `A description is one line of at most ${CUSTOM_DESCRIPTION_MAX} characters.`;
	}
	if (entry.type !== undefined && !(CUSTOM_TYPES as readonly unknown[]).includes(entry.type))
		return `type is one of ${CUSTOM_TYPES.join(", ")}.`;
}
function customStoredValueProblem(entry: Record<string, unknown>): string | undefined {
	if (!Object.hasOwn(entry, "value")) return;
	if (!boundedJson(entry.value)) return "The value is not bounded JSON.";
	if (entry.type !== undefined && !customValueMatches(entry.type as CustomType, entry.value))
		return `The value does not match type ${entry.type}.`;
}
/** Validates one user-created entry; returns the problem or undefined. */
export function customEntryProblem(key: string, entry: unknown): string | undefined {
	const keyProblem = customKeyProblem(key);
	if (keyProblem) return keyProblem;
	if (!plainObject(entry)) return "An entry is an object with value, description and type.";
	return customFieldProblem(entry) ?? customStoredValueProblem(entry);
}
function checkedCustom(input: unknown): Record<string, CustomEntry> {
	if (!boundedJson(input) || !plainObject(input)) throw new Error("Invalid custom settings");
	const entries = Object.entries(input);
	if (entries.length > CUSTOM_MAX_ENTRIES) throw new Error("Too many custom settings");
	for (const [key, entry] of entries) if (customEntryProblem(key, entry)) throw new Error("Invalid custom setting");
	return structuredClone(input) as Record<string, CustomEntry>;
}
function checkedPath(value: unknown, agentDir: string): string {
	if (!textValid(value) || !value.length || value.length > 4096) throw new Error("Invalid path");
	const path = resolve(agentDir, value);
	if (path.length > 4096) throw new Error("Resolved path exceeds length bound");
	return path;
}
function defaultApp(agentDir: string): string {
	try {
		return checkedPath(resolve(agentDir, "config-app/Config.app"), agentDir);
	} catch {
		throw new Error("Invalid default for settings.app");
	}
}
type Selection = { value: Json; origin: Origin; invalid: boolean };
function readSection(options: ReadOptions) {
	const { source, document, diagnostics } = readDocument(options);
	const sectionValue = document && Object.hasOwn(document, settings.slice) ? document[settings.slice] : undefined;
	let section: Record<string, unknown> = {};
	if (sectionValue !== undefined) {
		if (object(sectionValue)) section = sectionValue;
		else diagnostics.push(diagnostic(settings.slice, "file", "invalid"));
	}
	const add = (fact: Diagnostic) => {
		if (diagnostics.length < 256) diagnostics.push(fact);
		else if (!diagnostics.some((item) => item.code === "coverage"))
			diagnostics.push(diagnostic("coverage", "file", "coverage"));
	};
	for (const key of Object.keys(section)) {
		if (!Object.hasOwn(settings.fields, key)) add(diagnostic(unknownField(key), "file", "unknown"));
	}
	return { source, section, diagnostics, add };
}
function selectField(
	key: Key,
	fallback: Json,
	section: Record<string, unknown>,
	options: ReadOptions,
	add: (fact: Diagnostic) => void,
): Selection {
	const field = settings.fields[key];
	const env = options.env ?? process.env;
	const origin = env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : undefined;
	if (origin === undefined) return { value: fallback, origin: "default", invalid: false };
	try {
		let input: unknown = origin === "env" ? env[field.env] : section[key];
		if (key === "custom") {
			if (origin === "env") {
				if (typeof input !== "string" || Buffer.byteLength(input) > 131072) throw new Error("Invalid environment");
				input = JSON.parse(input);
			}
			return { value: checkedCustom(input), origin, invalid: false };
		}
		return { value: checkedPath(input, options.agentDir), origin, invalid: false };
	} catch {
		add(diagnostic(`${settings.slice}.${key}`, origin, "invalid"));
		return { value: fallback, origin: "default", invalid: true };
	}
}
function settingRecord(key: Key, selected: Selection): SettingRecord {
	const field = settings.fields[key];
	return {
		name: `${settings.slice}.${key}`,
		key,
		type: field.type,
		description: field.description,
		env: field.env,
		secret: false,
		origin: selected.origin,
		status: selected.invalid ? "invalid" : "valid",
		value: structuredClone(selected.value),
	};
}
export function readSettings(options: ReadOptions): Snapshot {
	const { source, section, diagnostics, add } = readSection(options);
	const app = selectField("app", defaultApp(options.agentDir), section, options, add);
	const custom = selectField("custom", {}, section, options, add);
	return {
		version: 2,
		slice: settings.slice,
		source,
		diagnostics,
		records: [settingRecord("app", app), settingRecord("custom", custom)],
		values: { app: app.value as string, custom: custom.value as Record<string, CustomEntry> },
	};
}
export type SettingsBus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};
function bounded<T>(value: T): T {
	if (Buffer.byteLength(JSON.stringify(value)) > PUBLICATION_MAX_BYTES)
		throw new Error("Settings publication exceeds byte limit");
	return structuredClone(value);
}
export function publication(options: ReadOptions): SettingsPublication {
	const { slice, source, records, diagnostics } = readSettings(options);
	return bounded({ version: 2, slice, declaration: settings, source, records, diagnostics });
}
export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void {
	const publish = () => bus.emit(SETTINGS_PUBLISH, publication(options));
	const off = bus.on(SETTINGS_REQUEST, (value) => {
		if (object(value) && value.version === 2) publish();
	});
	try {
		publish();
	} catch (error) {
		off();
		throw error;
	}
	return off;
}
