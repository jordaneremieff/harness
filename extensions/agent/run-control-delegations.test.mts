import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as native from "@earendil-works/pi-durable";
import { createAgentContribution } from "./durable-agents.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, fixtureStorageId, gateTool, hostOptions, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { machineConfig } from "./settings-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { stopForeignReferences, type RunScope, type RunStop } from "./run-control.ts";
import { agentRunControlDoc } from "./run-control-state.ts";
import type { Context } from "@earendil-works/chord";

const previous = process.env.PI_HARNESS_FILE;
delete process.env.PI_HARNESS_FILE;
after(() => { if (previous !== undefined) process.env.PI_HARNESS_FILE = previous; });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function inputEntry(tx: native.Tx, conversationId: native.ConversationId, requestId: string | undefined) {
	assert.ok(requestId);
	const record = await tx.submissionByRequest(conversationId, requestId); assert.ok(record?.entry);
	return record.entry;
}
async function family(t: { after(fn: () => Promise<void> | void): void }, holdSpawn = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-run-family-")));
	writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: `${testModel.provider}/${testModel.id}` } }, preferences: { defaultPreset: "standard" } })));
	const gates = [deferred(), deferred(), deferred()], release = deferred(); let count = 0;
	const registry = fixtureRegistry([gateTool(release.promise, () => gates[count++]?.resolve())]);
	const spawned = deferred(), releaseSpawn = deferred();
	if (!holdSpawn) releaseSpawn.resolve();
	const contribution = createAgentContribution({ configureSettings: () => {}, source: new URL("./index.ts", import.meta.url).pathname }).create({ durable: native, storageId: fixtureStorageId, cwd: root, agentDir: root, onClose: () => {}, services: { modelRuntime: { getModel: () => testModel, getModels: () => [testModel] } } });
	registry.install({ ...contribution, tools: contribution.tools?.map(tool => tool.name === "agent_spawn" ? { ...tool, execute: async (args, api, context) => { const result = await tool.execute(args, api, context); spawned.resolve(); await releaseSpawn.promise; return result; } } : tool) });
	const spawn = { ...answerMessage(), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: "spawn-child", name: "agent_spawn", arguments: { name: "child", prompt: "child work" } }] };
	const options = hostOptions(join(root, "session.sqlite"), await scriptedRuntime([spawn, toolCallMessage("gate"), toolCallMessage("gate"), toolCallMessage("gate")]), registry, root);
	const host = await DurableHost.open(options, BACKGROUND_CONTEXT);
	t.after(async () => { release.resolve(); releaseSpawn.resolve(); await host.close(); rmSync(root, { recursive: true, force: true }); });
	await host.submit({ message: "delegate then work", requestId: "family" });
	if (holdSpawn) await spawned.promise; else await gates[1].promise;
	return { host, gates, options, releaseSpawn };
}

test("selected Stop reaches its native background delegation and leaves an unrelated standing conversation active", { timeout: 10000 }, async t => {
	const { host, gates, options } = await family(t);
	const scope = await host.request("run-scope") as RunScope;
	assert.equal(scope.coverage.complete, true);
	assert.equal(scope.delegations.length, 1);
	assert.ok(scope.delegations[0].result);
	const standing = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: options.agent }, BACKGROUND_CONTEXT);
	await standing.submit({ type: "input", content: "independent work", requestId: "standing" }, BACKGROUND_CONTEXT);
	await gates[2].promise;
	const stopped = await host.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.delegations[0].state, "stopped");
	const live = await host.harness.snapshot(native.LiveDoc, standing.id, BACKGROUND_CONTEXT);
	assert.ok(live?.run);
	assert.equal((await host.harness.getTask(live.run.taskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("selected Stop preserves delegated work after an independently owned input joins its run", { timeout: 10000 }, async t => {
	const { host } = await family(t);
	const scope = await host.request("run-scope") as RunScope;
	const reference = scope.delegations[0].result; assert.ok(reference);
	const childId = Number(reference.sessionId.split(":").at(-1)) as native.ConversationId;
	const childRun = await host.harness.commit(async tx => {
		const live = await tx.doc(native.LiveDoc, childId); assert.ok(live.run);
		const entry = await inputEntry(tx, childId, reference.requestId);
		const unrelated = await tx.createSubmission({ conversationId: childId, type: "input", status: "placed", entry, requestId: "independent-input" });
		live.run.inputs.push(unrelated.id);
		return live.run.taskId;
	}, BACKGROUND_CONTEXT);
	const stopped = await host.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "partial");
	assert.equal(stopped.delegations[0].state, "protected");
	assert.equal((await host.harness.getTask(childRun, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("Stop selected before postTools follows its same native input group after generation handover", { timeout: 10000 }, async t => {
	const { host, gates, releaseSpawn } = await family(t, true);
	const before = await host.request("run-scope") as RunScope;
	releaseSpawn.resolve(); await gates[1].promise;
	const after = await host.request("run-scope") as RunScope;
	assert.equal(after.runId, before.runId);
	assert.notEqual(after.taskId, before.taskId);
	const stopped = await host.request("run-stop", { runId: before.runId }) as RunStop;
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.delegations[0].state, "stopped");
});

test("Stop reaches an older group's surviving delegation without aborting a newer independent group", { timeout: 10000 }, async t => {
	const { host, gates } = await family(t);
	const before = await host.request("run-scope") as RunScope;
	await host.harness.abortTask(before.taskId as native.TaskId, BACKGROUND_CONTEXT);
	await host.harness.waitForTask(before.taskId as native.TaskId, BACKGROUND_CONTEXT);
	const next = await host.submit({ message: "new independent work", requestId: "new-group" });
	await gates[2].promise;
	const current = await host.request("run-scope") as RunScope;
	assert.equal(current.runId, next.submissionId);
	assert.notEqual(current.runId, before.runId);
	const stopped = await host.request("run-stop", { runId: before.runId }) as RunStop;
	assert.equal(stopped.delegations[0].state, "stopped");
	assert.equal((await host.harness.getTask(current.taskId as native.TaskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("foreign Stop withdraws its exact queued input before it observes unrelated active work", { timeout: 10000 }, async t => {
	const { host } = await family(t);
	const queued = await host.submit({ message: "foreign queued delegation", requestId: "queued-delegation", whenBusy: "followUp" });
	const before = await host.request("run-scope") as RunScope;
	const methods: string[] = [];
	const result = await stopForeignReferences(async (method, input) => { methods.push(method); return host.request(method, input); }, [{ sessionId: fixtureStorageId, submissionId: queued.submissionId, requestId: "queued-delegation" }], BACKGROUND_CONTEXT);
	assert.equal(result.state, "cancelled");
	assert.deepEqual(methods, ["request-cancel"]);
	assert.equal((await host.harness.getTask(before.taskId as native.TaskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("foreign Stop withdraws multiple exact owned queued inputs behind unrelated active work", { timeout: 10000 }, async t => {
	const { host } = await family(t);
	const before = await host.request("run-scope") as RunScope;
	const references = [];
	for (const requestId of ["first-owned", "second-owned"]) {
		const queued = await host.submit({ message: requestId, requestId, whenBusy: "followUp" });
		references.push({ sessionId: fixtureStorageId, submissionId: queued.submissionId, requestId });
	}
	const methods: string[] = [];
	const result = await stopForeignReferences(async (method, input) => { methods.push(method); return host.request(method, input); }, references, BACKGROUND_CONTEXT);
	assert.equal(result.state, "cancelled");
	assert.deepEqual(methods, ["request-cancel", "request-cancel"]);
	assert.equal((await host.harness.getTask(before.taskId as native.TaskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("foreign Stop guards an active native group with every exact owned input", { timeout: 10000 }, async t => {
	const { host } = await family(t);
	const before = await host.request("run-scope") as RunScope;
	const second = await host.harness.commit(async tx => {
		const record = await tx.createSubmission({ conversationId: host.root().id, type: "input", status: "placed", entry: await inputEntry(tx, host.root().id, "family"), requestId: "second-owned" });
		const live = await tx.doc(native.LiveDoc, host.root().id); assert.ok(live.run);
		live.run.inputs.push(record.id);
		return record.id;
	}, BACKGROUND_CONTEXT);
	const result = await stopForeignReferences((method, input) => host.request(method, input), [...before.inputs, { sessionId: fixtureStorageId, submissionId: second, requestId: "second-owned" }], BACKGROUND_CONTEXT);
	assert.equal(result.state, "stopped");
});

async function holdUntilAbort(context: Context, release: Promise<void>): Promise<void> {
	await new Promise<void>(resolve => {
		release.then(resolve);
		if (context.abortSignal?.aborted) resolve();
		else context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
	});
}

async function placedFamily(t: { after(fn: () => Promise<void> | void): void }, options: { reused?: boolean; queued?: boolean; prompt?: string; interrupted?: boolean; invalid?: "target" | "request" | "missing" } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-place-control-")));
	writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: `${testModel.provider}/${testModel.id}` } }, preferences: { defaultPreset: "standard" } })));
	const release = deferred(), targetStarted = deferred(), captured = [deferred(), deferred()];
	const targetId = "placed-owner";
	const targetRegistry = fixtureRegistry([gateTool(release.promise, targetStarted.resolve)]);
	const targetOptions = { ...hostOptions(join(root, "target.sqlite"), await scriptedRuntime([toolCallMessage("gate"), answerMessage()]), targetRegistry, root), storageId: targetId };
	let target: DurableHost | undefined;
	let calls = 0, executions = 0;
	let rebound = false;
	if (options.reused || options.queued) target = await DurableHost.open(targetOptions, BACKGROUND_CONTEXT);
	if (options.queued) { assert.ok(target); await target.submit({ message: "unrelated work", requestId: "unrelated" }); await targetStarted.promise; }
	const sourceRegistry = fixtureRegistry();
	const contribution = createAgentContribution({ configureSettings: () => {}, source: new URL("./index.ts", import.meta.url).pathname, dispatch: async (method, params) => {
		assert.equal(method, "place"); calls++;
		assert.equal(rebound, false, "confirmed replay never resolves the rebound place registry");
		target ??= await DurableHost.open(targetOptions, BACKGROUND_CONTEXT);
		if (params.prompt === undefined) return { sessionId: targetId };
		assert.equal(params.prompt, options.prompt ?? "placed work");
		const admitted = await target.request("submit", { sessionId: targetId, message: params.prompt, requestId: params.requestId, origin: "model", ownerId: fixtureStorageId, whenBusy: "followUp" }) as Record<string, unknown>;
		if (options.interrupted) throw new Error("Admission confirmation interrupted");
		if (options.invalid === "missing") return { sessionId: targetId };
		return { ...admitted, sessionId: options.invalid === "target" ? "wrong-owner" : targetId, result: { sessionId: targetId, submissionId: admitted.submissionId, requestId: options.invalid === "request" ? "wrong-request" : params.requestId } };
	} }).create({ durable: native, storageId: fixtureStorageId, cwd: root, agentDir: root, onClose: () => {}, services: { modelRuntime: { getModel: () => testModel, getModels: () => [testModel] } } });
	sourceRegistry.install({ ...contribution, tools: contribution.tools?.map(tool => tool.name !== "agent_place" ? tool : { ...tool, execute: async (args, api, context) => {
		const result = await tool.execute(args, api, context);
		captured[executions++]?.resolve();
		await holdUntilAbort(context, release.promise);
		return result;
	} }) });
	const sourceOptions = hostOptions(join(root, "source.sqlite"), await scriptedRuntime([toolCallMessage("agent_place", { area: root, prompt: options.prompt ?? "placed work" }), answerMessage()]), sourceRegistry, root);
	let source = await DurableHost.open(sourceOptions, BACKGROUND_CONTEXT);
	const wireStop = () => source.setForeignStop((references, context) => stopForeignReferences((method, input) => { assert.ok(target); return target.request(method, input); }, references, context));
	wireStop();
	t.after(async () => { release.resolve(); await source.close(); await target?.close(); rmSync(root, { recursive: true, force: true }); });
	const input = await source.submit({ message: "place work", requestId: "place-source" });
	await captured[0].promise;
	if (options.prompt !== "") await targetStarted.promise;
	return {
		get source() { return source; }, get target() { assert.ok(target); return target; }, calls: () => calls, input,
		async reopen() { rebound = true; await source.close(); source = await DurableHost.open(sourceOptions, BACKGROUND_CONTEXT); wireStop(); await captured[1].promise; },
	};
}

for (const reused of [false, true]) test(`prompted place captures the exact ${reused ? "reused" : "created"} owner's input for Stop`, { timeout: 15000 }, async t => {
	const f = await placedFamily(t, { reused });
	const scope = await f.source.request("run-scope") as RunScope;
	assert.equal(scope.coverage.complete, true);
	assert.equal(scope.delegations.length, 1);
	const delegation = scope.delegations[0];
	assert.equal(delegation.ownership, "reused", "a shared area owner is not an exclusive child");
	assert.ok(delegation.result);
	assert.ok(delegation.result.requestId?.startsWith(`place:${fixtureStorageId}:`));
	assert.equal(delegation.result.sessionId, "placed-owner");
	const targetScope = await f.target.request("run-scope") as RunScope;
	const stopped = await f.source.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.delegations[0].state, "stopped");
	assert.equal((await f.target.harness.getTask(targetScope.taskId as native.TaskId, BACKGROUND_CONTEXT))?.abortRequested, true);
	assert.equal(f.calls(), 1);
});

test("Stop withdraws a placed owner's queued input without aborting unrelated active work", { timeout: 15000 }, async t => {
	const f = await placedFamily(t, { reused: true, queued: true });
	const targetScope = await f.target.request("run-scope") as RunScope;
	const scope = await f.source.request("run-scope") as RunScope;
	const stopped = await f.source.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.delegations[0].state, "cancelled");
	assert.equal((await f.target.harness.getTask(targetScope.taskId as native.TaskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

test("Stop reports partial coverage when unrelated input shares a placed owner's active group", { timeout: 15000 }, async t => {
	const f = await placedFamily(t, { reused: true });
	const scope = await f.source.request("run-scope") as RunScope;
	const reference = scope.delegations[0].result; assert.ok(reference);
	const taskId = await f.target.harness.commit(async tx => {
		const live = await tx.doc(native.LiveDoc, f.target.root().id); assert.ok(live.run);
		const unrelated = await tx.createSubmission({ conversationId: f.target.root().id, type: "input", status: "placed", entry: await inputEntry(tx, f.target.root().id, reference.requestId), requestId: "shared-place" });
		live.run.inputs.push(unrelated.id);
		return live.run.taskId;
	}, BACKGROUND_CONTEXT);
	const stopped = await f.source.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "partial");
	assert.equal(stopped.delegations[0].state, "protected");
	assert.equal((await f.target.harness.getTask(taskId, BACKGROUND_CONTEXT))?.abortRequested, false);
});

for (const reused of [false, true]) test(`empty-prompt place resolves a ${reused ? "reused" : "created"} owner without delegation`, { timeout: 15000 }, async t => {
	const f = await placedFamily(t, { reused, prompt: "" });
	const scope = await f.source.request("run-scope") as RunScope;
	assert.equal(scope.coverage.complete, true);
	assert.deepEqual(scope.delegations, []);
	const targetScope = await f.target.request("run-scope") as RunScope;
	assert.equal(targetScope.runId, null);
});

for (const invalid of [undefined, "target", "request", "missing"] as const) test(`unconfirmed place admission stays partial with response=${invalid ?? "interrupted"}`, { timeout: 15000 }, async t => {
	const f = await placedFamily(t, { interrupted: invalid === undefined, invalid });
	const scope = await f.source.request("run-scope") as RunScope;
	assert.equal(scope.coverage.complete, false);
	assert.equal(scope.coverage.omitted, 1);
	assert.deepEqual(scope.delegations, []);
	const stopped = await f.source.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "partial");
});

test("confirmed place replay after reopen keeps its exact reference despite an area rebinding", { timeout: 15000 }, async t => {
	const f = await placedFamily(t);
	const before = await f.source.request("run-scope") as RunScope;
	await f.reopen();
	const after = await f.source.request("run-scope") as RunScope;
	assert.deepEqual(after.delegations, before.delegations);
	assert.equal(after.coverage.complete, true);
	assert.equal(f.calls(), 1);
	const control = await f.source.harness.snapshot(agentRunControlDoc(native), f.source.root().id, String(after.delegations[0].createdBy), BACKGROUND_CONTEXT);
	assert.deepEqual(control?.result, before.delegations[0].result);
	const stopped = await f.source.request("run-stop", { runId: after.runId }) as RunStop;
	assert.equal(stopped.state, "stopped");
});
