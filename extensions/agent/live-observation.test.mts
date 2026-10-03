import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Models } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId, type WatchHandle } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureProvider, fixtureRegistry, fixtureStorageId, hostOptions, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import { LiveObservationService } from "./live-observation.ts";
import type { ConversationFrame, ObservationFrame, TasksFrame } from "./live-frames.ts";
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

/** Observe the service's own watch after its callback updates the frame revision. */
function serviceFor(host: DurableHost, t: TestContext) {
	const listeners = new Set<() => Promise<void>>();
	const tap = <T,>(handle: WatchHandle<T>): WatchHandle<T> => ({
		get value() { return handle.value; },
		closed: handle.closed,
		stop: () => handle.stop(),
		start: (listener) => handle.start(async (...args) => {
			await listener(...args);
			for (const check of [...listeners]) await check();
		}),
	});
	const conversation = host.harness.conversation.bind(host.harness);
	t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof conversation>) => {
		const value = await conversation(...args);
		if (value) {
			const watch = value.watch.bind(value);
			t.mock.method(value, "watch", async (...watchArgs: Parameters<typeof watch>) => tap(await watch(...watchArgs)));
		}
		return value;
	});
	const tasks = host.harness.watchTaskGraph.bind(host.harness);
	t.mock.method(host.harness, "watchTaskGraph", async (...args: Parameters<typeof tasks>) => tap(await tasks(...args)));
	const service = new LiveObservationService(host.harness, { storageId: fixtureStorageId }, BACKGROUND_CONTEXT);
	return Object.assign(service, {
		/** Read once now, then once per publication; the timer only rejects a missing event. */
		waitForFrame(token: string, accept: (frame: ObservationFrame) => boolean, label: string): Promise<ObservationFrame> {
			return new Promise((resolve, reject) => {
				let settled = false;
				let checking = Promise.resolve();
				const finish = (frame?: ObservationFrame, error?: Error): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					listeners.delete(check);
					if (frame) resolve(frame);
					else reject(error);
				};
				const check = (): Promise<void> => {
					checking = checking.then(async () => {
						if (settled) return;
						const frame = await service.frame(token);
						if (!frame) throw new Error(`observation token ${token} has no frame`);
						if (accept(frame)) finish(frame);
					}).catch((error: unknown) => finish(undefined, error instanceof Error ? error : new Error(String(error))));
					return checking;
				};
				const timer = setTimeout(() => finish(undefined, new Error(`${label} was not reached before its deadline`)), 8000);
				listeners.add(check);
				void check();
			});
		},
	});
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

for (const scope of ["conversation", "tasks"] as const) for (const sameToken of [false, true]) it(`shares concurrent ${scope} opens with same token=${sameToken}`, { timeout: 15000 }, async (t) => {
	const host = await DurableHost.open(hostOptions(join(fixtureRoot(t), "concurrent.sqlite"), await scriptedRuntime([]), fixtureRegistry()));
	t.after(() => host.close());
	let created = 0;
	let stopped = 0;
	const wrap = <T,>(handle: WatchHandle<T>): WatchHandle<T> => {
		created++;
		return { get value() { return handle.value; }, closed: handle.closed, start: (listener) => handle.start(listener), stop: async () => { stopped++; return handle.stop(); } };
	};
	const conversation = host.harness.conversation.bind(host.harness);
	t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof conversation>) => {
		const value = await conversation(...args);
		if (value) { const watch = value.watch.bind(value); t.mock.method(value, "watch", async (...watchArgs: Parameters<typeof watch>) => wrap(await watch(...watchArgs))); }
		return value;
	});
	const tasks = host.harness.watchTaskGraph.bind(host.harness);
	t.mock.method(host.harness, "watchTaskGraph", async (...args: Parameters<typeof tasks>) => wrap(await tasks(...args)));
	const service = new LiveObservationService(host.harness, { storageId: fixtureStorageId }, BACKGROUND_CONTEXT);
	const selected = scope === "conversation" ? { scope, conversationId: ROOT } : { scope };
	await Promise.all([service.open("first", selected), service.open(sameToken ? "first" : "second", selected)]);
	assert.equal(created, 1, "the native watch has one owner across concurrent opens");
	assert.equal(service.size, sameToken ? 1 : 2);
	await service.close("first");
	if (!sameToken) {
		assert.ok(await service.frame("second"), "the other token keeps its own reference");
		assert.equal(stopped, 0);
		await service.close("second");
	}
	assert.equal(stopped, 1);
	assert.equal(service.watches, 0);
});

it("preserves a new task token when its open overlaps the last token close", { timeout: 15000 }, async (t) => {
	const host = await DurableHost.open(hostOptions(join(fixtureRoot(t), "open-close.sqlite"), await scriptedRuntime([]), fixtureRegistry()));
	t.after(() => host.close());
	const service = new LiveObservationService(host.harness, { storageId: fixtureStorageId }, BACKGROUND_CONTEXT);
	await service.open("old", { scope: "tasks" });
	await Promise.all([service.open("new", { scope: "tasks" }), service.close("old")]);
	assert.ok(await service.frame("new"));
	assert.equal(service.size, 1);
	assert.equal(service.watches, 1);
	await service.close("new");
	assert.equal(service.watches, 0);
});

for (const scope of ["conversation", "tasks"] as const) it(`releases a ${scope} watch whose first frame fails`, { timeout: 15000 }, async (t) => {
	const host = await DurableHost.open(hostOptions(join(fixtureRoot(t), "failed-frame.sqlite"), await scriptedRuntime([]), fixtureRegistry()));
	t.after(() => host.close());
	let fail = true;
	let stopped = 0;
	const wrap = <T,>(handle: WatchHandle<T>): WatchHandle<T> => ({
		get value() { if (fail) { fail = false; throw new Error("initial frame unavailable"); } return handle.value; },
		closed: handle.closed, start: (listener) => handle.start(listener), stop: async () => { stopped++; return handle.stop(); },
	});
	const conversation = host.harness.conversation.bind(host.harness);
	t.mock.method(host.harness, "conversation", async (...args: Parameters<typeof conversation>) => {
		const value = await conversation(...args);
		if (value) { const watch = value.watch.bind(value); t.mock.method(value, "watch", async (...watchArgs: Parameters<typeof watch>) => wrap(await watch(...watchArgs))); }
		return value;
	});
	const tasks = host.harness.watchTaskGraph.bind(host.harness);
	t.mock.method(host.harness, "watchTaskGraph", async (...args: Parameters<typeof tasks>) => wrap(await tasks(...args)));
	const service = new LiveObservationService(host.harness, { storageId: fixtureStorageId }, BACKGROUND_CONTEXT);
	const selected = scope === "conversation" ? { scope, conversationId: ROOT } : { scope };
	await assert.rejects(service.open("failed", selected), /initial frame unavailable/u);
	assert.equal(service.size, 0);
	assert.equal(service.watches, 0);
	assert.equal(stopped, 1);
	await service.open("failed", selected);
	await service.close("failed");
	assert.equal(stopped, 2);
});

it("rolls back a failed second open without releasing the surviving task token", { timeout: 15000 }, async (t) => {
	const host = await DurableHost.open(hostOptions(join(fixtureRoot(t), "failed-second.sqlite"), await scriptedRuntime([]), fixtureRegistry()));
	t.after(() => host.close());
	let fail = false;
	let stopped = 0;
	let publish = async (): Promise<void> => {};
	const watch = host.harness.watchTaskGraph.bind(host.harness);
	t.mock.method(host.harness, "watchTaskGraph", async (...args: Parameters<typeof watch>) => {
		const handle = await watch(...args);
		return { get value() { if (fail) { fail = false; throw new Error("second frame unavailable"); } return handle.value; }, closed: handle.closed,
			start: (listener: Parameters<typeof handle.start>[0]) => { publish = () => listener(handle.value, [], BACKGROUND_CONTEXT); handle.start(listener); },
			stop: async () => { stopped++; return handle.stop(); } };
	});
	const service = new LiveObservationService(host.harness, { storageId: fixtureStorageId }, BACKGROUND_CONTEXT);
	await service.open("survivor", { scope: "tasks" });
	await publish();
	fail = true;
	await assert.rejects(service.open("failed", { scope: "tasks" }), /second frame unavailable/u);
	assert.equal(service.size, 1);
	assert.equal(stopped, 0);
	assert.ok(await service.frame("survivor"));
	await service.close("survivor");
	assert.equal(service.watches, 0);
	assert.equal(stopped, 1);
});

it("advances the conversation frame after a commit and serves committed entries", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "conversation.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("first answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host, t);
	const token = "watch-conversation";
	const first = (await service.open(token, { scope: "conversation", conversationId: ROOT })) as ConversationFrame;
	assert.equal(first.scope, "conversation");
	assert.equal(first.conversationId, 1);
	assert.equal(first.revision, 1, "a fresh observation starts at its first revision");
	assert.equal(first.live.length, 0, "nothing is in flight yet");
	assert.equal(service.watches, 1);

	const submitted = await host.submit({ message: "first prompt", requestId: "live-1" });
	assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	const frame = await service.waitForFrame(token, (value) => value.scope === "conversation" && value.revision > first.revision
		&& value.entries.some((entry) => entry.kind === "pi.user") && value.entries.some((entry) => entry.kind === "pi.assistant"), "committed frame revision") as ConversationFrame;
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
	const publish = defer();
	const started = defer();
	t.after(() => { publish.resolve(); release.resolve(); });
	const stream = (): AssistantMessageEventStream => {
		started.resolve();
		const events = createAssistantMessageEventStream();
		const base = answerMessage("");
		const partial = { ...base, stopReason: "pending" as const, content: [{ type: "text" as const, text: "streaming answer" }] };
		void publish.promise.then(() => {
			events.push({ type: "start", partial });
			events.push({ type: "text_delta", contentIndex: 0, delta: "streaming answer", partial });
		});
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
	const service = serviceFor(host, t);
	const token = "watch-tail";
	await service.open(token, { scope: "conversation", conversationId: ROOT });
	await host.submit({ message: "stream please", requestId: "tail-1" });
	let tailObserved = false;
	const tail = service.waitForFrame(token, (value) => value.scope === "conversation" && value.live.some((entry) => entry.kind === "pi.assistant"), "in-flight assistant tail")
		.then((frame) => { tailObserved = true; return frame as ConversationFrame; });
	await started.promise;
	assert.equal(tailObserved, false, "the provider holds its first event");
	publish.resolve();
	const liveFrame = await tail;
	const liveAssistant = liveFrame.live.find((entry) => entry.kind === "pi.assistant");
	assert.ok(liveAssistant !== undefined);
	const text = (liveAssistant.model ?? [])
		.flatMap((message) => (message.role === "assistant" ? message.content.filter((part) => part.type === "text").map((part) => part.text) : []))
		.join("");
	assert.match(text, /streaming answer/u);
	assert.ok(liveFrame.coverage.complete, "the committed page stays complete while the tail streams");
	let answerObserved = false;
	const committed = service.waitForFrame(token, (value) => value.scope === "conversation" && value.live.length === 0
		&& value.entries.some((entry) => entry.kind === "pi.assistant"), "committed answer").then(() => { answerObserved = true; });
	assert.equal(answerObserved, false, "the provider still holds completion");
	release.resolve();
	await committed;
	assert.equal(answerObserved, true);
	await service.closeAll();
});

it("stops the conversation watch when its last token closes", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "cancel.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage("one"), answerMessage("two")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host, t);
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
	t.after(() => release.resolve());
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
	const service = serviceFor(host, t);
	const token = "watch-tasks";
	const baseline = (await service.open(token, { scope: "tasks" })) as TasksFrame;
	assert.equal(baseline.scope, "tasks");
	assert.equal(baseline.tasks.length, 0, "a fresh storage has no live tasks");
	assert.equal(baseline.coverage.live, true);

	const submitted = await host.submit({ message: "run the streamer", requestId: "tasks-1" });
	await started.promise;
	const frame = await service.waitForFrame(token, (value) => value.scope === "tasks" && value.tasks.some((row) => row.kind === "pi.tool"), "live tool task") as TasksFrame;
	const toolRow = frame.tasks.find((row) => row.kind === "pi.tool");
	assert.ok(toolRow !== undefined);
	assert.equal(toolRow.conversationId, 1);
	assert.equal(toolRow.background, false);
	assert.equal(toolRow.abortRequested, false);
	assert.ok(frame.labels.some((label) => label.conversationId === 1 && label.identity === fixtureStorageId), "the root conversation is named");
	let emptyObserved = false;
	const empty = service.waitForFrame(token, (value) => value.scope === "tasks" && value.tasks.length === 0, "empty graph after completion")
		.then(() => { emptyObserved = true; });
	assert.equal(emptyObserved, false, "the tool holds its task completion");
	release.resolve();
	assert.equal((await host.wait(submitted.submissionId, BACKGROUND_CONTEXT)).status, "done");
	await empty;
	assert.equal(emptyObserved, true);
	await service.closeAll();
});

it("open is idempotent for one token and rejects an unknown conversation", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "open.sqlite");
	const host = await DurableHost.open(hostOptions(storagePath, await scriptedRuntime([answerMessage()]), fixtureRegistry()), BACKGROUND_CONTEXT);
	t.after(() => host.close());
	const service = serviceFor(host, t);
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
	const service = serviceFor(host, t);
	await service.open("a", { scope: "tasks" });
	await service.open("b", { scope: "tasks" });
	assert.equal(service.watches, 1);
	await service.close("a");
	assert.equal(service.watches, 1);
	await service.close("b");
	assert.equal(service.watches, 0);
});
