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
			assert.match(text, new RegExp(`› ● Agent${selected}`));
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
it("narrow roster includes selection, cost, state, last-change time, and shown coverage", () => {
	const rows = Array.from({ length: 100 }, (_, index) => row(String(index), { name: "界".repeat(100) }));
	const lines = rosterLines(rows, "50", 80, 4, 60000, theme, true);
	assert.equal(lines.length, 4);
	assert.ok(lines.some((line) => line.startsWith("›")));
	assert.match(lines.join("\n"), /Working.*\$0.42.*1m ago/);
	assert.match(lines[3], /3 of 100 loaded agents shown/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});
it("roster ages use coarse minutes and absolute dates stay fixed for every state", () => {
	const at = new Date(2026, 9, 3, 13, 24, 19, 951).getTime();
	for (const state of ["working", "idle", "done", "stopped"] as const) {
		const rows = [row("one", { state, modifiedAt: at })];
		for (const [width, height, compact] of [
			[64, 12, false],
			[60, 4, true],
			[80, 4, true],
		] as const) {
			const first = rosterLines(rows, "one", width, height, at + 1000, theme, compact);
			const later = rosterLines(rows, "one", width, height, at + 3700000, theme, compact);
			assert.match(first.join("\n"), /just now/);
			assert.match(later.join("\n"), /1h ago/);
			assert.ok(first.every((line) => visibleWidth(line) <= width));
			const exact = rosterLines(rows, "one", width, height, at, theme, compact, { exactTime: true });
			assert.match(exact.join("\n"), /Oct 3, 2026, 1:24 PM/);
			assert.doesNotMatch(exact.join("\n"), /Updated|\(local\)|\.951Z/);
		}
	}
});
it("wide roster budgets every group header and timestamp before it clips the selected row", () => {
	const now = new Date(2026, 9, 3, 12).getTime();
	const rows = [
		row("work"),
		row("failure", { state: "failed", error: "failure" }),
		row("today", { state: "done", modifiedAt: now }),
		row("yesterday", { state: "done", modifiedAt: now - 86400000 }),
		row("earlier", { state: "done", modifiedAt: 0 }),
	];
	const lines = rosterLines(rows, "earlier", 64, 18, now, theme, false);
	assert.match(lines.join("\n"), /› ✓ earlier/);
	assert.match(lines.join("\n"), /yesterday/);
	assert.match(lines.join("\n"), /\+1 more/);
	assert.equal(lines.filter((line) => /\$0.42 · /.test(line)).length, 4);
});
it("timestamp hit areas do not use a name that impersonates an Updated label", () => {
	let timeX = -1;
	const lines = rosterLines([row("one", { name: "Updated fake" })], "one", 80, 4, 0, theme, true, {
		timestamp: (_row, _line, x) => {
			timeX = x;
		},
	});
	assert.ok(timeX > 2 + "Updated fake".length);
	assert.match(lines[0] ?? "", /Updated fake/);
});
it("duplicate titles receive distinct shortest suffixes and coverage remains explicit", () => {
	const rows = [row("same-prefix-one", { name: "Audit" }), row("same-prefix-two", { name: "Audit" })];
	const lines = rosterLines(rows, rows[0].id, 38, 12, 0, theme, false);
	assert.match(lines.join("\n"), /Audit -one/);
	assert.match(lines.join("\n"), /Audit -two/);
	assert.match(
		coverageText({ complete: false, storagesVisited: 2, skipped: 1, omitted: 2, nextCursor: "more" }),
		/skipped.*not loaded.*more inventory/,
	);
});
it("roster identifies handles and roles separately from the historical first input", () => {
	const expert = row("expert", { name: "History", firstMessage: "One old task", profile: { identity: "expert", handle: "@history", role: "Review operator decisions", revision: "one", hasExpertise: true, updatedAt: 0 } });
	for (const [width, height, compact] of [[38, 18, false], [80, 4, true], [120, 24, false]] as const) {
		const lines = rosterLines([expert], expert.id, width, height, 0, theme, compact);
		assert.match(lines.join("\n"), /@history/);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (!compact) assert.match(lines.join("\n"), /test\/model high/);
		assert.doesNotMatch(lines.join("\n"), /One old task/);
	}
	for (const query of ["@history", "operator decisions", "History", "old task"]) assert.equal(dashboardRecords({ observedAt: 0, sessions: [expert] }, query).length, 1);
	const historical = row("plain", { name: undefined, firstMessage: "Original request" });
	assert.match(dashboardText({ observedAt: 0, sessions: [historical] }), /Historical: Original request/);
});
