import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyMetrics, scanSession, type BranchEntryLike } from "./metrics.ts";

function assistant(usage: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}): BranchEntryLike {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				cost: { total: usage.cost ?? 0 },
			},
		},
	};
}

describe("scanSession", () => {
	it("returns zeros for an empty branch", () => {
		assert.deepEqual(scanSession([]), emptyMetrics());
	});

	it("ignores non-message entries and non-assistant messages", () => {
		const entries: BranchEntryLike[] = [
			{ type: "compaction" },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } }, // no usage yet (aborted)
			assistant({ input: 5, cost: 0.01 }),
		];
		const m = scanSession(entries);
		assert.equal(m.inputTokens, 5);
		assert.equal(m.cost, 0.01);
		assert.equal(m.sawCacheUsage, false);
		assert.equal(m.lastTurnCacheHit, null);
	});

	it("sums tokens, cost, and cache across assistant turns", () => {
		const m = scanSession([
			assistant({ input: 100, output: 10, cacheRead: 50, cacheWrite: 20, cost: 0.5 }),
			assistant({ input: 200, output: 20, cacheRead: 70, cacheWrite: 0, cost: 0.25 }),
		]);
		assert.equal(m.inputTokens, 300);
		assert.equal(m.outputTokens, 30);
		assert.equal(m.cost, 0.75);
		assert.equal(m.cacheRead, 120);
		assert.equal(m.cacheWrite, 20);
	});

	it("tracks the last cache-active turn's hit outcome, unaffected by cache-free turns", () => {
		const hitThenIdle = scanSession([assistant({ cacheRead: 5 }), assistant({ input: 5 })]);
		assert.equal(hitThenIdle.lastTurnCacheHit, true);
		const writeOnlyLast = scanSession([assistant({ cacheRead: 5 }), assistant({ cacheWrite: 5 })]);
		assert.equal(writeOnlyLast.lastTurnCacheHit, false);
		const none = scanSession([assistant({ input: 5 })]);
		assert.equal(none.sawCacheUsage, false);
		assert.equal(none.lastTurnCacheHit, null);
	});
});
