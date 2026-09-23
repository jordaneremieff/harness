import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkerRecord } from "./index.ts";
import { formatSubtreeStatus, subtreeStatus, UsageEvidence } from "./footer.ts";

function record(id: string, ownerSession: string, sessionId: string, cost: number | null, state = "running"): WorkerRecord {
	return { id, ownerSession, sessionId, state, usage: cost === null ? null : { cost } } as WorkerRecord;
}

it("counts each subagent-only descendant once and keeps ordinary-session roots separate", () => {
	const first = record("a", "root", "a-session", 1);
	const nested = record("b", "a-session", "b-session", 2);
	const idle = record("c", "b-session", "c-session", 4);
	const terminal = record("d", "c-session", "d-session", 8, "done");
	const separate = record("e", "ordinary-session", "e-session", 16);
	const records = [first, nested, idle, terminal, separate, nested];
	assert.deepEqual(subtreeStatus(records, "root", new Set(["a", "b"]), new Set(["a", "b", "c"])), {
		active: 2, cost: 15, incomplete: false, workers: 4,
	});
	assert.equal(subtreeStatus(records, "ordinary-session", new Set(["e"])).cost, 16);
	assert.equal(formatSubtreeStatus(subtreeStatus([], "root", new Set())), undefined);
});

it("retains descendants across repeated replacement without counting copied ancestry", () => {
	const parent = record("parent", "root", "third", 1, "done");
	parent.previousSessionIds = ["first", "second", "first", "third"];
	const children = [record("one", "first", "one-session", 2, "done"), record("two", "second", "two-session", 4, "done"), record("three", "third", "three-session", 8, "done")];
	const separate = record("foreign", "fork-source", "foreign-session", 16, "done");
	assert.deepEqual(subtreeStatus([parent, ...children, children[0], separate], "root", new Set()), {
		active: 0, cost: 15, incomplete: false, workers: 4,
	});
	assert.equal(subtreeStatus([parent, ...children, separate], "fork-source", new Set()).cost, 16);
});

it("retains known cost beside missing usage and unavailable live ownership", () => {
	const records = [record("known", "root", "one", 3), record("unknown", "one", "two", null, "done")];
	const status = subtreeStatus(records, "root", new Set());
	assert.deepEqual(status, { active: 0, cost: 3, incomplete: true, workers: 2 });
	assert.equal(formatSubtreeStatus(status), "subagents: 0+? active · $3.00+?");
	assert.equal(subtreeStatus([record("idle", "root", "one", 0)], "root", new Set(), new Set(["idle"])).incomplete, false);
});

it("uses native usage categories after its history boundary and marks absent cost", () => {
	const usage = (total: number) => ({ cost: { total } });
	const entries = [
		{ type: "message", message: { role: "assistant", usage: usage(99) } },
		{ type: "message", message: { role: "assistant", usage: usage(1) } },
		{ type: "message", message: { role: "toolResult", usage: usage(2) } },
		{ type: "message", message: { role: "toolResult" } },
		{ type: "usage", usage: usage(4), reason: "cache_warm" },
		{ type: "compaction", usage: usage(8) },
		{ type: "branch_summary", usage: usage(16) },
	] as SessionEntry[];
	const evidence = new UsageEvidence(1);
	evidence.observe(entries);
	evidence.observe(entries);
	assert.equal(evidence.cost, 31);
	assert.equal(evidence.incomplete, false);
	evidence.observe([...entries, { type: "compaction" } as SessionEntry]);
	assert.equal(evidence.cost, 31);
	assert.equal(evidence.incomplete, true);
});
