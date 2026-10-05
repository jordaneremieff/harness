import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { AssistantEntry, ROOT_CONVERSATION_ID, ToolTask, type JsonObject, type RegistryReader } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { AgentDeliveryDoc } from "./durable-controls.ts";
import { DurableHost } from "./durable-host.ts";
import { toolCallMessage } from "./durable-host-fixture.mts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { structuredObservation } from "./observation-schema.ts";
import { createPrimaryChannel, type PrimaryChannel, type PrimaryDelivery } from "./primary-channel.ts";
import type { OrdinaryPrimaryObservation } from "./primary-observation.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

it("native peer tools read ordinary retained work and errors without admitting primary work or acquiring its host", { timeout: 20000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "ordinary-native-observation-"));
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	let channel: PrimaryChannel | undefined;
	t.after(async () => {
		try { await runtime?.close(); }
		finally { try { await channel?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
	});
	const context = withAbortSignal(AbortSignal.timeout(10000), BACKGROUND_CONTEXT);
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir); mkdirSync(cwd);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [fileURLToPath(new URL("./index.ts", import.meta.url))], cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	const models = await createTestRuntime();
	const stream = t.mock.method(models, "stream", () => { throw new Error("Observation must not request a provider"); });
	const streamSimple = t.mock.method(models, "streamSimple", () => { throw new Error("Observation must not request a provider"); });
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd, agentDir, packageDir: getPackageDir(), model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", trust: true });
	const ordinaryId = randomUUID();
	const sessionFile = join(root, "ordinary.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	const retained = `${[
		{ type: "session", version: 3, id: ordinaryId, timestamp, cwd },
		{ type: "message", id: "11111111", parentId: null, timestamp, message: { role: "user", content: "Check the parser boundary", timestamp: 0 } },
		{ type: "message", id: "22222222", parentId: "11111111", timestamp, message: { role: "toolResult", toolName: "bash", toolCallId: "parser-call", content: [{ type: "text", text: "Parser test failed: unexpected token" }], isError: true, timestamp: 1 } },
	].map((value) => JSON.stringify(value)).join("\n")}\n`;
	writeFileSync(sessionFile, retained);
	const delivered: PrimaryDelivery[] = [];
	let resolveDelivery!: () => void;
	const delivery = new Promise<void>((resolve) => { resolveDelivery = resolve; });
	let trustCalls = 0;
	channel = await createPrimaryChannel({ id: ordinaryId, cwd, sessionFile, sessionsRoot: root, deliver: (message) => { delivered.push(message); resolveDelivery(); }, promptTrust: async () => { trustCalls++; return undefined; } });
	const open = DurableHost.open.bind(DurableHost);
	let native: DurableHost | undefined;
	let registry: RegistryReader | undefined;
	const opened: string[] = [];
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => {
		opened.push(args[0].storageId);
		assert.equal(args[0].storageId, record.storageId, "only the caller storage opens a Durable host");
		registry = args[0].registry;
		native = await open(...args);
		return native;
	});
	runtime = await createDurableRuntime(hostMetadata(record), { modelRuntime: models });
	assert.ok(native); assert.ok(registry);
	const peer = native;
	const tools = registry.snapshot().extension("agent")?.tools;
	assert.ok(tools);
	const recoveryBefore = catalog.read(record.storageId).recoveryDue;
	const invoke = async (name: string, args: JsonObject) => {
		const message = toolCallMessage(name, args);
		const taskId = await peer.harness.commit(async (tx) => {
			const assistant = await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [message] });
			return tx.createTask(ToolTask, { assistant: assistant.id, callId: `fixture-call-${name}` }, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID });
		}, context);
		const task = await peer.harness.waitForTask(taskId, context);
		assert.equal(task.state.outcome.status, "completed");
		assert.ok(task.state.outcome.result);
		const entryId = task.state.outcome.result.entryId;
		const entry = await peer.harness.commit((tx) => tx.entry(entryId), context);
		assert.equal(entry?.kind, "pi.tool-result");
		const result = entry?.model?.[0];
		assert.ok(result?.role === "toolResult");
		return result;
	};
	for (const [name, view] of [["agent_status", "status"], ["agent_inspect", "activity"], ["agent_inspect", "history"]] as const) {
		const result = await invoke(name, { sessionId: ordinaryId, ...(name === "agent_inspect" ? { view } : {}) });
		assert.equal(result.isError, false, JSON.stringify(result));
		const observed = (result.details as { structuredContent: OrdinaryPrimaryObservation }).structuredContent;
		const schema = (tools.find((tool) => tool.name === name) as { outputSchema?: TSchema } | undefined)?.outputSchema;
		assert.ok(schema);
		structuredObservation(schema, observed);
		assert.equal(observed.kind, "ordinary-primary");
		assert.equal(observed.view, view);
		assert.equal(observed.sessionId, ordinaryId);
		assert.equal(observed.source.ancestry, "latest-retained-ancestry");
		assert.equal(observed.unknown.idle, "unknown");
		assert.equal(observed.unknown.selectedLeaf, "unknown");
		assert.ok(observed.entries.some((entry) => entry.text?.includes("Check the parser boundary")));
		assert.ok(observed.entries.some((entry) => entry.id === "22222222" && entry.isError && entry.text?.includes("Parser test failed")));
	}
	const unsupported = await invoke("agent_inspect", { sessionId: ordinaryId, view: "exact", entryId: 1 });
	assert.equal(unsupported.isError, true);
	assert.match(JSON.stringify(unsupported.content), /supports activity and history only/u);
	assert.deepEqual(opened, [record.storageId]);
	assert.equal(existsSync(catalog.path(ordinaryId)), false);
	assert.equal(existsSync(join(catalog.root, `${ordinaryId}.sqlite`)), false);
	assert.equal(catalog.read(record.storageId).recoveryDue, recoveryBefore);
	assert.equal((await peer.harness.inspect(context)).submissions.length, 0);
	assert.equal(readFileSync(sessionFile, "utf8"), retained);
	assert.equal(delivered.length, 0);
	assert.equal(trustCalls, 0);
	assert.equal(stream.mock.callCount(), 0);
	assert.equal(streamSimple.mock.callCount(), 0);

	const frame = { title: "Parser review", purpose: "Check the parser boundary", authority: "Review the requested parser behavior", source: "Parser task", restrictions: "No external changes", acceptance: "Retained peer evidence identifies the parser error" };
	const invalidIdentities: { field: string; fields: JsonObject }[] = [
		{ field: "sessionId", fields: { sessionId: "not-an-identity" } },
		{ field: "integrator", fields: { integrator: "not-an-identity" } },
		{ field: "notify[1]", fields: { notify: [ordinaryId, "not-an-identity"] } },
	];
	for (const { field, fields } of invalidIdentities) await t.test(`native collaboration identifies invalid ${field}`, async () => {
		const result = await invoke("agent_collaborate", { action: "create", sessionId: record.storageId, ...frame, ...fields });
		assert.equal(result.isError, true);
		const text = JSON.stringify(result.content);
		assert.ok(text.includes(`${field} requires an exact discovered identity`), text);
		assert.match(text, /canonical lowercase UUID for a bare root/u);
		assert.match(text, /UUID:positive nonroot conversation ID/u);
		assert.equal((await peer.harness.inspect(context)).submissions.length, 0);
		assert.equal((await peer.harness.snapshot(AgentDeliveryDoc, context))?.reports.length ?? 0, 0);
		assert.equal(delivered.length, 0);
	});
	const invalidHandles: { field: string; fields: JsonObject }[] = [
		{ field: "sessionId", fields: { sessionId: "@missing-agent" } },
		{ field: "integrator", fields: { integrator: "@missing-agent" } },
		{ field: "notify[1]", fields: { notify: [ordinaryId, "@missing-agent"] } },
	];
	for (const { field, fields } of invalidHandles) await t.test(`native collaboration identifies an unavailable handle in ${field}`, async () => {
		const result = await invoke("agent_collaborate", { action: "create", sessionId: record.storageId, ...frame, ...fields });
		assert.equal(result.isError, true);
		const text = JSON.stringify(result.content);
		assert.ok(text.includes(`${field}: handle resolution failed`), text);
		assert.equal((await peer.harness.inspect(context)).submissions.length, 0);
		assert.equal((await peer.harness.snapshot(AgentDeliveryDoc, context))?.reports.length ?? 0, 0);
		assert.equal(delivered.length, 0);
	});
	await t.test("native collaboration identifies a required source", async () => {
		const { source: _source, ...withoutSource } = frame;
		const result = await invoke("agent_collaborate", { action: "create", sessionId: record.storageId, ...withoutSource });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /source is required and must be nonblank text/u);
	});
	assert.equal(delivered.length, 0);
	assert.equal(trustCalls, 0);

	await t.test("default native send remains separate from ordinary observation", async () => {
		const sent = await invoke("agent_send", { sessionId: ordinaryId, message: "Separate delivery after observation", checkInMinutes: 0 });
		assert.equal(sent.isError, false, JSON.stringify(sent));
		const receipt = (sent.details as { structuredContent: Record<string, unknown> }).structuredContent;
		assert.equal(receipt.sessionId, ordinaryId);
		assert.equal(receipt.admitted, true);
		assert.equal(typeof receipt.sourceId, "string");
		assert.equal("result" in receipt, false);
		assert.equal("submissionId" in receipt, false);
		await awaitWithContext(delivery, context);
		assert.equal(delivered.length, 1);
		assert.match(delivered[0].text, /Separate delivery after observation/u);
		assert.equal(trustCalls, 0);
		assert.equal(readFileSync(sessionFile, "utf8"), retained);
		assert.deepEqual(opened, [record.storageId]);
		assert.equal(stream.mock.callCount(), 0);
		assert.equal(streamSimple.mock.callCount(), 0);
	});
});
