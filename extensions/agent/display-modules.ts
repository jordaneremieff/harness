import { pathToFileURL } from "node:url";
import { DurableInventorySchema } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { resolveDisplayEntry } from "./display-descriptor.ts";
import { presentationRecords, type ToolDisplayLookup } from "./tool-display.ts";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";

/** Presentation records collected from one attached host's admitted inventory. */
export interface DisplayModules {
	readonly lookup: ToolDisplayLookup;
	/** One bounded line per contribution whose display module could not be used. */
	readonly diagnostics: readonly string[];
}

export const noDisplayModules: DisplayModules = Object.freeze({ lookup: () => undefined, diagnostics: [] });

const bounded = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 160);

type Importer = (url: string) => Promise<Record<string, unknown>>;
type Contribution = { name: string; source: string; display?: { version: 1; entry: string; export: "toolDisplay" } };

async function readModule(contribution: Contribution & { display: NonNullable<Contribution["display"]> }, importModule: Importer): Promise<ReadonlyMap<string, ToolRenderers>> {
	const entry = resolveDisplayEntry(contribution.source, contribution.display);
	const exported = (await importModule(pathToFileURL(entry).href))[contribution.display.export];
	if (typeof exported !== "function") throw new Error(`export ${contribution.display.export} is not a function`);
	const records = presentationRecords(exported());
	if (!records) throw new Error("publication is not version 1");
	return records;
}

/**
 * Import each advertised display module and keep its checked renderer records.
 * Each failure stays with its contribution: the other modules and the standard card remain usable.
 * The caller scopes the result to one attached source; nothing here is cached across sources.
 */
export async function loadDisplayModules(inventory: unknown, importModule: Importer = (url) => import(url)): Promise<DisplayModules> {
	if (!matchesSchema(DurableInventorySchema, inventory)) return { lookup: () => undefined, diagnostics: ["Host inventory is not readable; standard tool cards are used."] };
	const renderers = new Map<string, ToolRenderers>();
	const diagnostics: string[] = [];
	for (const contribution of inventory.contributions) {
		if (!contribution.display) continue;
		try {
			const duplicates: string[] = [];
			for (const [name, presentation] of await readModule({ ...contribution, display: contribution.display }, importModule)) {
				if (renderers.has(name)) duplicates.push(name);
				else renderers.set(name, presentation);
			}
			if (duplicates.length) diagnostics.push(bounded(`${contribution.name}: ${duplicates.join(", ")} already supplied by an earlier module`));
		} catch (error) {
			diagnostics.push(bounded(`${contribution.name}: display module unavailable (${error instanceof Error ? error.message : String(error)}); standard cards are used`));
		}
	}
	return { lookup: (name) => renderers.get(name), diagnostics };
}
