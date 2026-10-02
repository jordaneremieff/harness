import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { dashboardRecords, dashboardText, rosterLines, coverageText, rosterTotals } from "./dashboard-roster.ts";
import { row, theme } from "./dashboard-test-fixture.mts";
for (const [width, height, compact] of [
	[38, 36, false],
	[80, 4, true],
] as const) {
	it(`truncated roster keeps focus and neighbors and states hidden rows at ${width}`, () => {
		const rows = Array.from({ length: 100 }, (_, index) => row(String(index), { name: `Agent${index}` }));
		for (const selected of [0, 50, 99]) {
			const lines = rosterLines(rows, String(selected), width, height, 0, theme, compact);
			const text = lines.join("\n");
			assert.match(text, new RegExp(`› Agent${selected}`));
			assert.match(text, /\+\d+ more/);
			if (selected > 0) assert.match(text, new RegExp(`Agent${selected - 1}`));
			if (selected < 99) assert.match(text, new RegExp(`Agent${selected + 1}`));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});
}
it("starting agents show their launch state in the Working group", () => {
	const starting = row("starting", { state: "starting", owner: "unknown" });
	const snapshot = { observedAt: 0, sessions: [row("done", { state: "done" }), starting] };
	assert.equal(dashboardRecords(snapshot, "")[0]?.id, starting.id);
	assert.match(rosterLines([starting], starting.id, 80, 10, 0, theme, false).join("\n"), /Working[\s\S]*Starting/);
	assert.equal(rosterTotals(snapshot), "1 working · $0.84 retained");
	assert.match(dashboardText(snapshot), /◌ Starting/);
	assert.doesNotMatch(dashboardText(snapshot), /Starting · stored/);
});
it("unknown row costs stay unknown and totals retain the known lower bound", () => {
	for (const unknown of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const rows = [
			row("known", { cost: 1 }),
			row("partial", { cost: 0.5, partial: true }),
			row("unknown", { cost: unknown }),
		];
		const snapshot = { observedAt: 0, sessions: rows };
		assert.match(rosterLines(rows, "unknown", 80, 4, 0, theme, true).join("\n"), /unknown.*\$\?/);
		assert.equal(rosterTotals(snapshot), "3 working · ≥$1.50 retained");
		assert.doesNotMatch(dashboardText(snapshot), /NaN|Infinity/);
		assert.equal(
			rosterTotals({ observedAt: 0, sessions: [row("unknown", { cost: unknown })] }),
			"1 working · ≥$0.00 retained",
		);
	}
});
it("incomplete roster coverage qualifies a known subtotal", () => {
	assert.equal(
		rosterTotals({
			observedAt: 0,
			sessions: [row()],
			coverage: { complete: false, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: "more" },
		}),
		"1 working · ≥$0.42 retained",
	);
});
it("roster order separates working, attention, and retained results", () => {
	const rows = [
		row("done", { state: "done" }),
		row("failed", { state: "failed", error: "failure" }),
		row("working"),
		row("stopped", { state: "stopped" }),
	];
	assert.deepEqual(
		dashboardRecords({ observedAt: 0, sessions: rows }, "").map((item) => item.id),
		["working", "failed", "done", "stopped"],
	);
	assert.deepEqual(dashboardRecords({ observedAt: 0, sessions: rows }, "test model").length, 4);
	assert.match(dashboardText({ observedAt: 0, sessions: rows }), /\$0.42/);
});
it("narrow roster includes selection, cost, state, age, and shown coverage", () => {
	const rows = Array.from({ length: 100 }, (_, index) => row(String(index), { name: "界".repeat(100) }));
	const lines = rosterLines(rows, "50", 80, 4, 60000, theme, true);
	assert.equal(lines.length, 4);
	assert.ok(lines.some((line) => line.startsWith("›")));
	assert.match(lines.join("\n"), /Working.*\$0.42.*1m/);
	assert.match(lines[3], /3 of 100 loaded agents shown/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});
it("duplicate titles receive distinct shortest suffixes and coverage remains explicit", () => {
	const rows = [row("same-prefix-one", { name: "Audit" }), row("same-prefix-two", { name: "Audit" })];
	const lines = rosterLines(rows, rows[0].id, 38, 10, 0, theme, false);
	assert.match(lines.join("\n"), /Audit -one/);
	assert.match(lines.join("\n"), /Audit -two/);
	assert.match(
		coverageText({ complete: false, storagesVisited: 2, skipped: 1, omitted: 2, nextCursor: "more" }),
		/skipped.*not loaded.*more inventory/,
	);
});
