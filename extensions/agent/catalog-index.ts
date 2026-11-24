import { stat } from "node:fs/promises";
import type { AgentCatalog, CatalogRecord } from "./catalog.ts";

/** One record of a catalog index read: `value` is undefined when the record exists and could not be read or validated. */
export interface CatalogIndexEntry<T> {
	storageId: string;
	value: T | undefined;
	unreadable: boolean;
}
/** Records between yields of an index read, so a pass over a large catalog never holds the event loop. */
const INDEX_BATCH = 64;
const INDEX_ROOTS = 4;
/**
 * One derived value per catalog record, kept in this process by record file stamp. A read lists the
 * catalog directory and stats each record; it reads and validates only the records whose file changed
 * since the previous read, through `AgentCatalog.derive`. Values are shared between reads: `project`
 * returns plain data that no reader changes.
 *
 * The catalog writes, replaces and removes a record only by link, rename or unlink in its directory,
 * so an unchanged directory stamp (identity and modification time, taken before the listing) proves
 * that no record changed: such a read returns the previous entries after one stat.
 */
export class CatalogIndex<T> {
	private readonly project: (record: CatalogRecord) => T;
	private readonly roots = new Map<
		string,
		{
			directory: string | undefined;
			records: Map<string, { fileStamp: string; value: T }>;
			entries: readonly CatalogIndexEntry<T>[];
		}
	>();
	constructor(project: (record: CatalogRecord) => T) {
		this.project = project;
	}

	/** Every record of the catalog in storage ID order. */
	async read(catalog: AgentCatalog): Promise<CatalogIndexEntry<T>[]> {
		const directory = await directoryStamp(catalog.root);
		const previous = this.roots.get(catalog.root);
		if (directory !== undefined && previous?.directory === directory) return [...previous.entries];
		const identities = await catalog.identities();
		const known = previous?.records;
		const current = new Map<string, { fileStamp: string; value: T }>();
		const entries: CatalogIndexEntry<T>[] = [];
		for (let index = 0; index < identities.length; index++) {
			if (index > 0 && index % INDEX_BATCH === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			const storageId = identities[index];
			try {
				const retained = known?.get(storageId);
				const entry =
					retained !== undefined && catalog.recordStamp(storageId) === retained.fileStamp
						? retained
						: catalog.derive(storageId, this.project);
				current.set(storageId, entry);
				entries.push({ storageId, value: entry.value, unreadable: false });
			} catch (error) {
				// A record removed since the listing is absent, not unreadable.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					entries.push({ storageId, value: undefined, unreadable: true });
			}
		}
		this.roots.delete(catalog.root);
		if (this.roots.size >= INDEX_ROOTS) this.roots.clear();
		this.roots.set(catalog.root, { directory, records: current, entries: [...entries] });
		return entries;
	}
}

/** The directory's identity and modification time, or undefined when it cannot be read. */
async function directoryStamp(root: string): Promise<string | undefined> {
	try {
		const info = await stat(root, { bigint: true });
		return `${info.dev}:${info.ino}:${info.mtimeNs}`;
	} catch {
		return undefined;
	}
}
