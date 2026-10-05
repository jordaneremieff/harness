import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as Durable from "@earendil-works/pi-durable";
import { readCreatedAgents, renderCreatedAgents } from "./agent-lineage.ts";

const context = BACKGROUND_CONTEXT;
async function lineageText(harness: Durable.Harness, caller: { storageId: string; conversationId: Durable.ConversationId }): Promise<string> {
	const lineage = await readCreatedAgents(harness, Children, caller, context);
	return lineage === undefined ? "" : renderCreatedAgents(lineage);
}
type Child = { name?: string; conversationId?: Durable.ConversationId; foreignSessionId?: string };
const Children = Durable.defineDoc<{ children: Child[] }>({
	kind: "agent.children", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ children: [] }),
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models: createModels(), registry: Durable.createRegistry() }, context);
	t.after(async () => { await harness.close(context); });
	const root = await harness.root(context);
	return { harness, root, caller: { storageId: "lineage-storage", conversationId: root.id } };
}

it("omits lineage for an absent or empty child document", async (t) => {
	const { harness, root, caller } = await fixture(t);
	assert.equal(await lineageText(harness, caller), "");
	await harness.commit(async (tx) => { await tx.doc(Children, root.id); }, context);
	assert.equal(await lineageText(harness, caller), "");
});

it("renders native and foreign children newest first with retained names", async (t) => {
	const { harness, root, caller } = await fixture(t);
	await harness.commit(async (tx) => {
		(await tx.doc(Children, root.id)).children.push(
			{ conversationId: 2 as Durable.ConversationId, name: "reader" },
			{ foreignSessionId: "foreign-storage", name: "writer" },
			{ conversationId: 3 as Durable.ConversationId },
		);
	}, context);
	assert.equal(await lineageText(harness, caller), [
		"Created agents (newest first; retained creation labels):",
		"- lineage-storage:3: conversation in this storage",
		'- foreign-storage "writer": storage with own host',
		'- lineage-storage:2 "reader": conversation in this storage',
	].join("\n"));
	assert.equal((await harness.snapshot(Children, root.id, context))?.children[0]?.name, "reader", "rendering does not reorder retained state");
});

it("caps lineage rows and reports the exact omitted count", async (t) => {
	const { harness, root, caller } = await fixture(t);
	await harness.commit(async (tx) => {
		(await tx.doc(Children, root.id)).children = Array.from({ length: 23 }, (_, index) => ({
			foreignSessionId: `foreign-${index}`, name: "repeat",
		}));
	}, context);
	const block = await lineageText(harness, caller);
	const rows = block.split("\n");
	assert.equal(rows.length, 22);
	assert.equal(rows[1], '- foreign-22 "repeat": storage with own host');
	assert.equal(rows[20], '- foreign-3 "repeat": storage with own host');
	assert.equal(rows[21], "3 more omitted.");
});

it("bounds and escapes retained names without creating extra rows", async (t) => {
	const { harness, root, caller } = await fixture(t);
	await harness.commit(async (tx) => {
		(await tx.doc(Children, root.id)).children.push({ foreignSessionId: "foreign", name: `line\nbreak${"x".repeat(200)}` });
	}, context);
	const block = await lineageText(harness, caller);
	assert.equal(block.split("\n").length, 2);
	assert.ok(block.includes("line\\nbreak"));
	assert.ok(block.includes("…"));
	assert.equal((await readCreatedAgents(harness, Children, caller, context))?.agents[0]?.name?.length, 161);
	assert.ok((block.split("\n")[1]?.length ?? 0) < 220);
});
