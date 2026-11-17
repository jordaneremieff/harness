import assert from "node:assert/strict";
import { it } from "node:test";
import { buildStatusOverview, STATUS_OVERVIEW_BYTE_LIMIT } from "./status-overview.ts";
import { StatusToolOutputSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";
import { page as rosterPage } from "./dashboard-test-fixture.mts";
import type { AgentPrioritySummary } from "./dashboard-types.ts";
import type { EffortAwareness } from "./effort-awareness.ts";

function awareness(): EffortAwareness {
	return {
		self: { id: "primary", cwd: "/work", observedPurpose: { source: "interactive-input", text: "Review parser" } },
		presence: { efforts: [], coverage: { visited: 0, unreadable: 0, dead: 0, unrelated: 0, omitted: 0, complete: true, reasons: [] }, limits: { visits: 256, results: 20, bytes: 16384 } },
		threads: { items: [], coverage: { visited: 0, records: 0, unreadable: 0, missingHints: 0, omittedHints: 0, omittedResults: 0, unvisited: false, complete: true, reasons: [] }, limits: { visits: 256, results: 12, bytes: 8192, hintsPerRecord: 8 } },
	};
}
const page = { ...rosterPage([]), observedAt: "2026-01-01T00:00:00.000Z" };

function failed(index: number, fields: Partial<AgentPrioritySummary> = {}): AgentPrioritySummary {
	const modifiedAt = Date.parse(`2025-12-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`);
	return { id: `failed-${index}`, storageId: `failed-${index}`, cwd: "/work", modifiedAt,
		rosterOrder: { priority: false, modifiedAt }, owner: "unknown", state: "failed", attention: "provider-blocked",
		error: "Provider quota exhausted", cost: 0, partial: false, ...fields };
}

it("samples old terminal failures with an exact recovery route and retains effort awareness", () => {
	const source = awareness();
	source.presence.efforts.push({ id: "peer", cwd: "/work", startedAt: "2025-12-31", liveness: "live", relationship: "cwd" });
	const rows = Array.from({ length: 13 }, (_, index) => failed(index, { cwd: `/${"project/".repeat(90)}`, latestReply: "Provider quota exhausted. ".repeat(100) }));
	const result = buildStatusOverview({ ...page, ...rosterPage(rows), observedAt: page.observedAt }, [], [], source);
	structuredObservation(StatusToolOutputSchema, result);
	assert.equal(result.summary.sessions.attention, 13);
	assert.deepEqual(result.sessions.map((row) => row.id), ["failed-12", "failed-11", "failed-10"]);
	assert.match(result.coverage.reasons.join(" "), /10 older terminal attention rows were intentionally summarised/);
	assert.match(result.coverage.reasons.join(" "), /24 hours/);
	assert.match(result.coverage.reasons.join(" "), /agent_list\(\{\}\)/);
	assert.deepEqual(result.awareness, source);
	assert.ok(result.coverage.bytes < 8 * 1024);
	assert.equal(result.coverage.complete, true, "intentional history sampling does not hide a source gap");
	assert.equal(result.coverage.omitted, 0);
});

it("keeps protected and recent attention outside historical sampling", () => {
	const now = Date.parse(page.observedAt);
	const protectedRows = [
		failed(20, { state: "starting" }), failed(21, { state: "working" }),
		failed(22, { rosterOrder: { priority: true, modifiedAt: 1 } }),
		failed(23, { openWorkCount: 1 }), failed(24, { unplaced: 1 }),
		failed(25, { modifiedAt: now - 24 * 60 * 60 * 1000 }),
		failed(26, { modifiedAt: now - 1 }),
		failed(27, { state: "idle", attention: "task-blocked" }),
	];
	const rows = [...Array.from({ length: 10 }, (_, index) => failed(index)), ...protectedRows];
	const result = buildStatusOverview({ ...rosterPage(rows), observedAt: page.observedAt }, [], [], awareness());
	for (const row of protectedRows) assert.ok(result.sessions.some((item) => item.id === row.id), row.id);
	assert.equal(result.sessions.length, protectedRows.length + 3);
	assert.equal(result.summary.sessions.attention, rows.length);
	assert.match(result.coverage.reasons.join(" "), /7 older terminal attention rows/);
	structuredObservation(StatusToolOutputSchema, result);
});

it("removes historical attention samples before effort awareness under byte pressure", () => {
	const source = awareness();
	source.presence.efforts.push({ id: "peer", cwd: "/work", startedAt: "2025-12-31", liveness: "live", relationship: "cwd" });
	const rows = Array.from({ length: 13 }, (_, index) => failed(index, { cwd: `/${"x".repeat(6000)}` }));
	const result = buildStatusOverview({ ...rosterPage(rows), observedAt: page.observedAt }, [], [], source);
	assert.equal(result.coverage.byteLimitReached, true);
	assert.ok(result.sessions.length < 3);
	assert.deepEqual(result.awareness, source);
	assert.equal(result.coverage.omitted, 3 - result.sessions.length);
	assert.equal(result.coverage.bytes, Buffer.byteLength(JSON.stringify(result)));
	structuredObservation(StatusToolOutputSchema, result);
});

it("adds current effort awareness only to the tool schema, not the native host response", () => {
	const result = buildStatusOverview(page, [], [], awareness());
	structuredObservation(StatusToolOutputSchema, result);
	assert.throws(() => structuredObservation(StatusOutputSchema, result));
	assert.equal(result.coverage.bytes, Buffer.byteLength(JSON.stringify(result)));
	assert.equal(result.awareness?.self.observedPurpose?.text, "Review parser");
	assert.equal(result.coverage.complete, true);
});

it("accounts for awareness omissions within the existing status byte bound", () => {
	const source = awareness();
	for (let i = 0; i < 20; i++) source.presence.efforts.push({ id: `effort-${i}`, cwd: "/work", startedAt: "2026-01-01", liveness: "live", relationship: "cwd", intentClaim: { purpose: "😀".repeat(256), integration: "next".repeat(400), authority: "quoted".repeat(300), scope: { paths: ["src"], branches: ["work"] }, updatedAt: "2026-01-01" } });
	const result = buildStatusOverview({ ...page, rows: [{ id: "active", storageId: "active", cwd: "/work", modifiedAt: 1, rosterOrder: { priority: false, modifiedAt: 1 }, owner: "here", state: "working", cost: 0, partial: false }] }, [], [], source);
	assert.equal(result.sessions[0]?.id, "active", "optional awareness does not evict active work that fits");
	structuredObservation(StatusToolOutputSchema, result);
	assert.ok(result.coverage.bytes <= STATUS_OVERVIEW_BYTE_LIMIT);
	assert.equal(result.coverage.bytes, Buffer.byteLength(JSON.stringify(result)));
	assert.ok(result.awareness);
	assert.equal(result.awareness.presence.efforts.length + result.awareness.presence.coverage.omitted, 20);
	assert.equal(result.coverage.complete, false);
	assert.ok(result.awareness.presence.coverage.reasons.includes("status-byte-limit"));
	assert.equal(source.presence.efforts.length, 20, "the source view is immutable to status projection");
});
