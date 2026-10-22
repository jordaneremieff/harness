import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";
const DOCUMENT_MAX_BYTES = 131072;

export type Environment = Readonly<Record<string, string | undefined>>;
export type ReadOptions = { agentDir: string; env?: Environment };
export type Origin = "env" | "file" | "default";
export type Band = "green" | "amber" | "red";
export type Diagnostic = {
	field: string;
	source: Origin;
	code: "document" | "unknown" | "invalid" | "coverage" | "relation";
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
	type: Field["type"];
	description: string;
	env: string;
	secret: false;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	value?: string | number | boolean;
};
export type SettingsPublication = {
	version: 1;
	slice: string;
	source: Source;
	records: SettingRecord[];
	diagnostics: Diagnostic[];
};
export type SettingsBus = {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
};

export const settings = {
	slice: "draft",
	fields: {
		enabled: {
			type: "boolean",
			env: "PI_DRAFT_ENABLED",
			description: "Run the prose meter on final replies.",
			default: true,
		},
		maxChars: {
			type: "integer",
			env: "PI_DRAFT_MAX_CHARS",
			description: "Longest reply prefix sent to the meter, in characters.",
			default: 20000,
			min: 100,
			max: 200000,
		},
		notifyBand: {
			type: "enum",
			env: "PI_DRAFT_NOTIFY_BAND",
			choices: ["green", "amber", "red"],
			default: "amber",
			description:
				"Lowest score band that sends findings to the agent when the score is reliable; this band and every worse band notify. Hard findings always notify.",
		},
		minScoredFindings: {
			type: "integer",
			env: "PI_DRAFT_MIN_SCORED_FINDINGS",
			description: "Scored findings that send findings to the agent even when the score is not reliable.",
			default: 2,
			min: 1,
			max: 50,
		},
		maxFindings: {
			type: "integer",
			env: "PI_DRAFT_MAX_FINDINGS",
			description: "Most findings listed in one message to the agent.",
			default: 12,
			min: 1,
			max: 50,
		},
	},
} as const;

export type DraftSettings = {
	enabled: boolean;
	maxChars: number;
	notifyBand: Band;
	minScoredFindings: number;
	maxFindings: number;
};
export type Snapshot = SettingsPublication & { values: DraftSettings };
type Field = {
	type: "boolean" | "integer" | "enum";
	env: string;
	description: string;
	default?: number | boolean | string;
	min?: number;
	max?: number;
	choices?: readonly string[];
};
type Value = string | number | boolean;

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function textValid(value: unknown): value is string {
	return typeof value === "string" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
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
function unknownKey(key: string): string {
	if (!textValid(key)) return "<invalid-key>";
	const unit = key.charCodeAt(63);
	return key.slice(0, unit >= 0xd800 && unit <= 0xdbff ? 63 : 64);
}
function diagnostic(field: string, source: Origin, code: Diagnostic["code"]): Diagnostic {
	const messages = {
		document: "Configuration document is invalid or unavailable.",
		unknown: "Unknown setting in this section.",
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
function parseEnvironment(field: Field, raw: unknown): unknown {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > DOCUMENT_MAX_BYTES)
		throw new Error("Invalid environment input");
	if (field.type === "boolean") {
		if (raw === "1" || raw === "true") return true;
		if (raw === "0" || raw === "false") return false;
		return undefined;
	}
	if (field.type === "integer")
		return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : undefined;
	return raw;
}
function checkedInteger(field: Field, value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < (field.min ?? -Infinity) ||
		value > (field.max ?? Infinity)
	)
		throw new Error("Invalid integer");
	return value;
}
function selectedValue(field: Field, input: unknown, origin: Origin): Value {
	const value = origin === "env" ? parseEnvironment(field, input) : input;
	if (field.type === "boolean") {
		if (typeof value !== "boolean") throw new Error("Invalid boolean");
		return value;
	}
	if (field.type === "integer") return checkedInteger(field, value);
	if (!textValid(value) || !value.length || value.length > 4096) throw new Error("Invalid text");
	if (!field.choices?.includes(value)) throw new Error("Invalid choice");
	return value;
}
function addDiagnostic(diagnostics: Diagnostic[], fact: Diagnostic): void {
	if (diagnostics.length < 256) diagnostics.push(fact);
	else if (!diagnostics.some((item) => item.code === "coverage"))
		diagnostics.push(diagnostic("coverage", "file", "coverage"));
}
function ownSection(document: Record<string, unknown> | undefined, diagnostics: Diagnostic[]): Record<string, unknown> {
	const value = document && Object.hasOwn(document, settings.slice) ? document[settings.slice] : undefined;
	if (value === undefined) return {};
	if (!object(value)) {
		diagnostics.push(diagnostic(settings.slice, "file", "invalid"));
		return {};
	}
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(settings.fields, key))
			addDiagnostic(diagnostics, diagnostic(`${settings.slice}.${unknownKey(key)}`, "file", "unknown"));
	}
	return value;
}
function safeDefault(key: string, field: Field): Value {
	try {
		const raw = field.default;
		if (raw === undefined) throw new Error("No default");
		return selectedValue(field, raw, "default");
	} catch {
		throw new Error(`Invalid default for ${settings.slice}.${key}`);
	}
}
function selectField(
	key: string,
	field: Field,
	fallback: Value,
	section: Record<string, unknown>,
	options: ReadOptions,
	diagnostics: Diagnostic[],
): SettingRecord {
	const env = options.env ?? process.env;
	let value = fallback;
	let origin: Origin = "default";
	let invalid = false;
	const selectedOrigin = env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : undefined;
	if (selectedOrigin !== undefined) {
		try {
			value = selectedValue(field, selectedOrigin === "env" ? env[field.env] : section[key], selectedOrigin);
			origin = selectedOrigin;
		} catch {
			invalid = true;
			addDiagnostic(diagnostics, diagnostic(`${settings.slice}.${key}`, selectedOrigin, "invalid"));
		}
	}
	return {
		name: `${settings.slice}.${key}`,
		key,
		type: field.type,
		description: field.description,
		env: field.env,
		secret: false,
		origin,
		status: invalid ? "invalid" : "valid",
		value,
	};
}

export function readSettings(options: ReadOptions): Snapshot {
	const { source, document, diagnostics } = readDocument(options);
	const values: Record<string, Value> = Object.create(null);
	const records: SettingRecord[] = [];
	const section = ownSection(document, diagnostics);
	for (const [key, field] of Object.entries(settings.fields) as [string, Field][]) {
		const record = selectField(key, field, safeDefault(key, field), section, options, diagnostics);
		values[key] = record.value as Value;
		records.push(record);
	}
	return { version: 1, slice: settings.slice, source, values: values as DraftSettings, records, diagnostics };
}

export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void {
	const publish = () => {
		const snapshot = readSettings(options);
		const publication: SettingsPublication = {
			version: 1,
			slice: snapshot.slice,
			source: snapshot.source,
			records: snapshot.records,
			diagnostics: snapshot.diagnostics,
		};
		if (Buffer.byteLength(JSON.stringify(publication)) > 262144)
			throw new Error("Settings publication exceeds byte limit");
		bus.emit(SETTINGS_PUBLISH, structuredClone(publication));
	};
	const unsubscribe = bus.on(SETTINGS_REQUEST, (value) => {
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
