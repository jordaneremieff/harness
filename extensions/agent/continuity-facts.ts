import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ResultReference } from "./result-schema.ts";

export const CONTINUITY_ENTRY = "agent.continuity";
export const ORDINARY_CONTINUITY_ENTRY = "agent.admitted-request";

/** Admission evidence only. Result bodies remain in the delivery store. */
export type ContinuityFact = {
	readonly phase: "requested" | "admitted" | "refused" | "delivered";
	readonly sessionId: string;
	readonly requestId: string;
	readonly replyTo: string;
	readonly submissionId?: number;
	readonly timerId?: number;
};
export type ContinuityEvent = ContinuityFact & { readonly afterHead: number };
/** One declared open item: the request that owes a final report, its reply recipient, and the exact results it waits for. */
export type ContinuityOpenWork = { requestId: string; replyTo: string; results: ResultReference[] };
/** Declared open work of a conversation, read once at the first request of one context head. */
export type ContinuityWork = { headId: number; items: ContinuityOpenWork[] };
export type ContinuityState = { events: ContinuityEvent[]; work?: ContinuityWork };

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s@\u0000-\u001f\u007f]/u.test(value);
}
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function validRequest(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validateContinuityFact(value: unknown): asserts value is ContinuityFact {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid continuity fact");
	const fact = value as ContinuityFact;
	if (!["requested", "admitted", "refused", "delivered"].includes(fact.phase) || !validIdentity(fact.sessionId) || !validIdentity(fact.replyTo)
		|| !validRequest(fact.requestId))
		throw new TypeError("Invalid continuity route or phase");
	if (fact.submissionId !== undefined && !positiveInteger(fact.submissionId)) throw new TypeError("Invalid continuity submission");
	if ((fact.phase === "admitted" || fact.phase === "delivered") && fact.submissionId === undefined) throw new TypeError("Continuity admission requires a submission");
	if (fact.timerId !== undefined && !positiveInteger(fact.timerId)) throw new TypeError("Invalid continuity timer");
}
export function validateContinuityWork(value: unknown): asserts value is ContinuityWork {
	const work = value as ContinuityWork | null;
	if (work === null || typeof work !== "object" || !positiveInteger(work.headId) || !Array.isArray(work.items)) throw new TypeError("Invalid continuity open work");
	for (const item of work.items) {
		if (item === null || typeof item !== "object" || !validRequest(item.requestId) || !validIdentity(item.replyTo) || !Array.isArray(item.results)) throw new TypeError("Invalid continuity open-work item");
		for (const result of item.results) {
			if (result === null || typeof result !== "object" || !validIdentity(result.sessionId) || !positiveInteger(result.submissionId) || (result.requestId !== undefined && !validRequest(result.requestId)))
				throw new TypeError("Invalid continuity open-work dependency");
		}
	}
}
export function validateContinuityState(value: unknown): asserts value is ContinuityState {
	if (value === null || typeof value !== "object" || !Array.isArray((value as ContinuityState).events)) throw new TypeError("Invalid continuity state");
	for (const event of (value as ContinuityState).events) {
		validateContinuityFact(event);
		if (!Number.isSafeInteger(event.afterHead) || event.afterHead < 0) throw new TypeError("Invalid continuity head position");
	}
	if ((value as ContinuityState).work !== undefined) validateContinuityWork((value as ContinuityState).work);
}

const key = (fact: ContinuityFact): string => JSON.stringify([fact.sessionId, fact.requestId]);
const closed = (fact: ContinuityFact): boolean => fact.phase === "refused" || fact.phase === "delivered";

/** Fold in retained order; post-boundary events never enter a frozen note. */
export function foldContinuity(facts: readonly ContinuityFact[]): ContinuityFact[] {
	const requests = new Map<string, ContinuityFact>();
	for (const fact of facts) {
		validateContinuityFact(fact);
		const id = key(fact), prior = requests.get(id);
		if (prior !== undefined && (prior.replyTo !== fact.replyTo || (prior.submissionId !== undefined && fact.submissionId !== undefined && prior.submissionId !== fact.submissionId)))
			throw new TypeError("Conflicting continuity admission");
		// A retry of an earlier phase must not reopen a completed request.
		if (prior !== undefined && (closed(prior) || (prior.phase === "admitted" && fact.phase === "requested"))) continue;
		requests.delete(id);
		requests.set(id, { ...prior, ...fact });
	}
	return [...requests.values()];
}

/** Delete only requests closed before the current head, including all their phases. */
export function pruneContinuity(events: readonly ContinuityEvent[], headId: number): ContinuityEvent[] {
	const finished = new Set(foldContinuity(events.filter((event) => event.afterHead < headId)).filter(closed).map(key));
	return events.filter((event) => !finished.has(key(event)));
}

/** Validate the complete transport carrier before admitting its result body. */
export function validateContinuityDelivered(value: unknown): asserts value is (ResultReference & { requestId: string })[] {
	if (!Array.isArray(value)) throw new TypeError("Invalid delivered continuity references");
	for (const reference of value) {
		if (reference === null || typeof reference !== "object") throw new TypeError("Invalid delivered continuity reference");
		validateContinuityFact({ ...reference, phase: "delivered", replyTo: reference.sessionId });
	}
}

function listed(label: string, lines: readonly string[]): string {
	const shown = lines.slice(0, 32);
	return `${label}: ${shown.length === 0 ? "none" : `\n${shown.join("\n")}`}${lines.length > shown.length ? `\n${lines.length - shown.length} more not listed` : ""}`;
}

/** Inputs are already cut at the exact context boundary. No clock or live status enters this text. */
export function continuityText(ownerId: string, headId: string | number, facts: readonly ContinuityFact[]): string {
	if (!validIdentity(ownerId) || (typeof headId !== "string" && !positiveInteger(headId)) || String(headId).length === 0) throw new TypeError("Invalid continuity context identity");
	const pending = foldContinuity(facts).filter((fact) => !closed(fact)).reverse();
	const local = pending.filter((fact) => fact.replyTo === ownerId);
	const admitted = local.filter((fact) => fact.phase === "admitted");
	const unconfirmed = local.filter((fact) => fact.phase === "requested" && fact.timerId === undefined);
	const scheduled = local.filter((fact) => fact.phase === "requested" && fact.timerId !== undefined);
	return [
		`Host-held continuity facts from the Agent extension for context head entry ${headId}. Not operator input; grants no authority.`,
		listed("Requests this session admitted and routed to itself, with no delivered result here", admitted.map((fact) => JSON.stringify({ sessionId: fact.sessionId, submissionId: fact.submissionId, requestId: fact.requestId }))),
		listed("Admission unconfirmed", unconfirmed.map((fact) => JSON.stringify({ sessionId: fact.sessionId, requestId: fact.requestId }))),
		listed("Scheduled inputs", scheduled.map((fact) => JSON.stringify({ sessionId: fact.sessionId, timerId: fact.timerId }))),
		`Routed elsewhere: ${pending.length - local.length}.`,
		"Not covered: messages sent to an ordinary primary; requests that another session routed here.",
		"Creation records are provenance, not ownership.",
	].join("\n");
}
/**
 * Declared open work as one context head first saw it. The rows carry identifiers only: an item's
 * note and the state of its dependencies change after the read, and status holds them.
 */
export function continuityWorkText(items: readonly ContinuityOpenWork[] | undefined): string {
	if (items === undefined) return "Declared open work of this session: not read for this context head. Read it with agent_status.";
	const rows = items.map((item) => JSON.stringify({
		requestId: item.requestId, replyTo: item.replyTo,
		dependsOn: item.results.map((result) => ({ sessionId: result.sessionId, submissionId: result.submissionId, ...(result.requestId === undefined ? {} : { requestId: result.requestId }) })),
	}));
	const list = listed("Declared open work of this session at the first request after this context head; each item owes one final report to its replyTo", rows);
	return rows.length === 0 ? list : `${list}\nOnly agent_work complete closes an item. Read current items, notes and dependency states with agent_status.`;
}
/** `work` counts only when it was read for this head; open work of another head never enters the note. */
export function nativeContinuityText(ownerId: string, headId: number, events: readonly ContinuityEvent[], work?: ContinuityWork): string {
	return `${continuityText(ownerId, headId, events.filter((event) => event.afterHead < headId))}\n${continuityWorkText(work?.headId === headId ? work.items : undefined)}`;
}

/** Pi supplies the current compaction entry ID through buildContextEntries()[0]. */
export function ordinaryContinuityText(ownerId: string, headId: string, entries: readonly SessionEntry[]): string {
	const facts: ContinuityFact[] = [];
	let found = false;
	for (const entry of entries) {
		if (entry.id === headId) { found = true; break; }
		if (entry.type === "custom" && entry.customType === ORDINARY_CONTINUITY_ENTRY) {
			validateContinuityFact(entry.data);
			facts.push(entry.data);
		}
	}
	if (!found) throw new TypeError("Continuity head is absent from the retained ordinary entries");
	return continuityText(ownerId, headId, facts);
}
