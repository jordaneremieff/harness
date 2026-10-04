import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { formatDurableFooter } from "./footer.ts";

function row(id = "a", overrides: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
	return { id, storageId: "storage", cwd: "/work", owner: "here", modifiedAt: 1, state: "idle", cost: 0, partial: false, ...overrides };
}

test("re-observing the same native totals is idempotent and never double-counts", () => {
	const rows = [row("a", { state: "working", cost: 0.25 })];
	assert.equal(formatDurableFooter(rows), "agents: 1/1 active (session) · $0.25");
	assert.equal(formatDurableFooter(rows), "agents: 1/1 active (session) · $0.25", "a second observation adds no delta");
	const before = structuredClone(rows);
	formatDurableFooter(rows);
	assert.deepEqual(rows, before, "formatting does not mutate the observation");
});

test("a later observation reports the native cumulative total, not a delta", () => {
	const first = formatDurableFooter([row("a", { state: "working", cost: 0.25 })]);
	const second = formatDurableFooter([row("a", { state: "working", cost: 0.4 })]);
	assert.equal(first, "agents: 1/1 active (session) · $0.25");
	assert.equal(second, "agents: 1/1 active (session) · $0.40");
});

test("reconnect re-reads the same Durable totals and restores the footer unchanged", () => {
	const native = [row("a", { state: "working", cost: 0.25 }), row("b", { state: "idle", cost: 0.1 })];
	const beforeDisconnect = formatDurableFooter(native);
	// A reconnect starts from the Durable usage documents, not from a retained local checkpoint.
	const afterReconnect = formatDurableFooter(structuredClone(native));
	assert.equal(afterReconnect, beforeDisconnect);
	assert.equal(afterReconnect, "agents: 1/2 active (session) · $0.35");
});

test("partial cost follows the current Durable source instead of a sticky local flag", () => {
	assert.equal(formatDurableFooter([row("a", { cost: 0.25, partial: true })]), "agents: 0/1 active (session) · $0.25+?");
	assert.equal(formatDurableFooter([row("a", { cost: 0.25, partial: false })]), "agents: 0/1 active (session) · $0.25");
});

test("counts each conversation's native total once across forks and owners", () => {
	const rows = [
		row("root", { state: "working", cost: 0.25, owner: "here" }),
		row("storage:2", { state: "idle", cost: 0.25, owner: "unknown" }),
	];
	assert.equal(formatDurableFooter(rows), "agents: 1/2 active (session) · $0.50");
});
