import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { formatDurableFooter } from "./footer.ts";

function row(id = "a", overrides: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
	return {
		id,
		storageId: "storage",
		cwd: "/work",
		owner: "here",
		modifiedAt: 1,
		state: "idle",
		cost: 0,
		partial: false,
		...overrides,
	};
}

test("coverage uncertainty qualifies cost without changing the complete status format", () => {
	const rows = [row("working", { state: "working", cost: 0.25 })];
	const complete = { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null };
	assert.equal(formatDurableFooter(rows, complete), "agents 1 · $0.25");
	for (const coverage of [
		{ ...complete, complete: false },
		{ ...complete, nextCursor: "more" },
		{ ...complete, skipped: 1 },
		{ ...complete, omitted: 1 },
	]) {
		assert.equal(formatDurableFooter(rows, coverage), "agents 1 · ≥$0.25");
		assert.equal(formatDurableFooter([], coverage), "agents 0 · ≥$0.00");
	}
});
test("counts only working conversations and keeps the empty footer", () => {
	assert.equal(formatDurableFooter([]), "agents 0 · $0.00");
	const rows = [
		row("working", { state: "working", cost: 0.25 }),
		row("idle", { state: "idle", cost: 1 }),
		row("done", { state: "done", cost: 2 }),
		row("failed", { state: "failed", cost: 4 }),
		row("unavailable", { owner: "unavailable", state: "unavailable", cost: 8 }),
	];
	assert.equal(formatDurableFooter(rows), "agents 1 · $15.25");
});

test("sums native conversation costs and keeps sub-cent totals readable", () => {
	assert.equal(formatDurableFooter([row("a", { cost: 0.1 }), row("b", { cost: 0.2 })]), "agents 0 · $0.30");
	assert.equal(formatDurableFooter([row("a", { cost: 0.0001 })]), "agents 0 · $0.0001");
	assert.equal(formatDurableFooter([row("a", { cost: 0 })]), "agents 0 · $0.00");
});

test("marks incomplete native cost with +? and never reports detached work", () => {
	assert.equal(formatDurableFooter([row("a", { cost: 0.25, partial: true })]), "agents 0 · $0.25+?");
	assert.equal(
		formatDurableFooter([row("a", { cost: 0.25 }), row("b", { cost: 0.75, partial: true })]),
		"agents 0 · $1.00+?",
	);
	assert.equal(formatDurableFooter([row("a", { cost: Number.NaN }), row("b", { cost: -1 })]), "agents 0 · $0.00+?");
	assert.doesNotMatch(formatDurableFooter([row("a", { state: "working" })]), /detached/);
});
