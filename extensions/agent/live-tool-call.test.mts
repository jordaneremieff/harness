import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type ToolCall, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import * as Durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createAgentContribution, type AgentControlDispatch } from "./durable-agents.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, completed, fixtureRegistry, fixtureStorageId, hostOptions, toolCallMessage } from "./durable-host-fixture.mts";
import { deferred } from "./dashboard-test-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { LiveObservationService } from "./live-observation.ts";
import { AssistantMessageSchema, ConversationStatusSchema, InspectOutputSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";
import { buildStatusOverview } from "./status-overview.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";

it("observes a provider's live tool call through native status, frames, and compact views without parsing buffers", { timeout: 10000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "live-tool-call-"));
	const ambientDir = mkdtempSync(join(tmpdir(), "live-ambient-preferences-"));
	const previous = { directory: process.env.PI_AGENT_DIR, file: process.env.PI_AGENT_PREFERENCES_FILE };
	const ambientMarker = "AMBIENT-LIVE-PREFERENCES-MARKER";
	t.after(() => {
		if (previous.directory === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous.directory;
		if (previous.file === undefined) delete process.env.PI_AGENT_PREFERENCES_FILE;
		else process.env.PI_AGENT_PREFERENCES_FILE = previous.file;
		rmSync(ambientDir, { recursive: true, force: true });
	});
	writeFileSync(join(ambientDir, "agent-preferences.json"), JSON.stringify({
		version: 1, presets: {}, preferences: { reportingNotes: ambientMarker },
	}));
	process.env.PI_AGENT_DIR = ambientDir;
	delete process.env.PI_AGENT_PREFERENCES_FILE;
	const prompts: string[] = [];
	const release = deferred();
	const published = deferred();
	let host: DurableHost | undefined;
	let watch: Durable.WatchHandle<Durable.ConversationView> | undefined;
	let service: LiveObservationService | undefined;
	t.after(async () => { release.resolve(); await watch?.stop(); await service?.closeAll(); await host?.close(); rmSync(root, { recursive: true, force: true }); });
	const call: ToolCall = { type: "toolCall", id: "streamed-call", name: "probe", arguments: { path: "file", partialArgs: "declared argument data" }, thoughtSignature: "signature", namespace: "fixture" };
	const text = { type: "text" as const, text: "Prepare the action" };
	const scratch = { partialArgs: '{"path":"fi', partialJson: '{"path":', customInput: { property: "code", jsonBuffer: "{" }, streamIndex: 0, transientMarker: "private scratch" };
	const partial: AssistantMessage = { ...answerMessage(), stopReason: "pending", content: [text, { ...call, ...scratch }] };
	let observed: ToolResultMessage | undefined;
	let executions = 0;
	const models = await createTestRuntime();
	const streamSimple = (_model: unknown, input: TranscriptContext) => {
		prompts.push(getCurrentSystemPrompt(input.messages));
		const last = input.messages.at(-1);
		if (last?.role === "toolResult") {
			if (last.toolName === "agent_status") observed = last;
			return completed(answerMessage("Finished"));
		}
		const task = input.messages.findLast((message) => message.role === "user");
		if (task?.content === "Observe the storage") return completed(toolCallMessage("agent_status", {}));
		assert.equal(task?.content, "Stream a tool call");
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial });
		events.push({ type: "toolcall_start", contentIndex: 1, partial });
		events.push({ type: "toolcall_delta", contentIndex: 1, delta: scratch.partialArgs, partial });
		void release.promise.then(() => {
			const message: AssistantMessage = { ...partial, stopReason: "toolUse", content: [text, call] };
			events.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message });
			events.push({ type: "done", reason: "toolUse", message });
			events.end(message);
		});
		return events;
	};
	models.registerNativeProvider({ id: testModel.provider, name: "Live tool fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream: streamSimple, streamSimple });
	const registry = fixtureRegistry([Durable.defineTool({ name: "probe", description: "Read fixture arguments", parameters: Type.Object({ path: Type.String(), partialArgs: Type.String() }), execute: async () => { executions++; return { content: [{ type: "text", text: "Read" }] }; } })]);
	const dispatch: AgentControlDispatch = async (method, params) => {
		assert.ok(host);
		const value = await host.request(method, params, context);
		return method === "status" ? { ...value as Record<string, unknown>, inventory: { contributions: [], ordinaryOnly: [] }, pid: process.pid, storageId: fixtureStorageId } : value;
	};
	registry.install(createAgentContribution({ source: fileURLToPath(new URL("./index.ts", import.meta.url)), dispatch }).create({ durable: Durable, storageId: fixtureStorageId, cwd: root, agentDir: root, services: { modelRuntime: models } }));
	host = await DurableHost.open(hostOptions(join(root, "agent.sqlite"), models, registry, root), context);
	const worker = host.root();
	watch = await worker.watch(context);
	watch.start(async (value) => {
		const live = value.docs["pi.live"] as Durable.LiveState | undefined;
		const block = live?.generation?.message?.content[1];
		if (block?.type === "toolCall" && "partialArgs" in block) published.resolve();
	});
	const submission = await host.submit({ message: "Stream a tool call", requestId: "stream" });
	await published.promise;
	const observer = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: testModel.provider, modelId: testModel.id } } }, context);
	await (await observer.submit({ type: "input", content: "Observe the storage", requestId: "observe" }, context)).wait(context);
	assert.ok(observed, "the model issued native agent_status({}) through the real contribution and host dispatch");
	assert.equal(observed.isError, false, JSON.stringify(observed.content));
	const status = structuredObservation(StatusOutputSchema, (observed.details as { structuredContent: unknown }).structuredContent) as { conversations: { conversationId: number; live: Durable.LiveState }[] };
	const workerStatus = status.conversations.find((row) => row.conversationId === worker.id);
	assert.ok(workerStatus?.live.generation?.message);
	assert.deepEqual(workerStatus.live.generation.message.content[1], call);
	structuredObservation(StatusOutputSchema, await dispatch("status", { sessionId: fixtureStorageId }));

	service = new LiveObservationService(host.harness, { storageId: fixtureStorageId }, context);
	const frame = await service.open("stream", { scope: "conversation", conversationId: worker.id });
	assert.equal(frame.scope, "conversation");
	if (frame.scope !== "conversation") throw new Error("Expected a conversation frame");
	structuredObservation(ConversationStatusSchema, frame.status);
	const liveMessage = frame.live.flatMap((entry) => entry.model ?? []).find((message) => message.role === "assistant");
	assert.ok(liveMessage);
	structuredObservation(AssistantMessageSchema, liveMessage);
	assert.deepEqual(liveMessage.content[1], call);
	for (const view of ["history", "branch", "activity"] as const) {
		const inspection: unknown = structuredObservation(InspectOutputSchema, await host.request("inspect", { sessionId: fixtureStorageId, view }, context));
		assert.doesNotMatch(JSON.stringify(inspection), /private scratch|partialJson|streamIndex/u);
		if (view === "activity") {
			const metadata = (inspection as { metadata: { operation: number | null; streamedText: string } }).metadata;
			assert.notEqual(metadata.operation, null);
			assert.equal(metadata.streamedText, text.text);
		}
	}
	const snapshot = await host.request("snapshot", { sessionId: fixtureStorageId }, context);
	assert.doesNotMatch(JSON.stringify(snapshot), /private scratch|partialJson|streamIndex/u);
	const rows = await host.request("dashboard", {}, context) as AgentConversationSummary[];
	const overview = buildStatusOverview({ rows, observedAt: new Date().toISOString(), coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null } }, [], []);
	structuredObservation(StatusOutputSchema, overview);
	assert.equal(overview.sessions.length, rows.length);
	assert.doesNotMatch(JSON.stringify(overview), /private scratch|partialJson|streamIndex/u);
	const native = await host.harness.snapshot(Durable.LiveDoc, worker.id, context);
	assert.deepEqual(native?.generation?.message?.content[1], { ...call, ...scratch }, "all observation paths leave the provider's private state unchanged");
	release.resolve();
	assert.equal((await host.wait(submission.submissionId, context)).status, "done");
	assert.equal(executions, 1);
	assert.ok(prompts.length > 0);
	assert.equal(prompts.some((prompt) => prompt.includes(ambientMarker)), false,
		"native live-tool fixtures must not read ambient machine preferences");
});
