import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT, type AgentLane } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";

async function fixture() {
	const base = mkdtempSync(join(tmpdir(), "agent-worker-control-"));
	const cwd = join(base, "work");
	mkdirSync(cwd);
	const store = new AgentStore({ sessionsRoot: join(base, "sessions") });
	const worker = await AgentWorkerSession.create({
		cwd, agentDir: base, store, rootContext: BACKGROUND_CONTEXT,
		modelRuntime: await createTestRuntime({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(base, "models-cache"), refreshOnCreate: false }),
		model: { provider: "agent-test", modelId: "model" }, extensionPaths: [],
	});
	return {
		worker,
		lane: (worker as unknown as { lane: AgentLane }).lane,
		async close() {
			try { await worker.close(); } finally {
				try { await store.close(BACKGROUND_CONTEXT); } finally { rmSync(base, { recursive: true, force: true }); }
			}
		},
	};
}

describe("worker control results", () => {
	it("returns the durable queued entry ID", async () => {
		const test = await fixture();
		try {
			const entryId = await test.worker.steer("Use the current source");
			const observer = await test.worker.observeLane();
			try { assert.equal(observer.snapshot.queues[0]?.entryId, entryId); }
			finally { observer.subscribe(() => undefined)(); }
			assert.ok(entryId);
		} finally { await test.close(); }
	});

	it("rejects failed lane admission instead of reporting a queued message", async (t) => {
		const test = await fixture();
		try {
			for (const tag of ["InvalidMessage", "Closed"]) {
				const mocked = t.mock.method(test.lane, "steer", async () => ({ ok: false, error: { _tag: tag } }));
				await assert.rejects(test.worker.steer("input"), new RegExp(`Steering failed: ${tag}`, "u"));
				mocked.mock.restore();
			}
			const observer = await test.worker.observeLane();
			try { assert.deepEqual(observer.snapshot.queues, []); }
			finally { observer.subscribe(() => undefined)(); }
		} finally { await test.close(); }
	});

	it("retrieves the requested operation without consulting the latest operation", async (t) => {
		const test = await fixture();
		try {
			const result = { operationId: "initial", kind: "run", status: "completed", fromTipId: null, tipId: null, startedAt: 0, endedAt: 1 };
			t.mock.method(test.lane, "inspectExecution", () => { throw new Error("latest operation must not select this result"); });
			const getResult = t.mock.method(test.lane, "getResult", async (operationId: string) => operationId === "initial" ? result : undefined);
			assert.equal(await test.worker.operationResult("initial"), result);
			assert.equal(await test.worker.operationResult("absent"), undefined);
			assert.deepEqual(getResult.mock.calls.map((call) => call.arguments[0]), ["initial", "absent"]);
		} finally { await test.close(); }
	});
});
