import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as Durable from "@earendil-works/pi-durable";
import { renderAgentLineage } from "./agent-lineage.ts";

const context = BACKGROUND_CONTEXT;
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
	assert.equal(await renderAgentLineage(harness, Children, caller, context), "");
	await harness.commit(async (tx) => { await tx.doc(Children, root.id); }, context);
	assert.equal(await renderAgentLineage(harness, Children, caller, context), "");
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
	assert.equal(await renderAgentLineage(harness, Children, caller, context), [
		"Your agents (newest first):",
		"- lineage-storage:3: native child conversation",
		'- foreign-storage "writer": storage with own host',
		'- lineage-storage:2 "reader": native child conversation',
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
	const block = await renderAgentLineage(harness, Children, caller, context);
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
	const block = await renderAgentLineage(harness, Children, caller, context);
	assert.equal(block.split("\n").length, 2);
	assert.ok(block.includes("line\\nbreak"));
	assert.ok(block.includes("…"));
	assert.ok(block.length < 260);
});
