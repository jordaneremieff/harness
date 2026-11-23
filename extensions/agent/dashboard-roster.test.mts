import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	attentionReason,
	coverageText,
	dashboardRecords,
	dashboardText,
	groupRows,
	modelLabel,
	ROSTER_ROWS,
	readableError,
	recoveryHint,
	rosterGroup,
	rosterLines,
	rosterRowCount,
	rosterTotals,
} from "./dashboard-roster.ts";
import { coverage as rosterCoverage, row, theme } from "./dashboard-test-fixture.mts";
import { mergeAgentCoverage } from "./dashboard-types.ts";

const dimTheme = Object.assign(Object.create(theme), {
	fg: (tone: string, text: string) => (tone === "dim" ? `\x1b[90m${text}\x1b[39m` : text),
}) as typeof theme;

for (const [width, height] of [
	[38, 36],
	[80, 8],
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
	assert.equal(selected.length, 3, "three painted lines; the spacing line below stays plain");
	assert.ok(selected.every((line) => line.endsWith("\x1b[0m")));
});

it("merges one current inventory scan and one latest projection per retained storage", () => {
	const inventory = {
		candidates: 4,
		inspected: 4,
		unreadable: 1,
		unknownClaims: 0,
		returned: 2,
		remaining: 0,
		priorityRemaining: 0,
		remainingRows: 0,
		priorityRemainingRows: 0,
		recordByteLimit: 32768,
		claimByteLimit: 16384,
		outputLimit: 2,
	};
	const previous = {
		complete: false,
		storagesVisited: 4,
		skipped: 2,
		omitted: 2,
		nextCursor: "more",
		inventory,
		projections: { a: { skipped: 1, omitted: 2 } },
	};
	const current = {
		complete: false,
		storagesVisited: 4,
		skipped: 2,
		omitted: 3,
		nextCursor: null,
		inventory,
		projections: { a: { skipped: 0, omitted: 0 }, b: { skipped: 1, omitted: 3 } },
	};
	const merged = mergeAgentCoverage(previous, current);
	assert.equal(merged.storagesVisited, 4);
	assert.equal(merged.skipped, 2);
	assert.equal(merged.omitted, 3);
	assert.deepEqual(merged.projections, current.projections);
	assert.equal(previous.projections.a.omitted, 2, "the prior observation is unchanged");
	const raw = { ...inventory, unreadable: 0, unknownClaims: 2 };
	const unresolved = {
		...previous,
		inventory: raw,
		projections: { a: { skipped: 0, omitted: 0, unresolvedClaim: true } },
	};
	const resolved = {
		...current,
		inventory: raw,
		complete: true,
		skipped: 0,
		omitted: 0,
		projections: { b: { skipped: 0, omitted: 0, unresolvedClaim: false } },
	};
	assert.equal(
		mergeAgentCoverage(unresolved, resolved).complete,
		false,
		"a previous selected unknown claim remains unresolved",
	);
	const refreshed = mergeAgentCoverage(unresolved, {
		...resolved,
		projections: { a: { skipped: 0, omitted: 0, unresolvedClaim: false } },
	});
	assert.equal(refreshed.complete, true);
	assert.equal(refreshed.inventory.unknownClaims, 2, "presentation never rewrites raw claim coverage");
});

it("describes continuation as excluded output after the complete priority inventory scan", () => {
	const coverage = rosterCoverage([], { complete: false, storagesVisited: 4, nextCursor: "more" });
	const inventory = {
		candidates: 4,
		inspected: 4,
		unreadable: 0,
		unknownClaims: 0,
		returned: 2,
		remaining: 2,
		priorityRemaining: 1,
		remainingRows: 2,
		priorityRemainingRows: 1,
		recordByteLimit: 32768,
		claimByteLimit: 16384,
		outputLimit: 2,
	};
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
	assert.equal(lines[0]?.trim(), "Working 1 · ~$0.42");
	assert.match(lines[1] ?? "", /◌ starting/);
	assert.match(lines[3] ?? "", /Starting/);
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
		const lines = rosterLines(rows, "unknown", 80, 5, 0, theme);
		assert.equal(lines[0]?.trim(), "Working 3 · ~$1.50+");
		assert.match(lines[1] ?? "", /unknown/);
		assert.match(lines[2] ?? "", /test\/model \[high\]/);
		assert.doesNotMatch(lines.slice(1).join("\n"), /\$|NaN|Infinity/);
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
	const lines = rosterLines(rows, "50", 80, 5, 60000, theme);
	assert.equal(lines.length, 5);
	assert.equal(lines[0]?.trim(), "Working 100 · ~$42.00");
	assert.match(lines[1] ?? "", /▌ ● 界.*…/);
	assert.match(lines[2] ?? "", /test\/model \[high\].*~\$0\.42/);
	assert.match(lines[3] ?? "", /Responding/);
	assert.match(lines[4] ?? "", /↑ 50 · ↓ 49 more/);
	assert.doesNotMatch(lines.join("\n"), /ago/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});
it("only settled names show a dim relative age when the roster has at least 24 columns", () => {
	for (const state of ["working", "starting", "idle", "done", "stopped"] as const) {
		const rows = [row("one", { state, modifiedAt: 0 })];
		for (const width of [23, 24, 64]) {
			for (const [now, age] of [
				[1000, "just now"],
				[3700000, "1h ago"],
			] as const) {
				const lines = rosterLines(rows, undefined, width, 5, now, dimTheme);
				assert.match(lines[2] ?? "", /test\/model \[high\]/);
				const name = lines[1] ?? "";
				if (width >= 24 && state !== "working" && state !== "starting")
					assert.ok(name.endsWith(`\x1b[90m${age}\x1b[39m`), name);
				else assert.doesNotMatch(name, /just now|ago/);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			}
		}
	}
});
it("sections show their counts with one blank separator and variable row heights", () => {
	const now = 2 * 86400000;
	const rows = groupRows(
		[
			row("work"),
			row("failure", { state: "failed", error: "failure", modifiedAt: now }),
			row("today", { state: "done", modifiedAt: now }),
			row("earlier", { state: "done", modifiedAt: 0 }),
		],
		now,
	);
	const hits: Array<[string, number, number]> = [];
	const lines = rosterLines(rows, "earlier", 64, 16, now, theme, {
		row: (item, line, height) => hits.push([item.id, line, height]),
	});
	assert.equal(ROSTER_ROWS, 2);
	assert.equal(lines[0]?.trim(), "Working 1 · ~$0.42");
	assert.equal(lines[4], "");
	assert.equal(lines[5]?.trim(), "Recent 2 · ~$0.84");
	assert.equal(lines[11], "");
	assert.equal(lines[12]?.trim(), "Earlier 1 · ~$0.42");
	assert.deepEqual(hits, [
		["work", 1, 3],
		["failure", 6, 3],
		["today", 9, 2],
		["earlier", 13, 2],
	]);
	assert.match(lines[13] ?? "", /▌ ✓ earlier/);
	assert.doesNotMatch(lines.join("\n"), /agents|with errors|failure.*failure/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 64));
});
it("a time-like name stays an ordinary roster name", () => {
	const lines = rosterLines([row("one", { name: "Updated fake" })], "one", 80, 5, 0, theme);
	assert.match(lines[1] ?? "", /Updated fake/);
	assert.match(lines[2] ?? "", /test\/model \[high\]/);
	assert.equal(lines[4]?.trim(), "");
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
	const profile = {
		identity: "expert",
		handle: "@history",
		role: "Review operator decisions",
		revision: "one",
		hasExpertise: true,
		updatedAt: 0,
	};
	const expert = row("expert", { name: "History", firstMessage: "One old task", profile });
	const handleOnly = row("handle", { name: undefined, firstMessage: "One old task", profile });
	for (const [width, height] of [
		[38, 18],
		[80, 5],
		[120, 24],
	] as const) {
		const lines = rosterLines([expert], expert.id, width, height, 0, theme);
		assert.match(lines.join("\n"), /History/);
		assert.doesNotMatch(lines.join("\n"), /@history · History/, "one label, not the handle and name pair");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /test\/model \[high\]/);
		assert.doesNotMatch(lines.join("\n"), /One old task/);
	}
	assert.match(rosterLines([handleOnly], handleOnly.id, 80, 10, 0, theme).join("\n"), /@history/);
	for (const query of ["@history", "operator decisions", "History", "old task"])
		assert.equal(dashboardRecords({ observedAt: 0, sessions: [expert] }, query).length, 1);
	const historical = row("plain", { name: undefined, firstMessage: "Original request" });
	assert.match(dashboardText({ observedAt: 0, sessions: [historical] }), /“Original request”/);
});

it("roster names carry no provenance tag and keep bold emphasis", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "muted" ? 90 : 37}m${text}\x1b[39m`;
	colored.bold = (text) => `\x1b[1m${text}\x1b[22m`;
	{
		const lines = rosterLines(
			[row("other", { storageId: "other", name: "Recipient", creatingOwnerId: "peer" })],
			"other",
			60,
			20,
			0,
			colored,
		);
		const title = lines.find((line) => line.includes("Recipient"));
		assert.ok(title);
		assert.ok(title.includes("\x1b[1m\x1b[37mRecipient"), "the name stays bold");
		assert.equal(
			lines.some((line) => line.includes("[other]")),
			false,
			"no tag for work another session created",
		);
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	}
});

it("provider errors read as plain words", () => {
	assert.equal(
		readableError('429: {"code":"1308","message":"Usage limit reached for 5 hour."}'),
		"429 Usage limit reached for 5 hour.",
	);
	assert.equal(readableError('{"error":{"message":"Overloaded"}}'), "Overloaded");
	assert.equal(readableError("plain failure"), "plain failure");
	assert.equal(readableError("400: {not json}"), "400: {not json}");
	assert.equal(
		readableError('xai API error (403): 403 "No credits available'),
		"xai API error 403: No credits available",
	);
	assert.equal(
		attentionReason(row("x", { state: "failed", error: '429: {"message":"Usage limit"}' })),
		"429 Usage limit",
	);
});

it("roster errors colour the state mark and reason without an error-count footer", () => {
	const colored = Object.create(theme) as typeof theme;
	colored.fg = (color, text) => `\x1b[${color === "warning" ? 33 : color === "error" ? 31 : 37}m${text}\x1b[39m`;
	const lines = rosterLines(
		[row("failed", { state: "failed", error: "429 Usage limit reached" })],
		undefined,
		80,
		10,
		0,
		colored,
	);
	assert.ok(lines[1]?.includes("\x1b[33m!"));
	assert.match(lines[2] ?? "", /test\/model/);
	assert.match(lines[3] ?? "", /\x1b\[33m429 Usage limit reached/);
	assert.equal(visibleWidth(lines.at(-1) ?? ""), 0);
	const fault = rosterLines(
		[row("host", { state: "idle", health: { lastError: "Host fault sentinel" } })],
		undefined,
		80,
		10,
		0,
		colored,
	);
	assert.ok(fault[1]?.includes("\x1b[31m○"));
	assert.match(fault[3] ?? "", /\x1b\[31mHost error: Host fault sentinel/);
});
it("grouped agents appear once and their hit areas include every activity or error row", () => {
	const now = 2 * 86400000;
	const rows = groupRows(
		[
			row("work", { name: "UniqueWork", currentTool: { name: "read", argument: "private-file" } }),
			row("done", { name: "UniqueDone", state: "done", modifiedAt: now, latestReply: "Result ready" }),
			row("failed", { name: "UniqueFailed", state: "failed", error: "quota limit" }),
		],
		now,
	);
	{
		const hits: Array<[string, number, number]> = [];
		const lines = rosterLines(rows, "failed", 100, 15, now, theme, {
			row: (item, line, height) => hits.push([item.id, line, height]),
		});
		assert.deepEqual(hits, [
			["work", 1, 3],
			["done", 6, 2],
			["failed", 10, 3],
		]);
		for (const item of rows) {
			assert.ok(item.name);
			assert.equal(lines.filter((line) => line.includes(item.name ?? "")).length, 1);
		}
		assert.deepEqual(rows.map(rosterRowCount), [3, 2, 3]);
		assert.match(lines[3] ?? "", /read private-file/);
		assert.match(lines[12] ?? "", /quota limit/);
		assert.doesNotMatch(lines.join("\n"), /Result ready|Responding/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 100));
	}
});
it("the compact strip keeps its two-row entries when the same roster renders with full heights", () => {
	const rows = [row("active", { currentTool: { name: "read", argument: "work.md" } })];
	const hits: number[] = [];
	const render = (compact: boolean) =>
		rosterLines(rows, "active", 80, 6, 0, theme, { compact, row: (_, _line, height) => hits.push(height) }).join("\n");
	const full = render(false);
	assert.match(full, /read work\.md/);
	const compact = render(true);
	assert.match(compact, /● active[^\n]*\n[^\n]*test\/model/);
	assert.doesNotMatch(compact, /read work\.md/);
	assert.equal(render(false), full);
	assert.deepEqual(hits, [3, 2, 3]);
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
	const rows = [
		row("first", { modifiedAt: 1 }),
		row("second", { modifiedAt: 2 }),
		row("recent", { state: "idle", modifiedAt: now }),
		row("earlier", { state: "done", modifiedAt: 0 }),
	];
	const ids = (items: typeof rows) => groupRows(items, now).map((item) => item.id);
	assert.deepEqual(ids(rows), ["first", "second", "recent", "earlier"]);
	assert.deepEqual(ids(rows.map((item) => (item.id === "second" ? { ...item, modifiedAt: now } : item))), [
		"first",
		"second",
		"recent",
		"earlier",
	]);
	assert.deepEqual(
		ids(rows.map((item) => (item.id === "first" ? { ...item, state: "done", modifiedAt: now } : item))),
		["second", "first", "recent", "earlier"],
	);
});
it("model labels preserve provider identity and a supported thinking level", () => {
	assert.equal(modelLabel(row(), theme, 60), "test/model [high]");
	assert.equal(
		modelLabel(row(), theme, 60, () => false),
		"test/model",
	);
	assert.equal(modelLabel(row("unknown", { model: undefined }), theme, 60), "model unknown");
	assert.equal(
		modelLabel(row("invalid", { model: { provider: "test", modelId: "model", thinkingLevel: "invalid" } }), theme, 60),
		"test/model",
	);
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const item = row("one", { model: { provider: "provider", modelId: "long-model-identity", thinkingLevel: level } });
		const label = modelLabel(item, theme, 20);
		assert.ok(label.endsWith(` [${level}]`));
		assert.match(label, /…/);
		assert.ok(visibleWidth(label) <= 20);
	}
});

it("recovery hints name the supported next action without asking a working agent to change models", () => {
	assert.equal(
		recoveryHint(row("provider", { state: "failed", attention: "provider-blocked" })),
		"Configure another model, then send a message",
	);
	assert.equal(
		recoveryHint(row("task", { state: "idle", attention: "task-blocked" })),
		"Open Tasks to inspect the blocked task",
	);
	assert.equal(
		recoveryHint(row("unavailable", { owner: "unavailable", state: "unavailable" })),
		"Reconnect starts the host when the storage is readable",
	);
	assert.equal(
		recoveryHint(row("health", { state: "idle", health: { lastError: "Host error" } })),
		"Reconnect starts the host; unfinished work resumes",
	);
	assert.equal(recoveryHint(row("failed", { state: "failed", error: "boom" })), "A new message runs the work again");
	assert.equal(recoveryHint(row("working", { attention: "provider-blocked" })), undefined);
	assert.equal(recoveryHint(row("idle", { state: "idle", latestReply: "Ready" })), undefined);
});

it("a scheduled provider retry remains working activity rather than a reconnect fault", () => {
	const retrying = row("retry", {
		health: { autoRetry: { attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "Rate limit" } },
	});
	const snapshot = { observedAt: 0, sessions: [retrying] };
	assert.equal(attentionReason(retrying), undefined);
	assert.equal(recoveryHint(retrying), undefined);
	assert.match(rosterTotals(snapshot), /^1 working · \$/u);
	assert.match(rosterLines([retrying], "retry", 80, 10, 0, theme).join("\n"), /Provider retry scheduled.*Rate limit/u);
});

it("a complete roster footer has no totals, costs or retired error controls", () => {
	const rows = groupRows([row("ok"), row("bad", { state: "failed", error: "quota limit" })], 0);
	const lines = rosterLines(rows, "ok", 80, 14, 0, theme);
	assert.equal(lines.at(-1)?.trim(), "");
	assert.doesNotMatch(lines.join("\n"), /with errors|errors only|loaded|retained/);
});

it("the footer names hidden rows above or below the window", () => {
	const rows = Array.from({ length: 10 }, (_, index) => row(String(index)));
	assert.match(rosterLines(rows, "0", 80, 8, 0, theme).at(-1) ?? "", /↓ 8 more/);
	assert.match(rosterLines(rows, "5", 80, 8, 0, theme).at(-1) ?? "", /↑ 4 · ↓ 4 more/);
	assert.match(rosterLines(rows, "9", 80, 8, 0, theme).at(-1) ?? "", /↑ 8 more/);
});

it("the model row shows a dim right-aligned cost only when the whole model fits beside it", () => {
	const model = "test/model [high]";
	const normal = row("one", { state: "idle", cost: 1.42 });
	const width = 4 + visibleWidth(model) + 2 + visibleWidth("~$1.42");
	const modelRow = (agent: ReturnType<typeof row>, columns = width) =>
		rosterLines([agent], undefined, columns, 7, 0, dimTheme)[2] ?? "";
	const full = modelRow(normal);
	assert.match(full, /test\/model \[high\] {2}\x1b\[90m~\$1\.42\x1b\[39m$/);
	assert.equal(visibleWidth(full), width);
	const noRoomForCost = modelRow(normal, width - 1);
	assert.match(noRoomForCost, /test\/model \[high\]/);
	assert.doesNotMatch(noRoomForCost, /\$/);
	const shortModel = modelRow(normal, 4 + visibleWidth(model) - 1);
	assert.match(shortModel, /…/);
	assert.doesNotMatch(shortModel, /\$/);
	assert.match(modelRow({ ...normal, partial: true }, width + 1), /~\$1\.42\+/);
	assert.match(modelRow({ ...normal, cost: 0.005 }), /~\$0\.01/);
	for (const cost of [0.0049, Number.NaN, Number.POSITIVE_INFINITY])
		assert.doesNotMatch(modelRow({ ...normal, cost }), /\$/);
});

it("section headings total all loaded costs and mark missing or partial estimates", () => {
	const recent = (id: string, cost: number, partial = false) => row(id, { state: "idle", cost, partial });
	const working = row("separate", { cost: 9 });
	const screen = (rows: ReturnType<typeof row>[], height = 20) =>
		rosterLines(rows, undefined, 38, height, 0, theme).join("\n");
	const known = [recent("one", 1.42), recent("two", 2.78), working];
	assert.match(screen(known), /Recent 2 · ~\$4\.20\s*\n/);
	assert.match(screen(known), /Working 1 · ~\$9\.00\s*\n/);
	const recentHeading = rosterLines(known, undefined, 38, 20, 0, dimTheme).find((line) => line.includes("Recent"));
	assert.match(recentHeading ?? "", /\x1b\[90m · ~\$4\.20\x1b\[39m$/);
	assert.match(screen([recent("one", 1.42, true), recent("two", 2.78)]), /Recent 2 · ~\$4\.20\+/);
	assert.match(screen([...known, recent("unknown", Number.NaN)]), /Recent 3 · ~\$4\.20\+/);
	assert.match(screen([recent("one", 0.0049), recent("unknown", Number.NaN)]), /Recent 2\s*\n/);
	assert.match(screen(known.slice(0, 2), 4), /Recent 2 · ~\$4\.20/);
	assert.doesNotMatch(
		screen(known.slice(0, 2), 4),
		/○ two/,
		"a hidden loaded agent still contributes to its section total",
	);
});
