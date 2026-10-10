/** Native retry observations use the existing report ledger and exact request routes. */
import { createHash } from "node:crypto";
import { LiveDoc, DEFAULT_RETRY_POLICY, type Harness, type ConversationId, type SubmissionId, type Tx, type Cursor } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { ProducerAwaitFactSchema, retryFactLines } from "./await-facts.ts";
import { producerRetryFact } from "./await-observation.ts";
import { providerRetryRevision } from "./awaited-results.ts";
import { AgentDeliveryDoc, type AgentDeliveryState, type DeliveryReport } from "./durable-controls.ts";
import { RequestContextDoc } from "./request-context.ts";
import { canonicalIdentity } from "./identity.ts";
import type { ProviderRetryNotice } from "./provider-block.ts";

export const ProviderRetryNoticeSchema = Type.Object({ requesterSubmissionId: Type.Optional(Type.Integer({ minimum: 1 })), fact: ProducerAwaitFactSchema }, { additionalProperties: false });

/** Semantic revision and exact result identities survive fresh observations and source reopen. */
export function providerNoticeRequestId(ownerId: string, notice: ProviderRetryNotice): string {
	const execution = notice.fact.execution;
	if (execution === undefined) throw new Error("A provider retry notice requires native retry evidence.");
	return `provider-retry:${createHash("sha256").update(JSON.stringify([ownerId, notice.fact.sessionId, providerRetryRevision(execution), execution.results.map((result) => [result.sessionId, result.submissionId, result.requestId ?? null]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))])).digest("hex")}`;
}

async function routedProviderResults(tx: Tx, storageId: string, conversationId: ConversationId, inputs: readonly SubmissionId[], ledger: AgentDeliveryState) {
	const routes = await tx.doc(RequestContextDoc, conversationId);
	const senderIdentity = canonicalIdentity(storageId, conversationId);
	const owners = new Map<string, { sessionId: string; submissionId: number; requestId?: string }[]>();
	const candidates = new Map(routes.requests.map((route) => [route.requestId, { owner: route.replyTo, origin: route.origin }]));
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
export async function retainProviderRetryNotices(tx: Tx, storageId: string, conversationId: ConversationId, maxAttempts: number, now: number): Promise<void> {
	const live = await tx.doc(LiveDoc, conversationId);
	if (live.generation?.retry === undefined || live.run === undefined) return;
	const ledger = await tx.doc(AgentDeliveryDoc);
	const senderIdentity = canonicalIdentity(storageId, conversationId);
	const owners = await routedProviderResults(tx, storageId, conversationId, live.run.inputs, ledger);
	for (const [ownerId, results] of owners) for (let offset = 0; offset < results.length; offset += 16) {
		const execution = await producerRetryFact(tx, conversationId, results.slice(offset, offset + 16), maxAttempts);
		if (execution === undefined) continue;
		const notice: ProviderRetryNotice = { fact: { sessionId: senderIdentity, observedAt: now, source: "producer await-state", execution } };
		const requestId = providerNoticeRequestId(ownerId, notice);
		if (ledger.reports.some((report) => report.ownerId === ownerId && report.requestId === requestId)) continue;
		const report: DeliveryReport = { sourceId: `report:${requestId}`, requestId, ownerId, senderIdentity,
			message: `Provider retry observed at ${new Date(now).toISOString()}. This notice is not a terminal result.\n${retryFactLines(execution).join("\n")}`,
			replyTo: ownerId, direct: true, steer: true, providerRetry: notice, acknowledged: false, createdAt: now };
		ledger.reports.push(report);
	}
}

/** Only native live changes schedule observations; read commits do not create an observation loop. */
export class ProviderRetryNotices {
	private readonly harness: Harness;
	private readonly storageId: string;
	private readonly ceiling: () => number;
	private readonly report: (error: unknown) => void;
	private readonly now: () => number;
	private readonly pending = new Set<ConversationId>();
	private readonly unsubscribe: () => void;
	private running?: Promise<void>;
	private closed = false;
	constructor(harness: Harness, storageId: string, settings: { retry?: Partial<typeof DEFAULT_RETRY_POLICY> } | undefined, report: (error: unknown) => void, now: () => number = Date.now) {
		this.harness = harness; this.storageId = storageId; this.report = report; this.now = now;
		this.ceiling = () => { const policy = { ...DEFAULT_RETRY_POLICY, ...settings?.retry }; return policy.enabled ? policy.maxRetries + 1 : 1; };
		this.unsubscribe = harness.subscribeCommits((publication) => {
			for (const change of publication.changes) if (change.type === "document" && change.record.kind === "pi.live" && change.conversationId !== undefined && change.value !== null) this.pending.add(change.conversationId);
			this.schedule();
		});
	}
	async initialize(): Promise<void> {
		let cursor: Cursor | undefined;
		do {
			const page = await this.harness.commit((tx) => tx.scanConversations({}, 64, cursor), BACKGROUND_CONTEXT);
			for (const conversation of page.items) this.pending.add(conversation.id);
			cursor = page.next;
		} while (cursor !== undefined);
		this.schedule(); await this.running;
	}
	private schedule(): void {
		if (this.closed || this.running !== undefined || this.pending.size === 0) return;
		this.running = this.drain().catch(this.report).finally(() => { this.running = undefined; this.schedule(); });
	}
	private async drain(): Promise<void> {
		while (!this.closed && this.pending.size > 0) {
			const ids = [...this.pending]; this.pending.clear();
			await this.harness.commit(async (tx) => { for (const id of ids) await retainProviderRetryNotices(tx, this.storageId, id, this.ceiling(), this.now()); }, BACKGROUND_CONTEXT);
		}
	}
	async close(): Promise<void> { this.closed = true; this.unsubscribe(); await this.running; }
}
