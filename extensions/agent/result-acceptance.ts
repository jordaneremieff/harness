/** A native recipient reconciles retained receipt groups before source acknowledgment. */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ConversationHandle, Tx, SubmissionRecord } from "@earendil-works/pi-durable";
import { AwaitDoc, ResultConsumptionDoc, acceptResult, referenceKey, type AwaitOutcome, type AwaitState, type ResultConsumption } from "./awaited-results.ts";

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
}
function groupText(outcomes: AwaitOutcome[]): string {
	return outcomes.map((outcome) => `Agent result from ${outcome.result.sessionId}: ${outcome.answer ?? outcome.reason ?? "No assistant text."}`).join("\n\n");
}
function subsetId(requestId: string, records: ResultConsumption[]): string {
	const digest = createHash("sha256").update(records.map((item) => item.key).sort().join("\n")).digest("hex");
	return `${requestId}:reconciled:${digest}`;
}

/** A queued shared input is withdrawn as a group, then only its unconsumed subset is readmitted. */
export async function deliverAcceptedResults(api: ResultRecipient, conversationId: ConversationId, outcomes: AwaitOutcome[], requestId: string, text: string, context: Context): Promise<ResultConsumption[]> {
	let records = await Promise.all(outcomes.map((outcome) => acceptance(api, conversationId, outcome, requestId, context)));
	const first = records.find((record) => record.disposition !== "consumed" && record.disposition !== "represented");
	if (first === undefined) return records;
	const group = first.group;
	if (group !== undefined) {
		const retained: ResultConsumption[] = [];
		await api.commit(async (tx) => {
			for (const key of group) {
				const record = (await tx.doc(ResultConsumptionDoc, key, null)).record;
				if (record === null) throw new Error("The retained result group is incomplete");
				retained.push(JSON.parse(JSON.stringify(record)) as ResultConsumption);
			}
			return undefined;
		}, context);
		records = retained;
	}
	const pending = records.filter((record) => record.disposition !== "consumed" && record.disposition !== "represented");
	const recipient = await api.conversation(conversationId, context);
	if (recipient === undefined) throw new Error("The result recipient conversation is missing");
	let id = first.requestId;
	await api.commit(async (tx) => {
		for (const record of pending) {
			const current = await requiredRecord(tx, record.key);
			current.group = pending.map((item) => item.key);
		}
		return undefined;
	}, context);
	const input = await recipient.submit({ type: "input", content: pending.length === outcomes.length && first.group === undefined ? text : groupText(pending.map((item) => item.outcome)), whenBusy: "followUp", requestId: id }, context);
	let withdraw = false;
	await api.commit(async (tx) => {
		const state = await tx.doc(AwaitDoc);
		const status = await tx.submissionByRequest(conversationId, id);
		withdraw = status?.status === "queued" && pending.some((record) => state.declarations.some((item) => item.conversationId === conversationId && item.decision === "awaiting" && item.results.some((result) => referenceKey(result) === referenceKey(record.outcome.result))));
		return undefined;
	}, context);
	const status = await input.status(context);
	const withdrawn = withdraw ? await input.abort(context) === "aborted" : status.status === "unanswered" && status.reason === "aborted";
	const ordinary: ResultConsumption[] = [];
	await api.commit(async (tx) => {
		const state = await tx.doc(AwaitDoc);
		const submission = await tx.submissionByRequest(conversationId, id);
		if (submission === undefined || submission.type !== "input") throw new Error("The synthetic result group is not admitted");
		for (const record of pending) {
			const current = await reconcileMember(tx, state, conversationId, record, submission, withdrawn);
			if (current !== undefined) ordinary.push(current);
		}
		if (ordinary.length > 0) {
			id = subsetId(id, ordinary);
			for (const record of ordinary) {
				const current = await requiredRecord(tx, record.key);
				current.requestId = id;
				current.group = ordinary.map((item) => item.key);
			}
		}
		return undefined;
	}, context);
	if (ordinary.length > 0) await deliverAcceptedResults(api, conversationId, ordinary.map((item) => item.outcome), id, groupText(ordinary.map((item) => item.outcome)), context);
	return Promise.all(records.map((record) => acceptance(api, conversationId, record.outcome, requestId, context)));
}

/** Single-result observation uses the same retained group reconciliation as normal delivery. */
export async function deliverAcceptedResult(api: ResultRecipient, conversationId: ConversationId, outcome: AwaitOutcome, requestId: string, text: string, context: Context): Promise<ResultConsumption> {
	const records = await deliverAcceptedResults(api, conversationId, [outcome], requestId, text, context);
	const record = records.find((item) => referenceKey(item.outcome.result) === referenceKey(outcome.result));
	if (record === undefined) throw new Error("The result group does not contain the observed result");
	return record;
}
