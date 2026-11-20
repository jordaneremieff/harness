import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const settings = {
	slice: "explorer",
	fields: {
		app: {
			apply: "reload",
			type: "path",
			env: "PI_EXPLORER_APP",
			defaultText: "<agentDir>/explorer-app/Explorer.app",
			description: "Installed native Explorer application.",
		},
		dir: {
			apply: "reload",
			type: "path",
			env: "PI_EXPLORER_DIR",
			defaultText: "<agentDir>/explorer",
			description: "Private directory for Explorer notes and review state.",
		},
		agentPane: {
			apply: "reload",
			type: "enum",
			env: "PI_EXPLORER_AGENT_PANE",
			choices: ["split", "float"],
			default: "split",
			description:
				"Pane in which an ordinary session shows an Explorer location. split names a split on the right of the session's own pane; float names a floating pane over its window. Agents without a pane of their own, such as Durable workers, always use a floating pane on the tab of the ordinary session that started them. An operator's request for another pane still applies, and /explorer always opens a split. A new or reloaded session applies a change.",
		},
		showIgnored: {
			apply: "use",
			type: "boolean",
			env: "PI_EXPLORER_SHOW_IGNORED",
			default: true,
			description:
				"Show Git-ignored files and folders in the Files list of a newly opened pane. Direct file access, Quick Open and content search are unchanged. Open panes keep their launch value.",
		},
	},
} as const;

const DOCUMENT_MAX_BYTES = 131072;
export const SETTINGS_PUBLISH = "harness:settings:publish";
export const SETTINGS_REQUEST = "harness:settings:request";
export type Environment = Readonly<Record<string, string | undefined>>;
export type Origin = "env" | "file" | "default";
export type ReadOptions = { agentDir: string; env?: Environment };
type Key = keyof typeof settings.fields;
type EnumKey = "agentPane";
type Choice<K extends EnumKey> = (typeof settings.fields)[K]["choices"][number];
export type AgentPane = Choice<"agentPane">;
type Values = { app: string; dir: string; agentPane: AgentPane; showIgnored: boolean };
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
	type: "path" | "enum" | "boolean";
	description: string;
	env: string;
	secret: boolean;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	value?: unknown;
};
export type SettingsPublication = {
	version: 2;
	declaration: typeof settings;
	slice: string;
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

function checked(value: unknown, agentDir: string): string {
	if (!textValid(value) || !value.length || value.length > 4096) throw new Error("Invalid directory");
	const path = resolve(agentDir, value);
	if (path.length > 4096) throw new Error("Resolved path exceeds length bound");
	return path;
}
function defaultPath(agentDir: string, key: "app" | "dir"): string {
	try {
		return checked(resolve(agentDir, { dir: "explorer", app: "explorer-app/Explorer.app" }[key]), agentDir);
	} catch {
		throw new Error(`Invalid default for explorer.${key}`);
	}
}
function choice<K extends EnumKey>(key: K, value: unknown): Choice<K> {
	if (typeof value !== "string" || !(settings.fields[key].choices as readonly string[]).includes(value))
		throw new Error(`Invalid explorer.${key} choice`);
	return value as Choice<K>;
}
function boolean(input: unknown, origin: Origin): boolean {
	if (origin === "env") {
		if (input === "true" || input === "1") return true;
		if (input === "false" || input === "0") return false;
	} else if (typeof input === "boolean") return input;
	throw new Error("Invalid boolean");
}
type Selection<T> = { value: T; origin: Origin; invalid: boolean };
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
function selectField<T>(
	key: Key,
	fallback: T,
	decode: (input: unknown, origin: Origin) => T,
	section: Record<string, unknown>,
	options: ReadOptions,
	add: (fact: Diagnostic) => void,
): Selection<T> {
	const field = settings.fields[key];
	const name = `${settings.slice}.${key}`;
	const env = options.env ?? process.env;
	const invalid = false;

	const origin = env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : undefined;
	if (origin === undefined) return { value: fallback, origin: "default", invalid };
	try {
		const input = origin === "env" ? env[field.env] : section[key];
		const value = decode(input, origin);
		return { value, origin, invalid };
	} catch {
		add(diagnostic(name, origin, "invalid"));
		return { value: fallback, origin: "default", invalid: true };
	}
}
function settingRecord(key: Key, selected: Selection<unknown>): SettingRecord {
	const field = settings.fields[key];
	const record: SettingRecord = {
		name: `${settings.slice}.${key}`,
		key,
		type: field.type,
		description: field.description,
		env: field.env,
		secret: false,
		origin: selected.origin,
		status: selected.invalid ? "invalid" : selected.value === undefined ? "unset" : "valid",
	};
	if (selected.value !== undefined) record.value = selected.value;
	return record;
}
export function readSettings(options: ReadOptions): Snapshot {
	const { source, section, diagnostics, add } = readSection(options);
	const records: SettingRecord[] = [];
	function select<K extends Key>(key: K, fallback: Values[K], decode: (input: unknown, origin: Origin) => Values[K]) {
		const selected = selectField(key, fallback, decode, section, options, add);
		records.push(settingRecord(key, selected));
		return selected.value;
	}
	const path = (input: unknown) => checked(input, options.agentDir);
	const values: Values = {
		app: select("app", defaultPath(options.agentDir, "app"), path),
		dir: select("dir", defaultPath(options.agentDir, "dir"), path),
		agentPane: select("agentPane", settings.fields.agentPane.default, (input) => choice("agentPane", input)),
		showIgnored: select("showIgnored", settings.fields.showIgnored.default, boolean),
	};
	return { version: 2, slice: settings.slice, source, values, records, diagnostics };
}
export type SettingsBus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};
function bounded<T>(value: T): T {
	if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw new Error("Settings payload exceeds byte limit");
	return structuredClone(value);
}

function publication(options: ReadOptions): SettingsPublication {
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
