import assert from "node:assert/strict";
import { isInputKind } from "./input-entry.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { Models, StreamOptions } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-schema";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, type ConversationId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { matchesSchema } from "./schema-check.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, completed, pending, fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime, gateTool, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { readOutcome, reconcileDeliveries } from "./durable-controls.ts";
import * as Durable from "@earendil-works/pi-durable";
import { createAgentContribution } from "./durable-agents.ts";
import { CommunicationIndexDoc, communicationIndexKey, reconcileInputCommunications, retainCommunicationIntent } from "./communication-retention.ts";
import { AwaitDoc, AWAIT_PROVENANCE_LIMIT, recordInputProvenance, type AwaitState } from "./awaited-results.ts";
import type { ConversationFrame } from "./live-frames.ts";
import { parseCommunicationView, type Communication } from "./communication.ts";
import { InspectOutputSchema, InspectToolOutputSchema, ResultToolOutputSchema } from "./observation-schema.ts";
import { readableControlText } from "./control-result.ts";
import { DurableObservation, readInspection, readConversationSnapshotPage, RESULT_PAGE_BYTES, RESULT_PAGE_UNITS } from "./durable-observation.ts";
import { deliveryState } from "./delivery-store.ts";
import { renderCommunicationCard } from "./tool-cards.ts";
import { theme } from "./dashboard-test-fixture.mts";
import { stripVTControlCharacters } from "node:util";

const ROOT = 1 as ConversationId;

/** Pi admits `submit(tx, draft)` only for its own transaction object, so an observing proxy passes the original on. */
function observeTx(t: TestContext, conversation: Durable.Conversation): (observed: Tx, original: Tx) => Tx {
	const originals = new WeakMap<object, Tx>();
	const submit = conversation.submit.bind(conversation) as (...args: unknown[]) => Promise<unknown>;
	t.mock.method(conversation, "submit", (...args: unknown[]) => submit(...(typeof args[0] === "object" && args[0] !== null && originals.has(args[0]) ? [originals.get(args[0]), ...args.slice(1)] : args)));
	return (observed, original) => { originals.set(observed, original); return observed; };
}
const sender = "7f7f7f7f-1111-4222-8333-444444444444";
const communication: Communication = { format: "agent.communication/1", kind: "report", sender: { identity: sender, name: "Peer" }, body: { text: "Source body", complete: false, redacted: false }, recordedAt: 0, metadata: { sourceId: "report:source", requestId: "source" } };

function openFixtureHost(root: string, storageId: string, supplied?: Models, resume = true): Promise<DurableHost> {
	return (supplied === undefined ? fixtureRuntime("answer") : Promise.resolve(supplied)).then((models) => DurableHost.open({ storagePath: join(root, "storage.sqlite"), storageId, cwd: root, models, registry: fixtureRegistry(), agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } }, resume, now: () => 17 }));
}

/** Supplied models and registry prevent generic resource discovery. */
async function withHost(run: (host: DurableHost, storageId: string, root: string) => Promise<void>, models?: Models): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "communication-runtime-"));
	const storageId = randomUUID();
	let host: DurableHost | undefined;
	try {
		try { host = await openFixtureHost(root, storageId, models); }
		catch (error) { throw new Error("Synthetic host open failed", { cause: error }); }
		await run(host, storageId, root);
	} finally { await host?.close(); rmSync(root, { recursive: true, force: true }); }
}

it("resolves native request IDs in the selected conversation with matching submission and entry selectors", async () => {
	await withHost(async (host, storageId) => {
		const first = await host.request("submit", { requestId: "qualified-request", message: "Root bytes" }) as { submissionId: number };
		const outcome = await readOutcome(host.harness, first.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		assert.ok(outcome.entryId);
		const root = await host.request("inspect", { sessionId: storageId, view: "result", requestId: "qualified-request", submissionId: String(first.submissionId), entryId: String(outcome.entryId) }) as { submissionId: number; requestId: string; status: string; answer: string; conversationId: number };
		assert.equal(matchesSchema(InspectToolOutputSchema, root), true);
		assert.equal(root.submissionId, first.submissionId);
		assert.equal(root.requestId, "qualified-request");
		assert.equal(root.conversationId, ROOT);
		assert.equal(root.status, "done");
		assert.equal(root.answer, "durable answer");
		const fork = await host.request("fork", { requestId: "request-lookup-fork", entryId: outcome.entryId }) as { conversationId: ConversationId };
		const identity = `${storageId}:${fork.conversationId}`;
		const child = await host.request("submit", { sessionId: identity, requestId: "qualified-request", message: "Child bytes" }) as { submissionId: number };
		await readOutcome(host.harness, child.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		const childView = await host.request("inspect", { sessionId: identity, view: "result", requestId: "qualified-request" }) as { submissionId: number; conversationId: number };
		assert.equal(childView.submissionId, child.submissionId);
		assert.equal(childView.conversationId, fork.conversationId);
		assert.notEqual(childView.submissionId, first.submissionId);
		await assert.rejects(host.request("inspect", { sessionId: identity, view: "result", requestId: "qualified-request", submissionId: first.submissionId }), /different native submissions/u);
	});
});

it("refuses conflicting native result selectors without treating operationId as requestId", async () => {
	await withHost(async (host, storageId) => {
		const first = await host.request("submit", { requestId: "request-alpha", message: "Alpha", ownerId: storageId, origin: "operator", operationId: "operation-alpha" }) as { submissionId: number };
		const second = await host.request("submit", { requestId: "request-beta", message: "Beta", ownerId: storageId, origin: "operator", operationId: "operation-beta" }) as { submissionId: number };
		const a = await readOutcome(host.harness, first.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		const b = await readOutcome(host.harness, second.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		assert.ok(a.entryId && b.entryId);
		await reconcileDeliveries(host.harness, BACKGROUND_CONTEXT);
		await assert.rejects(host.request("inspect", { sessionId: storageId, view: "result", requestId: "request-alpha", submissionId: second.submissionId }), /different native submissions/u);
		await assert.rejects(host.request("inspect", { sessionId: storageId, view: "result", requestId: "request-alpha", entryId: b.entryId }), /entryId does not match/u);
		await assert.rejects(host.request("inspect", { sessionId: storageId, view: "result", requestId: "request-alpha", operationId: "operation-beta" }), /different native submissions/u);
		await assert.rejects(host.request("inspect", { sessionId: storageId, view: "history", requestId: "request-alpha" }), /only the result view/u);
		const matching = await host.request("inspect", { sessionId: storageId, view: "result", requestId: "request-alpha", operationId: "operation-alpha", submissionId: first.submissionId, entryId: a.entryId }) as { submissionId: number; operationId: string; requestId: string };
		assert.equal(matching.submissionId, first.submissionId);
		assert.equal(matching.operationId, "operation-alpha");
		assert.equal(matching.requestId, "request-alpha");
		const alias = await host.request("inspect", { sessionId: storageId, view: "result", operationId: "request-alpha" }) as { status: string };
		assert.equal(alias.status, "unavailable");
	});
});

it("returns a closed unavailable result for a missing native request without inventing a submission", async () => {
	await withHost(async (host, storageId) => {
		const missing = await host.request("inspect", { sessionId: storageId, view: "result", requestId: "no-native-request" }) as { status: string; submissionId?: number; requestId: string; sessionId: string; conversationId: number; reason: string };
		assert.equal(matchesSchema(InspectOutputSchema, missing), true);
		assert.equal(missing.status, "unavailable");
		assert.equal(missing.submissionId, undefined);
		assert.equal(missing.requestId, "no-native-request");
		assert.equal(missing.sessionId, storageId);
		assert.equal(missing.conversationId, ROOT);
		assert.match(missing.reason, /No native submission/u);
		await assert.rejects(host.request("inspect", { view: "result", requestId: "" }), /nonempty/u);
	});
});

it("forwards the native request selector and returns terminal inspection text through the existing tool", async () => {
	await withHost(async (host, storageId, root) => {
		const admitted = await host.request("submit", { requestId: "terminal-request", message: "Original terminal request" }) as { submissionId: number };
		await readOutcome(host.harness, admitted.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		const seen: Record<string, unknown>[] = [];
		const extension = createAgentContribution({ source: import.meta.filename, configureSettings: () => {}, dispatch: async (method, params) => {
			assert.equal(method, "inspect");
			seen.push({ ...params });
			return host.request(method, params);
		} }).create({ durable: Durable, storageId, cwd: root, agentDir: root, onClose() {}, services: { modelRuntime: { getModel: () => testModel, getModels: () => [testModel] } } });
		const tool = extension.tools?.find((tool) => tool.name === "agent_inspect");
		assert.ok(tool);
		const args = { sessionId: storageId, view: "result", requestId: "terminal-request" };
		assert.equal(matchesSchema(tool.parameters, args), true);
		const output = await tool.execute(args, {} as never, BACKGROUND_CONTEXT);
		assert.notEqual(output.isError, true);
		const text = output.output?.find((part) => part.type === "text");
		assert.ok(text?.type === "text");
		const parsed = output.structuredOutput as { submissionId: number; requestId: string; answer: string };
		assert.equal(parsed.submissionId, admitted.submissionId);
		assert.equal(parsed.requestId, "terminal-request");
		assert.equal(parsed.answer, "durable answer");
		assert.ok(text.text.startsWith("durable answer\n\nResult: "));
		assert.equal(text.text, readableControlText(parsed));
		assert.equal(matchesSchema(InspectToolOutputSchema, output.structuredOutput), true);
		assert.equal(seen[0]?.requestId, args.requestId);
		const missing = await tool.execute({ sessionId: storageId, view: "result", requestId: "no-terminal-request" }, {} as never, BACKGROUND_CONTEXT);
		assert.notEqual(missing.isError, true);
		const unavailable = missing.output?.find((part) => part.type === "text");
		assert.ok(unavailable?.type === "text");
		assert.equal((missing.structuredOutput as { status: string }).status, "unavailable");
		assert.equal(matchesSchema(InspectToolOutputSchema, missing.structuredOutput), true);
		assert.equal(unavailable.text, readableControlText(missing.structuredOutput));
		assert.ok(unavailable.text.startsWith("No answer body is available in this result."));
	});
});

type RetainedResultPage = Exclude<Static<typeof ResultToolOutputSchema>, { status: "unavailable" }>;
function retainedResultPage(value: unknown): RetainedResultPage {
	assert.equal(matchesSchema(ResultToolOutputSchema, value), true);
	assert.notEqual((value as { status: string }).status, "unavailable");
	assert.ok(Buffer.byteLength(JSON.stringify(value)) <= RESULT_PAGE_BYTES);
	return value as RetainedResultPage;
}

async function readAnswerPages(initial: RetainedResultPage, execute: (args: Record<string, unknown>) => Promise<RetainedResultPage>): Promise<string> {
	let body = initial.answer ?? "", page = initial;
	while (page.answerContinuation !== undefined) {
		const { tool: name, ...args } = page.answerContinuation;
		assert.equal(name, "agent_inspect");
		assert.equal(Object.hasOwn(args, "receiptCursor"), false);
		const previousOffset = page.offset ?? 0;
		page = await execute(args);
		assert.ok((page.offset ?? 0) > previousOffset);
		assert.ok((page.answer?.length ?? 0) <= RESULT_PAGE_UNITS);
		body += page.answer ?? "";
	}
	assert.equal(page.nextOffset, null);
	return body;
}

it("executes independent answer and recipient continuations through native tools, cold reads and reopen", { timeout: 30000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "result-pages-")), storageId = randomUUID();
	const released = signal(), entered = signal();
	const answer = `${"a".repeat(4095)}😀\n${"separate answer line\n".repeat(400)}`;
	const models = await scriptedRuntime([toolCallMessage("gate"), answerMessage(answer)]);
	let host: DurableHost | undefined;
	try {
		host = await DurableHost.open({ storagePath: join(root, "storage.sqlite"), storageId, cwd: root, models, registry: fixtureRegistry([gateTool(released.promise, entered.resolve)]), settings: { steeringMode: "all" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
		const first = await host.request("submit", { message: "first", requestId: "result-group-0", ownerId: "recipient-a", origin: "model" }) as { submissionId: SubmissionId };
		await entered.promise;
		const intended = [first.submissionId], other: SubmissionId[] = [];
		for (let index = 1; index <= 18; index++) {
			const ownerId = index === 6 || index === 12 ? "recipient-b" : "recipient-a";
			const admitted = await host.request("submit", { message: `input ${index}`, requestId: `result-group-${index}`, ownerId, origin: "model", whenBusy: "steer" }) as { submissionId: SubmissionId };
			(ownerId === "recipient-a" ? intended : other).push(admitted.submissionId);
		}
		released.resolve();
		for (const id of [...intended, ...other]) await readOutcome(host.harness, id, BACKGROUND_CONTEXT);
		const active = host;
		const contribution = createAgentContribution({ source: import.meta.filename, configureSettings: () => {}, dispatch: (method, params) => active.request(method, params) }).create({ durable: Durable, storageId, cwd: root, agentDir: root, onClose() {}, services: { modelRuntime: { getModel: () => testModel, getModels: () => [testModel] } } });
		const tool = contribution.tools?.find((item) => item.name === "agent_inspect");
		assert.ok(tool);
		const execute = async (args: Record<string, unknown>) => {
			assert.equal(matchesSchema(tool.parameters, args), true, "each emitted call satisfies the native public input schema");
			const output = await tool.execute(args, {} as never, BACKGROUND_CONTEXT);
			assert.notEqual(output.isError, true);
			const page = retainedResultPage(output.structuredOutput);
			const text = output.output?.find((part) => part.type === "text");
			assert.ok(text?.type === "text");
			assert.equal(text.text, readableControlText(page));
			assert.equal(page.requestId, "result-group-0");
			return page;
		};
		const selected = { sessionId: storageId, view: "result", submissionId: first.submissionId, requestId: "result-group-0" };
		const initial = await execute(selected);
		assert.equal(initial.answer?.length, 4095, "the first page never splits the surrogate pair at its limit");
		assert.equal(initial.nextOffset, 4095);
		assert.equal(initial.receiptGroup?.recipient, "recipient-a");
		assert.equal(initial.receiptGroup?.results.length, 16);
		assert.equal(initial.receiptGroup?.complete, false);
		assert.equal(await readAnswerPages(initial, execute), answer);
		const answerContinuation = initial.answerContinuation;
		assert.ok(answerContinuation);
		const receiptCall = initial.receiptGroup?.next;
		assert.ok(receiptCall);
		const { tool: receiptTool, ...receiptArgs } = receiptCall;
		assert.equal(receiptTool, "agent_inspect");
		assert.equal(Object.hasOwn(receiptArgs, "offset"), false);
		const receiptPage = await execute(receiptArgs);
		assert.equal(receiptPage.answer, undefined, "a receipt-only continuation never repeats the answer body");
		assert.equal(receiptPage.answerContinuation, undefined);
		assert.equal(receiptPage.offset, undefined);
		assert.equal(receiptPage.receiptGroup?.complete, true);
		assert.equal(receiptPage.receiptGroup?.next, null);
		const references = [...initial.receiptGroup?.results ?? [], ...receiptPage.receiptGroup?.results ?? []];
		assert.deepEqual(references.map((row) => row.submissionId).sort((a, b) => a - b), [...intended].sort((a, b) => a - b));
		assert.equal(references.some((row) => other.includes(row.submissionId as SubmissionId)), false);
		await assert.rejects(host.request("inspect", { ...receiptArgs, submissionId: other[0], requestId: "result-group-6" }), /cursor disagrees.*selected result or recipient/u);
		await assert.rejects(host.request("inspect", { ...receiptArgs, receiptCursor: "not-a-current-cursor" }), /Invalid receipt cursor/u);
		const receipts = Object.values((await deliveryState(host.harness, BACKGROUND_CONTEXT, true)).receipts);
		assert.equal(receipts.length, 19);
		assert.equal(new Set(receipts.map((row) => row.answerEntryId)).size, 1);
		assert.ok(receipts.every((row) => row.acknowledged === false), "evidence inspection consumes no recipient receipt");
		const cold = await DurableObservation.open({ backupFrom: join(root, "storage.sqlite"), storageId, models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, BACKGROUND_CONTEXT);
		try {
			const coldReceipt = retainedResultPage(await cold.request("inspect", receiptArgs));
			assert.deepEqual(coldReceipt.receiptGroup, receiptPage.receiptGroup);
			assert.equal(coldReceipt.answer, undefined);
			const { tool: _tool, ...answerArgs } = answerContinuation;
			const coldAnswer = retainedResultPage(await cold.request("inspect", answerArgs));
			assert.equal(coldAnswer.answer, answer.slice(4095, 4095 + RESULT_PAGE_UNITS));
			await assert.rejects(cold.request("inspect", { ...receiptArgs, view: "history" }), /only the result view/u);
		} finally { await cold.close(); }
		for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, answer.length + 1]) await assert.rejects(host.request("inspect", { ...selected, offset }), /offset|integer/u);
		await host.close();
		host = await openFixtureHost(root, storageId);
		const reopened = retainedResultPage(await host.request("inspect", receiptArgs));
		assert.deepEqual(reopened.receiptGroup, receiptPage.receiptGroup);
		assert.equal(reopened.answer, undefined);
		const after = Object.values((await deliveryState(host.harness, BACKGROUND_CONTEXT, true)).receipts);
		assert.ok(after.every((row) => row.acknowledged === false));
	} finally {
		released.resolve();
		await host?.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps unsettled results and missing answer bodies distinct from readable pages", async () => {
	const control = await controlledRuntime(1);
	await withHost(async (host, storageId) => {
		const admitted = await host.request("submit", { requestId: "pending-page", message: "Hold the answer" }) as { submissionId: SubmissionId };
		try {
			await control.held;
			const pending = retainedResultPage(await host.request("inspect", { view: "result", sessionId: storageId, submissionId: admitted.submissionId }));
			assert.equal(pending.status, "placed");
			assert.equal(pending.answer, undefined);
			assert.equal(pending.offset, undefined);
			assert.equal(pending.receiptGroup, undefined);
			await assert.rejects(host.request("inspect", { view: "result", submissionId: admitted.submissionId, receiptCursor: "recipient-page" }), /settled native input/u);
		} finally { control.release(); }
		await readOutcome(host.harness, admitted.submissionId, BACKGROUND_CONTEXT);
	}, control.models);
	await withHost(async (host) => {
		const admitted = await host.request("submit", { requestId: "empty-answer", message: "An empty retained answer" }) as { submissionId: SubmissionId };
		await readOutcome(host.harness, admitted.submissionId, BACKGROUND_CONTEXT);
		const missing = retainedResultPage(await host.request("inspect", { view: "result", submissionId: admitted.submissionId }));
		assert.equal(missing.status, "done");
		assert.equal(missing.answer, undefined);
		assert.equal(missing.offset, undefined);
		assert.match(missing.reason ?? "", /answer entry.*not retained/u);
	}, await scriptedRuntime([answerMessage("")]));
});

it("preserves user model bytes and keeps communication out of input metadata", async () => {
	await withHost(async (host, storageId) => {
		const message = "Original input\n\t🙂 and preserved spaces  ";
		const result = await host.request("submit", { requestId: "active", message, communication }) as { submissionId: number };
		const outcome = await readOutcome(host.harness, result.submissionId as Parameters<typeof readOutcome>[1], BACKGROUND_CONTEXT);
		await reconcileInputCommunications(host.harness, storageId, BACKGROUND_CONTEXT);
		const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
		assert.ok(conversation);
		const native = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
		const input = native.items.find((entry) => entry.id === outcome.entryId);
		assert.equal(input?.model?.[0]?.role, "user");
		assert.equal(input?.model?.[0]?.content, message);
		assert.deepEqual(input?.data, { author: { role: "unknown" }, class: "report", sender, requestId: "active" });
		const snapshot = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		const view = parseCommunicationView(snapshot.entries.find((entry) => entry.id === String(outcome.entryId))?.communication);
		assert.equal(view?.state, "ready");
		if (view?.state !== "ready") throw new Error("Communication did not bind");
		assert.equal(view.value.recordedAt, 17);
		assert.equal(view.target.mode, "input");
		const card = stripVTControlCharacters(renderCommunicationCard(view.value, theme, { expanded: false, keyText: () => "ctrl+o" }).render(80).join("\n"));
		assert.match(card, /\[agent\] Report \u00b7 request source.*from Peer.*Partial body.*Source body/su);
		const history = await readInspection(host.harness, storageId, conversation, { view: "history" }, BACKGROUND_CONTEXT) as { entries: { id: number; kind: string; communication: unknown }[] };
		assert.equal(matchesSchema(InspectOutputSchema, history), true);
		assert.equal(history.entries.some((entry) => entry.kind === "agent.communication"), false);
		assert.deepEqual(history.entries.find((entry) => entry.id === outcome.entryId)?.communication, view);
		const branch = await readInspection(host.harness, storageId, conversation, { view: "branch" }, BACKGROUND_CONTEXT) as { entries: { kind: string; communication?: unknown }[] };
		assert.equal(matchesSchema(InspectOutputSchema, branch), true);
		assert.equal(branch.entries.some((entry) => entry.kind === "agent.communication"), true);
		assert.equal(branch.entries.some((entry) => entry.communication !== undefined), false);
		const exact = await readInspection(host.harness, storageId, conversation, { view: "exact", entryId: outcome.entryId }, BACKGROUND_CONTEXT) as { text: string };
		assert.equal(JSON.parse(exact.text).model[0].content, message);
		const activity = await readInspection(host.harness, storageId, conversation, { view: "activity" }, BACKGROUND_CONTEXT);
		assert.equal(matchesSchema(InspectOutputSchema, activity), true);
	});
});

it("binds passive invalid metadata to its original write without an input claim", async () => {
	await withHost(async (host, storageId) => {
		await host.request("passive-submit", { requestId: "passive-invalid", message: "Native passive text", communication: { wrong: true } });
		const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
		assert.ok(conversation);
		const snapshot = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		const row = snapshot.entries.find((entry) => entry.kind === "agent.thread-notice");
		assert.ok(row);
		assert.equal(row.model?.[0]?.content, "Native passive text");
		assert.deepEqual(row.communication, { state: "unavailable", reason: "invalid" });
		const records = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
		assert.equal(records.items.some((entry) => entry.kind === "pi.user" || entry.kind === "agent.communication"), false);
	});
});

it("preserves first association on conflict and validates fork visibility at the companion", async () => {
	await withHost(async (host, storageId) => {
		const first = await host.request("submit", { requestId: "forked", message: "Native input", communication }) as { submissionId: number };
		const outcome = await readOutcome(host.harness, first.submissionId as Parameters<typeof readOutcome>[1], BACKGROUND_CONTEXT);
		await reconcileInputCommunications(host.harness, storageId, BACKGROUND_CONTEXT);
		const snapshot = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		const value = parseCommunicationView(snapshot.entries.find((entry) => entry.id === String(outcome.entryId))?.communication);
		if (value?.state !== "ready") throw new Error("First association missing");
		const repeat = await host.request("submit", { requestId: "forked", message: "Native input", communication: { ...communication, sender: { identity: "88888888-1111-4222-8333-444444444444" } } }) as { submissionId: number };
		assert.equal(repeat.submissionId, first.submissionId);
		await reconcileInputCommunications(host.harness, storageId, BACKGROUND_CONTEXT);
		const replay = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		assert.deepEqual(replay.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, value);
		const olderPage = await readConversationSnapshotPage(host.harness, ROOT, { before: Number(value.recordEntryId) as NonNullable<typeof outcome.entryId> }, BACKGROUND_CONTEXT, storageId);
		assert.deepEqual(olderPage.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, value);
		const before = await host.request("fork", { requestId: "before-companion", entryId: outcome.entryId }) as { conversationId: ConversationId };
		const beforePage = await readConversationSnapshotPage(host.harness, before.conversationId, {}, BACKGROUND_CONTEXT, storageId);
		assert.deepEqual(beforePage.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, { state: "unresolved" });
		const after = await host.request("fork", { requestId: "after-companion", entryId: Number(value.recordEntryId) }) as { conversationId: ConversationId };
		const afterPage = await readConversationSnapshotPage(host.harness, after.conversationId, {}, BACKGROUND_CONTEXT, storageId);
		assert.deepEqual(afterPage.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, value);
		assert.equal(value.target.conversationId, ROOT);
	});
});

it("refuses communication backfill on a deduped input with no retained intent", async () => {
	await withHost(async (host, storageId) => {
		const first = await host.request("submit", { requestId: "plain", message: "Native input" }) as { submissionId: number };
		const outcome = await readOutcome(host.harness, first.submissionId as Parameters<typeof readOutcome>[1], BACKGROUND_CONTEXT);
		const repeat = await host.request("submit", { requestId: "plain", message: "Native input", communication }) as { submissionId: number };
		assert.equal(repeat.submissionId, first.submissionId);
		await reconcileInputCommunications(host.harness, storageId, BACKGROUND_CONTEXT);
		const page = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		assert.deepEqual(page.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, { state: "unresolved" });
		const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
		assert.ok(conversation);
		assert.equal((await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.some((entry) => entry.kind === "agent.communication"), false);
	});
});

it("captures invalid metadata as a bounded exact diagnostic without rejecting native input", async () => {
	await withHost(async (host, storageId) => {
		const admitted = await host.request("submit", { requestId: "invalid-active", message: "Native input", communication: { wrong: true } }) as { submissionId: number };
		const outcome = await readOutcome(host.harness, admitted.submissionId as Parameters<typeof readOutcome>[1], BACKGROUND_CONTEXT);
		assert.equal(outcome.status, "done");
		const page = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		const row = page.entries.find((entry) => entry.id === String(outcome.entryId));
		assert.equal(row?.model?.[0]?.content, "Native input");
		assert.deepEqual(row?.communication, { state: "unavailable", reason: "invalid" });
		assert.equal(host.communicationMetadataDiagnostic, "invalid-envelope");
	});
});

type TerminalInput = { requestId: string; submissionId: number; entryId: number; message: string; value: Communication };
async function terminalInputs(host: DurableHost, prefix: string): Promise<TerminalInput[]> {
	const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
	assert.ok(conversation);
	const inputs: TerminalInput[] = [];
	for (let index = 0; index < AWAIT_PROVENANCE_LIMIT; index++) {
		const requestId = `${prefix}-${index}`, message = `Original ${index}`;
		const submission = await conversation.submit({ type: "input", requestId, content: message }, BACKGROUND_CONTEXT);
		const outcome = await readOutcome(host.harness, submission.id, BACKGROUND_CONTEXT);
		assert.equal(outcome.status, "done");
		assert.ok(outcome.entryId);
		inputs.push({ requestId, submissionId: submission.id, entryId: outcome.entryId, message, value: { ...communication, body: { ...communication.body, text: `Retained ${index}` } } });
	}
	return inputs;
}
function stagedRows(inputs: TerminalInput[], storageId: string) {
	return inputs.map((input) => ({ conversationId: ROOT, requestId: input.requestId, classification: "explicit" as const, submissionId: input.submissionId, communicationIntent: { ...retainCommunicationIntent(input.value, () => 17), storageId } }));
}
function observePrune(t: TestContext, host: DurableHost, inputs: TerminalInput[]) {
	const expected = new Set(inputs.map((input) => input.requestId)), appended: string[] = [];
	const original = host.harness.conversation.bind(host.harness), wrapped = new WeakSet<object>();
	t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof original>) => {
		const conversation = await original(...args);
		if (conversation !== undefined && !wrapped.has(conversation)) {
			wrapped.add(conversation);
			const commit = conversation.commit.bind(conversation);
			const proxy = observeTx(t, conversation);
			t.mock.method(conversation, "commit", async (apply: (tx: Tx) => Promise<unknown>, context: typeof BACKGROUND_CONTEXT) => commit(async (tx) => {
				const state = await tx.doc(AwaitDoc);
				const observed = proxy(new Proxy(tx, { get(target, key) {
					if (key === "appendEntry") return async (...args: unknown[]) => {
						const draft = args[1] as { kind?: string; data?: { target?: { requestId?: string } } };
						const data = draft.data;
						const requestId = data?.target?.requestId;
						if (draft.kind === "agent.communication" && requestId !== undefined && expected.has(requestId)) {
							assert.deepEqual(new Set(state.provenance.map((row) => row.requestId)), expected);
							appended.push(requestId);
						}
						return Reflect.apply(target.appendEntry, target, args);
					};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				} }), tx);
				return apply(observed);
			}, context));
		}
		return conversation;
	});
	return appended;
}
async function assertCompanions(host: DurableHost, storageId: string, inputs: TerminalInput[]) {
	const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
	assert.ok(conversation);
	const entries = await conversation.entries({}, 512, undefined, BACKGROUND_CONTEXT), recordIds = new Set<string>();
	for (const input of inputs) {
		assert.equal(entries.items.find((entry) => entry.id === input.entryId)?.model?.[0]?.content, input.message);
		const point = await host.harness.snapshot(CommunicationIndexDoc, communicationIndexKey(storageId, ROOT, String(input.entryId)), BACKGROUND_CONTEXT);
		assert.ok(point?.recordEntryId);
		assert.equal(recordIds.has(point.recordEntryId), false);
		recordIds.add(point.recordEntryId);
		const record = entries.items.find((entry) => String(entry.id) === point.recordEntryId);
		assert.ok(record);
		assert.equal(record.kind, "agent.communication");
		assert.equal(record.conversationId, ROOT);
		assert.equal(record.model, undefined);
		assert.equal(record.head, undefined);
		assert.equal(record.edits, undefined);
		const target = { mode: "input", storageId, conversationId: ROOT, entryId: String(input.entryId), submissionId: input.submissionId, requestId: input.requestId };
		assert.deepEqual(point.target, target);
		assert.deepEqual(record.data, { format: "agent.communication-link/1", target, value: { ...input.value, recordedAt: 17 } });
	}
	assert.equal(recordIds.size, AWAIT_PROVENANCE_LIMIT);
}
function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
async function controlledRuntime(pendingAt: number) {
	const runtime = await createTestRuntime(), held = signal();
	let calls = 0, release = () => {};
	const streamSimple = (_model: unknown, _context: unknown, options?: StreamOptions) => {
		if (++calls !== pendingAt) return completed(answerMessage());
		const message = answerMessage(), stream = pending(message);
		const finish = () => {
			options?.signal?.removeEventListener("abort", finish);
			release = () => {};
			stream.push({ type: "done", reason: "stop", message }); stream.end(message);
		};
		release = finish;
		if (options?.signal?.aborted) finish();
		else options?.signal?.addEventListener("abort", finish, { once: true });
		held.resolve();
		return stream;
	};
	runtime.registerNativeProvider({ id: fixtureProvider, name: "Controlled retention fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream: streamSimple, streamSimple });
	return { models: runtime, held: held.promise, release: () => release() };
}

for (const abortResult of ["already_placed", "settled", "aborted"] as const) it(`captures communication before native abort result ${abortResult}`, { timeout: 60_000 }, async () => {
	const control = await controlledRuntime(abortResult === "settled" ? 2 : 1);
	await withHost(async (host, storageId) => {
		const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
		assert.ok(conversation);
		try {
			if (abortResult === "aborted") {
				await conversation.submit({ type: "input", requestId: "held-owner", content: "Held owner" }, BACKGROUND_CONTEXT);
				await control.held;
			}
			const result = await host.request("submit", { requestId: "check-in", message: "Original check-in bytes", whenBusy: "followUp", communication, provenance: { classification: "automatic", automaticKind: "checkIn", sender, producerRequestId: "producer" } }) as { submissionId: SubmissionId; suppressed?: boolean };
			assert.equal(result.suppressed, undefined, "admission does not suppress an automatic input");
			const native = await host.harness.submission(result.submissionId, BACKGROUND_CONTEXT);
			assert.ok(native);
			if (abortResult === "settled") {
				await native.wait(BACKGROUND_CONTEXT);
				await conversation.submit({ type: "input", requestId: "held-owner", content: "Held owner" }, BACKGROUND_CONTEXT);
			}
			await control.held;
			const state = await host.harness.snapshot(AwaitDoc, BACKGROUND_CONTEXT);
			const captured = state?.provenance.find((row) => row.requestId === "check-in");
			assert.equal(captured?.submissionId, native.id);
			assert.equal(captured?.communicationIntent?.value?.recordedAt, 17);
			assert.equal(captured?.communicationIntent?.linkedEntryId !== undefined, abortResult !== "aborted");
			assert.equal(await native.abort(BACKGROUND_CONTEXT), abortResult);
			const status = await native.status(BACKGROUND_CONTEXT);
			assert.ok(status.type === "input");
			if (abortResult === "aborted") {
				assert.equal(status.status, "unanswered");
				assert.equal(status.entry, undefined);
			} else {
				assert.ok(status.entry);
				const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
				assert.equal(entries.items.find((entry) => entry.id === status.entry)?.model?.[0]?.content, "Original check-in bytes");
				const page = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
				const view = parseCommunicationView(page.entries.find((entry) => entry.id === String(status.entry))?.communication);
				assert.equal(view?.state, "ready");
				if (view?.state !== "ready" || view.target.mode !== "input") throw new Error("Admitted communication missing");
				assert.deepEqual(view.value, { ...communication, recordedAt: 17 });
				assert.equal(view.target.submissionId, native.id);
			}
			const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
			assert.equal(entries.items.filter((entry) => isInputKind(entry.kind)).length, abortResult === "settled" ? 2 : 1);
			assert.equal(entries.items.filter((entry) => entry.kind === "agent.communication").length, abortResult === "aborted" ? 0 : 1);
		} finally { control.release(); }
	}, control.models);
});

it("preserves a queued plain decision through eviction after a stale negative dedupe lookup", { timeout: 60_000 }, async (t) => {
	const control = await controlledRuntime(1);
	await withHost(async (host, storageId) => {
		const snapshot = host.harness.snapshot.bind(host.harness);
		t.mock.method(host.harness, "snapshot", async (...args: unknown[]) => args[0] === AwaitDoc ? undefined : Reflect.apply(snapshot, host.harness, args));
		const original = host.harness.conversation.bind(host.harness), wrapped = new WeakSet<object>();
		const lookup = signal(), resume = signal();
		let held = false;
		t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof original>) => {
			const conversation = await original(...args);
			if (conversation !== undefined && !wrapped.has(conversation)) {
				wrapped.add(conversation);
				const commit = conversation.commit.bind(conversation);
				const proxy = observeTx(t, conversation);
				t.mock.method(conversation, "commit", async (apply: (tx: Tx) => Promise<unknown>, context: typeof BACKGROUND_CONTEXT) => {
					let negative = false;
					const value = await commit((tx) => apply(proxy(new Proxy(tx, { get(target, key) {
						if (key === "submissionByRequest") return async (...args: Parameters<Tx["submissionByRequest"]>) => {
							const submission = await target.submissionByRequest(...args);
							if (args[1] === "stale-plain" && submission === undefined && !held) negative = true;
							return submission;
						};
						const method = Reflect.get(target, key);
						return typeof method === "function" ? method.bind(target) : method;
					} }), tx)), context);
					if (negative && !held) { held = true; lookup.resolve(); await resume.promise; }
					return value;
				});
			}
			return conversation;
		});
		const later = host.request("submit", { requestId: "stale-plain", message: "Later changed bytes", communication }) as Promise<{ submissionId: number }>;
		try {
			await lookup.promise;
			const conversation = await original(ROOT, BACKGROUND_CONTEXT);
			assert.ok(conversation);
			await conversation.submit({ type: "input", requestId: "held-owner", content: "Held owner" }, BACKGROUND_CONTEXT);
			await control.held;
			const first = await host.request("submit", { requestId: "stale-plain", message: "Original plain bytes", whenBusy: "followUp" }) as { submissionId: number };
			await host.harness.commit(async (tx) => {
				const row = (await tx.doc(AwaitDoc)).provenance.find((row) => row.requestId === "stale-plain");
				assert.equal(row?.communicationIntent?.noEnvelope, true);
				assert.equal(row?.communicationIntent?.linkedEntryId, undefined);
			}, BACKGROUND_CONTEXT);
			control.release();
			const outcome = await readOutcome(host.harness, first.submissionId as SubmissionId, BACKGROUND_CONTEXT);
			assert.ok(outcome.entryId);
			assert.equal(await snapshot(CommunicationIndexDoc, communicationIndexKey(storageId, ROOT, String(outcome.entryId)), BACKGROUND_CONTEXT), undefined);
			await host.harness.commit(async (tx) => {
				const state = await tx.doc(AwaitDoc);
				for (let index = state.provenance.length; index < AWAIT_PROVENANCE_LIMIT; index++) state.provenance.push({ conversationId: ROOT, requestId: `plain-filler-${index}`, classification: "explicit" });
				await recordInputProvenance(tx, { conversationId: ROOT, requestId: "plain-overflow", classification: "explicit" });
				assert.equal(state.provenance.some((row) => row.requestId === "stale-plain"), false);
			}, BACKGROUND_CONTEXT);
			const point = await snapshot(CommunicationIndexDoc, communicationIndexKey(storageId, ROOT, String(outcome.entryId)), BACKGROUND_CONTEXT);
			assert.equal(point?.noEnvelope, true);
			assert.equal(point?.recordEntryId, undefined);
			assert.equal(point?.invalid, undefined);
			const before = await conversation.entries({}, 32, undefined, BACKGROUND_CONTEXT);
			resume.resolve();
			assert.equal((await later).submissionId, first.submissionId);
			const after = await conversation.entries({}, 32, undefined, BACKGROUND_CONTEXT);
			assert.deepEqual(after.items, before.items);
			assert.equal(after.items.find((entry) => entry.id === outcome.entryId)?.model?.[0]?.content, "Original plain bytes");
			assert.equal(after.items.some((entry) => entry.kind === "agent.communication"), false);
			const page = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
			assert.deepEqual(page.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, { state: "unresolved" });
		} finally { resume.resolve(); control.release(); await later; }
	}, control.models);
});

for (const status of ["done", "placed"] as const) it(`reconstructs ${status} capture before post-native classification prunes materializing rows`, { timeout: 60_000 }, async (t) => {
	const control = await controlledRuntime(status === "placed" ? AWAIT_PROVENANCE_LIMIT + 1 : 0);
	await withHost(async (host, storageId) => {
		try {
			const snapshot = host.harness.snapshot.bind(host.harness);
			t.mock.method(host.harness, "snapshot", async (...args: unknown[]) => args[0] === AwaitDoc ? undefined : Reflect.apply(snapshot, host.harness, args));
			const inputs = await terminalInputs(host, "combined"), appended = observePrune(t, host, inputs);
			const original = host.harness.conversation.bind(host.harness);
			let prunedBeforeCapture = false;
			t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof original>) => {
				const conversation = await original(...args);
				if (conversation !== undefined) {
					// The race runs after the commit that admits the input and before its capture commit.
					const submit = conversation.submit.bind(conversation) as (...args: unknown[]) => Promise<unknown>;
					const commit = conversation.commit.bind(conversation) as (...args: unknown[]) => Promise<unknown>;
					let admittedId: SubmissionId | undefined, raced = false;
					t.mock.method(conversation, "submit", async (...args: unknown[]) => {
						const value = await submit(...args);
						const draft = (args[0] as { type?: unknown }).type === undefined ? args[1] as Durable.SubmissionDraft : args[0] as Durable.SubmissionDraft;
						if (draft.requestId === "capture-race" && typeof value === "number") admittedId = value as SubmissionId;
						return value;
					});
					t.mock.method(conversation, "commit", async (...args: unknown[]) => {
						const value = await commit(...args);
						if (admittedId !== undefined && !raced) {
							raced = true;
							const submission = await host.harness.submission(admittedId, BACKGROUND_CONTEXT);
							assert.ok(submission !== undefined);
							if (status === "placed") await control.held;
							else await readOutcome(host.harness, submission.id, BACKGROUND_CONTEXT);
							assert.equal((await submission.status(BACKGROUND_CONTEXT)).status, status);
							await host.harness.commit(async (tx) => {
								const state = await tx.doc(AwaitDoc);
								for (let index = state.provenance.length; index < AWAIT_PROVENANCE_LIMIT; index++) state.provenance.push({ conversationId: ROOT, requestId: `uncaptured-${index}`, classification: "explicit" });
								await recordInputProvenance(tx, { conversationId: ROOT, requestId: "prune-race", classification: "explicit" });
								prunedBeforeCapture = !state.provenance.some((row) => row.requestId === "capture-race");
								state.provenance.splice(0, state.provenance.length, ...stagedRows(inputs, storageId));
								assert.equal(state.provenance.length, AWAIT_PROVENANCE_LIMIT);
							}, BACKGROUND_CONTEXT);
						}
						return value;
					});
				}
				return conversation;
			});
			const admitted = await host.request("submit", { requestId: "capture-race", message: "Original bytes", communication }) as { submissionId: number };
			assert.equal(prunedBeforeCapture, true);
			assert.deepEqual(new Set(appended), new Set(inputs.map((input) => input.requestId)));
			assert.equal(appended.length, AWAIT_PROVENANCE_LIMIT);
			const state = await host.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(AwaitDoc))) as AwaitState, BACKGROUND_CONTEXT);
			assert.deepEqual(state.provenance.map((row) => row.requestId), ["capture-race"]);
			const captured = state.provenance[0];
			assert.equal(captured?.submissionId, admitted.submissionId);
			assert.equal(captured?.communicationIntent?.value?.recordedAt, 17);
			assert.ok(captured?.communicationIntent?.linkedEntryId);
			const page = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
			assert.equal(parseCommunicationView(page.entries.find((entry) => entry.id === captured.communicationIntent?.linkedEntryId)?.communication)?.state, "ready");
			await assertCompanions(host, storageId, inputs);
		} finally { control.release(); }
	}, control.models);
});

for (const plain of [false, true]) it(`materializes placed ${plain ? "no-envelope decisions" : "communication intent"} before provenance eviction`, async () => {
	const control = await controlledRuntime(1);
	await withHost(async (host, storageId) => {
		try {
			const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
			assert.ok(conversation);
			const requestId = "placed-intent", message = "Unchanged native input";
			const submitted = await conversation.submit({ type: "input", requestId, content: message }, BACKGROUND_CONTEXT);
			await control.held;
			const status = await submitted.status(BACKGROUND_CONTEXT);
			assert.equal(status.status, "placed"); assert.ok(status.entry);
			await host.harness.commit(async (tx) => {
				const state = await tx.doc(AwaitDoc);
				state.provenance.push({ conversationId: ROOT, requestId, classification: "explicit", submissionId: submitted.id,
					communicationIntent: plain ? { storageId, noEnvelope: true } : { storageId, ...retainCommunicationIntent(communication, () => 17) } });
				for (let index = state.provenance.length; index < AWAIT_PROVENANCE_LIMIT; index++) state.provenance.push({ conversationId: ROOT, requestId: `absent-${index}`, classification: "explicit" });
				await recordInputProvenance(tx, { conversationId: ROOT, requestId: "new-admission", classification: "explicit" });
				assert.equal(state.provenance.some((row) => row.requestId === requestId), false);
			}, BACKGROUND_CONTEXT);
			const point = await host.harness.snapshot(CommunicationIndexDoc, communicationIndexKey(storageId, ROOT, String(status.entry)), BACKGROUND_CONTEXT);
			assert.equal(point?.target?.requestId, requestId);
			assert.equal(point?.noEnvelope, plain ? true : undefined);
			assert.equal(point?.invalid, undefined);
			const entries = await conversation.entries({}, 10, undefined, BACKGROUND_CONTEXT);
			assert.equal(entries.items.find((entry) => entry.id === status.entry)?.model?.[0]?.content, message);
			const records = entries.items.filter((entry) => entry.kind === "agent.communication");
			assert.equal(records.length, plain ? 0 : 1);
			if (!plain) {
				const record = records[0]; assert.ok(record);
				assert.equal(point?.recordEntryId, String(record.id));
				assert.deepEqual((record.data as { value?: Communication }).value, { ...communication, recordedAt: 17 });
			}
			assert.equal((await submitted.status(BACKGROUND_CONTEXT)).status, "placed");
		} finally { control.release(); }
	}, control.models);
});

it("materializes exact distinct terminal companions while every candidate remains present before eviction", { timeout: 60_000 }, async (t) => {
	await withHost(async (host, storageId) => {
		const snapshot = host.harness.snapshot.bind(host.harness);
		t.mock.method(host.harness, "snapshot", async (...args: unknown[]) => args[0] === AwaitDoc ? undefined : Reflect.apply(snapshot, host.harness, args));
		const inputs = await terminalInputs(host, "burst"), appended = observePrune(t, host, inputs);
		await host.harness.commit(async (tx) => {
			const state = await tx.doc(AwaitDoc);
			assert.equal(state.provenance.length, 0);
			state.provenance.push(...stagedRows(inputs, storageId));
		}, BACKGROUND_CONTEXT);
		const overflow = await host.request("submit", { requestId: "burst-overflow", message: "Original overflow", communication }) as { submissionId: number };
		assert.equal(appended.length, AWAIT_PROVENANCE_LIMIT);
		assert.deepEqual(new Set(appended), new Set(inputs.map((input) => input.requestId)));
		const state = await host.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(AwaitDoc))) as AwaitState, BACKGROUND_CONTEXT);
		assert.deepEqual(state.provenance.map((row) => row.requestId), ["burst-overflow"]);
		assert.equal(state.provenance[0]?.submissionId, overflow.submissionId);
		assert.ok(state.provenance.length <= AWAIT_PROVENANCE_LIMIT);
		await assertCompanions(host, storageId, inputs);
	});
});

it("retains queued report classifications and communication beyond collection across reopen and placement", { timeout: 60_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "queued-communication-")), storageId = randomUUID();
	const initial = await controlledRuntime(1), resumed = await controlledRuntime(1);
	let host = await openFixtureHost(root, storageId, initial.models), initialReleased = false, resumedReleased = false;
	t.after(async () => { if (!initialReleased) initial.release(); if (!resumedReleased) resumed.release(); await host.close(); rmSync(root, { recursive: true, force: true }); });
	await host.request("submit", { requestId: "pending-owner", message: "Pending owner" });
	await initial.held;
	const requests: { requestId: string; submissionId: number; message: string }[] = [];
	for (let index = 0; index <= AWAIT_PROVENANCE_LIMIT; index++) {
		const requestId = `queued-report-${index}`, message = `Original report ${index}`;
		const admitted = await host.request("submit", { requestId, message, whenBusy: "followUp", provenance: { classification: "report", sender }, communication: { ...communication, body: { ...communication.body, text: message }, metadata: { sourceId: `report:${requestId}`, requestId } } }) as { submissionId: number };
		requests.push({ requestId, submissionId: admitted.submissionId, message });
	}
	const assertQueued = async () => {
		const state = await host.harness.snapshot(AwaitDoc, BACKGROUND_CONTEXT);
		const inbox = await host.harness.snapshot(InboxDoc, ROOT, BACKGROUND_CONTEXT);
		assert.ok(state && inbox);
		assert.deepEqual(inbox.items.filter((item) => item.mode !== "write").map((item) => item.id), requests.map((request) => request.submissionId));
		for (const request of requests) {
			const row: AwaitState["provenance"][number] | undefined = state.provenance.find((item) => item.requestId === request.requestId);
			assert.equal(row?.classification, "report"); assert.equal(row?.sender, sender);
			assert.equal(row?.communicationIntent?.value?.body.text, request.message);
			assert.equal(row?.communicationIntent?.linkedEntryId, undefined);
			const submission = await host.harness.commit((tx) => tx.submissionByRequest(ROOT, request.requestId), BACKGROUND_CONTEXT);
			assert.equal(submission?.id, request.submissionId); assert.equal(submission?.status, "queued"); assert.equal(submission?.entry, undefined);
		}
		return state.provenance;
	};
	const before = await assertQueued();
	await host.close();
	initial.release(); initialReleased = true;
	host = await openFixtureHost(root, storageId, resumed.models, false);
	assert.deepEqual(await assertQueued(), before);
	const replay = await host.request("submit", { requestId: requests[0].requestId, message: requests[0].message, whenBusy: "followUp", provenance: { classification: "report", sender }, communication: { ...communication, body: { ...communication.body, text: requests[0].message }, metadata: { sourceId: `report:${requests[0].requestId}`, requestId: requests[0].requestId } } }) as { submissionId: number };
	assert.equal(replay.submissionId, requests[0].submissionId);
	await host.resume();
	await resumed.held;
	await assertQueued();
	resumed.release(); resumedReleased = true;
	const last = requests.at(-1); assert.ok(last);
	await readOutcome(host.harness, last.submissionId as SubmissionId, BACKGROUND_CONTEXT);
	await reconcileInputCommunications(host.harness, storageId, BACKGROUND_CONTEXT);
	const first = await host.harness.commit((tx) => tx.submissionByRequest(ROOT, requests[0].requestId), BACKGROUND_CONTEXT);
	assert.ok(first?.entry);
	const page = await readConversationSnapshotPage(host.harness, ROOT, { before: (first.entry + 1) as NonNullable<Parameters<typeof readConversationSnapshotPage>[2]["before"]> }, BACKGROUND_CONTEXT, storageId);
	const view = parseCommunicationView(page.entries.find((entry) => entry.id === String(first.entry))?.communication);
	assert.equal(view?.state, "ready");
	if (view?.state !== "ready") throw new Error("Queued communication did not bind after placement");
	assert.equal(view.value.body.text, requests[0].message); assert.equal(view.value.sender.identity, sender); assert.equal(view.target.requestId, requests[0].requestId);
	assert.equal(page.entries.find((entry) => entry.id === String(first.entry))?.model?.[0]?.content, requests[0].message);
	const next = await host.request("submit", { requestId: "after-drain", message: "After drain" }) as { submissionId: number };
	await readOutcome(host.harness, next.submissionId as SubmissionId, BACKGROUND_CONTEXT);
	const after = await host.harness.snapshot(AwaitDoc, BACKGROUND_CONTEXT);
	assert.equal(after?.provenance.some((row) => requests.some((request) => request.requestId === row.requestId)), false);
});

it("retains the same verified association across close and reopen", async () => {
	await withHost(async (host, storageId, root) => {
		const submitted = await host.request("submit", { requestId: "reopen", message: "Native input", communication }) as { submissionId: number };
		const outcome = await readOutcome(host.harness, submitted.submissionId as Parameters<typeof readOutcome>[1], BACKGROUND_CONTEXT);
		await reconcileInputCommunications(host.harness, storageId, BACKGROUND_CONTEXT);
		const before = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		await host.close();
		const reopened = await openFixtureHost(root, storageId);
		try {
			const after = await readConversationSnapshotPage(reopened.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
			assert.deepEqual(after.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, before.entries.find((entry) => entry.id === String(outcome.entryId))?.communication);
			const conversation = await reopened.harness.conversation(ROOT, BACKGROUND_CONTEXT);
			assert.ok(conversation);
			assert.equal((await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.filter((entry) => entry.kind === "agent.communication").length, 1);
		} finally { await reopened.close(); }
	});
});

it("bounds added views without removing native passive rows", async () => {
	await withHost(async (host, storageId) => {
		for (let index = 0; index < 20; index++) {
			await host.request("passive-submit", { requestId: `bounded-${index}`, message: `Native ${index}`, communication: { ...communication, kind: "notice", body: { text: "🙂".repeat(3_600), complete: false, redacted: false }, metadata: { threadId: "thread", passive: true } } });
		}
		const page = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		assert.equal(page.entries.length, 20);
		assert.equal(page.entries.every((entry) => entry.data === undefined), true);
		const conversation = await host.harness.conversation(ROOT, BACKGROUND_CONTEXT);
		assert.ok(conversation);
		const native = await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
		assert.equal(JSON.stringify(native.items[0]?.data).includes("🙂".repeat(3_600)), true);
		const views = page.entries.map((entry) => parseCommunicationView(entry.communication));
		assert.equal(views.every((view) => view !== undefined), true);
		assert.ok(views.some((view) => view?.state === "ready"));
		assert.ok(views.some((view) => view?.state === "unavailable" && view.reason === "limit"));
		assert.ok(views.reduce((bytes, view) => bytes + Buffer.byteLength(JSON.stringify(view)), 0) <= 65_536);
		assert.deepEqual(page.entries.map((entry) => entry.model?.[0]?.content), Array.from({ length: 20 }, (_, index) => `Native ${index}`));
	});
});

it("changes snapshot and live revisions when only the communication index changes", async () => {
	await withHost(async (host, storageId) => {
		const first = await host.request("submit", { requestId: "revision", message: "Input", communication }) as { submissionId: number };
		const outcome = await readOutcome(host.harness, first.submissionId as Parameters<typeof readOutcome>[1], BACKGROUND_CONTEXT);
		await reconcileInputCommunications(host.harness, storageId, BACKGROUND_CONTEXT);
		assert.ok(outcome.entryId);
		const snapshot = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		const opened = await host.request("observe-open", { token: "revision", scope: "conversation" }) as { frame: ConversationFrame };
		await host.harness.commit(async (tx) => {
			const index = await tx.doc(CommunicationIndexDoc, communicationIndexKey(storageId, ROOT, String(outcome.entryId)), null);
			index.recordEntryId = String(outcome.entryId);
		}, BACKGROUND_CONTEXT);
		const next = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		assert.deepEqual(next.entries.map((entry) => entry.id), snapshot.entries.map((entry) => entry.id));
		assert.notEqual(next.revision, snapshot.revision);
		assert.deepEqual(next.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, { state: "unavailable", reason: "invalid" });
		const frame = await host.request("observe-frame", { token: "revision" }) as ConversationFrame;
		assert.ok(frame.revision > opened.frame.revision);
		assert.deepEqual(frame.entries.find((entry) => entry.id === String(outcome.entryId))?.communication, { state: "unavailable", reason: "invalid" });
		await host.request("observe-close", { token: "revision" });
	});
});

it("continues an all-bookkeeping bounded page from the native scan", async () => {
	await withHost(async (host, storageId) => {
		const newest = await host.harness.commit(async (tx) => {
			let id = 0;
			for (let index = 0; index < 513; index++) id = (await tx.appendEntry(ROOT, { kind: "agent.communication", data: { fixture: index } })).id;
			return id;
		}, BACKGROUND_CONTEXT);
		const page = await readConversationSnapshotPage(host.harness, ROOT, { before: (newest + 1) as NonNullable<Parameters<typeof readConversationSnapshotPage>[2]["before"]> }, BACKGROUND_CONTEXT, storageId);
		assert.deepEqual(page.entries, []);
		assert.equal(page.coverage.complete, false);
		assert.equal(page.coverage.hiddenExcluded, 512);
		assert.ok(page.nextBefore !== null && page.nextBefore < newest);
		const older = await readConversationSnapshotPage(host.harness, ROOT, { before: page.nextBefore as NonNullable<Parameters<typeof readConversationSnapshotPage>[2]["before"]> }, BACKGROUND_CONTEXT, storageId);
		assert.equal(older.coverage.complete, true);
		assert.equal(older.coverage.hiddenExcluded, 1);
	});
});
