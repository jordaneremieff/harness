/** Bounded observation periods. The runtime owns terminal-call deduplication. */
import { createHash } from "node:crypto";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import { cloneJson, readPath, UNKNOWN } from "./data.ts";
import { evaluateCondition, PROGRAM_LIMITS, type ProgramRule, type StateSpec } from "./program.ts";
import type { ObservationClock } from "./observation-clock.ts";

export const STATE_LIMITS = {
	turns: 1024,
	events: 1024,
	total: Number.MAX_SAFE_INTEGER,
	keyBytes: 256,
	keysPerRule: 32,
	keysPerSession: 128,
} as const;

/** JSON-safe persistence form of one window sample. */
export type StoredEventSample = { at: number; turn: number; total: number | null };
/** JSON-safe persistence form of one turn counter entry. */
export type StoredTurnCounters = { turn: number; count: number; total: number | null };
type StoredObservationCounters = {
	count: number;
	total: number | null;
	turns: StoredTurnCounters[];
	currentTurn?: StoredTurnCounters;
	turnsUnavailable: boolean;
	window: StoredEventSample[];
	saturated: boolean;
};
/** JSON-safe persistence form of one observation period. `spec` is stored JSON. */
export type StoredObservationPeriod = StoredObservationCounters & {
	id: string;
	revision: string;
	generation: number;
	spec?: JsonRepresentation<StateSpec>;
	startedAt: number;
	resetReason: string;
	projected: number;
	lastProjectedAt?: number;
	projectedTurns: number[];
	partitions?: Record<string, StoredObservationCounters>;
};
/** JSON-safe persistence form of the whole observation state. */
export type StoredObservationState = { nextGeneration: number; periods: StoredObservationPeriod[] };
export interface StatePin {
	id: string;
	revision: string;
	generation: number;
}
export interface StateView extends StatePin {
	startedAt: number;
	resetReason: string;
	count: number | typeof UNKNOWN;
	total: number | typeof UNKNOWN;
	turns: number | typeof UNKNOWN;
	windowCount: number | typeof UNKNOWN;
	windowTotal: number | typeof UNKNOWN;
	windowTurns: number | typeof UNKNOWN;
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
interface ObservationCounters {
	count: number;
	total: ObservedTotal;
	turns: Map<number, { count: number; total: ObservedTotal }>;
	currentTurn?: { turn: number; count: number; total: ObservedTotal };
	turnsUnavailable: boolean;
	window: EventSample[];
	saturated: boolean;
}
interface ObservationPeriod extends StatePin, ObservationCounters {
	spec?: StateSpec;
	startedAt: number;
	resetReason: string;
	projected: number;
	lastProjectedAt?: number;
	projectedTurns: Set<number>;
	partitions?: Map<string, ObservationCounters>;
}

function emptyCounters(): ObservationCounters {
	return { count: 0, total: 0, turns: new Map(), turnsUnavailable: false, window: [], saturated: false };
}

const EMPTY_COUNTERS = emptyCounters();

function keyDigest(path: readonly string[], facts: Record<string, unknown>): string | undefined {
	const key = readPath(facts, path).value;
	if (
		typeof key !== "string" ||
		!key.length ||
		key.length > STATE_LIMITS.keyBytes ||
		/[\uD800-\uDFFF]/u.test(key) ||
		Buffer.byteLength(key, "utf8") > STATE_LIMITS.keyBytes
	)
		return undefined;
	return createHash("sha256").update(key, "utf8").digest("hex");
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
function countOutcome(period: ObservationCounters, total: ObservedTotal): void {
	if (period.count === STATE_LIMITS.total) period.saturated = true;
	period.count = Math.min(STATE_LIMITS.total, period.count + 1);
	period.total = addTotal(period.total, total);
}

/** Turn accounting stops at the turn bound and marks the hidden turns unavailable. */
function countTurnSample(period: ObservationCounters, turn: number, total: ObservedTotal): void {
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
function countCurrentTurn(period: ObservationCounters, turn: number, total: ObservedTotal): void {
	const current = period.currentTurn;
	if (!current || turn > current.turn) {
		period.currentTurn = { turn, count: 1, total };
		return;
	}
	if (turn !== current.turn) return;
	current.count = Math.min(STATE_LIMITS.total, current.count + 1);
	current.total = addTotal(current.total, total);
}

function withinWindow(at: number, now: number, maxAge: number): boolean {
	const age = now - at;
	return age >= 0 && age < maxAge;
}

/** The age bound drops samples before the event bound trims the remaining window. */
function recordWindow(
	period: ObservationCounters,
	window: NonNullable<StateSpec["window"]>,
	sample: EventSample,
): void {
	period.window = period.window.filter((event) => withinWindow(event.at, sample.at, window.maxAgeMs));
	period.window.push(sample);
	if (period.window.length > window.maxEvents) period.window.splice(0, period.window.length - window.maxEvents);
}

/** Invalid or expired periods report empty counters without changing live state. */
function expiredView(id: string, period: ObservationPeriod, now: number, reason = "expiry"): StateView {
	return {
		id,
		revision: period.revision,
		generation: period.generation,
		startedAt: now,
		resetReason: reason,
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
function turnCounters(period: ObservationCounters, turn: number): { count: ObservedTotal; total: ObservedTotal } {
	const current = period.currentTurn?.turn === turn ? period.currentTurn : period.turns.get(turn);
	if (current) return { count: current.count, total: current.total };
	const absent = period.turnsUnavailable && turn < (period.currentTurn?.turn ?? 0) ? UNKNOWN : 0;
	return { count: absent, total: absent };
}

export class ObservationState {
	private readonly periods = new Map<string, ObservationPeriod>();
	private nextGeneration = 0;
	private partitionCount = 0;

	private readonly clock?: ObservationClock;

	constructor(clock?: ObservationClock) {
		this.clock = clock;
	}

	private resolveTime(now: number): number {
		return this.clock ? this.clock.now() : now;
	}

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
			...emptyCounters(),
			projected: 0,
			projectedTurns: new Set(),
			...(spec?.keyPath ? { partitions: new Map() } : {}),
		};
	}
	private replace(id: string, next?: ObservationPeriod): void {
		const previousSize = this.periods.get(id)?.partitions?.size ?? 0;
		this.partitionCount += (next?.partitions?.size ?? 0) - previousSize;
		if (next) this.periods.set(id, next);
		else this.periods.delete(id);
	}

	private expired(period: ObservationPeriod, now: number): boolean {
		return period.spec?.expiresAfterMs !== undefined && now - period.startedAt >= period.spec.expiresAfterMs;
	}
	private expire(period: ObservationPeriod, now: number): ObservationPeriod {
		if (now < period.startedAt) {
			this.nextGeneration = Math.max(this.nextGeneration, period.generation);
			const next = this.fresh(period.id, period.revision, period.spec, "clock-regression", now);
			this.replace(period.id, next);
			return next;
		}
		if (this.expired(period, now)) {
			const next = this.fresh(period.id, period.revision, period.spec, "expiry", now);
			next.generation = period.generation;
			this.replace(period.id, next);
			return next;
		}
		if (period.lastProjectedAt !== undefined && period.lastProjectedAt > now) delete period.lastProjectedAt;
		if (period.spec?.window) {
			const maxAge = period.spec.window.maxAgeMs;
			for (const counters of period.partitions?.values() ?? [period])
				counters.window = counters.window.filter((event) => withinWindow(event.at, now, maxAge));
		}
		return period;
	}

	/** Pass only active rules. Absence, revision changes, and return start new periods. */
	sync(rules: readonly ProgramRule[], now: number): void {
		now = this.resolveTime(now);
		if (!validTime(now)) throw new Error("Invalid observation time");
		if (rules.length > PROGRAM_LIMITS.rules || new Set(rules.map((rule) => rule.id)).size !== rules.length)
			throw new Error("Invalid observation rule set");
		const ids = new Set(rules.map((rule) => rule.id));
		for (const id of this.periods.keys()) if (!ids.has(id)) this.replace(id);
		for (const rule of rules) {
			const prior = this.periods.get(rule.id);
			if (!prior || prior.revision !== rule.revision)
				this.replace(
					rule.id,
					this.fresh(rule.id, rule.revision, rule.program.state, prior ? "semantic-revision" : "activation", now),
				);
			else this.expire(prior, now);
		}
	}

	reset(reason: string, now: number, id?: string): void {
		now = this.resolveTime(now);
		if (!validTime(now)) throw new Error("Invalid observation time");
		for (const [key, period] of this.periods)
			if (id === undefined || key === id) this.replace(key, this.fresh(key, period.revision, period.spec, reason, now));
	}
	pin(id: string): StatePin | undefined {
		const period = this.periods.get(id);
		return period ? { id, revision: period.revision, generation: period.generation } : undefined;
	}

	/** One completed outcome enters one period only when its captured identity remains current. */
	complete(pin: StatePin, facts: Record<string, unknown>, turn: number, now: number): boolean {
		now = this.resolveTime(now);
		if (!validTime(now) || !Number.isSafeInteger(turn) || turn < 0) return false;
		let period = this.periods.get(pin.id);
		if (!period) return false;
		period = this.expire(period, now);
		if (period.revision !== pin.revision || period.generation !== pin.generation || now < period.startedAt)
			return false;
		const spec = period.spec;
		if (!spec) return true;
		if (spec.keyPath && period.partitions) {
			this.completePartition(period, period.partitions, spec, spec.keyPath, facts, turn, now);
			return true;
		}
		const actual = { ...facts, state: this.viewAt(pin.id, now, turn) };
		if (spec.resetWhen && evaluateCondition(spec.resetWhen, actual) === true)
			period = this.resetForOutcome(period, spec, now);
		if (evaluateCondition(spec.observe, { ...facts, state: this.viewAt(pin.id, now, turn) }) !== true) return true;
		this.record(period, spec, facts, turn, now);
		return true;
	}

	private record(
		counters: ObservationCounters,
		spec: StateSpec,
		facts: Record<string, unknown>,
		turn: number,
		now: number,
	): void {
		const total = outcomeTotal(spec, facts);
		countOutcome(counters, total);
		countTurnSample(counters, turn, total);
		countCurrentTurn(counters, turn, total);
		if (spec.window) recordWindow(counters, spec.window, { at: now, turn, total });
	}

	private partitionsFull(partitions: ReadonlyMap<string, ObservationCounters>): boolean {
		return partitions.size >= STATE_LIMITS.keysPerRule || this.partitionCount >= STATE_LIMITS.keysPerSession;
	}

	private completePartition(
		period: ObservationPeriod,
		partitions: Map<string, ObservationCounters>,
		spec: StateSpec,
		path: readonly string[],
		facts: Record<string, unknown>,
		turn: number,
		now: number,
	): void {
		const key = keyDigest(path, facts);
		if (!key) return;
		let counters = partitions.get(key);
		if (!counters && this.partitionsFull(partitions)) return;
		const state = () => this.liveView(period.id, period, now, turn, counters ?? EMPTY_COUNTERS);
		if (counters && spec.resetWhen && evaluateCondition(spec.resetWhen, { ...facts, state: state() }) === true) {
			partitions.delete(key);
			this.partitionCount--;
			counters = undefined;
		}
		if (evaluateCondition(spec.observe, { ...facts, state: state() }) !== true) return;
		if (!counters) {
			counters = emptyCounters();
			partitions.set(key, counters);
			this.partitionCount++;
		}
		this.record(counters, spec, facts, turn, now);
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
		return (
			period.lastProjectedAt === undefined ||
			period.lastProjectedAt > now ||
			now - period.lastProjectedAt >= (period.spec?.cooldownMs ?? 0)
		);
	}

	/** Views project expiry without changing the live period, for read-only previews. */
	view(id: string, now: number, turn = 0): StateView | undefined {
		return this.viewAt(id, this.resolveTime(now), turn);
	}

	private viewAt(id: string, now: number, turn: number): StateView | undefined {
		const period = this.periods.get(id);
		if (!period || !validTime(now)) return undefined;
		const view =
			now < period.startedAt
				? expiredView(id, period, now, "clock-regression")
				: this.expired(period, now)
					? expiredView(id, period, now)
					: this.liveView(id, period, now, turn);
		if (!period.partitions) return view;
		return {
			...view,
			count: UNKNOWN,
			total: UNKNOWN,
			turns: UNKNOWN,
			windowCount: UNKNOWN,
			windowTotal: UNKNOWN,
			windowTurns: UNKNOWN,
			turnCount: UNKNOWN,
			turnTotal: UNKNOWN,
			saturated: view.saturated || (view.startedAt === period.startedAt && this.partitionsFull(period.partitions)),
		};
	}

	/** Resolve a tool phase's state from the same decoded input facts as its conditions. */
	viewFor(id: string, facts: Record<string, unknown>, now: number, turn: number): StateView | undefined {
		now = this.resolveTime(now);
		const period = this.periods.get(id);
		if (!period || !validTime(now)) return undefined;
		const { partitions, spec } = period;
		if (!partitions || !spec?.keyPath) return undefined;
		const key = keyDigest(spec.keyPath, facts);
		if (!key) return undefined;
		if (now < period.startedAt || this.expired(period, now)) {
			if (this.partitionCount - partitions.size >= STATE_LIMITS.keysPerSession) return undefined;
			return expiredView(id, period, now, now < period.startedAt ? "clock-regression" : "expiry");
		}
		const counters = partitions.get(key);
		if (!counters && this.partitionsFull(partitions)) return undefined;
		return this.liveView(id, period, now, turn, counters ?? EMPTY_COUNTERS);
	}

	private liveView(
		id: string,
		period: ObservationPeriod,
		now: number,
		turn: number,
		stats = period as ObservationCounters,
	): StateView {
		const events = stats.window.filter((event) => withinWindow(event.at, now, period.spec?.window?.maxAgeMs ?? 0));
		const counters = turnCounters(stats, turn);
		return {
			id,
			revision: period.revision,
			generation: period.generation,
			startedAt: period.startedAt,
			resetReason: period.resetReason,
			count: stats.count,
			total: stats.total,
			turns: stats.turnsUnavailable ? UNKNOWN : stats.turns.size,
			windowCount: events.length,
			windowTotal: events.reduce<ObservedTotal>((sum, event) => addTotal(sum, event.total), 0),
			windowTurns: new Set(events.map((event) => event.turn)).size,
			turnCount: counters.count,
			turnTotal: counters.total,
			projected: period.projected,
			eligible: this.isEligible(period, now, turn),
			saturated: period.saturated || stats.saturated,
		};
	}
	eligible(id: string, now: number, turn: number): boolean {
		return this.viewAt(id, this.resolveTime(now), turn)?.eligible === true;
	}

	/** The caller invokes this only after actual eligible context or result projection. */
	project(id: string, now: number, turn: number): boolean {
		now = this.resolveTime(now);
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
		now = this.resolveTime(now);
		return [...this.periods.keys()].sort().flatMap((id) => {
			const view = this.viewAt(id, now, turn);
			return view ? [view] : [];
		});
	}

	/** Serialize the complete observation state for durable storage. */
	toJSON(): StoredObservationState {
		return {
			nextGeneration: this.nextGeneration,
			periods: [...this.periods.values()].map((period) => ({
				id: period.id,
				revision: period.revision,
				generation: period.generation,
				...(period.spec ? { spec: cloneJson(period.spec) } : {}),
				startedAt: period.startedAt,
				resetReason: period.resetReason,
				...serializeCounters(period),
				projected: period.projected,
				...(period.lastProjectedAt !== undefined ? { lastProjectedAt: period.lastProjectedAt } : {}),
				projectedTurns: [...period.projectedTurns],
				...(period.partitions
					? {
							partitions: Object.fromEntries(
								[...period.partitions].map(([key, counters]) => [key, serializeCounters(counters)]),
							),
						}
					: {}),
			})),
		};
	}

	/** Restore a persisted state, or undefined when the stored value is not usable. */
	static fromJSON(value: unknown, clock?: ObservationClock): ObservationState | undefined {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const raw = value as { nextGeneration?: unknown; periods?: unknown };
		if (!safeCount(raw.nextGeneration)) return undefined;
		if (!Array.isArray(raw.periods) || raw.periods.length > PROGRAM_LIMITS.rules) return undefined;
		const state = new ObservationState(clock);
		state.nextGeneration = raw.nextGeneration;
		for (const entry of raw.periods) {
			const period = storedPeriod(entry);
			if (!period || state.periods.has(period.id)) return undefined;
			state.partitionCount += period.partitions?.size ?? 0;
			if (state.partitionCount > STATE_LIMITS.keysPerSession) return undefined;
			state.periods.set(period.id, period);
		}
		return state;
	}
}

function serializeCounters(counters: ObservationCounters): StoredObservationCounters {
	return {
		count: counters.count,
		total: storedTotal(counters.total),
		turns: [...counters.turns].map(([turn, stats]) => ({ turn, count: stats.count, total: storedTotal(stats.total) })),
		...(counters.currentTurn
			? {
					currentTurn: { ...counters.currentTurn, total: storedTotal(counters.currentTurn.total) },
				}
			: {}),
		turnsUnavailable: counters.turnsUnavailable,
		window: counters.window.map((sample) => ({ ...sample, total: storedTotal(sample.total) })),
		saturated: counters.saturated,
	};
}

function storedTotal(total: ObservedTotal): number | null {
	return total === UNKNOWN ? null : total;
}
function storedFromTotal(value: unknown): ObservedTotal {
	return (
		value === null ? UNKNOWN : typeof value === "number" && Number.isFinite(value) ? value : UNKNOWN
	) as ObservedTotal;
}
function safeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function storedEventSample(value: unknown): EventSample | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as { at?: unknown; turn?: unknown; total?: unknown };
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || !safeCount(raw.turn)) return undefined;
	return { at: raw.at, turn: raw.turn, total: storedFromTotal(raw.total) };
}
function storedTurns(value: unknown): Map<number, { count: number; total: ObservedTotal }> {
	const turns = new Map<number, { count: number; total: ObservedTotal }>();
	if (!Array.isArray(value)) return turns;
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const stats = entry as { turn?: unknown; count?: unknown; total?: unknown };
		if (!safeCount(stats.turn) || !safeCount(stats.count)) continue;
		turns.set(stats.turn, { count: stats.count, total: storedFromTotal(stats.total) });
	}
	return turns;
}
function storedWindow(value: unknown): EventSample[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const sample = storedEventSample(entry);
		return sample ? [sample] : [];
	});
}
function storedProjectedTurns(value: unknown): Set<number> {
	const turns = new Set<number>();
	if (!Array.isArray(value)) return turns;
	for (const turn of value) if (safeCount(turn)) turns.add(turn);
	return turns;
}
function storedSpec(value: unknown): StateSpec | undefined {
	if (value === undefined) return undefined;
	try {
		return cloneJson(value) as StateSpec;
	} catch {
		return undefined;
	}
}
function storedCurrentTurn(value: unknown): ObservationPeriod["currentTurn"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const current = value as { turn?: unknown; count?: unknown; total?: unknown };
	return safeCount(current.turn) && safeCount(current.count)
		? { turn: current.turn, count: current.count, total: storedFromTotal(current.total) }
		: undefined;
}
function storedCounters(raw: Record<string, unknown>): ObservationCounters | undefined {
	if (!safeCount(raw.count)) return undefined;
	const currentTurn = storedCurrentTurn(raw.currentTurn);
	return {
		count: raw.count,
		total: storedFromTotal(raw.total),
		turns: storedTurns(raw.turns),
		...(currentTurn ? { currentTurn } : {}),
		turnsUnavailable: raw.turnsUnavailable === true,
		window: storedWindow(raw.window),
		saturated: raw.saturated === true,
	};
}

function storedPartition(value: unknown, maxEvents: number): ObservationCounters | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const fields = value as Record<string, unknown>;
	if (!Array.isArray(fields.turns) || fields.turns.length > STATE_LIMITS.turns) return undefined;
	if (!Array.isArray(fields.window) || fields.window.length > maxEvents) return undefined;
	return storedCounters(fields);
}

function storedPartitions(
	value: unknown,
	spec: StateSpec | undefined,
): Map<string, ObservationCounters> | null | undefined {
	if (!spec?.keyPath) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	if (entries.length > STATE_LIMITS.keysPerRule) return null;
	const declaredMax = spec.window?.maxEvents;
	const maxEvents = safeCount(declaredMax) ? Math.min(STATE_LIMITS.events, declaredMax) : 0;
	const partitions = new Map<string, ObservationCounters>();
	for (const [key, raw] of entries) {
		if (!/^[0-9a-f]{64}$/.test(key)) return null;
		const counters = storedPartition(raw, maxEvents);
		if (!counters) return null;
		partitions.set(key, counters);
	}
	return partitions;
}

function storedPeriod(value: unknown): ObservationPeriod | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || typeof raw.revision !== "string") return undefined;
	if (!safeCount(raw.generation) || !safeCount(raw.projected)) return undefined;
	if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt)) return undefined;
	const counters = storedCounters(raw);
	if (!counters) return undefined;
	const spec = storedSpec(raw.spec);
	const partitions = storedPartitions(raw.partitions, spec);
	if (partitions === null) return undefined;
	return {
		id: raw.id,
		revision: raw.revision,
		generation: raw.generation,
		...(spec ? { spec } : {}),
		startedAt: raw.startedAt,
		resetReason: typeof raw.resetReason === "string" ? raw.resetReason : "restore",
		...counters,
		projected: raw.projected,
		...(typeof raw.lastProjectedAt === "number" && Number.isFinite(raw.lastProjectedAt)
			? { lastProjectedAt: raw.lastProjectedAt }
			: {}),
		projectedTurns: storedProjectedTurns(raw.projectedTurns),
		...(partitions ? { partitions } : {}),
	};
}
