import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	validPresets,
	validPreferences,
	type ExecutionPresets,
	type DelegationPreferences,
} from "./preference-schema.ts";

export const settings = {
	slice: "agent",
	fields: {
		idleMinutes: {
			type: "number",
			env: "PI_AGENT_IDLE_MINUTES",
			description: "Idle host retirement interval in minutes; zero disables.",
			default: 5,
			min: 0,
			max: 35791,
		},
		checkInMinutes: {
			type: "number",
			env: "PI_AGENT_CHECK_IN_MINUTES",
			description: "Automatic owner check-in interval for model tasks in minutes; zero disables.",
			default: 30,
			min: 0,
			max: 35791,
		},
		presets: {
			type: "json",
			env: "PI_AGENT_PRESETS",
			description: "Named execution presets with exact model identities and optional creation fields.",
			default: {},
		},
		preferences: {
			type: "json",
			env: "PI_AGENT_PREFERENCES",
			description: "Delegation preferences, default preset, exclusions, planning budgets, and reporting guidance.",
			default: {},
		},
	},
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;
type Origin = "env" | "file" | "default";
export type Source = {
	path: string;
	status: "loaded" | "missing" | "invalid" | "unavailable";
	digest: string | null;
	observedAt: string;
};
type Diagnostic = {
	field: string;
	source: Origin;
	code: "document" | "unknown" | "invalid" | "coverage";
	message: string;
};
type SettingRecord = {
	name: string;
	key: string;
	type: "number" | "json";
	description: string;
	env: string;
	secret: false;
	origin: Origin;
	status: "valid" | "invalid";
	value: unknown;
};
export type SettingsPublication = {
	version: 1;
	slice: "agent";
	source: Source;
	records: SettingRecord[];
	diagnostics: Diagnostic[];
};
type SettingsValues = {
	idleMinutes: number;
	checkInMinutes: number;
	presets: ExecutionPresets;
	preferences: DelegationPreferences;
};
type Snapshot = SettingsPublication & { values: SettingsValues };
type ReadOptions = { agentDir: string; env?: Environment };
export type SettingsBus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};
const DOCUMENT_MAX_BYTES = 131072;

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function textValid(value: string): boolean {
	return !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}
function diagnostic(field: string, source: Origin, code: Diagnostic["code"]): Diagnostic {
	const messages = {
		document: "Configuration document is invalid or unavailable.",
		unknown: "Unknown setting in this section.",
		invalid: "Selected input is invalid; the safe default is in effect.",
		coverage: "Additional diagnostics were omitted at the diagnostic limit.",
	};
	return { field, source, code, message: messages[code] };
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
function plainObject(value: unknown): value is Record<string, unknown> {
	return object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundedJson(value: unknown): boolean {
	let nodes = 0;
	function visit(item: unknown, depth: number): boolean {
		if (++nodes > 10000 || depth > 32) return false;
		if (item === null || typeof item === "boolean") return true;
		if (typeof item === "number") return Number.isFinite(item);
		if (typeof item === "string") return item.length <= DOCUMENT_MAX_BYTES && !/[\u0000\ud800-\udfff]/u.test(item);
		if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
		if (!plainObject(item)) return false;
		return Object.entries(item).every(([key, child]) => textValid(key) && key.length <= 4096 && visit(child, depth + 1));
	}
	return visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= DOCUMENT_MAX_BYTES;
}
function checkedValue(key: keyof SettingsValues, input: unknown): unknown {
	const field = settings.fields[key];
	if (field.type === "number") {
		if (typeof input !== "number" || !Number.isFinite(input) || input < field.min || input > field.max)
			throw new Error("Invalid numeric setting");
	} else if (!boundedJson(input) || !(key === "presets" ? validPresets(input) : validPreferences(input))) {
		throw new Error("Invalid structured setting");
	}
	return input;
}
function environmentValue(type: "number" | "json", raw: string): unknown {
	if (Buffer.byteLength(raw) > DOCUMENT_MAX_BYTES) throw new Error("Oversized environment input");
	if (type === "json") return JSON.parse(raw);
	if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error("Invalid numeric input");
	return Number(raw);
}

function selectField(key: keyof SettingsValues, env: Environment, section: Record<string, unknown>, add: (fact: Diagnostic) => void) {
	const field = settings.fields[key];
	let origin: Origin = env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : "default";
	let value: unknown;
	try {
		value = checkedValue(key, structuredClone(field.default));
	} catch {
		throw new Error(`Invalid default for agent.${key}`);
	}
	let status: SettingRecord["status"] = "valid";
	if (origin !== "default") {
		try {
			const input = origin === "env" ? environmentValue(field.type, env[field.env] as string) : section[key];
			value = checkedValue(key, input);
		} catch {
			add(diagnostic(`agent.${key}`, origin, "invalid"));
			origin = "default";
			status = "invalid";
		}
	}
	return { value, origin, status };
}
function readSection(document: Record<string, unknown> | undefined, diagnostics: Diagnostic[]): Record<string, unknown> {
	if (!document || !Object.hasOwn(document, "agent")) return {};
	if (object(document.agent)) return document.agent;
	diagnostics.push(diagnostic("agent", "file", "invalid"));
	return {};
}

export function readSettings(options: ReadOptions): Snapshot {
	const { source, document, diagnostics } = readDocument(options);
	const env = options.env ?? process.env;
	const section = readSection(document, diagnostics);
	const add = (fact: Diagnostic) => {
		if (diagnostics.length < 256) diagnostics.push(fact);
		else if (!diagnostics.some((item) => item.code === "coverage")) diagnostics.push(diagnostic("coverage", "file", "coverage"));
	};
	for (const key of Object.keys(section)) {
		if (!Object.hasOwn(settings.fields, key))
			add(diagnostic(`agent.${textValid(key) ? key.slice(0, 64) : "<invalid-key>"}`, "file", "unknown"));
	}
	const values: Record<string, unknown> = Object.create(null);
	const records: SettingRecord[] = [];
	for (const key of Object.keys(settings.fields) as (keyof SettingsValues)[]) {
		const field = settings.fields[key];
		const { value, origin, status } = selectField(key, env, section, add);
		values[key] = value;
		records.push({ name: `agent.${key}`, key, type: field.type, description: field.description, env: field.env, secret: false, origin, status, value: structuredClone(value) });
	}
	return { version: 1, slice: "agent", source, values: values as SettingsValues, records, diagnostics };
}

export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void {
	const publish = () => {
		const { version, slice, source, records, diagnostics } = readSettings(options);
		const publication: SettingsPublication = { version, slice, source, records, diagnostics };
		if (Buffer.byteLength(JSON.stringify(publication)) > 262144) throw new Error("Settings publication exceeds byte limit");
		bus.emit("harness:settings:publish", publication);
	};
	const unsubscribe = bus.on("harness:settings:request", (value) => {
		if (object(value) && value.version === 1) publish();
	});
	try {
		publish();
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return unsubscribe;
}
