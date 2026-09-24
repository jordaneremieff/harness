import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkerRecord } from "./index.ts";
import { FOOTER_ENTRY, formatSubtreeStatus, restoreFooter, SessionFooter, subtreeStatus, UsageEvidence } from "./footer.ts";

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
	assert.equal(formatSubtreeStatus(subtreeStatus([], "root", new Set())), "subagents 0 · $0.00");
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
	assert.equal(formatSubtreeStatus(status), "subagents 0+? · $3.00+?");
	assert.equal(subtreeStatus([record("idle", "root", "one", 0)], "root", new Set(), new Set(["idle"])).incomplete, false);
});

it("keeps raw snapshots disjoint from ordinary-host display totals and retains exact-session checkpoints", () => {
	const footer = new SessionFooter("root");
	const status = { active: 1, cost: 2, incomplete: false, workers: 1 };
	assert.equal(footer.raw(status).cost, 2);
	assert.equal(footer.acceptAgent({ version: 1, publisher: "agent", sessionId: "root", available: true, active: 2, cost: 3, incomplete: false }), true);
	assert.equal(footer.display(footer.raw(status)).cost, 5);
	assert.equal(footer.raw(status).cost, 2);
	const saved = structuredClone(footer.saved);
	const entries = [{ type: "custom", customType: FOOTER_ENTRY, data: saved }] as SessionEntry[];
	const restored = new SessionFooter("root", restoreFooter(entries, "root"));
	assert.equal(restored.raw(status).cost, 2);
	assert.equal(restored.display(status).cost, 5);
	assert.equal(restored.display(status).incomplete, true, "retained contribution needs live confirmation");
	assert.equal(restoreFooter(entries, "fork"), undefined);
	footer.acceptAgent({ version: 1, publisher: "agent", sessionId: "root", available: false });
	assert.equal(footer.display(status).cost, 5);
	assert.equal(footer.display(status).incomplete, true);
	assert.equal(footer.raw({ ...status, cost: 0 }).cost, 2, "record removal never erases spend");
	assert.equal(footer.raw({ ...status, cost: 1 }).cost, 3);
});

it("seals missing raw usage at shutdown but permits complete startup evidence", () => {
	const footer = new SessionFooter("root");
	const pending = { active: 1, cost: 0, incomplete: true, workers: 1 };
	assert.equal(footer.raw(pending).incomplete, true);
	assert.equal(footer.raw({ ...pending, cost: 1, incomplete: false }).incomplete, false);
	footer.finish(footer.raw({ ...pending, active: 0, cost: 1 }));
	const restored = new SessionFooter("root", structuredClone(footer.saved));
	assert.equal(restored.raw({ active: 0, cost: 1, incomplete: false, workers: 1 }).incomplete, true);
	assert.equal(restored.saved.raw.cost, 1);
	assert.equal(footer.acceptAgent({ version: 1, publisher: "agent", sessionId: "foreign", available: true, active: 0, cost: 99, incomplete: false }), false);
	assert.equal(footer.acceptAgent({ version: 1, publisher: "agent", sessionId: "root", available: true, active: -1, cost: 99, incomplete: false }), true);
	assert.equal(footer.saved.agent.cost, 0);
	assert.equal(footer.saved.agent.incomplete, true);
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
