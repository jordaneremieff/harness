import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, runInContext } from "node:vm";
const base = new URL("../", import.meta.url);
export function scripts(files: string[], globals: Record<string, unknown> = {}) {
	const context = createContext({ console, TextEncoder, structuredClone, setTimeout, clearTimeout, ...globals });
	for (const file of files)
		runInContext(stripTypeScriptTypes(readFileSync(new URL(file, base), "utf8"), { mode: "strip" }), context, {
			filename: file,
		});
	return context as unknown as { reader: ReaderCoreAPI } & Record<string, unknown>;
}
export function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
