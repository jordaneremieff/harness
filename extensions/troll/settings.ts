import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const settings = {
	slice: "troll",
	fields: {
		model: {
			apply: "use",
			type: "string",
			env: "PI_TROLL_MODEL",
			minLength: 1,
			maxLength: 200,
			description:
				"Model of the troll session, in the form pi --model accepts, such as provider/id. Unset starts the troll on Pi's default model.",
		},
		thinkingLevel: {
			apply: "use",
			type: "enum",
			env: "PI_TROLL_THINKING_LEVEL",
			choices: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			description:
				"Thinking level of the troll session. Unset uses Pi's default thinking level. Pi clamps the level to the model's capabilities.",
		},
		width: {
			apply: "use",
			type: "number",
			env: "PI_TROLL_WIDTH",
			default: 0.34,
			min: 0.1,
			max: 0.9,
			description: "Width of the troll pane as a fraction of the tab's width.",
		},
		height: {
			apply: "use",
			type: "number",
			env: "PI_TROLL_HEIGHT",
			min: 0.1,
			max: 0.9,
			description:
				"Height of the troll pane as a fraction of the tab's height. Unset makes the pane square: its height follows its width and the tab's shape on screen.",
		},
		left: {
			apply: "use",
			type: "number",
			env: "PI_TROLL_LEFT",
			default: 0.01,
			min: 0,
			max: 0.1,
			description: "Gap between the tab's left edge and the troll pane, as a fraction of the tab's width.",
		},
		top: {
			apply: "use",
			type: "number",
			env: "PI_TROLL_TOP",
			default: 0.016,
			min: 0,
			max: 0.1,
			description: "Gap between the tab's top edge and the troll pane, as a fraction of the tab's height.",
		},
	},
} as const;

type Fields = typeof settings.fields;
type Key = keyof Fields;
type ThinkingLevel = Fields["thinkingLevel"]["choices"][number];
export interface TrollSettings {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	width: number;
	height?: number;
	left: number;
	top: number;
}
type Origin = "env" | "file" | "default";
type Diagnostic = { field: string; source: Origin; code: string; message: string };
export interface SettingsBus {
	on(name: string, listener: (payload: unknown) => void): () => void;
	emit(name: string, payload: unknown): void;
}
type ReadOptions = { agentDir: string; env?: Readonly<Record<string, string | undefined>> };
type SettingRecord = {
	name: string;
	key: string;
	type: string;
	description: string;
	env: string;
	secret: false;
	origin: Origin;
	status: "valid" | "unset" | "invalid";
	value?: string | number;
};
export interface SettingsSnapshot {
	version: 2;
	slice: "troll";
	source: {
		path: string;
		status: "loaded" | "missing" | "invalid" | "unavailable";
		digest: string | null;
		observedAt: string;
	};
	records: SettingRecord[];
	diagnostics: Diagnostic[];
	values: TrollSettings;
}
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const validText = (value: unknown, max = 4096): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const messages = {
	document: "Configuration document is invalid or unavailable.",
	unknown: "Unknown setting in this section.",
	invalid: "Selected input is invalid; the safe default is in effect.",
	coverage: "Additional diagnostics were omitted at the diagnostic limit.",
} as const;
type AddDiagnostic = (field: string, origin: Origin, code: keyof typeof messages) => void;

function readDocumentBytes(fd: number): Buffer {
	const stat = fstatSync(fd);
	if (!stat.isFile() || stat.size > 131072) throw new Error("invalid source");
	const bytes = Buffer.alloc(131073);
	let length = 0;
	while (length < bytes.length) {
		const size = readSync(fd, bytes, length, bytes.length - length, null);
		if (size === 0) break;
		length += size;
	}
	if (length > 131072) throw new Error("oversized source");
	return bytes.subarray(0, length);
}

function documentSection(
	content: Buffer,
	source: SettingsSnapshot["source"],
	add: AddDiagnostic,
): Record<string, unknown> {
	source.digest = createHash("sha256").update(content).digest("hex");
	if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) throw new Error("BOM");
	const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
	if (!object(document) || document.version !== 1) throw new Error("invalid envelope");
	source.status = "loaded";
	if (document.troll === undefined) return {};
	if (object(document.troll)) return document.troll;
	add("troll", "file", "invalid");
	return {};
}

function readSection(
	path: string,
	selectedPath: string | undefined,
	source: SettingsSnapshot["source"],
	add: AddDiagnostic,
): Record<string, unknown> {
	let fd: number | undefined;
	try {
		if (selectedPath !== undefined && !validText(selectedPath)) throw new Error("invalid path");
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		return documentSection(readDocumentBytes(fd), source, add);
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "ENOENT" ||
			(selectedPath !== undefined && !validText(selectedPath))
		) {
			source.status = (error as NodeJS.ErrnoException).code === "EACCES" ? "unavailable" : "invalid";
			add("document", "file", "document");
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return {};
}

function unknownKeySuffix(key: string): string {
	let suffix = "";
	for (const char of key) {
		if (suffix.length + char.length > 64) break;
		suffix += char;
	}
	return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(key) ? "<invalid-key>" : suffix;
}

type FieldBounds = { type: string; min?: number; max?: number; maxLength?: number; choices?: readonly string[] };

function acceptedNumber(field: FieldBounds, origin: Origin, selected: unknown): number | undefined {
	let value = selected;
	if (origin === "env") {
		try {
			value = JSON.parse(selected as string);
		} catch {
			return undefined;
		}
	}
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity) ? value : undefined;
}

/** Returns the accepted value, or undefined when the selected input is invalid. */
function accepted(key: Key, origin: Origin, selected: unknown): string | number | undefined {
	const field: FieldBounds = settings.fields[key];
	if (field.type === "number") return acceptedNumber(field, origin, selected);
	if (field.type === "enum")
		return typeof selected === "string" && field.choices?.includes(selected) ? selected : undefined;
	return validText(selected, field.maxLength) ? selected : undefined;
}

function settingRecord(
	key: Key,
	section: Record<string, unknown>,
	env: Readonly<Record<string, string | undefined>>,
	add: AddDiagnostic,
): SettingRecord {
	const field = settings.fields[key];
	const fallback = "default" in field ? field.default : undefined;
	const selectedOrigin: Origin =
		env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : "default";
	let origin = selectedOrigin;
	let value: string | number | undefined = fallback;
	let status: SettingRecord["status"] = fallback === undefined ? "unset" : "valid";
	if (selectedOrigin !== "default") {
		value = accepted(key, selectedOrigin, selectedOrigin === "env" ? env[field.env] : section[key]);
		status = "valid";
		if (value === undefined) {
			add(`troll.${key}`, selectedOrigin, "invalid");
			value = fallback;
			origin = "default";
			status = "invalid";
		}
	}
	return {
		name: `troll.${key}`,
		key,
		type: field.type,
		description: field.description,
		env: field.env,
		secret: false,
		origin,
		status,
		...(value === undefined ? {} : { value }),
	};
}

const thinkingLevels: readonly string[] = settings.fields.thinkingLevel.choices;
export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
	typeof value === "string" && thinkingLevels.includes(value);

function trollValues(records: readonly SettingRecord[]): TrollSettings {
	const selected = new Map(records.map((record) => [record.key, record.value]));
	const number = (key: Key, fallback: number) => {
		const value = selected.get(key);
		return typeof value === "number" ? value : fallback;
	};
	const model = selected.get("model");
	const thinkingLevel = selected.get("thinkingLevel");
	const height = selected.get("height");
	return {
		width: number("width", settings.fields.width.default),
		left: number("left", settings.fields.left.default),
		top: number("top", settings.fields.top.default),
		...(typeof height === "number" ? { height } : {}),
		...(typeof model === "string" ? { model } : {}),
		...(isThinkingLevel(thinkingLevel) ? { thinkingLevel } : {}),
	};
}

export function readSettings(options: ReadOptions): SettingsSnapshot {
	const env = options.env ?? process.env;
	const selectedPath = env.PI_HARNESS_FILE;
	const path =
		selectedPath === undefined ? resolve(options.agentDir, "harness.json") : resolve(options.agentDir, selectedPath);
	const source: SettingsSnapshot["source"] = {
		path,
		status: "missing",
		digest: null,
		observedAt: new Date().toISOString(),
	};
	const diagnostics: Diagnostic[] = [];
	const add: AddDiagnostic = (field, origin, code) => {
		if (diagnostics.length < 256) diagnostics.push({ field, source: origin, code, message: messages[code] });
		else if (diagnostics.length === 256)
			diagnostics.push({ field: "coverage", source: "file", code: "coverage", message: messages.coverage });
	};
	const section = readSection(path, selectedPath, source, add);
	for (const key of Object.keys(section)) {
		if (!Object.hasOwn(settings.fields, key)) add(`troll.${unknownKeySuffix(key)}`, "file", "unknown");
	}
	const records = (Object.keys(settings.fields) as Key[]).map((key) => settingRecord(key, section, env, add));
	return { version: 2, slice: "troll", source, records, diagnostics, values: trollValues(records) };
}

type SettingsPublication = Omit<SettingsSnapshot, "values"> & { declaration: typeof settings };

function bounded<T>(value: T): T {
	if (Buffer.byteLength(JSON.stringify(value)) > 262144) throw new Error("Settings payload exceeds byte limit");
	return structuredClone(value);
}

function publication(options: ReadOptions): SettingsPublication {
	const { slice, source, records, diagnostics } = readSettings(options);
	return bounded({ version: 2, slice, declaration: settings, source, records, diagnostics });
}

export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void {
	const publish = () => bus.emit("harness:settings:publish", publication(options));
	const off = bus.on("harness:settings:request", (value) => {
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
