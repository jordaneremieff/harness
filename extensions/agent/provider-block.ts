/** Retained provider-limit evidence and explicit recovery, independent of native submission settlement. */
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { AgentDoc, LiveDoc, ProviderDoc, defineDocFamily, configure, type ConversationId, type SubmissionId, type Tx, type ModelRef, type AgentChange, type Harness, type Cursor } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { DeferredHandle, Api, Model } from "@earendil-works/pi-ai";
import { ResultReferenceSchema } from "./result-reference.ts";
import type { ProducerAwaitFact } from "./await-facts.ts";

/** Typed retry evidence delivered independently of a producer's terminal result. */
export type ProviderRetryNotice = { requesterSubmissionId?: number; fact: ProducerAwaitFact };
import { canonicalIdentity } from "./identity.ts";
import { safeProviderError } from "./primary-observation.ts";

export const PROVIDER_BLOCK_ERROR = "Agent host: quota exceeded; explicit recovery required.";
export const STALE_PROVIDER_ERROR = "Agent host: request superseded by explicit model configuration.";
const closed = { additionalProperties: false } as const;
export const ProviderBlockFactSchema = Type.Object({
	blockId: Type.String({ minLength: 1, maxLength: 128 }),
	conversationId: Type.Integer({ minimum: 1 }), providerSessionId: Type.String({ minLength: 1, maxLength: 256 }),
	epoch: Type.Integer({ minimum: 0 }),
	model: Type.Object({ provider: Type.String({ maxLength: 256 }), modelId: Type.String({ maxLength: 256 }) }, closed),
	error: Type.String({ maxLength: 4096 }), errorRedacted: Type.Boolean(), errorTruncated: Type.Boolean(),
	source: Type.Union([Type.Literal("provider"), Type.Literal("host-block")]), timestamp: Type.Integer({ minimum: 0 }),
	originalResults: Type.Array(ResultReferenceSchema, { maxItems: 16 }), omittedOriginalResults: Type.Integer({ minimum: 0 }),
}, closed);
export type ProviderBlockFact = Static<typeof ProviderBlockFactSchema>;
export type ProviderControlState = { conversationId?: number; epoch: number; block?: ProviderBlockFact; recoveredFrom?: string };
// Chord documents are proxies; JSON detachment preserves their public JSON values.
function detached<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export const ProviderControlDoc = defineDocFamily<ProviderControlState, null>({ kind: "agent.provider-control", family: true, version: 1, scope: "session", initial: () => ({ epoch: 0 }) });
export const ProviderInputDoc = defineDocFamily<{ providerBlock?: ProviderBlockFact; recoveryOf?: string }, null>({ kind: "agent.provider-input", family: true, version: 1, scope: "session", initial: () => ({}) });

/** Positive exhaustion evidence is distinct from transient throttling and context-size rejection. */
export function isProviderExhaustion(error: string, provider?: string): boolean {
	if (/(?:per[ _-]?(?:minute|second)|requests?\/min|tokens?\/min|\b[rt]pm\b|context (?:window|length)|maximum context|billing (?:service|infrastructure).{0,40}(?:unavailable|timeout|error))/iu.test(error)) return false;
	return /billing_hard_limit_reached|billing.{0,40}limit.{0,40}(?:exhausted|reached|exceeded)/iu.test(error) || /(?:GoUsageLimitError|FreeUsageLimitError|insufficient[_ -]quota|subscription_sharing_usage_limit_exceeded)/iu.test(error)
		|| /(?:quota|budget|credits?|balance).{0,80}(?:exhausted|exceeded|insufficient|depleted|empty|limit reached)|(?:insufficient|exhausted|exceeded|out of).{0,40}(?:quota|budget|credits?|balance)/iu.test(error)
		|| /(?:weekly|monthly|daily|subscription|usage|spending|five.hour|5.hour).{0,60}(?:limit|quota).{0,60}(?:reached|exceeded|exhausted)/iu.test(error)
		|| (provider === "zai" && /(?:code|error[_ -]?code)["'\s:=]*["']?(?:1308|1310)\b/iu.test(error));
}

export async function initializeProviderControl(tx: Tx, conversationId: ConversationId): Promise<void> {
	const provider = await tx.doc(ProviderDoc, conversationId);
	const state = await tx.doc(ProviderControlDoc, provider.sessionId, null);
	state.conversationId = conversationId;
}
export async function reconcileProviderControls(harness: Harness, context: Context): Promise<void> {
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, 64, cursor), context);
		await harness.commit(async (tx) => { for (const conversation of page.items) await initializeProviderControl(tx, conversation.id); }, context);
		cursor = page.next;
	} while (cursor !== undefined);
}
export type ProviderAttempt = { conversationId: ConversationId; providerSessionId: string; epoch: number; model: ModelRef; inputs: SubmissionId[]; originalResults: ProviderBlockFact["originalResults"]; block?: ProviderBlockFact; stale: boolean };
export const ProviderDeferredDoc = defineDocFamily<{ attempt?: ProviderAttempt }, null>({ kind: "agent.provider-deferred", family: true, version: 1, scope: "session", initial: () => ({}) });
function deferredKey(model: ModelRef, handle: DeferredHandle): string { return createHash("sha256").update(JSON.stringify([model.provider, model.modelId, handle.api, handle.id])).digest("hex"); }
function validateDeferredModel(model: ModelRef, handle: DeferredHandle): void {
	if (handle.provider !== model.provider || handle.modelId !== model.modelId) throw new Error("The deferred handle does not match its selected provider and model.");
}
export async function retainDeferredAttempt(tx: Tx, attempt: ProviderAttempt, handle: DeferredHandle): Promise<void> {
	validateDeferredModel(attempt.model, handle);
	const state = await tx.doc(ProviderDeferredDoc, deferredKey(attempt.model, handle), null);
	if (state.attempt !== undefined && JSON.stringify(state.attempt) !== JSON.stringify(attempt)) throw new Error("A deferred handle has conflicting native request identities or configuration epochs.");
	state.attempt ??= detached(attempt);
}
export async function readDeferredAttempt(tx: Tx, model: Model<Api>, handle: DeferredHandle): Promise<ProviderAttempt> {
	validateDeferredModel({ provider: model.provider, modelId: model.id }, handle);
	const state = await tx.doc(ProviderDeferredDoc, deferredKey({ provider: model.provider, modelId: model.id }, handle), null);
	if (state.attempt === undefined) throw new Error("The deferred handle has no retained native request identity.");
	return detached(state.attempt);
}
export async function readProviderAttemptBlock(tx: Tx, attempt: ProviderAttempt): Promise<ProviderBlockFact | undefined> {
	const state = await tx.doc(ProviderControlDoc, attempt.providerSessionId, null);
	return state.block === undefined ? undefined : detached(state.block);
}
export async function captureProviderAttempt(tx: Tx, sessionId: string, model: ModelRef): Promise<ProviderAttempt> {
	const control = await tx.doc(ProviderControlDoc, sessionId, null);
	if (control.conversationId === undefined) throw new Error("Agent host: provider request has no retained conversation identity.");
	const conversationId = control.conversationId as ConversationId;
	const agent = await tx.doc(AgentDoc, conversationId);
	const live = await tx.doc(LiveDoc, conversationId);
	return { conversationId, providerSessionId: sessionId, epoch: control.epoch, model, inputs: [...(live.run?.inputs ?? [])], originalResults: [],
		...(control.block === undefined ? {} : { block: detached(control.block) }),
		stale: agent.model?.provider !== model.provider || agent.model.modelId !== model.modelId };
}
export async function providerAttemptCurrent(tx: Tx, attempt: ProviderAttempt): Promise<boolean> {
	const state = await tx.doc(ProviderControlDoc, attempt.providerSessionId, null);
	const agent = await tx.doc(AgentDoc, attempt.conversationId);
	return state.epoch === attempt.epoch && agent.model?.provider === attempt.model.provider && agent.model.modelId === attempt.model.modelId;
}
export async function associateProviderBlock(tx: Tx, inputs: readonly SubmissionId[], block: ProviderBlockFact): Promise<void> {
	for (const input of inputs) {
		const state = await tx.doc(ProviderInputDoc, String(input), null);
		state.providerBlock ??= detached(block);
	}
}
export async function retainProviderBlock(tx: Tx, attempt: ProviderAttempt, error: string, storageId: string, timestamp: number): Promise<ProviderBlockFact | undefined> {
	if (!await providerAttemptCurrent(tx, attempt)) return undefined;
	const state = await tx.doc(ProviderControlDoc, attempt.providerSessionId, null);
	if (state.block === undefined) {
		const evidence = safeProviderError(error, 4096);
		const originalResults = attempt.inputs.slice(0, 16).map((submissionId) => attempt.originalResults.find((result) => result.submissionId === submissionId) ?? { sessionId: canonicalIdentity(storageId, attempt.conversationId), submissionId });
		state.block = { blockId: createHash("sha256").update(JSON.stringify([attempt.providerSessionId, attempt.epoch, error])).digest("hex"),
			conversationId: attempt.conversationId, providerSessionId: attempt.providerSessionId, epoch: attempt.epoch, model: attempt.model,
			error: evidence.text, errorRedacted: evidence.redacted, errorTruncated: evidence.truncated,
			source: "provider", timestamp, originalResults, omittedOriginalResults: Math.max(0, attempt.inputs.length - originalResults.length) };
	}
	const block = detached(state.block);
	await associateProviderBlock(tx, attempt.inputs, block);
	return block;
}
export async function readProviderBlock(tx: Tx, conversationId: ConversationId): Promise<ProviderBlockFact | undefined> {
	const provider = await tx.doc(ProviderDoc, conversationId);
	const state = await tx.doc(ProviderControlDoc, provider.sessionId, null);
	return state.block === undefined ? undefined : detached(state.block);
}
export async function readInputProviderBlock(tx: Tx, submissionId: SubmissionId): Promise<ProviderBlockFact | undefined> {
	const fact = (await tx.doc(ProviderInputDoc, String(submissionId), null)).providerBlock;
	return fact === undefined ? undefined : detached(fact);
}

/** Public native configuration and recovery share one commit; late old-epoch failures cannot reblock it. */
export async function configureProviderRecovery(tx: Tx, conversationId: ConversationId, change: AgentChange, expectedBlockId?: string): Promise<void> {
	const provider = await tx.doc(ProviderDoc, conversationId);
	const state = await tx.doc(ProviderControlDoc, provider.sessionId, null);
	if (change.model !== undefined && change.model !== null) {
		if (state.block?.blockId !== expectedBlockId) throw new Error("The provider block changed before model configuration; inspect and retry explicit recovery.");
		state.epoch++;
		if (state.block !== undefined) state.recoveredFrom = state.block.blockId;
		delete state.block;
	}
	await configure(tx, conversationId, change);
}
export async function readInputRecovery(tx: Tx, submissionId: SubmissionId): Promise<string | undefined> { return (await tx.doc(ProviderInputDoc, String(submissionId), null)).recoveryOf; }
const ProviderRecoveryAdmissionDoc = defineDocFamily<{ initialized: boolean; recoveryOf?: string }, null>({ kind: "agent.provider-recovery-admission", family: true, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ initialized: false }) });

/** Bind recovery to the original admission intent, never to the epoch of a later request replay. */
export async function captureProviderRecovery(tx: Tx, conversationId: ConversationId, requestId: string): Promise<string | undefined> {
	const existing = await tx.submissionByRequest(conversationId, requestId);
	const admission = await tx.doc(ProviderRecoveryAdmissionDoc, conversationId, requestId, null);
	if (admission.initialized) return admission.recoveryOf;
	if (existing !== undefined) return undefined;
	const provider = await tx.doc(ProviderDoc, conversationId);
	const state = await tx.doc(ProviderControlDoc, provider.sessionId, null);
	admission.initialized = true;
	if (state.recoveredFrom !== undefined) admission.recoveryOf = state.recoveredFrom;
	return admission.recoveryOf;
}
export async function linkProviderRecovery(tx: Tx, submissionId: SubmissionId, recoveryOf: string | undefined): Promise<void> {
	if (recoveryOf !== undefined) (await tx.doc(ProviderInputDoc, String(submissionId), null)).recoveryOf ??= recoveryOf;
}
export function providerBlockText(block: ProviderBlockFact): string {
	return `${PROVIDER_BLOCK_ERROR} Provider evidence: ${block.error}${block.errorRedacted ? " [credential redacted]" : ""}${block.errorTruncated ? " [truncated]" : ""} Block ${block.blockId}. Use explicit validated model configuration before a new recovery send.`;
}
