/** Append-only, private filesystem persistence for policy records. */

import { chmod, lstat, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { PolicyRecord } from "./record.ts";
import {
	appendSerializedTelemetryRecords,
	type AppendTelemetry,
	DEFAULT_TELEMETRY_RETENTION,
	type SerializedTelemetryRecord,
	serializeTelemetryRecord,
	TELEMETRY_BATCH_BYTES,
	TELEMETRY_BATCH_RECORDS,
	TELEMETRY_QUEUE_BYTES,
	TELEMETRY_QUEUE_RECORDS,
	TelemetryAcquisitionExpiredError,
	type TelemetryHealth,
	TelemetryLockBusyError,
	type TelemetryRetention,
	type TelemetryWriter,
} from "./telemetry-files.ts";

export async function ensurePrivateDirectory(dir: string): Promise<void> {
	const created = await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`policy store is not a regular directory: ${dir}`);
	}
	const getuid = process.getuid;
	if (typeof getuid === "function" && info.uid !== getuid()) {
		throw new Error(`policy store is not owned by this user: ${dir}`);
	}
	if (created !== undefined) {
		await chmod(dir, 0o700);
	} else if ((info.mode & 0o077) !== 0) {
		throw new Error(`policy store permissions are not private: ${dir}`);
	}
}

function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown policy store failure";
	}
}

/**
 * Append one record to the day's segment.
 * The error is returned rather than thrown: a store failure must never reach
 * the tool call that produced the record.
 */
export async function appendRecord(
	dir: string,
	record: PolicyRecord,
	retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
): Promise<string | null> {
	try {
		await appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(record)], retention);
		return null;
	} catch (error) {
		return errorMessage(error);
	}
}

const TELEMETRY_RETRY_BUDGET_MS = 2_000;

/**
 * Bounded serial writer outside tool-result handlers. Accepted records are serialised once.
 * In-flight batches remain charged to the queue until written or discarded.
 */
export class PolicyWriter implements TelemetryWriter {
	private accepting = true;
	private discardQueued = false;
	private currentHealth: TelemetryHealth = { state: "ok", lostRecords: 0, lostBytes: 0 };
	private closeDeadline: number | undefined;
	private retryAbort: AbortController | undefined;
	private queuedBytes = 0;
	private queuedRecords = 0;
	private pending: SerializedTelemetryRecord[] = [];
	private drainPromise: Promise<void> | undefined;
	private readonly dir: string;
	private readonly onStateChange: (health: TelemetryHealth) => void;
	private readonly append: AppendTelemetry;
	private readonly retention: TelemetryRetention;

	constructor(
		dir: string,
		onStateChange: (health: TelemetryHealth) => void,
		append: AppendTelemetry = appendSerializedTelemetryRecords,
		retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
	) {
		this.dir = dir;
		this.onStateChange = onStateChange;
		this.append = append;
		this.retention = retention;
	}

	health(): TelemetryHealth {
		return { ...this.currentHealth };
	}

	private lose(records: number, bytes: number): void {
		this.currentHealth = {
			...this.currentHealth,
			lostRecords: this.currentHealth.lostRecords + records,
			lostBytes: this.currentHealth.lostBytes + bytes,
		};
	}

	private state(state: TelemetryHealth["state"], reason?: string): void {
		if (this.currentHealth.state === "failed" || this.currentHealth.state === state) return;
		this.currentHealth = { ...this.currentHealth, state, ...(reason === undefined ? {} : { reason }) };
		try {
			this.onStateChange(this.health());
		} catch {
			// Reporting has no persistence authority.
		}
	}

	private fail(reason: string): void {
		if (this.currentHealth.state === "failed") return;
		this.accepting = false;
		this.discardQueued = true;
		const bytes = this.pending.reduce((total, entry) => total + entry.bytes, 0);
		this.releaseBatch(this.pending.length, bytes, true);
		this.pending = [];
		this.retryAbort?.abort();
		this.state("failed", reason);
	}

	/** Queue telemetry only. Refusal never changes an approved policy decision. */
	enqueue(record: PolicyRecord): boolean {
		if (!this.accepting) return false;
		let admitted: SerializedTelemetryRecord;
		try {
			admitted = serializeTelemetryRecord(record);
		} catch (error) {
			this.lose(1, 0);
			this.fail(errorMessage(error));
			return false;
		}
		if (this.queuedRecords >= TELEMETRY_QUEUE_RECORDS || this.queuedBytes + admitted.bytes > TELEMETRY_QUEUE_BYTES) {
			this.lose(1, admitted.bytes);
			this.state("pressure");
			return false;
		}
		this.pending.push(admitted);
		this.queuedBytes += admitted.bytes;
		this.queuedRecords++;
		this.schedule();
		return true;
	}

	private releaseBatch(records: number, bytes: number, lost = false): void {
		if (lost) this.lose(records, bytes);
		this.queuedBytes -= bytes;
		this.queuedRecords -= records;
	}

	private schedule(): void {
		if (this.drainPromise) return;
		this.drainPromise = this.drain();
	}

	private takeBatch(): SerializedTelemetryRecord[] {
		const batch: SerializedTelemetryRecord[] = [];
		let bytes = 0;
		while (this.pending.length > 0 && batch.length < TELEMETRY_BATCH_RECORDS) {
			const next = this.pending[0];
			if (batch.length > 0 && bytes + next.bytes > TELEMETRY_BATCH_BYTES) break;
			this.pending.shift();
			batch.push(next);
			bytes += next.bytes;
			if (next.bytes > TELEMETRY_BATCH_BYTES) break;
		}
		return batch;
	}

	private acquisitionDeadline(started: number): number {
		return Math.min(started + TELEMETRY_RETRY_BUDGET_MS, this.closeDeadline ?? Number.POSITIVE_INFINITY);
	}

	private async backoff(started: number): Promise<void> {
		const remaining = this.acquisitionDeadline(started) - performance.now();
		const wait = Math.min(50 + Math.random() * 50, Math.max(0, remaining));
		if (wait <= 0) return;
		const abort = new AbortController();
		this.retryAbort = abort;
		try {
			await delay(wait, undefined, { signal: abort.signal });
		} catch (error) {
			if (!abort.signal.aborted) throw error;
		} finally {
			this.retryAbort = undefined;
		}
	}

	private async writeBatch(batch: readonly SerializedTelemetryRecord[]): Promise<"written" | "dropped"> {
		const started = performance.now();
		while (!this.discardQueued) {
			const deadline = this.acquisitionDeadline(started);
			if (deadline <= performance.now()) return "dropped";
			try {
				await this.append(this.dir, batch, this.retention, { acquireUntil: deadline });
				return "written";
			} catch (error) {
				if (error instanceof TelemetryAcquisitionExpiredError) return "dropped";
				if (!(error instanceof TelemetryLockBusyError)) throw error;
				this.state("pressure");
				if (!this.discardQueued) await this.backoff(started);
			}
		}
		return "dropped";
	}

	/** Clears its handle in the turn that finds the queue empty, so accepted records are not stranded. */
	private async drain(): Promise<void> {
		await Promise.resolve();
		try {
			while (!this.discardQueued && this.pending.length > 0) {
				const batch = this.takeBatch();
				const bytes = batch.reduce((total, entry) => total + entry.bytes, 0);
				try {
					const outcome = await this.writeBatch(batch);
					this.releaseBatch(batch.length, bytes, outcome === "dropped");
					this.state(outcome === "dropped" ? "pressure" : "ok");
				} catch (error) {
					this.releaseBatch(batch.length, bytes, true);
					this.fail(errorMessage(error));
					return;
				}
			}
		} finally {
			this.drainPromise = undefined;
		}
	}

	/** Stop admission; pending acquisitions share a deadline, while acquired appends finish cleanup. */
	async close(): Promise<void> {
		this.accepting = false;
		this.closeDeadline ??= performance.now() + TELEMETRY_RETRY_BUDGET_MS;
		while (this.drainPromise) await this.drainPromise;
	}
}
