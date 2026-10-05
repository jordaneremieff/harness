/** Read and release only the selected native run; producer facts never recurse. */
import { InboxDoc, LiveDoc, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { AwaitDoc, referenceKey, type AwaitDeclaration } from "./awaited-results.ts";
import { canonicalIdentity } from "./identity.ts";
import type { AwaitFact, OwnAwaitFact, ProducerAwaitFact } from "./await-facts.ts";
import type { ResultReference } from "./result-reference.ts";

const OWN_AWAIT_BYTE_LIMIT = 8000;
const AWAIT_BYTE_LIMIT = 12000;

/** Suppressed named check-ins and passive writes are not queued follow-up inputs. */
export async function queuedAwaitInputCount(tx: Tx, conversationId: ConversationId, results: readonly ResultReference[]): Promise<number> {
	const automatic = (await tx.doc(AwaitDoc)).provenance.filter((item) => item.conversationId === conversationId && item.classification === "automatic" && item.automaticKind === "checkIn" && results.some((result) => result.sessionId === item.sender && (result.requestId === undefined || result.requestId === item.producerRequestId)));
	return (await tx.doc(InboxDoc, conversationId)).items.filter((item) => item.mode !== "write" && !automatic.some((checkIn) => checkIn.submissionId === item.id)).length;
}

async function activeDeclarations(tx: Tx, conversationId: ConversationId): Promise<AwaitDeclaration[]> {
	const live = await tx.doc(LiveDoc, conversationId);
	if (live.run === undefined) return [];
	const active: AwaitDeclaration[] = [];
	for (const declaration of (await tx.doc(AwaitDoc)).declarations) {
		if (declaration.conversationId !== conversationId || declaration.runId !== live.run.taskId || declaration.decision !== "awaiting") continue;
		const task = await tx.task(declaration.taskId as TaskId);
		if (task !== undefined && !task.abortRequested && task.state.status !== "terminal") active.push(declaration);
	}
	return active;
}

export async function ownAwaitFact(tx: Tx, conversationId: ConversationId): Promise<OwnAwaitFact | undefined> {
	const active = await activeDeclarations(tx, conversationId);
	if (active.length === 0) return undefined;
	const results = new Map<string, OwnAwaitFact["results"][number]>();
	for (const declaration of active) for (const result of declaration.results) {
		const outcome = declaration.outcomes.find((item) => referenceKey(item.result) === referenceKey(result));
		results.set(referenceKey(result), { result, status: outcome?.status ?? "pending", ...(outcome?.reason === undefined ? {} : { reason: outcome.reason.slice(0, 512) }), ...(outcome?.answerEntryId === undefined ? {} : { answerEntryId: outcome.answerEntryId }) });
	}
	const held = [...new Set(active.flatMap((item) => item.inputs))];
	const fact: OwnAwaitFact = { runId: active[0].runId, heldInputs: held.slice(0, 16), results: [...results.values()].slice(0, 16), queuedInputCount: await queuedAwaitInputCount(tx, conversationId, [...results.values()].map((item) => item.result)), queueSnapshot: "committed InboxDoc", omitted: { heldInputs: Math.max(0, held.length - 16), results: Math.max(0, results.size - 16) } };
	while (Buffer.byteLength(JSON.stringify(fact), "utf8") > OWN_AWAIT_BYTE_LIMIT && fact.results.length > 0) { fact.results.pop(); fact.omitted.results++; }
	return JSON.parse(JSON.stringify(fact)) as OwnAwaitFact;
}

export async function readAwaitFact(tx: Tx, storageId: string, conversationId: ConversationId): Promise<AwaitFact | undefined> {
	const own = await ownAwaitFact(tx, conversationId);
	if (own === undefined) return undefined;
	const all = [...new Map((await activeDeclarations(tx, conversationId)).flatMap((item) => item.producers ?? []).map((fact) => [fact.sessionId, fact])).values()];
	const producers = all.slice(0, 16);
	const identity = canonicalIdentity(storageId, conversationId);
	const cycles = () => producers.filter((producer) => producer.awaiting?.results.some((item) => item.status === "pending" && item.result.sessionId === identity && own.heldInputs.includes(item.result.submissionId))).map((item) => item.sessionId);
	const fact: AwaitFact = { ...own, producers, omittedProducers: Math.max(0, all.length - 16), likelyCycle: cycles(), coverage: "one hop; remote graph incomplete" };
	while (Buffer.byteLength(JSON.stringify(fact), "utf8") > AWAIT_BYTE_LIMIT && producers.length > 0) { producers.pop(); fact.omittedProducers++; fact.likelyCycle = cycles(); }
	return JSON.parse(JSON.stringify(fact)) as AwaitFact;
}

export async function recordProducerAwait(tx: Tx, taskId: TaskId, fact: ProducerAwaitFact): Promise<void> {
	const declaration = (await tx.doc(AwaitDoc)).declarations.find((item) => item.taskId === taskId && item.decision === "awaiting");
	if (declaration === undefined || !declaration.results.some((result) => result.sessionId === fact.sessionId)) return;
	const prior = declaration.producers?.find((item) => item.sessionId === fact.sessionId);
	const semantic = (item: ProducerAwaitFact) => JSON.stringify({ awaiting: item.awaiting, unavailable: item.unavailable });
	if (prior !== undefined && semantic(prior) === semantic(fact)) return;
	declaration.producers ??= [];
	const index = declaration.producers.findIndex((item) => item.sessionId === fact.sessionId);
	if (index < 0) declaration.producers.push(fact); else declaration.producers[index] = fact;
}

export async function releaseAwait(tx: Tx, storageId: string, conversationId: ConversationId, expectedRunId: number): Promise<{ released: boolean; awaiting?: AwaitFact }> {
	const active = await activeDeclarations(tx, conversationId);
	if (active.length === 0 || active[0].runId !== expectedRunId) return { released: false };
	const snapshot = await readAwaitFact(tx, storageId, conversationId);
	for (const declaration of active) { declaration.decision = "released"; declaration.releaseReason = "dashboard release"; }
	return { released: true, ...(snapshot === undefined ? {} : { awaiting: snapshot }) };
}
