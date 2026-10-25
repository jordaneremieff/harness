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
