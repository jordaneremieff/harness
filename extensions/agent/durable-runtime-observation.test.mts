import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { it } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { AgentCatalog } from "./catalog.ts";
import { resolveAgentControlDispatch } from "./durable-agents.ts";
import { DurableHost } from "./durable-host.ts";
import { DurableObservation } from "./durable-observation.ts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { hostPaths } from "./host-protocol.ts";
import { AgentManager } from "./manager.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

it("native foreign observation reads a settled storage without its cwd or a writer launch", { timeout: 60000 }, async (t) => {
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(() => runtime?.close());
	const fixture = runtimeFixture(t);
	const model = { provider: testModel.provider, modelId: testModel.id };
	const target = new AgentCatalog(fixture.root).create({ cwd: fixture.childCwd, agentDir: fixture.agentDir, packageDir: fixture.metadata.packageDir, model, thinkingLevel: "off", trust: true }, "primary");
	const writer = await DurableHost.open({ ...hostOptions(target.storagePath, await fixtureRuntime("answer"), fixtureRegistry(), target.cwd), storageId: target.storageId });
	let submissionId: number;
	try {
		const admitted = await writer.submit({ message: "RETAINED_FOREIGN_INPUT", requestId: "retained-foreign", origin: "operator" });
		submissionId = admitted.submissionId;
		await writer.wait(admitted.submissionId);
	} finally { await writer.close(); }
	rmSync(target.cwd, { recursive: true });
	const before = statSync(target.storagePath, { bigint: true });
	const paths = hostPaths(target);
	assert.equal(existsSync(paths.claim), false);
	runtime = await createDurableRuntime({ ...fixture.metadata, model }, { modelRuntime: await createTestRuntime() });
	const dispatch = resolveAgentControlDispatch();
	const senderIdentity = `${fixture.metadata.storageId}:2`;
	const control = AgentManager.prototype.control;
	const observed: Array<{ method: string; caller: string; signal?: AbortSignal }> = [];
	t.mock.method(AgentManager.prototype, "control", async function (this: AgentManager, ...args: Parameters<typeof control>) {
		observed.push({ method: args[0], caller: args[2].id, signal: args[3]?.signal });
		return control.apply(this, args);
	});
	const acquire = t.mock.method(AgentManager.prototype, "connectNative", async () => { throw new Error("writer acquisition requested"); });
	const params = { sessionId: target.storageId, senderIdentity };
	const result = await dispatch("inspect", { ...params, view: "result", submissionId }) as { view: string };
	assert.equal(result.view, "result");
	assert.match(JSON.stringify(result), /durable answer/u);
	const history = await dispatch("inspect", { ...params, view: "history", limit: 1 }) as { entries: unknown[]; nextCursor?: Record<string, unknown> };
	assert.equal(history.entries.length, 1);
	assert.ok(history.nextCursor);
	const page = await dispatch("inspect", { ...params, view: "history", cursor: history.nextCursor, limit: 1 }) as { entries: unknown[] };
	assert.equal(page.entries.length, 1);
	assert.notDeepEqual(page.entries, history.entries);
	const status = await dispatch("status", params) as { live: boolean; conversation?: unknown; pid?: number };
	assert.equal(status.live, false);
	assert.ok(status.conversation);
	assert.equal(status.pid, undefined);
	const profile = await dispatch("profile-read", params) as { identity: string };
	assert.equal(profile.identity, target.storageId);
	const controller = new AbortController();
	controller.abort(new Error("observation cancelled"));
	const controlsBeforeAbort = observed.length;
	await assert.rejects(dispatch("inspect", { ...params, view: "history" }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)), /observation cancelled/u);
	assert.ok(observed.every(item => item.caller === senderIdentity));
	assert.equal(observed.length, controlsBeforeAbort, "an already cancelled observation starts no manager control");
	assert.equal(acquire.mock.callCount(), 0);

	const entered = gate();
	const release = gate();
	const disposed = gate();
	const controlAborted = gate();
	const coldAbort = new AbortController();
	const open = DurableObservation.open;
	t.mock.method(DurableObservation, "open", async (...args: Parameters<typeof open>) => {
		const snapshot = await open(...args);
		const close = snapshot.close.bind(snapshot);
		snapshot.close = async () => { try { await close(); } finally { disposed.resolve(); } };
		entered.resolve();
		await release.promise;
		return snapshot;
	});
	const controlDuringRead = AgentManager.prototype.control;
	t.mock.method(AgentManager.prototype, "control", async function (this: AgentManager, ...args: Parameters<typeof control>) {
		try { return await controlDuringRead.apply(this, args); }
		finally { if (args[3]?.signal === coldAbort.signal) controlAborted.resolve(); }
	});
	let settled = false;
	const cancelled = dispatch("inspect", { ...params, view: "history" }, withAbortSignal(coldAbort.signal, BACKGROUND_CONTEXT))
		.then(value => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
	try {
		await entered.promise;
		coldAbort.abort(new Error("cold read cancelled"));
		await controlAborted.promise;
		assert.equal(observed.at(-1)?.signal, coldAbort.signal);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, true, "the caller ends its wait before the cold snapshot opens");
		assert.equal(runtime.isIdle(), false, "the runtime retains cleanup ownership until the cold read ends");
	} finally { release.resolve(); }
	assert.match(String(await cancelled), /cold read cancelled/u);
	await disposed.promise;
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(runtime.isIdle(), true, "the completed cleanup releases runtime activity");
	assert.equal(existsSync(paths.claim), false);
	assert.equal(existsSync(paths.socket), false);
	const after = statSync(target.storagePath, { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeNs, before.mtimeNs);
	await assert.rejects(dispatch("attach", params), /writer acquisition requested/u);
	await assert.rejects(dispatch("submit", { ...params, message: "not admitted" }), /writer acquisition requested/u);
	assert.equal(acquire.mock.callCount(), 2, "attach and mutation retain writer acquisition");
});
