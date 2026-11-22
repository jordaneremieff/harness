import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ProviderDoc, type ConversationId } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { DurableHost } from "./durable-host.ts";
import {
	deferred,
	answerMessage,
	fixtureModelId,
	fixtureProvider,
	fixtureRegistry,
	hostOptions,
	scriptedRuntime,
} from "./durable-host-fixture.mts";
import { ProviderModels } from "./provider-models.ts";
import { readProviderBlock } from "./provider-block.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "provider-models-"));
	const models = await scriptedRuntime([answerMessage()]);
	const host = await DurableHost.open({
		...hostOptions(join(root, "storage.sqlite"), models, fixtureRegistry()),
		resume: false,
	});
	t.after(async () => {
		await host.close();
		await rm(root, { recursive: true, force: true });
	});
	const adapter = new ProviderModels(models, () => host.harness, host.storageId);
	adapter.bind();
	t.after(async () => adapter.close());
	const model = adapter.models.getModel(fixtureProvider, fixtureModelId);
	assert.ok(model);
	const provider = await host.harness.snapshot(ProviderDoc, 1 as ConversationId, BACKGROUND_CONTEXT);
	assert.ok(provider);
	return { host, models, adapter, model, sessionId: provider.sessionId };
}

/** A provider stream the test drives by hand; it ignores every abort signal, as a stalled authentication step does. */
function heldStream() {
	const stream = createAssistantMessageEventStream();
	return { stream, partial: answerMessage("partial") };
}

it("ends a request at its caller's abort even when the provider ignores the signal, and drops later output", async (t) => {
	const { models, adapter, model, sessionId } = await fixture(t);
	const held = heldStream();
	models.streamSimple = () => held.stream;
	const controller = new AbortController();
	const output = adapter.models.streamSimple(model, { messages: [] }, { sessionId, signal: controller.signal });
	const events: string[] = [];
	const read = (async () => {
		for await (const event of output) events.push(event.type);
	})();
	held.stream.push({ type: "start", partial: { ...held.partial, content: [] } });
	held.stream.push({ type: "text_start", contentIndex: 0, partial: held.partial });
	for (let step = 0; step < 20 && events.length < 2; step++) await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	const result = await output.result();
	await read;
	assert.equal(result.stopReason, "aborted");
	assert.deepEqual(result.content, held.partial.content, "the aborted result keeps the partial content");
	assert.deepEqual(events, ["start", "text_start", "error"]);
	held.stream.push({ type: "done", reason: "stop", message: answerMessage("late") });
	held.stream.end();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await output.result()).stopReason, "aborted", "a late provider answer changes nothing");
});

it("fails a request whose provider sends no event before timeoutMs with a retryable timeout", async (t) => {
	const { host, models, adapter, model, sessionId } = await fixture(t);
	const held = heldStream();
	models.streamSimple = () => held.stream;
	const started = performance.now();
	const result = await adapter.models.streamSimple(model, { messages: [] }, { sessionId, timeoutMs: 50 }).result();
	assert.ok(performance.now() - started < 5000);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /timed out after 50 ms/u);
	assert.equal(isRetryableAssistantError(result), true, "the retry policy runs the request again");
	const exhausted = { ...answerMessage(), stopReason: "error" as const, errorMessage: "usage limit reached" };
	held.stream.push({ type: "error", reason: "error", error: exhausted });
	held.stream.end();
	for (let step = 0; step < 20; step++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		await host.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT),
		undefined,
		"a provider answer after the deadline records no provider block",
	);
});

it("keeps a request whose first event arrives before timeoutMs, however long the rest takes", async (t) => {
	const { models, adapter, model, sessionId } = await fixture(t);
	const held = heldStream();
	models.streamSimple = () => {
		queueMicrotask(() => held.stream.push({ type: "start", partial: { ...held.partial, content: [] } }));
		setTimeout(() => {
			const message = answerMessage("complete");
			held.stream.push({ type: "done", reason: "stop", message });
			held.stream.end();
		}, 120);
		return held.stream;
	};
	const result = await adapter.models.streamSimple(model, { messages: [] }, { sessionId, timeoutMs: 40 }).result();
	assert.equal(result.stopReason, "stop");
});

it("makes no provider request after an abort that came before dispatch", async (t) => {
	const { models, adapter, model, sessionId } = await fixture(t);
	let calls = 0;
	models.streamSimple = () => {
		calls++;
		return heldStream().stream;
	};
	const controller = new AbortController();
	controller.abort();
	const result = await adapter.models.completeSimple(model, { messages: [] }, { sessionId, signal: controller.signal });
	assert.equal(result.stopReason, "aborted");
	assert.equal(calls, 0);
});

it("keeps a terminal-only provider answer when its commit outlasts the first-event deadline", async (t) => {
	const { host, models, adapter, model, sessionId } = await fixture(t);
	const held = heldStream();
	const answer = answerMessage("answer before deadline");
	const committing = deferred();
	const resume = deferred();
	const commit = host.harness.commit.bind(host.harness) as typeof host.harness.commit;
	let dispatched = false;
	models.streamSimple = () => {
		dispatched = true;
		held.stream.push({ type: "done", reason: "stop", message: answer });
		held.stream.end();
		return held.stream;
	};
	t.mock.method(
		host.harness,
		"commit",
		async (change: Parameters<typeof commit>[0], context: Parameters<typeof commit>[1]) => {
			if (dispatched) {
				committing.resolve();
				await resume.promise;
			}
			return commit(change, context);
		},
	);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const result = adapter.models.streamSimple(model, { messages: [] }, { sessionId, timeoutMs: 100 }).result();
	await committing.promise;
	t.mock.timers.tick(101);
	resume.resolve();
	assert.deepEqual(await result, answer);
});
