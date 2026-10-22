import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, LiveDoc, MemoryStorage, ProviderDoc, createRegistry, defineTask, type CompactionResult, type TaskId } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { CatalogAttentionHintsSchema, projectCatalogAttention } from "./catalog-attention.ts";
import { ProviderControlDoc } from "./provider-block.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const registry = createRegistry();
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
	t.after(() => harness.close(context));
	const root = await harness.root(context);
	const source = { identity: "storage", conversationId: root.id, state: "idle" };
	return { harness, registry, root, source };
}

function task(version: number) {
	return defineTask<null, { phase: "hold" }, null>({
		name: "fixture.catalog-attention",
		version,
		initial: () => ({ phase: "hold" }),
		phases: { hold: async () => {} },
		abort: (_task, runtime, current) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), current),
	});
}

it("projects failed native turns and clears the hint when the next native state replaces failure", async (t) => {
	const f = await fixture(t);
	const failed = await projectCatalogAttention(f.harness, [{ ...f.source, state: "failed" }], context);
	assert.deepEqual(failed.rows, [{ identity: f.source.identity, kind: "failed-turn" }]);
	assert.equal(Value.Check(CatalogAttentionHintsSchema, failed), true);
	for (const state of ["working", "done", "idle", "stopped", "interrupted"]) {
		assert.deepEqual((await projectCatalogAttention(f.harness, [{ ...f.source, state }], context)).rows, []);
	}
});

it("projects only current provider blocks and clears the hint after recovery removes the block", async (t) => {
	const f = await fixture(t);
	await f.harness.commit(async (tx) => {
		const provider = await tx.doc(ProviderDoc, f.root.id);
		const state = await tx.doc(ProviderControlDoc, provider.sessionId, null);
		state.block = { blockId: "provider-block", conversationId: f.root.id, providerSessionId: provider.sessionId, epoch: 0,
			model: { provider: "fixture", modelId: "fixture" }, error: "synthetic quota exhaustion", errorRedacted: false,
			errorTruncated: false, source: "provider", timestamp: 1, originalResults: [], omittedOriginalResults: 0 };
	}, context);
	const failed = { ...f.source, state: "failed" };
	assert.deepEqual((await projectCatalogAttention(f.harness, [failed], context)).rows,
		[{ identity: f.source.identity, kind: "provider-blocked", blockId: "provider-block" }]);
	await f.harness.commit(async (tx) => {
		const provider = await tx.doc(ProviderDoc, f.root.id);
		delete (await tx.doc(ProviderControlDoc, provider.sessionId, null)).block;
	}, context);
	assert.deepEqual((await projectCatalogAttention(f.harness, [failed], context)).rows,
		[{ identity: f.source.identity, kind: "failed-turn" }]);
	assert.deepEqual((await projectCatalogAttention(f.harness, [f.source], context)).rows, []);
});

it("uses exact native blocked-task reasons and clears host-repair hints when a definition becomes usable", async (t) => {
	const f = await fixture(t);
	const definition = task(2);
	const taskId = await f.harness.commit((tx) => tx.createTask(definition, null,
		{ ownership: { kind: "conversation" }, conversationId: f.root.id }), context);
	const failed = { ...f.source, state: "failed" };
	const expectReason = async (reason: string) => {
		assert.deepEqual((await projectCatalogAttention(f.harness, [failed], context)).rows,
			[{ identity: f.source.identity, kind: "task-blocked", taskId, reason }]);
	};
	await expectReason("missing_task");
	f.registry.install({ name: "fixture.catalog-attention", tasks: [task(1)] });
	await expectReason("task_too_old");
	f.registry.install({ name: "fixture.catalog-attention", tasks: [task(3)] });
	await expectReason("migration_failed");
	f.registry.install({ name: "fixture.catalog-attention", tasks: [definition] });
	assert.deepEqual((await projectCatalogAttention(f.harness, [failed], context)).rows,
		[{ identity: f.source.identity, kind: "failed-turn" }]);
	assert.deepEqual((await projectCatalogAttention(f.harness, [f.source], context)).rows, []);
});

it("does not treat automatic retries, compaction diagnostics or reply prose as intervention facts", async (t) => {
	const f = await fixture(t);
	await f.harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, f.root.id);
		live.generation = { attempt: 2, retry: { at: 5000, error: "synthetic throttle" } };
		live.compactions = [{ taskId: 10 as TaskId<CompactionResult>, reason: "manual", blocking: true, attempt: 1, retry: { at: 5000, error: "synthetic retry" } }];
		live.compactionFailure = { taskId: 11 as TaskId<CompactionResult>, reason: "manual", error: "synthetic compaction failure" };
	}, context);
	const source = { ...f.source, state: "working", latestReply: "I need your answer. Please approve this request.", error: "Needs input" };
	const hints = await projectCatalogAttention(f.harness, [source], context);
	assert.deepEqual(hints, { rows: [], coverage: { complete: true, omitted: 0 } });
});

it("accepts the native crash-loop guard reason without replacing it with a migration error", () => {
	assert.equal(Value.Check(CatalogAttentionHintsSchema, { rows: [{ identity: "storage", kind: "task-blocked", taskId: 1, reason: "restart_limit" }], coverage: { complete: true, omitted: 0 } }), true);
});

it("keeps blocked-task hints within their own conversation", async (t) => {
	const f = await fixture(t);
	const child = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	await f.harness.commit((tx) => tx.createTask(task(1), null,
		{ ownership: { kind: "conversation" }, conversationId: child.id }), context);
	assert.deepEqual((await projectCatalogAttention(f.harness, [f.source], context)).rows, []);
	const hints = await projectCatalogAttention(f.harness, [{ identity: "storage:2", conversationId: child.id, state: "idle" }], context);
	assert.equal(hints.rows[0]?.identity, "storage:2");
	assert.equal(hints.rows[0]?.kind, "task-blocked");
});
