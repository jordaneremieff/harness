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
			assert.match(text, new RegExp(`▌ ● Agent${selected}`));
			assert.match(text, /[↑↓↕] \d+ more/);
			if (selected > 0) assert.match(text, new RegExp(`Agent${selected - 1}`));
			if (selected < 99) assert.match(text, new RegExp(`Agent${selected + 1}`));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});
}
it("selected exact-time blocks close their styles before the adjacent pane", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
	const lines = rosterLines([row("one", { name: "Recipient" })], "one", 29, 10, 0, colored, false, { exactTime: true });
	const selected = lines.filter((line) => line.includes("▌"));
	assert.equal(selected.length, 4);
	assert.ok(selected.every((line) => line.endsWith("\x1b[0m")));
});

it("starting agents show their launch state without a group header", () => {
	const starting = row("starting", { state: "starting", owner: "unknown" });
	const snapshot = { observedAt: 0, sessions: [row("done", { state: "done" }), { ...starting, modifiedAt: 1 }] };
	assert.equal(dashboardRecords(snapshot, "")[0]?.id, starting.id);
	assert.match(rosterLines([starting], starting.id, 80, 10, 0, theme, false).join("\n"), /◌ starting[\s\S]*Starting agent/);
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
		assert.equal(rosterTotals(snapshot), "3 working · $1.50+ retained");
		assert.doesNotMatch(dashboardText(snapshot), /NaN|Infinity/);
		assert.equal(
			rosterTotals({ observedAt: 0, sessions: [row("unknown", { cost: unknown })] }),
			"1 working · $0.00+ retained",
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
		"1 working · $0.42+ retained",
	);
});
it("roster order follows recent activity across states and breaks ties by identity", () => {
	const rows = [
		row("done", { state: "done", modifiedAt: 4 }),
		row("failed", { state: "failed", error: "failure", modifiedAt: 1 }),
		row("working", { modifiedAt: 2 }),
		row("stopped", { state: "stopped", modifiedAt: 2 }),
	];
	assert.deepEqual(
		dashboardRecords({ observedAt: 0, sessions: rows }, "").map((item) => item.id),
		["done", "stopped", "working", "failed"],
	);
	assert.deepEqual(dashboardRecords({ observedAt: 0, sessions: rows }, "test model").length, 4);
	assert.match(dashboardText({ observedAt: 0, sessions: rows }), /\$0.42/);
});
it("narrow roster includes selection, cost, state, last-change time, and shown coverage", () => {
	const rows = Array.from({ length: 100 }, (_, index) => row(String(index), { name: "界".repeat(100) }));
	const lines = rosterLines(rows, "50", 80, 4, 60000, theme, true);
	assert.equal(lines.length, 4);
	assert.ok(lines.some((line) => line.startsWith("▌")));
	assert.match(lines.join("\n"), /Responding.*\$0.42.*1m ago/);
	assert.match(lines[3], /↕ 97 more/);
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
it("wide roster budgets flat blocks and timestamps before it clips the selected row", () => {
	const now = new Date(2026, 9, 3, 12).getTime();
	const rows = [
		row("work"),
		row("failure", { state: "failed", error: "failure" }),
		row("today", { state: "done", modifiedAt: now }),
		row("yesterday", { state: "done", modifiedAt: now - 86400000 }),
		row("earlier", { state: "done", modifiedAt: 0 }),
	];
	const lines = rosterLines(rows, "earlier", 64, 18, now, theme, false);
	assert.match(lines.join("\n"), /▌ ✓ earlier/);
	assert.match(lines.join("\n"), /yesterday/);
	assert.match(lines.join("\n"), /5 loaded/);
	assert.equal(lines.filter((line) => /\$0.42/.test(line)).length, 5);
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
		if (!compact) assert.match(lines.join("\n"), /model high/);
		assert.doesNotMatch(lines.join("\n"), /One old task/);
	}
	for (const query of ["@history", "operator decisions", "History", "old task"]) assert.equal(dashboardRecords({ observedAt: 0, sessions: [expert] }, query).length, 1);
	const historical = row("plain", { name: undefined, firstMessage: "Original request" });
	assert.match(dashboardText({ observedAt: 0, sessions: [historical] }), /Historical: Original request/);
});

it("creating-session provenance stays muted while roster names retain bold emphasis", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "muted" ? 90 : 37}m${text}\x1b[39m`;
	colored.bold = (text) => `\x1b[1m${text}\x1b[22m`;
	for (const compact of [false, true]) {
		const lines = rosterLines([row("other", { name: "Recipient", creatingOwnerId: "peer" })], "other", 60, 20, 0, colored, compact, { primaryId: "primary" });
		const title = lines.find((line) => line.includes("[other]"));
		assert.ok(title);
		assert.ok(title.includes("\x1b[90m[other] \x1b[39m\x1b[1m"));
		assert.ok(title.indexOf("[other]") < title.indexOf("\x1b[1m"));
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	}
});

it("flat roster keeps model second, failure text third, and hit areas on each block", () => {
	const rows = [row("work"), row("done", { state: "done", latestReply: "Result ready" }), row("failed", { state: "failed", error: "quota limit" })];
	for (const compact of [false, true]) {
		const hits: Array<[string, number, number]> = [];
		const times: Array<[string, number]> = [];
		const lines = rosterLines(rows, "failed", 100, 15, 0, theme, compact, { row: (item, line, height) => hits.push([item.id, line, height]), timestamp: (item, line) => times.push([item.id, line]) });
		assert.deepEqual(hits, rows.map((item, index) => [item.id, index * (compact ? 1 : 3), compact ? 1 : 3]));
		assert.deepEqual(times, rows.map((item, index) => [item.id, index * (compact ? 1 : 3)]));
		assert.doesNotMatch(lines.join("\n"), /Working ·|Attention ·|Today ·|Yesterday ·|Earlier ·|Work failed:|model_error/);
		assert.match(lines.join("\n"), /quota limit/);
		if (!compact) {
			assert.match(lines[7], /model high/);
			assert.match(lines[8], /quota limit/);
		}
	}
});
