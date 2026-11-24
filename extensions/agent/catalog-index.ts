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
 * A directory modified less than this long before its stat may change again within the same
 * timestamp tick (about 1 µs on APFS, 1 s on HFS+, a coarse kernel tick on Linux), so its stamp
 * cannot prove a later read unchanged. The margin also covers clock skew.
 */
export const CATALOG_INDEX_STAMP_MARGIN_MS = 2000;
/** The catalog directory's identity and modification time, or undefined when it cannot be read. */
export interface CatalogDirectoryStamp {
	readonly stamp: string;
	readonly modifiedMs: number;
}
/**
 * One derived value per catalog record, kept in this process by record file stamp. A read lists the
 * catalog directory and stats each record; it reads and validates only the records whose file changed
 * since the previous read, through `AgentCatalog.derive`. Values are shared between reads: `project`
 * returns plain data that no reader changes.
 *
 * The catalog writes, replaces and removes a record only by link, rename or unlink in its directory,
 * so an unchanged directory stamp (identity and modification time, taken before the listing) proves
 * that no record changed: such a read returns the previous entries after one stat. As in Git's
 * racy-clean rule, only a stamp whose modification time was older than the margin when it was
 * taken is kept for that proof; a recently modified directory is listed again at every read.
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
	private readonly now: () => number;
	private readonly directoryStamp: (root: string) => Promise<CatalogDirectoryStamp | undefined>;
	constructor(
		project: (record: CatalogRecord) => T,
		options: {
			now?: () => number;
			directoryStamp?: (root: string) => Promise<CatalogDirectoryStamp | undefined>;
		} = {},
	) {
		this.project = project;
		this.now = options.now ?? Date.now;
		this.directoryStamp = options.directoryStamp ?? readDirectoryStamp;
	}

	/** The directory stamp when it is old enough to prove a later read unchanged, otherwise undefined. */
	private async provingStamp(root: string): Promise<string | undefined> {
		const stamped = await this.directoryStamp(root);
		return stamped !== undefined && this.now() - stamped.modifiedMs >= CATALOG_INDEX_STAMP_MARGIN_MS
			? stamped.stamp
			: undefined;
	}

	/** One record's entry, reusing its retained value while its file stamp is unchanged; undefined once removed. */
	private entry(
		catalog: AgentCatalog,
		storageId: string,
		known: Map<string, { fileStamp: string; value: T }> | undefined,
		current: Map<string, { fileStamp: string; value: T }>,
	): CatalogIndexEntry<T> | undefined {
		try {
			const retained = known?.get(storageId);
			const entry =
				retained !== undefined && catalog.recordStamp(storageId) === retained.fileStamp
					? retained
					: catalog.derive(storageId, this.project);
			current.set(storageId, entry);
			return { storageId, value: entry.value, unreadable: false };
		} catch (error) {
			// A record removed since the listing is absent, not unreadable.
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? undefined
				: { storageId, value: undefined, unreadable: true };
		}
	}

	/** Every record of the catalog in storage ID order. */
	async read(catalog: AgentCatalog): Promise<CatalogIndexEntry<T>[]> {
		const directory = await this.provingStamp(catalog.root);
		const previous = this.roots.get(catalog.root);
		if (directory !== undefined && previous?.directory === directory) return [...previous.entries];
		const identities = await catalog.identities();
		const known = previous?.records;
		const current = new Map<string, { fileStamp: string; value: T }>();
		const entries: CatalogIndexEntry<T>[] = [];
		for (let index = 0; index < identities.length; index++) {
			if (index > 0 && index % INDEX_BATCH === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			const entry = this.entry(catalog, identities[index], known, current);
			if (entry !== undefined) entries.push(entry);
		}
		this.roots.delete(catalog.root);
		if (this.roots.size >= INDEX_ROOTS) this.roots.clear();
		// A record that failed to read may read next time without a directory change, so such a read
		// proves nothing about later ones.
		const proven = entries.some((entry) => entry.unreadable) ? undefined : directory;
		this.roots.set(catalog.root, { directory: proven, records: current, entries: [...entries] });
		return entries;
	}
}

async function readDirectoryStamp(root: string): Promise<CatalogDirectoryStamp | undefined> {
	try {
		const info = await stat(root, { bigint: true });
		return { stamp: `${info.dev}:${info.ino}:${info.mtimeNs}`, modifiedMs: Number(info.mtimeNs / 1_000_000n) };
	} catch {
		return undefined;
	}
}
