import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as Durable from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createAgentContribution } from "./durable-agents.ts";
import { answerMessage, fixtureModelId, fixtureProvider, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { AgentCatalog } from "./catalog.ts";
import type { FleetStatus } from "./fleet-status.ts";
import { matchesSchema } from "./schema-check.ts";

const listing = {
	rows: [], nextCursor: null,
	coverage: { complete: true, storagesVisited: 0, unavailable: [], catalog: { storages: 0, pass: "candidates", pending: 0, settled: 0 }, basis: "Every storage in scope was observed.", next: null, profileHints: { complete: true, unknownStorages: 0, omitted: 0 } },
	observedAt: "2026-10-13T00:00:00.000Z", authority: "native catalog scan",
};

it("native fleet calls select local published models and reject filters outside fleet mode", { timeout: 10000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "native-fleet-selection-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const catalog = new AgentCatalog(root);
	const source = catalog.create({ cwd: root, agentDir: root, packageDir: root, model: { provider: "sample", modelId: "a" }, thinkingLevel: "off" });
	catalog.updateView(source.storageId, { updatedAt: "2026-10-01T00:00:00.000Z", coverage: { complete: true, omitted: 0 },
		rows: ["a", "b"].map((modelId) => ({ id: `${source.storageId}:${modelId}`, storageId: source.storageId, cwd: root, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false,
			model: { provider: "sample", modelId, thinkingLevel: "off" } })) });
	const registry = Durable.createRegistry();
	const extension = createAgentContribution({ source: new URL("./index.ts", import.meta.url).pathname, configureSettings() {}, dispatch: async () => { throw new Error("fleet must not dispatch to a host"); } })
		.create({ durable: Durable, storageId: "native-fleet", cwd: root, agentDir: root, catalogRoot: catalog.root, onClose() {}, services: { modelRuntime: { getModel: () => undefined } } });
	registry.install(extension);
	const status = extension.tools?.find((tool) => tool.name === "agent_status"); assert.ok(status);
	assert.equal(matchesSchema(status.parameters, { view: "fleet", model: "sample/a", provider: "sample" }), true);
	const results: Durable.NestedToolExecutionResult[] = [];
	registry.install(Durable.defineExtension({ name: "fleet-query-probe", tools: [Durable.defineTool({
		name: "fleet-probe", description: "Read selected fleet evidence.", parameters: obj({}, { open: true }),
		execute: async (_args, api, callContext) => {
			const inputs: Durable.JsonObject[] = [{ view: "fleet", model: "sample/a", provider: "sample" }, { model: "sample/a" }, { view: "fleet", sessionId: "target", model: "sample/a" }, { view: "fleet", model: "broken" }];
			for (const args of inputs) results.push(await api.executeTool("agent_status", args, callContext));
			return { output: [{ type: "text", text: "fleet probe complete" }] };
		},
	})] }));
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models: await scriptedRuntime([toolCallMessage("fleet-probe", {}), answerMessage()]), registry }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	harness.resume();
	await (await conversation.submit({ type: "input", content: "Read the selected candidate" }, context)).wait(context);
	assert.equal(results[0]?.isError, false);
	const selected = results[0]?.structuredOutput as unknown as FleetStatus;
	assert.deepEqual(selected.models.map((model) => model.model), ["sample/a"]);
	assert.equal(selected.selection?.filter, "model-and-provider");
	assert.equal(selected.coverage.unknownEvidenceStorages, 1);
	for (const result of results.slice(1)) assert.equal(result.isError, true);
});

it("returns schema control values through native nested calls with tagged tasks and parent events", { timeout: 10000 }, async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "native-controls-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const registry = Durable.createRegistry();
	registry.install(createAgentContribution({ source: new URL("./index.ts", import.meta.url).pathname, configureSettings() {}, dispatch: async (method) => {
		if (method === "profile-list") return listing;
		if (method === "command") return { text: "command-result" };
		throw new Error("controlled unavailable observation");
	} }).create({ durable: Durable, storageId: "native-controls", cwd: agentDir, agentDir, onClose() {}, services: { modelRuntime: { getModel: () => undefined } } }));
	const results: Durable.NestedToolExecutionResult[] = [];
	const inputs: Durable.ToolTaskInput[] = [];
	registry.install(Durable.defineExtension({ name: "native-controls-probe", tools: [Durable.defineTool({
		name: "nested-probe", description: "Check nested controls.", parameters: obj({}, { open: true }),
		execute: async (_args, api, callContext) => {
			for (const [name, args] of [["agent_list", {}], ["agent_command", { sessionId: "native-controls", name: "echo" }], ["agent_status", { sessionId: "missing" }]] as const) {
				const result = await api.executeTool(name, args, callContext);
				results.push(result);
				const task = await api.getTask(result.taskId, callContext);
				inputs.push(task?.input as Durable.ToolTaskInput);
			}
			return { output: [{ type: "text", text: "probe-done" }] };
		},
	})] }));
	const models = await scriptedRuntime([toolCallMessage("nested-probe", {}), answerMessage()]);
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	t.after(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	// Nested slots leave pi.live when their caller settles; the synchronous observer sees every unfolded revision.
	const nestedDone = new Map<number, Durable.NestedToolSlot>();
	const observation = await harness.observeConversation(root.id, { end: () => {}, advance: (call) => {
		if (call.kind !== "value") return;
		const live = call.value.docs["pi.live"] as Durable.LiveState | undefined;
		for (const slot of live?.nestedTools ?? []) if (slot.status === "done") nestedDone.set(slot.taskId, structuredClone(slot));
	} }, context);
	t.after(() => observation.detach());
	harness.resume();
	await (await root.submit({ type: "input", content: "Probe controls" }, context)).wait(context);
	assert.deepEqual(results[0]?.structuredOutput, listing);
	assert.equal(results[0]?.isError, false);
	assert.deepEqual(results[0]?.details, listing);
	assert.equal(results[1]?.structuredOutput, '{"text":"command-result"}');
	assert.equal(results[1]?.isError, false);
	assert.equal(results[2]?.isError, true);
	assert.equal(results[2]?.structuredOutput, undefined);
	assert.ok(results[2]?.diagnostics.some((diagnostic) => diagnostic.message.includes("controlled unavailable observation")));
	assert.ok(inputs.every((input) => input.kind === "nested" && input.parent > 0 && input.call.name.startsWith("agent_")));
	const nestedEnds = [...nestedDone.values()];
	assert.equal(nestedEnds.length, 3);
	assert.ok(nestedEnds.every((slot) => slot.parentTaskId > 0 && slot.parentCallId !== "" && slot.summary !== undefined && slot.name.startsWith("agent_")));
	assert.deepEqual(nestedEnds.map((slot) => slot.summary?.isError), [false, false, true]);
	const nested = inputs[0];
	assert.ok(nested?.kind === "nested");
	const parent = await harness.getTask(nested.parent, context);
	assert.ok(parent);
	assert.equal((parent.input as Durable.ToolTaskInput).kind, "model");
	const compact = registry.snapshot().tools().find(({ tool }) => tool.name === "agent_compact")?.tool;
	assert.deepEqual(compact?.callers, ["model"]);
});

it("places a display-only write during a busy tool without changing model context", { timeout: 10000 }, async (t) => {
	let markEntered!: () => void;
	let releaseTool!: () => void;
	const entered = { promise: new Promise<void>((resolve) => { markEntered = resolve; }), resolve: () => markEntered() };
	const release = { promise: new Promise<void>((resolve) => { releaseTool = resolve; }), resolve: () => releaseTool() };
	t.after(() => release.resolve());
	const registry = Durable.createRegistry();
	registry.install(Durable.defineExtension({ name: "display-write-probe", tools: [Durable.defineTool({
		name: "hold", description: "Hold one busy tool.", parameters: obj({}, { open: true }),
		execute: async () => { entered.resolve(); await release.promise; return { output: [{ type: "text", text: "released" }] }; },
	})] }));
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models: await scriptedRuntime([toolCallMessage("hold", {}), answerMessage()]), registry }, context);
	t.after(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	harness.resume();
	const busy = await root.submit({ type: "input", content: "Hold a tool" }, context);
	await entered.promise;
	try {
		const before = await root.context(context);
		const display = await root.submit({ type: "write", entry: { kind: "fixture.display", data: { text: "shown now" } } }, context);
		assert.equal((await display.wait(context)).status, "done");
		assert.notEqual((await busy.status(context)).status, "done");
		assert.deepEqual((await root.context(context)).messages, before.messages);
	} finally { release.resolve(); }
	assert.equal((await busy.wait(context)).status, "done");
});
