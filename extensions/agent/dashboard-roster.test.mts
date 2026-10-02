import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { dashboardRecords, dashboardText, rosterLines, coverageText } from "./dashboard-roster.ts";
import { row, theme } from "./dashboard-test-fixture.mts";
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
