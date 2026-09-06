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

/** A valid unfinished suffix belongs to the next stream chunk, not a replacement character. */
function readableUtf8Length(buffer: Buffer): number {
	let start = buffer.length - 1;
	while (start >= Math.max(0, buffer.length - 4) && (buffer[start] & 0xc0) === 0x80) start--;
	if (start < 0) return buffer.length;
	const lead = buffer[start];
	const expected =
		lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
	const actual = buffer.length - start;
	if (actual >= expected) return buffer.length;
	const second = buffer[start + 1];
	if (
		actual > 1 &&
		((lead === 0xe0 && second < 0xa0) ||
			(lead === 0xed && second > 0x9f) ||
			(lead === 0xf0 && second < 0x90) ||
			(lead === 0xf4 && second > 0x8f))
	)
		return buffer.length;
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
		if (
			env !== undefined &&
			(env === null ||
				typeof env !== "object" ||
				Array.isArray(env) ||
				Object.entries(env).some(
					([key, value]) =>
						!key ||
						key.includes("=") ||
						key.includes("\0") ||
						(value !== undefined && (typeof value !== "string" || value.includes("\0"))),
				))
		)
			throw new Error("Invalid environment");
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
		job.done = Promise.resolve().then(async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				if (job.stopReason) return;
				if (timeoutSeconds !== undefined) timer = setTimeout(() => this.stop(job, "timed_out"), timeoutSeconds * 1000);
				const result = await operations.exec(command, cwd, {
					signal: job.controller.signal,
					env: environment,
					onData: (data) => {
						if (job.snapshot.status !== "running") return;
						job.end += data.length;
						const chunk = data.subarray(Math.max(0, data.length - JOB_LIMITS.logBytes));
						const prior = job.buffer.subarray(Math.max(0, job.buffer.length + chunk.length - JOB_LIMITS.logBytes));
						job.buffer = Buffer.concat([prior, chunk]);
					},
				});
				if (!result || (result.exitCode !== null && !Number.isInteger(result.exitCode)))
					throw new Error("Invalid bash exit result");
				job.snapshot.exitCode = result.exitCode;
				job.snapshot.status = result.exitCode === 0 ? "succeeded" : "failed";
			} catch (error) {
				job.snapshot.status = "failed";
				const message =
					error instanceof Error ? error.message : typeof error === "string" ? error : "Bash execution failed";
				job.snapshot.error = Buffer.from(message)
					.subarray(0, JOB_LIMITS.errorBytes - 3)
					.toString("utf8");
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				if (job.stopReason) job.snapshot.status = job.stopReason;
				job.snapshot.endedAt = Date.now();
			}
		});
		return { ...job.snapshot };
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
		let lines = 0;
		for (let index = 0; index < length; index++) {
			if (job.buffer[offset + index] === 10 && ++lines === JOB_LIMITS.pageLines) {
				length = index + 1;
				break;
			}
		}
		// Preserve complete UTF-8 characters across ordinary page boundaries.
		if (offset + length < job.buffer.length) {
			let boundary = length;
			while (boundary > 0 && (job.buffer[offset + boundary] & 0xc0) === 0x80) boundary--;
			if (boundary > 0) length = boundary;
		}
		// Replacement characters for split or invalid UTF-8 must also fit the byte limit.
		let text = job.buffer.subarray(offset, offset + length).toString("utf8");
		while (Buffer.byteLength(text) > JOB_LIMITS.pageBytes) {
			length -= Math.max(1, Math.ceil((Buffer.byteLength(text) - JOB_LIMITS.pageBytes) / 3));
			let boundary = length;
			while (boundary > 0 && (job.buffer[offset + boundary] & 0xc0) === 0x80) boundary--;
			if (boundary > 0) length = boundary;
			text = job.buffer.subarray(offset, offset + length).toString("utf8");
		}
		const next = start + length;
		return {
			id,
			text,
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
