import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as native from "@earendil-works/pi-durable";
import { agentChildrenDoc } from "./children.ts";
import { createAgentContribution, type AgentControlDispatch } from "./durable-agents.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, fixtureStorageId, gateTool, hostOptions, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { machineConfig } from "./settings-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { stopForeignReferences, type RunScope, type RunStop } from "./run-control.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function contribution(root: string, storageId: string, dispatch?: AgentControlDispatch) {
	return createAgentContribution({ configureSettings: () => {}, source: new URL("./index.ts", import.meta.url).pathname, ...(dispatch ? { dispatch } : {}) }).create({ durable: native, storageId, cwd: root, agentDir: root, onClose: () => {}, services: { modelRuntime: { getModel: () => testModel, getModels: () => [testModel] } } });
}
async function addSharedInput(api: native.ToolExecutionApi): Promise<void> {
	await api.commit(async tx => {
		const original = (await tx.scanEntries({ conversationId: api.conversationId, order: "ascending" }, 1)).items[0];
		assert.equal(original?.kind, native.UserEntry.kind); assert.ok(original);
		const live = await tx.doc(native.LiveDoc, api.conversationId); assert.ok(live.run);
		const shared = await tx.createSubmission({ conversationId: api.conversationId, type: "input", status: "placed", entry: original.id, requestId: "shared-child-input" });
		live.run.inputs.push(shared.id);
	}, BACKGROUND_CONTEXT);
}
async function lineage(t: TestContext, foreign: boolean, newer: boolean, shared = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-run-lineage-")));
	writeFileSync(join(root, "harness.json"), JSON.stringify(machineConfig({ presets: { standard: { model: `${testModel.provider}/${testModel.id}` } }, preferences: { defaultPreset: "standard" } })));
	const grandStarted = deferred(), newerStarted = deferred(), rootReady = deferred(), rootRelease = deferred(), release = deferred();
	let gates = 0;
	const targetStorageId = foreign ? "foreign-lineage" : fixtureStorageId;
	const registry = fixtureRegistry([gateTool(release.promise, () => (++gates === 1 ? grandStarted : newerStarted).resolve())]);
	const extension = contribution(root, targetStorageId);
	registry.install({ ...extension, tools: extension.tools?.map(tool => tool.name !== "agent_spawn" ? tool : { ...tool, execute: async (args, api, context) => {
		const parent = !foreign && api.conversationId === native.ROOT_CONVERSATION_ID;
		if (shared && !parent) await addSharedInput(api);
		const result = await tool.execute(args, api, context);
		if (parent) { rootReady.resolve(); await rootRelease.promise; } else await grandStarted.promise;
		return result;
	} }) });
	const messages = [...(foreign ? [] : [toolCallMessage("agent_spawn", { name: "child", prompt: "child work" })]), toolCallMessage("agent_spawn", { name: "grandchild", prompt: "grandchild work" }), toolCallMessage("gate"), answerMessage("child answered"), ...(newer ? [toolCallMessage("gate")] : []), answerMessage("root answered")];
	const target = await DurableHost.open({ ...hostOptions(join(root, "target.sqlite"), await scriptedRuntime(messages), registry, root), storageId: targetStorageId }, BACKGROUND_CONTEXT);
	let source = target;
	t.after(async () => { release.resolve(); rootRelease.resolve(); if (source !== target) await source.close(); await target.close(); rmSync(root, { recursive: true, force: true }); });
	if (foreign) {
		const dispatch: AgentControlDispatch = async (method, params) => {
			assert.equal(method, "submit");
			const admitted = await target.request(method, params) as { submissionId: number };
			return { ...admitted, result: { sessionId: targetStorageId, submissionId: admitted.submissionId, requestId: params.requestId } };
		};
		const sourceRegistry = fixtureRegistry(), sourceExtension = contribution(root, fixtureStorageId, dispatch);
		sourceRegistry.install({ ...sourceExtension, tools: sourceExtension.tools?.map(tool => tool.name !== "agent_send" ? tool : { ...tool, execute: async (args, api, context) => { const result = await tool.execute(args, api, context); rootReady.resolve(); await rootRelease.promise; return result; } }) });
		source = await DurableHost.open(hostOptions(join(root, "source.sqlite"), await scriptedRuntime([toolCallMessage("agent_send", { sessionId: targetStorageId, message: "child work", checkInMinutes: 0 }), answerMessage("root answered")]), sourceRegistry, root), BACKGROUND_CONTEXT);
		source.setForeignStop((references, context) => stopForeignReferences((method, input) => target.request(method, input), references, context));
	}
	const rootInput = await source.submit({ message: "root work", requestId: "root-work" });
	await rootReady.promise;
	const scope = await source.request("run-scope") as RunScope;
	assert.doesNotThrow(() => JSON.stringify(scope));
	const child = scope.delegations[0]?.result; assert.ok(child);
	assert.equal((await target.wait(child.submissionId as native.SubmissionId)).status, "done");
	const childId = child.sessionId === targetStorageId ? native.ROOT_CONVERSATION_ID : Number(child.sessionId.split(":").at(-1)) as native.ConversationId;
	const children = await target.harness.snapshot(agentChildrenDoc(native), childId, BACKGROUND_CONTEXT);
	const grandchild = children?.children.find(item => item.name === "grandchild"); assert.ok(grandchild?.conversationId);
	const grandScope = await target.request("run-scope", { sessionId: `${targetStorageId}:${grandchild.conversationId}` }) as RunScope; assert.ok(grandScope.taskId);
	let newerTask: native.TaskId | undefined;
	if (newer) {
		await target.request("submit", { sessionId: child.sessionId, message: "unrelated newer child work", requestId: "new-child-group", origin: "operator" });
		await newerStarted.promise;
		const childScope = await target.request("run-scope", { sessionId: child.sessionId }) as RunScope; assert.ok(childScope.taskId);
		newerTask = childScope.taskId as native.TaskId;
	}
	rootRelease.resolve(); assert.equal((await source.wait(rootInput.submissionId)).status, "done");
	return { source, target, scope, grandTask: grandScope.taskId as native.TaskId, newerTask };
}
for (const foreign of [false, true]) for (const newer of [false, true]) test(`Stop traverses an answered ${foreign ? "foreign" : "local"} child to its active grandchild with newer child work ${newer}`, { timeout: 10000 }, async t => {
	const { source, target, scope, grandTask, newerTask } = await lineage(t, foreign, newer);
	const stopped = await source.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "stopped");
	assert.equal((await target.harness.getTask(grandTask, BACKGROUND_CONTEXT))?.abortRequested, true);
	if (newerTask) assert.equal((await target.harness.getTask(newerTask, BACKGROUND_CONTEXT))?.abortRequested, false);
});
for (const foreign of [false, true]) test(`Stop protects a shared answered ${foreign ? "foreign" : "local"} child's surviving grandchild`, { timeout: 10000 }, async t => {
	const { source, target, scope, grandTask } = await lineage(t, foreign, false, true);
	const stopped = await source.request("run-stop", { runId: scope.runId }) as RunStop;
	assert.equal(stopped.state, "partial");
	assert.equal((await target.harness.getTask(grandTask, BACKGROUND_CONTEXT))?.abortRequested, false);
});
