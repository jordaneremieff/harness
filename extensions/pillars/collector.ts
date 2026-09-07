import { randomBytes } from "node:crypto";
import {
	addCounters,
	bytes,
	type Batch,
	type Cell,
	type CommitStatus,
	type HealthDelta,
	inWindow,
	key,
	LIMITS,
	safeAdd,
	zero,
} from "./capacity.ts";

export interface Publisher {
	commit(batch: Batch, today: string, signal?: AbortSignal): Promise<CommitStatus>;
}
export interface CollectorOptions {
	now?: () => number;
	diagnostic?: (message: string) => void;
}
export const utcDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);
export function folded(cell: Cell): Cell {
	return {
		...cell,
		resourceClass: "overflow",
		resourceId: "overflow",
		model: "other",
		reasoning: "unknown",
		referenceBodyDigest: "unresolved",
		observerVersion: "other",
		piVersion: "other",
		counters: {
			...cell.counters,
			bodyVerifiedAtObservation: 0,
			bodyMismatchedAtObservation: 0,
			bodyUnverifiable: cell.counters.readResults,
		},
	};
}

/** A sealed delta never changes after its first publication attempt. */
export class Collector {
	private readonly owner = randomBytes(16).toString("hex");
	private readonly now: () => number;
	private readonly diagnostic: (message: string) => void;
	private pending = new Map<string, Cell>();
	private health = new Map<string, HealthDelta>();
	private sequences = new Map<string, number>();
	private refused = new Set<string>();
	private sealed?: Batch;
	private active?: Promise<void>;
	private timer?: ReturnType<typeof setTimeout>;
	private lastAttempt = -Infinity;
	private first = true;
	private closed = false;
	private saturated = false;
	private throughDay = "";
	private readonly publisher: Publisher;
	constructor(publisher: Publisher, options: CollectorOptions = {}) {
		this.publisher = publisher;
		this.now = options.now ?? Date.now;
		this.diagnostic = options.diagnostic ?? (() => {});
	}
	get bufferedEvents(): number {
		let count = 0;
		for (const cell of this.pending.values())
			count = safeAdd(count, safeAdd(cell.counters.readRequests, cell.counters.readResults));
		for (const cell of this.sealed?.cells ?? [])
			count = safeAdd(count, safeAdd(cell.counters.readRequests, cell.counters.readResults));
		return count;
	}
	private prune(): boolean {
		const today = utcDay(this.now());
		if (today < this.throughDay) return false;
		this.throughDay = today;
		for (const [cellKey, cell] of this.pending) if (!inWindow(cell.day, today)) this.pending.delete(cellKey);
		for (const day of this.health.keys()) if (!inWindow(day, today)) this.health.delete(day);
		for (const day of this.sequences.keys()) if (!inWindow(day, today)) this.sequences.delete(day);
		for (const day of this.refused) if (!inWindow(day, today)) this.refused.delete(day);
		return true;
	}
	incident(name: keyof HealthDelta, count = 1): void {
		if (this.closed || this.saturated) return;
		if (!this.prune()) return;
		const day = utcDay(this.now());
		if (this.refused.has(day)) return;
		const health = this.health.get(day) ?? {};
		try {
			health[name] = safeAdd(health[name] ?? 0, count);
			this.health.set(day, health);
		} catch {
			this.saturated = true;
			this.diagnostic("Pillars access counters reached their limit. Unpersisted loss remains unknown.");
		}
	}
	admit(source: Cell): boolean {
		if (this.closed || this.saturated) return false;
		if (!this.prune()) return false;
		if (!inWindow(source.day, utcDay(this.now())) || this.refused.has(source.day)) return false;
		let cell = structuredClone(source),
			cellKey = key(cell);
		if (!this.pending.has(cellKey) && cell.resourceClass !== "overflow") {
			let normal = 0;
			for (const value of this.pending.values()) if (value.resourceClass !== "overflow") normal++;
			if (normal >= LIMITS.cellsPerDay) {
				cell = folded(cell);
				cellKey = key(cell);
			}
		}
		const previous = this.pending.get(cellKey);
		try {
			cell.counters = addCounters(previous?.counters ?? zero(), cell.counters);
			this.pending.set(cellKey, cell);
			if (bytes([...this.pending.values()]) + bytes([...this.health]) > LIMITS.shardBytes - 4096) {
				if (previous) this.pending.set(cellKey, previous);
				else this.pending.delete(cellKey);
				this.incident("pendingDroppedEvents", safeAdd(source.counters.readRequests, source.counters.readResults));
				return false;
			}
			return true;
		} catch {
			if (previous) this.pending.set(cellKey, previous);
			else this.pending.delete(cellKey);
			this.incident("pendingDroppedEvents", safeAdd(source.counters.readRequests, source.counters.readResults));
			return false;
		}
	}
	async observed(signal?: AbortSignal): Promise<void> {
		const immediate = this.first;
		this.first = false;
		await this.flush(immediate, signal);
	}
	private seal(): void {
		if (this.sealed) return;
		if (!this.prune()) return;
		const days = new Set([...this.pending.values()].map((cell) => cell.day));
		for (const day of this.health.keys()) days.add(day);
		const day = [...days].sort()[0];
		if (!day) return;
		const cells: Cell[] = [];
		for (const [cellKey, cell] of this.pending) {
			if (cell.day !== day || cells.length === LIMITS.batchCells) continue;
			cells.push(cell);
			this.pending.delete(cellKey);
		}
		const batch: Batch = {
			owner: this.owner,
			seq: (this.sequences.get(day) ?? 0) + 1,
			day,
			cells,
			health: this.health.get(day) ?? {},
		};
		this.health.delete(day);
		for (const cell of cells) {
			Object.freeze(cell.counters);
			Object.freeze(cell);
		}
		Object.freeze(batch.cells);
		Object.freeze(batch.health);
		Object.freeze(batch);
		this.sealed = batch;
	}
	private schedule(): void {
		if (this.closed || this.timer || (!this.sealed && !this.pending.size && !this.health.size)) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.flush();
			},
			Math.max(1, 1000 - (this.now() - this.lastAttempt)),
		);
		this.timer.unref();
	}
	async flush(immediate = false, signal?: AbortSignal): Promise<void> {
		if (this.closed) return;
		if (this.active) {
			await this.active;
			return;
		}
		if (!immediate && this.now() - this.lastAttempt < 1000) {
			this.schedule();
			return;
		}
		this.seal();
		if (!this.sealed) return;
		const batch = this.sealed;
		this.lastAttempt = this.now();
		this.active = (async () => {
			try {
				const status = await this.publisher.commit(batch, utcDay(this.now()), signal);
				if (status === "committed" || status === "duplicate") {
					this.sequences.set(batch.day, batch.seq);
					this.sealed = undefined;
				} else if (
					[
						"receipt_quota",
						"sequence_gap",
						"counter_saturated",
						"revision_saturated",
						"byte_quota",
						"outside_window",
					].includes(status)
				) {
					this.sealed = undefined;
					this.refused.add(batch.day);
					for (const [cellKey, cell] of this.pending) if (cell.day === batch.day) this.pending.delete(cellKey);
					this.health.delete(batch.day);
					this.diagnostic("Pillars storage refused a delta. Unpersisted loss remains unknown.");
				} else if (status === "publication_failed") this.incident("writeFailures");
			} catch {
				this.incident("writeFailures");
			}
		})();
		try {
			await this.active;
		} finally {
			this.active = undefined;
			this.schedule();
		}
	}
	async shutdown(): Promise<void> {
		if (this.closed) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.active;
		await this.flush(true);
		this.closed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
