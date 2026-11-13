import assert from "node:assert/strict";
import { test } from "node:test";
import { hostname } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { previousNative, readNative, recentNative, type NativeSource } from "./native-responses.ts";
import { responseText, SOURCE_BYTES } from "./responses.ts";

test("native extraction uses real fork-aware pages, a captured cutoff and exact visible identity", { timeout: 20000 }, async () => {
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models: createModels(), registry: Durable.createRegistry() }, context);
	try {
		const root = await harness.root(context);
		const append = (conversation: Durable.Conversation, text: string) => conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: Durable.AssistantEntry.kind, model: [fauxAssistantMessage(text, { timestamp: 1760000000000 })] }), context);
		const first = await append(root, "First response");
		const sibling = await append(root, "Only on the root branch");
		const branch = await root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
		const second = await append(branch, "Second response");
		let requests = 0;
		const source: NativeSource = { durable: Durable, storageId: "synthetic", cwd: "/project", conversation: { id: branch.id, entries: async (...args) => {
			const page = await branch.entries(...args);
			if (++requests === 1) await append(branch, "Arrived after cutoff");
			return page;
		} } };
		const recent = await recentNative(source, context, { pageSize: 1 });
		assert.deepEqual(recent.rows.map((row) => row.entryId), [String(second.id), String(first.id)]);
		assert.equal(recent.cutoff, String(second.id));
		assert.equal(recent.rows[0].timestamp, 1760000000000);
		assert.equal((await readNative(source, String(first.id), context)).provenance.host, hostname());
		assert.ok(requests >= 2);
		assert.equal(responseText(await readNative(source, String(first.id), context)), "First response");
		await assert.rejects(readNative(source, String(sibling.id), context), /not visible/u);
		assert.equal((await recentNative(source, context, { visits: 1, pageSize: 1 })).stop, "visits");
		assert.equal((await recentNative(source, context, { results: 1 })).stop, "results");
		const huge = await append(branch, "x".repeat(SOURCE_BYTES + 1));
		await assert.rejects(readNative(source, String(huge.id), context), /exceeds/u);
	} finally { await harness.close(context); }
});
test("the native previous answer precedes the newest user entry", { timeout: 20000 }, async () => {
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models: createModels(), registry: Durable.createRegistry() }, context);
	try {
		const root = await harness.root(context);
		const assistant = (text: string) => root.commit((tx) => tx.appendEntry(root.id, { kind: Durable.AssistantEntry.kind, model: [fauxAssistantMessage(text, { timestamp: 1760000000000 })] }), context);
		const user = (text: string) => root.commit((tx) => tx.appendEntry(root.id, { kind: Durable.UserEntry.kind, model: [{ role: "user", content: text, timestamp: 1760000000000 }] }), context);
		const source = { durable: Durable, storageId: "synthetic", cwd: "/project", conversation: root };
		await assert.rejects(previousNative(source, context), /No earlier response/u);
		await assistant("The long answer");
		await user("show that in the reader");
		await assistant("Opening it now");
		assert.equal(responseText(await previousNative(source, context)), "The long answer");
	} finally { await harness.close(context); }
});
