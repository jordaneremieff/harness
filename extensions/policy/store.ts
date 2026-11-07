/** Append-only, private filesystem persistence for policy records. */

import { chmod, lstat, mkdir } from "node:fs/promises";
import type { PolicyRecord } from "./record.ts";
import {
	appendTelemetryRecords,
	DEFAULT_TELEMETRY_RETENTION,
	MAX_TELEMETRY_RECORD_BYTES,
	TELEMETRY_BATCH_BYTES,
	TELEMETRY_BATCH_RECORDS,
	TELEMETRY_QUEUE_BYTES,
	TELEMETRY_QUEUE_RECORDS,
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

export type AppendTelemetry = (
	dir: string,
	records: readonly PolicyRecord[],
	retention: TelemetryRetention,
) => Promise<void>;

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
		await appendTelemetryRecords(dir, [record], retention);
		return null;
	} catch (error) {
		return errorMessage(error);
	}
}

interface QueueEntry {
	readonly record: PolicyRecord;
	readonly bytes: number;
}

/**
 * Bounded serial writer that keeps filesystem work outside tool-result
 * handlers. Every queued promise handles its own failure, so no rejection can
 * escape in the background.
 */
export class PolicyWriter implements TelemetryWriter {
	private accepting = true;
	private discardQueued = false;
	private failureReported = false;
	private queuedBytes = 0;
	private queuedRecords = 0;
	private pending: QueueEntry[] = [];
	private drainPromise: Promise<void> | undefined;
	private readonly dir: string;
	private readonly onFailure: (reason: string) => void;
	private readonly append: AppendTelemetry;
	private readonly retention: TelemetryRetention;

	constructor(
		dir: string,
		onFailure: (reason: string) => void,
		append: AppendTelemetry = appendTelemetryRecords,
		retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
	) {
		this.dir = dir;
		this.onFailure = onFailure;
		this.append = append;
		this.retention = retention;
	}

	private fail(reason: string, discardQueued: boolean): void {
		this.accepting = false;
		if (discardQueued) {
			this.discardQueued = true;
			this.pending = [];
			this.queuedBytes = 0;
			this.queuedRecords = 0;
		}
		if (this.failureReported) return;
		this.failureReported = true;
		try {
			this.onFailure(reason);
		} catch {
			// Failure reporting must not create an unhandled rejection.
		}
	}

	/** Queue telemetry only. Refusal never changes an approved policy decision. */
	enqueue(record: PolicyRecord): boolean {
		if (!this.accepting) return false;
		let bytes: number;
		try {
			const timestamp = new Date(record.at);
			if (Number.isNaN(timestamp.getTime())) throw new Error(`invalid policy timestamp: ${record.at}`);
			bytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 2;
		} catch (error) {
			this.fail(errorMessage(error), true);
			return false;
		}
		if (bytes > MAX_TELEMETRY_RECORD_BYTES) {
			this.fail(`policy record exceeds ${MAX_TELEMETRY_RECORD_BYTES} bytes`, true);
			return false;
		}
		if (this.queuedRecords >= TELEMETRY_QUEUE_RECORDS) {
			this.fail(`policy writer queue reached ${TELEMETRY_QUEUE_RECORDS} records`, false);
			return false;
		}
		if (this.queuedBytes + bytes > TELEMETRY_QUEUE_BYTES) {
			this.fail(`policy writer queue reached ${TELEMETRY_QUEUE_BYTES} bytes`, false);
			return false;
		}
		this.pending.push({ record, bytes });
		this.queuedBytes += bytes;
		this.queuedRecords++;
		this.schedule();
		return true;
	}

	private schedule(): void {
		if (this.drainPromise) return;
		this.drainPromise = this.drain();
	}

	private takeBatch(): QueueEntry[] {
		const batch: QueueEntry[] = [];
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

	/** Clears its own handle in the turn that finds the queue empty, so no accepted record is stranded. */
	private async drain(): Promise<void> {
		await Promise.resolve();
		try {
			while (!this.discardQueued && this.pending.length > 0) {
				const batch = this.takeBatch();
				let bytes = 0;
				for (const entry of batch) bytes += entry.bytes;
				try {
					await this.append(
						this.dir,
						batch.map((entry) => entry.record),
						this.retention,
					);
				} catch (error) {
					this.fail(errorMessage(error), true);
					return;
				}
				this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
				this.queuedRecords = Math.max(0, this.queuedRecords - batch.length);
			}
		} finally {
			this.drainPromise = undefined;
		}
	}

	/** Stop admission and wait for the final accepted batch. */
	async close(): Promise<void> {
		this.accepting = false;
		while (this.drainPromise) await this.drainPromise;
	}
}
