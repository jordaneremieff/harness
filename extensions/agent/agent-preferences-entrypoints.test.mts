import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

const preferenceOverride = process.env.PI_AGENT_PREFERENCES_FILE;
delete process.env.PI_AGENT_PREFERENCES_FILE;
after(() => { if (preferenceOverride !== undefined) process.env.PI_AGENT_PREFERENCES_FILE = preferenceOverride; });
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import registerAgentExtension from "./index.ts";
import { AgentManager } from "./manager.ts";
import { agentPreferencesPath, type ExecutionSelection, type PreferenceSnapshot } from "./agent-preferences.ts";
import * as Durable from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentContribution } from "./durable-agents.ts";
import { HOST_CONTRACT, MANAGER_CONTRACT, CONTROL_BINDING_CONTRACT } from "./version-contract.ts";
import { acquireHost, waitForHostRelease } from "./host-client.ts";
import { runtimeFixture, trackHost, killHost, waitForReceipt } from "./durable-runtime-fixture.mts";
import { AgentCatalog, hostMetadata } from "./catalog.ts";

type RegisteredTool = { name: string; parameters: TSchema; execute(id: string, input: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<unknown> };

it("ordinary and native callers share machine preferences and receive advisory substitution guidance",  async (t) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "ordinary-presets-")));
	const root = join(directory, "sessions"); mkdirSync(root);
	const previous = { agent: process.env.PI_AGENT_DIR, sessions: process.env.PI_AGENT_SESSIONS_DIR };
	process.env.PI_AGENT_DIR = directory; process.env.PI_AGENT_SESSIONS_DIR = root;
	const manager = new AgentManager({ root, agentDir: directory, packageDir: directory });
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	owners.managers.set(root, manager);
	t.after(async () => { await manager.close(); owners.managers.delete(root); if (previous.agent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previous.agent; if (previous.sessions === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous.sessions; rmSync(directory, { recursive: true, force: true }); });
	const seen: Array<{ method: string; input: unknown }> = [];
	manager.spawn = async (input) => { seen.push({ method: "spawn", input }); return {}; };
	manager.place = async (input) => { seen.push({ method: "place", input }); return {}; };
	manager.control = async (method, input) => { seen.push({ method, input }); return {}; };
	const tools = new Map<string, RegisteredTool>();
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	type StartEvent = { systemPromptOptions: { sections: Record<string, string> } };
	let beforeStart: ((event: StartEvent, ctx: ExtensionContext) => Promise<void>) | undefined;
	registerAgentExtension({ events: { on: () => () => {}, emit() {} }, on(name: string, handler: typeof beforeStart) { if (name === "before_agent_start") beforeStart = handler; }, registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); }, getThinkingLevel: () => "off" } as unknown as ExtensionAPI);
	const ctx = { cwd: directory, sessionManager: { getSessionId: () => "primary", getSessionName: () => undefined, getBranch: () => entries }, modelRegistry: { find: () => undefined, getAll: () => [] } } as unknown as ExtensionContext;
	for (const name of ["agent_spawn", "agent_place", "agent_configure"]) {
		const tool = tools.get(name); assert.ok(tool);
		const input = { preset: "review", model: "acme/model-x", thinkingLevel: "high", ...(name === "agent_configure" ? { sessionId: "target" } : {}) };
		assert.equal(Value.Check(tool.parameters, input), true);
		await tool.execute(name, input, undefined, undefined, ctx);
	}
	assert.deepEqual(seen.map((entry) => entry.method), ["spawn", "place", "configure"]);
	for (const entry of seen) assert.equal((entry.input as { preset: string }).preset, "review");
	const snapshots = seen.map((entry) => (entry.input as { preferenceSnapshot: unknown }).preferenceSnapshot);
	writeFileSync(agentPreferencesPath(directory), "malformed");
	for (const name of ["agent_spawn", "agent_place", "agent_configure"]) {
		const input = { preset: "review", model: "acme/model-x", thinkingLevel: "high", ...(name === "agent_configure" ? { sessionId: "target" } : {}) };
		const tool = tools.get(name); assert.ok(tool);
		await tool.execute(name, input, undefined, undefined, ctx);
	}
	assert.deepEqual(seen.slice(3).map((entry) => (entry.input as { preferenceSnapshot: unknown }).preferenceSnapshot), snapshots);
	const spawn = tools.get("agent_spawn"); const send = tools.get("agent_send"); assert.ok(spawn && send);
	await assert.rejects(spawn.execute("agent_spawn", { preset: "other" }, undefined, undefined, ctx), /different inputs/u);
	assert.equal(Value.Check(send.parameters, { sessionId: "target", message: "hello", preset: "review" }), false);
	writeFileSync(agentPreferencesPath(directory), JSON.stringify({ version: 1, presets: { review: { model: "acme/model-x" }, alternate: { model: "other/model-y" } }, preferences: { excludedProviders: ["acme"], quotaSubstitutionOrder: ["alternate", "review"], reportingNotes: "Current note" } }));
	assert.ok(beforeStart);
	const first: StartEvent = { systemPromptOptions: { sections: {} } }; await beforeStart(first, ctx);
	assert.match(first.systemPromptOptions.sections["agent-preferences"], /Current note/u);
	await spawn.execute("shared-document", { preset: "review" }, undefined, undefined, ctx);
	const admitted = seen.at(-1); assert.ok(admitted);
	const ordinarySnapshot = (admitted.input as { preferenceSnapshot: PreferenceSnapshot }).preferenceSnapshot;
	const models = createModels();
	const primaryProvider = fauxProvider({ provider: "acme", models: [{ id: "model-x" }] });
	const otherProvider = fauxProvider({ provider: "other", models: [{ id: "model-y" }] });
	models.setProvider(primaryProvider.provider); models.setProvider(otherProvider.provider);
	const requests: Message[][] = [];
	primaryProvider.setResponses([
		(request) => { requests.push([...request.messages]); return fauxAssistantMessage([fauxToolCall("agent_spawn", { preset: "review" })], { stopReason: "toolUse" }); },
		(request) => { requests.push([...request.messages]); return fauxAssistantMessage("Done"); },
	]);
	const registry = Durable.createRegistry();
	registry.install(createAgentContribution({ source: "/abs/extensions/agent/index.ts" }).create({ durable: Durable, storageId: "shared-machine", cwd: directory, agentDir: directory, services: { modelRuntime: models } }));
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	harness.resume();
	try {
		const native = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "acme", modelId: "model-x" } } });
		await (await native.submit({ type: "input", content: "Create the review worker" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const messages = requests.flat();
		const outcome = messages.find((message) => message.role === "toolResult" && message.toolName === "agent_spawn");
		assert.ok(outcome?.role === "toolResult" && !outcome.isError);
		const result = (outcome.details as { structuredContent: { selection: ExecutionSelection; conversationId: Durable.ConversationId } }).structuredContent;
		assert.equal(result.selection.source.path, ordinarySnapshot.source.path);
		assert.equal(result.selection.source.digest, ordinarySnapshot.source.digest);
		assert.equal(result.selection.values.model, ordinarySnapshot.document?.presets.review.model);
		assert.deepEqual((await harness.snapshot(Durable.AgentDoc, result.conversationId, BACKGROUND_CONTEXT))?.model, { provider: "acme", modelId: "model-x" }, "provider exclusion and substitution order do not retune the new child");
		assert.deepEqual((await native.agent(BACKGROUND_CONTEXT)).model, { provider: "acme", modelId: "model-x" }, "guidance does not retune its caller");
		assert.equal(otherProvider.state.callCount, 0);
		const nativePrompt = getCurrentSystemPrompt(requests[0]);
		for (const prompt of [first.systemPromptOptions.sections["agent-preferences"], nativePrompt]) {
			assert.match(prompt, /Excluded provider preference: "acme"/u);
			assert.match(prompt, /Quota substitution order: \["alternate","review"\]/u);
			assert.match(prompt, /other\/model-y/u);
			assert.match(prompt, /never automatic fallback/u);
		}
		writeFileSync(agentPreferencesPath(directory), JSON.stringify({ version: 1, presets: { review: { model: "other/model-y" } } }));
		primaryProvider.appendResponses([
			() => fauxAssistantMessage([fauxToolCall("agent_spawn", { preset: "review" })], { stopReason: "toolUse" }),
			(request) => { requests.push([...request.messages]); return fauxAssistantMessage("Done"); },
		]);
		await (await native.submit({ type: "input", content: "Create another review worker" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const latest = requests.at(-1)?.findLast((message) => message.role === "toolResult" && message.toolName === "agent_spawn");
		assert.ok(latest?.role === "toolResult" && !latest.isError);
		const replacement = (latest.details as { structuredContent: { selection: ExecutionSelection; conversationId: Durable.ConversationId } }).structuredContent;
		assert.notEqual(replacement.conversationId, result.conversationId);
		assert.notEqual(replacement.selection.source.digest, result.selection.source.digest);
		assert.equal(replacement.selection.values.model, "other/model-y");
		assert.deepEqual((await harness.snapshot(Durable.AgentDoc, replacement.conversationId, BACKGROUND_CONTEXT))?.model, { provider: "other", modelId: "model-y" });
		assert.deepEqual((await harness.snapshot(Durable.AgentDoc, result.conversationId, BACKGROUND_CONTEXT))?.model, { provider: "acme", modelId: "model-x" });
	} finally { await harness.close(BACKGROUND_CONTEXT); }
	writeFileSync(agentPreferencesPath(directory), "malformed");
	const next: StartEvent = { systemPromptOptions: { sections: {} } }; await beforeStart(next, ctx);
	assert.match(next.systemPromptOptions.sections["agent-preferences"], /unavailable/u);
	assert.doesNotMatch(next.systemPromptOptions.sections["agent-preferences"], /Current note/u);
});

it("native local creation uses the common default, override, and refusal precedence without caller inheritance", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "native-default-presets-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = agentPreferencesPath(directory);
	const models = createModels();
	const parent = fauxProvider({ provider: "acme", models: [{ id: "model-x" }] });
	const worker = fauxProvider({ provider: "other", models: [{ id: "model-y" }] });
	models.setProvider(parent.provider); models.setProvider(worker.provider);
	const write = (enforceRoster = false) => writeFileSync(path, JSON.stringify({ version: 1, presets: { standard: { model: "other/model-y", thinkingLevel: "low", role: "Review", checkInMinutes: 2 } }, preferences: { defaultPreset: "standard", enforceRoster, ...(enforceRoster ? { excludedProviders: ["other"] } : {}) } }));
	write();
	const registry = Durable.createRegistry();
	const extension = createAgentContribution({ source: "/abs/extensions/agent/index.ts" }).create({ durable: Durable, storageId: "native-default", cwd: directory, agentDir: directory, services: { modelRuntime: models } });
	registry.install(extension);
	for (const name of ["agent_spawn", "agent_place", "agent_configure"]) assert.match(JSON.stringify(extension.tools?.find((tool) => tool.name === name)?.parameters), /standard/u);
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	t.after(() => harness.close(BACKGROUND_CONTEXT)); harness.resume();
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "acme", modelId: "model-x" }, thinkingLevel: "high" } });
	const run = async (input: Durable.JsonObject): Promise<Message> => {
		let observed: Message[] = [];
		parent.setResponses([() => fauxAssistantMessage([fauxToolCall("agent_spawn", input)], { stopReason: "toolUse" }), (request) => { observed = [...request.messages]; return fauxAssistantMessage("Done"); }]);
		await (await root.submit({ type: "input", content: "Create an idle child" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const result = observed.findLast((message) => message.role === "toolResult" && message.toolName === "agent_spawn");
		assert.ok(result); return result;
	};
	const selectionOf = (result: Message) => {
		assert.ok(result.role === "toolResult" && !result.isError, JSON.stringify(result));
		return (result.details as { structuredContent: { selection: ExecutionSelection; conversationId: Durable.ConversationId } }).structuredContent;
	};
	const first = selectionOf(await run({}));
	assert.equal(first.selection.values.model, "other/model-y");
	assert.equal(first.selection.origins.model, "defaultPreset");
	assert.equal(first.selection.origins.thinkingLevel, "defaultPreset");
	assert.deepEqual(first.selection.presetNames, ["standard"]);
	assert.deepEqual((await harness.snapshot(Durable.AgentDoc, first.conversationId, BACKGROUND_CONTEXT))?.model, { provider: "other", modelId: "model-y" });
	const explicit = selectionOf(await run({ model: "acme/model-x" }));
	assert.equal(explicit.selection.origins.model, "explicit");
	assert.equal(explicit.selection.values.thinkingLevel, "off");
	assert.match(explicit.selection.diagnostics[0].message, /Explicit model override.*matches no preset/u);
	assert.equal(explicit.selection.preset, undefined);
	const mixed = selectionOf(await run({ preset: "standard", model: "acme/model-x", thinkingLevel: "high" }));
	assert.equal(mixed.selection.origins.thinkingLevel, "explicit");
	assert.equal(mixed.selection.values.thinkingLevel, "high");
	write(true);
	for (const input of [{}, { model: "acme/model-x" }] as Durable.JsonObject[]) {
		const refused = await run(input);
		assert.ok(refused.role === "toolResult" && refused.isError);
		assert.match(JSON.stringify(refused), /enforceRoster.*standard.*digest/u);
	}
	writeFileSync(path, JSON.stringify({ version: 1, presets: {} }));
	const absentDefault = await run({});
	assert.ok(absentDefault.role === "toolResult" && absentDefault.isError);
	assert.match(JSON.stringify(absentDefault), /defaultPreset.*agent-preferences.json/u);
	assert.deepEqual((await root.agent(BACKGROUND_CONTEXT)).model, { provider: "acme", modelId: "model-x" });
	assert.equal(worker.state.callCount, 0, "idle children start no model work");
});

it("configure resolves a preset against its target and retains the snapshot across retries", { timeout: 30000 }, async (t) => {
	const fixture = runtimeFixture(t);
	const path = agentPreferencesPath(fixture.agentDir);
	writeFileSync(path, JSON.stringify({ version: 1, presets: { review: { model: `${fixture.metadata.model.provider}/${fixture.metadata.model.modelId}`, thinkingLevel: "high", role: "Review", checkInMinutes: 2 } } }));
	const client = await acquireHost(fixture.metadata, { env: fixture.env("tool-round") }); trackHost(t, client.pid);
	t.after(() => client.close());
	const first = await client.request("configure", { preset: "review", thinkingLevel: "low", requestId: "preset-configure" }) as { outcome: string; after: { thinkingLevel: string }; selection: ExecutionSelection };
	assert.equal(first.outcome, "applied");
	assert.equal(first.after.thinkingLevel, "low");
	assert.equal(first.selection.origins.thinkingLevel, "explicit");
	assert.deepEqual(first.selection.unapplied, ["role", "checkInMinutes"]);
	writeFileSync(path, "malformed");
	for (let index = 0; index < 65; index++) await client.request("configure", { name: `Name ${index}`, requestId: `another-configure-${index}` });
	const replay = await client.request("configure", { preset: "review", thinkingLevel: "low", requestId: "preset-configure" }) as typeof first;
	assert.deepEqual(replay.selection, first.selection);
	await assert.rejects(client.request("configure", { preset: "review", requestId: "new-configure" }), /review.*agent-preferences.json/u);
	const plain = await client.request("configure", { name: "Renamed", requestId: "plain-configure" }) as typeof first;
	assert.equal(plain.outcome, "applied");
	assert.equal(plain.selection.source.status, "unavailable");
	assert.equal(plain.selection.origins.model, "retained");
	assert.equal(plain.after.thinkingLevel, "low");
});

for (const method of ["resolve-agent", "place"] as const) it(`native ${method} replay retains its selection after a lost result, file edit, and target configure`, { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const path = agentPreferencesPath(f.agentDir);
	const model = `${f.metadata.model.provider}/${f.metadata.model.modelId}`;
	const writePreset = (thinkingLevel: string, checkInMinutes: number) => writeFileSync(path, JSON.stringify({ version: 1, presets: { review: { model, thinkingLevel, checkInMinutes, role: "Review sources" } } }));
	writePreset("low", 0);
	const args = { preset: "review", prompt: "Review this input", senderIdentity: f.metadata.storageId, origin: "model", ...(method === "resolve-agent" ? { handle: "reviewer" } : { area: f.childCwd }) };
	let caller = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, caller.pid);
	t.after(() => caller.close());
	type Outcome = { sessionId: string; selection: ExecutionSelection; result: { submissionId: number } };
	const first = await caller.request(method, args, { requestId: "retained-creation" }).catch((cause: unknown) => { throw new Error("Initial native creation failed", { cause }); }) as Outcome;
	assert.equal(first.selection.origins.model, "preset");
	assert.equal(first.selection.values.thinkingLevel, "low");
	const record = new AgentCatalog(f.root).read(first.sessionId);
	assert.equal("selection" in record, false);
	const target = await acquireHost(hostMetadata(record), { env: f.env("answer") }); trackHost(t, target.pid);
	t.after(() => target.close());
	await waitForReceipt(target, f.metadata.storageId, first.result.submissionId);
	await target.request("acknowledge", { ownerId: f.metadata.storageId, submissionIds: [first.result.submissionId] });
	writePreset("high", 3);
	const configured = await target.request("configure", { thinkingLevel: "medium", requestId: "retune-target" }).catch((cause: unknown) => { throw new Error("Target configuration failed", { cause }); }) as { outcome: string };
	assert.equal(configured.outcome, "applied");
	// No tool result is committed in the caller. Process death also drops the RPC response cache.
	await waitForHostRelease(hostMetadata(record), { after: target.request("close"), signal: AbortSignal.timeout(10000) });
	await target.close();
	killHost(caller.pid); await caller.close().catch(() => {});
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	caller = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, caller.pid);
	const replay = await caller.request(method, args, { requestId: "retained-creation" }).catch((cause: unknown) => { throw new Error("Native creation replay failed", { cause }); }) as Outcome;
	assert.equal(replay.sessionId, first.sessionId);
	assert.deepEqual(replay.selection, first.selection);
	assert.equal(replay.result.submissionId, first.result.submissionId);
	const resumedTarget = await acquireHost(hostMetadata(record), { env: f.env("answer") }); trackHost(t, resumedTarget.pid);
	t.after(() => resumedTarget.close());
	const { prompt: _prompt, ...reuseArgs } = args;
	const fresh = await caller.request(method, reuseArgs, { requestId: "fresh-reuse" }).catch((cause: unknown) => { throw new Error("Fresh native reuse failed", { cause }); }) as Outcome;
	assert.equal(fresh.sessionId, first.sessionId);
	assert.equal(fresh.selection.origins.model, "retained");
	assert.equal(fresh.selection.values.thinkingLevel, "medium");
	assert.notEqual(fresh.selection.source.digest, first.selection.source.digest);
	assert.ok(fresh.selection.unapplied.includes("model"));
	assert.ok(fresh.selection.unapplied.includes("thinkingLevel"));
});

it("native place creation without a prompt returns a JSON-safe selection receipt", { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const caller = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, caller.pid);
	t.after(() => caller.close());
	const outcome = await caller.request("place", { area: f.childCwd, senderIdentity: f.metadata.storageId }, { requestId: "idle-place" }) as { sessionId: string; selection: ExecutionSelection };
	assert.equal(outcome.selection.origins.model, "defaultPreset");
	assert.equal("admission" in outcome, false);
	const target = await acquireHost(hostMetadata(new AgentCatalog(f.root).read(outcome.sessionId)), { env: f.env("answer") }); trackHost(t, target.pid);
	t.after(() => target.close());
});

for (const operation of ["creation", "configure"] as const) it(`native ${operation} retains only a SHA-256 comparison digest for long inputs and rejects changed replay inputs`, { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const caller = await acquireHost(f.metadata, { env: f.env("answer") }); trackHost(t, caller.pid);
	t.after(() => caller.close());
	const prompt = "Review neutral fixture input. ".repeat(4096);
	const name = "Fixture name ".repeat(20).slice(0, 256);
	const requestId = "bounded-comparison";
	const method = operation === "creation" ? "resolve-agent" : "configure";
	const input = operation === "creation"
		? { handle: "reviewer", prompt, checkInMinutes: 0, senderIdentity: f.metadata.storageId, origin: "operator" }
		: { name };
	type Outcome = { sessionId: string; selection: ExecutionSelection; result?: { submissionId: number }; outcome?: string };
	const first = await caller.request(method, input, { requestId }) as Outcome;
	const replay = await caller.request(method, input, { requestId }) as Outcome;
	assert.deepEqual(replay.selection, first.selection);
	await assert.rejects(caller.request(method, { ...input, ...(operation === "creation" ? { prompt: `${prompt}Changed` } : { name: `${name.slice(0, -1)}X` }) }, { requestId }), /request ID belongs to different inputs/u);
	if (operation === "creation") {
		assert.equal(replay.result?.submissionId, first.result?.submissionId);
		assert.ok(first.result);
		const metadata = hostMetadata(new AgentCatalog(f.root).read(first.sessionId));
		const target = await acquireHost(metadata, { env: f.env("answer") }); trackHost(t, target.pid);
		t.after(() => target.close());
		await target.request("abort", { sessionId: first.sessionId });
		await target.request("acknowledge", { ownerId: f.metadata.storageId, submissionIds: [first.result.submissionId] });
		await waitForHostRelease(metadata, { after: target.request("close") });
		await target.close();
	} else assert.equal(first.outcome, "applied");
	await waitForHostRelease(f.metadata, { after: caller.request("close") });
	await caller.close();
	const storage = await openNodeSqliteStorage(f.storagePath);
	try {
		const conversations = await storage.scanConversations({}, 2, undefined, BACKGROUND_CONTEXT);
		assert.equal(conversations.items.length, 1); assert.equal(conversations.next, undefined);
		const documents = await storage.scanDocuments({ scope: { kind: "conversation", conversationId: conversations.items[0].id }, at: "current", kind: "agent.execution-selection" }, 2, undefined, BACKGROUND_CONTEXT);
		assert.equal(documents.items.length, 1, "replay and rejection retain one request document");
		assert.equal(documents.next, undefined);
		const retained = await storage.document(documents.items[0].id, "current", BACKGROUND_CONTEXT);
		assert.ok(retained);
		assert.match(String(retained.value.input), /^[a-f0-9]{64}$/u);
		const comparison = operation === "creation"
			? ["reviewer", undefined, undefined, undefined, undefined, prompt, undefined, undefined, undefined, undefined, 0]
			: [undefined, undefined, undefined, name];
		assert.equal(retained.value.input, createHash("sha256").update(JSON.stringify(comparison)).digest("hex"));
	} finally { await storage.close(BACKGROUND_CONTEXT); }
});

it("advertises preset-aware process interfaces without changing message admission", () => {
	assert.equal(MANAGER_CONTRACT, "manager/2.0.0");
	assert.match(CONTROL_BINDING_CONTRACT, /^native-controls\/2\.0\.0;durable=/u);
	for (const method of ["spawn", "resolve-agent", "place"]) assert.deepEqual(HOST_CONTRACT.operations[method], { request: `${method}/2.0.0`, response: `${method}/2.0.0` });
	assert.deepEqual(HOST_CONTRACT.operations.configure, { request: "configure/1.2.0", response: "configure/1.2.0" });
	assert.equal(HOST_CONTRACT.operations["task-submit"].request, "task-submit/1.0.0");
});
