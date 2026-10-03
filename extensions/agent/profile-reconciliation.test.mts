import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentMetaDoc, AgentDeliveryDoc, readOutcome } from "./durable-controls.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { ProfileDoc } from "./profile.ts";
import { readRequestContexts, requestContextSection } from "./request-context.ts";
import { testModel } from "./test-runtime.mts";

it("reconciles retained children before resume and supplies routes for base-only callers", { timeout: 30000 }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "profile-reopen-"));
	const storagePath = join(directory, "agent.sqlite");
	const storageId = randomUUID();
	const model = { provider: testModel.provider, modelId: testModel.id };
	const runtime = await fixtureRuntime("answer");
	const original = await Harness.open(await openNodeSqliteStorage(storagePath), { models: runtime, registry: fixtureRegistry() }, context);
	let host: DurableHost | undefined;
	t.after(async () => { await host?.close(); rmSync(directory, { recursive: true, force: true }); });
	const root = await original.root(context, { agent: { model, instructions: "OLD ROOT INSTRUCTIONS" } });
	const ids = [root.id];
	for (let index = 0; index < 65; index++) {
		const child = await original.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions: "OLD CHILD INSTRUCTIONS" } }, context);
		ids.push(child.id);
	}
	const last = ids.at(-1);
	assert.ok(last !== undefined);
	await original.commit(async (tx) => {
		for (const id of ids) {
			const meta = await tx.doc(AgentMetaDoc, id);
			meta.name = `Retained ${id}`;
			meta.owner = "founder";
		}
		const delivery = await tx.doc(AgentDeliveryDoc);
		delivery.intents.push({ requestId: "retained-base", conversationId: last, ownerId: "old-requester", origin: "model", message: "Retained task", whenBusy: null, operationId: null, submissionId: null });
	}, context);
	await original.close(context);
	const observed: TranscriptContext[] = [];
	const models = new Proxy(runtime, { get(target, property) {
		const value = Reflect.get(target, property, target);
		if (property === "streamSimple") return (selected: unknown, input: TranscriptContext, options: unknown) => { observed.push(input); return value.call(target, selected, input, options); };
		return typeof value === "function" ? value.bind(target) : value;
	} });
	const registry = fixtureRegistry();
	registry.install({ name: "request-routes", sections: [requestContextSection(() => { assert.ok(host); return host.harness; })] });
	host = await DurableHost.open({ storagePath, storageId, models, registry, resume: false }, context);
	assert.equal(observed.length, 0);
	for (const id of ids) {
		const child = await host.harness.conversation(id, context);
		assert.ok(child);
		const instructions = (await child.agent(context)).instructions ?? "";
		assert.doesNotMatch(instructions, /OLD (ROOT|CHILD) INSTRUCTIONS/u);
		assert.ok(instructions.includes(`Retained ${id}`));
		assert.match(instructions, /mode: report/u);
		assert.equal((await host.harness.snapshot(ProfileDoc, id, context))?.handle, null, "reconciliation does not adopt a handle");
	}
	assert.deepEqual(await readRequestContexts(host.harness, last, context), [{ requestId: "retained-base", requester: "old-requester", replyTo: "old-requester", origin: "model", status: "admitting" }]);
	for (const [id, owner] of [[root.id, "old-primary"], [last, "old-child-caller"]] as const) {
		const conversation = await host.harness.conversation(id, context);
		assert.ok(conversation);
		await conversation.configure({ instructions: "STALE ADMISSION INSTRUCTIONS" }, context);
		const admitted = await host.request("submit", { sessionId: id === root.id ? storageId : `${storageId}:${id}`, message: `Task for ${owner}`, requestId: `base-${id}`, ownerId: owner, origin: "operator" }, context) as { submissionId: SubmissionId };
		assert.deepEqual(Object.keys(admitted).sort(), ["conversationId", "deduped", "identity", "submissionId"]);
		await readOutcome(host.harness, admitted.submissionId, context);
		const input = observed.at(-1);
		assert.ok(input);
		const prompt = getCurrentSystemPrompt(input.messages);
		assert.doesNotMatch(prompt, /STALE ADMISSION INSTRUCTIONS/u);
		assert.ok(prompt.includes(`"requester":"${owner}"`));
		assert.ok(prompt.includes(`"replyTo":"${owner}"`));
		assert.ok(input.messages.some((message) => message.role === "user" && message.content === `Task for ${owner}`));
	}
});
