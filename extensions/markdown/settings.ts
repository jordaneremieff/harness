import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { invalidCheckField, type CheckOverrides } from "./check-rules.ts";

export const settings = {
	slice: "markdown",
	fields: {
		app: {
			type: "path",
			env: "PI_MARKDOWN_APP",
			defaultText: "<agentDir>/markdown-reader/Markdown Reader.app",
			description: "Installed native reader application and headless parser tool.",
		},
		dir: {
			type: "path",
			env: "PI_MARKDOWN_DIR",
			defaultText: "<agentDir>/markdown",
			description: "Private directory for Markdown documents.",
		},
		composer: {
			type: "enum",
			env: "PI_MARKDOWN_COMPOSER",
			choices: ["manual", "auto"],
			default: "manual",
			description:
				"Composer mode. manual opens the native composer only through /compose; auto opens it automatically in an ordinary interactive Pi session in Rex with a capable macOS reader. No mode disables /compose.",
		},
		checks: {
			type: "enum", env: "PI_MARKDOWN_CHECKS", choices: ["off", "warn", "block"], default: "block",
			description: "Writing checks for new Markdown publications and updates. off skips validation, warn saves and reports findings, and block refuses a publication with findings. Exact captures and saved replays are unchanged.",
		},
		checksRules: {
			type: "json", env: "PI_MARKDOWN_CHECKS_RULES", default: {},
			description: "Rule overrides and an optional lexicon path for publication checks and the writing brief.",
		},
		readerFile: {
			type: "path", env: "PI_MARKDOWN_READER_FILE", defaultText: "<agentDir>/markdown-reader.md",
			description: "Optional plain Markdown reader profile for the writing brief.",
		},
		agentPane: {
			type: "enum",
			env: "PI_MARKDOWN_AGENT_PANE",
			choices: ["split", "float"],
			default: "split",
			description:
				"Pane in which the markdown_publish guidance of an ordinary session shows a publication. split names a split on the right of the session's own pane; float names a floating pane over its window. Agents without a pane of their own, such as Durable workers, always use a floating pane on the tab of the ordinary session that started them. An operator's request for another pane still applies, and /markdown always opens a split. A new or reloaded session applies a change.",
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
type EnumKey = "composer" | "agentPane" | "checks";
export type CheckMode = Choice<"checks">;
type Choice<K extends EnumKey> = (typeof settings.fields)[K]["choices"][number];
export type AgentPane = Choice<"agentPane">;
type Values = { app: string; dir: string; composer: Choice<"composer">; agentPane: AgentPane; checks: CheckMode; checksRules: CheckOverrides; readerFile: string };
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
	type: "path" | "enum" | "json";
	description: string;
	env: string;
	secret: boolean;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	value?: unknown;
};
export type SettingsPublication = {
	version: 1;
	slice: string;
	source: Source;
	records: SettingRecord[];
	diagnostics: Diagnostic[];
};

export type Snapshot = SettingsPublication & { values: Values; checksIssue?: string };
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
function defaultPath(agentDir: string, key: Exclude<Key, EnumKey | "checksRules">): string {
	try {
		return checked(resolve(agentDir, { dir: "markdown", app: "markdown-reader/Markdown Reader.app", readerFile: "markdown-reader.md" }[key]), agentDir);
	} catch {
		throw new Error(`Invalid default for markdown.${key}`);
	}
}
const isEnum = (key: Key): key is EnumKey => settings.fields[key].type === "enum";
function choice<K extends EnumKey>(key: K, value: unknown): Choice<K> {
	if (typeof value !== "string" || !(settings.fields[key].choices as readonly string[]).includes(value))
		throw new Error(`Invalid markdown.${key} choice`);
	return value as Choice<K>;
}
type Selection = { value: string; origin: Origin; invalid: boolean };
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
		if (!Object.hasOwn(settings.fields, key))
			add(diagnostic(unknownField(key), "file", "unknown"));
	}
	return { source, section, diagnostics, add };
}
function selectField(
	key: Exclude<Key, "checksRules">,
	fallback: Selection["value"],
	section: Record<string, unknown>,
	options: ReadOptions,
	add: (fact: Diagnostic) => void,
): Selection {
	const field = settings.fields[key];
	const name = `${settings.slice}.${key}`;
	const env = options.env ?? process.env;
	const invalid = false;

	const origin = env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : undefined;
	if (origin === undefined) return { value: fallback, origin: "default", invalid };
	try {
		const input = origin === "env" ? env[field.env] : section[key];
		const value = isEnum(key) ? choice(key, input) : checked(input, options.agentDir);
		return { value, origin, invalid };
	} catch {
		add(diagnostic(name, origin, "invalid"));
		return { value: fallback, origin: "default", invalid: true };
	}
}
function settingRecord(key: Key, selected: Omit<Selection, "value"> & { value: unknown }): SettingRecord {
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
function boundedJson(input: unknown): boolean {
	let nodes = 0;
	function visit(value: unknown, depth: number): boolean {
		if (++nodes > 10000 || depth > 32) return false;
		if (value === null || typeof value === "boolean") return true;
		if (typeof value === "number") return Number.isFinite(value);
		if (typeof value === "string") return value.length <= DOCUMENT_MAX_BYTES && !/[\u0000\ud800-\udfff]/u.test(value);
		if (Array.isArray(value)) return value.every((child) => visit(child, depth + 1));
		return object(value) && Object.entries(value).every(([key, child]) => textValid(key) && key.length <= 4096 && visit(child, depth + 1));
	}
	return visit(input, 0) && Buffer.byteLength(JSON.stringify(input)) <= DOCUMENT_MAX_BYTES;
}
function selectRuleOverrides(section: Record<string, unknown>, env: Environment): { value: CheckOverrides; origin: Origin; issue?: string; invalid: boolean } {
	const raw = env[settings.fields.checksRules.env];
	const origin = raw !== undefined ? "env" : Object.hasOwn(section, "checksRules") ? "file" : "default";
	if (origin === "default") return { value: {}, origin, invalid: false };
	let field = "checksRules";
	try {
		if (raw !== undefined && Buffer.byteLength(raw) > DOCUMENT_MAX_BYTES) throw new Error("Oversized value");
		const input: unknown = raw === undefined ? section.checksRules : JSON.parse(raw);
		if (!boundedJson(input)) throw new Error("Invalid JSON value");
		const invalid = invalidCheckField(input);
		if (!invalid) return { value: input as CheckOverrides, origin, invalid: false };
		field = invalid;
	} catch { /* Reject the selected input without echoing it. */ }
	return { value: {}, origin, invalid: true, issue: field };
}
export function readSettings(options: ReadOptions): Snapshot {
	const { source, section, diagnostics, add } = readSection(options);
	const selectedValues = Object.create(null) as Record<Exclude<Key, "checksRules">, string>;
	const overrides = selectRuleOverrides(section, options.env ?? process.env);
	const records: SettingRecord[] = [];
	for (const key of Object.keys(settings.fields) as Key[]) {
		if (key === "checksRules") {
			if (overrides.invalid) add(diagnostic("markdown.checksRules", overrides.origin, "invalid"));
			records.push(settingRecord(key, { ...overrides, origin: overrides.invalid ? "default" : overrides.origin }));
			continue;
		}
		const fallback = isEnum(key) ? settings.fields[key].default : defaultPath(options.agentDir, key);
		const selected = selectField(key, fallback, section, options, add);
		selectedValues[key] = selected.value;
		records.push(settingRecord(key, selected));
	}
	const values: Values = {
		app: selectedValues.app,
		dir: selectedValues.dir,
		composer: choice("composer", selectedValues.composer),
		agentPane: choice("agentPane", selectedValues.agentPane),
		checks: choice("checks", selectedValues.checks),
		checksRules: overrides.value,
		readerFile: selectedValues.readerFile,
	};
	return { version: 1, slice: settings.slice, source, values, records, diagnostics, ...(overrides.issue ? { checksIssue: `${overrides.origin === "env" ? settings.fields.checksRules.env : source.path}: markdown.${overrides.issue}` } : {}) };
}
export type SettingsBus = {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
};
export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void {
	const publish = () => {
		const { version, slice, source, records, diagnostics } = readSettings(options);
		const publication: SettingsPublication = { version, slice, source, records, diagnostics };
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
