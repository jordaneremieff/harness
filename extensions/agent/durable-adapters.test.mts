import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as Durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createAgentContribution } from "./durable-agents.ts";
import { answerMessage, fixtureModelId, fixtureProvider, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { waitForReceipts } from "./durable-controls.ts";

const listing = {
	rows: [], nextCursor: null,
	coverage: { complete: true, storagesVisited: 0, unavailable: [], profileHints: { complete: true, unknownStorages: 0, omitted: 0 } },
	observedAt: "2026-10-13T00:00:00.000Z", authority: "native catalog scan",
};

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
		name: "nested-probe", description: "Check nested controls.", parameters: Type.Object({}),
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
	const events: Durable.AgentEvent[] = [];
	const stream = await Durable.watchEvents(harness, root.id, context);
	stream.start(async (batch) => { events.push(...batch); });
	t.after(() => stream.stop());
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
	const nestedEnds = events.filter((event) => event.type === "tool_execution_end" && event.parentToolCallId !== undefined);
	assert.equal(nestedEnds.length, 3);
	assert.ok(nestedEnds.every((event) => event.type === "tool_execution_end" && event.taskId !== undefined && event.parentTaskId !== undefined && event.result !== undefined && event.entry === undefined));
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
		name: "hold", description: "Hold one busy tool.", parameters: Type.Object({}),
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

it("rejects a pending receipt wait with SessionFailed after a fatal storage read", { timeout: 10000 }, async (t) => {
	const cause = new Error("synthetic storage read failure");
	const storage = new Durable.MemoryStorage();
	const harness = await Durable.Harness.open(storage, { models: await scriptedRuntime([]), registry: Durable.createRegistry() }, context);
	t.after(() => harness.close(context));
	await harness.root(context);
	const pending = waitForReceipts(harness, "unserved-owner", context);
	const failed = (error: unknown) => error instanceof Durable.SessionFailed && error.cause === cause;
	const rejected = assert.rejects(pending, failed);
	storage.conversation = async () => { throw cause; };
	await assert.rejects(harness.conversation(999 as Durable.ConversationId, context), (error) => error === cause);
	await rejected;
	assert.deepEqual(await harness.closed, { reason: "failed", error: cause });
	await assert.rejects(harness.root(context), failed);
});
