import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export const JOB_LIMITS = Object.freeze({
	active: 8,
	retained: 32,
	logBytes: 256 * 1024,
	pageBytes: 16 * 1024,
	pageLines: 200,
	commandBytes: 64 * 1024,
	errorBytes: 2048,
});
export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export interface JobSnapshot {
	id: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	error?: string;
	cancellationRequested: boolean;
	timeoutSeconds?: number;
}
export interface JobLogs {
	id: string;
	text: string;
	earliest: number;
	next: number;
	end: number;
	gap: boolean;
	more: boolean;
	pendingBytes: number;
}

/** Expected UTF-8 sequence length from a lead byte; 1 for an invalid lead. */
function expectedSequenceLength(lead: number): number {
	if (lead >= 0xc2 && lead <= 0xdf) return 2;
	if (lead >= 0xe0 && lead <= 0xef) return 3;
	if (lead >= 0xf0 && lead <= 0xf4) return 4;
	return 1;
}

/** True when a lead byte forbids its observed second byte (overlong, surrogate, or out of range). */
function invalidSecondByte(lead: number, second: number): boolean {
	if (lead === 0xe0 && second < 0xa0) return true;
	if (lead === 0xed && second > 0x9f) return true;
	if (lead === 0xf0 && second < 0x90) return true;
	if (lead === 0xf4 && second > 0x8f) return true;
	return false;
}

/** A valid unfinished suffix belongs to the next stream chunk, not a replacement character. */
function readableUtf8Length(buffer: Buffer): number {
	let start = buffer.length - 1;
	const floor = Math.max(0, buffer.length - 4);
	while (start >= floor && (buffer[start] & 0xc0) === 0x80) start--;
	if (start < 0) return buffer.length;
	const lead = buffer[start];
	const actual = buffer.length - start;
	if (actual >= expectedSequenceLength(lead)) return buffer.length;
	const second = buffer[start + 1];
	if (actual > 1 && invalidSecondByte(lead, second)) return buffer.length;
	return start;
}

interface Job {
	snapshot: JobSnapshot;
	controller: AbortController;
	stopReason?: "cancelled" | "timed_out";
	buffer: Buffer;
	end: number;
	done: Promise<void>;
}

/** Reject malformed start arguments before any process or state is created. */
function validateStartArgs(
	command: string,
	cwd: string,
	operations: BashOperations,
	timeoutSeconds: number | undefined,
	env: NodeJS.ProcessEnv | undefined,
): void {
	if (
		typeof command !== "string" ||
		!command.trim() ||
		command.includes("\0") ||
		Buffer.byteLength(command) > JOB_LIMITS.commandBytes
	)
		throw new Error("Invalid command");
	if (typeof cwd !== "string" || !cwd || cwd.includes("\0") || Buffer.byteLength(cwd) > 16 * 1024)
		throw new Error("Invalid working directory");
	if (!operations || typeof operations.exec !== "function") throw new Error("Invalid bash operations");
	if (
		timeoutSeconds !== undefined &&
		(!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647)
	)
		throw new Error("Invalid timeout in seconds");
	if (env !== undefined && !validEnvironment(env)) throw new Error("Invalid environment");
}

function validEnvironment(env: NodeJS.ProcessEnv): boolean {
	if (env === null || typeof env !== "object" || Array.isArray(env)) return false;
	return Object.entries(env).every(([key, value]) => {
		if (!key || key.includes("=") || key.includes("\0")) return false;
		return value === undefined || (typeof value === "string" && !value.includes("\0"));
	});
}

/** Accumulate bounded tail output for a running job; terminal jobs ignore late chunks. */
function appendOutput(job: Job, data: Buffer): void {
	if (job.snapshot.status !== "running") return;
	job.end += data.length;
	const chunk = data.subarray(Math.max(0, data.length - JOB_LIMITS.logBytes));
	const prior = job.buffer.subarray(Math.max(0, job.buffer.length + chunk.length - JOB_LIMITS.logBytes));
	job.buffer = Buffer.concat([prior, chunk]);
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : typeof error === "string" ? error : "Bash execution failed";
}

/** Page length ending after the page-lines-th newline, or the full length. */
function lineBound(buffer: Buffer, offset: number, length: number): number {
	let lines = 0;
	for (let index = 0; index < length; index++) {
		if (buffer[offset + index] === 10 && ++lines === JOB_LIMITS.pageLines) return index + 1;
	}
	return length;
}

/** Back up to the start of a UTF-8 sequence so a page does not split one. */
function continuationBound(buffer: Buffer, offset: number, length: number): number {
	let boundary = length;
	while (boundary > 0 && (buffer[offset + boundary] & 0xc0) === 0x80) boundary--;
	return boundary > 0 ? boundary : length;
}

/** Decode and shrink the page until replacement characters also fit the byte limit. */
function fitUtf8Page(buffer: Buffer, offset: number, length: number): { length: number; text: string } {
	let size = length;
	let text = buffer.subarray(offset, offset + size).toString("utf8");
	while (Buffer.byteLength(text) > JOB_LIMITS.pageBytes) {
		size -= Math.max(1, Math.ceil((Buffer.byteLength(text) - JOB_LIMITS.pageBytes) / 3));
		size = continuationBound(buffer, offset, size);
		text = buffer.subarray(offset, offset + size).toString("utf8");
	}
	return { length: size, text };
}

/** Owns process lifetimes and bounded output, without owning a shell implementation. */
export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private closed = false;
	private disposal?: Promise<void>;

	start(
		command: string,
		cwd: string,
		operations: BashOperations,
		env?: NodeJS.ProcessEnv,
		timeoutSeconds?: number,
	): JobSnapshot {
		if (this.closed) throw new Error("Job manager is closed");
		validateStartArgs(command, cwd, operations, timeoutSeconds, env);
		if (this.list().filter((job) => job.status === "running").length >= JOB_LIMITS.active)
			throw new Error("Active job limit reached");
		if (this.jobs.size >= JOB_LIMITS.retained) {
			const terminal = [...this.jobs.values()]
				.filter((job) => job.snapshot.status !== "running")
				.sort((a, b) => (a.snapshot.endedAt ?? 0) - (b.snapshot.endedAt ?? 0))[0];
			if (!terminal) throw new Error("Retained job limit reached");
			this.jobs.delete(terminal.snapshot.id);
		}
		const job: Job = {
			snapshot: {
				id: randomUUID(),
				status: "running",
				startedAt: Date.now(),
				cancellationRequested: false,
				...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
			},
			controller: new AbortController(),
			buffer: Buffer.alloc(0),
			end: 0,
			done: Promise.resolve(),
		};
		const environment = env === undefined ? undefined : { ...env };
		this.jobs.set(job.snapshot.id, job);
		job.done = Promise.resolve().then(() =>
			this.#executeJob(job, command, cwd, operations, environment, timeoutSeconds),
		);
		return { ...job.snapshot };
	}

	/** Run one job after the caller has its snapshot; every terminal path sets endedAt. */
	async #executeJob(
		job: Job,
		command: string,
		cwd: string,
		operations: BashOperations,
		environment: NodeJS.ProcessEnv | undefined,
		timeoutSeconds: number | undefined,
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (job.stopReason) return;
			if (timeoutSeconds !== undefined) timer = setTimeout(() => this.stop(job, "timed_out"), timeoutSeconds * 1000);
			const result = await operations.exec(command, cwd, {
				signal: job.controller.signal,
				env: environment,
				onData: (data) => appendOutput(job, data),
			});
			if (!result || (result.exitCode !== null && !Number.isInteger(result.exitCode)))
				throw new Error("Invalid bash exit result");
			job.snapshot.exitCode = result.exitCode;
			job.snapshot.status = result.exitCode === 0 ? "succeeded" : "failed";
		} catch (error) {
			job.snapshot.status = "failed";
			job.snapshot.error = Buffer.from(failureMessage(error))
				.subarray(0, JOB_LIMITS.errorBytes - 3)
				.toString("utf8");
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (job.stopReason) job.snapshot.status = job.stopReason;
			job.snapshot.endedAt = Date.now();
		}
	}

	list(): JobSnapshot[] {
		return [...this.jobs.values()].map((job) => ({ ...job.snapshot }));
	}
	status(id: string): JobSnapshot {
		return { ...this.get(id).snapshot };
	}
	async wait(id: string): Promise<JobSnapshot> {
		const job = this.get(id);
		await job.done;
		return { ...job.snapshot };
	}
	logs(id: string, cursor = 0): JobLogs {
		const job = this.get(id);
		if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.end) throw new Error("Invalid log cursor");
		const earliest = job.end - job.buffer.length;
		const start = Math.max(cursor, earliest);
		const offset = start - earliest;
		const readable = job.snapshot.status === "running" ? readableUtf8Length(job.buffer) : job.buffer.length;
		const pendingBytes = job.buffer.length - readable;
		let length = Math.max(0, Math.min(readable - offset, JOB_LIMITS.pageBytes));
		length = lineBound(job.buffer, offset, length);
		// Preserve complete UTF-8 characters across ordinary page boundaries.
		if (offset + length < job.buffer.length) length = continuationBound(job.buffer, offset, length);
		const page = fitUtf8Page(job.buffer, offset, length);
		const next = start + page.length;
		return {
			id,
			text: page.text,
			earliest,
			next,
			end: job.end,
			gap: cursor < earliest,
			more: next < earliest + readable,
			pendingBytes,
		};
	}
	cancel(id: string): JobSnapshot {
		const job = this.get(id);
		this.stop(job, "cancelled");
		return { ...job.snapshot };
	}
	dispose(): Promise<void> {
		if (!this.disposal) {
			this.closed = true;
			for (const job of this.jobs.values()) this.stop(job, "cancelled");
			this.disposal = Promise.all([...this.jobs.values()].map((job) => job.done)).then(() => {});
		}
		return this.disposal;
	}
	private get(id: string): Job {
		const job = this.jobs.get(id);
		if (!job) throw new Error("Unknown job ID");
		return job;
	}
	private stop(job: Job, reason: "cancelled" | "timed_out"): void {
		if (job.snapshot.status !== "running" || job.stopReason) return;
		job.stopReason = reason;
		job.snapshot.cancellationRequested = true;
		job.controller.abort();
	}
}
