import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Models } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureProvider, fixtureRegistry, fixtureStorageId, hostOptions, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { LiveObservationService } from "./live-observation.ts";
import type { ConversationFrame, TaskGraphRow, TasksFrame } from "./live-frames.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const ROOT = 1 as ConversationId;

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "live-observation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Poll an async condition without a fixed sleep. */
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() >= deadline) throw new Error(`${label} was not reached before its deadline`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function serviceFor(host: DurableHost): LiveObservationService {
	return new LiveObservationService(host.harness, { storageId: fixtureStorageId }, BACKGROUND_CONTEXT);
}

/** One runtime that streams the supplied synthetic events under the fixture model identity. */
async function streamingRuntime(makeStream: () => AssistantMessageEventStream): Promise<Models> {
	const runtime = await createTestRuntime();
	const stream = (): AssistantMessageEventStream => makeStream();
	runtime.registerNativeProvider({
		id: fixtureProvider,
		name: "live observation stream",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	return runtime;
}

it("advances the conversation frame after a commit and serves committed entries", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "conversation.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host);
	const token = "watch-conversation";
	const first = (await service.open(token, { scope: "conversation", conversationId: ROOT })) as ConversationFrame;
	assert.equal(first.scope, "conversation");
	assert.equal(first.conversationId, 1);
	assert.equal(first.revision, 1, "a fresh observation starts at its first revision");
	assert.equal(first.live.length, 0, "nothing is in flight yet");
	assert.equal(service.watches, 1);

	const submitted = await host.submit({ message: "first prompt", requestId: "live-1" });
	assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	await until(async () => ((await service.frame(token)) as ConversationFrame).revision > first.revision, 8000, "frame revision advance");
	const frame = (await service.frame(token)) as ConversationFrame;
	assert.ok(frame.entries.some((entry) => entry.kind === "pi.user"), "the committed user entry is served");
	assert.ok(frame.entries.some((entry) => entry.kind === "pi.assistant"), "the committed answer is served");
	assert.equal(frame.status.lastTextRole, "assistant", "the retained tail carries its author role");
	assert.equal(frame.coverage.complete, true, "a short transcript is complete");
	await service.closeAll();
	assert.equal(service.watches, 0);
});

it("serves the uncommitted tail and drops it after the committed entry arrives", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "tail.sqlite");
	const release = defer();
	const stream = (): AssistantMessageEventStream => {
		const events = createAssistantMessageEventStream();
		const base = answerMessage("");
		const partial = { ...base, stopReason: "pending" as const, content: [{ type: "text" as const, text: "streaming answer" }] };
		events.push({ type: "start", partial });
		events.push({ type: "text_delta", contentIndex: 0, delta: "streaming answer", partial });
		// The stream stays open until the test releases it, so the committed
		// partial is observable as the live tail.
		release.promise.then(() => {
			const message = { ...base, content: [{ type: "text" as const, text: "streaming answer" }] };
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		});
		return events;
	};
	const host = await DurableHost.open(hostOptions(storagePath, await streamingRuntime(stream), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host);
	const token = "watch-tail";
	await service.open(token, { scope: "conversation", conversationId: ROOT });
	await host.submit({ message: "stream please", requestId: "tail-1" });
	await until(
		async () => ((await service.frame(token)) as ConversationFrame).live.some((entry) => entry.kind === "pi.assistant"),
		8000,
		"in-flight assistant tail",
	);
	const liveFrame = (await service.frame(token)) as ConversationFrame;
	const liveAssistant = liveFrame.live.find((entry) => entry.kind === "pi.assistant");
	assert.ok(liveAssistant !== undefined);
	const text = (liveAssistant.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content.filter((part) => part.type === "text").map((part) => part.text) : []))
		.join("");
	assert.match(text, /streaming answer/u);
	assert.ok(liveFrame.coverage.complete, "the committed page stays complete while the tail streams");
	// Release and settle; the committed entry replaces the tail.
	release.resolve();
	await until(async () => {
		const frame = (await service.frame(token)) as ConversationFrame;
		return frame.live.length === 0 && frame.entries.some((entry) => entry.kind === "pi.assistant");
	}, 8000, "committed answer");
	await service.closeAll();
});

it("stops the conversation watch when its last token closes", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "cancel.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("one"), answerMessage("two")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host);
	const scope = { scope: "conversation", conversationId: ROOT } as const;
	await service.open("first", scope);
	await service.open("second", scope);
	assert.equal(service.watches, 1, "both tokens share one watch");
	assert.equal(service.size, 2);
	assert.equal(await service.close("first"), true);
	assert.equal(service.watches, 1, "closing one token keeps the shared watch");
	assert.equal(await service.close("second"), true);
	assert.equal(service.watches, 0, "the last close stops the watch");
	assert.equal(await service.frame("second"), undefined);
	assert.equal(await service.close("second"), false);
});

it("projects the live task graph with owner edges and conversation labels", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "tasks.sqlite");
	const started = defer();
	const release = defer();
	const streamer = defineTool({
		name: "streamer",
		description: "Publish running output, then wait for the test.",
		parameters: Type.Object({}),
		execute: async (_args, api) => {
			api.output("running line\n");
			started.resolve();
			await release.promise;
			return {};
		},
	});
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([toolCallMessage("streamer"), answerMessage("finished")]), fixtureRegistry([streamer])), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host);
	const token = "watch-tasks";
	const baseline = (await service.open(token, { scope: "tasks" })) as TasksFrame;
	assert.equal(baseline.scope, "tasks");
	assert.equal(baseline.tasks.length, 0, "a fresh storage has no live tasks");
	assert.equal(baseline.coverage.live, true);

	const submitted = await host.submit({ message: "run the streamer", requestId: "tasks-1" });
	await started.promise;
	await until(async () => ((await service.frame(token)) as TasksFrame).tasks.some((row: TaskGraphRow) => row.kind === "pi.tool"), 8000, "live tool task");
	const frame = (await service.frame(token)) as TasksFrame;
	const toolRow = frame.tasks.find((row) => row.kind === "pi.tool");
	assert.ok(toolRow !== undefined);
	assert.equal(toolRow.conversationId, 1);
	assert.equal(toolRow.background, false);
	assert.equal(toolRow.abortRequested, false);
	assert.ok(frame.labels.some((label) => label.conversationId === 1 && label.identity === fixtureStorageId), "the root conversation is named");
	release.resolve();
	assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	await until(async () => ((await service.frame(token)) as TasksFrame).tasks.length === 0, 8000, "empty graph after completion");
	await service.closeAll();
});

it("open is idempotent for one token and rejects an unknown conversation", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "open.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage()]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host);
	const scope = { scope: "conversation", conversationId: ROOT } as const;
	const first = await service.open("same", scope);
	const second = await service.open("same", scope);
	assert.equal(first.revision, second.revision);
	assert.equal(service.watches, 1);
	await assert.rejects(service.open("missing", { scope: "conversation", conversationId: 999 as ConversationId }), /does not exist/u);
	await service.closeAll();
});

it("keeps the task watch alive across tokens and stops it with the last close", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "task-cancel.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage()]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host);
	await service.open("a", { scope: "tasks" });
	await service.open("b", { scope: "tasks" });
	assert.equal(service.watches, 1);
	await service.close("a");
	assert.equal(service.watches, 1);
	await service.close("b");
	assert.equal(service.watches, 0);
});
