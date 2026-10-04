import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import * as Durable from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import register from "./index.ts";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { acquireHost, waitForHostRelease } from "./host-client.ts";
import { runtimeFixture, trackHost, waitForReceipt } from "./durable-runtime-fixture.mts";
import { DurableHost } from "./durable-host.ts";
import { createAgentContribution } from "./durable-agents.ts";
import { answerMessage, completed, fixtureRegistry, hostOptions, toolCallMessage } from "./durable-host-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { AgentManager } from "./manager.ts";
import { buildStatusOverview } from "./status-overview.ts";
import { MODEL_SELECTION_GUIDANCE } from "./control-guidance.ts";
import type { FleetStatus } from "./fleet-status.ts";

function primaryTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	register({ events: { emit() {} }, on: () => () => {}, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} } as unknown as ExtensionAPI);
	return tools;
}

it("publishes real host evidence and reads fleet status locally from ordinary and native tools", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const root = join(realpathSync(f.root), "fleet");
	const catalog = new AgentCatalog(root);
	const { storageId: _storageId, storagePath: _storagePath, ...input } = f.metadata;
	const metadata = hostMetadata(catalog.create(input));
	const previous = { dir: process.env.PI_AGENT_DIR, sessions: process.env.PI_AGENT_SESSIONS_DIR };
	process.env.PI_AGENT_DIR = f.agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	t.after(() => {
		if (previous.dir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previous.dir;
		if (previous.sessions === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous.sessions;
	});
	const primary = await acquireHost(metadata, { env: { ...f.env("answer"), PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: root } });
	trackHost(t, primary.pid);
	try {
		const submission = await primary.request("submit", { message: "Publish model evidence", requestId: "model-evidence", ownerId: f.ownerId, origin: "operator" }) as { submissionId: number };
		assert.equal((await waitForReceipt(primary, f.ownerId, submission.submissionId)).status, "done");
		await primary.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submission.submissionId] });
	} finally { await primary.close(); }
	process.kill(primary.pid, "SIGTERM");
	await waitForHostRelease(metadata, { signal: AbortSignal.timeout(10000) });
	const view = catalog.read(metadata.storageId).view;
	assert.ok(view?.modelEvidence);
	assert.ok(view.modelEvidence.models.some((item) => item.model === `${f.metadata.model.provider}/${f.metadata.model.modelId}` && item.reportedCost > 0 && item.lastResponseAt !== undefined));

	const tools = primaryTools();
	const status = tools.get("agent_status");
	assert.ok(status);
	const ordinary = await status.execute("fleet", { view: "fleet" }, undefined, undefined, {} as never);
	const fleet = ordinary.details as FleetStatus;
	assert.equal(fleet.view, "fleet");
	assert.equal(fleet.models.length, 1);
	assert.ok(Buffer.byteLength(JSON.stringify(fleet)) <= 4096);
	assert.equal(ordinary.content[0].type, "text");
	if (ordinary.content[0].type === "text") assert.equal(ordinary.content[0].text, JSON.stringify(fleet));

	let native: ToolResultMessage | undefined;
	const models = await createTestRuntime();
	const streamSimple = (_model: unknown, transcript: TranscriptContext) => {
		const last = transcript.messages.at(-1);
		if (last?.role === "toolResult") { native = last; return completed(answerMessage("Observed fleet")); }
		return completed(toolCallMessage("agent_status", { view: "fleet" }));
	};
	models.registerNativeProvider({ id: testModel.provider, name: "Fleet fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream: streamSimple, streamSimple });
	const registry = fixtureRegistry();
	const contribution = createAgentContribution({ source: fileURLToPath(new URL("./index.ts", import.meta.url)), dispatch: async () => { throw new Error("Fleet observation must not dispatch a host operation"); } }).create({ durable: Durable, storageId: "fixture-agent", cwd: f.cwd, catalogRoot: catalog.root, services: { modelRuntime: models } });
	registry.install(contribution);
	for (const name of ["agent_spawn", "agent_configure"]) {
		const ordinaryTool = tools.get(name);
		const nativeTool = contribution.tools?.find((tool) => tool.name === name);
		assert.ok(ordinaryTool);
		assert.ok(nativeTool);
		assert.equal((ordinaryTool.parameters as { properties: { model: { description: string } } }).properties.model.description, MODEL_SELECTION_GUIDANCE);
		assert.equal((nativeTool.parameters as { properties: { model: { description: string } } }).properties.model.description, MODEL_SELECTION_GUIDANCE);
	}
	const observer = await DurableHost.open(hostOptions(join(f.root, "observer.sqlite"), models, registry, f.cwd), context);
	try {
		const submitted = await observer.submit({ message: "Read fleet", requestId: "fleet-native" });
		await observer.wait(submitted.submissionId, context);
		assert.ok(native);
		assert.equal(native.isError, false, JSON.stringify(native.content));
		const nativeFleet = (native.details as { structuredContent: FleetStatus }).structuredContent;
		assert.deepEqual(nativeFleet.models, fleet.models);
		assert.ok(native.content.every((part) => part.type !== "text" || Buffer.byteLength(part.text) <= 4096));
	} finally { await observer.close(); }
	t.diagnostic(`Fleet sample: ${JSON.stringify(fleet)}`);
});

it("publishes own usage across real model changes without counting a fork's inherited entries twice", async (t) => {
	const f = runtimeFixture(t);
	const models = await createTestRuntime();
	const alternate = { ...testModel, id: "alternate-model", name: "Alternate fixture" };
	const streamSimple = (model: { id: string }) => completed({ ...answerMessage(), model: model.id });
	models.registerNativeProvider({ id: testModel.provider, name: "Accounting fixture", getModels: () => [testModel, alternate], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream: streamSimple, streamSimple });
	const host = await DurableHost.open(hostOptions(join(f.root, "accounting.sqlite"), models, fixtureRegistry(), f.cwd), context);
	t.after(() => host.close());
	const first = await host.submit({ message: "First model", requestId: "first" });
	await host.wait(first.submissionId, context);
	await host.request("configure", { model: { provider: testModel.provider, modelId: alternate.id } });
	const second = await host.submit({ message: "Second model", requestId: "second" });
	await host.wait(second.submissionId, context);
	const assistant = (await host.root().entries({}, 20, undefined, context)).items.find((item) => item.kind === "pi.assistant");
	assert.ok(assistant);
	await host.request("fork", { entryId: assistant.id });
	const projection = await host.catalogProjection();
	assert.equal(projection.modelEvidence.coverage.conversationsVisited, 2);
	assert.deepEqual(projection.modelEvidence.models.map(({ model, reportedCost }) => ({ model, reportedCost })), [
		{ model: `${testModel.provider}/${testModel.id}`, reportedCost: 0.03 },
		{ model: `${testModel.provider}/${alternate.id}`, reportedCost: 0.03 },
	]);
	assert.equal(projection.rows[0].model?.modelId, alternate.id);
	assert.equal(projection.rows[0].cost, 0.06);
	assert.equal(projection.modelEvidence.toolReportedCost, 0);
});

it("keeps default manager status byte-equivalent to its established overview and selected-session path", async (t) => {
	const f = runtimeFixture(t);
	const selected = { conversation: { fixture: "unchanged" } };
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.root, observe: async (_record, method, params) => { assert.equal(method, "status"); assert.equal(params.sessionId, f.metadata.storageId); return selected; } });
	t.after(() => manager.close());
	const page = { rows: [], coverage: { complete: true, storagesVisited: 0, skipped: 0, omitted: 0, nextCursor: null }, observedAt: "2026-01-01T00:00:00.000Z" };
	t.mock.method(manager, "dashboardPage", async () => page);
	assert.equal(JSON.stringify(await manager.status()), JSON.stringify(buildStatusOverview(page, [], [])));
	assert.equal(await manager.status(f.metadata.storageId), selected);
	await assert.rejects(manager.status(f.metadata.storageId, "fleet"), /omit sessionId/u);
});
