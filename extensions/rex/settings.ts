import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const settings = {
	slice: "rex",
	fields: {
		executable: { type: "string", env: "PI_REX_EXECUTABLE", default: "rex", minLength: 1, maxLength: 4096, description: "Installed Rex executable name or path. The extension uses the supported CLI without a shell." },
		maxOutputBytes: { type: "integer", env: "PI_REX_MAX_OUTPUT_BYTES", default: 32768, min: 4096, max: 1048576, description: "Maximum combined stdout/stderr bytes retained from one Rex CLI process. Core results have a separate aggregate bound. Capture is not a complete transcript." },
		maxWaitMs: { type: "integer", env: "PI_REX_MAX_WAIT_MS", default: 30000, min: 1000, max: 300000, description: "Deadline cap for each Rex CLI process, in milliseconds. An operation can use several processes. Deadline cancellation does not stop persistent terminal work." },
		maxRecords: { type: "integer", env: "PI_REX_MAX_RECORDS", default: 128, min: 2, max: 256, description: "Maximum retained ownership and operation records per caller." },
	},
} as const;

type Origin = "env" | "file" | "default";
type Diagnostic = { field: string; source: Origin; code: string; message: string };
export interface SettingsBus {
	on(name: string, listener: (payload: unknown) => void): () => void;
	emit(name: string, payload: unknown): void;
}
export interface RexSettings {
	executable: string;
	maxOutputBytes: number;
	maxWaitMs: number;
	maxRecords: number;
}
export interface SettingsSnapshot {
	version: 1;
	slice: "rex";
	source: { path: string; status: "loaded" | "missing" | "invalid" | "unavailable"; digest: string | null; observedAt: string };
	records: Array<{ name: string; key: string; type: string; description: string; env: string; secret: false; origin: Origin; status: "valid" | "invalid"; value: string | number }>;
	diagnostics: Diagnostic[];
	values: RexSettings;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const messages = {
	document: "Configuration document is invalid or unavailable.",
	unknown: "Unknown setting in this section.",
	invalid: "Selected input is invalid; the safe default is in effect.",
	coverage: "Additional diagnostics were omitted at the diagnostic limit.",
} as const;

export function readSettings(options: { agentDir: string; env?: Readonly<Record<string, string | undefined>> }): SettingsSnapshot {
	const env = options.env ?? process.env;
	const selectedPath = env.PI_HARNESS_FILE;
	const path = selectedPath === undefined ? resolve(options.agentDir, "harness.json") : resolve(options.agentDir, selectedPath);
	const source: SettingsSnapshot["source"] = { path, status: "missing", digest: null, observedAt: new Date().toISOString() };
	const diagnostics: Diagnostic[] = [];
	const add = (field: string, origin: Origin, code: keyof typeof messages) => {
		if (diagnostics.length < 256) diagnostics.push({ field, source: origin, code, message: messages[code] });
		else if (diagnostics.length === 256) diagnostics.push({ field: "coverage", source: "file", code: "coverage", message: messages.coverage });
	};
	let section: Record<string, unknown> = {};
	let fd: number | undefined;
	try {
		if (selectedPath !== undefined && !validText(selectedPath)) throw new Error("invalid path");
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
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
		const content = bytes.subarray(0, length);
		source.digest = createHash("sha256").update(content).digest("hex");
		if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) throw new Error("BOM");
		const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
		if (!object(document) || document.version !== 1) throw new Error("invalid envelope");
		source.status = "loaded";
		if (document.rex !== undefined) {
			if (object(document.rex)) section = document.rex;
			else add("rex", "file", "invalid");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (selectedPath !== undefined && !validText(selectedPath))) {
			source.status = (error as NodeJS.ErrnoException).code === "EACCES" ? "unavailable" : "invalid";
			add("document", "file", "document");
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	for (const key of Object.keys(section)) {
		if (Object.hasOwn(settings.fields, key)) continue;
		let suffix = "";
		for (const char of key) { if (suffix.length + char.length > 64) break; suffix += char; }
		if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(key)) suffix = "<invalid-key>";
		add(`rex.${suffix}`, "file", "unknown");
	}
	const values = {} as RexSettings;
	const records: SettingsSnapshot["records"] = [];
	for (const key of Object.keys(settings.fields) as Array<keyof RexSettings>) {
		const field = settings.fields[key];
		const fallback = field.default;
		let origin: Origin = env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : "default";
		let value: unknown = origin === "env" ? env[field.env] : origin === "file" ? section[key] : fallback;
		let valid = true;
		if (field.type === "integer") {
			if (origin === "env") {
				try { value = JSON.parse(value as string); } catch { valid = false; }
			}
			valid = valid && typeof value === "number" && Number.isSafeInteger(value) && value >= field.min && value <= field.max;
		} else valid = validText(value);
		const status = valid ? "valid" : "invalid";
		if (!valid) {
			add(`rex.${key}`, origin, "invalid");
			value = fallback;
			origin = "default";
		}
		Object.assign(values, { [key]: value });
		records.push({ name: `rex.${key}`, key, type: field.type, description: field.description, env: field.env, secret: false, origin, status, value: value as string | number });
	}
	return { version: 1, slice: "rex", source, records, diagnostics, values };
}

export function publishSettings(bus: SettingsBus, options: { agentDir: string; env?: Readonly<Record<string, string | undefined>> }): () => void {
	const publish = () => {
		const { values: _values, ...publication } = readSettings(options);
		bus.emit("harness:settings:publish", publication);
	};
	const stop = bus.on("harness:settings:request", (payload) => { if (object(payload) && payload.version === 1) publish(); });
	publish();
	return stop;
}
