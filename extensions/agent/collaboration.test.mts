import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, ROOT_CONVERSATION_ID, type LiveState } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { discoverCollaboration } from "./collaboration-discovery.ts";
import { type CollaborationPage, listCollaboration, mutateCollaboration, projectCollaboration, readCollaboration } from "./collaboration.ts";
import { AgentDeliveryDoc, acknowledgeReports } from "./durable-controls.ts";
import { DurableHost } from "./durable-host.ts";
import { DurableObservation, readConversationStatus } from "./durable-observation.ts";
import { fixtureRegistry, fixtureRuntime, hostOptions, toolCallMessage } from "./durable-host-fixture.mts";
import { ConversationStatusSchema, structuredObservation } from "./observation-schema.ts";

const context = BACKGROUND_CONTEXT;
const actor = randomUUID();
const peer = randomUUID();
const frame = { title: "Protocol design", purpose: "Keep peers useful across process restarts", authority: "Implement the requested current contracts", source: "Operator task source", restrictions: "Do not change external systems", acceptance: "A peer exchange survives host replacement" };

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-collaboration-"));
	const storageId = randomUUID();
	const storagePath = join(root, "host.sqlite");
	const options = { ...hostOptions(storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId };
	let host = await DurableHost.open(options, context);
	t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
	return { root, storageId, storagePath, get host() { return host; }, async reopen() { await host.close(); host = await DurableHost.open(options, context); return host; } };
}
function mutation(action: string, requestId: string, fields: Record<string, unknown> = {}) {
	return { action, requestId, senderIdentity: actor, origin: "model", ...fields };
}

it("retains a shared frame and deduplicates the same mutation without any model admission", async (t) => {
	const f = await fixture(t);
	const input = mutation("create", "create", frame);
	const first = await mutateCollaboration(f.host.harness, f.storageId, input, context);
	const replay = await mutateCollaboration(f.host.harness, f.storageId, input, context);
	assert.deepEqual(replay, { ...first, deduped: true });
	assert.equal((await f.host.harness.inspect(context)).submissions.length, 0);
	assert.equal((await f.host.harness.snapshot(AgentDeliveryDoc, context))?.reports.length ?? 0, 0);
	await assert.rejects(mutateCollaboration(f.host.harness, f.storageId, { ...input, title: "Changed" }, context), /different content/u);
	await f.reopen();
	const page = await readCollaboration(f.host.harness, { threadId: first.threadId }, context);
	assert.equal(page.thread.purpose, frame.purpose);
	assert.equal(page.events[0].sender, actor);
	assert.equal(page.events[0].origin, "model");
	assert.equal(page.thread.integrator, actor);
});

it("keeps request IDs distinct across peer storages and permits self-chosen contribution changes", async (t) => {
	const f = await fixture(t);
	const created = await mutateCollaboration(f.host.harness, f.storageId, mutation("create", "same-task", frame), context);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("join", "same-task", { threadId: created.threadId, senderIdentity: peer, contribution: "Challenge the method contracts" }), context);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("join", "revise-participation", { threadId: created.threadId, senderIdentity: peer, contribution: "Test independent restarts" }), context);
	let page = await readCollaboration(f.host.harness, { threadId: created.threadId }, context);
	assert.equal(page.thread.members.length, 2);
	assert.equal(page.thread.members[1].contribution, "Test independent restarts");
	await mutateCollaboration(f.host.harness, f.storageId, mutation("leave", "leave", { threadId: created.threadId, senderIdentity: peer }), context);
	page = await readCollaboration(f.host.harness, { threadId: created.threadId }, context);
	assert.deepEqual(page.thread.members.map((member) => member.identity), [actor]);
	assert.deepEqual(page.events.map((event) => event.kind), ["create", "join", "join", "leave"]);
});

it("writes notification intents with the event and retains source-qualified deduplication after reopen", async (t) => {
	const f = await fixture(t);
	const created = await mutateCollaboration(f.host.harness, f.storageId, mutation("create", "create", frame), context);
	for (const invalid of [`${actor}:1`, `${peer}:9007199254740992`]) await assert.rejects(mutateCollaboration(f.host.harness, f.storageId, mutation("post", `invalid-${invalid}`, { threadId: created.threadId, message: "Invalid recipient", notify: [invalid] }), context), /exact discovered identity/u);
	const post = mutation("post", "post", { threadId: created.threadId, message: "Please challenge this boundary.", notify: [peer, peer, actor] });
	const receipt = await mutateCollaboration(f.host.harness, f.storageId, post, context);
	let ledger = await f.host.harness.snapshot(AgentDeliveryDoc, context);
	assert.equal(ledger?.reports.length, 1);
	assert.equal(ledger?.reports[0].ownerId, peer);
	assert.equal(ledger?.reports[0].direct, true);
	assert.equal(ledger?.reports[0].steer, true);
	assert.ok(ledger);
	assert.match(ledger.reports[0].requestId, new RegExp(f.storageId));
	await f.reopen();
	assert.equal((await mutateCollaboration(f.host.harness, f.storageId, post, context)).deduped, true);
	ledger = await f.host.harness.snapshot(AgentDeliveryDoc, context);
	assert.equal(ledger?.reports.length, 1);
	const page = await readCollaboration(f.host.harness, { threadId: created.threadId }, context);
	assert.equal(page.pending, 1);
	assert.equal(page.events.at(-1)?.sequence, receipt.sequence);
	assert.ok(ledger);
	const sourceId = ledger.reports[0].sourceId;
	assert.deepEqual(await acknowledgeReports(f.host.harness, peer, [sourceId], context), [sourceId]);
	assert.deepEqual(await acknowledgeReports(f.host.harness, peer, [sourceId], context), []);
	await f.reopen();
	assert.equal((await readCollaboration(f.host.harness, { threadId: created.threadId }, context)).pending, 0);
});

it("distinguishes carried authority from claims and keeps governing revisions and restrictions visible", async (t) => {
	const f = await fixture(t);
	const created = await mutateCollaboration(f.host.harness, f.storageId, mutation("create", "create", frame), context);
	await assert.rejects(mutateCollaboration(f.host.harness, f.storageId, mutation("post", "bad-authority", { threadId: created.threadId, message: "Approved", kind: "carried-authority" }), context), /source/u);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("post", "authority", { threadId: created.threadId, message: "The operator retains the publication restriction.", kind: "carried-authority", source: "Operator task, restriction paragraph" }), context);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("join", "join", { threadId: created.threadId, senderIdentity: peer }), context);
	await assert.rejects(mutateCollaboration(f.host.harness, f.storageId, mutation("revise", "bad-frame", { ...frame, threadId: created.threadId, senderIdentity: peer }), context), /creator, integrator or operator/u);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("revise", "frame", { ...frame, threadId: created.threadId, purpose: "Verify compatible current contracts", integrator: peer }), context);
	const page = await readCollaboration(f.host.harness, { threadId: created.threadId }, context);
	assert.equal(page.thread.revision, 2);
	assert.equal(page.thread.restrictions, frame.restrictions);
	assert.equal(page.events[1].kind, "carried-authority");
	assert.equal(page.events[1].revision, 1);
	assert.equal(page.events.at(-1)?.revision, 2);
});

it("pages the retained exchange, rejects invalid references atomically and retains closed threads", async (t) => {
	const f = await fixture(t);
	const created = await mutateCollaboration(f.host.harness, f.storageId, mutation("create", "create", frame), context);
	for (let n = 0; n < 6; n++) await mutateCollaboration(f.host.harness, f.storageId, mutation("post", `post-${n}`, { threadId: created.threadId, message: "x".repeat(8000), replyTo: 1 }), context);
	const latest = await readCollaboration(f.host.harness, { threadId: created.threadId, limit: 20 }, context);
	assert.ok(latest.nextBefore !== null);
	assert.ok(latest.coverage.bytes <= 48 * 1024);
	const older = await readCollaboration(f.host.harness, { threadId: created.threadId, before: latest.nextBefore, limit: 20 }, context);
	assert.equal(older.events[0].sequence, 1);
	const lastOlder = older.events.at(-1);
	assert.ok(lastOlder);
	assert.equal(lastOlder.sequence + 1, latest.events[0].sequence);
	await assert.rejects(mutateCollaboration(f.host.harness, f.storageId, mutation("post", "invalid-reply", { threadId: created.threadId, message: "Bad reference", replyTo: 500 }), context), /earlier event/u);
	assert.equal((await readCollaboration(f.host.harness, { threadId: created.threadId }, context)).thread.sequence, 7);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("close", "close", { threadId: created.threadId, message: "The arrangement reached its outcome." }), context);
	assert.equal((await readCollaboration(f.host.harness, { threadId: created.threadId }, context)).thread.closed, true);
	await assert.rejects(mutateCollaboration(f.host.harness, f.storageId, mutation("post", "after-close", { threadId: created.threadId, message: "No" }), context), /closed/u);
	assert.equal((await listCollaboration(f.host.harness, {}, context)).items[0].closed, true);
});

it("reads retained threads through the cold observation path without scheduling a model", async (t) => {
	const f = await fixture(t);
	const created = await mutateCollaboration(f.host.harness, f.storageId, mutation("create", "create", frame), context);
	await f.host.close();
	const cold = await DurableObservation.open({ backupFrom: f.storagePath, storageId: f.storageId, models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	try {
		const page = await cold.request("collaboration-read", { threadId: created.threadId }) as CollaborationPage;
		assert.equal(page.thread.title, frame.title);
		assert.equal(page.events.length, 1);
		await assert.rejects(cold.request("collaboration-mutate", {}), /does not support/u);
	} finally { await cold.close(); }
});

it("discovers bounded purpose hints without opening hosts and names omitted stores for scoped continuation", async (t) => {
	const f = await fixture(t);
	const catalog = new AgentCatalog(f.root);
	const record = catalog.create({ cwd: f.root, agentDir: f.root, packageDir: f.root, model: { provider: "test", modelId: "test" }, thinkingLevel: "off" });
	for (let n = 0; n < 10; n++) await mutateCollaboration(f.host.harness, record.storageId, mutation("create", `create-${n}`, { ...frame, title: `Thread ${n}` }), context);
	const projection = await projectCollaboration(f.host.harness, context);
	catalog.updateView(record.storageId, { updatedAt: new Date().toISOString(), rows: [], coverage: { complete: true, omitted: 0 } }, projection);
	const page = await discoverCollaboration(catalog, { limit: 2 });
	assert.equal(page.items.length, 2);
	assert.equal(page.coverage.omitted, 2);
	assert.equal(page.sources[0].sessionId, record.storageId);
	assert.ok(page.nextCursor);
	const next = await discoverCollaboration(catalog, { limit: 2, cursor: page.nextCursor });
	assert.equal(next.items.length, 2);
	assert.notEqual(next.items[0].id, page.items[0].id);
	assert.equal((await listCollaboration(f.host.harness, {}, context)).items.length, 10);
});

it("bounds serialized event and read bytes independently of character and row counts", async (t) => {
	const f = await fixture(t);
	const created = await mutateCollaboration(f.host.harness, f.storageId, mutation("create", "create", frame), context);
	await assert.rejects(mutateCollaboration(f.host.harness, f.storageId, mutation("post", "oversized", { threadId: created.threadId, message: "\u0001".repeat(8000), notify: [peer] }), context), /byte bound/u);
	assert.equal((await readCollaboration(f.host.harness, { threadId: created.threadId }, context)).thread.sequence, 1);
	assert.equal((await f.host.harness.snapshot(AgentDeliveryDoc, context))?.reports.length ?? 0, 0);
	for (let index = 0; index < 12; index++) await mutateCollaboration(f.host.harness, f.storageId, mutation("post", `post-${index}`, { threadId: created.threadId, message: "x".repeat(8000) }), context);
	let before: number | undefined;
	const sequences: number[] = [];
	for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
		const page = await readCollaboration(f.host.harness, { threadId: created.threadId, limit: 20, ...(before === undefined ? {} : { before }) }, context);
		const bytes = Buffer.byteLength(JSON.stringify(page));
		assert.ok(bytes <= 48 * 1024);
		assert.equal(page.coverage.bytes, bytes);
		sequences.unshift(...page.events.map((event) => event.sequence));
		if (page.nextBefore === null) break;
		before = page.nextBefore;
	}
	assert.deepEqual(sequences, Array.from({ length: 13 }, (_, index) => index + 1));
});

it("uses native passive writes without a model turn and deduplicates replay", async (t) => {
	const f = await fixture(t);
	const input = { message: "A joined thread has a new contribution. Read its current frame.", requestId: "thread-notice" };
	const first = await f.host.request("passive-submit", input) as { submissionId: number };
	const replay = await f.host.request("passive-submit", input) as { submissionId: number };
	assert.equal(replay.submissionId, first.submissionId);
	const conversation = await f.host.harness.conversation(ROOT_CONVERSATION_ID, context);
	assert.ok(conversation);
	const entries = await conversation.entries({}, 20, undefined, context);
	assert.equal(entries.items.filter((entry) => entry.kind === "agent.thread-notice").length, 1);
	assert.equal(entries.items.some((entry) => entry.kind === "pi.assistant"), false);
	assert.equal((await f.host.harness.inspect(context)).tasks.length, 0);
	await f.reopen();
	const retained = await f.host.request("passive-submit", input) as { submissionId: number };
	assert.equal(retained.submissionId, first.submissionId);
});

it("joining subscribes to bounded passive notices while explicit attention remains distinct", async (t) => {
	const f = await fixture(t);
	const created = await mutateCollaboration(f.host.harness, f.storageId, mutation("create", "create", frame), context);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("join", "join", { threadId: created.threadId, senderIdentity: peer }), context);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("post", "quiet-post", { threadId: created.threadId, message: "x".repeat(8000) }), context);
	await mutateCollaboration(f.host.harness, f.storageId, mutation("post", "attention", { threadId: created.threadId, message: "Please challenge this decision.", notify: [peer] }), context);
	const ledger = await f.host.harness.snapshot(AgentDeliveryDoc, context);
	assert.ok(ledger);
	const notices = ledger.reports.filter((report) => report.ownerId === peer);
	assert.equal(notices.length, 2);
	assert.equal(notices[0].passive, true);
	assert.equal(notices[0].steer, false);
	assert.ok(notices[0].message.length < 1500);
	assert.equal(notices[1].passive, false);
	assert.equal(notices[1].steer, true);
});

it("publishes valid status while a provider retains parsing scratch on a live tool call", async (t) => {
	const f = await fixture(t);
	const message = toolCallMessage("read", { path: "file" });
	const block = message.content[0];
	Object.assign(block, { partialJson: '{"path":', customInput: { property: "code", jsonBuffer: "{" } });
	await f.host.harness.commit(async (tx) => { const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID); live.generation = JSON.parse(JSON.stringify({ attempt: 1, message })); }, context);
	const status = await readConversationStatus(f.host.harness, f.storageId, ROOT_CONVERSATION_ID, {}, context);
	assert.ok(status);
	assert.doesNotThrow(() => structuredObservation(ConversationStatusSchema, status));
	const projected = status.live as LiveState;
	assert.ok(projected.generation?.message);
	assert.equal("partialJson" in projected.generation.message.content[0], false);
	const raw = await f.host.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
	assert.ok(raw?.generation?.message);
	assert.equal("partialJson" in raw.generation.message.content[0], true, "read projection never mutates native state");
});
