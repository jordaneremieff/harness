/** Read and release only the selected native run; producer facts never recurse. */
import { AgentDoc, InboxDoc, LiveDoc, type ConversationId, type TaskId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { AwaitDoc, referenceKey, type AwaitDeclaration } from "./awaited-results.ts";
import { canonicalIdentity } from "./identity.ts";
import type { AwaitFact, OwnAwaitFact, ProducerAwaitFact, ProducerRetry } from "./await-facts.ts";
import type { ResultReference } from "./result-reference.ts";

import { safeFactText } from "./primary-observation.ts";

async function retryInputMatches(tx: Tx, conversationId: ConversationId, result: ResultReference): Promise<boolean> {
	if (result.requestId === undefined) return true;
	const input = await tx.submissionByRequest(conversationId, result.requestId);
	return input?.id === result.submissionId && input.status === "placed";
}

/** Retry belongs only to placed inputs of the current native run. */
export async function producerRetryFact(tx: Tx, conversationId: ConversationId, results: readonly ResultReference[], maxAttempts?: number): Promise<ProducerRetry | undefined> {
	const live = await tx.doc(LiveDoc, conversationId);
	if (live.run === undefined || live.generation?.retry === undefined) return undefined;
	const task = await tx.task(live.run.taskId);
	if (task === undefined || task.abortRequested || task.state.status === "terminal") return undefined;
	const correlated: ResultReference[] = [];
	for (const result of results.slice(0, 16)) {
		if (!live.run.inputs.includes(result.submissionId as SubmissionId)) continue;
		if (!await retryInputMatches(tx, conversationId, result)) continue;
		correlated.push(result);
	}
	if (correlated.length === 0) return undefined;
	const agent = await tx.doc(AgentDoc, conversationId);
	const error = safeFactText(live.generation.retry.error);
	return { state: "provider-retry", runId: live.run.taskId, results: correlated,
		...(agent.model === undefined ? {} : { model: { provider: safeFactText(agent.model.provider, 256).text, modelId: safeFactText(agent.model.modelId, 256).text } }),
		attempt: live.generation.attempt, ...(maxAttempts === undefined ? {} : { maxAttempts }),
		nextRetryAt: live.generation.retry.at, error: error.text, errorTruncated: error.truncated };
}

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

function exactReferenceKey(result: ResultReference): string {
	return JSON.stringify([result.sessionId, result.submissionId, result.requestId ?? null]);
}

function matchesReference(expected: ResultReference, observed: ResultReference): boolean {
	return referenceKey(expected) === referenceKey(observed) && (expected.requestId === undefined || expected.requestId === observed.requestId);
}

/** Reference coverage is not a change in the shared input's execution state. */
function referenceState(fact: ProducerAwaitFact, result: ResultReference): string {
	const execution = fact.execution?.results.some((item) => matchesReference(result, item)) ? fact.execution : undefined;
	const state = execution === undefined ? undefined : (({ results: _results, ...value }) => value)(execution);
	return JSON.stringify({ awaiting: fact.awaiting, execution: state, unavailable: fact.unavailable });
}

function newestObservation(observations: { result: ResultReference; fact: ProducerAwaitFact }[]): typeof observations[number] | undefined {
	return observations.reduce<typeof observations[number] | undefined>((prior, item) => prior === undefined || item.fact.observedAt > prior.fact.observedAt ? item : prior, undefined);
}

function partialObservationLoss(losses: { result: ResultReference; fact: ProducerAwaitFact }[]): string {
	const details = losses.slice(0, 4).map(({ result, fact }) => `submission ${result.submissionId}${result.requestId === undefined ? "" : ` request ${result.requestId}`} at ${fact.observedAt}: ${fact.unavailable}`).join("; ");
	const text = safeFactText(`Partial observation loss (unavailable references: ${losses.length}; up to 4 shown): ${details}`, 500);
	return `${text.text}${text.truncated ? " [truncated]" : ""}`;
}

async function ownFact(tx: Tx, conversationId: ConversationId, active: AwaitDeclaration[]): Promise<{ own: OwnAwaitFact; producers: ProducerAwaitFact[] } | undefined> {
	if (active.length === 0) return undefined;
	const results = new Map<string, OwnAwaitFact["results"][number]>();
	for (const declaration of active) for (const result of declaration.results) {
		const outcome = declaration.outcomes.find((item) => referenceKey(item.result) === referenceKey(result));
		results.set(exactReferenceKey(result), { result, status: outcome?.status ?? "pending", ...(outcome?.reason === undefined ? {} : { reason: safeFactText(outcome.reason).text }), ...(outcome?.answerEntryId === undefined ? {} : { answerEntryId: outcome.answerEntryId }) });
	}
	const held = [...new Set(active.flatMap((item) => item.inputs))];
	const producers = mergedProducers(active, [...results.values()]);
	const retryKeys = new Set(producers.flatMap((producer) => producer.execution?.results.map(exactReferenceKey) ?? []));
	const ranked = [...results.values()].sort((left, right) => Number(retryKeys.has(exactReferenceKey(right.result))) - Number(retryKeys.has(exactReferenceKey(left.result))));
	const fact: OwnAwaitFact = { runId: active[0].runId, heldInputs: held.slice(0, 16), results: ranked.slice(0, 16), queuedInputCount: await queuedAwaitInputCount(tx, conversationId, [...results.values()].map((item) => item.result)), queueSnapshot: "committed InboxDoc", omitted: { heldInputs: Math.max(0, held.length - 16), results: Math.max(0, results.size - 16) } };
	while (Buffer.byteLength(JSON.stringify(fact), "utf8") > OWN_AWAIT_BYTE_LIMIT && fact.results.length > 0) { fact.results.pop(); fact.omitted.results++; }
	return { own: JSON.parse(JSON.stringify(fact)) as OwnAwaitFact, producers };
}

export async function ownAwaitFact(tx: Tx, conversationId: ConversationId): Promise<OwnAwaitFact | undefined> {
	return (await ownFact(tx, conversationId, await activeDeclarations(tx, conversationId)))?.own;
}

/** A read with no retry clears only its declared references, not another await's inputs. */
function mergedProducers(active: AwaitDeclaration[], results: OwnAwaitFact["results"]): ProducerAwaitFact[] {
	const pending = new Set(results.filter((item) => item.status === "pending").map((item) => exactReferenceKey(item.result)));
	const groups = new Map<string, { latest: ProducerAwaitFact; references: Map<string, { result: ResultReference; fact: ProducerAwaitFact }> }>();
	const observations = active.flatMap((declaration) => (declaration.producers ?? []).map((fact) => ({ declaration, fact })));
	for (const { declaration, fact } of observations) {
		let group = groups.get(fact.sessionId);
		if (group === undefined) { group = { latest: fact, references: new Map() }; groups.set(fact.sessionId, group); }
		if (fact.observedAt >= group.latest.observedAt) group.latest = fact;
		for (const result of declaration.results.filter((result) => result.sessionId === fact.sessionId)) {
			const key = exactReferenceKey(result); const prior = group.references.get(key);
			const retries = (value: ProducerAwaitFact) => value.unavailable === undefined && value.execution?.results.some((item) => matchesReference(result, item));
			if (prior === undefined || fact.observedAt > prior.fact.observedAt || (fact.observedAt === prior.fact.observedAt && !retries(fact))) group.references.set(key, { result, fact });
		}
	}
	return [...groups.values()].map<ProducerAwaitFact>(({ latest, references }) => {
		const supported = [...references.values()].filter(({ result, fact }) => fact.unavailable === undefined && pending.has(exactReferenceKey(result)));
		const retries = supported.filter(({ result, fact }) => fact.execution?.results.some((item) => matchesReference(result, item)));
		const newest = newestObservation(retries);
		const successful = newestObservation(supported);
		const observed = latest.unavailable !== undefined && successful !== undefined ? successful.fact : latest;
		const { execution: _execution, awaiting, ...base } = observed;
		const rest = { ...base, ...(awaiting === undefined ? {} : { awaiting: { ...awaiting, results: [...awaiting.results], heldInputs: [...awaiting.heldInputs], omitted: { ...awaiting.omitted } } }) };
		const losses = [...references.values()].filter(({ result, fact }) => fact.unavailable !== undefined && pending.has(exactReferenceKey(result)));
		const scoped = successful !== undefined && losses.length > 0 ? { ...rest, unavailable: partialObservationLoss(losses) } : rest;
		if (newest?.fact.execution === undefined) return scoped;
		const current = retries.filter((item) => item.fact.execution?.runId === newest.fact.execution?.runId);
		// The merged timestamp never makes older reference evidence appear fresher.
		return { ...scoped, observedAt: Math.min(...current.map((item) => item.fact.observedAt)), execution: { ...newest.fact.execution, results: current.map((item) => item.result) } };
	}).sort((left, right) => Number(right.execution !== undefined) - Number(left.execution !== undefined));
}

export async function readAwaitFact(tx: Tx, storageId: string, conversationId: ConversationId, heldInput?: SubmissionId): Promise<AwaitFact | undefined> {
	const active = await activeDeclarations(tx, conversationId);
	if (heldInput !== undefined && !active.some((declaration) => declaration.inputs.includes(heldInput))) return undefined;
	const projected = await ownFact(tx, conversationId, active);
	if (projected === undefined) return undefined;
	const { own, producers: all } = projected;
	retainRetryReferences(all, own.results);
	const producers = all.sort((left, right) => Number(right.execution !== undefined) - Number(left.execution !== undefined)).slice(0, 16);
	const identity = canonicalIdentity(storageId, conversationId);
	const fact: AwaitFact = { ...own, producers, omittedProducers: Math.max(0, all.length - 16), likelyCycle: [], coverage: "one hop; remote graph incomplete" };
	fact.likelyCycle = likelyCycles(fact, identity);
	while (Buffer.byteLength(JSON.stringify(fact), "utf8") > AWAIT_BYTE_LIMIT && producers.length > 0) {
		trimAwaitDetail(fact);
		fact.likelyCycle = likelyCycles(fact, identity);
	}
	return JSON.parse(JSON.stringify(fact)) as AwaitFact;
}

function retainRetryReferences(producers: ProducerAwaitFact[], results: OwnAwaitFact["results"]): void {
	const pending = new Set(results.filter((item) => item.status === "pending").map((item) => exactReferenceKey(item.result)));
	for (const producer of producers) if (producer.execution !== undefined) {
		producer.execution.results = producer.execution.results.filter((result) => pending.has(exactReferenceKey(result)));
		if (producer.execution.results.length === 0) delete producer.execution;
	}
}

function likelyCycles(fact: AwaitFact, identity: string): string[] {
	return fact.producers.filter((producer) => fact.results.some((item) => item.status === "pending" && item.result.sessionId === producer.sessionId) && producer.awaiting?.results.some((item) => item.status === "pending" && item.result.sessionId === identity && fact.heldInputs.includes(item.result.submissionId))).map((item) => item.sessionId);
}

/** Spend the shared byte budget on retry identity before generic dependency detail. */
function trimAwaitDetail(fact: AwaitFact): void {
	const generic = fact.producers.findLastIndex((producer) => producer.execution === undefined);
	if (generic >= 0) { fact.producers.splice(generic, 1); fact.omittedProducers++; return; }
	const detail = fact.producers.find((producer) => producer.execution !== undefined && producer.awaiting !== undefined && producer.awaiting.results.length > 0)?.awaiting;
	if (detail !== undefined) { detail.results.pop(); detail.omitted.results++; return; }
	if (fact.results.length > 1) { fact.results.pop(); fact.omitted.results++; retainRetryReferences(fact.producers, fact.results); return; }
	fact.producers.pop(); fact.omittedProducers++;
}

export async function recordProducerAwait(tx: Tx, taskId: TaskId, fact: ProducerAwaitFact): Promise<void> {
	const error = fact.execution === undefined ? undefined : safeFactText(fact.execution.error);
	fact = { ...fact, ...(fact.unavailable === undefined ? {} : { unavailable: safeFactText(fact.unavailable).text }), ...(fact.execution === undefined || error === undefined ? {} : { execution: { ...fact.execution, error: error.text, errorTruncated: fact.execution.errorTruncated || error.truncated } }) };
	const declaration = (await tx.doc(AwaitDoc)).declarations.find((item) => item.taskId === taskId && item.decision === "awaiting");
	if (declaration === undefined || !declaration.results.some((result) => result.sessionId === fact.sessionId)) return;
	const prior = declaration.producers?.find((item) => item.sessionId === fact.sessionId);
	const semantic = (item: ProducerAwaitFact) => JSON.stringify({ awaiting: item.awaiting, execution: item.execution, unavailable: item.unavailable });
	if (prior !== undefined && semantic(prior) === semantic(fact)) {
		// A repeated read still clears a newer conflicting observation of the same input.
		const supersedes = (await tx.doc(AwaitDoc)).declarations.some((other) => other.taskId !== declaration.taskId && other.decision === "awaiting" && other.conversationId === declaration.conversationId && other.runId === declaration.runId && other.producers?.some((item) => item.sessionId === fact.sessionId && item.observedAt > prior.observedAt && item.observedAt <= fact.observedAt && other.results.some((result) => result.sessionId === fact.sessionId && declaration.results.some((own) => exactReferenceKey(own) === exactReferenceKey(result)) && referenceState(item, result) !== referenceState(fact, result))));
		if (!supersedes) return;
	}
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
