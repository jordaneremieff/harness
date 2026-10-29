import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SETTINGS_PUBLISH, SETTINGS_REQUEST, type Diagnostic, type Origin, type SettingsBus, type SettingsPublication, type Source } from "./configuration-protocol.ts";

export const settings = {
	slice: "registry",
	fields: {
		notes: { type: "boolean", env: "PI_REGISTRY_NOTES", default: true,
			description: "Append bounded registry facts to matching completed discovery calls. Read fresh for each matching call." },
	},
} as const;
export type ReadOptions = { agentDir: string; env?: Readonly<Record<string, string | undefined>> };
export type Snapshot = SettingsPublication & { values: { notes: boolean } };
const messages = {
	document: "Configuration document is invalid or unavailable.",
	unknown: "Unknown setting in this section.",
	invalid: "Selected input is invalid; the safe default is in effect.",
	coverage: "Additional diagnostics were omitted at the diagnostic limit.",
};
function diagnostic(field: string, source: Origin, code: keyof typeof messages): Diagnostic {
	return { field, source, code, message: messages[code] };
}
function text(value: unknown): value is string {
	return typeof value === "string" && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function documentPath(options: ReadOptions): string {
	if (!isAbsolute(options.agentDir) || !text(options.agentDir) || options.agentDir.length > 4096)
		throw new Error("agentDir must be an absolute directory path");
	const override = (options.env ?? process.env).PI_HARNESS_FILE;
	if (override !== undefined && (!text(override) || !override.length || override.length > 4096))
		throw new Error("PI_HARNESS_FILE must be a nonempty path");
	const path = resolve(options.agentDir, override ?? "harness.json");
	if (path.length > 4096) throw new Error("Configuration path exceeds length limit");
	return path;
}
function boundedRead(fd: number): Buffer {
	const bytes = Buffer.alloc(131073);
	let length = 0;
	while (length < bytes.length) {
		const count = readSync(fd, bytes, length, bytes.length - length, length);
		if (!count) break;
		length += count;
	}
	return bytes.subarray(0, length);
}
function readDocument(options: ReadOptions): { source: Source; document?: Record<string, unknown>; diagnostics: Diagnostic[] } {
	const source: Source = { path: documentPath({ agentDir: options.agentDir, env: {} }),
		status: "unavailable", digest: null, observedAt: new Date().toISOString() };
	try { source.path = documentPath(options); }
	catch { return { source, diagnostics: [diagnostic("PI_HARNESS_FILE", "env", "document")] }; }
	let fd: number | undefined;
	let readComplete = false;
	try {
		fd = openSync(source.path, constants.O_RDONLY | constants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) throw new Error("Nonregular source");
		const content = boundedRead(fd);
		readComplete = true;
		if (content.length > 131072) throw new Error("Oversized document");
		source.digest = createHash("sha256").update(content).digest("hex");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content));
		if (!object(value) || value.version !== 1) throw new Error("Invalid document envelope");
		return { source: { ...source, status: "loaded" }, document: value, diagnostics: [] };
	} catch (error) {
		if (object(error) && error.code === "ENOENT") return { source: { ...source, status: "missing" }, diagnostics: [] };
		return { source: { ...source, status: readComplete ? "invalid" : "unavailable" }, diagnostics: [diagnostic("document", "file", "document")] };
	} finally { if (fd !== undefined) closeSync(fd); }
}
function readSection(options: ReadOptions) {
	const { source, document, diagnostics } = readDocument(options);
	const sectionValue = document && Object.hasOwn(document, "registry") ? document.registry : undefined;
	const section = object(sectionValue) ? sectionValue : {};
	if (sectionValue !== undefined && !object(sectionValue)) diagnostics.push(diagnostic("registry", "file", "invalid"));
	for (const key of Object.keys(section)) {
		if (key === "notes") continue;
		if (diagnostics.length >= 256) { diagnostics.push(diagnostic("coverage", "file", "coverage")); break; }
		let suffix = text(key) ? key.slice(0, 64) : "<invalid-key>";
		if (/[\ud800-\udbff]$/.test(suffix)) suffix = suffix.slice(0, -1);
		diagnostics.push(diagnostic(`registry.${suffix}`, "file", "unknown"));
	}
	return { source, section, diagnostics };
}
function addDiagnostic(diagnostics: Diagnostic[], fact: Diagnostic): void {
	if (diagnostics.length < 256) diagnostics.push(fact);
	else if (!diagnostics.some((item) => item.code === "coverage")) diagnostics.push(diagnostic("coverage", "file", "coverage"));
}
function selectNotes(section: Record<string, unknown>, options: ReadOptions, diagnostics: Diagnostic[]) {
	const env = options.env ?? process.env;
	let origin: Origin = env.PI_REGISTRY_NOTES !== undefined ? "env" : Object.hasOwn(section, "notes") ? "file" : "default";
	const input = origin === "env" ? env.PI_REGISTRY_NOTES : origin === "file" ? section.notes : true;
	let value = true;
	let invalid = false;
	if (origin === "env" && ["true", "false", "0", "1"].includes(input as string)) value = input === "true" || input === "1";
	else if (origin !== "env" && typeof input === "boolean") value = input;
	else { addDiagnostic(diagnostics, diagnostic("registry.notes", origin, "invalid")); origin = "default"; invalid = true; }
	return { value, origin, invalid };
}
export function readSettings(options: ReadOptions): Snapshot {
	const { source, section, diagnostics } = readSection(options);
	const { value, origin, invalid } = selectNotes(section, options, diagnostics);
	return { version: 1, slice: "registry", source, diagnostics, values: { notes: value }, records: [{
		name: "registry.notes", key: "notes", type: "boolean", env: settings.fields.notes.env,
		description: settings.fields.notes.description, secret: false, origin,
		status: invalid ? "invalid" : "valid", value,
	}] };
}
export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void {
	const publish = () => {
		const { values: _values, ...publication } = readSettings(options);
		bus.emit(SETTINGS_PUBLISH, structuredClone(publication));
	};
	const off = bus.on(SETTINGS_REQUEST, (input) => { if (object(input) && input.version === 1) publish(); });
	try { publish(); } catch (error) { off(); throw error; }
	return off;
}
