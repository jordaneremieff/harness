/** Native child continuity facts, and capacity and planning-budget reports for exact reply recipients. */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { AssistantEntry, InboxDoc, LiveDoc, type CommitPublication, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type LiveState, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { onStoredCommit } from "./commit-observation.ts";
import { planningBudgetBody, planningBudgetCrossed, planningBudgetSelfBody, planningBudgetSelfId, planningBudgetSourceId } from "./continuity-budget.ts";
import { retainedIntent, retainedReportRequest } from "./delivery-store.ts";
import { recordReportInTransaction } from "./durable-controls.ts";
import { canonicalIdentity } from "./native-identity.ts";
import { safeProviderError } from "./primary-observation.ts";
import { RequestContextDoc } from "./request-context.ts";
import type { ResultReference } from "./result-schema.ts";

export const CHILD_CAPACITY_REPORT_PERCENT = 90;
/** Entry kind of the notice a conversation receives when it crosses its own planning budget. */
export const PLANNING_BUDGET_NOTICE_KIND = "agent.planning-budget";
const PREDECESSOR_SCAN_ENTRIES = 64;

/** `producerRunId` is `runIdentity()` of the producer's run, so one run has one identity for all its tool rounds. */
export function childCapacityRequestId(ownerId: string, producerIdentity: string, producerRunId: number): string {
	return `child-capacity:${createHash("sha256").update(JSON.stringify([ownerId, producerIdentity, producerRunId])).digest("hex")}`;
}

/**
 * A run is named by the first input it started with. Durable starts every run with at least one input,
 * only appends later ones, and empties the list once the run answered; `LiveRun.taskId` moves to a new
 * generation after each tool round and `LiveRun.first` can appear after the run started, so neither names
 * the run. Undefined for a run that answered and only waits for its after-run tasks.
 */
export function runIdentity(run: { readonly inputs: readonly number[] }): number | undefined {
	return run.inputs[0];
}

/** Exact-model planning budget in tokens; undefined when the operator configured none. */
export type PlanningBudgetLookup = (provider: string, modelId: string) => number | undefined;

export type ChildContinuityFact = { tokens?: number; window?: number; compactionFailure?: { trigger: string; error: string }; unavailable?: string };

/** Context tokens of a completed provider response; an unfinished or failed response measures nothing. */
function completedUsage(message: AssistantMessage): number | undefined {
	if (message.stopReason === "pending" || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") return undefined;
	const tokens = calculateContextTokens(message.usage);
	return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

function positive(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function modelWindow(models: () => Models, provider: string, modelId: string): number | undefined {
	try { return positive(models().getModel(provider, modelId)?.contextWindow); }
	catch { return undefined; }
}

function usedPercent(tokens: number, window: number): number {
	return Math.floor(tokens / window * 100);
}

/** The active context supplies the newest usage; a context without a completed response has none. */
export async function childContinuityFact(harness: Harness, conversationId: ConversationId, models: () => Models, context: Context): Promise<ChildContinuityFact> {
	try {
		const conversation = await harness.conversation(conversationId, context);
		if (conversation === undefined) return { unavailable: "the native conversation is not retained" };
		const view = await conversation.context(context);
		const message = view.messages.findLast((item): item is AssistantMessage => item.role === "assistant" && completedUsage(item) !== undefined);
		const tokens = message === undefined ? undefined : completedUsage(message);
		const window = message === undefined ? undefined : modelWindow(models, message.provider, message.model);
		const failure = (await harness.snapshot(LiveDoc, conversationId, context))?.compactionFailure;
		return {
			...(tokens === undefined ? {} : { tokens }),
			...(window === undefined ? {} : { window }),
			...(failure === undefined ? {} : { compactionFailure: { trigger: failure.trigger, error: safeProviderError(failure.error, 512).text } }),
		};
	} catch { return { unavailable: "the native continuity fact read failed" }; }
}

const UNUSABLE_ANSWER = "The child returned no usable answer. The facts above are its last observed state; they do not predict the next attempt. Inspect the child (agent_inspect) before another send. If its context is near the window or a compaction failed, agent_compact with instructions or agent_reset with a handoff that names its latest handover or checkpoint can restore room.";

/** Lines for a delivered child result; `unusable` marks an unanswered result or an empty answer. */
export function continuityLines(fact: ChildContinuityFact, unusable = false): string[] {
	const lines: string[] = [];
	if (fact.unavailable !== undefined) lines.push(`Child continuity facts are unavailable: ${fact.unavailable}.`);
	if (fact.tokens !== undefined) lines.push(fact.window === undefined
		? `Child context use: ${fact.tokens} tokens; context window unavailable.`
		: `Child context use: ${fact.tokens} of ${fact.window} tokens (${usedPercent(fact.tokens, fact.window)}%, newest assistant usage).`);
	if (fact.compactionFailure !== undefined) lines.push(`Last child compaction failure (${fact.compactionFailure.trigger}): ${fact.compactionFailure.error}`);
	if (unusable) lines.push(UNUSABLE_ANSWER);
	return lines;
}

type RunRef = { taskId: TaskId; id?: number };
type Usage = { tokens: number; runId?: number };
/** `seeded` means the predecessor of the next sample is known in memory, also when there is none. */
type Track = { run?: RunRef; headId?: EntryId; last?: Usage; seeded: boolean; noticed: boolean };
type Sample = { entryId: EntryId; generationId?: TaskId; tokens: number; model: string; window?: number; budget?: number; runId?: number };
type CapacityReport = { runId: number; tokens: number; window: number };
type BudgetReport = { runId: number; tokens: number; budget: number; model: string };
type SelfNotice = { headId?: EntryId; runId: number; tokens: number; budget: number; model: string; observedAt: number };
/** The first sample after host open; its predecessor is read from the retained transcript. */
type Seed = Sample & { budget: number; headId?: EntryId; observedAt: number };
/** One slot per report kind: a newer run replaces an ended one, whose report can no longer name a live run. */
type Pending = { capacity?: CapacityReport; budget?: BudgetReport; self?: SelfNotice; seed?: Seed };
type Changes = { live?: LiveState; retired?: true; entries: EntryRecord[] };
type ReportDraft = { requestId: (ownerId: string) => string; message: string };

/** A run that answered keeps its task and loses its inputs; it stays the run observed before. */
function runRef(live: LiveState, before: RunRef | undefined): RunRef | undefined {
	if (live.run === undefined) return undefined;
	const id = runIdentity(live.run) ?? (before?.taskId === live.run.taskId ? before.id : undefined);
	return { taskId: live.run.taskId, ...(id === undefined ? {} : { id }) };
}

/**
 * Whether an entry was appended after a live run started. A run that an input started begins at the
 * entry that placed that input. A run that an idle continue started places no entry: the commit that
 * creates the continue also starts its run, and every ID of a storage comes from one increasing
 * sequence, so an entry with a greater ID than the continue was appended in that run.
 */
async function inRun(tx: Tx, runId: number, entryId: EntryId): Promise<boolean> {
	const first = await tx.submission(runId as SubmissionId);
	if (first?.type === "input") return first.entry !== undefined && entryId > first.entry;
	return first?.type === "continue" && entryId > first.id;
}

/** An assistant entry belongs to the run whose generation appended it. */
function owningRun(entry: EntryRecord, after: RunRef | undefined, before: RunRef | undefined): RunRef | undefined {
	if (entry.byTaskId === undefined) return undefined;
	if (after?.taskId === entry.byTaskId) return after;
	return before?.taskId === entry.byTaskId ? before : undefined;
}

function groupChanges(publication: CommitPublication): Map<ConversationId, Changes> {
	const groups = new Map<ConversationId, Changes>();
	const group = (id: ConversationId): Changes => {
		const found = groups.get(id) ?? { entries: [] };
		groups.set(id, found);
		return found;
	};
	for (const change of publication.changes) {
		if (change.type === "entry") group(change.value.conversationId).entries.push(change.value);
		else if (change.type === "document" && change.record.kind === "pi.live" && change.conversationId !== undefined) {
			if (change.kind === "retire") group(change.conversationId).retired = true;
			else group(change.conversationId).live = change.value as LiveState;
		}
	}
	return groups;
}

function entryUsage(entry: EntryRecord): { message: AssistantMessage; tokens: number } | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	for (const message of entry.model ?? []) {
		if (message.role !== "assistant") continue;
		const tokens = completedUsage(message);
		if (tokens !== undefined) return { message, tokens };
	}
	return undefined;
}

/** Newest completed usage before `before` in the same context episode, within a bounded scan. */
async function previousUsage(tx: Tx, conversationId: ConversationId, before: EntryId): Promise<{ entryId: EntryId; tokens: number } | undefined> {
	if (before <= 1) return undefined;
	let cursor: Cursor | undefined;
	let visited = 0;
	do {
		const page = await tx.scanEntries({ conversationId, maxEntryId: (before - 1) as EntryId, order: "descending" }, 32, cursor);
		for (const entry of page.items) {
			if (entry.head !== undefined) return undefined;
			const usage = entryUsage(entry);
			if (usage !== undefined) return { entryId: entry.id, tokens: usage.tokens };
		}
		visited += page.items.length;
		cursor = page.next;
	} while (cursor !== undefined && visited < PREDECESSOR_SCAN_ENTRIES);
	return undefined;
}

/** Model-origin reply recipients of a run's inputs, each with every exact input it owns in that run. */
async function runRecipients(tx: Tx, conversationId: ConversationId, sender: string, inputs: readonly SubmissionId[]): Promise<Map<string, ResultReference[]>> {
	const routes = (await tx.doc(RequestContextDoc, conversationId)).requests;
	const owners = new Map<string, ResultReference[]>();
	for (const id of inputs) {
		const input = await tx.submission(id);
		if (input?.type !== "input" || input.conversationId !== conversationId || input.requestId === undefined) continue;
		const intent = await retainedIntent(tx, conversationId, input.requestId);
		const route = routes.find((item) => item.requestId === input.requestId);
		const ownerId = intent?.ownerId ?? route?.replyTo;
		if (ownerId === undefined || (intent?.origin ?? route?.origin) !== "model") continue;
		const results = owners.get(ownerId) ?? [];
		owners.set(ownerId, results);
		results.push({ sessionId: sender, submissionId: input.id, requestId: input.requestId });
	}
	return owners;
}

function reportDrafts(sender: string, runId: number, pending: Pending): ReportDraft[] {
	const drafts: ReportDraft[] = [];
	const capacity = pending.capacity;
	if (capacity?.runId === runId) drafts.push({
		requestId: (ownerId) => childCapacityRequestId(ownerId, sender, runId),
		message: `Child ${sender} reported context use of ${usedPercent(capacity.tokens, capacity.window)}% (${capacity.tokens} of ${capacity.window} tokens, newest assistant usage) in its current run. This report does not stop or change the child. If it needs room, agent_compact with instructions or agent_reset with a handoff can provide it.`,
	});
	const budget = pending.budget;
	if (budget?.runId === runId) drafts.push({
		requestId: (ownerId) => planningBudgetSourceId(ownerId, sender, runId),
		message: planningBudgetBody(sender, budget.tokens, budget.budget, budget.model),
	});
	return drafts;
}

/**
 * Observes stored assistant usage. A run at or above 90% of its model window, or one that crosses its
 * planning budget, sends one active report per model-origin reply recipient; a conversation that crosses
 * its own planning budget receives one retained notice per context episode. Nothing here stops, refuses
 * or compacts work. A report names a live run, so usage first observed in a run's final answer sends none;
 * the continuity lines of that result carry the fact. A failed observation reports once and ends
 * observation for this host.
 */
export class ChildCapacityReports {
	private readonly harness: Harness;
	private readonly storageId: string;
	private readonly models: () => Models;
	private readonly budgetOf: PlanningBudgetLookup;
	private readonly report: (error: unknown) => void;
	private readonly now: () => number;
	private readonly tracks = new Map<ConversationId, Track>();
	private readonly pending = new Map<ConversationId, Pending>();
	private readonly unsubscribe: () => void;
	private running?: Promise<void>;
	private closing = false;
	private failed = false;

	constructor(harness: Harness, storageId: string, models: () => Models, planningBudget: PlanningBudgetLookup, report: (error: unknown) => void, now: () => number = Date.now) {
		this.harness = harness; this.storageId = storageId; this.models = models; this.budgetOf = planningBudget; this.report = report; this.now = now;
		this.unsubscribe = onStoredCommit(harness, (publication) => this.observe(publication));
	}

	private observe(publication: CommitPublication): void {
		if (this.closing || this.failed) return;
		try {
			for (const [conversationId, changes] of groupChanges(publication)) this.observeConversation(conversationId, changes);
		} catch (error) {
			this.fail(error);
			return;
		}
		this.schedule();
	}

	private observeConversation(conversationId: ConversationId, changes: Changes): void {
		if (changes.retired) {
			this.tracks.delete(conversationId);
			this.pending.delete(conversationId);
			return;
		}
		const track: Track = this.tracks.get(conversationId) ?? { seeded: false, noticed: false };
		this.tracks.set(conversationId, track);
		const after = changes.live === undefined ? track.run : runRef(changes.live, track.run);
		for (const entry of changes.entries.sort((left, right) => left.id - right.id)) {
			if (entry.head !== undefined) this.startEpisode(conversationId, track, entry.id);
			else this.observeEntry(conversationId, track, entry, owningRun(entry, after, track.run));
		}
		track.run = after;
	}

	/** A compaction or reset starts a context episode: no usage is known, and the own-budget notice can fire again. */
	private startEpisode(conversationId: ConversationId, track: Track, headId: EntryId): void {
		track.headId = headId; track.last = undefined; track.seeded = true; track.noticed = false;
		const pending = this.pending.get(conversationId);
		if (pending === undefined) return;
		delete pending.self;
		delete pending.seed;
		if (pending.capacity === undefined && pending.budget === undefined) this.pending.delete(conversationId);
	}

	private sample(entry: EntryRecord, run: RunRef | undefined): Sample | undefined {
		const usage = entryUsage(entry);
		if (usage === undefined) return undefined;
		const { provider, model } = usage.message;
		const window = modelWindow(this.models, provider, model);
		const budget = this.planningBudget(provider, model);
		return {
			entryId: entry.id, tokens: usage.tokens, model: `${provider}/${model}`,
			...(entry.byTaskId === undefined ? {} : { generationId: entry.byTaskId }),
			...(window === undefined ? {} : { window }),
			...(budget === undefined ? {} : { budget }),
			...(run?.id === undefined ? {} : { runId: run.id }),
		};
	}

	private planningBudget(provider: string, modelId: string): number | undefined {
		try { return positive(this.budgetOf(provider, modelId)); }
		catch { return undefined; }
	}

	private observeEntry(conversationId: ConversationId, track: Track, entry: EntryRecord, run: RunRef | undefined): void {
		const sample = this.sample(entry, run);
		if (sample === undefined) return;
		const previous = track.last;
		const seeded = track.seeded;
		track.last = { tokens: sample.tokens, ...(sample.runId === undefined ? {} : { runId: sample.runId }) };
		track.seeded = true;
		this.queueCapacity(conversationId, sample);
		if (!seeded) this.queueSeed(conversationId, track, sample);
		else if (previous !== undefined) this.queueCrossing(conversationId, track, sample, previous);
	}

	private slot(conversationId: ConversationId): Pending {
		const pending = this.pending.get(conversationId) ?? {};
		this.pending.set(conversationId, pending);
		return pending;
	}

	private queueCapacity(conversationId: ConversationId, sample: Sample): void {
		if (sample.runId === undefined || sample.window === undefined || sample.tokens / sample.window * 100 < CHILD_CAPACITY_REPORT_PERCENT) return;
		this.slot(conversationId).capacity = { runId: sample.runId, tokens: sample.tokens, window: sample.window };
	}

	/** Only a sample at or above a budget below its window can end a crossing that began before host open. */
	private queueSeed(conversationId: ConversationId, track: Track, sample: Sample): void {
		if (sample.budget === undefined || sample.window === undefined || sample.budget >= sample.window || sample.tokens < sample.budget) return;
		this.slot(conversationId).seed = { ...sample, budget: sample.budget, ...(track.headId === undefined ? {} : { headId: track.headId }), observedAt: this.now() };
	}

	private queueCrossing(conversationId: ConversationId, track: Track, sample: Sample, previous: Usage): void {
		if (sample.budget === undefined || !planningBudgetCrossed(previous.tokens, sample.tokens, sample.budget, sample.window)) return;
		const pending = this.slot(conversationId);
		// The first crossing of a run keeps its measurement; a later sample of that run does not replace it.
		if (sample.runId !== undefined && previous.runId === sample.runId && pending.budget?.runId !== sample.runId) pending.budget = { runId: sample.runId, tokens: sample.tokens, budget: sample.budget, model: sample.model };
		if (track.noticed) return;
		track.noticed = true;
		pending.self = selfNotice(sample, sample.budget, track.headId, this.now());
	}

	private schedule(): void {
		if (this.running !== undefined || this.closing || this.failed || this.pending.size === 0) return;
		this.running = this.drain().catch((error) => this.fail(error)).finally(() => {
			this.running = undefined;
			this.schedule();
		});
	}

	private fail(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.unsubscribe();
		this.pending.clear();
		// The callback is the only route for this failure; a throw from it must not reach the storage publication.
		try { this.report(new Error("Child capacity and planning-budget observation stopped after a failure; reopen the host to resume these reports. Result continuity facts remain separate.", { cause: error })); }
		catch { /* no further route */ }
	}

	private async drain(): Promise<void> {
		while (!this.failed) {
			const next = this.pending.entries().next();
			if (next.done) return;
			const [conversationId, pending] = next.value;
			this.pending.delete(conversationId);
			await this.emit(conversationId, pending);
		}
	}

	private async emit(conversationId: ConversationId, pending: Pending): Promise<void> {
		const conversation = await this.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return;
		const seed = pending.seed;
		if (seed !== undefined) await this.harness.commit((tx) => this.resolveSeed(tx, conversationId, pending, seed), BACKGROUND_CONTEXT);
		if (pending.capacity !== undefined || pending.budget !== undefined) await this.harness.commit((tx) => this.retainChildReports(tx, conversationId, pending), BACKGROUND_CONTEXT);
		if (pending.self !== undefined) await this.retainSelfNotice(conversation, pending.self);
	}

	private async resolveSeed(tx: Tx, conversationId: ConversationId, pending: Pending, seed: Seed): Promise<void> {
		const previous = await previousUsage(tx, conversationId, seed.entryId);
		if (previous === undefined || !planningBudgetCrossed(previous.tokens, seed.tokens, seed.budget, seed.window)) return;
		if (seed.runId !== undefined && await inRun(tx, seed.runId, previous.entryId)) pending.budget ??= { runId: seed.runId, tokens: seed.tokens, budget: seed.budget, model: seed.model };
		const track = this.tracks.get(conversationId);
		if (track === undefined || track.noticed || track.headId !== seed.headId) return;
		track.noticed = true;
		pending.self = selfNotice(seed, seed.budget, seed.headId, seed.observedAt);
	}

	/** The association names the run's current task and inputs, so it is written only while that run is live. */
	private async retainChildReports(tx: Tx, conversationId: ConversationId, pending: Pending): Promise<void> {
		const run = (await tx.doc(LiveDoc, conversationId)).run;
		const runId = run === undefined ? undefined : runIdentity(run);
		if (run === undefined || runId === undefined) return;
		const sender = canonicalIdentity(this.storageId, conversationId);
		const drafts = reportDrafts(sender, runId, pending);
		if (drafts.length === 0) return;
		for (const [ownerId, producerResults] of await runRecipients(tx, conversationId, sender, run.inputs)) {
			for (const draft of drafts) {
				const requestId = draft.requestId(ownerId);
				// One row per recipient and run: a later round of the run names another current task.
				if (await retainedReportRequest(tx, ownerId, requestId) !== undefined) continue;
				await recordReportInTransaction(tx, { storageId: this.storageId, ownerId, senderIdentity: sender, requestId, replyTo: ownerId, intervention: { producerRunId: run.taskId, producerResults }, message: draft.message });
			}
		}
	}

	/**
	 * A write with model content joins a busy run at its next boundary and settles at once on an idle
	 * conversation; neither starts a run. Behind queued inputs of an idle conversation the same write
	 * would place them and start one, so the notice is not written there.
	 */
	private async retainSelfNotice(conversation: Conversation, notice: SelfNotice): Promise<void> {
		const conversationId = conversation.id;
		await this.harness.commit(async (tx) => {
			if (this.tracks.get(conversationId)?.headId !== notice.headId) return;
			const live = await tx.doc(LiveDoc, conversationId);
			if (live.run === undefined && (await tx.doc(InboxDoc, conversationId)).items.length > 0) return;
			const head = await tx.latestHeadMarker(conversationId);
			const text = planningBudgetSelfBody(notice.tokens, notice.budget, notice.model, notice.observedAt);
			await conversation.submit(tx, { type: "write", requestId: planningBudgetSelfId(head?.id ?? 0, notice.runId), entry: { kind: PLANNING_BUDGET_NOTICE_KIND, model: [{ role: "user", content: text, timestamp: notice.observedAt }] } });
		}, BACKGROUND_CONTEXT);
	}

	/** Resolves when no retention is in flight. */
	async flush(): Promise<void> {
		while (this.running !== undefined) await this.running;
	}

	/** Stops observation, then retains what was observed before the call. */
	async close(): Promise<void> {
		this.closing = true;
		this.unsubscribe();
		await this.flush();
		if (this.failed || this.pending.size === 0) return;
		try { await this.drain(); }
		catch (error) { this.fail(error); }
	}
}

function selfNotice(sample: Sample, budget: number, headId: EntryId | undefined, observedAt: number): SelfNotice {
	return { ...(headId === undefined ? {} : { headId }), runId: sample.runId ?? sample.generationId ?? 0, tokens: sample.tokens, budget, model: sample.model, observedAt };
}
