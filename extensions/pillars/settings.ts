import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";
const DOCUMENT_MAX_BYTES = 131072;
export type Environment = Readonly<Record<string, string | undefined>>;
export type ReadOptions = { agentDir: string; env?: Environment };
export type Origin = "env" | "file" | "default";
export type Diagnostic = {
	field: string;
	source: Origin;
	code: "document" | "unknown" | "invalid" | "coverage";
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
/** The corpus ships beside the extension in one package. */
export function defaultCorpusRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../pillars");
}
export const settings = {
	slice: "pillars",
	fields: {
		dir: {
			type: "path",
			env: "PI_PILLARS_DIR",
			description: "Private aggregate directory.",
			absolute: true,
			defaultText: "<agentDir>/pillars",
		},
		corpus: {
			type: "path",
			env: "PI_PILLARS_CORPUS",
			description: "Corpus root with inventory and governance sources.",
			absolute: true,
			defaultText: "Package sibling ../../pillars",
		},
		collect: {
			type: "boolean",
			env: "PI_PILLARS_COLLECT",
			description: "Collect source access evidence.",
			default: true,
		},
	},
} as const;
export type Snapshot = SettingsPublication & { values: { dir: string; corpus: string; collect: boolean } };
type Field = {
	type: "path" | "boolean";
	env: string;
	description: string;
	default?: boolean;
	defaultText?: string;
	absolute?: boolean;
};

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

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function textValid(value: unknown): value is string {
	return typeof value === "string" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}
function parseEnvironment(field: Field, raw: unknown): unknown {
	if (typeof raw !== "string" || Buffer.byteLength(raw) > DOCUMENT_MAX_BYTES)
		throw new Error("Invalid environment input");
	if (field.type === "boolean") {
		if (raw === "1" || raw === "true") return true;
		if (raw === "0" || raw === "false") return false;
		return undefined;
	}

	return raw;
}
function checkedPath(input: unknown, field: Field, agentDir: string): string {
	if (!textValid(input) || !input.length || input.length > 4096 || (field.absolute && !isAbsolute(input)))
		throw new Error("Invalid path");
	const path = resolve(agentDir, input);
	if (path.length > 4096) throw new Error("Resolved path exceeds length bound");
	return path;
}

function selectedValue(field: Field, input: unknown, origin: Origin, agentDir: string): string | number | boolean {
	const value = origin === "env" ? parseEnvironment(field, input) : input;
	if (field.type === "path") return checkedPath(value, field, agentDir);
	if (field.type === "boolean") {
		if (typeof value !== "boolean") throw new Error("Invalid boolean");
		return value;
	}
	throw new Error("Unknown field type");
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
			addDiagnostic(
				diagnostics,
				diagnostic(`${settings.slice}.${unknownKey(key)}`, "file", "unknown"),
			);
	}
	return value;
}
function safeDefault(key: string, field: Field, agentDir: string): string | number | boolean | undefined {
	try {
		let value: string | number | boolean | undefined = field.default;
		if (key === "dir") value = join(agentDir, "pillars");
		if (key === "corpus") value = defaultCorpusRoot();
		return value === undefined ? undefined : selectedValue(field, value, "default", agentDir);
	} catch {
		throw new Error(`Invalid default for ${settings.slice}.${key}`);
	}
}
function selectField(
	key: string,
	field: Field,
	fallback: string | number | boolean | undefined,
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
			value = selectedValue(
				field,
				selectedOrigin === "env" ? env[field.env] : section[key],
				selectedOrigin,
				options.agentDir,
			);
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
		status: invalid ? "invalid" : value === undefined ? "unset" : "valid",
		...(value === undefined ? {} : { value }),
	};
}
export function readSettings(options: ReadOptions): Snapshot {
	const { source, document, diagnostics } = readDocument(options);
	const values: Record<string, string | number | boolean | undefined> = Object.create(null);
	const records: SettingRecord[] = [];
	const section = ownSection(document, diagnostics);
	for (const [key, field] of Object.entries(settings.fields) as [string, Field][]) {
		const fallback = safeDefault(key, field, options.agentDir);
		const record = selectField(key, field, fallback, section, options, diagnostics);
		values[key] = record.value;
		records.push(record);
	}
	return { version: 1, slice: settings.slice, source, values: values as Snapshot["values"], records, diagnostics };
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
