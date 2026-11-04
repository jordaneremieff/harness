import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Package contract: docs/conventions/tool-display.md. */
export interface DisplayDescriptor {
	readonly version: 1;
	readonly entry: string;
	readonly export: "toolDisplay";
}

/** Package contract: docs/conventions/operator-panels.md. */
export interface PanelDescriptor {
	readonly version: 1;
	readonly entry: string;
	readonly export: "operatorPanel";
	/** A command of the same contribution that serves the panel's requests. */
	readonly command: string;
}

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

function readRecord(value: unknown, kind: string, fields: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${kind} descriptor must be an object`);
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some(key => !fields.includes(key))) throw new Error(`${kind} descriptor has unknown fields`);
	return record;
}

/** A bare relative file path under the owner directory: no empty, `.` or `..` segment, URL, drive, query, fragment or control character. */
function readEntry(value: unknown, kind: string): string {
	if (typeof value !== "string" || !value.startsWith("./") || /[\\:?#\u0000-\u0020\u007f-\u009f]/u.test(value) || value.slice(2).split("/").some(part => part === "" || part === "." || part === "..")) {
		throw new Error(`${kind} entry must be a bare relative file path inside its owner directory`);
	}
	return value;
}

/** Accept only a local module identity, never an import URL or parent path. */
export function readDisplayDescriptor(value: unknown): DisplayDescriptor {
	const record = readRecord(value, "Display", ["version", "entry", "export"]);
	if (record.version !== 1 || record.export !== "toolDisplay") throw new Error("Display descriptor requires version 1 and export toolDisplay");
	return { version: 1, entry: readEntry(record.entry, "Display"), export: "toolDisplay" };
}

/** The panel descriptor adds the owner command that serves its requests; the host checks that command exists. */
export function readPanelDescriptor(value: unknown): PanelDescriptor {
	const record = readRecord(value, "Panel", ["version", "entry", "export", "command"]);
	if (record.version !== 1 || record.export !== "operatorPanel") throw new Error("Panel descriptor requires version 1 and export operatorPanel");
	if (typeof record.command !== "string" || !COMMAND_NAME.test(record.command)) throw new Error("Panel descriptor requires the name of an owner command");
	return { version: 1, entry: readEntry(record.entry, "Panel"), export: "operatorPanel", command: record.command };
}

/** Bind an entry to its canonical admitted owner and refuse symlink escapes. */
function resolveOwnedEntry(source: string, entry: string, kind: string): string {
	if (!isAbsolute(source)) throw new Error(`${kind} source must be an absolute file path`);
	const canonicalSource = realpathSync(source);
	if (!statSync(canonicalSource).isFile()) throw new Error(`${kind} source must be a file`);
	const owner = dirname(canonicalSource);
	const resolved = realpathSync(resolve(owner, entry));
	const inside = relative(owner, resolved);
	if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !statSync(resolved).isFile()) throw new Error(`${kind} entry escapes its owner directory or is not a file`);
	return resolved;
}

export function resolveDisplayEntry(source: string, descriptor: DisplayDescriptor): string {
	return resolveOwnedEntry(source, readDisplayDescriptor(descriptor).entry, "Display");
}

export function resolvePanelEntry(source: string, descriptor: PanelDescriptor): string {
	return resolveOwnedEntry(source, readPanelDescriptor(descriptor).entry, "Panel");
}
