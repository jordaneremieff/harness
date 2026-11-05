import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { attentionReason, dashboardRecords, dashboardText, readableError, recoveryHint, rosterDetail, rosterLines, coverageText, rosterTotals } from "./dashboard-roster.ts";
import { row, theme, coverage as rosterCoverage } from "./dashboard-test-fixture.mts";
import { mergeAgentCoverage } from "./dashboard-types.ts";
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
			if (!compact && selected > 0) assert.match(text, new RegExp(`Agent${selected - 1}`));
			if (!compact && selected < 99) assert.match(text, new RegExp(`Agent${selected + 1}`));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});
}
it("selected exact-time blocks close their styles before the adjacent pane", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
	const lines = rosterLines([row("one", { name: "Recipient" })], "one", 29, 10, 0, colored, false, { exactTime: true });
	const selected = lines.filter((line) => line.includes("▌"));
	assert.equal(selected.length, 2, "two painted lines; the spacing line below stays plain");
	assert.ok(selected.every((line) => line.endsWith("\x1b[0m")));
});

it("merges one current inventory scan and one latest projection per retained storage", () => {
	const inventory = { candidates: 4, inspected: 4, unreadable: 1, unknownClaims: 0, returned: 2, remaining: 0, priorityRemaining: 0,
		remainingRows: 0, priorityRemainingRows: 0, recordByteLimit: 32768, claimByteLimit: 16384, outputLimit: 2 };
	const previous = { complete: false, storagesVisited: 4, skipped: 2, omitted: 2, nextCursor: "more", inventory,
		projections: { a: { skipped: 1, omitted: 2 } } };
	const current = { complete: false, storagesVisited: 4, skipped: 2, omitted: 3, nextCursor: null, inventory,
		projections: { a: { skipped: 0, omitted: 0 }, b: { skipped: 1, omitted: 3 } } };
	const merged = mergeAgentCoverage(previous, current);
	assert.equal(merged.storagesVisited, 4);
	assert.equal(merged.skipped, 2);
	assert.equal(merged.omitted, 3);
	assert.deepEqual(merged.projections, current.projections);
	assert.equal(previous.projections.a.omitted, 2, "the prior observation is unchanged");
});

it("describes continuation as excluded output after the complete priority inventory scan", () => {
	const coverage = rosterCoverage([], { complete: false, storagesVisited: 4, nextCursor: "more" });
	const inventory = { candidates: 4, inspected: 4, unreadable: 0, unknownClaims: 0, returned: 2, remaining: 2, priorityRemaining: 1,
		remainingRows: 2, priorityRemainingRows: 1, recordByteLimit: 32768, claimByteLimit: 16384, outputLimit: 2 };
	const text = coverageText({ ...coverage, inventory });
	assert.match(text, /4\/4 catalog records inspected/);
	assert.match(text, /more records to load/);
	assert.doesNotMatch(text, /more inventory to inspect/);
});

it("starting agents show their launch state without a group header", () => {
	const starting = row("starting", { state: "starting", owner: "unknown" });
	const snapshot = { observedAt: 0, sessions: [row("done", { state: "done" }), { ...starting, modifiedAt: 1 }] };
	assert.equal(dashboardRecords(snapshot, "")[0]?.id, starting.id);
	assert.match(rosterLines([starting], starting.id, 80, 10, 0, theme, false).join("\n"), /◌ starting/);
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
		const lines = rosterLines(rows, "unknown", 80, 4, 0, theme, true);
		assert.match(lines[0] ?? "", /unknown/);
		assert.match(lines[1] ?? "", /\$\?/);
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
			coverage: rosterCoverage([row()], { complete: false, nextCursor: "more" }),
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
it("a narrow strip wraps a long title and states the rows hidden above and below", () => {
	const rows = Array.from({ length: 100 }, (_, index) => row(String(index), { name: "界".repeat(100) }));
	const lines = rosterLines(rows, "50", 80, 4, 60000, theme, true);
	assert.equal(lines.length, 4);
	assert.ok(lines.some((line) => line.startsWith("▌")));
	assert.match(lines[0] ?? "", /1m ago/, "the time keeps the title row");
	assert.match(lines[1] ?? "", /界/, "the title continues on the second row");
	assert.match(lines[2] ?? "", /Responding · model high · \$0.42/);
	assert.match(lines[3] ?? "", /↑ 50 · ↓ 49 more/);
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
	const text = lines.join("\n");
	assert.match(text, /▌ ✓ earlier/);
	assert.match(text, /yesterday/);
	assert.match(text, /5 agents · 1 with errors/);
	assert.equal(lines.filter((line) => /\$0.42/.test(line)).length, 4, "the failed row states its reason instead of a cost");
	assert.match(lines[4] ?? "", /failure/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 64));
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
		coverageText(rosterCoverage(rows, { complete: false, skipped: 1, omitted: 2, nextCursor: "more" })),
		/skipped.*not loaded.*more records/,
	);
});
it("roster titles use the name, then the handle, ahead of the historical first input", () => {
	const profile = { identity: "expert", handle: "@history", role: "Review operator decisions", revision: "one", hasExpertise: true, updatedAt: 0 };
	const expert = row("expert", { name: "History", firstMessage: "One old task", profile });
	const handleOnly = row("handle", { name: undefined, firstMessage: "One old task", profile });
	for (const [width, height, compact] of [[38, 18, false], [80, 4, true], [120, 24, false]] as const) {
		const lines = rosterLines([expert], expert.id, width, height, 0, theme, compact);
		assert.match(lines.join("\n"), /History/);
		assert.doesNotMatch(lines.join("\n"), /@history · History/, "one label, not the handle and name pair");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (!compact) assert.match(lines.join("\n"), /model high/);
		assert.doesNotMatch(lines.join("\n"), /One old task/);
	}
	assert.match(rosterLines([handleOnly], handleOnly.id, 80, 10, 0, theme, false).join("\n"), /@history/);
	for (const query of ["@history", "operator decisions", "History", "old task"]) assert.equal(dashboardRecords({ observedAt: 0, sessions: [expert] }, query).length, 1);
	const historical = row("plain", { name: undefined, firstMessage: "Original request" });
	assert.match(dashboardText({ observedAt: 0, sessions: [historical] }), /“Original request”/);
});

it("roster names carry no provenance tag and keep bold emphasis", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "muted" ? 90 : 37}m${text}\x1b[39m`;
	colored.bold = (text) => `\x1b[1m${text}\x1b[22m`;
	for (const compact of [false, true]) {
		const lines = rosterLines([row("other", { storageId: "other", name: "Recipient", creatingOwnerId: "peer" })], "other", 60, 20, 0, colored, compact, { primaryId: "primary" });
		const title = lines.find((line) => line.includes("Recipient"));
		assert.ok(title);
		assert.ok(title.includes("\x1b[1m\x1b[37mRecipient"), "the name stays bold");
		assert.equal(lines.some((line) => line.includes("[other]")), false, "no tag for work another session created");
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	}
});

it("provider errors read as plain words", () => {
	assert.equal(readableError('429: {"code":"1308","message":"Usage limit reached for 5 hour."}'), "429 Usage limit reached for 5 hour.");
	assert.equal(readableError('{"error":{"message":"Overloaded"}}'), "Overloaded");
	assert.equal(readableError("plain failure"), "plain failure");
	assert.equal(readableError("400: {not json}"), "400: {not json}");
	assert.equal(readableError('xai API error (403): 403 "No credits available'), "xai API error 403: No credits available");
	assert.equal(attentionReason(row("x", { state: "failed", error: '429: {"message":"Usage limit"}' })), "429 Usage limit");
});

it("a failed row states its reason in warning colour and the footer counts errors", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "muted" ? 90 : color === "warning" ? 33 : color === "error" ? 31 : 37}m${text}\x1b[39m`;
	const lines = rosterLines([row("failed", { state: "failed", error: "429 Usage limit reached" })], undefined, 80, 10, 0, colored, false);
	assert.match(lines[0] ?? "", /!/);
	assert.match(lines[1] ?? "", /429 Usage limit reached/);
	assert.ok((lines[1] ?? "").includes("\x1b[33m429"), "a finished run's reason uses warning colour");
	assert.match(lines[3] ?? "", /1 agent · 1 with errors/);
});

it("a host fault marks its reason as an error rather than a finished run", () => {
	assert.deepEqual(rosterDetail(row("now", { state: "idle", health: { lastError: "Host error marker" } })), { text: "Host error: Host error marker", color: "error" });
});

it("flat roster states each row's facts and keeps hit areas on each block", () => {
	const rows = [row("work"), row("done", { state: "done", latestReply: "Result ready" }), row("failed", { state: "failed", error: "quota limit" })];
	for (const compact of [false, true]) {
		const hits: Array<[string, number, number]> = [];
		const times: Array<[string, number]> = [];
		const lines = rosterLines(rows, "failed", 100, 15, 0, theme, compact, { row: (item, line, height) => hits.push([item.id, line, height]), timestamp: (item, line) => times.push([item.id, line]) });
		assert.deepEqual(hits, rows.map((item, index) => [item.id, index * 3, 3]));
		assert.deepEqual(times, rows.map((item, index) => [item.id, index * 3]));
		assert.doesNotMatch(lines.join("\n"), /Working ·|Attention ·|Today ·|Yesterday ·|Earlier ·|Work failed:|model_error/);
		assert.match(lines[1] ?? "", /Responding · model high · \$0.42/);
		assert.match(lines[4] ?? "", /model high · \$0.42/);
		assert.match(lines[7] ?? "", /quota limit/);
		assert.equal(lines[8]?.trim(), "", "a spacing line follows each block");
	}
});

for (const exactTime of [false, true]) {
	it(`flat mixed-state rows appear once and keep their height with exact time ${exactTime}`, () => {
		const now = new Date(2026, 9, 5, 13, 41).getTime();
		const rows = dashboardRecords({ observedAt: now, sessions: [
			row("alpha", { name: "UniqueAlpha", modifiedAt: now, state: "working" }),
			row("bravo", { name: "UniqueBravo", modifiedAt: now - 1000, state: "failed", error: "quota limit" }),
			row("charlie", { name: "UniqueCharlie", modifiedAt: now - 2000, state: "working" }),
			row("delta", { name: "UniqueDelta", modifiedAt: now - 3000, state: "done", latestReply: "Result ready" }),
			row("echo", { name: "UniqueEcho", modifiedAt: now - 4000, state: "starting" }),
		] }, "");
		for (const compact of [false, true]) {
			const shown = compact ? rows.slice(0, 1) : rows;
			const hits: Array<[string, number, number]> = [];
			const timeHits: Array<[string, number]> = [];
			const lines = rosterLines(shown, "alpha", 80, compact ? 4 : 16, now, theme, compact, { exactTime, row: (item, line, height) => hits.push([item.id, line, height]), timestamp: (item, line) => timeHits.push([item.id, line]) });
			assert.equal(lines.length, compact ? 4 : 16);
			for (const item of shown) {
				const name = item.name;
				assert.ok(name);
				assert.equal(lines.filter((line) => line.includes(name)).length, 1, item.id);
			}
			assert.deepEqual(hits, shown.map((item, index) => [item.id, index * 3, 3]));
			assert.deepEqual(timeHits, shown.map((item, index) => [item.id, index * 3 + (exactTime ? 1 : 0)]));
			assert.ok(lines.every((line) => visibleWidth(line) <= 80));
			assert.doesNotMatch(lines.join("\n"), /Working ·|Attention ·|Today ·/);
			if (exactTime) assert.match(lines[1], /Oct 5, 2026, 1:41 PM/);
		}
	});
}

it("rosterDetail names a working agent's tool, an idle row's facts and a reason's first sentence", () => {
	assert.deepEqual(rosterDetail(row("work", { currentTool: { name: "read", argument: "notes.md" } })), { text: "read notes.md · model high · $0.42", color: "muted" });
	assert.deepEqual(rosterDetail(row("idle", { state: "idle", latestReply: "Result ready" })), { text: "model high · $0.42", color: "muted" });
	assert.deepEqual(rosterDetail(row("failed", { state: "failed", error: "429 Usage limit reached. Try again later." })), { text: "429 Usage limit reached.", color: "warning" });
});

it("recovery hints name the supported next action and never a working row", () => {
	assert.equal(recoveryHint(row("provider", { state: "failed", attention: "provider-blocked" })), "Configure another model, then send a message");
	assert.equal(recoveryHint(row("task", { state: "idle", attention: "task-blocked" })), "The host must repair a blocked task; Reconnect starts it");
	assert.equal(recoveryHint(row("unavailable", { owner: "unavailable", state: "unavailable" })), "Reconnect starts the host when the storage is readable");
	assert.equal(recoveryHint(row("health", { state: "idle", health: { lastError: "Host error" } })), "Reconnect starts the host; unfinished work resumes");
	assert.equal(recoveryHint(row("failed", { state: "failed", error: "boom" })), "A new message runs the work again");
	assert.equal(recoveryHint(row("working", { attention: "provider-blocked" })), undefined);
	assert.equal(recoveryHint(row("idle", { state: "idle", latestReply: "Ready" })), undefined);
});

it("the list's error count names its column and reads errors only under the filter", () => {
	const rows = [row("ok", { modifiedAt: 2 }), row("bad", { state: "failed", error: "quota limit", modifiedAt: 1 })];
	const controls: Array<{ line: number; x: number; width: number }> = [];
	const lines = rosterLines(rows, "ok", 80, 14, 0, theme, false, { errors: (line, x, width) => controls.push({ line, x, width }) });
	assert.match(lines[6] ?? "", /2 agents · 1 with errors/);
	assert.deepEqual(controls, [{ line: 6, x: 11, width: 13 }], "the control starts after the counts and covers the label");
	const filtered: Array<{ line: number; x: number; width: number }> = [];
	const only = rosterLines(rows, "bad", 80, 14, 0, theme, false, { errorsOnly: true, errors: (line, x, width) => filtered.push({ line, x, width }) });
	assert.match(only[6] ?? "", /2 with errors · errors only/);
	assert.deepEqual(filtered, [{ line: 6, x: 16, width: 11 }], "the filter state owns its own label");
});

it("the footer names hidden rows above or below the window", () => {
	const rows = Array.from({ length: 10 }, (_, index) => row(String(index)));
	assert.match(rosterLines(rows, "0", 80, 7, 0, theme, false).at(-1) ?? "", /↓ 8 more/);
	assert.match(rosterLines(rows, "5", 80, 7, 0, theme, false).at(-1) ?? "", /↑ 4 · ↓ 4 more/);
	assert.match(rosterLines(rows, "9", 80, 7, 0, theme, false).at(-1) ?? "", /↑ 8 more/);
});
