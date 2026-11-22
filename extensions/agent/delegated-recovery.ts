/** Prospective recovery links for child requests sent by one attributable routed input. */
import {
	defineDoc,
	LiveDoc,
	type Tx,
	type ConversationId,
	type SubmissionId,
	type TaskId,
	type EntryId,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { isStopped } from "./conversation-stop.ts";
import { RequestContextDoc } from "./request-context.ts";
import {
	OpenWorkDoc,
	OPEN_WORK_LIMIT,
	WORK_DEPENDENCY_LIMIT,
	type WorkRoute,
	finalReportRequestId,
	markedState,
	type OpenWorkItem,
} from "./open-work.ts";
import { retainedReportRequest, storeDeliveryRow, retainedReceipt } from "./delivery-store.ts";
import type { ResultReference } from "./result-schema.ts";

type Binding = WorkRoute & { entry: number; self: string };
type Edge = { key: string; parent: Binding; target?: string; childRequest?: string; result?: ResultReference };
const Edges = defineDoc<{ edges: Edge[] }>({
	kind: "agent.provisional-delegations",
	scope: "conversation",
	version: 1,
	history: "latest",
	fork: "initial",
	initial: () => ({ edges: [] }),
	checkpointWhen: () => false,
});

/** No owner inference: an exact single live input, its route and its executing tool all have to agree. */
export async function dispatchParent(
	tx: Tx,
	id: ConversationId,
	tool: TaskId,
	self: string,
): Promise<Binding | undefined> {
	const run = (await tx.doc(LiveDoc, id)).run;
	if (run?.inputs.length !== 1) return undefined;
	const task = await tx.task(tool);
	if (!task || task.owner !== run.taskId || task.abortRequested || (await isStopped(tx, id))) return undefined;
	const input = await tx.submission(run.inputs[0]);
	if (input?.type !== "input" || input.status !== "placed") return undefined;
	const route = (await tx.doc(RequestContextDoc, id)).requests.find((r) => r.requestId === input.requestId);
	if (!route || (await tx.doc(OpenWorkDoc, id)).items.some((item) => item.requestId === route.requestId))
		return undefined;
	return { ...route, submissionId: input.id, entry: input.entry, self };
}
export async function bindDispatch(
	tx: Tx,
	id: ConversationId,
	key: string,
	parent: Binding | undefined,
	target?: string,
	childRequest?: string,
) {
	if (!parent || target === parent.self) return;
	const { edges } = await tx.doc(Edges, id);
	if (edges.some((e) => e.key === key)) return;
	if (
		edges.length >= 128 ||
		edges.filter((e) => e.parent.submissionId === parent.submissionId).length >= WORK_DEPENDENCY_LIMIT
	)
		return;
	edges.push({ key, parent, ...(target ? { target } : {}), ...(childRequest ? { childRequest } : {}) });
}
export async function confirmDispatch(tx: Tx, id: ConversationId, key: string, result: ResultReference) {
	const edge = (await tx.doc(Edges, id)).edges.find((e) => e.key === key);
	if (
		!edge ||
		result.sessionId === edge.parent.self ||
		!result.requestId ||
		(edge.target && edge.target !== result.sessionId) ||
		(edge.childRequest && edge.childRequest !== result.requestId)
	)
		return;
	if (
		edge.result &&
		(edge.result.submissionId !== result.submissionId ||
			edge.result.sessionId !== result.sessionId ||
			edge.result.requestId !== result.requestId)
	)
		throw new Error("Conflicting child admission for a retained dispatch");
	edge.result = { sessionId: result.sessionId, submissionId: result.submissionId, requestId: result.requestId };
}
export async function discardDispatches(tx: Tx, id: ConversationId, scope?: { before: EntryId } | { request: string }) {
	if (!scope) {
		await tx.retireDoc(Edges, id);
		return;
	}
	const state = await tx.doc(Edges, id);
	if (!state.edges.length) return;
	state.edges = state.edges.filter((e) =>
		"before" in scope ? e.parent.entry >= scope.before : e.parent.requestId !== scope.request,
	);
}
/** Materialise confirmed edges before the unanswered receipt. Unknown admissions stay provisional until exact evidence arrives. */
export async function recoverFailedDelegations(tx: Tx, input: SubmissionRecord, now: number) {
	if (input.type !== "input" || !input.requestId) return;
	const id = input.conversationId,
		state = await tx.doc(Edges, id),
		edges = state.edges.filter((e) => e.parent.submissionId === input.id && e.parent.requestId === input.requestId);
	if (!edges.length) return;
	if (input.status === "done" || (input.status === "unanswered" && input.reason !== "model_error")) {
		await discardDispatches(tx, id, { request: input.requestId });
		return;
	}
	if (input.status !== "unanswered") return;
	const parent = edges[0].parent;
	if (await retainedReportRequest(tx, parent.replyTo, finalReportRequestId(id, parent.requestId))) {
		await discardDispatches(tx, id, { request: parent.requestId });
		return;
	}
	const results = edges.flatMap((e) => (e.result ? [{ ...e.result }] : []));
	if (!results.length) {
		await discardDispatches(tx, id, { request: parent.requestId });
		return;
	}
	return materialiseRecovery(tx, id, parent, results, now);
}
async function materialiseRecovery(
	tx: Tx,
	id: ConversationId,
	parent: Binding,
	results: ResultReference[],
	now: number,
) {
	const work = await tx.doc(OpenWorkDoc, id);
	const prior = work.items.find((item) => item.submissionId === parent.submissionId);
	const allowed = prior
		? prior.recovered && !prior.close
		: work.items.filter((item) => !item.close).length < OPEN_WORK_LIMIT &&
			!(await retainedReceipt(tx, parent.submissionId));
	if (!allowed) {
		await discardDispatches(tx, id, { request: parent.requestId });
		return;
	}
	const { requestId, requester, replyTo, origin, submissionId, self } = parent;
	const route = { requestId, requester, replyTo, origin, submissionId };
	const item: OpenWorkItem = prior ?? {
		...route,
		results: [],
		recovered: true,
		note: "After the child results arrive, synthesise the result and use agent_work complete for this request.",
		declaredAt: now,
		updatedAt: now,
	};
	for (const result of results)
		if (!item.results.some((r) => r.sessionId === result.sessionId && r.submissionId === result.submissionId))
			item.results.push(result);
	if (!prior) work.items.push(item);
	const state = await tx.doc(Edges, id);
	state.edges = state.edges.filter((e) => e.parent.submissionId !== parent.submissionId || !e.result);
	if (!prior && results.some((r) => markedState(work.arrivals ?? [], r) === "arrived"))
		await noticeEarlyResult(tx, id, self, item, now);
	return true as const;
}
/** An unconfirmed foreign send binds only to the same target and stable child request, never to creation ownership. */
export async function receivedDelegations(
	tx: Tx,
	id: ConversationId,
	results: readonly ResultReference[],
	now: number,
): Promise<string[]> {
	const state = await tx.doc(Edges, id);
	for (const edge of state.edges.map((e) => ({ ...e, parent: { ...e.parent } }))) {
		const matched = results.find(
			(r) => r.requestId !== undefined && r.sessionId === edge.target && r.requestId === edge.childRequest,
		);
		if (!matched) continue;
		await confirmDispatch(tx, id, edge.key, matched);
		// Only receipt settlement opens new recovery work. Later evidence may extend that open item.
		if (
			(await tx.doc(OpenWorkDoc, id)).items.some(
				(item) => item.recovered && !item.close && item.submissionId === edge.parent.submissionId,
			)
		) {
			const parent = await tx.submission(edge.parent.submissionId as SubmissionId);
			if (parent) await recoverFailedDelegations(tx, parent, now);
		}
	}
	return recoveryRecipients((await tx.doc(OpenWorkDoc, id)).items, results);
}
export function recoveryRecipients(items: readonly OpenWorkItem[], results: readonly ResultReference[]): string[] {
	return items
		.filter(
			(item) =>
				item.recovered &&
				!item.close &&
				item.results.some((expected) =>
					results.some(
						(r) =>
							r.sessionId === expected.sessionId &&
							r.submissionId === expected.submissionId &&
							r.requestId === expected.requestId,
					),
				),
		)
		.map((item) => item.requestId);
}

/** A delivery consumed by the failed generation has no future result wake. */
export async function noticeEarlyResult(tx: Tx, id: ConversationId, self: string, item: OpenWorkItem, now: number) {
	const key = `delegation-recovery:${item.submissionId}`;
	if (await retainedReportRequest(tx, self, key)) return;
	await storeDeliveryRow(
		tx,
		"report",
		{
			sourceId: `report:${key}`,
			requestId: key,
			ownerId: self,
			senderIdentity: self,
			replyTo: null,
			message: recoveryHint([item.requestId]),
			createdAt: now,
			acknowledged: false,
			recoveryWork: { conversationId: id, requestId: item.requestId },
		},
		true,
	);
}
export function recoveryHint(requests: readonly string[]) {
	return `Recovered work for ${JSON.stringify(requests)}: read agent_status for the exact child results. Synthesise each original request's result and use agent_work complete. Child results do not go directly to the original requester.`;
}
