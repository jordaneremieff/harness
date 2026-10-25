import {RECENTS_CONVERSATION_LIMIT,type RecentConversations} from '../../extensions/agent/recents.ts';
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { CatalogRecord } from "./catalog-record.mts";
import type { CatalogEntry, CatalogPage, CatalogRow, CatalogScan, CatalogUpdate } from "./catalog-state.mts";
import { compareRosterRows, initialScan } from "./catalog-state.mts";
import {retainedTarget} from "./contract.mts";
import {LIMITS} from "../shared/api.ts";
export { deriveEndpoint, readClaim } from "./catalog-record.mts";
export type { CatalogRecord, ClaimObservation, ClaimOptions, WriterClaim } from "./catalog-record.mts";
export type { CatalogPage, CatalogRow, CatalogScan } from "./catalog-state.mts";
export interface AgentCatalogOptions {
	store: string;
	onChange?: (page: CatalogPage) => void;
  readRecents?: (identity:string,conversationIds:number[]) => Promise<RecentConversations>;
}
interface Pending {
	resolve: (value: CatalogScan) => void;
	reject: (error: Error) => void;
}

function recentIds(entry:CatalogEntry):number[] {
  const ids=new Set<number>();
  for(const row of entry.rows){try {const target=retainedTarget(row.id);if(target.storageId===entry.record.storageId)ids.add(target.conversationId);}catch{}}
  return [...ids].slice(0,RECENTS_CONVERSATION_LIMIT);
}
/** Paging stays cached; exact misses request bounded named reads without a host. */
export class AgentCatalog {
	private readonly worker: Worker;
	private readonly onChange?: (page: CatalogPage) => void;
  private readonly readRecents?: AgentCatalogOptions['readRecents'];
  private readonly recentsPending = new Set<string>();
  private readonly recentsReading = new Set<string>();
  private recentsActive = 0;
  private recentsTimer?: ReturnType<typeof setTimeout>;
	private readonly entries = new Map<string, CatalogEntry>();
	private rows: CatalogRow[] = [];
	private incompletePublications = 0;
	private scan = initialScan();
	/** Whether a scan has run, is running, or ended: a catalog that has finished one scan is not empty because it is new. */
	get scanState(): CatalogScan["state"] {
		return this.scan.state;
	}
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
		this.onChange = options.onChange;this.readRecents=options.readRecents;
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
      this.retainRecents(entry);
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
		await this.publishDeltas(changed, removed);this.pumpRecents();
	}
  private retainRecents(entry:CatalogEntry):void {
    const prior=this.entries.get(entry.record.storageId);
    entry.recentsReadAt=prior?.recentsReadAt;entry.recentsRevision=prior?.recentsRevision;
    const previous=new Map(prior?.rows.map(row=>[row.id,row.recents]));
    for(const row of entry.rows){const retained=previous.get(row.id);if(retained)row.recents={...retained,...row.recents};}
    const ids=recentIds(entry),root=entry.rows.find(row=>row.id===entry.record.storageId);
    if(!ids.length||!ids.some(id=>id!==1)&&root?.recents?.creator!=='operator')return;
    if(entry.recentsRevision!==entry.record.view?.updatedAt||!entry.recentsReadAt)this.recentsPending.add(entry.record.storageId);
  }
  /** One retained snapshot enriches published conversations per storage after publication changes. */
  private pumpRecents():void {
    if(this.closed||!this.readRecents)return;
    if(this.recentsTimer){clearTimeout(this.recentsTimer);this.recentsTimer=undefined;}
    let delay=Infinity;
    for(const id of this.recentsPending){
      if(this.recentsActive>=2)break;
      if(this.recentsReading.has(id))continue;
      const entry=this.entries.get(id);
      if(!entry){this.recentsPending.delete(id);continue;}
      const wait=(entry.recentsReadAt??-Infinity)+30_000-Date.now();
      if(wait>0){delay=Math.min(delay,wait);continue;}
      this.recentsPending.delete(id);entry.recentsReadAt=Date.now();entry.recentsRevision=entry.record.view?.updatedAt;
      this.recentsActive++;this.recentsReading.add(id);
      void this.readRecents(id,recentIds(entry)).then(facts=>this.applyRecents(id,facts)).catch(()=>{}).finally(()=>{this.recentsActive--;this.recentsReading.delete(id);this.pumpRecents();});
    }
    if(Number.isFinite(delay)&&this.recentsActive<2)this.recentsTimer=setTimeout(()=>{this.recentsTimer=undefined;this.pumpRecents();},delay);
  }
  private async applyRecents(id:string,facts:RecentConversations):Promise<void> {
    const current=this.entries.get(id);if(this.closed||!current)return;
    const changed:CatalogRow[]=[];
    for(const item of facts.items){const identity=item.conversationId===1?id:`${id}:${item.conversationId}`,row=current.rows.find(value=>value.id===identity);if(row){row.recents=item.activity;changed.push(row);}}
    this.rows=[...this.entries.values()].flatMap(value=>value.rows).sort(compareRosterRows);this.revision++;
    await this.publishDeltas(changed,[]);
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
	private request(kind: string, scanId?: string, storageIds?: string[]): Promise<CatalogScan> {
		if (this.exited) return Promise.reject(new Error("Catalog worker exited"));
		const id = ++this.serial;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({ id, kind, scanId, storageIds });
		});
	}
	lookup(identities: string[]): Promise<CatalogScan> {
		if (this.closed) return Promise.reject(new Error("Catalog is closed"));
		const storages = [...new Set(identities.slice(0, LIMITS.identityLookup).flatMap(id => {
			try {return [retainedTarget(id).storageId];} catch {return [];}
		}))];
		return this.request("lookup", undefined, storages);
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
		this.closed = true;if(this.recentsTimer)clearTimeout(this.recentsTimer);this.recentsPending.clear();
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
