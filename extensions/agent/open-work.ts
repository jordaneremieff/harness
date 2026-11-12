/**
 * Declared background work of a request, and the explicit report that completes it.
 *
 * A run that leaves work for later declares it with `continue` and ends with a state note; the native
 * input settles `done` while the item stays open. An item names the results it depends on, or none.
 * Only `complete` closes an item, in the commit that retains one final report for the request's reply
 * recipient. Arrived dependencies and settled inputs never close an item, and nothing is scheduled
 * for an item: it stays in status and in check-ins until then.
 *
 * A dependency whose producer is in this storage is read from that producer's committed facts. For a
 * producer of another storage the producer's host sends a typed mark with each receipt and final report,
 * and the admitting host retains it here (`recordDependencyMarks`).
 *
 * Every function that takes a transaction reads submissions, except `recordDependencyMarks`. A
 * transaction refuses table reads after its first table write, so call these before an entry, submission
 * or task write of the same commit, or in a commit of their own. Their own writes are documents and
 * delivery rows only.
 */
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, LiveDoc, type ConversationId, type Harness, type SubmissionId, type SubmissionRecord, type ToolExecutionResult, type Tx } from "@earendil-works/pi-durable";
import { DeliveryRowDoc, reportKey, retainedReportRequest, storeDeliveryRow } from "./delivery-store.ts";
import { recordReportInTransaction, type DeliveryReceipt, type DeliveryReport } from "./durable-controls.ts";
import { canonicalIdentity } from "./native-identity.ts";
import { RequestContextDoc, type RequestContext } from "./request-context.ts";
import { DEPENDENCY_MARK_LIMIT, WORK_DEPENDENCY_LIMIT, parseAgentWorkInput, type AgentWorkInput, type DependencyMark, type FinalReportDelivery, type FinalReportRead, type OpenWorkDependencyView, type OpenWorkDetails, type OpenWorkView } from "./open-work-schema.ts";
import type { ResultReference } from "./result-schema.ts";

export * from "./open-work-schema.ts";

/** New declarations refuse at this bound; retained open items never do. */
export const OPEN_WORK_LIMIT = 32;
/** Closed items kept for repeated `complete` calls and status reads; the newest stay. */
export const CLOSED_WORK_LIMIT = 16;
const CLOSE_EXCERPT_CHARS = 600;

export type WorkCloseStatus = "done" | "failed" | "stopped" | "reset";
export type OpenWorkClose = { status: WorkCloseStatus; at: number; message: string; reportRequestId: string };
/** The route is the request's own, copied while its input was placed; later routes never replace it. */
export type OpenWorkItem = {
	requestId: string;
	submissionId: number;
	requester: string;
	replyTo: string;
	origin: "operator" | "model";
	results: ResultReference[];
	note: string;
	declaredAt: number;
	updatedAt: number;
	close?: OpenWorkClose;
};
/** `arrivals` holds the marks of admitted deliveries; a dependency of another storage reads its state there. */
export type OpenWorkState = { items: OpenWorkItem[]; arrivals?: DependencyMark[] };

/** A fork starts without items: declared work stays with the conversation that owes its final report. */
export const OpenWorkDoc = defineDoc<OpenWorkState>({
	kind: "agent.open-work",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
	checkpointWhen: () => false,
});

// ─── Rules over the document ────────────────────────────────────────────────

type Rejection = { readonly error: string };
export type InputStatus = SubmissionRecord["status"];

function excerpt(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let end = limit - 1;
	if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
	return `${text.slice(0, end)}…`;
}

function isOpen(item: OpenWorkItem): boolean {
	return item.close === undefined;
}

export function dependencyKey(reference: Pick<ResultReference, "sessionId" | "submissionId">): string {
	return JSON.stringify([reference.sessionId, reference.submissionId]);
}

export function finalReportRequestId(conversationId: number, requestId: string): string {
	return `work-final:${conversationId}:${requestId}`;
}

const FINAL_REPORT_ID = /^work-final:([1-9][0-9]*):(.+)$/su;

/** Conversation of an identity in this storage; undefined for another storage. */
function localConversation(storageId: string, sessionId: string): ConversationId | undefined {
	if (sessionId === storageId) return 1 as ConversationId;
	if (!sessionId.startsWith(`${storageId}:`)) return undefined;
	const rest = sessionId.slice(storageId.length + 1);
	const parsed = /^[0-9]+$/u.test(rest) ? Number(rest) : 0;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed as ConversationId : undefined;
}

/**
 * True for a final work report whose reply recipient is the conversation that declared the work, as for an
 * operator request whose answer stays in its target conversation. Such a report is retained for reading
 * and is never admitted as an input: an input would start a run of the conversation that just completed,
 * was stopped, or was reset.
 */
export function finalReportToItself(storageId: string, report: Pick<DeliveryReport, "requestId" | "ownerId">): boolean {
	const match = FINAL_REPORT_ID.exec(report.requestId);
	return match !== null && localConversation(storageId, report.ownerId) === Number(match[1]);
}

export function finalReportLabel(status: WorkCloseStatus, requestId: string): string {
	return `Final work result (${status}) for request ${requestId}`;
}

const CLOSE_STATUSES: readonly WorkCloseStatus[] = ["done", "failed", "stopped", "reset"];

/** Status of a retained final report, read from the label line that the host writes before its text. */
function labelledStatus(message: string, requestId: string): WorkCloseStatus | undefined {
	return CLOSE_STATUSES.find((status) => message.startsWith(`${finalReportLabel(status, requestId)}\n\n`));
}

/** The call that reads the final report of the request whose input is `submissionId`, from `offset`. */
export function finalReportRead(sessionId: string, submissionId: number, offset = 0): FinalReportRead {
	return { tool: "agent_inspect", view: "result", sessionId, submissionId, finalReport: true, offset };
}

/** Receipt label of an input whose answer is not the result of its request. */
export function stateNoteLabel(work: "open" | "closed", status?: WorkCloseStatus): string {
	return work === "open"
		? "State note, not a final result: work continues in background"
		: `State note, not a final result: the final work result${status === undefined ? "" : ` (${status})`} is a separate report`;
}

/**
 * An open item whose input ended `unanswered` is void: its declaring run ended without the state note,
 * and the unanswered receipt already tells the requester. A closed item stays; its report is retained.
 */
export function withoutVoidItems(items: readonly OpenWorkItem[], statusOf: (item: OpenWorkItem) => InputStatus | undefined): OpenWorkItem[] {
	return items.filter((item) => !isOpen(item) || statusOf(item) !== "unanswered");
}

/** Every open item stays; the newest closed items stay up to the bound. */
export function boundClosedItems(items: readonly OpenWorkItem[]): OpenWorkItem[] {
	const closed = items.filter((item) => !isOpen(item)).sort((left, right) => (right.close?.at ?? 0) - (left.close?.at ?? 0)).slice(0, CLOSED_WORK_LIMIT);
	return items.filter((item) => isOpen(item) || closed.includes(item));
}

export type WorkRoute = Pick<RequestContext, "requestId" | "requester" | "replyTo" | "origin"> & { readonly submissionId: number };
export type ContinueWork = {
	readonly requestId: string;
	/** The request's retained route and input; present only while that input is placed. */
	readonly route?: WorkRoute;
	/** No result is open work with no producer dependency. */
	readonly results: readonly ResultReference[];
	readonly note: string;
	/** External identity of the declaring conversation. */
	readonly self: string;
	readonly now: number;
};
export type ContinueOutcome = { readonly items: OpenWorkItem[]; readonly item: OpenWorkItem; readonly change: "declared" | "replaced" };

function copyReference(reference: ResultReference): ResultReference {
	return { sessionId: reference.sessionId, submissionId: reference.submissionId, ...(reference.requestId === undefined ? {} : { requestId: reference.requestId }) };
}

function dependencyProblem(input: ContinueWork, submissionId: number | undefined): string | undefined {
	if (input.results.length > WORK_DEPENDENCY_LIMIT) return `Declared work names at most ${WORK_DEPENDENCY_LIMIT} results`;
	const keys = new Set(input.results.map(dependencyKey));
	if (keys.size !== input.results.length) return "Each result is named once";
	if (submissionId !== undefined && keys.has(dependencyKey({ sessionId: input.self, submissionId }))) return "Declared work cannot depend on its own input";
	return undefined;
}

/** Declare one item, or replace the dependencies and note of an open one. `items` holds no void item. */
export function continueWork(items: readonly OpenWorkItem[], input: ContinueWork): ContinueOutcome | Rejection {
	const prior = items.find((item) => item.requestId === input.requestId);
	if (prior?.close !== undefined) return { error: `Request ${input.requestId} has closed declared work (${prior.close.status}); closed work does not reopen` };
	const problem = dependencyProblem(input, prior?.submissionId ?? input.route?.submissionId);
	if (problem !== undefined) return { error: problem };
	const results = input.results.map(copyReference);
	if (prior !== undefined) {
		const item: OpenWorkItem = { ...prior, results, note: input.note, updatedAt: input.now };
		return { items: items.map((candidate) => candidate === prior ? item : candidate), item, change: "replaced" };
	}
	if (input.route === undefined) return { error: `Request ${input.requestId} is not a placed input of this conversation with a retained route; declared work needs the route of the request it serves` };
	if (items.filter(isOpen).length >= OPEN_WORK_LIMIT) return { error: `The conversation already has ${OPEN_WORK_LIMIT} open work items; complete one first` };
	const { requestId, submissionId, requester, replyTo, origin } = input.route;
	const item: OpenWorkItem = { requestId, submissionId, requester, replyTo, origin, results, note: input.note, declaredAt: input.now, updatedAt: input.now };
	return { items: [...items, item], item, change: "declared" };
}

export type CompleteWork = { readonly requestId: string; readonly status: WorkCloseStatus; readonly message: string; readonly conversationId: number; readonly now: number };
export type CompleteOutcome = { readonly items: OpenWorkItem[]; readonly item: OpenWorkItem; readonly deduped: boolean };

function closedItem(item: OpenWorkItem, status: WorkCloseStatus, message: string, conversationId: number, now: number): OpenWorkItem {
	return { ...item, updatedAt: now, close: { status, at: now, message: excerpt(message, CLOSE_EXCERPT_CHARS), reportRequestId: finalReportRequestId(conversationId, item.requestId) } };
}

/** Close one item. A closed item returns its retained close unchanged, whatever the new status says. */
export function completeWork(items: readonly OpenWorkItem[], input: CompleteWork): CompleteOutcome | Rejection {
	const prior = items.find((item) => item.requestId === input.requestId);
	if (prior === undefined) return { error: `Request ${input.requestId} has no retained work item, for one of two reasons. Either no work was declared for this request: such a request completes with the answer of its run. Or its item closed earlier than the last ${CLOSED_WORK_LIMIT} closed items that the conversation keeps: its final report was sent then. This call changed nothing and sent no report` };
	if (prior.close !== undefined) return { items: [...items], item: prior, deduped: true };
	const item = closedItem(prior, input.status, input.message, input.conversationId, input.now);
	return { items: boundClosedItems(items.map((candidate) => candidate === prior ? item : candidate)), item, deduped: false };
}

const HOST_CLOSE_TEXT: Record<"stopped" | "reset", string> = {
	stopped: "The conversation was stopped before it reported a final result for this declared work.",
	reset: "The context of the conversation was reset before it reported a final result for this declared work.",
};

/** Fixed text of a final report that the host writes; it names the dependencies and stops none. */
export function hostCloseMessage(item: OpenWorkItem, reason: "stopped" | "reset"): string {
	const lines = [HOST_CLOSE_TEXT[reason], "No producer was stopped."];
	if (item.results.length > 0) lines.push("Each dependency stays readable with agent_inspect view: result:", ...item.results.map((reference) => `- ${reference.sessionId}, submission ${reference.submissionId}`));
	return lines.join("\n");
}

/** Close every open item, or the open items of the named requests, with the host's fixed text. */
export function closeWork(items: readonly OpenWorkItem[], input: { readonly reason: "stopped" | "reset"; readonly conversationId: number; readonly now: number; readonly requestIds?: readonly string[] }): { items: OpenWorkItem[]; closed: OpenWorkItem[] } {
	const closed: OpenWorkItem[] = [];
	const next = items.map((item) => {
		if (!isOpen(item) || (input.requestIds !== undefined && !input.requestIds.includes(item.requestId))) return item;
		const done = closedItem(item, input.reason, hostCloseMessage(item, input.reason), input.conversationId, input.now);
		closed.push(done);
		return done;
	});
	return { items: boundClosedItems(next), closed };
}

/** `unavailable` marks a fact that was not read from the producer's committed state. */
export type DependencyFact = { readonly input: "pending" | "settled"; readonly work: "none" | "open" | "closed"; readonly unavailable?: string };

/** A settled input whose conversation keeps its work open delivered a state note, not the result. */
export function dependencyState(fact: DependencyFact): "open" | "state-note" | "arrived" {
	if (fact.input === "pending") return "open";
	return fact.work === "open" ? "state-note" : "arrived";
}

function markMatches(reference: ResultReference, mark: DependencyMark): boolean {
	return reference.sessionId === mark.sessionId && reference.submissionId === mark.submissionId && (reference.requestId === undefined || reference.requestId === mark.requestId);
}

/** State that admitted deliveries established for one dependency; undefined without a matching mark. */
export function markedState(arrivals: readonly DependencyMark[], reference: ResultReference): DependencyMark["state"] | undefined {
	const matches = arrivals.filter((mark) => markMatches(reference, mark));
	if (matches.length === 0) return undefined;
	return matches.some((mark) => mark.state === "arrived") ? "arrived" : "state-note";
}

/**
 * Retained marks after one delivery. A mark only rises: a state note never replaces an arrived result.
 * A mark that a retained item names always stays; of the others, which a later declaration can still
 * name, the newest stay up to the bound.
 */
export function withDependencyMarks(arrivals: readonly DependencyMark[], marks: readonly DependencyMark[], items: readonly OpenWorkItem[]): DependencyMark[] {
	const next = arrivals.map((mark) => ({ ...mark }));
	for (const mark of marks) {
		const prior = next.find((candidate) => candidate.sessionId === mark.sessionId && candidate.submissionId === mark.submissionId && candidate.requestId === mark.requestId);
		if (prior === undefined) next.push({ ...mark });
		else if (mark.state === "arrived") prior.state = "arrived";
	}
	const named = (mark: DependencyMark): boolean => items.some((item) => item.results.some((reference) => markMatches(reference, mark)));
	let spare = next.filter((mark) => !named(mark)).length - DEPENDENCY_MARK_LIMIT;
	return next.filter((mark) => named(mark) || spare-- <= 0);
}

export function reportDelivery(report: Pick<DeliveryReport, "acknowledged" | "delivery" | "fallbackRecipients"> | undefined): FinalReportDelivery {
	if (report === undefined) return "absent";
	if (report.acknowledged) return "delivered";
	if (report.delivery !== undefined) return report.delivery.state;
	return (report.fallbackRecipients?.length ?? 0) > 0 ? "fallback" : "active";
}

// ─── Committed reads ────────────────────────────────────────────────────────

/**
 * A transaction, or snapshot reads of a Harness. A transaction read creates the conversation's document
 * when it is absent, which is a committed change; a read that must commit nothing, such as a status
 * read, uses the snapshot reader.
 */
export type SnapshotReader = { readonly harness: Harness; readonly context: Context };
export type OpenWorkReader = Tx | SnapshotReader;

function isTx(reader: OpenWorkReader): reader is Tx {
	return !("harness" in reader);
}

async function readItems(reader: OpenWorkReader, conversationId: ConversationId): Promise<readonly OpenWorkItem[]> {
	if (isTx(reader)) return await reader.conversation(conversationId) === undefined ? [] : (await reader.doc(OpenWorkDoc, conversationId)).items;
	return (await reader.harness.snapshot(OpenWorkDoc, conversationId, reader.context))?.items ?? [];
}

async function readArrivals(reader: OpenWorkReader, conversationId: ConversationId): Promise<readonly DependencyMark[]> {
	if (isTx(reader)) return await reader.conversation(conversationId) === undefined ? [] : (await reader.doc(OpenWorkDoc, conversationId)).arrivals ?? [];
	return (await reader.harness.snapshot(OpenWorkDoc, conversationId, reader.context))?.arrivals ?? [];
}

/** The retained row of a final report; the snapshot reader finds it by its key and creates nothing. */
async function readFinalReport(reader: OpenWorkReader, ownerId: string, reportRequestId: string): Promise<DeliveryReport | undefined> {
	if (isTx(reader)) return retainedReportRequest(reader, ownerId, reportRequestId);
	const row = await reader.harness.snapshot(DeliveryRowDoc, reportKey(ownerId, `report:${reportRequestId}`), reader.context);
	return row?.value == null ? undefined : row.value as DeliveryReport;
}

async function readSubmission(reader: OpenWorkReader, id: number): Promise<SubmissionRecord | undefined> {
	if (isTx(reader)) return reader.submission(id as SubmissionId);
	return (await reader.harness.submission(id as SubmissionId, reader.context))?.status(reader.context);
}

async function inputStatuses(reader: OpenWorkReader, items: readonly OpenWorkItem[]): Promise<Map<number, InputStatus>> {
	const statuses = new Map<number, InputStatus>();
	for (const item of items) {
		if (!isOpen(item)) continue;
		const record = await readSubmission(reader, item.submissionId);
		if (record !== undefined) statuses.set(item.submissionId, record.status);
	}
	return statuses;
}

/** Retained items without the void ones; the document itself is not changed. */
async function currentItems(reader: OpenWorkReader, conversationId: ConversationId): Promise<OpenWorkItem[]> {
	const items = await readItems(reader, conversationId);
	if (items.length === 0) return [];
	const statuses = await inputStatuses(reader, items);
	return withoutVoidItems(items, (item) => statuses.get(item.submissionId));
}

/** Open items of a conversation, each with the route of its request. */
export async function openWorkItems(reader: OpenWorkReader, conversationId: ConversationId): Promise<OpenWorkItem[]> {
	return (await currentItems(reader, conversationId)).filter(isOpen);
}

/** True while a request's declared work is open; a check-in of that request continues until then. */
export async function requestHasOpenWork(reader: OpenWorkReader, conversationId: ConversationId, requestId: string): Promise<boolean> {
	return (await openWorkItems(reader, conversationId)).some((item) => item.requestId === requestId);
}

/** `work` of a settled input and its receipt label; undefined for a request without declared work. */
export async function receiptWork(reader: OpenWorkReader, conversationId: ConversationId, requestId: string): Promise<{ work: "open" | "closed"; label: string } | undefined> {
	const item = (await currentItems(reader, conversationId)).find((candidate) => candidate.requestId === requestId);
	if (item === undefined) return undefined;
	return item.close === undefined ? { work: "open", label: stateNoteLabel("open") } : { work: "closed", label: stateNoteLabel("closed", item.close.status) };
}

async function localInput(reader: OpenWorkReader, conversationId: ConversationId, reference: ResultReference): Promise<Extract<SubmissionRecord, { type: "input" }> | string> {
	const record = await readSubmission(reader, reference.submissionId);
	if (record === undefined || record.type !== "input" || record.conversationId !== conversationId) return `Result ${reference.sessionId} submission ${reference.submissionId} is not an admitted input of that conversation`;
	if (reference.requestId !== undefined && record.requestId !== reference.requestId) return `Result ${reference.sessionId} submission ${reference.submissionId} has another request ID`;
	return record;
}

/**
 * Committed fact of one dependency whose producer is in this storage; undefined for another storage.
 * A producer host evaluates it for its own references.
 */
export async function dependencyFact(reader: OpenWorkReader, storageId: string, reference: ResultReference): Promise<DependencyFact | undefined> {
	const conversationId = localConversation(storageId, reference.sessionId);
	if (conversationId === undefined) return undefined;
	const record = await localInput(reader, conversationId, reference);
	if (typeof record === "string") return { input: "pending", work: "none", unavailable: record };
	if (record.status !== "done" && record.status !== "unanswered") return { input: "pending", work: "none" };
	const work = record.status === "unanswered" || record.requestId === undefined ? undefined : (await readItems(reader, conversationId)).find((item) => item.requestId === record.requestId);
	return { input: "settled", work: work === undefined ? "none" : work.close === undefined ? "open" : "closed" };
}

const NO_ADMITTED_RESULT = "the producer is in another storage and no result of this dependency was admitted into this conversation; read it with the inspect call";

/** Marks of the declaring conversation, and facts that a caller read from producers of other storages. */
type DependencyEvidence = { readonly arrivals: readonly DependencyMark[]; readonly facts?: ReadonlyMap<string, DependencyFact> };

/**
 * A producer of this storage is read from its committed facts. A producer of another storage reads from a
 * caller's fact, else from the marks of the deliveries that this conversation admitted.
 */
async function dependencyViews(reader: OpenWorkReader, storageId: string, item: OpenWorkItem, evidence: DependencyEvidence): Promise<OpenWorkDependencyView[]> {
	const views: OpenWorkDependencyView[] = [];
	for (const reference of item.results) {
		const fact = await dependencyFact(reader, storageId, reference) ?? evidence.facts?.get(dependencyKey(reference));
		const marked = fact === undefined ? markedState(evidence.arrivals, reference) : undefined;
		const unavailable = fact === undefined ? marked === undefined ? NO_ADMITTED_RESULT : undefined : fact.unavailable;
		views.push({
			...copyReference(reference),
			state: fact === undefined ? marked ?? "open" : dependencyState(fact),
			...(unavailable === undefined ? {} : { unavailable }),
			inspect: { tool: "agent_inspect", view: "result", sessionId: reference.sessionId, submissionId: reference.submissionId },
		});
	}
	return views;
}

function finalReportDelivery(storageId: string, ownerId: string, reportRequestId: string, report: DeliveryReport | undefined): FinalReportDelivery {
	return finalReportToItself(storageId, { requestId: reportRequestId, ownerId }) ? "retained" : reportDelivery(report);
}

async function itemView(reader: OpenWorkReader, storageId: string, conversationId: ConversationId, item: OpenWorkItem, state: OpenWorkView["state"], evidence: DependencyEvidence): Promise<OpenWorkView> {
	const { requestId, submissionId, requester, replyTo, origin, note, declaredAt, updatedAt, close } = item;
	const delivery = close === undefined ? undefined : finalReportDelivery(storageId, replyTo, close.reportRequestId, await readFinalReport(reader, replyTo, close.reportRequestId));
	return {
		requestId, submissionId, requester, replyTo, origin, note, state, declaredAt, updatedAt,
		...(close === undefined ? {} : { close: { status: close.status, message: close.message, at: close.at, reportRequestId: close.reportRequestId, ...(delivery === undefined ? {} : { delivery }), read: finalReportRead(canonicalIdentity(storageId, conversationId), submissionId) } }),
		dependencies: await dependencyViews(reader, storageId, item, evidence),
	};
}

/** Identity, delivery state and read call of the final report of one request. */
export type FinalReportFact = {
	readonly requestId: string;
	readonly ownerId: string;
	readonly status?: WorkCloseStatus;
	readonly delivery: FinalReportDelivery;
	readonly read: FinalReportRead;
};
/**
 * Declared work of one request. `open`: the settled answer is a state note and no final report exists yet.
 * `closed`: the settled answer is a state note and `finalReport` names the separate final report.
 */
export type RequestWork =
	| { readonly work: "open"; readonly label: string }
	| { readonly work: "closed"; readonly label: string; readonly finalReport: FinalReportFact; readonly report?: DeliveryReport };

/**
 * Declared work of one request; undefined for a request that declared none, whose answer is its result.
 * The retained item answers first. A closed item can leave the bounded work document, but its final
 * report row stays at its fixed key, so that row answers after the item is gone: the bound of the
 * document never changes what a settled answer was. `ownerId` is the reply recipient of the request's
 * retained receipt, which admission keeps equal to the route's reply recipient; the conversation's own
 * identity covers a report retained for itself. It takes the snapshot reader only: a transaction read
 * would create the absent rows that it probes.
 */
export async function requestWork(reader: SnapshotReader, storageId: string, conversationId: ConversationId, input: { readonly requestId: string; readonly submissionId: number; readonly ownerId?: string }): Promise<RequestWork | undefined> {
	const self = canonicalIdentity(storageId, conversationId);
	const reportRequestId = finalReportRequestId(conversationId, input.requestId);
	const item = (await currentItems(reader, conversationId)).find((candidate) => candidate.requestId === input.requestId);
	if (item !== undefined && item.close === undefined) return { work: "open", label: stateNoteLabel("open") };
	const closed = (ownerId: string, status: WorkCloseStatus | undefined, report: DeliveryReport | undefined): RequestWork => ({
		work: "closed",
		label: stateNoteLabel("closed", status),
		finalReport: { requestId: reportRequestId, ownerId, ...(status === undefined ? {} : { status }), delivery: finalReportDelivery(storageId, ownerId, reportRequestId, report), read: finalReportRead(self, item?.submissionId ?? input.submissionId) },
		...(report === undefined ? {} : { report }),
	});
	if (item?.close !== undefined) return closed(item.replyTo, item.close.status, await readFinalReport(reader, item.replyTo, reportRequestId));
	for (const ownerId of new Set([input.ownerId ?? self, self])) {
		const report = await readFinalReport(reader, ownerId, reportRequestId);
		if (report !== undefined && report.senderIdentity === self) return closed(ownerId, labelledStatus(report.message, input.requestId), report);
	}
	return undefined;
}

/** References of open items whose producer is in another storage; their facts come from that storage's host. */
export async function remoteDependencies(reader: OpenWorkReader, storageId: string, conversationId: ConversationId): Promise<ResultReference[]> {
	const remote = new Map<string, ResultReference>();
	for (const item of await openWorkItems(reader, conversationId)) {
		for (const reference of item.results) if (localConversation(storageId, reference.sessionId) === undefined) remote.set(dependencyKey(reference), copyReference(reference));
	}
	return [...remote.values()];
}

/**
 * Status read: every retained item with its route, note, state, final-report delivery state and
 * dependency states. Committed facts only; it never waits. A dependency of another storage reads the
 * mark of the delivery that this conversation admitted: `state-note` for a labelled state note, `arrived`
 * for an ordinary result or an explicit final report, and `open` with `unavailable` without one.
 * `facts`, keyed by `dependencyKey`, takes precedence when a caller read the producer's storage.
 */
export async function openWorkStatus(reader: OpenWorkReader, storageId: string, conversationId: ConversationId, facts?: ReadonlyMap<string, DependencyFact>): Promise<OpenWorkView[]> {
	const views: OpenWorkView[] = [];
	const evidence = { arrivals: await readArrivals(reader, conversationId), ...(facts === undefined ? {} : { facts }) };
	for (const item of await currentItems(reader, conversationId)) views.push(await itemView(reader, storageId, conversationId, item, isOpen(item) ? "open" : "closed", evidence));
	return views;
}

/** Lines for the check-in of a request with open declared work; empty without an open item. */
export async function openWorkCheckInLines(reader: OpenWorkReader, storageId: string, conversationId: ConversationId, requestId: string): Promise<string[]> {
	const item = (await openWorkItems(reader, conversationId)).find((candidate) => candidate.requestId === requestId);
	if (item === undefined) return [];
	const lines = [`Declared background work is open (not a final result). Note: ${excerpt(item.note, CLOSE_EXCERPT_CHARS)}`];
	if (item.results.length === 0) lines.push("No producer dependency: no event wakes this work; it stays open until agent_work complete.");
	for (const dependency of await dependencyViews(reader, storageId, item, { arrivals: await readArrivals(reader, conversationId) })) {
		const state = dependency.unavailable === undefined ? dependency.state : `${dependency.state} (${dependency.unavailable})`;
		lines.push(`Dependency ${dependency.sessionId} submission ${dependency.submissionId}: ${state}. Read: agent_inspect view: result, sessionId ${dependency.sessionId}, submissionId ${dependency.submissionId}.`);
	}
	return lines;
}

// ─── Committed changes ──────────────────────────────────────────────────────

async function draftItems(tx: Tx, conversationId: ConversationId): Promise<{ state: OpenWorkState; items: OpenWorkItem[] }> {
	const state = await tx.doc(OpenWorkDoc, conversationId);
	const statuses = await inputStatuses(tx, state.items);
	const items = withoutVoidItems(state.items, (item) => statuses.get(item.submissionId));
	if (items.length !== state.items.length) state.items = items;
	return { state, items };
}

async function placedRequests(tx: Tx, conversationId: ConversationId, routes: readonly RequestContext[]): Promise<string[]> {
	const placed: string[] = [];
	for (const id of (await tx.doc(LiveDoc, conversationId)).run?.inputs ?? []) {
		const record = await tx.submission(id);
		if (record?.type === "input" && record.status === "placed" && record.requestId !== undefined && routes.some((route) => route.requestId === record.requestId)) placed.push(record.requestId);
	}
	return placed;
}

async function defaultRequest(tx: Tx, conversationId: ConversationId, routes: readonly RequestContext[], items: readonly OpenWorkItem[]): Promise<string | Rejection> {
	const placed = await placedRequests(tx, conversationId, routes);
	if (placed.length === 1) return placed[0];
	const open = items.filter(isOpen).map((item) => item.requestId);
	if (placed.length === 0 && open.length === 1) return open[0];
	return { error: `Name the request. Routed inputs of the current run: ${JSON.stringify(placed)}; open items: ${JSON.stringify(open)}` };
}

export type DeclareWorkInput = { readonly request?: string; readonly results: readonly ResultReference[]; readonly note: string };

/** `continue`: one commit declares the item of one request, or replaces its dependencies and note. */
export async function declareOpenWork(tx: Tx, storageId: string, conversationId: ConversationId, input: DeclareWorkInput, now: number): Promise<{ change: ContinueOutcome["change"]; item: OpenWorkView } | Rejection> {
	const { state, items } = await draftItems(tx, conversationId);
	const routes = (await tx.doc(RequestContextDoc, conversationId)).requests;
	const requestId = input.request ?? await defaultRequest(tx, conversationId, routes, items);
	if (typeof requestId !== "string") return requestId;
	const record = await tx.submissionByRequest(conversationId, requestId);
	const retained = routes.find((route) => route.requestId === requestId);
	const route = record?.type !== "input" || record.status !== "placed" || retained === undefined ? undefined : { requestId, submissionId: record.id, requester: retained.requester, replyTo: retained.replyTo, origin: retained.origin };
	for (const reference of input.results) {
		const local = localConversation(storageId, reference.sessionId);
		const problem = local === undefined ? undefined : await localInput(tx, local, reference);
		if (typeof problem === "string") return { error: problem };
	}
	const outcome = continueWork(items, { requestId, ...(route === undefined ? {} : { route }), results: input.results, note: input.note, self: canonicalIdentity(storageId, conversationId), now });
	if ("error" in outcome) return outcome;
	state.items = outcome.items;
	return { change: outcome.change, item: await itemView(tx, storageId, conversationId, outcome.item, "open", { arrivals: state.arrivals ?? [] }) };
}

async function finalReport(tx: Tx, storageId: string, conversationId: ConversationId, item: OpenWorkItem, message: string): Promise<DeliveryReport> {
	const close = item.close;
	if (close === undefined) throw new Error("A final report requires a closed item");
	const report = await recordReportInTransaction(tx, {
		storageId,
		ownerId: item.replyTo,
		senderIdentity: canonicalIdentity(storageId, conversationId),
		requestId: close.reportRequestId,
		message: `${finalReportLabel(close.status, item.requestId)}\n\n${message}`,
	});
	// The row of a report to the declaring conversation is never pending: no delivery admits it as an input.
	if (report.acknowledged || !finalReportToItself(storageId, report)) return report;
	return storeDeliveryRow(tx, "report", { ...report, acknowledged: true });
}

export type CompleteWorkInput = { readonly request: string; readonly status: "done" | "failed"; readonly message: string };
export type CompletedWork = { item: OpenWorkView; deduped: boolean; report?: DeliveryReport };

/**
 * Refusal without a retained item. For an input of this conversation it names the read call of a final
 * report that an earlier close may have retained; the read itself reports whether one exists. The
 * transaction reads no delivery row here: a transaction read creates an absent row.
 */
async function missingItem(tx: Tx, storageId: string, conversationId: ConversationId, requestId: string, rejection: Rejection): Promise<Rejection> {
	const record = await tx.submissionByRequest(conversationId, requestId);
	if (record?.type !== "input") return rejection;
	const { tool: _tool, ...read } = finalReportRead(canonicalIdentity(storageId, conversationId), record.id);
	return { error: `${rejection.error}. A final report of an earlier close stays readable: agent_inspect(${JSON.stringify(read)})` };
}

/**
 * `complete`: one commit closes the item and retains its final report for the retained reply recipient.
 * A repeated call returns the retained close and row. The row is delivered at least once.
 */
export async function completeOpenWork(tx: Tx, storageId: string, conversationId: ConversationId, input: CompleteWorkInput, now: number): Promise<CompletedWork | Rejection> {
	const { state, items } = await draftItems(tx, conversationId);
	const outcome = completeWork(items, { requestId: input.request, status: input.status, message: input.message, conversationId, now });
	if ("error" in outcome) return missingItem(tx, storageId, conversationId, input.request, outcome);
	const close = outcome.item.close;
	const report = outcome.deduped
		? close === undefined ? undefined : await retainedReportRequest(tx, outcome.item.replyTo, close.reportRequestId)
		: await finalReport(tx, storageId, conversationId, outcome.item, input.message);
	if (!outcome.deduped) state.items = outcome.items;
	return { item: await itemView(tx, storageId, conversationId, outcome.item, "closed", { arrivals: state.arrivals ?? [] }), deduped: outcome.deduped, ...(report === undefined ? {} : { report }) };
}

/**
 * Close open items after a conversation abort (`stopped`) or a context reset (`reset`), or the items of
 * the named requests after a stop of their inputs. Each closed item gets the same final report ID that
 * `complete` uses, with the host's fixed text. An item whose declaring run ended unanswered is removed
 * without a report. Stops no producer.
 */
export async function closeOpenWork(tx: Tx, storageId: string, conversationId: ConversationId, reason: "stopped" | "reset", now: number = Date.now(), requestIds?: readonly string[]): Promise<OpenWorkView[]> {
	if (await tx.conversation(conversationId) === undefined) return [];
	const { state, items } = await draftItems(tx, conversationId);
	const outcome = closeWork(items, { reason, conversationId, now, ...(requestIds === undefined ? {} : { requestIds }) });
	if (outcome.closed.length === 0) return [];
	state.items = outcome.items;
	const views: OpenWorkView[] = [];
	for (const item of outcome.closed) {
		await finalReport(tx, storageId, conversationId, item, hostCloseMessage(item, reason));
		views.push(await itemView(tx, storageId, conversationId, item, "closed", { arrivals: state.arrivals ?? [] }));
	}
	return views;
}

// ─── Delivery evidence ────────────────────────────────────────────────────────

/**
 * Marks that the producer's host sends with a receipt delivery: a receipt of a request with declared work is
 * a state note, whether that work is open or closed; every other receipt is the result. Read in the
 * producer's storage when the delivery is sent.
 */
export async function receiptDependencyMarks(reader: OpenWorkReader, storageId: string, receipts: readonly Pick<DeliveryReceipt, "conversationId" | "submissionId" | "requestId">[]): Promise<DependencyMark[]> {
	const declared = new Map<ConversationId, OpenWorkItem[]>();
	const marks: DependencyMark[] = [];
	for (const receipt of receipts.slice(0, DEPENDENCY_MARK_LIMIT)) {
		const items = declared.get(receipt.conversationId) ?? await currentItems(reader, receipt.conversationId);
		declared.set(receipt.conversationId, items);
		const stateNote = items.some((item) => item.requestId === receipt.requestId);
		marks.push({ sessionId: canonicalIdentity(storageId, receipt.conversationId), submissionId: receipt.submissionId, requestId: receipt.requestId, state: stateNote ? "state-note" : "arrived" });
	}
	return marks;
}


/**
 * Mark that the producer's host sends with a report delivery: an explicit final report marks the input
 * of its request `arrived`. Empty for every other report, and for a final report ID that names no input
 * of the sending conversation.
 */
export async function reportDependencyMarks(tx: Tx, storageId: string, report: Pick<DeliveryReport, "requestId" | "senderIdentity">): Promise<DependencyMark[]> {
	const match = FINAL_REPORT_ID.exec(report.requestId);
	if (match === null) return [];
	const conversationId = Number(match[1]) as ConversationId;
	if (!Number.isSafeInteger(conversationId) || canonicalIdentity(storageId, conversationId) !== report.senderIdentity || await tx.conversation(conversationId) === undefined) return [];
	const record = await tx.submissionByRequest(conversationId, match[2]);
	return record?.type === "input" ? [{ sessionId: report.senderIdentity, submissionId: record.id, requestId: match[2], state: "arrived" }] : [];
}

/** Original request, close status and read call of a final report, from the arrived mark of its delivery. */
export type FinalReportDeliveryFacts = { readonly requestId: string; readonly reportRequestId: string; readonly status?: WorkCloseStatus; readonly read: FinalReportRead };

export function finalReportDeliveryFacts(report: Pick<DeliveryReport, "requestId" | "message">, marks: readonly DependencyMark[]): FinalReportDeliveryFacts | undefined {
	const match = FINAL_REPORT_ID.exec(report.requestId);
	const mark = match === null ? undefined : marks.find((candidate) => candidate.requestId === match[2] && candidate.state === "arrived");
	if (mark === undefined) return undefined;
	const status = labelledStatus(report.message, mark.requestId);
	return { requestId: mark.requestId, reportRequestId: report.requestId, ...(status === undefined ? {} : { status }), read: finalReportRead(mark.sessionId, mark.submissionId) };
}

/**
 * Retain the marks of a delivery that the conversation admitted. It reads and writes this conversation's
 * document only, so it can follow a table write of the same commit. A repeated delivery changes nothing.
 */
export async function recordDependencyMarks(tx: Tx, conversationId: ConversationId, marks: readonly DependencyMark[]): Promise<void> {
	if (marks.length === 0) return;
	const state = await tx.doc(OpenWorkDoc, conversationId);
	const prior = state.arrivals ?? [];
	const next = withDependencyMarks(prior, marks, state.items);
	if (JSON.stringify(next) !== JSON.stringify(prior)) state.arrivals = next;
}

// ─── Tool execution ─────────────────────────────────────────────────────────

/** A Harness or a tool invocation; both commit on the calling storage. */
export type AgentWorkHost = {
	readonly harness: { commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> };
	readonly storageId: string;
	readonly conversationId: ConversationId;
	/** One time for the call, stable across a rerun after a restart. */
	readonly now: number;
};

function workError(text: string): ToolExecutionResult<OpenWorkDetails> {
	return { output: [{ type: "text", text }], isError: true };
}

function workResult(lead: string, details: OpenWorkDetails): ToolExecutionResult<OpenWorkDetails> {
	return { output: [{ type: "text", text: `${lead}\n${JSON.stringify(details)}` }], details };
}

const CONTINUE_LEAD: Record<ContinueOutcome["change"], string> = {
	declared: "Declared background work. This is not the answer: end the run with a short state note. Results arrive as events; call agent_work complete when the work is finished.",
	replaced: "Replaced the dependencies and the note of the declared work. The item stays open until agent_work complete.",
};
const NO_DEPENDENCY_LEAD = " The item names no result: no event wakes it, and it stays open until agent_work complete.";

/** `agent_work`: returns at once; every outcome is one commit. */
export async function executeAgentWork(args: unknown, host: AgentWorkHost, context: Context): Promise<ToolExecutionResult<OpenWorkDetails>> {
	let input: AgentWorkInput;
	try { input = parseAgentWorkInput(args); }
	catch (error) { return workError(error instanceof Error ? error.message : String(error)); }
	if (input.action === "continue") {
		const { request, results, note } = input;
		const declared = await host.harness.commit((tx) => declareOpenWork(tx, host.storageId, host.conversationId, { ...(request === undefined ? {} : { request }), results, note }, host.now), context);
		if ("error" in declared) return workError(declared.error);
		return workResult(`${CONTINUE_LEAD[declared.change]}${results.length === 0 ? NO_DEPENDENCY_LEAD : ""}`, { action: "continue", item: declared.item });
	}
	const { request, status, message } = input;
	const completed = await host.harness.commit((tx) => completeOpenWork(tx, host.storageId, host.conversationId, { request, status, message }, host.now), context);
	if ("error" in completed) return workError(completed.error);
	const retained = completed.item.close?.status ?? status;
	const { report } = completed;
	const lead = completed.deduped
		? `Request ${request} was already closed (${retained}); this call changed nothing and sent no second report.`
		: completed.item.close?.delivery === "retained"
			? `${finalReportLabel(retained, request)} is retained for reading. The reply recipient is this conversation, so the report is not sent to it as an input.`
			: `${finalReportLabel(retained, request)} is retained for ${completed.item.replyTo}.`;
	return workResult(lead, {
		action: "complete",
		item: completed.item,
		requestId: request,
		status: retained,
		deduped: completed.deduped,
		...(report === undefined ? {} : { report: { sourceId: report.sourceId, requestId: report.requestId, ownerId: report.ownerId, acknowledged: report.acknowledged, createdAt: report.createdAt } }),
	});
}
