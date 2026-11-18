import { resolve } from "node:path";
import { boundedFile } from "./reference-capture.ts";
import type { CheckMode, Snapshot } from "./settings.ts";
import type { CheckOverrides } from "./check-rules.ts";

export type WritingOptions = { mode: CheckMode; overrides?: CheckOverrides; issue?: string; lexiconFile?: string; readerFile?: string };
export function writingOptions(agentDir: string, snapshot: Snapshot): WritingOptions {
	const { checks: mode, checksRules: overrides, readerFile } = snapshot.values;
	return { mode, overrides, readerFile, issue: snapshot.checksIssue, lexiconFile: overrides.lexicon ? resolve(agentDir, overrides.lexicon) : undefined };
}

export class WritingConfigError extends Error {}
async function readText(path: string, field: string, max: number, optional: boolean): Promise<string | undefined> {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode((await boundedFile(path, max)).data);
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw new WritingConfigError(`${field} (${JSON.stringify(path)}): expected a readable UTF-8 text file of at most ${max} bytes.`);
	}
}
export async function loadLexicon(options: WritingOptions): Promise<ReadonlySet<string> | undefined> {
	if (options.issue) throw new WritingConfigError(`${options.issue} is invalid.`);
	if (!options.lexiconFile) return undefined;
	const text = await readText(options.lexiconFile, "markdown.checksRules.lexicon", 2 * 1024 * 1024, false);
	return new Set(text?.split(/\r?\n/u).map((term) => term.trim().toLowerCase()).filter(Boolean));
}
export async function loadReader(options: WritingOptions): Promise<string | undefined> {
	if (options.readerFile) return readText(options.readerFile, "markdown.readerFile", 4096, true);
}
