import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import type { Dir, Dirent, FSWatcher } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { CACHE_BYTES, CACHE_ROWS, readClaim, readRecord, RECORD_BYTES, storageName } from "./catalog-record.mts";
import type { CatalogEntry, CatalogScan, CatalogUpdate } from "./catalog-state.mts";
import { initialScan, retainedRows } from "./catalog-state.mts";

export const SEGMENT_ENTRIES = 4096;
export const SEGMENT_BYTES = 8 * 1024 * 1024;
export const UPDATE_BYTES = 256 * 1024;
type Directory = Pick<Dir, "read" | "close">;
type Watcher = Pick<FSWatcher, "close" | "on">;
export interface InventoryDependencies {
	readCatalogRecord?: typeof readRecord;
	openDirectory?: (root: string) => Promise<Directory>;
	watchDirectory?: (root: string, hint: (name: string | Buffer | null) => void) => Watcher;
}
interface Stored {
	entry: CatalogEntry;
	bytes: number;
	generation: number;
	omitted: number;
}

/** The iterator and file work stay in the worker; named hints never enumerate. */
export class CatalogInventory {
	readonly root: string;
	private readonly emit: (update: CatalogUpdate) => unknown;
	private readonly dependencies: InventoryDependencies;
	private directory?: Directory;
	private watcher?: Watcher;
	private records = new Map<string, Stored>();
	private hints = new Set<string>();
	private scan = initialScan();
	private generation = 0;
	private bytes = 0;
	private rows = 0;
	private stale = false;
	private observedAt?: string;
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	private changed = new Set<string>();
	private removed = new Set<string>();
	private hintScheduled = false;
	private hintRevision = 0;
	private scanHintRevision = 0;
	private directoryIdentity?: string;
	constructor(store: string, emit: (update: CatalogUpdate) => unknown, dependencies: InventoryDependencies = {}) {
		this.root = join(resolve(store), "durable");
		this.emit = emit;
		this.dependencies = dependencies;
	}
	private serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = this.queue.then(action);
		this.queue = result.catch(() => {});
		return result;
	}
	private markStale(): void {
		this.stale = true;
		this.hintRevision++;
	}
	hint(name: string | Buffer | null): void {
		if (this.closed) return;
		if (name === null) this.markStale();
		else {
			const filename = name.toString();
			if (filename.endsWith(".json")) {
				try {
					storageName(filename.slice(0, -5));
					if (this.hints.size >= SEGMENT_ENTRIES) this.markStale();
					else this.hints.add(filename);
				} catch {
					this.markStale();
				}
			} else if (!filename || filename === "durable") this.markStale();
		}
		if (!this.hintScheduled) {
			this.hintScheduled = true;
			void this.serialize(async () => {
				this.hintScheduled = false;
				if (this.closed) return;
				if (this.directory) {
					if (this.hints.size) this.markStale();
				} else await this.reconcileHints();
				await this.publish();
			});
		}
	}
	private async checkDirectory(): Promise<void> {
		const stat = await lstat(this.root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Catalog root is not a directory");
		const identity = `${stat.dev}:${stat.ino}`;
		if (this.directoryIdentity && identity !== this.directoryIdentity) {
			this.markStale();
			this.watcher?.close();
			this.watcher = undefined;
			if (this.directory) throw new Error("Catalog directory was replaced");
		}
		this.directoryIdentity = identity;
	}
	private async installWatch(): Promise<void> {
		if (this.watcher) return;
		try {
			await this.checkDirectory();
			this.watcher = this.dependencies.watchDirectory
				? this.dependencies.watchDirectory(this.root, (name) => this.hint(name))
				: watch(this.root, (_event, name) => this.hint(name));
			this.watcher.on("error", () => {
				this.markStale();
				this.watcher?.close();
				this.watcher = undefined;
				this.hint(null);
			});
			this.watcher.on("close", () => {
				if (!this.closed) this.hint(null);
			});
		} catch {
			this.markStale();
		}
	}
	private drop(id: string): void {
		const old = this.records.get(id);
		if (!old) return;
		this.bytes -= old.bytes;
		this.rows -= old.entry.rows.length;
		this.records.delete(id);
		this.changed.delete(id);
		this.removed.add(id);
	}
	private async load(filename: string, discovery: boolean): Promise<number> {
		const id = filename.slice(0, -5);
		if (!discovery && !this.records.has(id)) {
			this.markStale();
			return 0;
		}
		try {
			const { record, bytes } = await (this.dependencies.readCatalogRecord ?? readRecord)(this.root, id);
			const claim = await readClaim(record);
			const rows = retainedRows(record, claim);
			const entry = { record, rows };
			const size = Buffer.byteLength(JSON.stringify(entry));
			const old = this.records.get(id);
			if (
				this.records.size - (old ? 1 : 0) >= CACHE_ROWS ||
				this.rows - (old?.entry.rows.length ?? 0) + rows.length > CACHE_ROWS ||
				this.bytes - (old?.bytes ?? 0) + size > CACHE_BYTES
			) {
				this.drop(id);
				this.scan.omitted += Math.max(1, rows.length);
				return bytes;
			}
			this.drop(id);
			this.removed.delete(id);
			const omitted = record.view?.coverage.omitted ?? 0;
			this.records.set(id, { entry, bytes: size, generation: this.generation, omitted });
			this.bytes += size;
			this.rows += rows.length;
			this.changed.add(id);
			return bytes;
		} catch (error) {
			this.drop(id);
			if (discovery) this.scan.skipped++;
			else if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.markStale();
			return RECORD_BYTES;
		}
	}
	private async reconcileHints(budget = SEGMENT_BYTES): Promise<void> {
		let bytes = 0,
			visited = 0;
		for (const name of this.hints) {
			if (visited++ >= SEGMENT_BYTES / RECORD_BYTES || bytes + RECORD_BYTES > budget) {
				this.markStale();
				this.scan.state = "running";
				this.scan.complete = false;
				break;
			}
			this.hints.delete(name);
			bytes += await this.load(name, false);
		}
	}
	private currentScan(): CatalogScan {
		const scan = { ...this.scan };
		for (const stored of this.records.values()) scan.omitted += stored.omitted;
		return scan;
	}
	private async publish(): Promise<void> {
		const finalScan = this.currentScan();
		const batches: CatalogUpdate[] = [];
		const fresh = (): CatalogUpdate => ({
			entries: [],
			removed: [],
			scan: { ...finalScan, state: "running", complete: false },
			stale: this.stale,
			observedAt: this.observedAt,
		});
		let batch = fresh(),
			bytes = 2048;
		const add = (size: number): void => {
			if (bytes + size > UPDATE_BYTES) {
				batches.push(batch);
				batch = fresh();
				bytes = 2048;
			}
			bytes += size;
		};
		for (const id of this.removed) {
			add(Buffer.byteLength(JSON.stringify(id)) + 1);
			batch.removed.push(id);
		}
		for (const id of this.changed) {
			const stored = this.records.get(id);
			if (stored) {
				add(stored.bytes + 1);
				batch.entries.push(stored.entry);
			}
		}
		batch.scan = finalScan;
		batches.push(batch);
		this.changed.clear();
		this.removed.clear();
		for (const update of batches) await this.emit(update);
	}
	private async closeDirectory(): Promise<void> {
		const directory = this.directory;
		this.directory = undefined;
		if (directory) await directory.close().catch(() => {});
	}
	private async startScan(): Promise<void> {
		await this.closeDirectory();
		this.generation++;
		this.scan = { ...initialScan(), scanId: randomUUID(), state: "running" };
		await this.installWatch();
		this.scanHintRevision = this.hintRevision;
		await this.checkDirectory();
		this.directory = await (this.dependencies.openDirectory
			? this.dependencies.openDirectory(this.root)
			: opendir(this.root, { bufferSize: 32 }));
	}
	private async finishScan(): Promise<void> {
		await this.closeDirectory();
		for (const [id, stored] of this.records) if (stored.generation !== this.generation) this.drop(id);
		this.scan.state = "ready";
		this.scan.complete = true;
		this.stale = this.hintRevision !== this.scanHintRevision || !this.watcher;
	}
	private async segment(): Promise<void> {
		let visited = 0,
			bytes = 0,
			complete = false;
		await this.checkDirectory();
		while (visited < SEGMENT_ENTRIES && bytes + RECORD_BYTES <= SEGMENT_BYTES) {
			const item: Dirent | null = (await this.directory?.read()) ?? null;
			if (!item) {
				complete = true;
				break;
			}
			visited++;
			this.scan.visited++;
			if (item.name.endsWith(".json")) bytes += await this.load(item.name, true);
		}
		await this.reconcileHints(SEGMENT_BYTES - bytes);
		if (complete && this.hints.size === 0) await this.finishScan();
		this.observedAt = new Date().toISOString();
	}
	refresh(scanId?: string): Promise<CatalogScan> {
		return this.serialize(async () => {
			if (this.closed) throw new Error("Catalog is closed");
			if (scanId !== undefined && ((!this.directory && this.hints.size === 0) || this.scan.scanId !== scanId))
				throw new Error("Invalid catalog continuation");
			try {
				if (scanId === undefined) await this.startScan();
				await this.segment();
			} catch (error) {
				await this.closeDirectory();
				this.scan.state = "failed";
				this.scan.complete = false;
				this.scan.error =
					(error as NodeJS.ErrnoException).code === "ENOENT" ? "Catalog directory is absent" : "Catalog scan failed";
				this.markStale();
			}
			await this.publish();
			return this.currentScan();
		});
	}
	settled(): Promise<void> {
		return this.serialize(async () => {});
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.serialize(async () => {
			await this.closeDirectory();
			this.watcher?.close();
			this.watcher = undefined;
			this.hints.clear();
			this.records.clear();
		});
	}
}

if (parentPort) {
	const port = parentPort;
	let serial = 0;
	const acknowledgments = new Map<number, () => void>();
	const inventory = new CatalogInventory(
		(workerData as { store: string }).store,
		(update) =>
			new Promise<void>((resolve) => {
				const batchId = ++serial;
				acknowledgments.set(batchId, resolve);
				port.postMessage({ kind: "update", update, batchId });
			}),
	);
	port.on("message", (message: { id: number; kind: string; scanId?: string; batchId?: number }) => {
		if (message.kind === "ack" && message.batchId !== undefined) {
			acknowledgments.get(message.batchId)?.();
			acknowledgments.delete(message.batchId);
			return;
		}
		const action = message.kind === "close" ? inventory.close() : inventory.refresh(message.scanId);
		void action.then(
			(result) => {
				port.postMessage({ kind: "response", id: message.id, result });
				if (message.kind === "close") port.close();
			},
			() => port.postMessage({ kind: "response", id: message.id, error: "Catalog request refused" }),
		);
	});
}
