/**
 * Declared background work of a request, and the explicit report that completes it.
 *
 * A run that leaves work for later declares it with `continue` and ends with a state note; the native
 * input settles `done` while the item stays open. An item names the results it depends on, or none.
 * Only `complete` closes an item, in the commit that retains one final report for the request's reply
 * recipient. Arrived dependencies and settled inputs never close an item, and nothing is scheduled
 * for an item: it stays in status, in the route listing of later runs and in check-ins until then.
 *
 * Every function that takes a transaction reads submissions. A transaction refuses table reads after its
 * first table write, so call these before an entry, submission or task write of the same commit, or in
 * a commit of their own. Their own writes are documents and delivery rows only.
 */
import type { Context } from "@earendil-works/chord/context";
import { arr, bool, int, lit, obj, opt, str, union, type Schema, type Static } from "@earendil-works/pi-schema";
import { defineDoc, LiveDoc, type ConversationId, type Harness, type SubmissionId, type SubmissionRecord, type ToolExecutionResult, type Tx } from "@earendil-works/pi-durable";
import { retainedReportRequest } from "./delivery-store.ts";
import { recordReportInTransaction, type DeliveryReport } from "./durable-controls.ts";
import { canonicalIdentity } from "./native-identity.ts";
import { RequestContextDoc, type RequestContext } from "./request-context.ts";
import { ResultReferenceSchema, type ResultReference } from "./result-schema.ts";
import { matchesSchema } from "./schema-check.ts";

/** New declarations refuse at this bound; retained open items never do. */
export const OPEN_WORK_LIMIT = 32;
/** Closed items kept for repeated `complete` calls and status reads; the newest stay. */
export const CLOSED_WORK_LIMIT = 16;
export const WORK_DEPENDENCY_LIMIT = 16;
export const WORK_NOTE_CHARS = 1200;
export const WORK_MESSAGE_CHARS = 100_000;
const CLOSE_EXCERPT_CHARS = 600;
const SECTION_NOTE_CHARS = 200;

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
export type OpenWorkState = { items: OpenWorkItem[] };

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

// ─── Tool schemas ───────────────────────────────────────────────────────────

const StringEnum = <const T extends readonly string[]>(values: T, description?: string): Schema<T[number]> => ({ type: "string", enum: [...values], ...(description === undefined ? {} : { description }) });
const identityText = str({ minLength: 1, maxLength: 256 });
const requestText = str({ minLength: 1, maxLength: 1024 });
const submissionNumber = int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const timestamp = int({ minimum: 0 });

export const AGENT_WORK_DESCRIPTION = "Declare background work for a request, or complete it. Returns at once; it never waits. continue records the request, its reply route and the exact results the work depends on; then end the run with a short state note, which is not the final result. A repeated continue replaces the dependencies and the note. Empty results declare open work with no producer dependency: no event wakes it, so it stays open until you complete it. complete is the only act that finishes declared work: it closes the item and sends one final report (done or failed) to the request's reply recipient. Arrived results and settled inputs complete nothing. Read open items and dependency states with agent_status.";

/** One object root for every provider; the action-specific shapes apply at execution. */
export const AgentWorkParams = obj({
	action: StringEnum(["continue", "complete"]),
	request: opt(str({ minLength: 1, maxLength: 1024, description: "Request ID of the work. Required for complete. For continue: default the single routed input of the current run, else the single open item." })),
	results: opt(arr(ResultReferenceSchema, { maxItems: WORK_DEPENDENCY_LIMIT, description: "continue only, required: exact admitted results the work depends on. Empty declares open work with no producer dependency." })),
	note: opt(str({ minLength: 1, maxLength: WORK_NOTE_CHARS, description: "continue only, required: what remains and what the results are for." })),
	status: opt(StringEnum(["done", "failed"], "complete only.")),
	message: opt(str({ minLength: 1, maxLength: WORK_MESSAGE_CHARS, description: "complete only: the final result for the reply recipient." })),
});
const ContinueWorkParams = obj({ action: lit("continue"), request: opt(requestText), results: arr(ResultReferenceSchema, { maxItems: WORK_DEPENDENCY_LIMIT }), note: str({ minLength: 1, maxLength: WORK_NOTE_CHARS }) });
const CompleteWorkParams = obj({ action: lit("complete"), request: requestText, status: union([lit("done"), lit("failed")]), message: str({ minLength: 1, maxLength: WORK_MESSAGE_CHARS }) });
export type AgentWorkInput = Static<typeof ContinueWorkParams> | Static<typeof CompleteWorkParams>;

/** The closed union of the two actions; the registered schema cannot express it under one object root. */
export function parseAgentWorkInput(input: unknown): AgentWorkInput {
	if (!matchesSchema(AgentWorkParams, input)) throw new Error("agent_work requires action continue or complete and valid fields");
	if (input.action === "continue") {
		if (!matchesSchema(ContinueWorkParams, input)) throw new Error("continue requires results (which can be empty) and note, and takes request; omit status and message");
		return input;
	}
	if (!matchesSchema(CompleteWorkParams, input)) throw new Error("complete requires request, status (done or failed) and message; omit results and note");
	return input;
}

export const OpenWorkDependencySchema = obj({
	sessionId: str({ minLength: 1, maxLength: 256 }),
	submissionId: submissionNumber,
	requestId: opt(requestText),
	state: union([lit("open"), lit("state-note"), lit("arrived")]),
	/** Present when the state was not read from the producer's committed facts. */
	unavailable: opt(str()),
	inspect: obj({ tool: lit("agent_inspect"), view: lit("result"), sessionId: str({ minLength: 1, maxLength: 256 }), submissionId: submissionNumber }),
});
export type OpenWorkDependencyView = Static<typeof OpenWorkDependencySchema>;

const ReportDeliverySchema = union([lit("active"), lit("parked"), lit("fallback"), lit("terminal"), lit("delivered"), lit("absent")]);
export type FinalReportDelivery = Static<typeof ReportDeliverySchema>;

export const OpenWorkViewSchema = obj({
	requestId: requestText,
	submissionId: submissionNumber,
	requester: identityText,
	replyTo: identityText,
	origin: union([lit("operator"), lit("model")]),
	note: str(),
	/** `work`, kept apart from the native input status. */
	state: union([lit("open"), lit("closed")]),
	declaredAt: timestamp,
	updatedAt: timestamp,
	close: opt(obj({
		status: union([lit("done"), lit("failed"), lit("stopped"), lit("reset")]),
		message: str(),
		at: timestamp,
		reportRequestId: str({ minLength: 1 }),
		/** Delivery state of the final report row; absent when the reader has no delivery store access. */
		delivery: opt(ReportDeliverySchema),
	})),
	dependencies: arr(OpenWorkDependencySchema, { maxItems: WORK_DEPENDENCY_LIMIT }),
});
export type OpenWorkView = Static<typeof OpenWorkViewSchema>;

const FinalReportSchema = obj({ sourceId: str(), requestId: str(), ownerId: str(), acknowledged: bool(), createdAt: timestamp });
export const AgentWorkOutputSchema = obj({
	action: union([lit("continue"), lit("complete")]),
	item: OpenWorkViewSchema,
	requestId: opt(requestText),
	status: opt(union([lit("done"), lit("failed"), lit("stopped"), lit("reset")])),
	/** True when the item was already closed and this call returned the retained close. */
	deduped: opt(bool()),
	report: opt(FinalReportSchema),
});
export type OpenWorkDetails = Static<typeof AgentWorkOutputSchema>;

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

export function finalReportLabel(status: WorkCloseStatus, requestId: string): string {
	return `Final work result (${status}) for request ${requestId}`;
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
	if (prior === undefined) return { error: `Request ${input.requestId} has no declared work. A request without declared work completes with the answer of its run` };
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

export function reportDelivery(report: Pick<DeliveryReport, "acknowledged" | "delivery" | "fallbackRecipients"> | undefined): FinalReportDelivery {
	if (report === undefined) return "absent";
	if (report.acknowledged) return "delivered";
	if (report.delivery !== undefined) return report.delivery.state;
	return (report.fallbackRecipients?.length ?? 0) > 0 ? "fallback" : "active";
}

// ─── Committed reads ────────────────────────────────────────────────────────

/** A transaction, or snapshot reads of a Harness that must not commit. */
export type OpenWorkReader = Tx | { readonly harness: Harness; readonly context: Context };

function isTx(reader: OpenWorkReader): reader is Tx {
	return !("harness" in reader);
}

async function readItems(reader: OpenWorkReader, conversationId: ConversationId): Promise<readonly OpenWorkItem[]> {
	if (isTx(reader)) return await reader.conversation(conversationId) === undefined ? [] : (await reader.doc(OpenWorkDoc, conversationId)).items;
	return (await reader.harness.snapshot(OpenWorkDoc, conversationId, reader.context))?.items ?? [];
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

/** Conversation of a reference in this storage; undefined for another storage. */
function localConversation(storageId: string, sessionId: string): ConversationId | undefined {
	if (sessionId === storageId) return 1 as ConversationId;
	if (!sessionId.startsWith(`${storageId}:`)) return undefined;
	const rest = sessionId.slice(storageId.length + 1);
	const parsed = /^[0-9]+$/u.test(rest) ? Number(rest) : 0;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed as ConversationId : undefined;
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

const REMOTE_PRODUCER = "the producer is in another storage; read the result with the inspect call";

async function dependencyViews(reader: OpenWorkReader, storageId: string, item: OpenWorkItem, facts?: ReadonlyMap<string, DependencyFact>): Promise<OpenWorkDependencyView[]> {
	const views: OpenWorkDependencyView[] = [];
	for (const reference of item.results) {
		const fact = await dependencyFact(reader, storageId, reference) ?? facts?.get(dependencyKey(reference)) ?? { input: "pending" as const, work: "none" as const, unavailable: REMOTE_PRODUCER };
		views.push({
			...copyReference(reference),
			state: dependencyState(fact),
			...(fact.unavailable === undefined ? {} : { unavailable: fact.unavailable }),
			inspect: { tool: "agent_inspect", view: "result", sessionId: reference.sessionId, submissionId: reference.submissionId },
		});
	}
	return views;
}

async function itemView(reader: OpenWorkReader, storageId: string, item: OpenWorkItem, state: OpenWorkView["state"], facts?: ReadonlyMap<string, DependencyFact>): Promise<OpenWorkView> {
	const { requestId, submissionId, requester, replyTo, origin, note, declaredAt, updatedAt, close } = item;
	const delivery = close === undefined || !isTx(reader) ? undefined : reportDelivery(await retainedReportRequest(reader, replyTo, close.reportRequestId));
	return {
		requestId, submissionId, requester, replyTo, origin, note, state, declaredAt, updatedAt,
		...(close === undefined ? {} : { close: { status: close.status, message: close.message, at: close.at, reportRequestId: close.reportRequestId, ...(delivery === undefined ? {} : { delivery }) } }),
		dependencies: await dependencyViews(reader, storageId, item, facts),
	};
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
 * dependency states. Committed facts only; it never waits. `facts` supplies dependencies of other
 * storages, keyed by `dependencyKey`; without one such a dependency reads `open` with `unavailable`.
 */
export async function openWorkStatus(reader: OpenWorkReader, storageId: string, conversationId: ConversationId, facts?: ReadonlyMap<string, DependencyFact>): Promise<OpenWorkView[]> {
	const views: OpenWorkView[] = [];
	for (const item of await currentItems(reader, conversationId)) views.push(await itemView(reader, storageId, item, isOpen(item) ? "open" : "closed", facts));
	return views;
}

/** Lines for the check-in of a request with open declared work; empty without an open item. */
export async function openWorkCheckInLines(reader: OpenWorkReader, storageId: string, conversationId: ConversationId, requestId: string): Promise<string[]> {
	const item = (await openWorkItems(reader, conversationId)).find((candidate) => candidate.requestId === requestId);
	if (item === undefined) return [];
	const lines = [`Declared background work is open (not a final result). Note: ${excerpt(item.note, CLOSE_EXCERPT_CHARS)}`];
	if (item.results.length === 0) lines.push("No producer dependency: no event wakes this work; it stays open until agent_work complete.");
	for (const dependency of await dependencyViews(reader, storageId, item)) {
		const state = dependency.unavailable === undefined ? dependency.state : `${dependency.state} (${dependency.unavailable})`;
		lines.push(`Dependency ${dependency.sessionId} submission ${dependency.submissionId}: ${state}. Read: agent_inspect view: result, sessionId ${dependency.sessionId}, submissionId ${dependency.submissionId}.`);
	}
	return lines;
}

/**
 * Prompt text that lists the open items with their routes, so a later run or a new context knows what the
 * conversation still owes and to whom. Undefined without an open item. The text changes only when an item
 * is declared, replaced or closed.
 */
export async function openWorkSectionText(harness: Harness, conversationId: ConversationId, context: Context): Promise<string | undefined> {
	const items = await openWorkItems({ harness, context }, conversationId);
	if (items.length === 0) return undefined;
	const lines = items.map((item) => {
		const { requestId, requester, replyTo, origin } = item;
		const dependencies = item.results.length === 0 ? "has no producer dependency" : `depends on ${item.results.map((reference) => `${reference.sessionId} submission ${reference.submissionId}`).join(", ")}`;
		return `- ${JSON.stringify({ requestId, requester, replyTo, origin })} ${dependencies}. Note: ${excerpt(item.note, SECTION_NOTE_CHARS)}`;
	});
	return ["Open declared work of this conversation. Each item stays open until agent_work complete names its request; that call sends the final result to the item's replyTo. Arrived results complete nothing. Read dependency states with agent_status.", ...lines].join("\n");
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
	return { change: outcome.change, item: await itemView(tx, storageId, outcome.item, "open") };
}

async function finalReport(tx: Tx, storageId: string, conversationId: ConversationId, item: OpenWorkItem, message: string): Promise<DeliveryReport> {
	const close = item.close;
	if (close === undefined) throw new Error("A final report requires a closed item");
	return recordReportInTransaction(tx, {
		storageId,
		ownerId: item.replyTo,
		senderIdentity: canonicalIdentity(storageId, conversationId),
		requestId: close.reportRequestId,
		message: `${finalReportLabel(close.status, item.requestId)}\n\n${message}`,
	});
}

export type CompleteWorkInput = { readonly request: string; readonly status: "done" | "failed"; readonly message: string };
export type CompletedWork = { item: OpenWorkView; deduped: boolean; report?: DeliveryReport };

/**
 * `complete`: one commit closes the item and retains its final report for the retained reply recipient.
 * A repeated call returns the retained close and row. The row is delivered at least once.
 */
export async function completeOpenWork(tx: Tx, storageId: string, conversationId: ConversationId, input: CompleteWorkInput, now: number): Promise<CompletedWork | Rejection> {
	const { state, items } = await draftItems(tx, conversationId);
	const outcome = completeWork(items, { requestId: input.request, status: input.status, message: input.message, conversationId, now });
	if ("error" in outcome) return outcome;
	const close = outcome.item.close;
	const report = outcome.deduped
		? close === undefined ? undefined : await retainedReportRequest(tx, outcome.item.replyTo, close.reportRequestId)
		: await finalReport(tx, storageId, conversationId, outcome.item, input.message);
	if (!outcome.deduped) state.items = outcome.items;
	return { item: await itemView(tx, storageId, outcome.item, "closed"), deduped: outcome.deduped, ...(report === undefined ? {} : { report }) };
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
		views.push(await itemView(tx, storageId, item, "closed"));
	}
	return views;
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
