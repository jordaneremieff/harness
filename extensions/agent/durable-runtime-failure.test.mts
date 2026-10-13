import assert from "node:assert/strict";
import { it } from "node:test";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SessionFailed, type ConversationId, type Storage } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { DurableHost } from "./durable-host.ts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

for (const reloaded of [false, true]) it(`publishes fatal Session closure${reloaded ? " after reload" : ""} to runtime supervision and retains recovery due`, { timeout: 15000 }, async (t) => {
	const fixture = runtimeFixture(t);
	const models = await createTestRuntime();
	const open = DurableHost.open;
	let host: DurableHost | undefined;
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => {
		host = await open(...args);
		return host;
	});
	const runtime = await createDurableRuntime({ ...fixture.metadata, model: { provider: testModel.provider, modelId: testModel.id } }, { modelRuntime: models });
	t.after(() => runtime.close());
	assert.ok(host);
	assert.equal(runtime.shutdownRequired, false);
	if (reloaded) {
		const previous = host;
		const outcome = await runtime.request("command", { name: "reload" }, "reload-before-failure") as { reloaded: boolean };
		assert.equal(outcome.reloaded, true);
		assert.notEqual(host, previous);
		assert.equal(runtime.shutdownRequired, false);
	}
	let signaled = false;
	const stop = runtime.onActivity?.(() => { if (host?.sessionEnded) signaled = true; });
	t.after(() => stop?.());
	const cause = new Error("synthetic runtime storage failure");
	const storage = (host as unknown as { storage: Storage }).storage;
	storage.conversation = async () => { throw cause; };
	await assert.rejects(host.harness.conversation(999 as ConversationId, context), (error) => error === cause);
	assert.deepEqual(await host.harness.closed, { reason: "failed", error: cause });
	assert.equal(runtime.shutdownRequired, true);
	assert.equal(runtime.isIdle(), false);
	assert.equal(signaled, true);
	assert.equal(new AgentCatalog(dirname(dirname(fixture.storagePath))).read(fixture.metadata.storageId).recoveryDue, true);
	await assert.rejects(runtime.request("submit", { message: "unadmitted", requestId: "after-failure" }, "after-failure"), (error) => error instanceof SessionFailed && error.cause === cause);
	assert.equal(await runtime.close(), "process-exit");
});
