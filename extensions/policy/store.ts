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
	type TelemetryLockHolder,
	TelemetryLockBusyError,
	type TelemetryRetention,
	TelemetryUncertainAppendError,
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
/** Longest first wait before a stopped writer admits a record again. Each further failure doubles it. */
export const TELEMETRY_RESUME_BASE_MS = 1_000;
/** Longest wait between two write attempts of a stopped writer. */
export const TELEMETRY_RESUME_MAX_MS = 300_000;

/**
 * Bounded serial writer outside tool-result handlers. Accepted records are serialised once.
 * In-flight batches remain charged to the queue until written or discarded.
 *
 * A failed append stops admission for a bounded, growing wait instead of for the life of the
 * process. The first record offered after the wait is admitted, and its append is the next
 * attempt: the writer holds no timer, and it tries only as often as records arrive. Each attempt
 * runs every safety check of an append before it writes, and repairs nothing. Only a completed
 * append returns the state to `ok` and resets the wait.
 */
export class PolicyWriter implements TelemetryWriter {
	private closing = false;
	private state: TelemetryHealth["state"] = "ok";
	private reason: string | undefined;
	private lock: TelemetryLockHolder | undefined;
	private lostRecords = 0;
	private lostBytes = 0;
	private uncertainRecords = 0;
	private uncertainBytes = 0;
	private stops = 0;
	private resumes = 0;
	private staleLocks = 0;
	/** Failed appends since the latest completed one; selects the next wait. */
	private failures = 0;
	/** Monotonic time before which a stopped writer refuses records. */
	private resumeAt: number | undefined;
	private retryAt: string | undefined;
	private lossSignalled = false;
	private closeDeadline: number | undefined;
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
		return {
			state: this.state,
			lostRecords: this.lostRecords,
			lostBytes: this.lostBytes,
			...(this.uncertainRecords > 0
				? { uncertainRecords: this.uncertainRecords, uncertainBytes: this.uncertainBytes }
				: {}),
			...(this.reason === undefined ? {} : { reason: this.reason }),
			...(this.lock === undefined ? {} : { lock: this.lock }),
			...(this.retryAt === undefined ? {} : { retryAt: this.retryAt }),
			...(this.stops + this.staleLocks > 0
				? { recovery: { stops: this.stops, resumes: this.resumes, staleLocks: this.staleLocks } }
				: {}),
		};
	}

	/**
	 * Signals a state change, and once the first loss under an unchanged state: a lock that
	 * stays held keeps the writer in pressure while every batch drops.
	 */
	private transition(state: TelemetryHealth["state"]): void {
		const lost = this.lostRecords + this.uncertainRecords > 0;
		if (this.state === state && (this.lossSignalled || !lost)) return;
		if (lost) this.lossSignalled = true;
		if (state !== "pressure") this.lock = undefined;
		if (state !== "failed") this.reason = undefined;
		this.state = state;
		try {
			this.onStateChange(this.health());
		} catch {
			// Reporting has no persistence authority.
		}
	}

	/** Discard the queue and refuse records until a bounded wait ends. Each failure doubles the wait. */
	private stop(reason: string): void {
		const bytes = this.pending.reduce((total, entry) => total + entry.bytes, 0);
		this.releaseBatch(this.pending.length, bytes, "lost");
		this.pending = [];
		if (this.state !== "failed") this.stops++;
		const longest = Math.min(TELEMETRY_RESUME_MAX_MS, TELEMETRY_RESUME_BASE_MS * 2 ** Math.min(this.failures, 30));
		this.failures++;
		// Writers that failed together spread their next attempts over the second half of the wait.
		const wait = longest * (0.5 + Math.random() / 2);
		this.resumeAt = performance.now() + wait;
		this.retryAt = new Date(Date.now() + wait).toISOString();
		this.reason = reason;
		this.transition("failed");
	}

	/** Queue telemetry only. Refusal never changes an approved policy decision. */
	enqueue(record: PolicyRecord): boolean {
		if (this.closing) return false;
		let admitted: SerializedTelemetryRecord;
		try {
			admitted = serializeTelemetryRecord(record);
		} catch {
			this.lostRecords++;
			this.transition(this.state);
			return false;
		}
		if (this.resumeAt !== undefined) {
			if (performance.now() < this.resumeAt) {
				this.lostRecords++;
				this.lostBytes += admitted.bytes;
				return false;
			}
			this.resumeAt = undefined;
			this.retryAt = undefined;
		}
		if (this.queuedRecords >= TELEMETRY_QUEUE_RECORDS || this.queuedBytes + admitted.bytes > TELEMETRY_QUEUE_BYTES) {
			this.lostRecords++;
			this.lostBytes += admitted.bytes;
			this.transition(this.state === "failed" ? "failed" : "pressure");
			return false;
		}
		this.pending.push(admitted);
		this.queuedBytes += admitted.bytes;
		this.queuedRecords++;
		this.schedule();
		return true;
	}

	private releaseBatch(records: number, bytes: number, outcome?: "lost" | "uncertain"): void {
		if (outcome === "lost") {
			this.lostRecords += records;
			this.lostBytes += bytes;
		} else if (outcome === "uncertain") {
			this.uncertainRecords += records;
			this.uncertainBytes += bytes;
		}
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
		if (wait > 0) await delay(wait);
	}

	/** Retries only a held lock, which leaves the batch unwritten. Every other failure is thrown. */
	private async writeBatch(batch: readonly SerializedTelemetryRecord[]): Promise<"written" | "dropped"> {
		const started = performance.now();
		for (;;) {
			const deadline = this.acquisitionDeadline(started);
			if (deadline <= performance.now()) return "dropped";
			try {
				await this.append(this.dir, batch, this.retention, {
					acquireUntil: deadline,
					onStaleLock: () => {
						this.staleLocks++;
					},
				});
				return "written";
			} catch (error) {
				if (error instanceof TelemetryAcquisitionExpiredError) return "dropped";
				if (!(error instanceof TelemetryLockBusyError)) throw error;
				this.lock = error.holder;
				this.transition("pressure");
				await this.backoff(started);
			}
		}
	}

	/** Clears its handle in the turn that finds the queue empty, so accepted records are not stranded. */
	private async drain(): Promise<void> {
		await Promise.resolve();
		try {
			while (this.pending.length > 0) {
				const batch = this.takeBatch();
				const bytes = batch.reduce((total, entry) => total + entry.bytes, 0);
				let outcome: "written" | "dropped";
				try {
					outcome = await this.writeBatch(batch);
				} catch (error) {
					// Bytes of this batch may be in storage: count it apart, and never write it again.
					const uncertain = error instanceof TelemetryUncertainAppendError;
					this.releaseBatch(batch.length, bytes, uncertain ? "uncertain" : "lost");
					this.stop(errorMessage(error));
					continue;
				}
				if (outcome === "dropped") {
					this.releaseBatch(batch.length, bytes, "lost");
					this.transition("pressure");
					continue;
				}
				this.releaseBatch(batch.length, bytes);
				if (this.state === "failed") this.resumes++;
				this.failures = 0;
				this.transition("ok");
			}
		} finally {
			this.drainPromise = undefined;
		}
	}

	/** Stop admission; pending acquisitions share a deadline, while acquired appends finish cleanup. */
	async close(): Promise<void> {
		this.closing = true;
		this.closeDeadline ??= performance.now() + TELEMETRY_RETRY_BUDGET_MS;
		while (this.drainPromise) await this.drainPromise;
	}
}

function lockAdvice(lock: TelemetryLockHolder | undefined): string {
	if (!lock) return "";
	if (lock.ownership === "live")
		return ` A running writer holds ${lock.path} in the policy directory; recording continues when it releases the lock.`;
	const age = lock.ageMs === undefined ? "" : ` for ${Math.round(lock.ageMs / 1000)} s`;
	const owner =
		lock.pid === undefined
			? "names no process"
			: lock.running === undefined
				? `names process ${lock.pid} on another host`
				: `names process ${lock.pid}, which is ${lock.running ? "" : "not "}running on this host`;
	const evidence = ` The lock file ${lock.path} in the policy directory has existed${age} and ${owner}.`;
	if (lock.running) return `${evidence} Recording continues when that process releases the lock.`;
	return `${evidence} A writer from an earlier release can still own that file, so Policy never removes it. Recording continues when the file is gone. Remove it only when no Pi process from an earlier release still runs.`;
}

export interface TelemetryNotice {
	readonly level: "info" | "warning" | "error";
	readonly text: string;
}

/** Shortest time between two stop notices of one writer. */
export const TELEMETRY_STOP_NOTICE_INTERVAL_MS = 600_000;

/**
 * Selects the writer health changes that need operator attention. Lock contention
 * that recovers without loss is routine and stays visible only through health
 * inspection, and so does a lock taken over from a stopped writer. The first loss
 * is reported once per writer, also while pressure persists. A stop is reported
 * when it starts, at most once per interval, and a reported stop is followed by one
 * notice when a completed append ends it. Later attempts and cumulative counts stay
 * in the health view.
 */
export class TelemetryNotices {
	private lossReported = false;
	private stopped = false;
	private stopNoticeAt: number | undefined;
	private resumeOwed = false;

	next(health: TelemetryHealth): TelemetryNotice | undefined {
		if (health.state === "failed") {
			if (this.stopped) return undefined;
			this.stopped = true;
			this.lossReported = true;
			const now = performance.now();
			if (this.stopNoticeAt !== undefined && now - this.stopNoticeAt < TELEMETRY_STOP_NOTICE_INTERVAL_MS) return undefined;
			this.stopNoticeAt = now;
			this.resumeOwed = true;
			const uncertain = health.uncertainRecords
				? ` ${health.uncertainRecords} record(s) of a failed batch may be partly stored and are not written again.`
				: "";
			return {
				level: "error",
				text: `[policy] Telemetry persistence stopped: ${health.reason ?? "unknown failure"}. Rules still apply.${uncertain} The writer tries again by itself at growing intervals. Policy health shows the next attempt and the lost counts.`,
			};
		}
		this.stopped = false;
		if (this.resumeOwed && health.state === "ok") {
			this.resumeOwed = false;
			return {
				level: "info",
				text: "[policy] Telemetry persistence resumed: a batch reached storage. Policy health shows the lost counts.",
			};
		}
		if (health.lostRecords === 0 || this.lossReported) return undefined;
		this.lossReported = true;
		return {
			level: "warning",
			text: `[policy] Telemetry dropped ${health.lostRecords} record(s). Rules still apply.${lockAdvice(health.lock)} Policy health shows the current counts.`,
		};
	}
}
