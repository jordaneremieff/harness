import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { AgentDeliveryDoc, recordDeliveryIntent, reconcileDeliveries, type DeliveryReceipt } from "./durable-controls.ts";
import { classifyDelivery, observeDeliveryEligibility, startDurableDelivery } from "./durable-delivery.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { eventLog } from "./host-fixture.mts";
import { createTestRuntime } from "./test-runtime.mts";
import { createPrimaryChannel } from "./primary-channel.ts";
import { createDurableRuntime } from "./durable-runtime.ts";

async function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "delivery-eligibility-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent"); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [], cacheWarming: { mode: "off" } }));
	const catalog = new AgentCatalog(root);
	const metadata = hostMetadata(catalog.create({ cwd: root, agentDir, packageDir: getPackageDir(), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", trust: true }));
	const models = await fixtureRuntime("answer");
	const open = () => DurableHost.open({ storageId: metadata.storageId, storagePath: metadata.storagePath, cwd: root, models, registry: fixtureRegistry(), agent: { model: metadata.model } }, context);
	let host = await open();
	t.after(() => host.close());
	return { root, metadata, catalog, models, get host() { return host; }, async reopen() { await host.close(); host = await open(); return host; } };
}

function receipt(ownerId: string, origin: DeliveryReceipt["origin"] = "model"): DeliveryReceipt {
	return { submissionId: 999 as SubmissionId, requestId: "retained", ownerId, conversationId: 1 as ConversationId, operationId: null, origin, status: "done", entryId: null, answerEntryId: null, answer: "retained answer", reason: null, acknowledged: false };
}

const cases = [
	{ name: "absent primary with incomplete fallback discovery", owner: () => randomUUID(), state: "parked", reason: /primary endpoint is absent/u, incomplete: true },
	{ name: "target not retained with no primary registered", owner: () => randomUUID(), state: "parked", reason: /not retained/u, missingTarget: true },
	{ name: "eight-character recipient", owner: () => "12345678", state: "terminal", reason: /malformed recipient/u },
	{ name: "native identity without a catalog record", owner: () => `${randomUUID()}:7`, state: "parked", reason: /no catalog record/u },
	{ name: "corrupt admission origin", owner: () => randomUUID(), state: "terminal", reason: /corrupt admission origin/u, corrupt: true },
	{ name: "linked intent without its native submission", owner: () => randomUUID(), state: "terminal", reason: /native submission is absent/u, intent: true },
	{ name: "linked intent without its conversation", owner: () => randomUUID(), state: "terminal", reason: /native submission is absent/u, intent: true, missingConversation: true },
] as const;

for (const example of cases) it(`parks or terminates ${example.name} without a retry timer`, { timeout: 10000 }, async (t) => {
	const f = await fixture(t), owner = example.owner();
	await f.host.harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		if ("intent" in example) state.intents.push({ requestId: "missing", ownerId: owner, conversationId: ("missingConversation" in example ? 998 : 1) as ConversationId, message: "retained", whenBusy: null, operationId: null, submissionId: 998 as SubmissionId, origin: "model" });
		else {
			const { origin: _origin, ...corrupt } = receipt(owner);
			state.receipts["999"] = "corrupt" in example ? corrupt : receipt(owner);
		}
	}, context);
	const idle = eventLog<void>(), errors = eventLog<Error>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: f.host, metadata: f.metadata, catalog: f.catalog, sessionsRoot: f.root, signal: new AbortController().signal, onIdle: () => idle.push(undefined), onError: error => errors.push(error),
		...("incomplete" in example ? { listPrimaryChannels: async () => ({ ids: [], complete: false, visited: 256 }) } : {}),
		...("missingTarget" in example ? { readTarget: () => { throw Object.assign(new Error("exact target is not retained and no primary is registered"), { code: "ENOENT" }); } } : {}),
	});
	t.after(() => watcher.close());
	t.mock.timers.tick(0); await idle.waitForCount(1);
	t.mock.timers.tick(0); await new Promise<void>(setImmediate);
	const state = await f.host.harness.snapshot(AgentDeliveryDoc, context);
	const row = "intent" in example ? state?.intents[0] : state?.receipts["999"];
	assert.equal(row?.delivery?.state, example.state);
	assert.match(row?.delivery?.reason ?? "", example.reason);
	assert.match(errors[0]?.message ?? "", new RegExp(`${example.state}:`, "u"));
	const passes = idle.length;
	t.mock.timers.tick(300000); await new Promise<void>(setImmediate);
	assert.equal(idle.length, passes, "elapsed time never retries parked or terminal rows");
	assert.equal(watcher.busy, false);
});

it("retains a terminal reason through reopen and never routes the row", { timeout: 10000 }, async (t) => {
	const f = await fixture(t);
	await f.host.harness.commit(async tx => { (await tx.doc(AgentDeliveryDoc)).receipts["999"] = receipt("12345678"); }, context);
	const run = async () => {
		const idle = eventLog<void>();
		const watcher = startDurableDelivery({ host: f.host, metadata: f.metadata, catalog: f.catalog, sessionsRoot: f.root, signal: new AbortController().signal, onIdle: () => idle.push(undefined) });
		await idle.waitForCount(1); await watcher.close();
		return (await f.host.harness.snapshot(AgentDeliveryDoc, context))?.receipts["999"].delivery;
	};
	const terminal = await run();
	await f.reopen();
	assert.deepEqual(await run(), terminal);
	assert.deepEqual(terminal, { state: "terminal", reason: "malformed recipient identity" });
});

it("replays and delivers a null-linked intent after a crash between intent and input", { timeout: 10000 }, async (t) => {
	const f = await fixture(t), owner = randomUUID(), received = eventLog<unknown>();
	const channel = await createPrimaryChannel({ id: owner, cwd: f.root, sessionsRoot: f.root, deliver: message => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	await f.host.harness.commit(tx => recordDeliveryIntent(tx, 1 as ConversationId, { requestId: "gap", ownerId: owner, message: "replay this task", origin: "model" }), context);
	const before = await observeDeliveryEligibility(f.host.harness, { catalog: f.catalog, sessionsRoot: f.root });
	assert.equal(before[0]?.eligibility.state, "active");
	await f.reopen();
	const input = await f.host.harness.commit(tx => tx.submissionByRequest(1 as ConversationId, "gap"), context);
	assert.ok(input); await f.host.wait(input.id, context);
	const idle = eventLog<void>();
	const watcher = startDurableDelivery({ host: f.host, metadata: f.metadata, catalog: f.catalog, sessionsRoot: f.root, signal: new AbortController().signal, onIdle: () => idle.push(undefined) });
	try { await received.waitForCount(1); await idle.waitForCount(1); }
	finally { await watcher.close(); }
	assert.equal((await f.host.harness.snapshot(AgentDeliveryDoc, context))?.receipts[String(input.id)]?.acknowledged, true);
});

it("marks an impossible replay terminal", { timeout: 10000 }, async (t) => {
	const f = await fixture(t), owner = randomUUID();
	await f.host.harness.commit(async tx => {
		(await tx.doc(AgentDeliveryDoc)).intents.push({ requestId: "orphan", ownerId: owner, conversationId: 999 as ConversationId, message: "cannot replay", origin: "model", submissionId: null, whenBusy: null, operationId: null });
	}, context);
	await f.reopen();
	const state = await f.host.harness.snapshot(AgentDeliveryDoc, context);
	assert.deepEqual(state?.intents[0]?.delivery, { state: "terminal", reason: "replay target conversation does not exist" });
	const rows = await observeDeliveryEligibility(f.host.harness, { catalog: f.catalog, sessionsRoot: f.root });
	assert.equal(rows[0]?.eligibility.state, "terminal");
	assert.equal(classifyDelivery({ ownerId: owner, originValid: true, pendingIntent: true, nativeRecord: false, primaryState: "absent" }).state, "active");
});

it("leaves a transient replay failure pending and retries through reconciliation", { timeout: 10000 }, async (t) => {
	const f = await fixture(t);
	await f.host.harness.commit(tx => recordDeliveryIntent(tx, 1 as ConversationId, { requestId: "transient-gap", ownerId: randomUUID(), message: "replay after recovery", origin: "model" }), context);
	const unavailable = t.mock.method(f.host.harness, "conversation", async () => { throw new Error("temporary storage read failure"); });
	await assert.rejects(reconcileDeliveries(f.host.harness, context), /temporary storage read/u);
	assert.equal((await f.host.harness.snapshot(AgentDeliveryDoc, context))?.intents[0]?.delivery, undefined);
	assert.equal((await observeDeliveryEligibility(f.host.harness, { catalog: f.catalog, sessionsRoot: f.root }))[0]?.eligibility.state, "active");
	unavailable.mock.restore();
	await reconcileDeliveries(f.host.harness, context);
	const input = await f.host.harness.commit(tx => tx.submissionByRequest(1 as ConversationId, "transient-gap"), context);
	assert.ok(input);
	await f.host.wait(input.id, context);
});

it("parks a native target whose host cannot start without a retry timer", { timeout: 10000 }, async (t) => {
	const f = await fixture(t);
	const target = f.catalog.create({ cwd: f.root, agentDir: f.metadata.agentDir, packageDir: getPackageDir(), model: f.metadata.model, thinkingLevel: "off" });
	await f.host.harness.commit(async tx => { (await tx.doc(AgentDeliveryDoc)).receipts["999"] = receipt(target.storageId); }, context);
	const idle = eventLog<void>(), unavailableTargets = new Map<string, string>();
	let acquisitions = 0;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: f.host, metadata: f.metadata, catalog: f.catalog, sessionsRoot: f.root, unavailableTargets, signal: new AbortController().signal,
		acquire: async () => { acquisitions++; throw new Error("launch refused"); }, onIdle: () => idle.push(undefined) });
	try {
		t.mock.timers.tick(0); await idle.waitForCount(1);
		t.mock.timers.tick(0); await new Promise<void>(setImmediate);
		const rows = await observeDeliveryEligibility(f.host.harness, { catalog: f.catalog, sessionsRoot: f.root, unavailableTargets });
		assert.equal(rows[0]?.eligibility.state, "parked");
		assert.match(rows[0]?.eligibility.reason ?? "", /native host cannot start: launch refused/u);
		t.mock.timers.tick(300000); await new Promise<void>(setImmediate);
		assert.equal(acquisitions, 1);
		assert.equal((await f.host.harness.snapshot(AgentDeliveryDoc, context))?.receipts["999"].delivery?.state, "parked");
	} finally { await watcher.close(); }
});

it("keeps a live reachable recipient active after a transient failure and retries", { timeout: 10000 }, async (t) => {
	const f = await fixture(t), owner = randomUUID(), errors = eventLog<Error>(), accepted = eventLog<void>();
	let attempts = 0;
	const channel = await createPrimaryChannel({ id: owner, cwd: f.root, sessionsRoot: f.root, deliver: () => { attempts++; if (attempts === 1) throw new Error("transient transport failure"); accepted.push(undefined); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	await f.host.harness.commit(async tx => { (await tx.doc(AgentDeliveryDoc)).receipts["999"] = receipt(owner); }, context);
	const watcher = startDurableDelivery({ host: f.host, metadata: f.metadata, catalog: f.catalog, sessionsRoot: f.root, signal: new AbortController().signal, retryDelayMs: 50, onError: error => errors.push(error) });
	try {
		await errors.waitForCount(1);
		assert.match(errors[0]?.message ?? "", /active: transient transport failure/u);
		assert.equal((await observeDeliveryEligibility(f.host.harness, { catalog: f.catalog, sessionsRoot: f.root }))[0]?.eligibility.state, "active");
		await accepted.waitForCount(1);
		assert.equal(attempts, 2);
	} finally { await watcher.close(); }
});

for (const state of ["parked", "terminal"] as const) it(`lets tryRetire seal an idle runtime with ${state} rows`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t), owner = state === "parked" ? randomUUID() : "12345678";
	await f.host.harness.commit(async tx => { (await tx.doc(AgentDeliveryDoc)).receipts["999"] = receipt(owner); }, context);
	await f.host.close();
	const runtime = await createDurableRuntime(f.metadata, { modelRuntime: await createTestRuntime() });
	try {
		const idle = eventLog<void>();
		const stop = runtime.onQuiescent?.(() => idle.push(undefined));
		await idle.waitForCount(1); stop?.();
		const recovery = await runtime.request("recovery-state", {}, randomUUID()) as { deliveriesActive: boolean; deliveriesPending: boolean };
		assert.equal(recovery.deliveriesPending, true);
		assert.equal(recovery.deliveriesActive, false);
		assert.equal(await runtime.tryRetire?.(() => true), true);
	} finally { await runtime.close(); }
});
