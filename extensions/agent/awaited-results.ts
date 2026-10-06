/** Native await ownership, exact outcomes, and control-provenance release. */
import { Type, type Static } from "typebox";
import { defineDoc, LiveDoc, InboxDoc, ROOT_CONVERSATION_ID, type ConversationId, type TaskId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { canonicalIdentity } from "./identity.ts";
import { ResultReferenceSchema, type ResultReference } from "./result-reference.ts";
import { ProducerAwaitFactSchema, type ProducerAwaitFact } from "./await-facts.ts";

export const AwaitParams = Type.Object({
	results: Type.Array(ResultReferenceSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
	releaseOnProviderRetry: Type.Optional(Type.Object({ minAttempt: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type AwaitInput = Static<typeof AwaitParams>;
export const AwaitOutcomeSchema = Type.Object({
	result: ResultReferenceSchema,
	status: Type.Union([Type.Literal("done"), Type.Literal("unanswered"), Type.Literal("unavailable")]),
	answer: Type.Optional(Type.String({ maxLength: 16000 })),
	answerEntryId: Type.Optional(Type.Integer({ minimum: 1 })),
	entryId: Type.Optional(Type.Integer({ minimum: 1 })),
	reason: Type.Optional(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
	excerpt: Type.Optional(Type.Boolean()),
	continuation: Type.Optional(Type.Object({ tool: Type.Literal("agent_inspect"), sessionId: Type.String({ minLength: 1, maxLength: 256 }), view: Type.Literal("exact"), entryId: Type.Integer({ minimum: 1 }), offset: Type.Literal(0) }, { additionalProperties: false })),
}, { additionalProperties: false });
export const AwaitOutputSchema = Type.Object({
	decision: Type.Union([Type.Literal("awaiting"), Type.Literal("settled"), Type.Literal("released"), Type.Literal("failed")]),
	results: Type.Array(AwaitOutcomeSchema, { maxItems: 16 }),
	unresolved: Type.Array(ResultReferenceSchema, { maxItems: 16 }),
	originalInputs: Type.Array(Type.Integer({ minimum: 1 })),
	queuedInputCount: Type.Integer({ minimum: 0 }),
	queueSnapshot: Type.Object({ source: Type.Literal("committed InboxDoc"), conversationId: Type.Integer({ minimum: 1 }), runId: Type.Integer({ minimum: 1 }) }),
	releaseReason: Type.Optional(Type.String()),
	producerRetries: Type.Optional(Type.Array(ProducerAwaitFactSchema, { maxItems: 16 })),
}, { additionalProperties: false });
export type AwaitOutcome = { result: ResultReference; status: "done" | "unanswered" | "unavailable"; answer?: string; answerEntryId?: number; entryId?: number; reason?: string; truncated?: boolean; excerpt?: boolean; continuation?: { tool: "agent_inspect"; sessionId: string; view: "exact"; entryId: number; offset: 0 } };
export type AwaitDecision = "awaiting" | "settled" | "released" | "failed";
export type AwaitDeclaration = { taskId: number; callId: string; conversationId: number; runId: number; cohort: number[]; inputs: number[]; results: ResultReference[]; outcomes: AwaitOutcome[]; decision: AwaitDecision; releaseReason?: string; deliveries?: AwaitDelivery[]; producers?: ProducerAwaitFact[]; releaseOnProviderRetry?: AwaitInput["releaseOnProviderRetry"]; producerRetries?: ProducerAwaitFact[] };
export type InputProvenance = { conversationId: number; requestId: string; classification: "explicit" | "automatic" | "report"; sender?: string; submissionId?: number; automaticKind?: "checkIn" | "timer"; producerRequestId?: string; runId?: number };
export type AwaitDelivery = { requestId: string; results: ResultReference[]; complete: boolean };
export type AwaitState = { declarations: AwaitDeclaration[]; provenance: InputProvenance[] };
export const AwaitDoc = defineDoc<AwaitState>({ kind: "agent.awaited-results", version: 1, scope: "session", initial: () => ({ declarations: [], provenance: [] }) });
export const AWAIT_DECLARATION_LIMIT = 64;
export const AWAIT_PROVENANCE_LIMIT = 128;

export function boundedAwaitAnswer(result: ResultReference, answer: string, answerEntryId: number | undefined, excerpt = false): Pick<AwaitOutcome, "answer" | "truncated" | "excerpt" | "continuation"> {
	let end = Math.min(answer.length, 16000);
	if (end < answer.length && /[\uD800-\uDBFF]/u.test(answer[end - 1] ?? "")) end--;
	const truncated = end < answer.length || excerpt;
	if (truncated && answerEntryId === undefined) throw new Error("A bounded answer requires its exact native continuation");
	return { answer: answer.slice(0, end), ...(truncated && answerEntryId !== undefined ? { truncated: true, continuation: { tool: "agent_inspect", sessionId: result.sessionId, view: "exact", entryId: answerEntryId, offset: 0 } as const } : {}), ...(excerpt ? { excerpt: true } : {}) };
}

export function referenceKey(reference: ResultReference): string { return `${reference.sessionId}/${reference.submissionId}`; }
export function localProducer(storageId: string, reference: ResultReference): ConversationId | undefined {
	if (reference.sessionId === storageId) return ROOT_CONVERSATION_ID;
	if (!reference.sessionId.startsWith(`${storageId}:`)) return undefined;
	const id = Number(reference.sessionId.slice(storageId.length + 1));
	if (!Number.isSafeInteger(id) || id < 1 || canonicalIdentity(storageId, id as ConversationId) !== reference.sessionId) throw new Error("Result conversation identity is not canonical");
	return id as ConversationId;
}
export async function forgetFailedAdmission(tx: Tx, conversationId: ConversationId, requestId: string): Promise<void> {
	if (await tx.submissionByRequest(conversationId, requestId) !== undefined) return;
	const state = await tx.doc(AwaitDoc);
	state.provenance = state.provenance.filter((item) => item.conversationId !== conversationId || item.requestId !== requestId);
}
function matching(left: ResultReference, right: ResultReference): boolean {
	if (referenceKey(left) !== referenceKey(right)) return false;
	if (left.requestId !== undefined && left.requestId !== right.requestId) throw new Error("Result requestId disagrees with the declared input");
	return true;
}
async function pruneDeclarations(tx: Tx, state: AwaitState): Promise<void> {
	const retained: AwaitDeclaration[] = [];
	for (const declaration of state.declarations) {
		const task = await tx.task(declaration.taskId as TaskId);
		const live = await tx.doc(LiveDoc, declaration.conversationId as ConversationId);
		if (task !== undefined && !task.abortRequested && !(task.state.status === "terminal" && task.state.outcome.status === "aborted") && live.run?.taskId === declaration.runId) {
			if (task.state.status === "terminal" && declaration.decision === "awaiting") {
				declaration.decision = "released";
				declaration.releaseReason = "the native await invocation ended";
			}
			retained.push(declaration);
		}
	}
	state.declarations.splice(0, state.declarations.length, ...retained);
}
async function ownsCurrentRound(tx: Tx, taskId: TaskId, live: { run?: { taskId: TaskId }; tools?: { taskId?: TaskId }[] }): Promise<boolean> {
	let current: TaskId | undefined = taskId;
	for (let depth = 0; current !== undefined && depth < 16; depth++) {
		if (current === live.run?.taskId || live.tools?.some((slot) => slot.taskId === current)) return true;
		current = (await tx.task(current))?.owner;
	}
	return false;
}
function decide(declaration: AwaitDeclaration): void {
	if (declaration.decision !== "awaiting") return;
	if (declaration.outcomes.some((outcome) => outcome.status !== "done")) declaration.decision = "failed";
	else if (declaration.results.every((reference) => declaration.outcomes.some((outcome) => matching(reference, outcome.result)))) declaration.decision = "settled";
}
export function releaseCohort(state: AwaitState, declaration: AwaitDeclaration, reason: string, retry?: ProducerAwaitFact): void {
	for (const peer of state.declarations) {
		if (peer.runId !== declaration.runId || peer.conversationId !== declaration.conversationId || peer.cohort.join(",") !== declaration.cohort.join(",") || peer.decision !== "awaiting") continue;
		peer.decision = "released";
		peer.releaseReason = reason;
		if (retry !== undefined) peer.producerRetries = [JSON.parse(JSON.stringify(retry)) as ProducerAwaitFact];
	}
}
async function producerEdge(tx: Tx, storageId: string, reference: ResultReference): Promise<number | undefined> {
	const producer = localProducer(storageId, reference);
	if (producer === undefined) return undefined;
	if (reference.requestId !== undefined) {
		const submission = await tx.submissionByRequest(producer, reference.requestId);
		if (submission === undefined || submission.type !== "input" || submission.id !== reference.submissionId) throw new Error("The exact local result reference does not identify an admitted input");
		return submission.status === "done" || submission.status === "unanswered" ? undefined : producer;
	}
	const live = await tx.doc(LiveDoc, producer);
	const inbox = await tx.doc(InboxDoc, producer);
	return live.run?.inputs.includes(reference.submissionId as SubmissionId) || inbox.items.some((item) => item.mode !== "write" && item.id === reference.submissionId) ? producer : undefined;
}
async function localEdges(tx: Tx, state: AwaitState, storageId: string, candidate: AwaitDeclaration): Promise<Map<number, Set<number>>> {
	const edges = new Map<number, Set<number>>();
	for (const declaration of [...state.declarations.filter((item) => item.decision === "awaiting"), candidate]) {
		const targets = edges.get(declaration.conversationId) ?? new Set<number>();
		for (const reference of declaration.results) {
			const edge = await producerEdge(tx, storageId, reference);
			if (edge !== undefined) targets.add(edge);
		}
		edges.set(declaration.conversationId, targets);
	}
	return edges;
}
function cycleError(storageId: string, candidate: AwaitDeclaration, path: number[]): Error {
	const witness = path.slice(0, 16).map((id) => canonicalIdentity(storageId, id as ConversationId)).join(" -> ");
	const request = candidate.results.find((reference) => localProducer(storageId, reference) === path[1]);
	return new Error(`Await would create a local result cycle: ${witness}${path.length > 16 ? ` -> (${path.length - 16} further agents)` : ""}; submission ${request?.submissionId}${request?.requestId === undefined ? "" : `, request ${request.requestId}`}. Release a wait or change the results.`);
}
async function rejectCycle(tx: Tx, state: AwaitState, storageId: string, candidate: AwaitDeclaration): Promise<void> {
	const edges = await localEdges(tx, state, storageId, candidate);
	const pending = [...(edges.get(candidate.conversationId) ?? [])].map((id) => ({ id, path: [candidate.conversationId, id] }));
	const seen = new Set<number>();
	while (pending.length > 0) {
		const item = pending.pop();
		if (item === undefined) break;
		const { id: next, path } = item;
		if (next === candidate.conversationId) throw cycleError(storageId, candidate, path);
		if (seen.has(next)) continue;
		seen.add(next);
		if (seen.size > AWAIT_DECLARATION_LIMIT) throw new Error("Local cycle coverage exceeds the await bound");
		pending.push(...[...(edges.get(next) ?? [])].map((id) => ({ id, path: [...path, id] })));
	}
}
async function inboxRelease(tx: Tx, state: AwaitState, declaration: AwaitDeclaration): Promise<void> {
	const inbox = await tx.doc(InboxDoc, declaration.conversationId as ConversationId);
	for (const item of inbox.items) {
		if (item.mode === "write") continue;
		for (const pending of state.provenance.filter((entry) => entry.conversationId === declaration.conversationId && entry.submissionId === undefined)) {
			const submission = await tx.submissionByRequest(declaration.conversationId as ConversationId, pending.requestId);
			if (submission?.type === "input") pending.submissionId = submission.id;
		}
		const provenance = state.provenance.find((entry) => entry.conversationId === declaration.conversationId && entry.submissionId === item.id);
		if (provenance?.classification === "explicit" || (provenance?.classification === "report" && declaration.results.some((reference) => reference.sessionId === provenance.sender))) {
			item.mode = "steer";
			releaseCohort(state, declaration, "admitted input");
		}
	}
}

/** All ownership and local dependency edges are admitted on one native transaction line. */
export async function declareAwait(tx: Tx, storageId: string, owner: { conversationId: ConversationId; taskId: TaskId; callId: string }, results: ResultReference[], releaseOnProviderRetry?: AwaitInput["releaseOnProviderRetry"]): Promise<AwaitDeclaration> {
	const state = await tx.doc(AwaitDoc);
	await pruneDeclarations(tx, state);
	const prior = state.declarations.find((item) => item.taskId === owner.taskId);
	if (prior !== undefined) { await inboxRelease(tx, state, prior); return JSON.parse(JSON.stringify(prior)) as AwaitDeclaration; }
	const live = await tx.doc(LiveDoc, owner.conversationId);
	if (live.run === undefined || !await ownsCurrentRound(tx, owner.taskId, live)) throw new Error("Await requires the current native tool round and original run within the ownership bound");
	if (state.declarations.length >= AWAIT_DECLARATION_LIMIT) throw new Error("The native await declaration bound is full");
	const self = results.find((reference) => localProducer(storageId, reference) === owner.conversationId);
	if (self !== undefined) throw new Error(`Await refuses self, current-run, and queued-self results: ${self.sessionId}, submission ${self.submissionId}${self.requestId === undefined ? "" : `, request ${self.requestId}`}`);
	let declaration: AwaitDeclaration = { ...owner, runId: live.run.taskId, cohort: (live.tools ?? []).flatMap((slot) => slot.taskId === undefined ? [] : [slot.taskId]), inputs: [...live.run.inputs], results: results.map((reference) => ({ ...reference })), outcomes: [], decision: "awaiting", ...(releaseOnProviderRetry === undefined ? {} : { releaseOnProviderRetry: { ...releaseOnProviderRetry } }) };
	const released = state.declarations.find((item) => item.runId === declaration.runId && item.cohort.join(",") === declaration.cohort.join(",") && item.decision !== "awaiting" && item.decision !== "settled");
	if (released !== undefined) { declaration.decision = "released"; declaration.releaseReason = released.releaseReason ?? "parallel await returned control"; if (released.producerRetries !== undefined) declaration.producerRetries = JSON.parse(JSON.stringify(released.producerRetries)) as ProducerAwaitFact[]; }
	await rejectCycle(tx, state, storageId, declaration);
	state.declarations.push(declaration);
	const admitted = state.declarations.find((item) => item.taskId === owner.taskId);
	if (admitted === undefined) throw new Error("The native declaration was not admitted");
	declaration = admitted;
	decide(declaration);
	if (declaration.decision === "failed") releaseCohort(state, declaration, "a retained result did not succeed");
	await inboxRelease(tx, state, declaration);
	return JSON.parse(JSON.stringify(declaration)) as AwaitDeclaration;
}

export async function commitAwaitOutcome(tx: Tx, taskId: TaskId, outcome: AwaitOutcome, delivery?: AwaitDelivery): Promise<void> {
	const state = await tx.doc(AwaitDoc);
	const declaration = state.declarations.find((item) => item.taskId === taskId);
	if (declaration === undefined || !declaration.results.some((reference) => matching(reference, outcome.result))) return;
	if (!declaration.outcomes.some((item) => matching(item.result, outcome.result))) declaration.outcomes.push(outcome);
	if (delivery !== undefined && !(declaration.deliveries ?? []).some((item) => item.requestId === delivery.requestId)) { declaration.deliveries ??= []; declaration.deliveries.push(delivery); }
	decide(declaration);
	if (declaration.decision === "failed") releaseCohort(state, declaration, outcome.reason ?? "a result did not succeed");
}

/** Record classification before admission; native input identity makes release crash-reconcilable. */
export async function recordInputProvenance(tx: Tx, provenance: InputProvenance): Promise<void> {
	const state = await tx.doc(AwaitDoc);
	const prior = state.provenance.find((item) => item.conversationId === provenance.conversationId && item.requestId === provenance.requestId);
	if (prior !== undefined) {
		if (prior.classification !== provenance.classification || prior.sender !== provenance.sender) throw new Error("Input requestId already has different release provenance");
		return;
	}
	if (state.provenance.length >= AWAIT_PROVENANCE_LIMIT) {
		const retained: InputProvenance[] = [];
		for (const item of state.provenance) {
			const submission = await tx.submissionByRequest(item.conversationId as ConversationId, item.requestId);
			const live = await tx.doc(LiveDoc, item.conversationId as ConversationId);
			if ((submission === undefined && item.runId !== undefined && item.runId === live.run?.taskId) || submission?.status === "queued" || submission?.status === "placed") retained.push(item);
		}
		state.provenance.splice(0, state.provenance.length, ...retained);
	}
	if (state.provenance.length >= AWAIT_PROVENANCE_LIMIT) throw new Error("Input provenance bound is full");
	const live = await tx.doc(LiveDoc, provenance.conversationId as ConversationId);
	state.provenance.push({ ...provenance, ...(live.run === undefined ? {} : { runId: live.run.taskId }) });
}
export async function classifyAwaitInput(tx: Tx, provenance: InputProvenance): Promise<{ suppress: boolean; defer: boolean; release: boolean }> {
	const state = await tx.doc(AwaitDoc);
	await pruneDeclarations(tx, state);
	const active = state.declarations.filter((item) => item.conversationId === provenance.conversationId && item.decision === "awaiting");
	const automatic = provenance.classification === "automatic";
	const suppress = automatic && provenance.automaticKind === "checkIn" && active.some((declaration) => declaration.results.some((reference) => reference.sessionId === provenance.sender && (reference.requestId === undefined || reference.requestId === provenance.producerRequestId)));
	if (!suppress) await recordInputProvenance(tx, provenance);
	const release = provenance.classification === "explicit" || (provenance.classification === "report" && active.some((item) => item.results.some((reference) => reference.sessionId === provenance.sender)));
	return { suppress, defer: automatic && active.length > 0, release: release && active.length > 0 };
}
export async function reconcileInputRelease(tx: Tx, conversationId: ConversationId, requestId: string): Promise<void> {
	const state = await tx.doc(AwaitDoc);
	const provenance = state.provenance.find((item) => item.conversationId === conversationId && item.requestId === requestId);
	if (provenance === undefined) return;
	const input = await tx.submissionByRequest(conversationId, requestId);
	if (input === undefined || input.type !== "input") return;
	provenance.submissionId = input.id;
	const inbox = await tx.doc(InboxDoc, conversationId);
	const live = await tx.doc(LiveDoc, conversationId);
	if (!inbox.items.some((item) => item.mode !== "write" && item.id === input.id) && !live.run?.inputs.includes(input.id)) return;
	for (const declaration of state.declarations.filter((item) => item.conversationId === conversationId && item.runId === live.run?.taskId && input.status === "queued" && !item.inputs.includes(input.id))) {
		if (provenance.classification === "explicit" || (provenance.classification === "report" && declaration.results.some((reference) => reference.sessionId === provenance.sender))) {
			const queued = inbox.items.find((item) => item.id === input.id);
			if (queued !== undefined && queued.mode !== "write") queued.mode = "steer";
			releaseCohort(state, declaration, "admitted input");
		}
	}
}
