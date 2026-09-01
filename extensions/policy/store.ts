/** Append-only, private filesystem persistence for policy records. */

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PolicyRecord } from "./record.ts";

const MAX_RECORD_BYTES = 256 * 1024;
export const MAX_QUEUED_RECORDS = 512;

/** Store directory: `PI_POLICY_DIR`, else `<agentDir>/policy`. */
export function resolvePolicyDir(env: NodeJS.ProcessEnv = process.env, agentDir?: string): string {
	if (env.PI_POLICY_DIR) return resolve(env.PI_POLICY_DIR);
	return join(agentDir ?? join(homedir(), ".pi", "agent"), "policy");
}

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD in the local timezone. */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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
 * Append one record to the day's file.
 * The error is returned rather than thrown: a store failure must never reach
 * the tool call that produced the record.
 */
export async function appendRecord(dir: string, record: PolicyRecord): Promise<string | null> {
	try {
		const serialized = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
		if (serialized.length > MAX_RECORD_BYTES) {
			throw new Error(`policy record exceeds ${MAX_RECORD_BYTES} bytes`);
		}
		const timestamp = new Date(record.at);
		if (Number.isNaN(timestamp.getTime())) throw new Error(`invalid policy timestamp: ${record.at}`);
		await ensurePrivateDirectory(dir);
		const path = join(dir, `${localDate(timestamp)}.jsonl`);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
		try {
			await handle.chmod(0o600);
			const { bytesWritten } = await handle.write(serialized, 0, serialized.length, null);
			if (bytesWritten !== serialized.length) {
				throw new Error(`policy record write stopped at ${bytesWritten} of ${serialized.length} bytes`);
			}
		} finally {
			await handle.close();
		}
		return null;
	} catch (error) {
		return errorMessage(error);
	}
}

/**
 * Bounded serial writer that keeps filesystem work outside tool-result
 * handlers. Every queued promise handles its own failure, so no rejection can
 * escape in the background.
 */
export class PolicyWriter {
	private tail: Promise<void> = Promise.resolve();
	private queued = 0;
	/** Slots held for calls whose block was already returned. */
	private reserved = 0;
	private accepting = true;
	private discardQueued = false;
	private failureReported = false;
	private readonly dir: string;
	private readonly onFailure: (reason: string) => void;
	private readonly write: typeof appendRecord;

	constructor(dir: string, onFailure: (reason: string) => void, write: typeof appendRecord = appendRecord) {
		this.dir = dir;
		this.onFailure = onFailure;
		this.write = write;
	}

	private fail(reason: string, discardQueued: boolean): void {
		this.accepting = false;
		if (discardQueued) this.discardQueued = true;
		if (this.failureReported) return;
		this.failureReported = true;
		try {
			this.onFailure(reason);
		} catch {
			// Failure reporting must not create an unhandled rejection.
		}
	}

	/**
	 * Reserve one record slot for a call whose block is about to be returned.
	 *
	 * The reserved call's `enqueue(record, true)` consumes the slot, so a
	 * block is never returned without capacity for its record. A reservation
	 * whose call never produces a record is released at close.
	 */
	tryReserve(): boolean {
		if (!this.accepting) return false;
		if (this.queued + this.reserved >= MAX_QUEUED_RECORDS) return false;
		this.reserved++;
		return true;
	}

	/**
	 * Queue one record and return without waiting for disk I/O.
	 *
	 * Returns false when admission failed, so the caller can withhold any
	 * mechanism effect that would otherwise exist without its record. `reserved`
	 * consumes the slot that `tryReserve` held for this call.
	 */
	enqueue(record: PolicyRecord, reserved = false): boolean {
		if (reserved) {
			// A discarded queue cannot honor the reservation: the queued write
			// would be skipped. Capacity-only failures keep the queue valid,
			// so reservations still drain after those.
			if (this.reserved === 0 || this.discardQueued) return false;
			this.reserved--;
		} else {
			if (!this.accepting) return false;
			if (this.queued + this.reserved >= MAX_QUEUED_RECORDS) {
				this.fail(`policy writer queue reached ${MAX_QUEUED_RECORDS} records`, false);
				return false;
			}
		}
		this.queued++;
		this.tail = this.tail
			.then(async () => {
				if (this.discardQueued) return;
				const failure = await this.write(this.dir, record);
				if (failure) this.fail(failure, true);
			})
			.catch((error: unknown) => this.fail(errorMessage(error), true))
			.finally(() => {
				this.queued--;
			});
		return true;
	}

	/** Stop admission and wait for the final accepted write. */
	async close(): Promise<void> {
		this.accepting = false;
		this.reserved = 0;
		await this.tail;
	}
}
