/** Native retry observations use the existing report ledger and exact request routes. */
import { createHash } from "node:crypto";
import { AgentDoc, LiveDoc, DEFAULT_RETRY_POLICY, defineDoc, type Harness, type ConversationId, type SubmissionId, type TaskId, type Tx, type Cursor, type LiveState, type CommitPublication, type HarnessOptions } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { ProducerAwaitFactSchema } from "./await-facts.ts";
import { safeFactText } from "./primary-observation.ts";
import type { ResultReference } from "./result-reference.ts";
import { providerRetryRevision } from "./awaited-results.ts";
import { AgentDeliveryDoc, type AgentDeliveryState, type DeliveryReport } from "./durable-controls.ts";
import { RequestContextDoc, type RequestContext } from "./request-context.ts";
import { canonicalIdentity } from "./identity.ts";
import type { ProviderRetryNotice } from "./provider-block.ts";

export const ProviderRetryNoticeSchema = Type.Object({ requesterSubmissionId: Type.Optional(Type.Integer({ minimum: 1 })), fact: ProducerAwaitFactSchema }, { additionalProperties: false });

/** Semantic revision and exact result identities survive fresh observations and source reopen. */
export function providerNoticeRequestId(ownerId: string, notice: ProviderRetryNotice): string {
	const execution = notice.fact.execution;
	if (execution === undefined) throw new Error("A provider retry notice requires native retry evidence.");
	return `provider-retry:${createHash("sha256").update(JSON.stringify([ownerId, notice.fact.sessionId, providerRetryRevision(execution), execution.results.map((result) => [result.sessionId, result.submissionId, result.requestId ?? null]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))])).digest("hex")}`;
}

type RetryRoute = Pick<RequestContext, "requestId" | "replyTo" | "origin">;
type RetryObservation = LiveState & { routes?: RetryRoute[] };
type PendingRetries = { retries: Map<number, { first: RetryObservation; latest: RetryObservation }>; current?: RetryObservation };

async function routedProviderResults(tx: Tx, storageId: string, conversationId: ConversationId, inputs: readonly SubmissionId[], ledger: AgentDeliveryState, observedRoutes: readonly RetryRoute[] = []) {
	const routes = await tx.doc(RequestContextDoc, conversationId);
	const senderIdentity = canonicalIdentity(storageId, conversationId);
	const owners = new Map<string, { sessionId: string; submissionId: number; requestId?: string }[]>();
	const candidates = new Map([...routes.requests, ...observedRoutes].map((route) => [route.requestId, { owner: route.replyTo, origin: route.origin }]));
	for (const intent of ledger.intents) if (intent.conversationId === conversationId && !candidates.has(intent.requestId)) candidates.set(intent.requestId, { owner: intent.ownerId, origin: intent.origin });
	for (const [requestId, route] of candidates) {
		if (route.origin !== "model") continue;
		const input = await tx.submissionByRequest(conversationId, requestId);
		if (input?.type !== "input" || !inputs.includes(input.id)) continue;
		const results = owners.get(route.owner) ?? []; owners.set(route.owner, results);
		results.push({ sessionId: senderIdentity, submissionId: input.id, requestId });
	}
	return owners;
}
type RetryBurst = {
	runId: number;
	retries: number;
	attempts: number;
	maxAttempts: number;
	startedAt: number;
	lastRetryAt: number;
	error: string;
	errorTruncated: boolean;
	model?: { provider: string; modelId: string };
	recipients: { ownerId: string; results: ResultReference[] }[];
};
type RetryBurstState = { completedThrough: number; active?: RetryBurst };

/** Open retry evidence and recipient routes survive settlement and host reopen. */
export const ProviderRetryBurstDoc = defineDoc<RetryBurstState>({ kind: "agent.provider-retry-burst", version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false, initial: () => ({ completedThrough: 0 }) });

type BurstEnd = "recovered" | "failed" | "aborted" | "interrupted";
async function burstEnd(tx: Tx, burst: RetryBurst, live: LiveState): Promise<BurstEnd | undefined> {
	const task = await tx.task(burst.runId as TaskId);
	if (task?.state.status === "terminal" || task?.state.status === "completing") {
		switch (task.state.outcome.status) {
			case "completed": return "recovered";
			case "aborted": return "aborted";
			case "failed": case "faulted": return "failed";
			case "orphaned": return "interrupted";
		}
	}
	// A retry backoff ending starts another attempt, not another burst.
	if (live.run?.taskId === burst.runId && live.tools !== undefined) return "recovered";
	if (live.run?.taskId !== burst.runId) return "interrupted";
	return undefined;
}

async function closeBurst(tx: Tx, ledger: AgentDeliveryState, state: RetryBurstState, senderIdentity: string, live: LiveState, now: number): Promise<void> {
	const burst = state.active;
	if (burst === undefined) return;
	const end = await burstEnd(tx, burst, live);
	if (end === undefined) return;
	if (end === "recovered" || end === "failed") burst.attempts = Math.max(burst.attempts, burst.retries + 1);
	for (const { ownerId, results } of end === "failed" ? burst.recipients : []) {
		const requestId = burstRequestId(ownerId, senderIdentity, burst.runId);
		if (ledger.reports.some((report) => report.ownerId === ownerId && report.requestId === requestId)) continue;
		const shown = results.slice(0, 16);
		const report: DeliveryReport = { sourceId: `report:${requestId}`, requestId, ownerId, senderIdentity,
			message: [`Provider retry burst ended at ${new Date(now).toISOString()}. End state: ${end}.`,
				`Generation attempts: ${burst.attempts}. Native retries: ${burst.retries}. Configured attempt ceiling: ${burst.maxAttempts}.`,
				`First retry observed at ${new Date(burst.startedAt).toISOString()}; last retry scheduled for ${new Date(burst.lastRetryAt).toISOString()}.`,
				`Model: ${burst.model === undefined ? "unknown" : `${burst.model.provider}/${burst.model.modelId}`}. Last retry error: ${burst.error}${burst.errorTruncated ? " [truncated]" : ""}`,
				...shown.map((result) => `${result.sessionId} · submission ${result.submissionId}${result.requestId === undefined ? "" : ` · request ${safeFactText(result.requestId, 160).text}`}`),
				...(results.length > shown.length ? [`Omitted result references: ${results.length - shown.length}.`] : []),
				"This summary is not a terminal result. Native result receipts remain separate."].join("\n"),
			replyTo: ownerId, direct: true, steer: true, acknowledged: false, createdAt: now };
		ledger.reports.push(report);
	}
	state.completedThrough = Math.max(state.completedThrough, burst.runId);
	delete state.active;
}

function burstRequestId(ownerId: string, senderIdentity: string, runId: number): string {
	return `provider-retry-burst:${createHash("sha256").update(JSON.stringify([ownerId, senderIdentity, runId])).digest("hex")}:failure`;
}

async function retainRetryEvidence(tx: Tx, conversationId: ConversationId, state: RetryBurstState, observed: RetryObservation, maxAttempts: number, now: number): Promise<void> {
	const run = observed.run;
	const retry = observed.generation?.retry;
	if (run === undefined || retry === undefined || run.taskId <= state.completedThrough) return;
	const error = safeFactText(retry.error);
	const agent = await tx.doc(AgentDoc, conversationId);
	state.active ??= { runId: run.taskId, retries: 0, attempts: 1, maxAttempts, startedAt: now, lastRetryAt: retry.at, error: error.text, errorTruncated: error.truncated, ...(agent.model === undefined ? {} : { model: { provider: safeFactText(agent.model.provider, 256).text, modelId: safeFactText(agent.model.modelId, 256).text } }), recipients: [] };
	const burst = state.active;
	if (burst.runId !== run.taskId) return;
	const attempt = observed.generation?.attempt ?? 1;
	if (attempt >= burst.retries) {
		burst.retries = attempt; burst.lastRetryAt = retry.at; burst.error = error.text; burst.errorTruncated = error.truncated;
	}
}

function retainBurstRecipients(burst: RetryBurst, owners: Map<string, ResultReference[]>): void {
	for (const [ownerId, results] of owners) {
		let recipient = burst.recipients.find((item) => item.ownerId === ownerId);
		if (recipient === undefined) { burst.recipients.push({ ownerId, results: [] }); recipient = burst.recipients[burst.recipients.length - 1]; }
		for (const result of results) if (!recipient.results.some((item) => item.submissionId === result.submissionId)) recipient.results.push(result);
	}
}

/** Committed snapshots preserve short backoffs; one atomic close retains a failure summary. */
export async function retainProviderRetryNotices(tx: Tx, storageId: string, conversationId: ConversationId, maxAttempts: number, now: number, observations?: readonly RetryObservation[]): Promise<void> {
	const live = await tx.doc(LiveDoc, conversationId);
	const state = await tx.doc(ProviderRetryBurstDoc, conversationId);
	const ledger = await tx.doc(AgentDeliveryDoc);
	const senderIdentity = canonicalIdentity(storageId, conversationId);
	for (const observed of observations === undefined ? [live as RetryObservation] : [...observations, live as RetryObservation]) {
		const run = observed.run;
		if (run === undefined) continue;
		if (state.active !== undefined && state.active.runId !== run.taskId) await closeBurst(tx, ledger, state, senderIdentity, live, now);
		await retainRetryEvidence(tx, conversationId, state, observed, maxAttempts, now);
		const burst = state.active;
		if (burst === undefined || burst.runId !== run.taskId) continue;
		burst.attempts = Math.max(burst.attempts, observed.generation?.attempt ?? 1);
		const owners = await routedProviderResults(tx, storageId, conversationId, run.inputs, ledger, observed.routes);
		retainBurstRecipients(burst, owners);
	}
	await closeBurst(tx, ledger, state, senderIdentity, live, now);
}

function retrySnapshot(live: LiveState, routes: readonly RetryRoute[]): RetryObservation {
	return { routes: routes.map(({ requestId, replyTo, origin }) => ({ requestId, replyTo, origin })), ...(live.run === undefined ? {} : { run: { taskId: live.run.taskId, inputs: [...live.run.inputs] } }),
		...(live.generation === undefined ? {} : { generation: { attempt: live.generation.attempt, ...(live.generation.retry === undefined ? {} : { retry: { ...live.generation.retry } }) } }),
		...(live.tools === undefined ? {} : { tools: [] }) };
}

/** Only native live changes schedule observations; read commits do not create an observation loop. */
export class ProviderRetryNotices {
	private readonly harness: Harness;
	private readonly storageId: string;
	private readonly ceiling: () => number;
	private readonly report: (error: unknown) => void;
	private readonly now: () => number;
	private readonly pending = new Map<ConversationId, PendingRetries>();
	private readonly routes = new Map<ConversationId, RetryRoute[]>();
	private readonly unsubscribe: () => void;
	private running?: Promise<void>;
	private closing = false;
	private closed = false;
	constructor(harness: Harness, storageId: string, settings: HarnessOptions["settings"], report: (error: unknown) => void, now: () => number = Date.now) {
		this.harness = harness; this.storageId = storageId; this.report = report; this.now = now;
		this.ceiling = () => { const policy = { ...DEFAULT_RETRY_POLICY, ...(typeof settings === "function" ? settings() : settings)?.retry }; return policy.enabled ? policy.maxRetries + 1 : 1; };
		this.unsubscribe = harness.subscribeCommits((publication) => {
			this.captureRoutes(publication);
			this.captureLive(publication);
			this.schedule();
		});
	}
	private captureRoutes(publication: CommitPublication): void {
		for (const change of publication.changes) if (change.type === "document" && change.record.kind === "agent.request-context" && change.conversationId !== undefined) {
			const requests = change.value === null ? [] : (change.value as { requests: RequestContext[] }).requests;
			if (requests.length === 0) this.routes.delete(change.conversationId);
			else this.routes.set(change.conversationId, requests.map(({ requestId, replyTo, origin }) => ({ requestId, replyTo, origin })));
		}
	}
	private captureLive(publication: CommitPublication): void {
		for (const change of publication.changes) if (change.type === "document" && change.record.kind === "pi.live" && change.conversationId !== undefined && change.value !== null) this.captureSnapshot(change.conversationId, change.value as LiveState);
	}
	private captureSnapshot(conversationId: ConversationId, live: LiveState): void {
		const pending: PendingRetries = this.pending.get(conversationId) ?? { retries: new Map() };
		const snapshot = retrySnapshot(live, this.routes.get(conversationId) ?? []);
		const run = snapshot.run;
		if (run !== undefined) {
			const prior = pending.retries.get(run.taskId);
			if (snapshot.generation?.retry !== undefined) pending.retries.set(run.taskId, { first: prior?.first ?? snapshot, latest: snapshot });
			else if (prior !== undefined && prior.latest.run !== undefined) {
				prior.latest.run.inputs = [...new Set([...prior.latest.run.inputs, ...run.inputs])];
				prior.latest.routes = [...new Map([...(prior.latest.routes ?? []), ...(snapshot.routes ?? [])].map((route) => [route.requestId, route])).values()];
			}
		}
		pending.current = snapshot;
		this.pending.set(conversationId, pending);
	}
	async initialize(): Promise<void> {
		let cursor: Cursor | undefined;
		do {
			const page = await this.harness.commit(async (tx) => {
				const page = await tx.scanConversations({}, 64, cursor);
				for (const conversation of page.items) {
					const routes = await tx.doc(RequestContextDoc, conversation.id);
					if (routes.requests.length > 0) this.routes.set(conversation.id, routes.requests.map(({ requestId, replyTo, origin }) => ({ requestId, replyTo, origin })));
				}
				return page;
			}, BACKGROUND_CONTEXT);
			for (const conversation of page.items) if (!this.pending.has(conversation.id)) this.pending.set(conversation.id, { retries: new Map() });
			cursor = page.next;
		} while (cursor !== undefined);
		this.schedule(); await this.running;
	}
	private schedule(): void {
		if (this.closed || this.closing || this.running !== undefined || this.pending.size === 0) return;
		let failed = false;
		this.running = this.drain().catch((error) => {
			failed = true; this.unsubscribe();
			this.report(new Error("Retry observation stopped after retention failed; reopen the host to resume retry reports.", { cause: error }));
		}).finally(() => { this.running = undefined; if (!failed) this.schedule(); });
	}
	private async retainPending(tx: Tx, pending: readonly [ConversationId, PendingRetries][]): Promise<void> {
		for (const [id, batch] of pending) {
			const observations = [...batch.retries.values()].flatMap(({ first, latest }) => first === latest ? [first] : [first, latest]);
			if (batch.current !== undefined) observations.push(batch.current);
			await retainProviderRetryNotices(tx, this.storageId, id, this.ceiling(), this.now(), observations.length === 0 ? undefined : observations);
		}
	}
	private restorePending(pending: readonly [ConversationId, PendingRetries][]): void {
		for (const [id, batch] of pending) {
			const newer = this.pending.get(id);
			if (newer !== undefined) {
				for (const [runId, retry] of newer.retries) batch.retries.set(runId, { first: batch.retries.get(runId)?.first ?? retry.first, latest: retry.latest });
				if (newer.current !== undefined) batch.current = newer.current;
			}
			this.pending.set(id, batch);
		}
	}
	private async drain(): Promise<void> {
		while (!this.closed && this.pending.size > 0) {
			let pending: [ConversationId, PendingRetries][] = [];
			try {
				await this.harness.commit(async (tx) => {
					pending = [...this.pending]; this.pending.clear();
					await this.retainPending(tx, pending);
				}, BACKGROUND_CONTEXT);
			} catch (error) {
				this.restorePending(pending);
				throw error;
			}
		}
	}
	async close(): Promise<void> {
		this.closing = true; this.unsubscribe();
		try { await this.running; if (this.pending.size > 0) await this.drain(); }
		finally { this.closed = true; }
	}
}
