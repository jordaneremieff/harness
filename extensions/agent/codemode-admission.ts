import { CodemodeSandbox, type CodemodeResult, type CodemodeRun, type CodemodeRunOptions, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";

/** Why a native script did not obtain a worker. */
export type CodemodeAdmissionFailureCode =
	| "CODEMODE_QUEUE_FULL"
	| "CODEMODE_ADMISSION_TIMEOUT"
	| "CODEMODE_CANCELLED";

/** Admission state reported with a failure, through the tool's public diagnostics. */
export interface CodemodeAdmissionFailure {
	readonly code: CodemodeAdmissionFailureCode;
	readonly message: string;
	readonly active: number;
	readonly waiting: number;
	readonly limit: number;
}

class WorkerWaitError extends Error {
	readonly failure: CodemodeAdmissionFailure;
	constructor(failure: CodemodeAdmissionFailure) {
		super(failure.message);
		this.failure = failure;
	}
}

const CODEMODE_MAX_WAITERS = 64;

function maxCodemodeWorkers(): number {
	const value = Number(process.env.PI_CODEMODE_MAX_WORKERS);
	return Number.isInteger(value) && value > 0 ? value : 2;
}

/** The result a refused or cancelled queue wait returns to the script's caller. */
function waitFailure(error: unknown, signal: AbortSignal, queue: CodemodeWorkerQueue, diagnostic: ((failure: CodemodeAdmissionFailure) => void) | undefined): CodemodeResult {
	if (!(error instanceof WorkerWaitError) && !signal.aborted) throw error;
	const counts = queue.snapshot();
	const failure = error instanceof WorkerWaitError ? error.failure : { code: "CODEMODE_CANCELLED" as const, message: error instanceof Error ? error.message : "The codemode worker wait was cancelled.", ...counts };
	diagnostic?.(failure);
	const kind = failure.code === "CODEMODE_CANCELLED" ? "aborted" : failure.code === "CODEMODE_QUEUE_FULL" ? "sandbox" : "timeout";
	return { ok: false, error: { kind, message: failure.message }, output: [], calls: [] };
}

/** Process-local FIFO reservations. A lease belongs to a worker until its actual exit. */
export class CodemodeWorkerQueue {
	private active = 0;
	private readonly waiting: (() => void)[] = [];
	private readonly limit: number | undefined;
	private readonly maxWaiters: number;
	constructor(limit?: number, maxWaiters = CODEMODE_MAX_WAITERS) { this.limit = limit; this.maxWaiters = maxWaiters; }

	/** Current reservations and the limit that produced them. */
	snapshot(): { readonly active: number; readonly waiting: number; readonly limit: number } {
		return { active: this.active, waiting: this.waiting.length, limit: this.limit ?? maxCodemodeWorkers() };
	}

	private refusal(code: CodemodeAdmissionFailure["code"], message: string): WorkerWaitError {
		return new WorkerWaitError({ code, message, ...this.snapshot() });
	}

	reserve(signal: AbortSignal, deadline: number): Promise<() => void> {
		if (this.waiting.length >= this.maxWaiters) return Promise.reject(this.refusal("CODEMODE_QUEUE_FULL", `The codemode worker queue is full (${this.maxWaiters} waiting calls).`));
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				const index = this.waiting.indexOf(grant);
				if (index >= 0) this.waiting.splice(index, 1);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const abort = () => fail(this.refusal("CODEMODE_CANCELLED", "The codemode worker wait was aborted."));
			const grant = () => {
				if (signal.aborted) return abort();
				if (Date.now() >= deadline) return fail(this.refusal("CODEMODE_ADMISSION_TIMEOUT", "The codemode worker wait timed out."));
				settled = true;
				cleanup();
				this.active++;
				let released = false;
				resolve(() => {
					if (released) return;
					released = true;
					this.active--;
					this.admit();
				});
			};
			const timer = setTimeout(() => fail(this.refusal("CODEMODE_ADMISSION_TIMEOUT", "The codemode worker wait timed out.")), Math.max(0, deadline - Date.now()));
			signal.addEventListener("abort", abort, { once: true });
			this.waiting.push(grant);
			if (signal.aborted) abort();
			this.admit();
		});
	}

	private admit(): void {
		while (this.waiting.length > 0 && this.active < (this.limit ?? maxCodemodeWorkers())) this.waiting[0]?.();
	}
}

const workers = new CodemodeWorkerQueue();

type CodemodeAdmission = {
	deadline(): Promise<number>;
	admitted(): Promise<void>;
	/** The clock that supplied the native run's remaining timeout budget. */
	now(): number;
	/** The original absolute execution deadline on that clock; no preparation delay or replay moves it. */
	executionDeadline: number;
	/**
	 * A failure found before the native tool asked for a sandbox. It refuses execution only when `start` is called,
	 * so a result the native tool already retained is returned without it.
	 */
	refusal?: { readonly code: CodemodeAdmissionFailureCode; readonly message: string };
};

/** Queue at the native start boundary, after Durable records its replay data and deadline. */
export class QueuedCodemodeSandbox extends CodemodeSandbox {
	private readonly shutdown = new AbortController();
	private readonly sandboxes = new Set<CodemodeSandbox>();

	private readonly admission: CodemodeAdmission;
	private readonly queue: CodemodeWorkerQueue;
	private readonly options: CodemodeSandboxOptions;
	private readonly diagnostic: ((failure: CodemodeAdmissionFailure) => void) | undefined;
	constructor(
		admission: CodemodeAdmission,
		queue = workers,
		options: CodemodeSandboxOptions = {},
		diagnostic?: (failure: CodemodeAdmissionFailure) => void,
	) { super(); this.admission = admission; this.queue = queue; this.options = options; this.diagnostic = diagnostic; }

	override start(code: string, options: CodemodeRunOptions): CodemodeRun {
		const signal = AbortSignal.any([this.shutdown.signal, ...(options.signal ? [options.signal] : [])]);
		const started = Date.now();
		const scriptDeadline = options.timeoutMs === undefined ? Infinity : started + options.timeoutMs;
		const nativeStarted = this.admission.now();
		const nativeDeadline = options.timeoutMs === undefined ? Infinity : nativeStarted + options.timeoutMs;
		const remainingScriptMs = () => Math.min(scriptDeadline - Date.now(), nativeDeadline - this.admission.now(), this.admission.executionDeadline - this.admission.now());
		let finished = false;
		let run: CodemodeRun | undefined;
		const result = (async (): Promise<CodemodeResult> => {
			let release: (() => void) | undefined;
			let claimed = false;
			let sandbox: CodemodeSandbox | undefined;
			try {
				if (this.admission.refusal !== undefined) throw new WorkerWaitError({ ...this.admission.refusal, ...this.queue.snapshot() });
				const deadline = Math.min(await this.admission.deadline(), scriptDeadline);
				release = await this.queue.reserve(signal, deadline);
				await this.admission.admitted();
				signal.throwIfAborted();
				const remaining = remainingScriptMs();
				if (remaining <= 0) throw new WorkerWaitError({ code: "CODEMODE_ADMISSION_TIMEOUT", message: "The codemode script timed out before worker launch.", ...this.queue.snapshot() });
				sandbox = new CodemodeSandbox({ ...this.options, acquireWorker: () => {
					// wasm loading is asynchronous and can finish after the result or close().
					if (finished || signal.aborted || remainingScriptMs() <= 0) throw new Error("The codemode worker launch was cancelled.");
					claimed = true;
					return () => release?.();
				} });
				this.sandboxes.add(sandbox);
				run = sandbox.start(code, { ...options, signal, ...(Number.isFinite(remaining) ? { timeoutMs: remaining } : {}) });
				return await run.result;
			} catch (error) {
				return waitFailure(error, signal, this.queue, this.diagnostic);
			} finally {
				finished = true;
				// An unclaimed reservation has no worker. A delayed launcher is fenced above.
				if (!claimed) release?.();
				if (sandbox) { this.sandboxes.delete(sandbox); await sandbox.close(); }
			}
		})();
		return { result, get finished() { return finished || run?.finished === true; }, deliver: (...args) => run?.deliver(...args) };
	}

	override async close(): Promise<void> {
		this.shutdown.abort();
		await Promise.all([...this.sandboxes].map((sandbox) => sandbox.close()));
	}
}
