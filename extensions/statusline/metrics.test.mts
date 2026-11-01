import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyMetrics, MetricsCache, scanSession, type SessionEntryLike } from "./metrics.ts";

function assistant(usage: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}): SessionEntryLike {
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

describe("metrics cache", () => {
	it("bounds catch-up and preserves all branches and standalone usage", () => {
		const entries: Array<SessionEntryLike & { id: string; parentId: string | null }> = [];
		let leaf: string | null = null, scans = 0, pointReads = 0;
		const source = {
			getEntries: () => { scans += 1; return entries; },
			getLeafId: () => leaf,
			getEntry: (id: string) => { pointReads += 1; return entries.find((entry) => entry.id === id); },
		};
		const append = (entry: SessionEntryLike) => { const id = String(entries.length); entries.push({ ...entry, id, parentId: leaf }); leaf = id; };
		append(assistant({ cost: 1, cacheWrite: 10 }));
		const cache = new MetricsCache(); cache.reset(source);
		for (let index = 0; index < 600; index += 1) append(assistant({ cost: 0.125, cacheRead: index === 599 ? 10 : 0 }));
		assert.equal(cache.refresh(source), false); assert.equal(pointReads, 256);
		assert.equal(cache.refresh(source), false); assert.equal(pointReads, 512);
		assert.equal(cache.refresh(source), true); assert.equal(pointReads, 600);
		assert.equal(scans, 1);
		assert.deepEqual(cache.value, scanSession(entries));
		for (let frame = 0; frame < 100; frame += 1) assert.equal(cache.refresh(source), true);
		assert.equal(pointReads, 600); assert.equal(scans, 1);
		leaf = "0"; cache.reset(source);
		append({ type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.75 } } });
		assert.equal(cache.refresh(source), true);
		assert.deepEqual(cache.value, scanSession(entries));
		assert.equal(cache.value.lastTurnCacheHit, true);
	});
});

describe("scanSession", () => {
	it("returns zeros for an empty session", () => {
		assert.deepEqual(scanSession([]), emptyMetrics());
	});

	it("ignores non-message entries and non-assistant messages", () => {
		const entries: SessionEntryLike[] = [
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

	it("includes every usage-bearing entry in cost without changing assistant cache statistics", () => {
		const usage = { input: 50, output: 1, cacheRead: 900, cacheWrite: 0, cost: { total: 0.25 } };
		const baseline = assistant({ input: 100, output: 10, cacheWrite: 50, cost: 1 });
		const result = scanSession([baseline,
			{ type: "usage", usage },
			{ type: "compaction", usage },
			{ type: "branch_summary", usage },
			{ type: "message", message: { role: "toolResult", usage } },
			{ type: "custom", usage },
			{ type: "message", message: { role: "user", usage } },
		]);
		assert.deepEqual(result, { ...scanSession([baseline]), cost: 2 });
		assert.equal(result.lastTurnCacheHit, false, "background cache reads must not replace the assistant write-only indicator");
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
