import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WorkerRecord } from "./index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "dashboard-records-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { dashboardRecords, dashboardWorker, sendWorkerMessageOutcome, sharedWorkerState } = await import("./index.ts");
after(() => rmSync(agentDir, { recursive: true, force: true }));

function record(id: string, task: string): WorkerRecord {
	return { id, task } as WorkerRecord;
}

test("dashboard records prefer shared live observations and never materialize a worker store", () => {
	const live = record("bg-one", "live");
	const cached = record("bg-one", "cached");
	const nested = record("bg-nested", "nested terminal");
	sharedWorkerState.statusRecords.set(cached.id, cached);
	sharedWorkerState.statusRecords.set(nested.id, nested);
	sharedWorkerState.workerOwners.set("session-one", {
		workerId: live.id,
		ownerSession: "manager",
		model: "provider/model",
		reports: 0,
		collaborationRecord: () => live,
	});
	try {
		assert.deepEqual([...dashboardRecords()], [live, nested]);
		assert.deepEqual(readdirSync(agentDir), []);
	} finally {
		sharedWorkerState.statusRecords.clear();
		sharedWorkerState.workerOwners.clear();
	}
});

test("render-time record lookup uses cached metadata and detects removed records", () => {
	const cached = record("bg-known", "cached");
	const dir = join(agentDir, "subagent", "workers", cached.id);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "worker.json");
	writeFileSync(path, "not parsed during a render");
	sharedWorkerState.statusRecords.set(cached.id, cached);
	try {
		assert.equal(dashboardWorker(cached.id), cached);
		assert.equal(dashboardWorker("../invalid"), null);
		rmSync(path);
		assert.equal(dashboardWorker(cached.id), null);
	} finally {
		sharedWorkerState.statusRecords.clear();
		rmSync(join(agentDir, "subagent"), { recursive: true, force: true });
	}
});

test("typed panel sends report a refusal without parsing the public text response", async () => {
	const outcome = await sendWorkerMessageOutcome("bg-absent", "text", "manager");
	assert.equal(outcome.ok, false);
	assert.match(outcome.text, /No live worker/);
	assert.deepEqual(readdirSync(agentDir), []);
});
