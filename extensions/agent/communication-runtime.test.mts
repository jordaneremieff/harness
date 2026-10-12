import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, completed, pending, fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { readOutcome, reconcileDeliveries } from "./durable-controls.ts";
import * as Durable from "@earendil-works/pi-durable";
import { createAgentContribution } from "./durable-agents.ts";
import { CommunicationIndexDoc, communicationIndexKey, reconcileInputCommunications, retainCommunicationIntent } from "./communication-retention.ts";
import { AwaitDoc, AWAIT_PROVENANCE_LIMIT, recordInputProvenance, type AwaitState } from "./awaited-results.ts";
import type { ConversationFrame } from "./live-frames.ts";
import { parseCommunicationView, type Communication } from "./communication.ts";
import { InspectOutputSchema } from "./observation-schema.ts";
import { readInspection, readConversationSnapshotPage } from "./durable-observation.ts";
import { communicationText } from "./dashboard-conversation.ts";

const ROOT = 1 as ConversationId;
const sender = "7f7f7f7f-1111-4222-8333-444444444444";
const communication: Communication = { format: "agent.communication/1", kind: "report", sender: { identity: sender, name: "Peer" }, body: { text: "Source body", complete: false, redacted: false }, recordedAt: 0, metadata: { sourceId: "report:source", requestId: "source" } };

function openFixtureHost(root: string, storageId: string, supplied?: Models): Promise<DurableHost> {
	return (supplied === undefined ? fixtureRuntime("answer") : Promise.resolve(supplied)).then((models) => DurableHost.open({ storagePath: join(root, "storage.sqlite"), storageId, cwd: root, models, registry: fixtureRegistry(), agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } }, resume: true, now: () => 17 }));
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
		assert.equal(Value.Check(InspectOutputSchema, root), true);
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
		assert.equal(Value.Check(InspectOutputSchema, missing), true);
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
		assert.equal(Value.Check(tool.parameters, args), true);
		const output = await tool.execute(args, {} as never, BACKGROUND_CONTEXT);
		assert.notEqual(output.isError, true);
		const text = output.content?.find((part) => part.type === "text");
		assert.ok(text?.type === "text");
		const parsed = JSON.parse(text.text) as { submissionId: number; requestId: string; answer: string };
		assert.equal(parsed.submissionId, admitted.submissionId);
		assert.equal(parsed.requestId, "terminal-request");
		assert.equal(parsed.answer, "durable answer");
		assert.equal(seen[0]?.requestId, args.requestId);
		const missing = await tool.execute({ sessionId: storageId, view: "result", requestId: "no-terminal-request" }, {} as never, BACKGROUND_CONTEXT);
		assert.notEqual(missing.isError, true);
		const unavailable = missing.content?.find((part) => part.type === "text");
		assert.ok(unavailable?.type === "text");
		assert.equal(JSON.parse(unavailable.text).status, "unavailable");
	});
});

it("joins an admitted input without changing native model bytes or raw inspection", async () => {
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
		assert.equal(input?.data, undefined);
		const snapshot = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
		const view = parseCommunicationView(snapshot.entries.find((entry) => entry.id === String(outcome.entryId))?.communication);
		assert.equal(view?.state, "ready");
		if (view?.state !== "ready") throw new Error("Communication did not bind");
		assert.equal(view.value.recordedAt, 17);
		assert.equal(view.target.mode, "input");
		assert.match(communicationText(view.value), /report from Peer.*Source body/su);
		const history = await readInspection(host.harness, storageId, conversation, { view: "history" }, BACKGROUND_CONTEXT) as { entries: { id: number; kind: string; communication: unknown }[] };
		assert.equal(Value.Check(InspectOutputSchema, history), true);
		assert.equal(history.entries.some((entry) => entry.kind === "agent.communication"), false);
		assert.deepEqual(history.entries.find((entry) => entry.id === outcome.entryId)?.communication, view);
		const branch = await readInspection(host.harness, storageId, conversation, { view: "branch" }, BACKGROUND_CONTEXT) as { entries: { kind: string; communication?: unknown }[] };
		assert.equal(Value.Check(InspectOutputSchema, branch), true);
		assert.equal(branch.entries.some((entry) => entry.kind === "agent.communication"), true);
		assert.equal(branch.entries.some((entry) => entry.communication !== undefined), false);
		const exact = await readInspection(host.harness, storageId, conversation, { view: "exact", entryId: outcome.entryId }, BACKGROUND_CONTEXT) as { text: string };
		assert.equal(JSON.parse(exact.text).model[0].content, message);
		const activity = await readInspection(host.harness, storageId, conversation, { view: "activity" }, BACKGROUND_CONTEXT);
		assert.equal(Value.Check(InspectOutputSchema, activity), true);
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
			t.mock.method(conversation, "commit", async (apply: (tx: Tx) => Promise<unknown>, context: typeof BACKGROUND_CONTEXT) => commit(async (tx) => {
				const state = await tx.doc(AwaitDoc);
				const observed = new Proxy(tx, { get(target, key) {
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
				} });
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
	const streamSimple = () => {
		if (++calls !== pendingAt) return completed(answerMessage());
		const message = answerMessage(), stream = pending(message);
		release = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); };
		held.resolve();
		return stream;
	};
	runtime.registerNativeProvider({ id: fixtureProvider, name: "Controlled retention fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream: streamSimple, streamSimple });
	return { models: runtime, held: held.promise, release: () => release() };
}

for (const abortResult of ["already_placed", "settled", "aborted"] as const) it(`captures before late suppression with native abort result ${abortResult}`, { timeout: 60_000 }, async (t) => {
	const control = await controlledRuntime(abortResult === "settled" ? 2 : 1);
	await withHost(async (host, storageId) => {
		const original = host.harness.conversation.bind(host.harness), wrapped = new WeakSet<object>();
		let nativeAbort: string | undefined, nativeId: number | undefined, nativeAdmissions = 0;
		if (abortResult === "aborted") {
			const owner = await original(ROOT, BACKGROUND_CONTEXT);
			assert.ok(owner);
			await owner.submit({ type: "input", requestId: "held-owner", content: "Held owner" }, BACKGROUND_CONTEXT);
			await control.held;
		}
		t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof original>) => {
			const conversation = await original(...args);
			if (conversation !== undefined && !wrapped.has(conversation)) {
				wrapped.add(conversation);
				const submit = conversation.submit.bind(conversation);
				t.mock.method(conversation, "submit", async (...args: Parameters<typeof submit>) => {
					const submission = await submit(...args);
					if (args[0].requestId !== "late-check-in") return submission;
					nativeAdmissions++;
					nativeId = submission.id;
					if (abortResult === "settled") {
						await readOutcome(host.harness, submission.id, BACKGROUND_CONTEXT);
						await submit({ type: "input", requestId: "held-owner", content: "Held owner" }, BACKGROUND_CONTEXT);
					}
					await control.held;
					await host.harness.commit(async (tx) => {
						const live = await tx.doc(LiveDoc, ROOT);
						assert.ok(live.run);
						const task = await tx.task(live.run.taskId);
						assert.ok(task && task.state.status !== "terminal");
						const state = await tx.doc(AwaitDoc);
						assert.equal(state.declarations.length, 0);
						state.declarations.push({ taskId: live.run.taskId, callId: "active-await", conversationId: ROOT, runId: live.run.taskId, cohort: [], inputs: [...live.run.inputs], results: [{ sessionId: sender, submissionId: 1, requestId: "producer" }], outcomes: [], decision: "awaiting" });
					}, BACKGROUND_CONTEXT);
					const abort = submission.abort.bind(submission);
					t.mock.method(submission, "abort", async (...args: Parameters<typeof abort>) => {
						const state = await host.harness.snapshot(AwaitDoc, BACKGROUND_CONTEXT);
						const captured = state?.provenance.find((row) => row.requestId === "late-check-in");
						assert.equal(captured?.submissionId, submission.id);
						assert.equal(captured?.communicationIntent?.value?.recordedAt, 17);
						assert.equal(captured?.communicationIntent?.linkedEntryId !== undefined, abortResult !== "aborted");
						nativeAbort = await abort(...args);
						return nativeAbort;
					});
					return submission;
				});
			}
			return conversation;
		});
		try {
			const result = await host.request("submit", { requestId: "late-check-in", message: "Original check-in bytes", whenBusy: "followUp", communication, provenance: { classification: "automatic", automaticKind: "checkIn", sender, producerRequestId: "producer" } }) as { submissionId?: number; suppressed?: boolean };
			assert.equal(nativeAbort, abortResult);
			assert.equal(nativeAdmissions, 1);
			assert.ok(nativeId);
			const native = await host.harness.submission(nativeId as SubmissionId, BACKGROUND_CONTEXT);
			const status = await native?.status(BACKGROUND_CONTEXT);
			assert.ok(status?.type === "input");
			if (abortResult === "aborted") {
				assert.deepEqual(result, { suppressed: true });
				assert.equal(status.status, "unanswered");
				assert.equal(status.entry, undefined);
			} else {
				assert.equal(result.submissionId, nativeId);
				assert.ok(status.entry);
				const conversation = await original(ROOT, BACKGROUND_CONTEXT);
				assert.ok(conversation);
				const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
				assert.equal(entries.items.find((entry) => entry.id === status.entry)?.model?.[0]?.content, "Original check-in bytes");
				const page = await readConversationSnapshotPage(host.harness, ROOT, {}, BACKGROUND_CONTEXT, storageId);
				const view = parseCommunicationView(page.entries.find((entry) => entry.id === String(status.entry))?.communication);
				assert.equal(view?.state, "ready");
				if (view?.state !== "ready" || view.target.mode !== "input") throw new Error("Late capture missing");
				assert.deepEqual(view.value, { ...communication, recordedAt: 17 });
				assert.equal(view.target.submissionId, nativeId);
			}
			const conversation = await original(ROOT, BACKGROUND_CONTEXT);
			assert.ok(conversation);
			const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
			assert.equal(entries.items.filter((entry) => entry.kind === "pi.user").length, abortResult === "settled" ? 2 : 1);
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
				t.mock.method(conversation, "commit", async (apply: (tx: Tx) => Promise<unknown>, context: typeof BACKGROUND_CONTEXT) => {
					let negative = false;
					const value = await commit((tx) => apply(new Proxy(tx, { get(target, key) {
						if (key === "submissionByRequest") return async (...args: Parameters<Tx["submissionByRequest"]>) => {
							const submission = await target.submissionByRequest(...args);
							if (args[1] === "stale-plain" && submission === undefined && !held) negative = true;
							return submission;
						};
						const method = Reflect.get(target, key);
						return typeof method === "function" ? method.bind(target) : method;
					} })), context);
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

it("prepares reconstructed capture before a post-native classification prunes materializing terminal rows", { timeout: 60_000 }, async (t) => {
	await withHost(async (host, storageId) => {
		const snapshot = host.harness.snapshot.bind(host.harness);
		t.mock.method(host.harness, "snapshot", async (...args: unknown[]) => args[0] === AwaitDoc ? undefined : Reflect.apply(snapshot, host.harness, args));
		const inputs = await terminalInputs(host, "combined"), appended = observePrune(t, host, inputs);
		const original = host.harness.conversation.bind(host.harness);
		let prunedBeforeCapture = false;
		t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof original>) => {
			const conversation = await original(...args);
			if (conversation !== undefined) {
				const submit = conversation.submit.bind(conversation);
				t.mock.method(conversation, "submit", async (...args: Parameters<typeof submit>) => {
					const submission = await submit(...args);
					if (args[0].requestId === "capture-race") {
						await readOutcome(host.harness, submission.id, BACKGROUND_CONTEXT);
						await host.harness.commit(async (tx) => {
							const state = await tx.doc(AwaitDoc);
							for (let index = state.provenance.length; index < AWAIT_PROVENANCE_LIMIT; index++) state.provenance.push({ conversationId: ROOT, requestId: `uncaptured-${index}`, classification: "explicit" });
							await recordInputProvenance(tx, { conversationId: ROOT, requestId: "prune-race", classification: "explicit" });
							prunedBeforeCapture = !state.provenance.some((row) => row.requestId === "capture-race");
							state.provenance.splice(0, state.provenance.length, ...stagedRows(inputs, storageId));
							assert.equal(state.provenance.length, AWAIT_PROVENANCE_LIMIT);
						}, BACKGROUND_CONTEXT);
					}
					return submission;
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
	});
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
