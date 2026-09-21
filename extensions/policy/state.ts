/** Bounded observation periods. The runtime owns terminal-call deduplication. */
import { cloneJson, readPath, UNKNOWN } from "./data.ts";
import { evaluateCondition, PROGRAM_LIMITS, type ProgramRule, type StateSpec } from "./program.ts";

export const STATE_LIMITS = { turns: 1024, events: 1024, total: Number.MAX_SAFE_INTEGER } as const;
export interface StatePin {
	id: string;
	revision: string;
	generation: number;
}
export interface StateView extends StatePin {
	startedAt: number;
	resetReason: string;
	count: number;
	total: number | typeof UNKNOWN;
	turns: number | typeof UNKNOWN;
	windowCount: number;
	windowTotal: number | typeof UNKNOWN;
	windowTurns: number;
	turnCount: number | typeof UNKNOWN;
	turnTotal: number | typeof UNKNOWN;
	projected: number;
	eligible: boolean;
	saturated: boolean;
}
type ObservedTotal = number | typeof UNKNOWN;
interface EventSample {
	at: number;
	turn: number;
	total: ObservedTotal;
}
interface ObservationPeriod extends StatePin {
	spec?: StateSpec;
	startedAt: number;
	resetReason: string;
	count: number;
	total: ObservedTotal;
	turns: Map<number, { count: number; total: ObservedTotal }>;
	currentTurn?: { turn: number; count: number; total: ObservedTotal };
	turnsUnavailable: boolean;
	window: EventSample[];
	projected: number;
	lastProjectedAt?: number;
	projectedTurns: Set<number>;
	saturated: boolean;
}
function validTime(now: number): boolean {
	return Number.isFinite(now) && now >= 0;
}
function finiteTotal(value: number): ObservedTotal {
	return Math.abs(value) > STATE_LIMITS.total ? UNKNOWN : value;
}
function addTotal(left: ObservedTotal, right: ObservedTotal): ObservedTotal {
	return left === UNKNOWN || right === UNKNOWN ? UNKNOWN : finiteTotal(left + right);
}

/** A declared total path supplies the outcome amount; every other outcome counts as one. */
function outcomeTotal(spec: StateSpec, facts: Record<string, unknown>): ObservedTotal {
	const value = spec.totalPath ? readPath(facts, spec.totalPath).value : 0;
	return typeof value === "number" && Number.isFinite(value) ? finiteTotal(value) : UNKNOWN;
}

/** Period counters saturate at the bound and report saturation instead of wrapping. */
function countOutcome(period: ObservationPeriod, total: ObservedTotal): void {
	if (period.count === STATE_LIMITS.total) period.saturated = true;
	period.count = Math.min(STATE_LIMITS.total, period.count + 1);
	period.total = addTotal(period.total, total);
}

/** Turn accounting stops at the turn bound and marks the hidden turns unavailable. */
function countTurnSample(period: ObservationPeriod, turn: number, total: ObservedTotal): void {
	let stats = period.turns.get(turn);
	if (!stats && period.turns.size < STATE_LIMITS.turns) {
		stats = { count: 0, total: 0 };
		period.turns.set(turn, stats);
	}
	if (!stats) {
		period.saturated = true;
		period.turnsUnavailable = true;
		return;
	}
	stats.count = Math.min(STATE_LIMITS.total, stats.count + 1);
	stats.total = addTotal(stats.total, total);
}

/** The newest turn stays visible after the turn map saturates. */
function countCurrentTurn(period: ObservationPeriod, turn: number, total: ObservedTotal): void {
	const current = period.currentTurn;
	if (!current || turn > current.turn) {
		period.currentTurn = { turn, count: 1, total };
		return;
	}
	if (turn !== current.turn) return;
	current.count = Math.min(STATE_LIMITS.total, current.count + 1);
	current.total = addTotal(current.total, total);
}

/** The age bound drops samples before the event bound trims the remaining window. */
function recordWindow(
	period: ObservationPeriod,
	window: NonNullable<StateSpec["window"]>,
	sample: EventSample,
): void {
	period.window = period.window.filter((event) => sample.at - event.at < window.maxAgeMs);
	period.window.push(sample);
	if (period.window.length > window.maxEvents) period.window.splice(0, period.window.length - window.maxEvents);
}

/** An expired period reports an empty period that starts at the reading time. */
function expiredView(id: string, period: ObservationPeriod, now: number): StateView {
	return {
		id,
		revision: period.revision,
		generation: period.generation,
		startedAt: now,
		resetReason: "expiry",
		count: 0,
		total: 0,
		turns: 0,
		windowCount: 0,
		windowTotal: 0,
		windowTurns: 0,
		turnCount: 0,
		turnTotal: 0,
		projected: 0,
		eligible: true,
		saturated: false,
	};
}

/** A turn without samples reads as zero, or as unavailable when saturation hid it. */
function turnCounters(period: ObservationPeriod, turn: number): { count: ObservedTotal; total: ObservedTotal } {
	const current = period.currentTurn?.turn === turn ? period.currentTurn : period.turns.get(turn);
	if (current) return { count: current.count, total: current.total };
	const absent = period.turnsUnavailable && turn < (period.currentTurn?.turn ?? 0) ? UNKNOWN : 0;
	return { count: absent, total: absent };
}

export class ObservationState {
	private readonly periods = new Map<string, ObservationPeriod>();
	private nextGeneration = 0;

	private fresh(
		id: string,
		revision: string,
		spec: StateSpec | undefined,
		reason: string,
		now: number,
	): ObservationPeriod {
		return {
			id,
			revision,
			generation: ++this.nextGeneration,
			...(spec ? { spec: cloneJson(spec) } : {}),
			startedAt: now,
			resetReason: reason.slice(0, 160),
			count: 0,
			total: 0,
			turns: new Map(),
			turnsUnavailable: false,
			window: [],
			projected: 0,
			projectedTurns: new Set(),
			saturated: false,
		};
	}
	private expired(period: ObservationPeriod, now: number): boolean {
		return period.spec?.expiresAfterMs !== undefined && now - period.startedAt >= period.spec.expiresAfterMs;
	}
	private expire(period: ObservationPeriod, now: number): ObservationPeriod {
		if (!this.expired(period, now)) return period;
		const next = this.fresh(period.id, period.revision, period.spec, "expiry", now);
		next.generation = period.generation;
		this.periods.set(period.id, next);
		return next;
	}

	/** Pass only active rules. Absence, revision changes, and return start new periods. */
	sync(rules: readonly ProgramRule[], now: number): void {
		if (!validTime(now)) throw new Error("Invalid observation time");
		if (rules.length > PROGRAM_LIMITS.rules || new Set(rules.map((rule) => rule.id)).size !== rules.length)
			throw new Error("Invalid observation rule set");
		const ids = new Set(rules.map((rule) => rule.id));
		for (const id of this.periods.keys()) if (!ids.has(id)) this.periods.delete(id);
		for (const rule of rules) {
			const prior = this.periods.get(rule.id);
			if (!prior || prior.revision !== rule.revision)
				this.periods.set(
					rule.id,
					this.fresh(rule.id, rule.revision, rule.program.state, prior ? "semantic-revision" : "activation", now),
				);
			else this.expire(prior, now);
		}
	}

	reset(reason: string, now: number, id?: string): void {
		if (!validTime(now)) throw new Error("Invalid observation time");
		for (const [key, period] of this.periods)
			if (id === undefined || key === id)
				this.periods.set(key, this.fresh(key, period.revision, period.spec, reason, now));
	}
	pin(id: string): StatePin | undefined {
		const period = this.periods.get(id);
		return period ? { id, revision: period.revision, generation: period.generation } : undefined;
	}

	/** One completed outcome enters one period only when its captured identity remains current. */
	complete(pin: StatePin, facts: Record<string, unknown>, turn: number, now: number): boolean {
		if (!validTime(now) || !Number.isSafeInteger(turn) || turn < 0) return false;
		let period = this.periods.get(pin.id);
		if (!period) return false;
		period = this.expire(period, now);
		if (period.revision !== pin.revision || period.generation !== pin.generation || now < period.startedAt)
			return false;
		const spec = period.spec;
		if (!spec) return true;
		const actual = { ...facts, state: this.view(pin.id, now, turn) };
		if (spec.resetWhen && evaluateCondition(spec.resetWhen, actual) === true)
			period = this.resetForOutcome(period, spec, now);
		if (evaluateCondition(spec.observe, { ...facts, state: this.view(pin.id, now, turn) }) !== true) return true;
		const total = outcomeTotal(spec, facts);
		countOutcome(period, total);
		countTurnSample(period, turn, total);
		countCurrentTurn(period, turn, total);
		if (spec.window) recordWindow(period, spec.window, { at: now, turn, total });
		return true;
	}

	/** Outcome resets preserve the admission generation for concurrent completions. */
	private resetForOutcome(period: ObservationPeriod, spec: StateSpec, now: number): ObservationPeriod {
		const reset = this.fresh(period.id, period.revision, spec, "condition", now);
		reset.generation = period.generation;
		this.periods.set(period.id, reset);
		return reset;
	}

	private isEligible(period: ObservationPeriod, now: number, turn: number): boolean {
		if (period.spec?.once === "period" && period.projected > 0) return false;
		if (
			period.spec?.once === "turn" &&
			(period.projectedTurns.has(turn) || period.projectedTurns.size >= STATE_LIMITS.turns)
		)
			return false;
		return period.lastProjectedAt === undefined || now - period.lastProjectedAt >= (period.spec?.cooldownMs ?? 0);
	}

	/** Views project expiry without changing the live period, for read-only previews. */
	view(id: string, now: number, turn = 0): StateView | undefined {
		const period = this.periods.get(id);
		if (!period || !validTime(now)) return undefined;
		return this.expired(period, now) ? expiredView(id, period, now) : this.liveView(id, period, now, turn);
	}

	private liveView(id: string, period: ObservationPeriod, now: number, turn: number): StateView {
		const events = period.window.filter((event) => now - event.at < (period.spec?.window?.maxAgeMs ?? 0));
		const counters = turnCounters(period, turn);
		return {
			id,
			revision: period.revision,
			generation: period.generation,
			startedAt: period.startedAt,
			resetReason: period.resetReason,
			count: period.count,
			total: period.total,
			turns: period.turnsUnavailable ? UNKNOWN : period.turns.size,
			windowCount: events.length,
			windowTotal: events.reduce<ObservedTotal>((sum, event) => addTotal(sum, event.total), 0),
			windowTurns: new Set(events.map((event) => event.turn)).size,
			turnCount: counters.count,
			turnTotal: counters.total,
			projected: period.projected,
			eligible: this.isEligible(period, now, turn),
			saturated: period.saturated,
		};
	}
	eligible(id: string, now: number, turn: number): boolean {
		return this.view(id, now, turn)?.eligible === true;
	}

	/** The caller invokes this only after actual eligible context or result projection. */
	project(id: string, now: number, turn: number): boolean {
		if (!validTime(now) || !Number.isSafeInteger(turn) || turn < 0) return false;
		let period = this.periods.get(id);
		if (!period) return false;
		period = this.expire(period, now);
		if (!this.isEligible(period, now, turn)) return false;
		period.projected = Math.min(STATE_LIMITS.total, period.projected + 1);
		period.lastProjectedAt = now;
		if (period.projectedTurns.size < STATE_LIMITS.turns) period.projectedTurns.add(turn);
		else period.saturated = true;
		return true;
	}
	snapshot(now: number, turn = 0): StateView[] {
		return [...this.periods.keys()].sort().flatMap((id) => {
			const view = this.view(id, now, turn);
			return view ? [view] : [];
		});
	}
}
