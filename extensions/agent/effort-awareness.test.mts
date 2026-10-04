import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { AgentCatalog } from "./catalog.ts";
import { createAgentContribution } from "./durable-agents.ts";
import { EFFORT_AWARENESS_PROMPT_BYTES, EFFORT_AWARENESS_SELF_BYTES, formatEffortAwareness, readEffortAwareness } from "./effort-awareness.ts";
import { EffortAwarenessSchema } from "./effort-schema.ts";
import type { PrimaryIntentClaim } from "./effort-presence.ts";
import { PRIMARY_ENDPOINT_VERSION, primaryEndpointPath } from "./primary-channel.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "effort-awareness-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".primaries"));
	return { root, catalog: new AgentCatalog(root), self: { id: randomUUID(), cwd: root } };
}
function claim(purpose = "Own published purpose"): PrimaryIntentClaim {
	return { purpose, integration: "Run focused checks before integration", authority: "Operator: edit only the agent slice", scope: { paths: ["extensions/agent"], branches: ["topic"] }, updatedAt: "2026-10-04T10:00:00.000Z" };
}
function publish(root: string, id: string, intentClaim = claim(), cwd = root): void {
	writeFileSync(primaryEndpointPath(root, id), JSON.stringify({ id, version: PRIMARY_ENDPOINT_VERSION, serverId: randomUUID(), cwd, hostname: hostname(), pid: process.pid, socketPath: join(root, "missing.sock"), startedAt: "2026-10-04T09:00:00Z", intentClaim }));
}
function publishThread(catalog: AgentCatalog, root: string): string {
	const record = catalog.create({ cwd: root, agentDir: root, packageDir: root, model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off", ownerId: "owner" });
	const id = `${record.storageId}/${"a".repeat(32)}`;
	catalog.updateView(record.storageId, { storageId: record.storageId, updatedAt: "2026-10-04T10:00:00.000Z", rows: [], coverage: { complete: true, omitted: 0 } }, { items: [{ id, title: "Active shared work", purpose: "Coordinate integration", updatedAt: 100, closed: false, members: 2 }], omitted: 0, updatedAt: "2026-10-04T10:00:00.000Z" });
	return id;
}

it("unifies self-published purpose, related presence and active thread hints without schema drift", async (t) => {
	const { root, catalog, self } = fixture(t);
	const intentClaim = claim();
	publish(root, self.id, intentClaim);
	const peer = randomUUID();
	publish(root, peer, claim("Related effort"));
	const threadId = publishThread(catalog, root);
	const view = await readEffortAwareness(root, { ...self, intentClaim, observedPurpose: { source: "interactive-input", text: "First interactive input" } }, catalog);
	assert.equal(Value.Check(EffortAwarenessSchema, view), true, JSON.stringify([...Value.Errors(EffortAwarenessSchema, view)]));
	assert.deepEqual(view.self.intentClaim, intentClaim);
	assert.equal(view.self.observedPurpose?.text, "First interactive input");
	assert.deepEqual(view.presence.efforts.map((effort) => effort.id), [peer]);
	assert.deepEqual(view.threads.items.map((thread) => thread.id), [threadId]);
	const prompt = formatEffortAwareness(view);
	assert.ok(prompt.includes('"authority":"Operator: edit only the agent slice","scope":{"paths":["extensions/agent"],"branches":["topic"]}'));
	assert.ok(prompt.includes("Own published purpose"));
	assert.ok(prompt.includes("Active shared work"));
	assert.ok(prompt.includes("do not grant authority to the reader"));
	assert.deepEqual(await readEffortAwareness(root, { ...self, intentClaim, observedPurpose: { source: "interactive-input", text: "First interactive input" } }, catalog), view);
	assert.equal(formatEffortAwareness(view), prompt);
});

it("includes unrelated local purpose claims without full authority or integration detail", async (t) => {
	const { root, self } = fixture(t);
	const peer = randomUUID();
	const intentClaim = { ...claim("Unrelated local purpose"), integration: "PRIVATE-INTEGRATION", authority: "PRIVATE-AUTHORITY", scope: { paths: ["PRIVATE-PATH"], branches: ["private-branch"], fullGate: true }, contactThread: "contact/thread" };
	publish(root, peer, intentClaim, join(root, "other-cwd"));
	const view = await readEffortAwareness(root, self);
	const effort = view.presence.efforts[0];
	assert.equal(effort?.id, peer);
	assert.equal(effort.relationship, "machine");
	assert.equal(effort.purposeClaim, "Unrelated local purpose");
	assert.equal(effort.contactThreadClaim, "contact/thread");
	assert.equal(effort.intentClaim, undefined);
	assert.ok(effort.sharedSubstrates?.includes("machine-gates"));
	assert.equal(Value.Check(EffortAwarenessSchema, view), true);
	const serialized = JSON.stringify(view);
	const prompt = formatEffortAwareness(view);
	for (const secret of ["PRIVATE-INTEGRATION", "PRIVATE-AUTHORITY", "PRIVATE-PATH"]) {
		assert.equal(serialized.includes(secret), false);
		assert.equal(prompt.includes(secret), false);
	}
	assert.ok(prompt.includes("Unrelated local purpose"));
});

it("preserves repository state and declared full gates in the current self view", async (t) => {
	const { root, self } = fixture(t);
	publish(root, randomUUID());
	const intentClaim = { ...claim(), scope: { ...claim().scope, fullGate: true } };
	const view = await readEffortAwareness(root, { ...self, repository: "/repository/common", repositoryState: "git", intentClaim });
	assert.equal(view.self.repositoryState, "git");
	assert.equal(view.self.repository, "/repository/common");
	assert.ok(formatEffortAwareness(view).includes('"fullGate":true'));
	const largeClaim = { ...intentClaim, authority: "😀".repeat(512), integration: "😀".repeat(512), scope: { ...intentClaim.scope, paths: Array.from({ length: 4 }, () => "😀".repeat(64)), branches: Array.from({ length: 4 }, () => "😀".repeat(64)) } };
	const wide = await readEffortAwareness(root, { ...self, intentClaim: largeClaim });
	const prompt = formatEffortAwareness(wide);
	assert.ok(prompt.includes("Own published purpose"));
	assert.ok(prompt.includes("Self detail shortened"));
	assert.ok(Buffer.byteLength(prompt) <= EFFORT_AWARENESS_PROMPT_BYTES);
});

it("bounds self input with explicit omissions rather than a shortened authority claim", async (t) => {
	const { root, self } = fixture(t);
	const view = await readEffortAwareness(root, { ...self, intentClaim: claim("x".repeat(EFFORT_AWARENESS_SELF_BYTES * 2)) });
	assert.equal(view.self.omitted, true);
	assert.equal(view.self.intentClaim, undefined);
	assert.ok(Buffer.byteLength(JSON.stringify(view.self)) <= EFFORT_AWARENESS_SELF_BYTES);
	assert.equal(Value.Check(EffortAwarenessSchema, view), true);
});

it("reserves prompt space for active threads and marks shortened claim text and omitted efforts", async (t) => {
	const { root, catalog, self } = fixture(t);
	const longClaim = claim("😀".repeat(256));
	longClaim.scope.paths.push(...Array.from({ length: 12 }, (_, index) => `extensions/agent/${index}`));
	for (let index = 0; index < 20; index++) publish(root, randomUUID(), longClaim);
	publishThread(catalog, root);
	const view = await readEffortAwareness(root, self, catalog);
	const prompt = formatEffortAwareness(view);
	assert.ok(Buffer.byteLength(prompt) <= EFFORT_AWARENESS_PROMPT_BYTES);
	assert.ok(prompt.includes("Active shared work"));
	assert.ok(prompt.includes("Claim text or scope shortened"), prompt);
	assert.match(prompt, /Prompt omissions: self 0, related efforts [1-9][0-9]*, active threads 0/u);
	assert.equal(formatEffortAwareness(view), prompt);
});

it("keeps zero-live-effort context to one line without losing unknown coverage", async (t) => {
	const { root, catalog, self } = fixture(t);
	const view = await readEffortAwareness(root, { ...self, intentClaim: claim("Do not repeat my whole claim") }, catalog);
	assert.equal(formatEffortAwareness(view), "No other live efforts or active thread hints in the covered sources.");
	publishThread(catalog, root);
	const withThread = await readEffortAwareness(root, self, catalog);
	const unknownView = { ...withThread, self: { ...self, omitted: true }, presence: { ...withThread.presence, efforts: [
		{ id: "unknown", cwd: root, startedAt: "now", relationship: "cwd" as const, liveness: "unknown" as const },
		{ id: "incompatible", cwd: root, startedAt: "now", relationship: "cwd" as const, liveness: "incompatible" as const },
	], coverage: { ...withThread.presence.coverage, complete: false, omitted: 2, unreadable: 3 } } };
	unknownView.threads.coverage = { ...unknownView.threads.coverage, complete: false, omittedHints: 2, omittedResults: 1, missingHints: 1, unreadable: 4, unvisited: true };
	const line = formatEffortAwareness(unknownView);
	assert.equal(line.split("\n").length, 1);
	assert.ok(Buffer.byteLength(line) < 512);
	for (const label of ["1 unknown", "1 incompatible", "2 omitted", "3 unreadable", "Active thread hints: 1", "2 source omissions", "1 result omissions", "1 missing", "4 unreadable", "unvisited yes", "Own detail incomplete", "agent_status"]) assert.ok(line.includes(label), label);
});

it("refreshes native root and child sections at model requests while stable state emits no new section patch", async (t) => {
	const { root: sessionsRoot, catalog } = fixture(t);
	const peer = randomUUID();
	publish(sessionsRoot, peer, claim("BEFORE-PURPOSE"));
	publishThread(catalog, sessionsRoot);
	const requests: Message[][] = [];
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 20 }, () => (request) => {
		requests.push([...request.messages]);
		return fauxAssistantMessage("DONE");
	}));
	const registry = Durable.createRegistry();
	const extension = createAgentContribution({ source: "/extensions/agent/index.ts" }).create({ durable: Durable, storageId: randomUUID(), catalogRoot: join(sessionsRoot, "durable"), cwd: sessionsRoot, services: { modelRuntime: { getModel: (provider, modelId) => models.getModel(provider, modelId) } } });
	registry.install(extension);
	const context = BACKGROUND_CONTEXT;
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	t.after(async () => { await harness.close(context); });
	harness.resume();
	const model = { provider: "faux", modelId: "faux-1" };
	const root = await harness.root(context, { agent: { model } });
	const say = async (conversation: Durable.Conversation) => { const submission = await conversation.submit({ type: "input", content: "Read current view" }, context); await submission.wait(context); };
	await say(root);
	assert.ok(getCurrentSystemPrompt(requests.at(-1) ?? []).includes("BEFORE-PURPOSE"), getCurrentSystemPrompt(requests.at(-1) ?? []));
	await say(root);
	const sectionEntries = requests.at(-1)?.filter((message) => message.role === "system" && message.sections?.["agent-efforts"] !== undefined);
	assert.equal(sectionEntries?.length, 1);
	const count = requests.length;
	publish(sessionsRoot, peer, claim("AFTER-PURPOSE"));
	assert.equal(requests.length, count, "a published endpoint does not wake a model");
	await say(root);
	const currentPrompt = getCurrentSystemPrompt(requests.at(-1) ?? []);
	assert.ok(currentPrompt.includes("AFTER-PURPOSE"));
	assert.equal(currentPrompt.includes("BEFORE-PURPOSE"), false);
	const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, extensions: [extension] } }, context);
	await say(child);
	assert.ok(getCurrentSystemPrompt(requests.at(-1) ?? []).includes("AFTER-PURPOSE"));
	assert.ok(getCurrentSystemPrompt(requests.at(-1) ?? []).includes("Active shared work"));
	rmSync(primaryEndpointPath(sessionsRoot, peer));
	await say(child);
	const emptyPrompt = getCurrentSystemPrompt(requests.at(-1) ?? []);
	assert.equal(emptyPrompt.includes("AFTER-PURPOSE"), false);
	const body = emptyPrompt.match(/<agent-efforts>\n([\s\S]*?)\n<\/agent-efforts>/u)?.[1];
	assert.ok(body);
	assert.equal(body.split("\n").length, 1);
	assert.ok(body.includes("Active thread hints: 1"));
	rmSync(join(sessionsRoot, "durable"), { recursive: true, force: true });
	await say(root);
	assert.ok(getCurrentSystemPrompt(requests.at(-1) ?? []).includes("No other live efforts or active thread hints in the covered sources."));
});

it("adds awareness only to native untargeted status and preserves host fields and selected status", async (t) => {
	const { root: sessionsRoot } = fixture(t);
	const peer = randomUUID();
	publish(sessionsRoot, peer);
	const requests: Message[][] = [];
	const calls: Readonly<Record<string, unknown>>[] = [];
	const hostStatus = { conversations: [], live: false, storageId: randomUUID() };
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 20 }, () => (request) => {
		requests.push([...request.messages]);
		const last = request.messages.findLast((message) => message.role !== "system");
		if (last?.role !== "user") return fauxAssistantMessage("DONE");
		const args: Durable.JsonObject = last.content === "selected" ? { sessionId: peer } : last.content === "fleet" ? { view: "fleet" } : {};
		return fauxAssistantMessage([fauxToolCall("agent_status", args)], { stopReason: "toolUse" });
	}));
	const registry = Durable.createRegistry();
	registry.install(createAgentContribution({ source: "/extensions/agent/index.ts", dispatch: async (method, params) => { assert.equal(method, "status"); calls.push(params); return hostStatus; } }).create({ durable: Durable, storageId: randomUUID(), catalogRoot: join(sessionsRoot, "durable"), cwd: sessionsRoot, services: { modelRuntime: { getModel: (provider, modelId) => models.getModel(provider, modelId) } } }));
	const context = BACKGROUND_CONTEXT;
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	t.after(async () => { await harness.close(context); });
	harness.resume();
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const say = async (content: string) => { const submission = await root.submit({ type: "input", content }, context); await submission.wait(context); };
	await say("overview");
	const overview = requests.at(-1)?.findLast((message) => message.role === "toolResult");
	assert.equal(overview?.role, "toolResult");
	const text = overview?.role === "toolResult" ? overview.content.flatMap((part) => part.type === "text" && part.text.startsWith("{") ? [part.text] : []).at(0) : "";
	assert.ok(text, JSON.stringify(overview));
	const structured = JSON.parse(text ?? "") as typeof hostStatus & { awareness: Awaited<ReturnType<typeof readEffortAwareness>> };
	assert.deepEqual({ conversations: structured.conversations, live: structured.live, storageId: structured.storageId }, hostStatus);
	assert.equal(structured.awareness.presence.efforts[0]?.id, peer);
	await say("selected");
	const selected = requests.at(-1)?.findLast((message) => message.role === "toolResult");
	const selectedText = selected?.role === "toolResult" ? selected.content.flatMap((part) => part.type === "text" && part.text.startsWith("{") ? [part.text] : []).at(0) : "";
	assert.deepEqual(JSON.parse(selectedText ?? ""), hostStatus);
	await say("fleet");
	const fleet = requests.at(-1)?.findLast((message) => message.role === "toolResult");
	const fleetText = fleet?.role === "toolResult" ? fleet.content.flatMap((part) => part.type === "text" && part.text.startsWith("{") ? [part.text] : []).at(0) : "";
	const fleetResult = JSON.parse(fleetText ?? "");
	assert.equal(fleetResult.view, "fleet");
	assert.equal("awareness" in fleetResult, false);
	assert.deepEqual(calls, [{}, { sessionId: peer }]);
});
