import assert from "node:assert/strict";
import { it } from "node:test";
import { buildStatusOverview, STATUS_OVERVIEW_BYTE_LIMIT } from "./status-overview.ts";
import { StatusToolOutputSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";
import type { EffortAwareness } from "./effort-awareness.ts";

function awareness(): EffortAwareness {
	return {
		self: { id: "primary", cwd: "/work", observedPurpose: { source: "interactive-input", text: "Review parser" } },
		presence: { efforts: [], coverage: { visited: 0, unreadable: 0, dead: 0, unrelated: 0, omitted: 0, complete: true, reasons: [] }, limits: { visits: 256, results: 20, bytes: 16384 } },
		threads: { items: [], coverage: { visited: 0, records: 0, unreadable: 0, missingHints: 0, omittedHints: 0, omittedResults: 0, unvisited: false, complete: true, reasons: [] }, limits: { visits: 256, results: 12, bytes: 8192, hintsPerRecord: 8 } },
	};
}
const page = { rows: [], coverage: { complete: true, storagesVisited: 0, skipped: 0, omitted: 0, nextCursor: null }, observedAt: "2026-01-01T00:00:00.000Z" };

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
	const result = buildStatusOverview({ ...page, rows: [{ id: "active", storageId: "active", cwd: "/work", modifiedAt: 1, owner: "here", state: "working", cost: 0, partial: false }] }, [], [], source);
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
