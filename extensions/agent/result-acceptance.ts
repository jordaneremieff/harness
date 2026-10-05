/** A native recipient reconciles retained receipt groups before source acknowledgment. */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ConversationHandle, Tx, SubmissionRecord } from "@earendil-works/pi-durable";
import { AwaitDoc, ResultConsumptionDoc, acceptResult, ownedResultWithdrawal, referenceKey, type AwaitOutcome, type AwaitState, type ResultConsumption } from "./awaited-results.ts";

export interface ResultRecipient {
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown>;
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
}
async function acceptance(api: ResultRecipient, conversationId: ConversationId, outcome: AwaitOutcome, requestId: string, context: Context): Promise<ResultConsumption> {
	let record: ResultConsumption | undefined;
	await api.commit(async (tx) => { record = await acceptResult(tx, conversationId, outcome, requestId); return undefined; }, context);
	if (record === undefined) throw new Error("Result acceptance did not commit");
	return record;
}
async function requiredRecord(tx: Tx, key: string): Promise<ResultConsumption> {
	const record = (await tx.doc(ResultConsumptionDoc, key, null)).record;
	if (record === null) throw new Error("The retained result disposition is missing");
	return record;
}
async function reconcileMember(tx: Tx, state: AwaitState, conversationId: ConversationId, record: ResultConsumption, submission: SubmissionRecord, withdrawn: boolean): Promise<ResultConsumption | undefined> {
	const current = await requiredRecord(tx, record.key);
	const consumer = state.declarations.some((item) => item.conversationId === conversationId && item.decision === "awaiting" && item.results.some((result) => referenceKey(result) === referenceKey(record.outcome.result)));
	if (withdrawn) {
		delete current.entryId;
		if (consumer) { current.disposition = "consumed"; return; }
		current.disposition = "intent";
		delete current.submissionId;
		return JSON.parse(JSON.stringify(current)) as ResultConsumption;
	}
	current.submissionId = submission.id;
	if (submission.type === "input" && submission.entry !== undefined) current.entryId = submission.entry;
	current.disposition = submission.status === "queued" ? "ordinary" : "represented";
	if (submission.status === "unanswered" && submission.reason === "aborted" && submission.entry === undefined) current.disposition = "consumed";
}
function groupText(outcomes: AwaitOutcome[]): string {
	return outcomes.map((outcome) => `Agent result from ${outcome.result.sessionId}: ${outcome.answer ?? outcome.reason ?? "No assistant text."}`).join("\n\n");
}
function subsetId(requestId: string, records: ResultConsumption[]): string {
	const digest = createHash("sha256").update(records.map((item) => item.key).sort().join("\n")).digest("hex");
	return `${requestId}:reconciled:${digest}`;
}
function pendingRecords(records: ResultConsumption[]): ResultConsumption[] {
	return records.filter((record) => record.disposition !== "consumed" && record.disposition !== "represented");
}
async function retainedGroup(api: ResultRecipient, record: ResultConsumption, incoming: ResultConsumption[], context: Context): Promise<ResultConsumption[]> {
	const retained: ResultConsumption[] = [];
	await api.commit(async (tx) => {
		const current = await requiredRecord(tx, record.key);
		const keys = current.group ?? incoming.map((item) => item.key);
		if (keys.length > 128) throw new Error("Result reconciliation group exceeds its bound");
		for (const key of keys) {
			const member = await requiredRecord(tx, key);
			if (current.group !== undefined || member.requestId === current.requestId) retained.push(JSON.parse(JSON.stringify(member)) as ResultConsumption);
		}
		return undefined;
	}, context);
	return retained;
}
function partitionGroups(records: ResultConsumption[]): ResultConsumption[][] {
	const groups = new Map<string, ResultConsumption[]>();
	for (const record of records) { const group = groups.get(record.requestId) ?? []; group.push(record); groups.set(record.requestId, group); }
	return [...groups.values()];
}
async function separateNewMembers(api: ResultRecipient, conversationId: ConversationId, records: ResultConsumption[], context: Context): Promise<ResultConsumption[][]> {
	const first = records[0];
	if (first === undefined) return [];
	await api.commit(async (tx) => {
		if (await tx.submissionByRequest(conversationId, first.requestId) === undefined) return undefined;
		const fresh = pendingRecords(records).filter((record) => record.group === undefined);
		if (fresh.length === 0) return undefined;
		const id = subsetId(first.requestId, fresh);
		for (const record of fresh) {
			const current = await requiredRecord(tx, record.key);
			current.requestId = id; current.group = fresh.map((item) => item.key);
			record.requestId = id; record.group = [...current.group];
		}
		return undefined;
	}, context);
	return partitionGroups(records);
}
async function prepareWithdrawal(api: ResultRecipient, conversationId: ConversationId, id: string, pending: ResultConsumption[], context: Context): Promise<boolean> {
	let withdraw = false;
	await api.commit(async (tx) => {
		const state = await tx.doc(AwaitDoc);
		const status = await tx.submissionByRequest(conversationId, id);
		const consumer = state.declarations.find((item) => item.conversationId === conversationId && item.decision === "awaiting" && pending.some((record) => item.results.some((result) => referenceKey(result) === referenceKey(record.outcome.result))));
		if (status?.status === "queued" && consumer !== undefined) {
			withdraw = true;
			for (const record of pending) (await requiredRecord(tx, record.key)).withdrawal = { requestId: id, runId: consumer.runId };
		}
		return undefined;
	}, context);
	return withdraw;
}
async function reconcileGroup(api: ResultRecipient, conversationId: ConversationId, records: ResultConsumption[], text: string, context: Context): Promise<void> {
	const pending = pendingRecords(records);
	const first = pending[0];
	if (first === undefined) return;
	const recipient = await api.conversation(conversationId, context);
	if (recipient === undefined) throw new Error("The result recipient conversation is missing");
	let id = first.requestId;
	await api.commit(async (tx) => { for (const record of pending) (await requiredRecord(tx, record.key)).group = pending.map((item) => item.key); return undefined; }, context);
	const input = await recipient.submit({ type: "input", content: pending.length === records.length ? text : groupText(pending.map((item) => item.outcome)), whenBusy: "followUp", requestId: id }, context);
	if (await prepareWithdrawal(api, conversationId, id, pending, context)) {
		const disposition = await input.abort(context);
		if (disposition !== "aborted") await api.commit(async (tx) => { for (const record of pending) delete (await requiredRecord(tx, record.key)).withdrawal; return undefined; }, context);
	}
	const ordinary: ResultConsumption[] = [];
	await api.commit(async (tx) => {
		const state = await tx.doc(AwaitDoc);
		const submission = await tx.submissionByRequest(conversationId, id);
		if (submission === undefined || submission.type !== "input") throw new Error("The synthetic result group is not admitted");
		const withdrawn = await ownedResultWithdrawal(tx, await requiredRecord(tx, first.key), submission);
		for (const record of pending) {
			const current = await reconcileMember(tx, state, conversationId, record, submission, withdrawn);
			if (current !== undefined) ordinary.push(current);
		}
		if (ordinary.length > 0) {
			id = subsetId(id, ordinary);
			for (const record of ordinary) { const current = await requiredRecord(tx, record.key); current.requestId = id; current.group = ordinary.map((item) => item.key); }
		}
		return undefined;
	}, context);
	if (ordinary.length > 0) await deliverAcceptedResults(api, conversationId, ordinary.map((item) => item.outcome), id, groupText(ordinary.map((item) => item.outcome)), context);
}

type ResultBatch = { records: ResultConsumption[]; requestId: string; text: string; handled: Set<string> };
async function reconcileIncomingMember(api: ResultRecipient, conversationId: ConversationId, record: ResultConsumption, batch: ResultBatch, context: Context): Promise<void> {
	for (const retained of partitionGroups(await retainedGroup(api, record, batch.records, context))) {
		for (const group of await separateNewMembers(api, conversationId, retained, context)) {
			const first = group[0];
			if (first === undefined || batch.handled.has(first.requestId)) continue;
			batch.handled.add(first.requestId);
			const text = group.length === batch.records.length && first.requestId === batch.requestId ? batch.text : groupText(group.map((item) => item.outcome));
			await reconcileGroup(api, conversationId, group, text, context);
		}
	}
}

/** Reconcile every incoming member and each owned group before acknowledging any source receipt. */
export async function deliverAcceptedResults(api: ResultRecipient, conversationId: ConversationId, outcomes: AwaitOutcome[], requestId: string, text: string, context: Context): Promise<ResultConsumption[]> {
	const records = await Promise.all(outcomes.map((outcome) => acceptance(api, conversationId, outcome, requestId, context)));
	const batch: ResultBatch = { records, requestId, text, handled: new Set() };
	for (const record of records) await reconcileIncomingMember(api, conversationId, record, batch, context);
	const dispositions = await Promise.all(records.map((record) => acceptance(api, conversationId, record.outcome, requestId, context)));
	if (dispositions.some((record) => record.disposition === "intent")) throw new Error("Result reconciliation has no final disposition for every incoming member");
	return dispositions;
}

/** Single-result observation uses the same retained group reconciliation as normal delivery. */
export async function deliverAcceptedResult(api: ResultRecipient, conversationId: ConversationId, outcome: AwaitOutcome, requestId: string, text: string, context: Context): Promise<ResultConsumption> {
	const records = await deliverAcceptedResults(api, conversationId, [outcome], requestId, text, context);
	const record = records.find((item) => referenceKey(item.outcome.result) === referenceKey(outcome.result));
	if (record === undefined) throw new Error("The result group does not contain the observed result");
	return record;
}
