import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Package contract: docs/conventions/tool-display.md. */
export interface DisplayDescriptor {
	readonly version: 1;
	readonly entry: string;
	readonly export: "toolDisplay";
}

/** Accept only a local module identity, never an import URL or parent path. */
export function readDisplayDescriptor(value: unknown): DisplayDescriptor {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Display descriptor must be an object");
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || record.export !== "toolDisplay") throw new Error("Display descriptor requires version 1 and export toolDisplay");
	if (Object.keys(record).some(key => !["version", "entry", "export"].includes(key))) throw new Error("Display descriptor has unknown fields");
	const entry = record.entry;
	if (typeof entry !== "string" || !entry.startsWith("./") || /[\\:?#\u0000-\u0020\u007f-\u009f]/u.test(entry) || entry.slice(2).split("/").some(part => part === "" || part === "." || part === "..")) {
		throw new Error("Display entry must be a bare relative file path inside its owner directory");
	}
	return { version: 1, entry, export: "toolDisplay" };
}

/** Bind an entry to its canonical admitted owner and refuse symlink escapes. */
export function resolveDisplayEntry(source: string, descriptor: DisplayDescriptor): string {
	if (!isAbsolute(source)) throw new Error("Display source must be an absolute file path");
	const canonicalSource = realpathSync(source);
	if (!statSync(canonicalSource).isFile()) throw new Error("Display source must be a file");
	const owner = dirname(canonicalSource);
	const entry = realpathSync(resolve(owner, readDisplayDescriptor(descriptor).entry));
	const inside = relative(owner, entry);
	if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !statSync(entry).isFile()) throw new Error("Display entry escapes its owner directory or is not a file");
	return entry;
}
