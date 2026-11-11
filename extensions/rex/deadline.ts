export type StopReason = "timeout" | "cancelled";
export type BudgetPhase = "resolve" | "observe" | "effect" | "finalise";
export interface RexBudget {
	readonly effectiveMs: number;
	readonly startedAt: number;
	readonly workEndsAt: number;
	readonly endsAt: number;
	readonly signal: AbortSignal;
	readonly finaliseSignal: AbortSignal;
	readonly phase: BudgetPhase;
	elapsed(): number;
	remaining(phase: "work" | "finalise"): number;
	check(phase: BudgetPhase): void;
	stopReason(): StopReason | undefined;
	dispose(): void;
}
export interface BudgetClock {
	now(): number;
	schedule(action: () => void, milliseconds: number): () => void;
}
const clock: BudgetClock = {
	now: () => performance.now(),
	schedule: (action, milliseconds) => { const timer = setTimeout(action, milliseconds); return () => clearTimeout(timer); },
};
export function deadlineCoverage(budget: RexBudget) {
	const elapsedMs = Math.ceil(budget.elapsed());
	return { effectiveMs: budget.effectiveMs, elapsedMs, phase: budget.phase, ...(elapsedMs > budget.effectiveMs ? { overrunMs: elapsedMs - budget.effectiveMs } : {}) };
}
export class RexStopped extends Error {
	readonly reason: StopReason;
	readonly phase: BudgetPhase;
	constructor(reason: StopReason, phase: BudgetPhase) { super(`Rex ${phase} stopped: ${reason}.`); this.reason = reason; this.phase = phase; }
}
/** One operation owns both active work and its bounded mandatory finalisation. */
export function createRexBudget(requested: number | undefined, cap: number, caller?: AbortSignal, time: BudgetClock = clock): RexBudget {
	const value = requested ?? Math.min(30000, cap);
	if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw new Error("Rex timeoutMs must be an integer from 1 to 300000.");
	const effectiveMs = Math.min(value, cap);
	const startedAt = time.now();
	const reserve = Math.min(1000, Math.max(1, Math.floor(effectiveMs / 10)));
	const workEndsAt = startedAt + effectiveMs - reserve;
	let endsAt = startedAt + effectiveMs;
	const work = new AbortController();
	const finalise = new AbortController();
	let reason: StopReason | undefined;
	let phase: BudgetPhase = "resolve";
	let cancelWork: (() => void) | undefined;
	let cancelFinal: (() => void) | undefined;
	const stop = (cause: StopReason) => { reason ??= cause; work.abort(); };
	const armFinal = () => { cancelFinal?.(); cancelFinal = time.schedule(() => finalise.abort(), Math.max(0, endsAt - time.now())); };
	const cancel = () => {
		if (time.now() >= workEndsAt) stop("timeout");
		else stop("cancelled");
		endsAt = Math.min(endsAt, time.now() + reserve);
		armFinal();
	};
	cancelWork = time.schedule(() => stop("timeout"), Math.max(0, workEndsAt - time.now()));
	armFinal();
	caller?.addEventListener("abort", cancel, { once: true });
	if (caller?.aborted) cancel();
	const refresh = () => {
		if (time.now() >= workEndsAt) stop("timeout");
		if (time.now() >= endsAt) finalise.abort();
	};
	return {
		effectiveMs, startedAt, workEndsAt,
		get endsAt() { return endsAt; },
		get phase() { return phase; },
		signal: work.signal, finaliseSignal: finalise.signal,
		elapsed: () => Math.max(0, time.now() - startedAt),
		remaining: (kind) => { refresh(); return Math.max(0, (kind === "work" ? workEndsAt : endsAt) - time.now()); },
		check: (next) => {
			phase = next; refresh();
			if (next === "finalise" ? finalise.signal.aborted : work.signal.aborted) throw new RexStopped(reason ?? "timeout", next);
		},
		stopReason: () => { refresh(); return reason; },
		dispose: () => { cancelWork?.(); cancelFinal?.(); caller?.removeEventListener("abort", cancel); },
	};
}
