/** Explicit discovery collections; checkpoints never enter handover lifecycle paths. */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { StashMeta } from "./format.ts";
import { redactSecrets } from "./redact.ts";
import { readSettings } from "./settings.ts";
import { validateStore } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export type StashCollection = "handovers" | "checkpoints";
export const CHECKPOINT_NOTICE = "Provisional working material, not durable memory or authority to resume. Read-only recovery does not change lifecycle state.";

export async function collectionDirectory(agentDir: string, collection: StashCollection = "handovers", retainedHandovers?: string): Promise<string> {
	if (collection !== "handovers" && collection !== "checkpoints") throw new Error("Invalid stash collection");
	if (collection === "handovers" && retainedHandovers !== undefined) return retainedHandovers;
	const settings = readSettings({ agentDir }).values;
	const handoverDirectory = retainedHandovers ?? settings.dir;
	if (collection === "handovers") return handoverDirectory;
	const directory = settings.checkpointDir;
	if (resolve(directory) === resolve(handoverDirectory)) throw new Error("The checkpoint directory must differ from stash.dir.");
	if (await validateStore(directory, false)) {
		const handovers = await validateStore(handoverDirectory, false);
		if (handovers && await realpath(directory) === await realpath(handoverDirectory))
			throw new Error("The checkpoint directory must differ from stash.dir.");
	}
	return directory;
}

export function collectionId(id: string, collection: StashCollection = "handovers"): string {
	return collection === "checkpoints" ? `checkpoint:${id}` : id;
}

export function artifactId(id: string, collection: StashCollection = "handovers"): string {
	if (collection === "checkpoints") {
		if (!/^checkpoint:[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))
			throw new Error("Checkpoint reads require the checkpoint: identifier from stash_list with collection checkpoints.");
		return id.slice("checkpoint:".length);
	}
	if (id.includes(":")) throw new Error("A checkpoint identifier requires collection checkpoints; handover actions do not accept it.");
	return id;
}

export function collectionFilter(collection: StashCollection | undefined, state: string | undefined): void {
	if (collection === "checkpoints" && state !== undefined)
		throw new Error("Checkpoints are provisional working material, not handover lifecycle records; omit state.");
}

/** Bounded and credential-safe provenance stays visible beside provisional results. */
export function checkpointMetadata(meta: Partial<StashMeta>) {
	const field = (value: string | undefined) => value === undefined ? null : Array.from(sanitizeTerminalText(redactSecrets(value)).text).slice(0, 512).join("");
	return { source: field(meta.sessionId), workspace: field(meta.project) };
}
