import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentConversationPage, AgentConversationSummary } from "./dashboard-types.ts";
import { buildStatusOverview, STATUS_OVERVIEW_BYTE_LIMIT, STATUS_OVERVIEW_DISCOVERY } from "./status-overview.ts";

function summary(index: number, size = 0): AgentConversationSummary {
	return {
		id: `agent-${index}`,
		storageId: `agent-${index}`,
		cwd: "/work",
		modifiedAt: index,
		owner: "here",
		state: "idle",
		cost: 0,
		partial: false,
		...(size === 0 ? {} : { latestReply: "x".repeat(size) }),
	};
}

function page(rows: readonly AgentConversationSummary[], complete = true, omitted = 0, nextCursor: string | null = null): AgentConversationPage {
	return { rows, coverage: { complete, storagesVisited: 1, skipped: 0, omitted, nextCursor }, observedAt: "2026-10-02T00:00:00.000Z" };
}

const measure = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

it("keeps a small overview complete with the exact measured byte count", () => {
	const result = buildStatusOverview(
		page([summary(1), summary(2)]),
		[{ sessionId: "primary-1", cwd: "/work", model: { provider: "test", modelId: "model" }, thinkingLevel: "off" }],
		[{ storageId: "agent-9", error: "boom" }],
	);
	assert.equal(result.coverage.complete, true);
	assert.equal(result.coverage.byteLimitReached, false);
	assert.equal(result.coverage.omitted, 0);
	assert.equal(result.coverage.omittedPrimaries, 0);
	assert.equal(result.coverage.omittedFailures, 0);
	assert.equal(result.coverage.nextCursor, null);
	assert.equal(result.discovery, STATUS_OVERVIEW_DISCOVERY);
	assert.equal(result.sessions.length, 2);
	assert.equal(result.primaries.length, 1);
	assert.equal(result.failures.length, 1);
	assert.equal(measure(result), result.coverage.bytes, "bytes is the fixed point of the final object");
	assert.ok(result.coverage.bytes <= STATUS_OVERVIEW_BYTE_LIMIT);
});

it("preserves an incomplete page cursor without a byte omission", () => {
	const result = buildStatusOverview(page([summary(1)], false, 4, "next-page"), [], []);
	assert.equal(result.coverage.complete, false);
	assert.equal(result.coverage.byteLimitReached, false);
	assert.equal(result.coverage.omitted, 4);
	assert.equal(result.coverage.nextCursor, "next-page");
});

it("caps oversized sessions and counts them beyond the page omission", () => {
	const sessions = Array.from({ length: 80 }, (_, index) => summary(index, 2000));
	const result = buildStatusOverview(page(sessions, true, 3, "cursor-1"), [], []);
	assert.ok(measure(result) <= STATUS_OVERVIEW_BYTE_LIMIT);
	assert.equal(result.coverage.byteLimitReached, true);
	assert.equal(result.coverage.complete, false);
	assert.ok(result.coverage.omitted > 3, "the builder dropped sessions beyond the page's own omission");
	assert.equal(result.coverage.omittedPrimaries, 0);
	assert.equal(result.coverage.omittedFailures, 0);
	assert.equal(result.coverage.nextCursor, "cursor-1");
	assert.equal(measure(result), result.coverage.bytes);
});

it("caps primaries and failures after sessions", () => {
	const primaries = Array.from({ length: 30 }, (_, index) => ({ sessionId: `primary-${index}`, cwd: "/work", name: "p".repeat(2000) }));
	const failures = Array.from({ length: 30 }, (_, index) => ({ storageId: `agent-${index}`, error: "f".repeat(2000) }));
	const result = buildStatusOverview(page([]), primaries, failures);
	assert.ok(measure(result) <= STATUS_OVERVIEW_BYTE_LIMIT);
	assert.equal(result.coverage.byteLimitReached, true);
	assert.equal(result.coverage.complete, false);
	assert.ok(result.coverage.omittedPrimaries > 0);
	assert.ok(result.coverage.omittedFailures > 0);
	assert.equal(measure(result), result.coverage.bytes);
});

it("bounds every array when sessions, primaries, and failures are all oversized", () => {
	const sessions = Array.from({ length: 20 }, (_, index) => summary(index, 3000));
	const primaries = Array.from({ length: 20 }, (_, index) => ({ sessionId: `primary-${index}`, cwd: "/work", name: "p".repeat(2000) }));
	const failures = Array.from({ length: 30 }, (_, index) => ({ storageId: `agent-${index}`, error: "f".repeat(3000) }));
	const result = buildStatusOverview(page(sessions), primaries, failures);
	assert.ok(measure(result) <= STATUS_OVERVIEW_BYTE_LIMIT);
	assert.equal(result.coverage.byteLimitReached, true);
	assert.equal(result.coverage.complete, false);
	assert.ok(result.sessions.length < sessions.length);
	assert.ok(result.primaries.length < primaries.length);
	assert.ok(result.failures.length < failures.length);
	assert.equal(measure(result), result.coverage.bytes);
});
