/**
 * agent/durable-controls: native control operations and durable delivery records
 * over one Pi Durable Harness.
 *
 * The caller owns storage exclusivity; every function here treats the Harness as
 * the single mutation line. Control operations (submit, outcome, fork, rewind,
 * compact, configure, abort) and the delivery ledger (intents, receipts,
 * acknowledgement) are ordinary Harness commits. No function decodes private
 * SQL and no function opens a second writer.
 *
 * Document fields are required and nullable rather than optional: a stored
 * document value must satisfy the durable JSON object contract, which admits no
 * `undefined` member. The document tokens are the shared runtime identity for
 * every consumer in the host process; a contribution imports them instead of
 * defining a second copy.
 */
import { randomUUID } from "node:crypto";
import { createCheckIn } from "./durable-checkins.ts";
import { cleanupRequestContexts, recordRequestContext, type RequestContext } from "./request-context.ts";
import { refreshManagedInstructions } from "./profile.ts";
import { existsSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, type Message, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	CompactionEntry,
	defineDoc,
	defineDocFamily,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type EntryId,
	type Harness,
	type HarnessInspection,
	type ModelRef,
	type SubmissionId,
	type SubmissionRecord,
	type TaskId,
	type Tx,
	type UsageState,
	type UserInput,
} from "@earendil-works/pi-durable";
import { boundedConfigurationResult, configurationModel, configurationThinkingLevel, validateConfigurationPatch, type ConfigurationPatch, type ConfigurationResult, type ConfigurationState } from "./configuration.ts";

/** Conversation metadata retained beside the transcript: display name, creating owner, and title fallback. */
export type AgentMeta = {
	name: string | null;
	/** External identity of the creating agent: the storage ID, or `storageId:conversationId`. */
	owner: string | null;
	/** First input text, retained so a bounded dashboard read does not scan the whole transcript. */
	firstMessage: string | null;
	/** Last submission time in epoch milliseconds. */
	updatedAt: number | null;
};

const EMPTY_META: AgentMeta = { name: null, owner: null, firstMessage: null, updatedAt: null };

/**
 * Shared conversation metadata. `fork: "initial"` keeps a fork's name and owner
 * separate from its parent's until the fork writes its own values.
 */
export const AgentMetaDoc = defineDoc<AgentMeta>({
	kind: "agent.meta",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ ...EMPTY_META }),
});

/** JSON-safe stored form of one user input. */
export type DeliveryMessagePart = {
	readonly type: string;
	/** Text content; empty for an image part. */
	readonly text: string;
	/** Image base64 payload; empty for a text part. */
	readonly data: string;
	/** Image media type; empty for a text part. */
	readonly mimeType: string;
};
export type DeliveryMessage = string | DeliveryMessagePart[];

/**
 * Who caused one admission. An operator action from the board or the
 * `/agent` command is `operator`; an agent tool from a model is `model`.
 * Each owned admission requires an explicit origin. A receipt with a missing
 * or malformed origin stays pending and reports an error instead of choosing
 * whether to wake its recipient.
 */
export type DeliveryOrigin = "operator" | "model";

/** One durable delivery intent, written before the submission it describes. */
export type DeliveryIntent = {
	readonly requestId: string;
	readonly ownerId: string;
	readonly conversationId: ConversationId;
	readonly message: DeliveryMessage;
	readonly whenBusy: "steer" | "followUp" | "reject" | null;
	readonly operationId: string | null;
	readonly submissionId: SubmissionId | null;
	readonly origin: DeliveryOrigin;
};

/** One settled result waiting for its owner to acknowledge it. */
export type DeliveryReceipt = {
	readonly submissionId: SubmissionId;
	readonly requestId: string;
	readonly ownerId: string;
	readonly conversationId: ConversationId;
	readonly operationId: string | null;
	/** Admission origin copied from the intent; the reader rejects a missing or malformed value. */
	readonly origin?: DeliveryOrigin;
	readonly status: "done" | "unanswered";
	readonly entryId: EntryId | null;
	readonly answerEntryId: EntryId | null;
	/** Bounded answer text retained with the receipt. */
	readonly answer: string | null;
	/** Terminal reason for an unanswered submission. */
	readonly reason: string | null;
	/** Informational primary copies accepted before owner delivery; retained across host reopen. */
	readonly fallbackRecipients?: string[];
	readonly acknowledged: boolean;
};

/** One recorded outbound report from a Durable agent to an owner session. */
export type DeliveryReport = {
	/** Stable source identity: `report:<requestId>`. */
	readonly sourceId: string;
	readonly requestId: string;
	readonly ownerId: string;
	/** External identity of the sending agent. */
	readonly senderIdentity: string;
	readonly message: string;
	readonly replyTo: string | null;
	/** Direct thread notices never broadcast to unrelated primary sessions. */
	readonly direct?: boolean;
	/** Explicit peer attention interrupts at the next native boundary, not the next answer. */
	readonly steer?: boolean;
	/** Opted-in thread subscribers receive a passive native entry, not a model turn. */
	readonly passive?: boolean;
	/** Thread-keyed pending projection updated in the acknowledgment transaction. */
	readonly threadId?: string;
	/** Title and display body from the defining thread event, not parsed notice text. */
	readonly threadTitle?: string;
	readonly operatorMessage?: string;
	/** Informational primary copies accepted before owner delivery; retained across host reopen. */
	readonly fallbackRecipients?: string[];
	readonly acknowledged: boolean;
	readonly createdAt: number;
	readonly checkIn?: { readonly origin: DeliveryOrigin; readonly elapsedMs: number; readonly cost: number | null; readonly conversationId: number; readonly requestId: string; readonly fallbackBroadcast?: boolean };
};

export type AgentDeliveryState = {
	readonly intents: DeliveryIntent[];
	readonly receipts: Record<string, DeliveryReceipt>;
	readonly reports: DeliveryReport[];
};

/** Session-scoped delivery ledger shared by every conversation of one storage. */
export const AgentDeliveryDoc = defineDoc<AgentDeliveryState>({
	kind: "agent.delivery",
	version: 1,
	scope: "session",
	initial: () => ({ intents: [], receipts: {}, reports: [] }),
	checkpointWhen: () => true,
});

/** One bounded pending-notice count avoids reading the whole report ledger during observation. */
export const ThreadDeliveryDoc = defineDocFamily<{ pending: number }, null>({ kind: "agent.thread-delivery", version: 1, scope: "session", family: true, initial: () => ({ pending: 0 }) });

/** Session-scoped fork markers: request key to the conversation it created. */
export type AgentForkState = {
	readonly forks: Record<string, ConversationId>;
};

/** Fork markers that make a retried fork or rewind return its retained fork. */
export const AgentForkDoc = defineDoc<AgentForkState>({
	kind: "agent.forks",
	version: 1,
	scope: "session",
	initial: () => ({ forks: {} }),
	checkpointWhen: () => true,
});

/** One conversation cannot accept a configuration change while it is running. */
export class DurableConversationBusyError extends Error {
	readonly conversationId: ConversationId;
	constructor(conversationId: ConversationId) {
		super(`conversation ${conversationId} is busy; configuration requires an idle conversation`);
		this.name = "DurableConversationBusyError";
		this.conversationId = conversationId;
	}
}

export interface DurableSubmitParams {
	readonly message: UserInput;
	readonly requestId: string;
	/** When absent, the submission runs but retains no external receipt. */
	readonly ownerId?: string;
	readonly whenBusy?: "steer" | "followUp" | "reject";
	readonly operationId?: string;
	readonly origin?: DeliveryOrigin;
	readonly checkInMinutes?: number;
	readonly senderIdentity?: string;
	/** Host-authored metadata; base submit callers need not supply it. */
	readonly requestContext?: RequestContext;
}

export interface RichSubmitParams {
	readonly message: UserInput;
	readonly requestId: string;
	readonly requester: string;
	readonly replyTo?: string;
	readonly origin: DeliveryOrigin;
	readonly whenBusy?: "steer" | "followUp" | "reject";
	readonly operationId?: string;
	readonly checkInMinutes?: number;
	/** Worker identity used by check-ins, not the requester. */
	readonly senderIdentity?: string;
}

/** Enriched admission is independent of the unchanged base submit operation. */
export async function richSubmitConversation(conversation: Conversation, params: RichSubmitParams, context: Context, now: () => number = Date.now): Promise<DurableSubmitResult> {
	const request: RequestContext = { requestId: params.requestId, requester: params.requester, replyTo: params.replyTo ?? params.requester, origin: params.origin };
	return submitConversation(conversation, { ...params, ownerId: request.replyTo, requestContext: request }, context, now);
}

export interface DurableSubmitResult {
	readonly submissionId: SubmissionId;
	readonly conversationId: ConversationId;
	/** True when an earlier submission with this request ID already existed. */
	readonly deduped: boolean;
}

function intentIndex(state: Readonly<AgentDeliveryState>, conversationId: ConversationId, requestId: string): number {
	return state.intents.findIndex((intent) => intent.conversationId === conversationId && intent.requestId === requestId);
}

/** One admission's delivery identity, written before the submission it describes. */
export interface DeliveryAdmission {
	readonly requestId: string;
	readonly ownerId: string;
	readonly message: UserInput;
	readonly whenBusy?: "steer" | "followUp" | "reject";
	readonly operationId?: string;
	readonly origin: DeliveryOrigin;
	readonly checkInMinutes?: number;
	readonly senderIdentity?: string;
	readonly requestContext?: RequestContext;
}

/** What the admission intent lookup found: no record, an unlinked record, or a retained submission. */
export type DeliveryIntentState =
	| { readonly kind: "new" }
	| { readonly kind: "unlinked" }
	| { readonly kind: "linked"; readonly submissionId: SubmissionId };

/** Write the conversation's display metadata for one admitted input on the caller's session transaction. */
export async function recordAdmissionMeta(tx: Tx, conversationId: ConversationId, message: UserInput | DeliveryMessage): Promise<void> {
	const meta = await tx.doc(AgentMetaDoc, conversationId);
	writeFirstMessage(meta, message);
	(meta as { updatedAt: number | null }).updatedAt = Date.now();
}

/**
 * Record one delivery intent on the caller's session transaction. A repeated
 * request ID returns the retained state instead of writing a second intent.
 * The timer task uses this through its own task commit, so a fired input and
 * its answer keep the same origin rule as any other admission.
 */
export async function recordDeliveryIntent(tx: Tx, conversationId: ConversationId, admission: DeliveryAdmission, admittedAt = Date.now(), admissionKind: "new" | "retained" = "new"): Promise<DeliveryIntentState> {
	const state = await tx.doc(AgentDeliveryDoc);
	if (admission.requestContext !== undefined) {
		if (admissionKind === "new" && (admission.requestContext.requestId !== admission.requestId || admission.requestContext.replyTo !== admission.ownerId || admission.requestContext.origin !== admission.origin))
			throw new Error("The request context does not match its delivery admission");
		await recordRequestContext(tx, conversationId, admission.requestContext, admissionKind);
	}
	await recordAdmissionMeta(tx, conversationId, admission.message);
	const index = intentIndex(state, conversationId, admission.requestId);
	if (index >= 0) {
		const prior = state.intents[index];
		if (prior !== undefined && prior.submissionId !== null) return { kind: "linked", submissionId: prior.submissionId };
		return { kind: "unlinked" };
	}
	const message = admission.message;
	await createCheckIn(tx, {
		conversationId, requestId: admission.requestId, ownerId: admission.ownerId,
		senderIdentity: admission.senderIdentity ?? String(conversationId), message: storedMessage(message),
		whenBusy: admission.whenBusy ?? "steer", origin: admission.origin, admittedAt,
	}, admission.checkInMinutes ?? 0);
	state.intents.push({
		requestId: admission.requestId,
		ownerId: admission.ownerId,
		conversationId,
		message: storedMessage(message),
		whenBusy: admission.whenBusy ?? null,
		operationId: admission.operationId ?? null,
		submissionId: null,
		origin: admission.origin,
	});
	return { kind: "new" };
}

/** Link one retained intent to its submission; true when a different submission was already linked. */
export async function linkDeliveryIntent(tx: Tx, conversationId: ConversationId, requestId: string, submissionId: SubmissionId): Promise<boolean> {
	const state = await tx.doc(AgentDeliveryDoc);
	const index = intentIndex(state, conversationId, requestId);
	const intent = state.intents[index];
	if (intent === undefined) return false;
	if (intent.submissionId === null) {
		state.intents[index] = { ...intent, submissionId };
		return false;
	}
	return intent.submissionId !== submissionId;
}

function storedMessage(message: UserInput): DeliveryMessage {
	if (typeof message === "string") return message;
	return message.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text, data: "", mimeType: "" }
			: { type: part.type, text: "", data: part.data, mimeType: part.mimeType },
	);
}

function deliveredMessage(message: DeliveryMessage): UserInput {
	if (typeof message === "string") return message;
	return message.map((part) => (part.type === "image" ? { type: "image" as const, data: part.data, mimeType: part.mimeType } : { type: "text" as const, text: part.text }));
}

/** Plain text of one stored input, for display-only metadata. */
function inputText(message: UserInput | DeliveryMessage): string {
	if (typeof message === "string") return message;
	return message.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function writeFirstMessage(meta: AgentMeta, message: UserInput | DeliveryMessage): void {
	if (meta.firstMessage !== null) return;
	const text = inputText(message);
	if (text === "") return;
	(meta as { firstMessage: string | null }).firstMessage = text.length > 1200 ? text.slice(0, 1200) : text;
}

/**
 * Admit one input. A supplied owner writes the delivery intent before the
 * submission, so a crash between the two commits leaves a durable record that
 * `reconcileDeliveries()` resolves through Durable's request-ID deduplication.
 */
export async function submitConversation(
	conversation: Conversation,
	params: DurableSubmitParams,
	context: Context,
	now: () => number = Date.now,
): Promise<DurableSubmitResult> {
	const { message, requestId, ownerId, whenBusy, operationId, origin } = params;
	await conversation.commit((tx) => refreshManagedInstructions(tx, conversation.id), context);
	let deduped = (await conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context)) !== undefined;
	if (ownerId !== undefined) {
		// An owned admission requires an explicit origin before its delivery intent is recorded.
		if (origin === undefined) throw new Error("This request carries no admission origin, so the calling Pi runs older agent code. Restart that Pi window, then retry.");
		const state = await conversation.commit(
			(tx) => recordDeliveryIntent(tx, conversation.id, { requestId, ownerId, message, ...(whenBusy === undefined ? {} : { whenBusy }), ...(operationId === undefined ? {} : { operationId }), origin, ...(params.checkInMinutes === undefined ? {} : { checkInMinutes: params.checkInMinutes }), ...(params.senderIdentity === undefined ? {} : { senderIdentity: params.senderIdentity }), ...(params.requestContext === undefined ? {} : { requestContext: params.requestContext }) }, now()),
			context,
		);
		if (state.kind === "linked") deduped = true;
	} else {
		await conversation.commit(async (tx) => {
			if (params.requestContext !== undefined) await recordRequestContext(tx, conversation.id, params.requestContext);
			await recordAdmissionMeta(tx, conversation.id, message);
		}, context);
	}
	const submission = await conversation.submit(
		{
			type: "input",
			content: message,
			requestId,
			...(whenBusy === undefined ? {} : { whenBusy }),
		},
		context,
	);
	if (ownerId !== undefined) {
		const relinked = await conversation.commit((tx) => linkDeliveryIntent(tx, conversation.id, requestId, submission.id), context);
		if (relinked) deduped = true;
	}
	return { submissionId: submission.id, conversationId: conversation.id, deduped };
}

function assistantTextOf(messages: readonly Message[] | undefined): string {
	if (!messages) return "";
	return messages
		.flatMap((message) => {
			const content = (message as { readonly content?: unknown }).content;
			if (typeof content === "string") return [content];
			if (!Array.isArray(content)) return [];
			return content.flatMap((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
		})
		.join("");
}

/** Terminal result of one submitted input, read from committed state. */
export interface DurableRunOutcome {
	readonly submissionId: SubmissionId;
	readonly conversationId: ConversationId;
	readonly status: "done" | "unanswered";
	readonly requestId?: string;
	readonly entryId?: EntryId;
	readonly answerEntryId?: EntryId;
	readonly reason?: string;
	readonly answer?: string;
	readonly usage: UsageState;
}

/**
 * Wait for settlement and read the retained answer, source IDs, and usage. A
 * settled submission whose answer entry is absent reports `unanswered`.
 */
export async function readOutcome(harness: Harness, submissionId: SubmissionId, context: Context): Promise<DurableRunOutcome> {
	const submission = await harness.submission(submissionId, context);
	if (!submission) throw new Error(`durable submission ${submissionId} is not retained`);
	const settled = await submission.wait(context);
	const usage = await harness.usage(context);
	if (settled.type !== "input") return { submissionId: settled.id, conversationId: settled.conversationId, status: "unanswered", ...(settled.requestId === undefined ? {} : { requestId: settled.requestId }), reason: "durable submit retained a write submission", usage };
	if (settled.status === "unanswered") {
		return {
			submissionId: settled.id,
			conversationId: settled.conversationId,
			status: "unanswered",
			...(settled.requestId === undefined ? {} : { requestId: settled.requestId }),
			...(settled.entry === undefined ? {} : { entryId: settled.entry }),
			reason: settled.reason,
			usage,
		};
	}
	const entry = await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	if (!entry) {
		return {
			submissionId: settled.id,
			conversationId: settled.conversationId,
			status: "unanswered",
			...(settled.requestId === undefined ? {} : { requestId: settled.requestId }),
			entryId: settled.entry,
			reason: `durable answer entry ${settled.answer} is not retained`,
			usage,
		};
	}
	return {
		submissionId: settled.id,
		conversationId: settled.conversationId,
		status: "done",
		...(settled.requestId === undefined ? {} : { requestId: settled.requestId }),
		entryId: settled.entry,
		answerEntryId: settled.answer,
		answer: assistantTextOf(entry.model),
		usage,
	};
}

/** Withdraw queued inputs and wait until the conversation's ownership scope is idle. */
export async function abortConversation(conversation: Conversation, background: boolean, context: Context): Promise<void> {
	await conversation.abort(context, background ? { background: true } : undefined);
}

/** True when the conversation has no live ordinary task and no admitted input waiting to run. */
export function conversationIsIdle(inspection: HarnessInspection, conversationId: ConversationId): boolean {
	const liveTask = inspection.tasks.some(
		(task) => task.record.conversationId === conversationId && !task.record.background && task.record.state.status !== "terminal",
	);
	const waiting = inspection.submissions.some(
		(submission) => submission.conversationId === conversationId && (submission.status === "queued" || submission.status === "placed"),
	);
	return !liveTask && !waiting;
}

export async function assertConversationIdle(harness: Harness, conversationId: ConversationId, context: Context): Promise<void> {
	const inspection = await harness.inspect(context);
	if (!conversationIsIdle(inspection, conversationId)) throw new DurableConversationBusyError(conversationId);
}

export interface DurableForkOptions {
	readonly name?: string;
	/** External identity of the creating agent. */
	readonly owner?: string;
	/** Stable request key: a repeated key returns the fork created by the first call. */
	readonly requestId?: string;
}

/** Thrown inside a creating commit when another fork already claimed the request key. */
class DuplicateForkError extends Error {
	readonly conversationId: ConversationId;
	constructor(conversationId: ConversationId) {
		super(`fork request already created conversation ${conversationId}`);
		this.name = "DuplicateForkError";
		this.conversationId = conversationId;
	}
}

/**
 * Fork through one visible entry, or through the newest visible entry when
 * `at` is absent. The fork is ownerless; metadata and the request marker are
 * written in the creating commit, so a retry after any crash returns the same
 * fork instead of a duplicate. The marker is re-read inside the creating commit
 * under the Session's single mutation line, so concurrent requests with one key
 * create one fork even though the initial snapshot read is only a fast path.
 */
export async function forkConversation(
	harness: Harness,
	conversation: Conversation,
	at: EntryId | undefined,
	options: DurableForkOptions,
	context: Context,
): Promise<{ readonly conversation: Conversation; readonly deduped: boolean }> {
	const requestId = options.requestId;
	if (requestId !== undefined) {
		const retainedId = (await harness.snapshot(AgentForkDoc, context))?.forks[requestId];
		if (retainedId !== undefined) {
			const retained = await harness.conversation(retainedId, context);
			if (retained) return { conversation: retained, deduped: true };
		}
	}
	let entry = at;
	if (entry === undefined) {
		const page = await conversation.entries({}, 1, undefined, context);
		entry = page.items[0]?.id;
		if (entry === undefined) throw new Error(`conversation ${conversation.id} has no entries to fork`);
	}
	try {
		const created = await conversation.fork(
			entry,
			{
				ownership: { kind: "ownerless" },
				init: async (tx, childId) => {
					if (requestId !== undefined) {
						const forks = await tx.doc(AgentForkDoc);
						const existing = (forks as { forks: Record<string, ConversationId> }).forks[requestId];
						if (existing !== undefined && existing !== childId) throw new DuplicateForkError(existing);
						(forks as { forks: Record<string, ConversationId> }).forks[requestId] = childId;
					}
					const meta = await tx.doc(AgentMetaDoc, childId);
					if (options.name !== undefined) (meta as { name: string | null }).name = options.name;
					if (options.owner !== undefined) (meta as { owner: string | null }).owner = options.owner;
					await refreshManagedInstructions(tx, childId);
				},
			},
			context,
		);
		return { conversation: created, deduped: false };
	} catch (error) {
		if (!(error instanceof DuplicateForkError)) throw error;
		const retained = await harness.conversation(error.conversationId, context);
		if (retained) return { conversation: retained, deduped: true };
		throw error;
	}
}

export interface DurableRewindParams {
	readonly entryId: EntryId;
	readonly correction: string;
	readonly requestId?: string;
	readonly name?: string;
	readonly owner?: string;
	readonly ownerId?: string;
	readonly whenBusy?: "steer" | "followUp" | "reject";
	readonly operationId?: string;
	readonly origin?: DeliveryOrigin;
}

export interface DurableRewindResult {
	readonly conversation: Conversation;
	readonly predecessorEntryId: EntryId;
	readonly submissionId: SubmissionId;
	readonly deduped: boolean;
}

/**
 * Drop the decision entry and its descendants into a native fork, then admit the
 * correction there. The source conversation is unchanged. Only a supplied
 * request ID is a stable key: it marks the fork and is the correction's native
 * request ID, so a repeated key returns the retained fork and admission. An
 * absent key is a fresh invocation identity, so two rewinds of one entry with
 * different corrections create distinct forks.
 */
export async function rewindConversation(
	harness: Harness,
	conversation: Conversation,
	params: DurableRewindParams,
	context: Context,
): Promise<DurableRewindResult> {
	const suppliedRequestId = params.requestId;
	const submissionRequestId = suppliedRequestId ?? `rewind:${randomUUID()}`;
	const page = await conversation.entries({ maxEntryId: params.entryId }, 2, undefined, context);
	const target = page.items[0];
	if (target === undefined || target.id !== params.entryId) {
		throw new Error(`entry ${params.entryId} is not visible from conversation ${conversation.id}`);
	}
	const predecessor = page.items[1];
	if (predecessor === undefined) throw new Error(`entry ${params.entryId} has no visible predecessor to fork at`);
	const forked = await forkConversation(
		harness,
		conversation,
		predecessor.id,
		{
			...(params.name === undefined ? {} : { name: params.name }),
			...(params.owner === undefined ? {} : { owner: params.owner }),
			...(suppliedRequestId === undefined ? {} : { requestId: suppliedRequestId }),
		},
		context,
	);
	const submitted = await submitConversation(
		forked.conversation,
		{
			message: params.correction,
			requestId: submissionRequestId,
			...(params.ownerId === undefined ? {} : { ownerId: params.ownerId }),
			...(params.whenBusy === undefined ? {} : { whenBusy: params.whenBusy }),
			...(params.operationId === undefined ? {} : { operationId: params.operationId }),
			...(params.origin === undefined ? {} : { origin: params.origin }),
		},
		context,
	);
	return { conversation: forked.conversation, predecessorEntryId: predecessor.id, submissionId: submitted.submissionId, deduped: forked.deduped };
}

/** Retained text includes the native wrapper; queued writes have no observed size. */
async function compactionSummarySize(harness: Harness, result: { entryId?: EntryId; submissionId?: SubmissionId }, context: Context): Promise<number | undefined> {
	let entryId = result.entryId;
	if (entryId === undefined && result.submissionId !== undefined) {
		const submission = await harness.submission(result.submissionId, context);
		const record = await submission?.status(context);
		if (record?.type === "write" && record.status === "done") entryId = record.entry;
	}
	if (entryId === undefined) return undefined;
	const summary = await harness.commit((tx) => tx.entry(CompactionEntry, entryId), context);
	return summary?.model?.reduce((size, message) => size + (typeof message.content === "string" ? message.content.length : message.content.reduce((chars, part) => chars + (part.type === "text" ? part.text.length : 0), 0)), 0);
}

async function compactionSummaryFacts(harness: Harness, result: { entryId?: EntryId; submissionId?: SubmissionId }, context: Context): Promise<{ summaryChars?: number; summarySizeError?: string }> {
	try {
		const summaryChars = await compactionSummarySize(harness, result, context);
		return summaryChars === undefined ? {} : { summaryChars };
	} catch (error) { return { summarySizeError: error instanceof Error ? error.message : String(error) }; }
}

/** Run a manual compaction and optionally wait for its placement. */
export async function compactConversation(
	harness: Harness,
	conversation: Conversation,
	instructions: string | undefined,
	wait: boolean,
	context: Context,
): Promise<{
	readonly taskId: TaskId<{ entryId?: EntryId; submissionId?: SubmissionId }>;
	readonly status: "task" | "completed" | "aborted" | "failed" | "orphaned" | "faulted";
	readonly summaryChars?: number;
	readonly summarySizeError?: string;
	readonly entryId?: EntryId;
	readonly submissionId?: SubmissionId;
	readonly error?: string;
}> {
	const taskId = await conversation.compact(instructions, context);
	if (!wait) return { taskId, status: "task" };
	const settled = await harness.waitForTask(taskId, context);
	const outcome = settled.state.outcome;
	if (outcome.status === "completed") {
		return {
			taskId,
			status: "completed",
			...await compactionSummaryFacts(harness, outcome.result, context),
			...(outcome.result.entryId === undefined ? {} : { entryId: outcome.result.entryId }),
			...(outcome.result.submissionId === undefined ? {} : { submissionId: outcome.result.submissionId }),
		};
	}
	if (outcome.status === "failed" || outcome.status === "faulted") {
		return { taskId, status: outcome.status, error: outcome.error.message };
	}
	return { taskId, status: outcome.status };
}

export interface DurableConfigureParams {
	readonly model?: ModelRef | null;
	readonly thinkingLevel?: ModelThinkingLevel | null;
	readonly name?: string | null;
}

/** Runtime inputs the caller supplies for one native configuration attempt. */
export interface DurableConfigureOptions {
	/** External identity returned in the result. */
	readonly sessionId: string;
	/** The host's model catalog, for resolving and clamping the selected model. */
	readonly models: Models;
	/** Storage file whose existence the persistence field reports. */
	readonly storagePath?: string;
}

const CONFIGURATION_PERSISTENCE_NOTE = "Durable commits are atomic per transaction; storage contents are not independently verified. No rollback or replay.";

/** No native configuration hook exists; extension failures reach the host report channel instead. */
function configurationHookErrors(): ConfigurationResult["hookErrors"] {
	return {
		count: 0,
		events: [],
		omitted: 0,
		observation: "Durable configuration runs no model-selection or tool hooks; extension failures reach the host report channel instead.",
	};
}

/** Committed configuration state: display name, exact model identity, and reasoning level. */
async function readConfigurationState(harness: Harness, conversation: Conversation, context: Context): Promise<ConfigurationState> {
	const agent = await conversation.agent(context);
	const meta = await harness.snapshot(AgentMetaDoc, conversation.id, context);
	return {
		name: meta?.name ?? "",
		model: agent.model === undefined ? null : `${agent.model.provider}/${agent.model.modelId}`,
		thinkingLevel: agent.thinkingLevel ?? null,
	};
}

/** Validate host configure parameters into the shared patch contract. */
function configurationPatch(params: DurableConfigureParams): ConfigurationPatch {
	const input: Record<string, unknown> = {};
	if (params.name !== undefined) input.name = params.name ?? "";
	if (params.model !== undefined) {
		if (params.model === null) throw new TypeError("model cannot be cleared; supply an exact provider/model identity");
		input.model = `${params.model.provider}/${params.model.modelId}`;
	}
	if (params.thinkingLevel !== undefined) {
		if (params.thinkingLevel === null) throw new TypeError("thinkingLevel cannot be cleared; supply a level");
		input.thinkingLevel = params.thinkingLevel;
	}
	return validateConfigurationPatch(input);
}

interface ResolvedConfiguration {
	readonly requestedLevel?: ModelThinkingLevel;
	readonly effectiveLevel?: ModelThinkingLevel;
	readonly error?: string;
}

/** Resolve the reasoning request against the target model's supported levels. */
function resolveConfiguration(patch: ConfigurationPatch, before: ConfigurationState, models: Models): ResolvedConfiguration {
	const requestedLevel = configurationThinkingLevel(patch, before.thinkingLevel);
	if (requestedLevel === undefined) return {};
	const target = patch.model ?? before.model;
	if (target === null) return { error: "The conversation has no model to clamp the reasoning level against." };
	const identity = configurationModel(target);
	const resolved = models.getModel(identity.provider, identity.modelId);
	if (resolved === undefined) return { error: "The requested model is not available in the configured model catalog." };
	return { requestedLevel, effectiveLevel: clampThinkingLevel(resolved, requestedLevel) };
}

interface AppliedConfiguration {
	readonly writes: boolean;
	readonly error?: string;
}

/** Commit the selected agent change and then the name; each commit is atomic on its own. */
async function applyConfiguration(conversation: Conversation, patch: ConfigurationPatch, effectiveLevel: ModelThinkingLevel | undefined, context: Context): Promise<AppliedConfiguration> {
	const change: { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } = {};
	if (patch.model !== undefined) change.model = configurationModel(patch.model);
	if (effectiveLevel !== undefined) change.thinkingLevel = effectiveLevel;
	let writes = false;
	if (Object.keys(change).length > 0) {
		writes = true;
		try {
			await conversation.configure(change as AgentChange, context);
		} catch {
			return { writes, error: patch.model === undefined ? "The reasoning update was not retained." : "The model update was not retained." };
		}
	}
	if (patch.name === undefined) return { writes };
	try {
		await writeConversationName(conversation, patch.name, context);
	} catch {
		return { writes: true, error: "The name update was not retained." };
	}
	return { writes: true };
}

function configurationResult(
	sessionId: string,
	before: ConfigurationState,
	patch: ConfigurationPatch,
	after: ConfigurationState,
	resolved: ResolvedConfiguration,
	applied: AppliedConfiguration | undefined,
	fileExists: boolean,
): ConfigurationResult {
	const error = resolved.error ?? applied?.error;
	const outcome = error === undefined ? "applied" : "failed";
	const effective = resolved.effectiveLevel ?? before.thinkingLevel;
	return boundedConfigurationResult({
		sessionId,
		outcome,
		before,
		beforeSource: "live",
		requested: patch,
		after,
		afterSource: "live",
		...(resolved.requestedLevel === undefined ? {} : { reasoning: { requested: resolved.requestedLevel, effective, clamped: resolved.requestedLevel !== effective } }),
		hookErrors: configurationHookErrors(),
		persistence: {
			nativeWrites: applied === undefined || !applied.writes ? "not-attempted" : outcome === "applied" ? "completed" : "uncertain",
			fileExists,
			note: CONFIGURATION_PERSISTENCE_NOTE,
		},
		...(error === undefined ? {} : { error }),
	});
}

/**
 * Change model, reasoning level, or display name and return the configuration outcome.
 * Requires an idle conversation. The requested reasoning level is clamped with the
 * resolved model's supported levels, and the clamped value is what the commit retains.
 */
export async function configureConversation(
	harness: Harness,
	conversation: Conversation,
	options: DurableConfigureOptions,
	params: DurableConfigureParams,
	context: Context,
): Promise<ConfigurationResult> {
	await assertConversationIdle(harness, conversation.id, context);
	const patch = configurationPatch(params);
	const before = await readConfigurationState(harness, conversation, context);
	const fileExists = options.storagePath !== undefined && existsSync(options.storagePath);
	const resolved = resolveConfiguration(patch, before, options.models);
	if (resolved.error !== undefined) return configurationResult(options.sessionId, before, patch, before, resolved, undefined, fileExists);
	const applied = await applyConfiguration(conversation, patch, resolved.effectiveLevel, context);
	const after = await readConfigurationState(harness, conversation, context);
	return configurationResult(options.sessionId, before, patch, after, resolved, applied, fileExists);
}

export async function writeConversationName(conversation: Conversation, name: string | null, context: Context): Promise<void> {
	await conversation.commit(async (tx) => {
		const meta = await tx.doc(AgentMetaDoc, conversation.id);
		(meta as { name: string | null }).name = name;
		await refreshManagedInstructions(tx, conversation.id);
	}, context);
}

/** Delivery rows the owner has not acknowledged, after settling every known receipt. */
export async function undeliveredReceipts(harness: Harness, ownerId: string, context: Context): Promise<DeliveryReceipt[]> {
	await settleDeliveries(harness, context);
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	if (!state) return [];
	return Object.values(state.receipts).filter((receipt) => receipt.ownerId === ownerId && !receipt.acknowledged);
}

/** Recorded outbound reports the owner has not acknowledged. */
export async function undeliveredReports(harness: Harness, ownerId: string, context: Context): Promise<DeliveryReport[]> {
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	if (!state) return [];
	return state.reports.filter((report) => report.ownerId === ownerId && !report.acknowledged);
}

export interface OwnerDeliveries {
	readonly receipts: DeliveryReceipt[];
	readonly reports: DeliveryReport[];
}

/** Both delivery kinds awaiting one owner in a single committed read. */
export async function undeliveredForOwner(harness: Harness, ownerId: string, context: Context): Promise<OwnerDeliveries> {
	return { receipts: await undeliveredReceipts(harness, ownerId, context), reports: await undeliveredReports(harness, ownerId, context) };
}

/**
 * Retain one outbound report from a Durable agent to an owner session. A
 * repeated request ID returns the retained report unchanged, including its
 * acknowledgement, so a retry never reopens a delivered report.
 */
export async function recordReport(
	harness: Harness,
	params: { readonly ownerId: string; readonly senderIdentity: string; readonly message: string; readonly requestId: string; readonly replyTo?: string },
	context: Context,
): Promise<DeliveryReport> {
	const { ownerId, senderIdentity, message, requestId, replyTo } = params;
	const existing = (await harness.snapshot(AgentDeliveryDoc, context))?.reports.find(
		(report) => report.ownerId === ownerId && report.requestId === requestId,
	);
	if (existing !== undefined) return existing;
	return harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		const found = state.reports.find((report) => report.ownerId === ownerId && report.requestId === requestId);
		if (found !== undefined) return found;
		const report: DeliveryReport = {
			sourceId: `report:${requestId}`,
			requestId,
			ownerId,
			senderIdentity,
			message,
			replyTo: replyTo ?? null,
			acknowledged: false,
			createdAt: Date.now(),
		};
		state.reports.push(report);
		return report;
	}, context);
}

/** Number of known delivery intents that have no settled receipt yet. */
export async function pendingDeliveries(harness: Harness, ownerId: string, context: Context): Promise<number> {
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	if (!state) return 0;
	const settled = new Set(Object.keys(state.receipts));
	return state.intents.filter((intent) => intent.ownerId === ownerId && (intent.submissionId === null || !settled.has(String(intent.submissionId)))).length;
}

function receiptRow(intent: DeliveryIntent, record: Extract<SubmissionRecord, { readonly type: "input" }> & { readonly status: "done" | "unanswered" }, answer: string | null): DeliveryReceipt {
	return {
		submissionId: record.id,
		requestId: intent.requestId,
		ownerId: intent.ownerId,
		conversationId: intent.conversationId,
		operationId: intent.operationId,
		origin: intent.origin,
		status: record.status,
		entryId: record.entry ?? null,
		answerEntryId: record.status === "done" ? record.answer : null,
		answer,
		reason: record.status === "unanswered" ? record.reason : null,
		acknowledged: false,
	};
}

async function finalizeReceipt(tx: Tx, state: AgentDeliveryState, intent: DeliveryIntent, index: number): Promise<void> {
	if (intent.submissionId !== null && state.receipts[String(intent.submissionId)] !== undefined) return;
	const record = await tx.submissionByRequest(intent.conversationId, intent.requestId);
	if (record === undefined || record.type !== "input") return;
	if (intent.submissionId === null) state.intents[index] = { ...intent, submissionId: record.id };
	if (record.status !== "done" && record.status !== "unanswered") return;
	if (state.receipts[String(record.id)] !== undefined) return;
	let answer: string | null = null;
	if (record.status === "done") {
		const entry = await tx.entry(AssistantEntry, record.answer);
		const text = assistantTextOf(entry?.model);
		answer = text === "" ? null : text.slice(0, 1200);
	}
	state.receipts[String(record.id)] = receiptRow(intent, record, answer);
}

/**
 * Materialize settled inputs in one commit. Native run settlement assigns one
 * answer to all run inputs atomically, so no observer sees a partial answer
 * group. Request lookup covers admission before its intent link is written.
 */
export async function settleDeliveries(harness: Harness, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		for (const [index, intent] of state.intents.entries()) await finalizeReceipt(tx, state, intent, index);
		for (const conversationId of new Set(state.intents.map((intent) => intent.conversationId))) await cleanupRequestContexts(tx, conversationId);
		for (let index = state.reports.length - 1; index >= 0; index -= 1) {
			const report = state.reports[index];
			if (report?.checkIn === undefined) continue;
			const watched = await tx.submissionByRequest(report.checkIn.conversationId as ConversationId, report.checkIn.requestId);
			if (watched?.status === "done" || watched?.status === "unanswered") state.reports.splice(index, 1);
		}
	}, context);
}

/** Mark receipts delivered by their owner. Only the owning caller can acknowledge its rows. */
export async function acknowledgeDeliveries(
	harness: Harness,
	ownerId: string,
	submissionIds: readonly SubmissionId[],
	context: Context,
): Promise<SubmissionId[]> {
	await settleDeliveries(harness, context);
	const wanted = new Set(submissionIds);
	const acknowledged: SubmissionId[] = [];
	await harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		for (const [key, receipt] of Object.entries(state.receipts)) {
			if (receipt.ownerId !== ownerId || !wanted.has(receipt.submissionId) || receipt.acknowledged) continue;
			state.receipts[key] = { ...receipt, acknowledged: true };
			acknowledged.push(receipt.submissionId);
		}
	}, context);
	return acknowledged;
}

/** Mark reports delivered by their owner. */
export async function acknowledgeReports(harness: Harness, ownerId: string, sourceIds: readonly string[], context: Context): Promise<string[]> {
	const wanted = new Set(sourceIds);
	const acknowledged: string[] = [];
	await harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		for (const [index, report] of state.reports.entries()) {
			if (report.ownerId !== ownerId || report.acknowledged || !wanted.has(report.sourceId)) continue;
			if (report.threadId !== undefined) {
				const notices = await tx.doc(ThreadDeliveryDoc, report.threadId, null);
				if (notices.pending < 1) throw new Error("The pending thread-notice projection is inconsistent");
				notices.pending -= 1;
			}
			state.reports[index] = { ...report, acknowledged: true };
			acknowledged.push(report.sourceId);
		}
	}, context);
	return acknowledged;
}

/** Resolve retained receipts by the caller's operation ID, across owners. */
export async function receiptsByOperation(harness: Harness, operationId: string, context: Context): Promise<DeliveryReceipt[]> {
	await settleDeliveries(harness, context);
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	if (!state) return [];
	return Object.values(state.receipts).filter((receipt) => receipt.operationId === operationId);
}

/**
 * Resolve delivery intents that have no submission yet: look up the request ID
 * through Durable's deduplication first, and admit the stored message only when
 * no submission exists. Runs once per open before control traffic.
 */
export async function reconcileDeliveries(harness: Harness, context: Context): Promise<void> {
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	if (!state) return;
	for (const intent of state.intents) {
		if (intent.submissionId !== null) continue;
		let submissionId = (await harness.commit((tx) => tx.submissionByRequest(intent.conversationId, intent.requestId), context))?.id;
		if (submissionId === undefined) {
			const conversation = await harness.conversation(intent.conversationId, context);
			if (!conversation) continue;
			const admitted = await conversation.submit(
				{
					type: "input",
					content: deliveredMessage(intent.message),
					requestId: intent.requestId,
					...(intent.whenBusy === null ? {} : { whenBusy: intent.whenBusy }),
				},
				context,
			);
			submissionId = admitted.id;
		}
		const resolved = submissionId;
		await harness.commit(async (tx) => {
			const current = await tx.doc(AgentDeliveryDoc);
			const index = intentIndex(current, intent.conversationId, intent.requestId);
			if (index < 0) return;
			const found = current.intents[index];
			if (found !== undefined && found.submissionId === null) current.intents[index] = { ...found, submissionId: resolved };
		}, context);
	}
	await settleDeliveries(harness, context);
}

function abortWatch(signals: readonly AbortSignal[], reason: (signal: AbortSignal | undefined) => Error): { readonly promise: Promise<never>; readonly dispose: () => void } {
	const listeners: { signal: AbortSignal; listener: () => void }[] = [];
	const promise = new Promise<never>((_, reject) => {
		for (const signal of signals) {
			const listener = () => reject(reason(signals.find((candidate) => candidate.aborted)));
			listeners.push({ signal, listener });
			if (signal.aborted) {
				listener();
				break;
			}
			signal.addEventListener("abort", listener, { once: true });
		}
	});
	return { promise, dispose: () => { for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener); } };
}

/** First cancellation reason among the signals, if any. */
function cancellationReason(signals: readonly AbortSignal[]): Error | undefined {
	const aborted = signals.find((signal) => signal.aborted);
	if (aborted === undefined) return undefined;
	return aborted.reason instanceof Error ? aborted.reason : new Error("request cancelled while waiting for receipts");
}

/**
 * Resolve when this owner has at least one unacknowledged receipt or report.
 * The wait is event-based on committed publications; it never polls and never
 * sleeps. A cancelled request or a closing host rejects with that signal's
 * reason, never with a later storage error from the same shutdown.
 */
export async function waitForReceipts(
	harness: Harness,
	ownerId: string,
	context: Context,
	closeSignal?: AbortSignal,
): Promise<OwnerDeliveries> {
	for (;;) {
		let wake!: () => void;
		const woke = new Promise<void>((resolve) => {
			wake = resolve;
		});
		const unsubscribe = harness.subscribeCommits(() => {
			queueMicrotask(wake);
		});
		const signals = [context.abortSignal, closeSignal].filter((signal): signal is AbortSignal => signal !== undefined);
		const abort = abortWatch(signals, () => cancellationReason(signals) ?? new Error("request cancelled while waiting for receipts"));
		// The race attaches later, after the read below; keep an early rejection handled.
		void abort.promise.catch(() => {});
		try {
			const deliveries = await undeliveredForOwner(harness, ownerId, context);
			if (deliveries.receipts.length > 0 || deliveries.reports.length > 0) return deliveries;
			await Promise.race([woke, abort.promise]);
		} catch (error) {
			const cancelled = cancellationReason(signals);
			if (cancelled !== undefined) throw cancelled;
			throw error;
		} finally {
			unsubscribe();
			abort.dispose();
		}
	}
}
