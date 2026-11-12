import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "./ordinary-entry.ts";
import type { AgentManager } from "./manager.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { eventLog } from "./host-fixture.mts";
import { waitForHostRelease, type HostConnection } from "./host-client.ts";

interface ObservedStatus {
	conversation: { busy: boolean; live: { runFailure?: { reason: string } } | null };
	deliveryError?: string;
}
function toolsFor(root: string, agentDir: string, cwd: string, env: Record<string, string>) {
	const values = { ...env, PI_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: root };
	const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values);
	const tools = new Map<string, ToolDefinition>();
	register({ events: { on: () => () => {}, emit() {} }, on() {}, getThinkingLevel: () => "off", registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {} } as unknown as ExtensionAPI);
	const ctx = { cwd, sessionManager: { getSessionId: () => "00000000-0000-4000-8000-000000000001", getSessionName: () => "primary", getEntries: () => [] }, modelRegistry: { find: () => undefined, getAll: () => [] } } as unknown as ExtensionToolContext;
	const managerRoot = realpathSync(root);
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	return {
		manager: () => { const manager = owners.managers.get(managerRoot); assert.ok(manager); return manager; },
		execute: (name: string, input: Record<string, unknown>, callId = randomUUID()) => { const tool = tools.get(name); assert.ok(tool); return tool.execute(callId, input, new AbortController().signal, undefined, ctx); },
		async close() { await owners.managers.get(managerRoot)?.close(); owners.managers.delete(managerRoot); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } },
	};
}
async function observeStatus(host: HostConnection, sessionId: string, predicate: (value: ObservedStatus) => boolean): Promise<ObservedStatus> {
	assert.ok(host.subscribeChanges);
	const events = eventLog<ObservedStatus>();
	let rejectLost!: (error: unknown) => void;
	const lost = new Promise<never>((_resolve, reject) => { rejectLost = reject; });
	const capture = () => { void host.request("status", { sessionId }).then((value) => events.push(value as ObservedStatus), rejectLost); };
	const stop = await host.subscribeChanges(capture, AbortSignal.timeout(20000));
	try { capture(); await Promise.race([events.waitFor((rows) => rows.some(predicate), 20000), lost]); const value = events.find(predicate); assert.ok(value); return value; }
	finally { stop(); }
}
async function liveShapes(t: TestContext): Promise<void> {
	let tools: ReturnType<typeof toolsFor> | undefined;
	t.after(async () => { await tools?.close(); });
	const f = runtimeFixture(t, { withAgentExtension: true });
	tools = toolsFor(f.root, f.agentDir, f.cwd, { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "0" });
	const done = f.marker("answered"), sessionId = f.metadata.storageId;
	await tools.execute("agent_send", { sessionId, message: "Return a short answer", checkInMinutes: 0 }); await done;
	const manager = tools.manager(), host = await manager.connectNative(sessionId, false);
	await observeStatus(host, sessionId, (value) => !value.conversation.busy && typeof value.deliveryError === "string");
	const compact = await tools.execute("agent_status", { sessionId });
	assert.equal((compact.details as { format: string }).format, "compact");
	assert.equal((compact.details as { conversation: { busy: boolean } }).conversation.busy, false);
	const delivery = (compact.structuredContent as { deliveryError: string }).deliveryError;
	assert.equal(typeof delivery, "string"); assert.ok(delivery.length > 0);
	const raw = await manager.status(sessionId);
	assert.equal(delivery, (raw as { deliveryError: string }).deliveryError);
	assert.deepEqual((await tools.execute("agent_status", { sessionId, detail: true })).details, raw);
	const frame = { action: "create", sessionId, title: "Shared work", purpose: "Exercise retained read selectors", authority: "Test fixture", source: "Fixture source", restrictions: "Local fixture only", acceptance: "Valid read result" };
	const created = await tools.execute("agent_collaborate", frame);
	const threadId = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/[a-f0-9]{32}/u.exec(JSON.stringify(created.details))?.[0]; assert.ok(threadId);
	await assert.rejects(tools.execute("agent_collaborate", { action: "read", threadId, before: 2, after: 0 }), /after and before are exclusive/u);
	await assert.rejects(tools.execute("agent_collaborate", { action: "read", threadId, knownFrameRevision: 1 }), /knownFrameRevision requires after/u);
	await tools.execute("agent_abort", { sessionId, release: true });
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(20000) });
	const cold = await tools.execute("agent_status", { sessionId });
	assert.equal((cold.details as { conversation: { availability: string } }).conversation.availability, "retained");
	assert.deepEqual((await tools.execute("agent_status", { sessionId, detail: true })).details, await manager.status(sessionId));
	const ordinary = randomUUID(), abort = new AbortController();
	t.after(() => abort.abort());
	await manager.registerPrimary(ordinary, { signal: abort.signal, cwd: f.cwd, name: "Peer primary", thinkingLevel: "off", send() {} });
	assert.equal(((await tools.execute("agent_status", { sessionId: ordinary })).details as { conversation: { identity: string } }).conversation.identity, ordinary);
	// Each read of an ordinary primary is its own observation, so only the observation time can differ between the two.
	const viaTool = (await tools.execute("agent_status", { sessionId: ordinary, detail: true })).details as { observedAt: string };
	const direct = await manager.status(ordinary) as { observedAt: string };
	assert.ok(Date.parse(viaTool.observedAt) <= Date.parse(direct.observedAt));
	assert.deepEqual({ ...viaTool, observedAt: direct.observedAt }, direct);
	await tools.close(); tools = undefined;
}
async function interruptedShapes(t: TestContext): Promise<void> {
	let tools: ReturnType<typeof toolsFor> | undefined;
	t.after(async () => { await tools?.close(); });
	const f = runtimeFixture(t, { withAgentExtension: true });
	tools = toolsFor(f.root, f.agentDir, f.cwd, { ...f.env("request"), PI_AGENT_IDLE_MINUTES: "0" });
	const sessionId = f.metadata.storageId;
	await tools.execute("agent_send", { sessionId, message: "Hold the request", checkInMinutes: 0 });
	const host = await tools.manager().connectNative(sessionId, false);
	await observeStatus(host, sessionId, (value) => value.conversation.busy);
	assert.equal(((await tools.execute("agent_status", { sessionId })).details as { conversation: { busy: boolean } }).conversation.busy, true);
	await tools.execute("agent_abort", { sessionId });
	const observed = await observeStatus(host, sessionId, (value) => !value.conversation.busy && value.conversation.live?.runFailure !== undefined);
	const failed = await tools.execute("agent_status", { sessionId });
	const conversation = (failed.structuredContent as { conversation: { runFailure: { reason: string } } }).conversation;
	assert.equal(conversation.runFailure.reason, observed.conversation.live?.runFailure?.reason);
	assert.equal(conversation.runFailure.reason, "aborted");
	assert.deepEqual((await tools.execute("agent_status", { sessionId, detail: true })).details, await tools.manager().status(sessionId));
	await tools.close(); tools = undefined;
}
it("passes real live, cold, primary and run failure values through ordinary registrations", { timeout: 120000 }, async (t) => {
	await liveShapes(t);
	await interruptedShapes(t);
});
