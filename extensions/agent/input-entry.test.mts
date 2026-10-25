import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { inputEntry, isInputKind } from "./input-entry.ts";
import { richSubmitConversation, readOutcome, recordDeliveryIntent, reconcileDeliveries, submitConversation } from "./durable-controls.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { entrySource } from "./durable-observation.ts";
import { committedChoices } from "./action-dialogs.ts";

it("keeps operator admission native and records agent or unknown authors explicitly", () => {
	assert.equal(inputEntry("operator", "operator"), undefined);
	assert.deepEqual(inputEntry("model", "caller"), { kind: "agent.input", data: { author: { role: "agent", identity: "caller" } } });
	assert.deepEqual(inputEntry(undefined), { kind: "agent.input", data: { author: { role: "unknown" } } });
	assert.equal(isInputKind("pi.user"), true);
	assert.equal(isInputKind("agent.input"), true);
	assert.equal(isInputKind("agent.thread-notice"), false);
	assert.equal(entrySource("agent.input"), "user");
});

it("places model and operator requests under distinct kinds without changing model content", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	const content = [{ type: "text" as const, text: "Unchanged input" }, { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
	for (const origin of ["model", "operator"] as const) {
		const admitted = await richSubmitConversation(conversation, { message: content, requestId: origin, requester: "caller", origin }, context);
		const outcome = await readOutcome(harness, admitted.submissionId, context);
		assert.ok(outcome.entryId);
		const entry = (await conversation.entries({ minEntryId: outcome.entryId, maxEntryId: outcome.entryId }, 1, undefined, context)).items[0];
		assert.equal(entry?.kind, origin === "operator" ? "pi.user" : "agent.input");
		assert.deepEqual(entry?.model?.[0]?.content, content);
		assert.deepEqual(entry?.data, origin === "operator" ? undefined : { author: { role: "agent", identity: "caller" } });
		const repeated = await richSubmitConversation(conversation, { message: content, requestId: origin, requester: "caller", origin }, context);
		assert.equal(repeated.submissionId, admitted.submissionId);
	}
	const unknown = await submitConversation(conversation, { requestId: "unowned", message: "Unowned input" }, context);
	const outcome = await readOutcome(harness, unknown.submissionId, context);
	const entry = (await conversation.entries({ minEntryId: outcome.entryId, maxEntryId: outcome.entryId }, 1, undefined, context)).items[0];
	assert.deepEqual(entry?.data, { author: { role: "unknown" } });
	assert.equal(entry?.kind, "agent.input");
});

it("recovers delivery intents with their original input origin and author", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	for (const origin of ["model", "operator"] as const) {
		const request = { requestId: `recovered-${origin}`, requester: "caller", replyTo: "recipient", origin };
		await harness.commit((tx) => recordDeliveryIntent(tx, conversation.id, { requestId: request.requestId, ownerId: request.replyTo, message: "Recovered input", origin, requestContext: request }, 1), context);
		await reconcileDeliveries(harness, context);
		const submission = await harness.commit((tx) => tx.submissionByRequest(conversation.id, request.requestId), context);
		assert.ok(submission);
		const outcome = await readOutcome(harness, submission.id, context);
		const entry = (await conversation.entries({ minEntryId: outcome.entryId, maxEntryId: outcome.entryId }, 1, undefined, context)).items[0];
		assert.equal(entry?.kind, origin === "operator" ? "pi.user" : "agent.input");
		if (origin === "model") assert.deepEqual(entry?.data, { author: { role: "agent", identity: "caller" } });
	}
});

it("offers Agent input as a committed fork choice without calling it the operator", () => {
	const choices = committedChoices([{ id: "7", kind: "agent.input", model: [{ role: "user", content: "Task", timestamp: 1 }] }]);
	assert.deepEqual(choices, [{ id: "7", label: "Agent input: Task · 7" }]);
});
