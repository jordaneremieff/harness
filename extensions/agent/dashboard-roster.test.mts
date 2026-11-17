import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { attentionReason, dashboardRecords, dashboardText, readableError, recoveryHint, rosterLines, coverageText, rosterTotals, groupRows, rosterGroup, modelLabel, ROSTER_ROWS } from "./dashboard-roster.ts";
import { row, theme, coverage as rosterCoverage } from "./dashboard-test-fixture.mts";
import { mergeAgentCoverage } from "./dashboard-types.ts";
for (const [width, height] of [
	[38, 36],
	[80, 4],
] as const) {
	it(`truncated roster keeps focus and neighbors and states hidden rows at ${width}`, () => {
		const rows = Array.from({ length: 100 }, (_, index) => row(String(index), { name: `Agent${index}` }));
		for (const selected of [0, 50, 99]) {
			const lines = rosterLines(rows, String(selected), width, height, 0, theme);
			const text = lines.join("\n");
			assert.match(text, new RegExp(`▌ ● Agent${selected}`));
			assert.match(text, /[↑↓↕] \d+ more/);
			if (height > 4 && selected > 0) assert.match(text, new RegExp(`Agent${selected - 1}`));
			if (height > 4 && selected === 0) assert.match(text, /Agent1/);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	});
}
it("selected roster blocks close their styles before the adjacent pane", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
	const lines = rosterLines([row("one", { name: "Recipient" })], "one", 29, 10, 0, colored);
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
	const raw = { ...inventory, unreadable: 0, unknownClaims: 2 };
	const unresolved = { ...previous, inventory: raw, projections: { a: { skipped: 0, omitted: 0, unresolvedClaim: true } } };
	const resolved = { ...current, inventory: raw, complete: true, skipped: 0, omitted: 0, projections: { b: { skipped: 0, omitted: 0, unresolvedClaim: false } } };
	assert.equal(mergeAgentCoverage(unresolved, resolved).complete, false, "a previous selected unknown claim remains unresolved");
	const refreshed = mergeAgentCoverage(unresolved, { ...resolved, projections: { a: { skipped: 0, omitted: 0, unresolvedClaim: false } } });
	assert.equal(refreshed.complete, true);
	assert.equal(refreshed.inventory.unknownClaims, 2, "presentation never rewrites raw claim coverage");
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

it("starting agents appear under the Working heading", () => {
	const starting = row("starting", { state: "starting", owner: "unknown" });
	const snapshot = { observedAt: 0, sessions: [row("done", { state: "done" }), { ...starting, modifiedAt: 1 }] };
	assert.equal(dashboardRecords(snapshot, "")[0]?.id, starting.id);
	const lines = rosterLines([starting], starting.id, 80, 10, 0, theme);
	assert.equal(lines[0]?.trim(), "Working 1");
	assert.match(lines[1] ?? "", /◌ starting/);
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
		const lines = rosterLines(rows, "unknown", 80, 4, 0, theme);
		assert.match(lines[1] ?? "", /unknown/);
		assert.match(lines[2] ?? "", /test\/model \[high\]/);
		assert.doesNotMatch(lines.join("\n"), /\$|NaN|Infinity/);
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
it("a narrow strip truncates the name above its model and states hidden rows", () => {
	const rows = Array.from({ length: 100 }, (_, index) => row(String(index), { name: "界".repeat(100) }));
	const lines = rosterLines(rows, "50", 80, 4, 60000, theme);
	assert.equal(lines.length, 4);
	assert.equal(lines[0]?.trim(), "Working 100");
	assert.match(lines[1] ?? "", /▌ ● 界.*…/);
	assert.match(lines[2] ?? "", /test\/model \[high\]/);
	assert.match(lines[3] ?? "", /↑ 50 · ↓ 49 more/);
	assert.doesNotMatch(lines.join("\n"), /ago|Responding|\$/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});
it("roster rows omit times for active and settled agents", () => {
	const at = new Date(2026, 9, 3, 13, 24).getTime();
	for (const state of ["working", "starting", "idle", "done", "stopped"] as const) {
		const rows = [row("one", { state, modifiedAt: at })];
		for (const [width, height] of [[64, 12], [60, 4], [80, 4]] as const) {
			for (const now of [at + 1000, at + 3700000]) {
				const lines = rosterLines(rows, "one", width, height, now, theme);
				assert.match(lines.join("\n"), /test\/model \[high\]/);
				assert.doesNotMatch(lines.join("\n"), /just now|ago|Oct 3|Updated|2026/);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			}
		}
	}
});
it("sections show their counts with one blank separator and two rows per agent", () => {
	const now = 2 * 86400000;
	const rows = groupRows([row("work"), row("failure", { state: "failed", error: "failure", modifiedAt: now }), row("today", { state: "done", modifiedAt: now }), row("earlier", { state: "done", modifiedAt: 0 })], now);
	const hits: Array<[string, number, number]> = [];
	const lines = rosterLines(rows, "earlier", 64, 16, now, theme, { row: (item, line, height) => hits.push([item.id, line, height]) });
	assert.equal(ROSTER_ROWS, 2);
	assert.equal(lines[0]?.trim(), "Working 1");
	assert.equal(lines[3], "");
	assert.equal(lines[4]?.trim(), "Recent 2");
	assert.equal(lines[9], "");
	assert.equal(lines[10]?.trim(), "Earlier 1");
	assert.deepEqual(hits, [["work", 1, 2], ["failure", 5, 2], ["today", 7, 2], ["earlier", 11, 2]]);
	assert.match(lines[11] ?? "", /▌ ✓ earlier/);
	assert.doesNotMatch(lines.join("\n"), /agents|with errors|failure.*failure|\$/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 64));
});
it("a time-like name stays an ordinary roster name", () => {
	const lines = rosterLines([row("one", { name: "Updated fake" })], "one", 80, 4, 0, theme);
	assert.match(lines[1] ?? "", /Updated fake/);
	assert.match(lines[2] ?? "", /test\/model \[high\]/);
	assert.equal(lines[3]?.trim(), "");
});

it("duplicate titles receive distinct shortest suffixes and coverage remains explicit", () => {
	const rows = [row("same-prefix-one", { name: "Audit" }), row("same-prefix-two", { name: "Audit" })];
	const lines = rosterLines(rows, rows[0].id, 38, 12, 0, theme);
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
	for (const [width, height] of [[38, 18], [80, 4], [120, 24]] as const) {
		const lines = rosterLines([expert], expert.id, width, height, 0, theme);
		assert.match(lines.join("\n"), /History/);
		assert.doesNotMatch(lines.join("\n"), /@history · History/, "one label, not the handle and name pair");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /test\/model \[high\]/);
		assert.doesNotMatch(lines.join("\n"), /One old task/);
	}
	assert.match(rosterLines([handleOnly], handleOnly.id, 80, 10, 0, theme).join("\n"), /@history/);
	for (const query of ["@history", "operator decisions", "History", "old task"]) assert.equal(dashboardRecords({ observedAt: 0, sessions: [expert] }, query).length, 1);
	const historical = row("plain", { name: undefined, firstMessage: "Original request" });
	assert.match(dashboardText({ observedAt: 0, sessions: [historical] }), /“Original request”/);
});

it("roster names carry no provenance tag and keep bold emphasis", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "muted" ? 90 : 37}m${text}\x1b[39m`;
	colored.bold = (text) => `\x1b[1m${text}\x1b[22m`;
	{
		const lines = rosterLines([row("other", { storageId: "other", name: "Recipient", creatingOwnerId: "peer" })], "other", 60, 20, 0, colored);
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

it("failed rows colour their mark without a reason, cost or error-count footer", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "warning" ? 33 : color === "error" ? 31 : 37}m${text}\x1b[39m`;
	const lines = rosterLines([row("failed", { state: "failed", error: "429 Usage limit reached" })], undefined, 80, 10, 0, colored);
	assert.ok(lines[1]?.includes("\x1b[33m!"));
	assert.match(lines[2] ?? "", /test\/model/);
	assert.doesNotMatch(lines.join("\n"), /429|Usage limit|with errors|\$/);
	const fault = rosterLines([row("host", { state: "idle", health: { lastError: "Host fault sentinel" } })], undefined, 80, 10, 0, colored);
	assert.ok(fault[1]?.includes("\x1b[31m○"));
	assert.doesNotMatch(fault.join("\n"), /Host fault sentinel/);
});
it("grouped rows appear once with two-row hit areas and no activity previews", () => {
	const now = 2 * 86400000;
	const rows = groupRows([row("work", { name: "UniqueWork", currentTool: { name: "read", argument: "private-file" } }), row("done", { name: "UniqueDone", state: "done", modifiedAt: now, latestReply: "Result ready" }), row("failed", { name: "UniqueFailed", state: "failed", error: "quota limit" })], now);
	{
		const hits: Array<[string, number, number]> = [];
		const lines = rosterLines(rows, "failed", 100, 15, now, theme, { row: (item, line, height) => hits.push([item.id, line, height]) });
		assert.deepEqual(hits, [["work", 1, 2], ["done", 5, 2], ["failed", 9, 2]]);
		for (const item of rows) {
			assert.ok(item.name);
			assert.equal(lines.filter((line) => line.includes(item.name ?? "")).length, 1);
		}
		for (const [, , height] of hits) assert.equal(height, ROSTER_ROWS);
		assert.doesNotMatch(lines.join("\n"), /private-file|Result ready|quota limit|Responding|\$|ago/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 100));
	}
});
it("section membership uses active state and the last-day boundary", () => {
	const now = 2 * 86400000;
	assert.equal(rosterGroup(row("work", { modifiedAt: 0 }), now), "working");
	assert.equal(rosterGroup(row("start", { state: "starting", modifiedAt: 0 }), now), "working");
	assert.equal(rosterGroup(row("recent", { state: "idle", modifiedAt: now - 86400000 + 1 }), now), "recent");
	assert.equal(rosterGroup(row("earlier", { state: "done", modifiedAt: now - 86400000 }), now), "earlier");
});
it("grouping preserves section order across refreshes and moves changed states", () => {
	const now = 2 * 86400000;
	const rows = [row("first", { modifiedAt: 1 }), row("second", { modifiedAt: 2 }), row("recent", { state: "idle", modifiedAt: now }), row("earlier", { state: "done", modifiedAt: 0 })];
	const ids = (items: typeof rows) => groupRows(items, now).map((item) => item.id);
	assert.deepEqual(ids(rows), ["first", "second", "recent", "earlier"]);
	assert.deepEqual(ids(rows.map((item) => item.id === "second" ? { ...item, modifiedAt: now } : item)), ["first", "second", "recent", "earlier"]);
	assert.deepEqual(ids(rows.map((item) => item.id === "first" ? { ...item, state: "done", modifiedAt: now } : item)), ["second", "first", "recent", "earlier"]);
});
it("model labels preserve provider identity and a supported thinking level", () => {
	assert.equal(modelLabel(row(), theme, 60), "test/model [high]");
	assert.equal(modelLabel(row(), theme, 60, () => false), "test/model");
	assert.equal(modelLabel(row("unknown", { model: undefined }), theme, 60), "model unknown");
	assert.equal(modelLabel(row("invalid", { model: { provider: "test", modelId: "model", thinkingLevel: "invalid" } }), theme, 60), "test/model");
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const item = row("one", { model: { provider: "provider", modelId: "long-model-identity", thinkingLevel: level } });
		const label = modelLabel(item, theme, 20);
		assert.ok(label.endsWith(` [${level}]`));
		assert.match(label, /…/);
		assert.ok(visibleWidth(label) <= 20);
	}
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

it("a complete roster footer has no totals, costs or retired error controls", () => {
	const rows = groupRows([row("ok"), row("bad", { state: "failed", error: "quota limit" })], 0);
	const lines = rosterLines(rows, "ok", 80, 14, 0, theme);
	assert.equal(lines.at(-1)?.trim(), "");
	assert.doesNotMatch(lines.join("\n"), /with errors|errors only|loaded|retained|\$/);
});

it("the footer names hidden rows above or below the window", () => {
	const rows = Array.from({ length: 10 }, (_, index) => row(String(index)));
	assert.match(rosterLines(rows, "0", 80, 7, 0, theme).at(-1) ?? "", /↓ 8 more/);
	assert.match(rosterLines(rows, "5", 80, 7, 0, theme).at(-1) ?? "", /↑ 4 · ↓ 4 more/);
	assert.match(rosterLines(rows, "9", 80, 7, 0, theme).at(-1) ?? "", /↑ 8 more/);
});
