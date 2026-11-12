import { isDeepStrictEqual } from "node:util";
import type { ContextEvent, ContextEventResult, ExtensionContext, SessionEntry, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { planningBudgetCrossed, planningBudgetSelfBody } from "./continuity-budget.ts";
import { ORDINARY_CONTINUITY_ENTRY, foldContinuity, ordinaryContinuityText, validateContinuityDelivered, validateContinuityFact, type ContinuityFact } from "./continuity-facts.ts";
import { projectOrdinaryContinuity } from "./continuity-projection.ts";
import { HostError } from "./host-protocol.ts";
import type { ResultReference } from "./result-schema.ts";
import { sentWorkIdentity } from "./session-work.ts";

/** Custom message type of the notice a session receives when it crosses its own planning budget. */
export const PLANNING_BUDGET_NOTICE = "agent.planning-budget";

export type ContinuityRecorder = (fact: ContinuityFact) => void;
export type DeliveredResult = ResultReference & { requestId: string };
export interface AdmissionTarget {
	/** The session that sends the request. It receives the answer unless `replyTo` names another identity. */
	readonly ownerId: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly replyTo?: unknown;
}

const key = (fact: Pick<ContinuityFact, "sessionId" | "requestId">): string => JSON.stringify([fact.sessionId, fact.requestId]);
const closed = (fact: ContinuityFact): boolean => fact.phase === "refused" || fact.phase === "delivered";
/** The root conversation's explicit spelling and its bare storage identity name one producer. */
const canonical = (identity: string): string => sentWorkIdentity(identity) ?? identity;

/**
 * Record the admission phases of one answer-bearing host call and return its outcome unchanged.
 * Only a host refusal with code `invalid` proves that nothing was admitted. Every other failure
 * leaves the request recorded as requested, so it stays listed as unconfirmed.
 */
export async function recordAdmission<T>(record: ContinuityRecorder | undefined, target: AdmissionTarget, call: () => Promise<T>): Promise<T> {
	if (record === undefined) return call();
	const route = { sessionId: canonical(target.sessionId), requestId: target.requestId, replyTo: typeof target.replyTo === "string" ? canonical(target.replyTo) : target.ownerId };
	record({ phase: "requested", ...route });
	let admission: T;
	try { admission = await call(); }
	catch (error) {
		if (error instanceof HostError && error.code === "invalid") record({ phase: "refused", ...route });
		throw error;
	}
	const submissionId = (admission as { submissionId?: unknown } | null)?.submissionId;
	if (typeof submissionId === "number" && Number.isSafeInteger(submissionId) && submissionId > 0) record({ phase: "admitted", ...route, submissionId });
	return admission;
}

/** Every result tuple a delivery settles, validated as a whole. A delivery without the carrier settles nothing. */
export function deliveredResults(details: unknown): readonly DeliveredResult[] {
	const carrier = details !== null && typeof details === "object" ? (details as { deliveredResults?: unknown }).deliveredResults : undefined;
	if (carrier === undefined) return [];
	validateContinuityDelivered(carrier);
	return carrier;
}

export interface OrdinaryContinuityOptions {
	/** Retain one fact as a session entry of kind `ORDINARY_CONTINUITY_ENTRY`. */
	readonly append: ContinuityRecorder;
	/** Exact-model planning budget in tokens; undefined when none is configured. */
	readonly budget: (provider: string, modelId: string) => number | undefined;
	/** Report a note that could not be built or placed; undefined clears the report. */
	readonly diagnose: (sessionId: string, text: string | undefined) => void;
	readonly now?: () => number;
}
type Note = { readonly headId: string; readonly text?: string };
type Episode = { readonly headId: string | undefined; previous?: number; noticed: boolean };
type SessionState = { readonly facts: Map<string, ContinuityFact>; note?: Note; diagnosed: boolean; episode: Episode };

/**
 * Continuity of one ordinary session across compactions: the retained admission facts, the frozen
 * note directly after the current compaction summary, and one notice per context episode when the
 * session crosses its planning budget.
 */
export class OrdinaryContinuity {
	private readonly sessions = new Map<string, SessionState>();
	private readonly options: OrdinaryContinuityOptions;
	constructor(options: OrdinaryContinuityOptions) { this.options = options; }

	private session(sessionId: string): SessionState {
		let state = this.sessions.get(sessionId);
		if (state === undefined) { state = { facts: new Map(), diagnosed: false, episode: { headId: undefined, noticed: false } }; this.sessions.set(sessionId, state); }
		return state;
	}

	/** Fold the retained facts once. An entry that is not a valid fact changes no request. */
	start(sessionId: string, entries: readonly SessionEntry[]): void {
		this.sessions.delete(sessionId);
		const facts = this.session(sessionId).facts;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ORDINARY_CONTINUITY_ENTRY) continue;
			try { this.apply(facts, entry.data as ContinuityFact); }
			catch { /* The note reports an invalid retained fact when its head needs it. */ }
		}
	}
	end(sessionId: string): void { this.sessions.delete(sessionId); }

	/** Returns whether the fact changes its request. A conflicting route throws and changes nothing. */
	private apply(facts: Map<string, ContinuityFact>, fact: ContinuityFact): boolean {
		validateContinuityFact(fact);
		const id = key(fact), prior = facts.get(id);
		// A refusal answers only a request without a confirmed admission; a result closes only a request sent here.
		if (fact.phase === "refused" && prior?.phase !== "requested") return false;
		if (fact.phase === "delivered" && (prior === undefined || closed(prior))) return false;
		const [next] = foldContinuity(prior === undefined ? [fact] : [prior, fact]);
		if (isDeepStrictEqual(next, prior)) return false;
		facts.delete(id);
		facts.set(id, next);
		return true;
	}

	/** Validate, then retain a fact that changes its request. A repeated phase writes nothing. */
	record(sessionId: string, fact: ContinuityFact): void {
		const facts = this.session(sessionId).facts, id = key(fact), prior = facts.get(id);
		if (!this.apply(facts, fact)) return;
		try { this.options.append(fact); }
		catch (error) {
			if (prior === undefined) facts.delete(id); else facts.set(id, prior);
			throw error;
		}
	}

	/** Close every delivered tuple that this session requested. Call only after the result body is accepted. */
	delivered(sessionId: string, results: readonly DeliveredResult[]): void {
		const facts = this.session(sessionId).facts;
		for (const result of results) {
			const prior = facts.get(key(result));
			// A tuple of another submission is not this request's result; the request stays listed.
			if (prior === undefined || (prior.submissionId !== undefined && prior.submissionId !== result.submissionId)) continue;
			this.record(sessionId, { phase: "delivered", sessionId: result.sessionId, requestId: result.requestId, replyTo: prior.replyTo, submissionId: result.submissionId });
		}
	}

	/**
	 * Insert the frozen note directly after the current compaction summary. The head is identified by
	 * its entry ID alone; the summary text only detects an inconsistent request.
	 */
	context(event: ContextEvent, ctx: Pick<ExtensionContext, "sessionManager">): ContextEventResult | undefined {
		const head = ctx.sessionManager.buildContextEntries()[0];
		if (head?.type !== "compaction") return undefined;
		const sessionId = ctx.sessionManager.getSessionId(), state = this.session(sessionId);
		if (state.note?.headId !== head.id) {
			try { state.note = { headId: head.id, text: ordinaryContinuityText(sessionId, head.id, ctx.sessionManager.getEntries()) }; }
			catch (error) {
				state.note = { headId: head.id };
				this.diagnose(state, sessionId, `The continuity note for context head ${head.id} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (state.note.text === undefined) return undefined;
		const projection = projectOrdinaryContinuity(event.messages, head, state.note.text);
		if (projection.mismatch !== undefined) {
			this.diagnose(state, sessionId, `The continuity note for context head ${head.id} was not inserted: ${projection.mismatch}`);
			return undefined;
		}
		if (state.diagnosed) this.diagnose(state, sessionId, undefined);
		return { messages: projection.messages };
	}
	private diagnose(state: SessionState, sessionId: string, text: string | undefined): void {
		state.diagnosed = text !== undefined;
		this.options.diagnose(sessionId, text);
	}

	/**
	 * Add one retained notice when context use crosses the planning budget of the exact model. A new
	 * compaction head starts a new episode. Unknown usage and a first sample above the budget are no
	 * crossing. A boundary that compacts ends its episode, so it takes no sample and no notice.
	 */
	turnEnd(event: Pick<TurnEndEvent, "entries">, ctx: Pick<ExtensionContext, "sessionManager" | "model" | "getContextUsage">, compacting = false): TurnEndEventResult | undefined {
		if (compacting || event.entries.some((entry) => entry.type === "compaction")) return undefined;
		const state = this.session(ctx.sessionManager.getSessionId());
		const head = ctx.sessionManager.buildContextEntries()[0], headId = head?.type === "compaction" ? head.id : undefined;
		if (state.episode.headId !== headId) state.episode = { headId, noticed: false };
		const usage = ctx.getContextUsage(), model = ctx.model;
		if (model === undefined || usage === undefined || usage.tokens === null) return undefined;
		const previous = state.episode.previous, budget = this.options.budget(model.provider, model.id);
		state.episode.previous = usage.tokens;
		if (state.episode.noticed || budget === undefined || !planningBudgetCrossed(previous, usage.tokens, budget, usage.contextWindow)) return undefined;
		state.episode.noticed = true;
		const content = planningBudgetSelfBody(usage.tokens, budget, `${model.provider}/${model.id}`, (this.options.now ?? Date.now)());
		return { entries: [...event.entries, { type: "custom_message", customType: PLANNING_BUDGET_NOTICE, content, display: true }] };
	}
}
