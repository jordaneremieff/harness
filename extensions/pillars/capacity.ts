export const LIMITS = Object.freeze({
	days: 30,
	cellsPerDay: 2048,
	overflowPerDay: 2,
	ownersPerDay: 4096,
	shardBytes: 2 * 1024 * 1024,
	storeBytes: 64 * 1024 * 1024,
	controlBytes: 4096,
	entries: 32,
	batchCells: 2048,
	maxSeq: 2147483647,
	cellBytes: 864,
	lockMilliseconds: 100,
});
export const COUNTERS = [
	"readRequests", "readResults", "resultComplete", "resultPartial", "resultError", "resultUnknown",
	"bodyVerifiedAtObservation", "bodyMismatchedAtObservation", "bodyUnverifiable",
] as const;
export const HEALTH_COUNTERS = [
	"writeFailures", "unresolvedAccessEvents", "forkResets", "forkDroppedEvents", "pendingDroppedEvents",
] as const;
export type Counters = Record<(typeof COUNTERS)[number], number>;
export type HealthDelta = Partial<Record<(typeof HEALTH_COUNTERS)[number], number>>;
export type Health = Required<HealthDelta> & { cellsOverflowedEvents: number; receiptQuotaReached: boolean };
export type Stage = "tool_request" | "tool_result";
export type ResourceClass = "entry" | "inventory" | "governance" | "overflow";
export type Reasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "unknown";
export interface Cell {
	day: string;
	observationStage: Stage;
	resourceClass: ResourceClass;
	resourceId: string;
	model: string;
	reasoning: Reasoning;
	referenceBodyDigest: string;
	observerVersion: string;
	piVersion: string;
	counters: Counters;
}
export interface Receipt { owner: string; seq: number }
export interface Shard {
	schema: "pillars-day";
	schemaVersion: 1;
	day: string;
	retentionThroughDay: string;
	revision: number;
	cells: Cell[];
	receipts: Receipt[];
	health: Health;
}
export interface Snapshot { shards: Record<string, Shard> }
export interface Batch extends Receipt { day: string; cells: Cell[]; health?: HealthDelta }
export type CommitStatus = "committed" | "duplicate" | "receipt_quota" | "sequence_gap" | "outside_window" |
	"clock_rollback" | "counter_saturated" | "revision_saturated" | "byte_quota" | "publication_failed";
export interface Plan {
	status: CommitStatus;
	candidate?: Shard;
	slot?: string;
	expiredSlots: string[];
}

const CELL_FIELDS = ["day", "observationStage", "resourceClass", "resourceId", "model", "reasoning", "referenceBodyDigest", "observerVersion", "piVersion", "counters"];
const SHARD_FIELDS = ["schema", "schemaVersion", "day", "retentionThroughDay", "revision", "cells", "receipts", "health"];
const HEALTH_FIELDS = [...HEALTH_COUNTERS, "cellsOverflowedEvents", "receiptQuotaReached"];
const STAGES = ["tool_request", "tool_result"];
const RESOURCE_CLASSES = ["entry", "inventory", "governance", "overflow"];
const REASONING = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "unknown"];

function fail(): never { throw new Error("store_corrupt"); }
function object(value: unknown): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail();
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
	object(value);
	if (required.some((field) => !Object.hasOwn(value, field)) || Object.keys(value).some((field) => !required.includes(field) && !optional.includes(field))) fail();
}
function count(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail();
}
function text(value: unknown, pattern: RegExp): asserts value is string {
	if (typeof value !== "string" || !pattern.test(value)) fail();
}
export function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
export function zero(): Counters {
	return { readRequests: 0, readResults: 0, resultComplete: 0, resultPartial: 0, resultError: 0, resultUnknown: 0,
		bodyVerifiedAtObservation: 0, bodyMismatchedAtObservation: 0, bodyUnverifiable: 0 };
}
export function zeroHealth(): Health {
	return { writeFailures: 0, unresolvedAccessEvents: 0, forkResets: 0, forkDroppedEvents: 0, pendingDroppedEvents: 0,
		cellsOverflowedEvents: 0, receiptQuotaReached: false };
}
export function dayNumber(day: unknown): number {
	text(day, /^20\d{2}-\d{2}-\d{2}$/);
	const value = Date.parse(`${day}T00:00:00.000Z`);
	if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== day) fail();
	return value / 86400000;
}
export function inWindow(day: string, today: string): boolean {
	const difference = dayNumber(today) - dayNumber(day);
	return difference >= 0 && difference < LIMITS.days;
}
export function slotFor(day: string): string {
	return `day-${String(dayNumber(day) % LIMITS.days).padStart(2, "0")}.json`;
}
export function key(cell: Cell): string {
	return JSON.stringify([cell.day, cell.observationStage, cell.resourceClass, cell.resourceId, cell.model,
		cell.reasoning, cell.referenceBodyDigest, cell.observerVersion, cell.piVersion]);
}
export function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) throw new Error("counter_saturated");
	return result;
}
export function addCounters(left: Counters, right: Counters): Counters {
	const result = zero();
	for (const field of COUNTERS) result[field] = safeAdd(left[field], right[field]);
	return result;
}
function validateCellIdentity(value: Record<string, unknown>, day: string): void {
	dayNumber(value.day);
	if (value.day !== day || typeof value.observationStage !== "string" || !STAGES.includes(value.observationStage)) fail();
	if (typeof value.resourceClass !== "string" || !RESOURCE_CLASSES.includes(value.resourceClass)) fail();
	text(value.resourceId, /^[a-z0-9][a-z0-9-]{0,63}$/);
	if (value.resourceClass !== "entry" && value.resourceId !== value.resourceClass) fail();
	text(value.model, /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,63}$/);
	if (typeof value.reasoning !== "string" || !REASONING.includes(value.reasoning)) fail();
	text(value.referenceBodyDigest, /^(?:[a-f0-9]{64}|unresolved|other)$/);
}

function validateObserverVersions(value: Record<string, unknown>): void {
	for (const field of ["observerVersion", "piVersion"] as const) {
		const version = value[field];
		if (value.resourceClass === "overflow") {
			if (version !== "other") fail();
		} else {
			text(version, /^\d+\.\d+\.\d+$/);
			if (version.length > 32) fail();
		}
	}
}

function counterValue(counters: Record<string, unknown>, field: (typeof COUNTERS)[number]): number {
	const value = counters[field];
	count(value);
	return value;
}

function validateCounterPartitions(counters: Record<string, unknown>, stage: unknown, digest: unknown): void {
	const results = safeAdd(
		safeAdd(counterValue(counters, "resultComplete"), counterValue(counters, "resultPartial")),
		safeAdd(counterValue(counters, "resultError"), counterValue(counters, "resultUnknown")),
	);
	const attributed = safeAdd(
		counterValue(counters, "bodyVerifiedAtObservation"),
		counterValue(counters, "bodyMismatchedAtObservation"),
	);
	if (
		results !== counterValue(counters, "readResults") ||
		safeAdd(attributed, counterValue(counters, "bodyUnverifiable")) !== counterValue(counters, "readResults") ||
		attributed > counterValue(counters, "resultComplete")
	)
		fail();
	if (stage === "tool_request" ? COUNTERS.slice(1).some((field) => counterValue(counters, field) !== 0) : counterValue(counters, "readRequests") !== 0)
		fail();
	if (["unresolved", "other"].includes(typeof digest === "string" ? digest : "") && attributed !== 0) fail();
}

export function validateCell(value: unknown, day: string): asserts value is Cell {
	fields(value, CELL_FIELDS);
	validateCellIdentity(value, day);
	validateObserverVersions(value);
	if (value.resourceClass === "overflow" && (value.model !== "other" || value.reasoning !== "unknown" || value.referenceBodyDigest !== "unresolved")) fail();
	fields(value.counters, COUNTERS);
	for (const field of COUNTERS) count(value.counters[field]);
	validateCounterPartitions(value.counters, value.observationStage, value.referenceBodyDigest);
	if (bytes(value) > LIMITS.cellBytes) fail();
}
export function validateHealthDelta(value: unknown): asserts value is HealthDelta {
	fields(value, [], HEALTH_COUNTERS);
	for (const item of Object.values(value)) count(item);
}
function validateReceipt(value: unknown): asserts value is Receipt {
	fields(value, ["owner", "seq"]);
	text(value.owner, /^[a-f0-9]{32}$/);
	count(value.seq);
	if (value.seq < 1 || value.seq > LIMITS.maxSeq || bytes(value) > 64) fail();
}
export function validateBatch(value: unknown): asserts value is Batch {
	fields(value, ["owner", "seq", "day", "cells"], ["health"]);
	validateReceipt({ owner: value.owner, seq: value.seq });
	dayNumber(value.day);
	if (!Array.isArray(value.cells) || value.cells.length > LIMITS.batchCells) fail();
	for (const cell of value.cells) validateCell(cell, value.day as string);
	if (Object.hasOwn(value, "health")) validateHealthDelta(value.health);
	if (bytes(value) > LIMITS.shardBytes) fail();
}
function dayString(value: unknown): string {
	if (typeof value !== "string") fail();
	return value;
}

function validateShardCells(cells: unknown[], day: string): void {
	const identities = new Set<string>();
	let normal = 0;
	let total = zero();
	for (const cell of cells) {
		validateCell(cell, day);
		const identity = key(cell);
		if (identities.has(identity)) fail();
		identities.add(identity);
		if (cell.resourceClass !== "overflow" && ++normal > LIMITS.cellsPerDay) fail();
		total = addCounters(total, cell.counters);
	}
}

function validateReceipts(receipts: unknown[]): void {
	const owners = new Set<string>();
	for (const receipt of receipts) {
		validateReceipt(receipt);
		if (owners.has(receipt.owner)) fail();
		owners.add(receipt.owner);
	}
}

function validateShardHealth(health: unknown): void {
	fields(health, HEALTH_FIELDS);
	for (const field of [...HEALTH_COUNTERS, "cellsOverflowedEvents"]) count(health[field]);
	if (typeof health.receiptQuotaReached !== "boolean") fail();
}

export function validateShard(value: unknown, slot?: string): asserts value is Shard {
	fields(value, SHARD_FIELDS);
	if (value.schema !== "pillars-day" || value.schemaVersion !== 1) fail();
	const day = dayString(value.day);
	if (dayNumber(day) > dayNumber(value.retentionThroughDay)) fail();
	if (slot !== undefined && slot !== slotFor(day)) fail();
	count(value.revision);
	if (!Array.isArray(value.cells) || value.cells.length > LIMITS.cellsPerDay + LIMITS.overflowPerDay ||
		!Array.isArray(value.receipts) || value.receipts.length > LIMITS.ownersPerDay) fail();
	validateShardCells(value.cells, day);
	validateReceipts(value.receipts);
	validateShardHealth(value.health);
	if (bytes(value) > LIMITS.shardBytes) fail();
}
export function validateSnapshot(value: unknown, today?: string): asserts value is Snapshot {
	fields(value, ["shards"]);
	object(value.shards);
	const entries = Object.entries(value.shards);
	if (entries.length > LIMITS.days) fail();
	const slots = new Set<string>();
	let total = zero();
	const health = zeroHealth();
	for (const [day, shard] of entries) {
		validateShard(shard);
		if (day !== shard.day || slots.has(slotFor(day))) fail();
		slots.add(slotFor(day));
		if (today !== undefined && dayNumber(shard.retentionThroughDay) > dayNumber(today)) throw new Error("clock_rollback");
		for (const cell of shard.cells) total = addCounters(total, cell.counters);
		for (const field of [...HEALTH_COUNTERS, "cellsOverflowedEvents"] as const) health[field] = safeAdd(health[field], shard.health[field]);
	}
	if (today !== undefined) dayNumber(today);
}
export function emptyShard(day: string): Shard {
	dayNumber(day);
	return { schema: "pillars-day", schemaVersion: 1, day, retentionThroughDay: day, revision: 0,
		cells: [], receipts: [], health: zeroHealth() };
}
export function emptyStore(): Snapshot { return { shards: {} }; }
export function overflowCell(cell: Cell): Cell {
	return { day: cell.day, observationStage: cell.observationStage, resourceClass: "overflow", resourceId: "overflow",
		model: "other", reasoning: "unknown", referenceBodyDigest: "unresolved", observerVersion: "other", piVersion: "other",
		counters: { ...cell.counters, bodyVerifiedAtObservation: 0, bodyMismatchedAtObservation: 0, bodyUnverifiable: cell.counters.readResults } };
}
export function planBytes(snapshot: Snapshot, candidate: Shard, tempBytes = 0, controlBytes: number = LIMITS.controlBytes) {
	count(tempBytes); count(controlBytes);
	if (tempBytes > LIMITS.shardBytes || controlBytes > LIMITS.controlBytes) fail();
	const oldBytes = Object.values(snapshot.shards).reduce((sum, shard) => sum + bytes(shard), 0);
	const candidateBytes = bytes(candidate);
	const peakBytes = oldBytes + tempBytes + candidateBytes + controlBytes;
	return { oldBytes, candidateBytes, peakBytes, admitted: tempBytes === 0 && candidateBytes <= LIMITS.shardBytes && peakBytes <= LIMITS.storeBytes };
}

/** A candidate is the only publication unit: counters, health, and receipt advance together. */
export function planCommit(snapshot: Snapshot, batch: Batch, today: string): Plan {
	validateBatch(batch);
	dayNumber(today);
	validateSnapshot(snapshot);
	const stopped = (status: CommitStatus): Plan => ({ status, expiredSlots: [] });
	const admitted = admitCommit(snapshot, batch, today);
	if ("refusal" in admitted) return stopped(admitted.refusal);
	const { source, receipt } = admitted;
	const quota = !receipt && source.receipts.length === LIMITS.ownersPerDay;
	const candidate = structuredClone(source);
	candidate.retentionThroughDay = today;
	if (quota) candidate.health.receiptQuotaReached = true;
	else {
		try {
			applyBatch(snapshot, candidate, batch, today);
		} catch (error) {
			if (error instanceof Error && error.message === "counter_saturated") return stopped("counter_saturated");
			throw error;
		}
	}
	if (candidate.revision === Number.MAX_SAFE_INTEGER) return stopped("revision_saturated");
	candidate.revision++;
	if (!planBytes(snapshot, candidate).admitted) return stopped("byte_quota");
	return { status: quota ? "receipt_quota" : "committed", candidate, slot: slotFor(batch.day),
		expiredSlots: expiredSlots(snapshot, today, batch.day) };
}

function admitCommit(
	snapshot: Snapshot,
	batch: Batch,
	today: string,
): { refusal: CommitStatus } | { source: Shard; receipt: Receipt | undefined } {
	if (Object.values(snapshot.shards).some((shard) => dayNumber(shard.retentionThroughDay) > dayNumber(today)))
		return { refusal: "clock_rollback" };
	if (!inWindow(batch.day, today)) return { refusal: "outside_window" };
	const source = snapshot.shards[batch.day] ?? emptyShard(batch.day);
	const receipt = source.receipts.find((item) => item.owner === batch.owner);
	if (receipt && batch.seq <= receipt.seq) return { refusal: "duplicate" };
	if (batch.seq !== (receipt?.seq ?? 0) + 1) return { refusal: "sequence_gap" };
	return { source, receipt };
}

function applyBatch(snapshot: Snapshot, candidate: Shard, batch: Batch, today: string): void {
	for (const field of HEALTH_COUNTERS) candidate.health[field] = safeAdd(candidate.health[field], batch.health?.[field] ?? 0);
	const cells = new Map(candidate.cells.map((cell) => [key(cell), cell]));
	let normal = candidate.cells.filter((cell) => cell.resourceClass !== "overflow").length;
	for (const input of batch.cells) {
		let cell = input;
		if (cell.resourceClass === "overflow" || (!cells.has(key(cell)) && normal === LIMITS.cellsPerDay)) {
			cell = overflowCell(input);
			candidate.health.cellsOverflowedEvents = safeAdd(candidate.health.cellsOverflowedEvents, safeAdd(input.counters.readRequests, input.counters.readResults));
		} else if (!cells.has(key(cell))) normal++;
		cells.set(key(cell), { ...cell, counters: addCounters(cells.get(key(cell))?.counters ?? zero(), cell.counters) });
	}
	candidate.cells = [...cells.values()];
	const nextReceipt = candidate.receipts.find((item) => item.owner === batch.owner);
	if (nextReceipt) nextReceipt.seq = batch.seq;
	else candidate.receipts.push({ owner: batch.owner, seq: batch.seq });
	// Cross-cell sums also remain representable by the readback counter contract.
	validateShard(candidate);
	validateSnapshot({ shards: { ...Object.fromEntries(Object.entries(snapshot.shards).filter(([day]) => inWindow(day, today))), [batch.day]: candidate } });
}

function expiredSlots(snapshot: Snapshot, today: string, batchDay: string): string[] {
	return Object.values(snapshot.shards)
		.filter((shard) => !inWindow(shard.day, today) && slotFor(shard.day) !== slotFor(batchDay))
		.map((shard) => slotFor(shard.day));
}

/** Pure publication model, useful for deterministic failure and retry checks. */
export function commit(snapshot: Snapshot, batch: Batch, today: string, options: { publish?: boolean } = {}): { status: CommitStatus; store: Snapshot } {
	const plan = planCommit(snapshot, batch, today);
	if (!plan.candidate) return { status: plan.status, store: snapshot };
	if (options.publish === false) return { status: "publication_failed", store: snapshot };
	return { status: plan.status, store: { shards: {
		...Object.fromEntries(Object.entries(snapshot.shards).filter(([day]) => inWindow(day, today))), [batch.day]: plan.candidate,
	} } };
}
export function capture(snapshot: Snapshot, today: string): Snapshot {
	validateSnapshot(snapshot, today);
	return structuredClone({ shards: Object.fromEntries(Object.entries(snapshot.shards).filter(([day]) => inWindow(day, today))) });
}
