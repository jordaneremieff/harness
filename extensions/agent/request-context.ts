/** Host-authored request routes, retained independently of the active transcript. */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { isInputKind } from "./input-entry.ts";
import { AgentDeliveryDoc } from "./durable-controls.ts";
import { RequestRouteState, type RouteNote } from "./request-route-state.ts";
import { defineDoc, LiveDoc, section, type ConversationId, type GenerationHooks, type Harness, type HookApi, type PromptSection, type SubmissionId, type Tx } from "@earendil-works/pi-durable";

export type RequestContext = {
	readonly requestId: string;
	readonly requester: string;
	readonly replyTo: string;
	readonly origin: "operator" | "model";
};
export type ActiveRequestContext = RequestContext & { readonly status: "admitting" | "queued" | "placed" };

/** Only unfinished requests remain here; native submission state owns settlement. */
export const RequestContextDoc = defineDoc<{ requests: RequestContext[] }>({
	kind: "agent.request-context",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ requests: [] }),
	checkpointWhen: () => false,
});

/** New explicit-route admissions refuse at this bound; retained work never does. */
export const REQUEST_CONTEXT_LIMIT = 128;

export function validateRequestContext(request: RequestContext): void {
	for (const key of ["requestId", "requester", "replyTo", "origin"] as const) {
		const value = request[key];
		if (typeof value !== "string" || value.trim() === "" || value.length > (key === "requestId" ? 1024 : 256) || /[\u0000-\u001f\u007f]/u.test(value))
			throw new Error(`Invalid request context ${key}`);
	}
	if (request.origin !== "model" && request.origin !== "operator") throw new Error("Invalid request context origin");
}

type RequestEvidence = { route: ActiveRequestContext; submissionId?: SubmissionId };
async function unfinishedRequest(tx: Tx, conversationId: ConversationId, request: RequestContext): Promise<RequestEvidence | undefined> {
	const submission = await tx.submissionByRequest(conversationId, request.requestId);
	if (submission !== undefined && (submission.type !== "input" || submission.status === "done" || submission.status === "unanswered")) return undefined;
	return { route: { ...request, status: submission?.status ?? "admitting" }, ...(submission === undefined ? {} : { submissionId: submission.id }) };
}

async function activeRequests(tx: Tx, conversationId: ConversationId): Promise<RequestEvidence[]> {
	const state = await tx.doc(RequestContextDoc, conversationId);
	const active: RequestEvidence[] = [];
	const retained: RequestContext[] = [];
	for (const request of state.requests) {
		const evidence = await unfinishedRequest(tx, conversationId, request);
		if (evidence === undefined) continue;
		retained.push(request);
		active.push(evidence);
	}
	if (retained.length !== state.requests.length) state.requests.splice(0, state.requests.length, ...retained);
	const known = new Set(active.map(({ route }) => route.requestId));
	const delivery = await tx.doc(AgentDeliveryDoc);
	for (const intent of delivery.intents) {
		if (intent.conversationId !== conversationId || known.has(intent.requestId)) continue;
		const evidence = await unfinishedRequest(tx, conversationId, { requestId: intent.requestId, requester: intent.ownerId, replyTo: intent.ownerId, origin: intent.origin });
		if (evidence === undefined) continue;
		known.add(intent.requestId);
		active.push(evidence);
	}
	return active;
}

/** Call before native admission, in the same commit as the delivery intent or Reporter checkpoint. */
export async function recordRequestContext(tx: Tx, conversationId: ConversationId, request: RequestContext, admission: "new" | "retained" = "new"): Promise<void> {
	if (admission === "new") validateRequestContext(request);
	const state = await tx.doc(RequestContextDoc, conversationId);
	const prior = state.requests.find((candidate) => candidate.requestId === request.requestId);
	if (admission === "new" && prior !== undefined && (prior.requester !== request.requester || prior.replyTo !== request.replyTo || prior.origin !== request.origin))
		throw new Error("The request ID already identifies a different request route");
	await activeRequests(tx, conversationId);
	if (prior !== undefined) return;
	const submission = await tx.submissionByRequest(conversationId, request.requestId);
	if (submission !== undefined && (submission.type !== "input" || submission.status === "done" || submission.status === "unanswered")) return;
	if (admission === "new" && submission === undefined && state.requests.length >= REQUEST_CONTEXT_LIMIT) throw new Error(`The conversation already has ${REQUEST_CONTEXT_LIMIT} unfinished request routes`);
	state.requests.push({ requestId: request.requestId, requester: request.requester, replyTo: request.replyTo, origin: request.origin });
}

/** Cleanup is driven by native terminal submissions, including reset and abort, never elapsed time. */
export async function cleanupRequestContexts(tx: Tx, conversationId: ConversationId): Promise<void> {
	await activeRequests(tx, conversationId);
}

/** Profile reads expose pending admissions and queued inputs without calling them the current run. */
export async function readRequestContexts(harness: Harness, conversationId: ConversationId, context: Context): Promise<ActiveRequestContext[]> {
	return harness.commit(async (tx) => (await activeRequests(tx, conversationId)).map(({ route }) => route), context);
}

/** Base delivery fields need not fit the explicit-route bounds. Never shorten an identity. */
function projectable(request: RequestContext): boolean {
	try { validateRequestContext(request); return true; }
	catch { return false; }
}

/** The profile is a bounded view, not a capacity restriction on accepted work. */
export async function readRequestContextPage(harness: Harness, conversationId: ConversationId, context: Context): Promise<{ requests: ActiveRequestContext[]; omitted: number }> {
	const requests: ActiveRequestContext[] = [];
	let omitted = 0;
	for (const request of await readRequestContexts(harness, conversationId, context)) {
		if (requests.length >= REQUEST_CONTEXT_LIMIT || !projectable(request)) omitted += 1;
		else requests.push(request);
	}
	return { requests, omitted };
}

/** Request-specific bytes belong beside their input, never in the system prefix or request tail. */
export function requestContextSection(): PromptSection {
	return section("agent-request-context", () => "Each input with a retained request route has a host-authored agent-request-route note immediately after it. Final answers route automatically. For interim reports, use agent_send with mode: report and the replyTo of the input being answered. An input without a note has no retained route evidence; read agent_profile. Creating-owner provenance never selects a reply recipient.");
}

type UserInput = { key: string; index: number; message: Extract<Message, { role: "user" }> };
type NativeInput = UserInput & { entryId: number };
export const REQUEST_NOTE_LIMIT = 1024;
export const REQUEST_NOTE_BYTES = 4 * 1024 * 1024;

function userInputs(messages: readonly Message[]): UserInput[] {
	const occurrences = new Map<string, number>();
	return messages.flatMap((message, index) => {
		if (message.role !== "user") return [];
		const digest = createHash("sha256").update(JSON.stringify(message)).digest("hex");
		const ordinal = occurrences.get(digest) ?? 0;
		occurrences.set(digest, ordinal + 1);
		return [{ key: `${digest}:${ordinal}`, index, message }];
	});
}

async function requestInputEntry(tx: Tx, conversationId: ConversationId, id: SubmissionId, requestId: string) {
	const submission = await tx.submissionByRequest(conversationId, requestId);
	if (submission?.id !== id || submission.type !== "input" || submission.entry === undefined) return undefined;
	const entry = await tx.entry(submission.entry);
	return entry && isInputKind(entry.kind) && entry.model?.some((message) => message.role === "user") ? entry : undefined;
}

async function nativeInputs(harness: Harness, api: HookApi, context: Context): Promise<NativeInput[]> {
	const conversation = await harness.conversation(api.conversationId, context);
	if (!conversation) return [];
	const view = await conversation.context(context);
	const users = userInputs(view.contributions.flat());
	const inputs: NativeInput[] = [];
	let offset = 0;
	for (let index = 0; index < view.entries.length; index++) {
		const messages = view.contributions[index];
		const lastUser = messages.findLastIndex((message) => message.role === "user");
		const user = users.find((item) => item.index === offset + lastUser);
		if (lastUser >= 0 && user) inputs.push({ ...user, entryId: view.entries[index].id });
		offset += messages.length;
	}
	return inputs;
}

async function newRouteNotes(harness: Harness, api: HookApi, inputs: NativeInput[], context: Context): Promise<RouteNote[]> {
	const candidates = await harness.commit(async (tx) => {
		const active = await activeRequests(tx, api.conversationId);
		const routes = new Map(active.map(({ route, submissionId }) => [submissionId, route]));
		const notes = [];
		for (const id of (await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? []) {
			const route = routes.get(id);
			if (!route || !projectable(route)) continue;
			const entry = await requestInputEntry(tx, api.conversationId, id, route.requestId);
			if (entry) notes.push({ entryId: entry.id, route });
		}
		return notes;
	}, context);
	return candidates.flatMap(({ entryId, route }) => {
		const input = inputs.find((item) => item.entryId === entryId);
		if (!input) return [];
		const { requestId, requester, replyTo, origin } = route;
		return [{ key: input.key, entryId, text: `<agent-request-route>\n${JSON.stringify({ requestId, requester, replyTo, origin })}\n</agent-request-route>` }];
	});
}

function insertRouteNotes(messages: readonly Message[], users: UserInput[], notes: RouteNote[]): readonly Message[] {
	const byKey = new Map(notes.map((note) => [note.key, note]));
	const result = [...messages];
	let inserted = 0;
	for (const user of users) {
		const note = byKey.get(user.key);
		if (note) result.splice(user.index + 1 + inserted++, 0, { role: "user", content: [{ type: "text", text: note.text }], timestamp: user.message.timestamp });
	}
	return result;
}

function boundNotes(notes: RouteNote[], active: Set<number>): RouteNote[] {
	let count = notes.length;
	let bytes = Buffer.byteLength(JSON.stringify(notes));
	return [...notes].sort((left, right) => left.entryId - right.entryId).filter((note) => {
		if (active.has(note.entryId) || (count <= REQUEST_NOTE_LIMIT && bytes <= REQUEST_NOTE_BYTES)) return true;
		count--;
		bytes -= Buffer.byteLength(JSON.stringify(note)) + (count ? 1 : 0);
		return false;
	});
}

/** Conversation retention survives settlement; task memos freeze retries, including recovery. */
export function requestContextHooks(source: Harness | (() => Harness), conversations = new RequestRouteState()): Partial<GenerationHooks> {
	return {
		async beforeRequest(request, api, context) {
			const users = userInputs(request.messages);
			const keys = new Set(users.map((user) => user.key));
			let notes = await api.memo<RouteNote[]>("agent:request-routes", context);
			if (notes === undefined) {
				const harness = typeof source === "function" ? source() : source;
				const inputs = await nativeInputs(harness, api, context);
				// Entry identity prevents an identical surviving input from inheriting a compacted input's route.
				const retained = (conversations.get(api.conversationId) ?? []).flatMap((note) => {
					const input = inputs.find((item) => item.entryId === note.entryId && item.key.split(":")[0] === note.key.split(":")[0]);
					return input && keys.has(input.key) ? [{ ...note, key: input.key }] : [];
				});
				const known = new Set(retained.map((note) => note.key));
				const current = await newRouteNotes(harness, api, inputs, context);
				notes = boundNotes([...retained, ...current.filter((note) => keys.has(note.key) && !known.has(note.key))], new Set(current.map((note) => note.entryId)));
				notes = await api.memo("agent:request-routes", notes, context);
			}
			const visible = notes.filter((note) => keys.has(note.key));
			if (visible.length) conversations.set(api.conversationId, visible);
			else conversations.delete(api.conversationId);
			return visible.length ? { messages: insertRouteNotes(request.messages, users, visible) } : undefined;
		},
	};
}
