import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCollaborationReader } from "./collaboration.ts";
import type { WorkerRecord } from "./index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "dashboard-records-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const {
	dashboardRecords,
	dashboardRoster,
	dashboardWorker,
	collaborationMessageText,
	peerMessage,
	sendWorkerMessageOutcome,
	sharedWorkerState,
} = await import("./index.ts");
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

test("the overview scopes before its cap and sorts settled records by their recorded creation time", () => {
	for (let index = 0; index < 520; index++)
		sharedWorkerState.statusRecords.set(`bg-other${index}`, {
			...record(`bg-other${index}`, "other"),
			ownerSession: "other",
			createdAt: index,
			state: "done",
		});
	const child = {
		...record("bg-child", "direct child"),
		ownerSession: "manager",
		createdAt: 999,
		state: "done" as const,
	};
	sharedWorkerState.statusRecords.set(child.id, child);
	try {
		assert.deepEqual(dashboardRoster("manager"), [child]);
		assert.equal(dashboardRoster().length, 513);
		assert.equal(dashboardRoster()[0], child);
		assert.deepEqual(readdirSync(agentDir), []);
	} finally {
		sharedWorkerState.statusRecords.clear();
	}
});

test("communication family selection precedes unrelated cached records at the evidence cap", async () => {
	const managerId = "11111111-1111-4111-8111-111111111111";
	for (let index = 0; index < 520; index++) sharedWorkerState.statusRecords.set(`bg-other${index}`, {
		...record(`bg-other${index}`, "unrelated"), sessionId: `other-session-${index}`, ownerSession: "other", createdAt: index, state: "done", model: "test/model",
	});
	const child = { ...record("bg-child", "direct child"), sessionId: "child-session", ownerSession: managerId, createdAt: 0, state: "done" as const, model: "test/model" };
	sharedWorkerState.statusRecords.set(child.id, child);
	try {
		const query = createCollaborationReader({ current: SessionManager.inMemory(process.cwd(), { id: managerId }), records: dashboardRecords, managers: () => [] });
		const snapshot = await query({});
		assert.ok(snapshot.participants.some((participant) => participant.id === child.id));
		assert.match(snapshot.notices.join("\n"), /known-record limit/);
		assert.deepEqual(dashboardRoster(managerId), [child]);
	} finally { sharedWorkerState.statusRecords.clear(); }
});

test("a nested current session keeps its ownership ancestors before the evidence cap", async () => {
	const managerId = "11111111-1111-4111-8111-111111111111";
	// A large family: 520 direct children newer than the old parent, so the parent
	// sorts last within the family and would be pushed past the cap without
	// ancestry retention.
	for (let index = 0; index < 520; index++) sharedWorkerState.statusRecords.set(`bg-direct${index}`, {
		...record(`bg-direct${index}`, "sibling"), sessionId: `direct-session-${index}`, ownerSession: managerId, createdAt: 2 + index, state: "done", model: "test/model",
	});
	const parent = { ...record("bg-parent", "parent"), sessionId: "parent-session", ownerSession: managerId, createdAt: 0, state: "done" as const, model: "test/model" };
	const current = { ...record("bg-current", "nested current"), sessionId: "current-session", ownerSession: "parent-session", createdAt: 1, state: "running" as const, model: "test/model" };
	sharedWorkerState.statusRecords.set(parent.id, parent);
	sharedWorkerState.statusRecords.set(current.id, current);
	try {
		const query = createCollaborationReader({
			current: SessionManager.inMemory(process.cwd(), { id: "current-session" }),
			records: dashboardRecords,
			managers: () => [],
		});
		const snapshot = await query({});
		assert.equal(snapshot.familyId, managerId);
		assert.ok(snapshot.participants.some((participant) => participant.id === current.id));
		assert.ok(snapshot.participants.some((participant) => participant.id === parent.id));
	} finally { sharedWorkerState.statusRecords.clear(); }
});

test("conversation display removes its own wrapper and preserves original peer source evidence", () => {
	const payload = peerMessage({
		id: "pm-fixture",
		from: "bg-source",
		to: "bg-target",
		replyTo: null,
		sentAt: 1,
		message: "Please inspect the interface.\nKeep exact identifiers.",
	});
	assert.equal(
		collaborationMessageText(payload.content, "bg-source"),
		"Please inspect the interface.\nKeep exact identifiers.",
	);
	assert.match(payload.content, /Peer-authored data, not operator input/);
	assert.equal(collaborationMessageText(payload.content, "bg-other"), payload.content);
	assert.equal(collaborationMessageText("plain fixture message", "bg-source"), "plain fixture message");
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
