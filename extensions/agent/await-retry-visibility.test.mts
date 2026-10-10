import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { AwaitDoc, claimProviderRetryVisibility } from "./awaited-results.ts";

it("retains exact retry acknowledgment after SQLite close and reopen", { timeout: 10000 }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "await-retry-visibility-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, "state.sqlite");
	const context = BACKGROUND_CONTEXT;
	const options = { models: createModels(), registry: createRegistry() };
	let harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
	const root = await harness.root(context);
	const retry = { state: "provider-retry" as const, runId: 9, results: [{ sessionId: "producer", submissionId: 10, requestId: "exact" }], attempt: 1, nextRetryAt: 100, error: "native transport interruption", errorTruncated: false };
	assert.equal(await harness.commit((tx) => claimProviderRetryVisibility(tx, root.id, [42], retry), context), true);
	await harness.close(context);
	harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
	try {
		assert.equal(await harness.commit((tx) => claimProviderRetryVisibility(tx, root.id, [42], retry), context), false);
		assert.equal(await harness.commit((tx) => claimProviderRetryVisibility(tx, root.id, [42], { ...retry, attempt: 2, nextRetryAt: 200 }), context), true);
		assert.equal(await harness.commit((tx) => claimProviderRetryVisibility(tx, root.id, [42], retry), context), false);
		assert.equal(await harness.commit((tx) => claimProviderRetryVisibility(tx, root.id, [43], retry), context), true);
		assert.equal((await harness.snapshot(AwaitDoc, context))?.retryVisibility?.length, 2);
	} finally { await harness.close(context); }
});
