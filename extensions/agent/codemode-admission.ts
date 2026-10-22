import { CodemodeSandbox, type CodemodeResult, type CodemodeRun, type CodemodeRunOptions, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";

class WorkerWaitError extends Error {}
class WorkerQueueFullError extends WorkerWaitError {}

const CODEMODE_MAX_WAITERS = 64;

function waitFailure(error: unknown, signal: AbortSignal): CodemodeResult {
	if (!signal.aborted && !(error instanceof WorkerWaitError)) throw error;
	return { ok: false, error: { kind: signal.aborted ? "aborted" : error instanceof WorkerQueueFullError ? "sandbox" : "timeout", message: error instanceof Error ? error.message : String(error) }, output: [], calls: [] };
}

/** Process-local FIFO reservations. A lease belongs to a worker until its actual exit. */
export class CodemodeWorkerQueue {
	private active = 0;
	private readonly waiting: (() => void)[] = [];
	private readonly limit: number;
	private readonly maxWaiters: number;
	constructor(limit = 2, maxWaiters = CODEMODE_MAX_WAITERS) { this.limit = limit; this.maxWaiters = maxWaiters; }

	reserve(signal: AbortSignal, deadline: number): Promise<() => void> {
		if (this.waiting.length >= this.maxWaiters) return Promise.reject(new WorkerQueueFullError(`The codemode worker queue is full (${this.maxWaiters} waiting calls).`));
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
			const abort = () => fail(new WorkerWaitError("The codemode worker wait was aborted."));
			const grant = () => {
				if (signal.aborted) return abort();
				if (Date.now() >= deadline) return fail(new WorkerWaitError("The codemode worker wait timed out."));
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
			const timer = setTimeout(() => fail(new WorkerWaitError("The codemode worker wait timed out.")), Math.max(0, deadline - Date.now()));
			signal.addEventListener("abort", abort, { once: true });
			this.waiting.push(grant);
			if (signal.aborted) abort();
			this.admit();
		});
	}

	private admit(): void {
		while (this.active < this.limit && this.waiting.length > 0) this.waiting[0]?.();
	}
}

const workers = new CodemodeWorkerQueue();

/** Queue at the native start boundary, after Durable records its replay data and deadline. */
export class QueuedCodemodeSandbox extends CodemodeSandbox {
	private readonly shutdown = new AbortController();
	private readonly sandboxes = new Set<CodemodeSandbox>();

	private readonly admission: { deadline(): Promise<number>; admitted(): Promise<void> };
	private readonly queue: CodemodeWorkerQueue;
	private readonly options: CodemodeSandboxOptions;
	constructor(
		admission: { deadline(): Promise<number>; admitted(): Promise<void> },
		queue = workers,
		options: CodemodeSandboxOptions = {},
	) { super(); this.admission = admission; this.queue = queue; this.options = options; }

	override start(code: string, options: CodemodeRunOptions): CodemodeRun {
		const signal = AbortSignal.any([this.shutdown.signal, ...(options.signal ? [options.signal] : [])]);
		const started = Date.now();
		const scriptDeadline = options.timeoutMs === undefined ? Infinity : started + options.timeoutMs;
		let finished = false;
		let run: CodemodeRun | undefined;
		const result = (async (): Promise<CodemodeResult> => {
			let release: (() => void) | undefined;
			let claimed = false;
			let sandbox: CodemodeSandbox | undefined;
			try {
				const deadline = Math.min(await this.admission.deadline(), scriptDeadline);
				release = await this.queue.reserve(signal, deadline);
				await this.admission.admitted();
				signal.throwIfAborted();
				if (Date.now() >= scriptDeadline) throw new WorkerWaitError("The codemode script timed out before worker launch.");
				sandbox = new CodemodeSandbox({ ...this.options, acquireWorker: () => {
					// wasm loading is asynchronous and can finish after the result or close().
					if (finished || signal.aborted || Date.now() >= scriptDeadline) throw new Error("The codemode worker launch was cancelled.");
					claimed = true;
					return () => release?.();
				} });
				this.sandboxes.add(sandbox);
				run = sandbox.start(code, { ...options, signal, ...(Number.isFinite(scriptDeadline) ? { timeoutMs: Math.max(1, scriptDeadline - Date.now()) } : {}) });
				return await run.result;
			} catch (error) {
				return waitFailure(error, signal);
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
