import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { createMemoryContribution } from "./durable.ts";
import { failSelectedReads, proactiveCorpus, recallText, writeRecall } from "./proactive-fixture.mts";
import { isolateMachineSettings } from "./settings-fixture.mts";

isolateMachineSettings();
function textOf(message: TranscriptContext["messages"][number]): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}
function notices(request: TranscriptContext): string[] {
	return request.messages.map(textOf).filter((text) => text.startsWith("Memory notice."));
}
async function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "memory-durable-boundaries-"));
	const corpus = proactiveCorpus(root);
	const previous = { PI_MEMORY_DIR: process.env.PI_MEMORY_DIR, PI_MEMORY_PROACTIVE: process.env.PI_MEMORY_PROACTIVE };
	process.env.PI_MEMORY_DIR = corpus;
	process.env.PI_MEMORY_PROACTIVE = "true";
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(
		new Durable.MemoryStorage(),
		{ models, registry, settings: { steeringMode: "all", followUpMode: "all" } },
		BACKGROUND_CONTEXT,
	);
	t.after(async () => {
		await harness.close(BACKGROUND_CONTEXT);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const contribution = createMemoryContribution("memory-fixture", { emit: () => {}, on: () => () => {} }, () => {});
	registry.install(
		await contribution.create({
			durable: Durable,
			services: {} as never,
			cwd: root,
			agentDir: root,
			storageId: "memory-boundary-fixture",
			harness,
			signal: new AbortController().signal,
			onClose: () => {},
			inventory: { contributions: [], ordinaryOnly: [] },
		}),
	);
	const agent = { model: { provider: "faux", modelId: "faux-1" } };
	const requests: TranscriptContext[] = [];
	const create = () => harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
	const drive = async (conversation: Durable.Conversation, content: string) => {
		faux.setResponses([
			(request) => {
				requests.push(structuredClone(request));
				return fauxAssistantMessage("done");
			},
		]);
		const result = await (await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		assert.equal(result.status, "done");
		return requests.at(-1) as TranscriptContext;
	};
	return { harness, corpus, faux, agent, requests, create, drive };
}

test("identical queued Durable inputs at one boundary receive one occurrence-bound notice", {
	timeout: 15000,
}, async (t) => {
	const { harness, faux, agent, requests } = await fixture(t);
	const conversation = await harness.root(BACKGROUND_CONTEXT, { agent });
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(() => release());
	faux.setResponses([
		async (request) => {
			requests.push(structuredClone(request));
			entered();
			await gate;
			return fauxAssistantMessage("first answer");
		},
		(request) => {
			requests.push(structuredClone(request));
			return fauxAssistantMessage("done");
		},
	]);
	const initial = await conversation.submit({ type: "input", content: "Unrelated start" }, BACKGROUND_CONTEXT);
	await started;
	const one = await conversation.submit({ type: "input", content: recallText, whenBusy: "steer" }, BACKGROUND_CONTEXT);
	const two = await conversation.submit({ type: "input", content: recallText, whenBusy: "steer" }, BACKGROUND_CONTEXT);
	release();
	for (const submission of [initial, one, two])
		assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
	const admitted = requests.find(
		(request) => request.messages.filter((message) => textOf(message) === recallText).length === 2,
	);
	assert.ok(admitted);
	const duplicates = admitted.messages.filter((message) => textOf(message) === recallText);
	assert.deepEqual(duplicates[0], duplicates[1]);
	assert.equal(notices(admitted).length, 1);
	const first = admitted.messages.findIndex((message) => textOf(message) === recallText);
	assert.match(textOf(admitted.messages[first + 1]), /^Memory notice\./);
	assert.equal(textOf(admitted.messages[first + 2]), recallText);
	const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	assert.equal(entries.items.filter((entry) => entry.kind === "memory.notice").length, 1);
});

test("Durable preserves visible notices across completed matching and watermark-only conversations", {
	timeout: 20000,
}, async (t) => {
	const { create, drive } = await fixture(t);
	const conversations: Durable.Conversation[] = [];
	const original: string[][] = [];
	for (let i = 0; i < 32; i++) {
		const conversation = await create();
		conversations.push(conversation);
		original.push(notices(await drive(conversation, i % 2 === 0 ? recallText : "Unrelated input")));
	}
	const active = notices(await drive(conversations[0], "Refresh the oldest conversation"));
	assert.equal(active.length, 1);
	for (const content of [recallText, "Unrelated input"]) await drive(await create(), content);
	assert.deepEqual(notices(await drive(conversations[0], "Return to the recently used conversation")), active);
	assert.deepEqual(notices(await drive(conversations[2], "Return after conversation churn")), original[2]);
	assert.equal(notices(await drive(conversations[2], recallText)).length, 1);
	assert.equal(notices(await drive(conversations[1], "Return without a match")).length, 0);
});

test("a failed selected read preserves earlier Durable notices and a later request recovers", async (t) => {
	const { corpus, create, drive } = await fixture(t);
	const conversation = await create();
	const first = notices(await drive(conversation, recallText));
	assert.equal(first.length, 1);
	writeRecall(corpus, "Changed before a failed source read.");
	const fault = failSelectedReads(t);
	assert.deepEqual(notices(await drive(conversation, recallText)), first);
	assert.ok(fault.failures() > 0);
	fault.restore();
	const recovered = notices(await drive(conversation, recallText));
	assert.equal(recovered.length, 2);
	assert.equal(recovered[0], first[0]);
	assert.notEqual(recovered[1], first[0]);
});
