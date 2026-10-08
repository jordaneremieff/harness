import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { CatalogRecord } from "./catalog-record.mts";
import type { CatalogEntry, CatalogPage, CatalogRow, CatalogScan, CatalogUpdate } from "./catalog-state.mts";
import { compareRosterRows, initialScan } from "./catalog-state.mts";
export { deriveEndpoint, readClaim } from "./catalog-record.mts";
export type { CatalogRecord, ClaimObservation, ClaimOptions, WriterClaim } from "./catalog-record.mts";
export type { CatalogPage, CatalogRow, CatalogScan } from "./catalog-state.mts";
export interface AgentCatalogOptions {
	store: string;
	onChange?: (page: CatalogPage) => void;
}
interface Pending {
	resolve: (value: CatalogScan) => void;
	reject: (error: Error) => void;
}

/** Cached reads do not touch the filesystem or acquire a host. */
export class AgentCatalog {
	private readonly worker: Worker;
	private readonly onChange?: (page: CatalogPage) => void;
	private readonly entries = new Map<string, CatalogEntry>();
	private rows: CatalogRow[] = [];
	private incompletePublications = 0;
	private scan = initialScan();
	private observedAt?: string;
	private stale = false;
	private revision = 0;
	private serial = 0;
	private pending = new Map<number, Pending>();
	private inFlight?: Promise<CatalogScan>;
	private inFlightScanId?: string;
	private closed = false;
	private exited = false;
	private closing?: Promise<void>;
	constructor(options: AgentCatalogOptions) {
		if (!options.store) throw new Error("Catalog store is required");
		this.onChange = options.onChange;
		this.worker = new Worker(new URL("./catalog-worker.mts", import.meta.url), {
			workerData: { store: resolve(options.store) },
		});
		this.worker.on(
			"message",
			(message: {
				kind: string;
				update?: CatalogUpdate;
				id?: number;
				result?: CatalogScan;
				error?: string;
				batchId?: number;
			}) => {
				if (message.kind === "update" && message.update) {
					void this.update(message.update).finally(() =>
						this.worker.postMessage({ kind: "ack", batchId: message.batchId }),
					);
				} else if (message.id !== undefined) {
					const request = this.pending.get(message.id);
					this.pending.delete(message.id);
					if (message.error) request?.reject(new Error(message.error));
					else request?.resolve(message.result ?? this.scan);
				}
			},
		);
		this.worker.on("error", () => this.fail("Catalog worker failed"));
		this.worker.on("exit", () => {
			this.exited = true;
			if (!this.closed) this.fail("Catalog worker exited");
			else {
				for (const request of this.pending.values()) request.reject(new Error("Catalog worker exited"));
				this.pending.clear();
			}
		});
	}
	private fail(error: string): void {
		this.scan = { ...this.scan, state: "failed", complete: false, error };
		this.stale = true;
		for (const request of this.pending.values()) request.reject(new Error(error));
		this.pending.clear();
		this.changed();
	}
	private removeEntry(id: string): void {
		const prior = this.entries.get(id);
		if (prior && (!prior.record.view?.coverage.complete || prior.record.view.unavailable))
			this.incompletePublications--;
		this.entries.delete(id);
	}
	private async update(update: CatalogUpdate): Promise<void> {
		const changed = update.entries.flatMap((entry) => entry.rows).sort(compareRosterRows);
		const ids = new Set(changed.map((row) => row.id));
		const touched = new Set([...update.removed, ...update.entries.map((entry) => entry.record.storageId)]);
		const removed = [...touched]
			.flatMap((id) => this.entries.get(id)?.rows.map((row) => row.id) ?? [])
			.filter((id) => !ids.has(id));
		for (const id of update.removed) this.removeEntry(id);
		for (const entry of update.entries) {
			this.removeEntry(entry.record.storageId);
			this.entries.set(entry.record.storageId, entry);
			if (!entry.record.view?.coverage.complete || entry.record.view.unavailable) this.incompletePublications++;
		}
		if (changed.length || removed.length)
			this.rows = [...this.entries.values()].flatMap((entry) => entry.rows).sort(compareRosterRows);
		this.scan = update.scan;
		this.stale = update.stale;
		this.observedAt = update.observedAt;
		this.revision++;
		await this.publishDeltas(changed, removed);
	}
	private async publishDeltas(changed: CatalogRow[], removed: string[]): Promise<void> {
		let rows: CatalogRow[] = [],
			ids: string[] = [],
			bytes = 2048;
		const emit = async (): Promise<void> => {
			this.onChange?.({ ...this.metadata([], null), changed: structuredClone(rows), removed: [...ids] });
			rows = [];
			ids = [];
			bytes = 2048;
			await yieldTurn();
		};
		for (const row of changed) {
			const size = Buffer.byteLength(JSON.stringify(row)) + 1;
			if (bytes + size > 256 * 1024) await emit();
			rows.push(row);
			bytes += size;
		}
		for (const id of removed) {
			const size = Buffer.byteLength(JSON.stringify(id)) + 1;
			if (bytes + size > 256 * 1024) await emit();
			ids.push(id);
			bytes += size;
		}
		await emit();
	}
	private changed(): void {
		this.onChange?.({ ...this.metadata([], null), changed: [], removed: [] });
	}
	private request(kind: string, scanId?: string): Promise<CatalogScan> {
		if (this.exited) return Promise.reject(new Error("Catalog worker exited"));
		const id = ++this.serial;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({ id, kind, scanId });
		});
	}
	refresh(scanId?: string): Promise<CatalogScan> {
		if (this.closed) return Promise.reject(new Error("Catalog is closed"));
		if (this.inFlight) {
			if (scanId === undefined || scanId === this.inFlightScanId || scanId === this.scan.scanId) return this.inFlight;
			return Promise.reject(new Error("Another catalog scan is active"));
		}
		this.inFlightScanId = scanId;
		const result = this.request("refresh", scanId).finally(() => {
			this.inFlight = undefined;
			this.inFlightScanId = undefined;
		});
		this.inFlight = result;
		return result;
	}
	private cursorOffset(cursor?: string): number {
		if (cursor === undefined) return 0;
		if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("Invalid catalog cursor");
		const decoded = Buffer.from(cursor, "base64url").toString("utf8");
		const match = /^(\d+):(\d+)$/u.exec(decoded);
		if (!match || Number(match[1]) !== this.revision || !Number.isSafeInteger(Number(match[2])))
			throw new Error("Expired catalog cursor");
		const offset = Number(match[2]);
		if (offset > this.rows.length) throw new Error("Invalid catalog cursor offset");
		return offset;
	}
	page(options: { cursor?: string; limit?: number } = {}): CatalogPage {
		const limit = options.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Catalog page limit must be 1..100");
		const offset = this.cursorOffset(options.cursor);
		const rows: CatalogRow[] = [];
		let bytes = 2048;
		while (offset + rows.length < this.rows.length && rows.length < limit) {
			const row = this.rows[offset + rows.length];
			if (!row) break;
			const size = Buffer.byteLength(JSON.stringify(row));
			if (bytes + size > 256 * 1024) break;
			rows.push(structuredClone(row));
			bytes += size;
		}
		const nextOffset = offset + rows.length;
		const nextCursor =
			nextOffset < this.rows.length ? Buffer.from(`${this.revision}:${nextOffset}`).toString("base64url") : null;
		return this.metadata(rows, nextCursor);
	}
	private metadata(rows: CatalogRow[], nextCursor: string | null): CatalogPage {
		return {
			rows,
			nextCursor,
			coverage: {
				complete:
					this.scan.complete &&
					!nextCursor &&
					this.scan.skipped === 0 &&
					this.scan.omitted === 0 &&
					this.incompletePublications === 0,
				omitted: this.scan.omitted,
			},
			observedAt: this.observedAt,
			stale: this.stale,
			scan: { ...this.scan },
		};
	}
	get(storageId: string): CatalogRecord | undefined {
		const record = this.entries.get(storageId)?.record;
		return record ? structuredClone(record) : undefined;
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			try {
				if (!this.exited) await this.request("close");
			} finally {
				await this.worker.terminate();
				for (const request of this.pending.values()) request.reject(new Error("Catalog is closed"));
				this.pending.clear();
			}
		})();
		return this.closing;
	}
}
