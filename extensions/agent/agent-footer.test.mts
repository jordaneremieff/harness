import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageState } from "@earendil-works/pi-durable";
import { agentStatusLines, agentContextBar, agentCacheShare, formatCost } from "./agent-footer.ts";
import { row, theme } from "./dashboard-test-fixture.mts";
const info = { name: "Example model", reasoning: true, contextWindow: 1000 };
const usage = (input: number, cacheRead: number, cacheWrite: number) => ({ input, output: 20, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
it("cache share includes every model call and excludes tools", () => {
	assert.deepEqual(agentCacheShare({ models: { main: usage(100, 300, 100), summary: usage(100, 400, 0) }, tools: { nested: usage(10000, 0, 0) } }), { percent: 70, read: true });
	assert.deepEqual(agentCacheShare({ models: { main: usage(10, 0, 90) }, tools: {} }), { percent: 0, read: false });
	for (const value of [undefined, { models: {}, tools: {} }, { models: { main: usage(10, 0, 0) }, tools: {} }, { models: { main: usage(Number.NaN, 1, 0) }, tools: {} }] as (UsageState | undefined)[]) assert.equal(agentCacheShare(value), undefined);
});
it("context bar keeps ten cells, display bands, zero and overflow", () => {
	for (const [percent, expected, color] of [[0, "░░░░░░░░░░ 0%", "success"], [56, "██████░░░░ 56%", "success"], [60, "██████░░░░ 60%", "success"], [61, "██████░░░░ 61%", "warning"], [80, "████████░░ 80%", "warning"], [81, "████████░░ 81%", "error"], [120, "██████████ 120%", "error"]] as const) {
		const colors: string[] = [];
		assert.equal(agentContextBar(percent, { fg: (key, text) => { colors.push(key); return text; } }), expected);
		assert.deepEqual(colors, [color, "dim", color]);
	}
});
it("status lines use registry display name and reasoning capability, with no placeholders", () => {
	assert.deepEqual(agentStatusLines(row(), 140, theme, 560, info, { models: { main: usage(10, 990, 0) }, tools: {} }, "main", undefined, "/home/example"), ["Example model [high] │ ██████░░░░ 56% │ 560/1.0k │ ~$0.42 │ ● 99% hit", "/work (main)"]);
	assert.match(agentStatusLines(row(), 140, theme, undefined, { ...info, reasoning: false })[0], /^Example model │ ~\$0.42$/);
	assert.deepEqual(agentStatusLines(row("unknown", { model: undefined, cost: Number.NaN }), 80, theme), ["", "/work"]);
	assert.equal(agentStatusLines(row(), 140, theme, 0, info)[0].includes("0/1.0k"), true);
});
it("elapsed stays absent without a placed-run start, not inferred from activity or turn duration", () => {
	const known = row("one", { modifiedAt: 12345678, durationMs: 3665000 });
	assert.equal(agentStatusLines(known, 140, theme)[0], "model │ ~$0.42");
});
it("narrow metrics shed rate then dot then tokens then cost and preserve model and context", () => {
	const state = { models: { main: usage(10, 990, 0) }, tools: {} };
	const full = agentStatusLines(row(), 140, theme, 560, info, state)[0];
	const noRate = agentStatusLines(row(), visibleWidth(full) - 1, theme, 560, info, state)[0];
	assert.doesNotMatch(noRate, /hit/); assert.match(noRate, /●/);
	const noDot = agentStatusLines(row(), visibleWidth(noRate) - 1, theme, 560, info, state)[0];
	assert.doesNotMatch(noDot, /●|hit/); assert.match(noDot, /560\/1.0k/);
	const noTokens = agentStatusLines(row(), visibleWidth(noDot) - 1, theme, 560, info, state)[0];
	assert.doesNotMatch(noTokens, /560\/1.0k/); assert.match(noTokens, /~\$0.42/);
	const minimal = agentStatusLines(row(), visibleWidth(noTokens) - 1, theme, 560, info, state)[0];
	assert.doesNotMatch(minimal, /\$/); assert.match(minimal, /Example model \[high\] │ ██████░░░░ 56%/);
});
it("project labels shorten from the left and keep branch and own child facts when possible", () => {
	const selected = row("one", { cwd: "/home/example/work/long/project" });
	const children = { active: 2, total: 4, cost: 9.5, incomplete: true };
	assert.equal(agentStatusLines(selected, 140, theme, undefined, info, undefined, "main", children, "/home/example")[1], "~/work/long/project (main) │ agents: 2/4+ active · ~$9.50");
	const narrow = agentStatusLines(selected, 48, theme, undefined, info, undefined, "main", children, "/home/example")[1];
	assert.match(narrow, /….*project \(main\)/);
	assert.match(narrow, /agents: 2\/4\+/);
	for (const width of [1, 5, 20, 60, 140]) assert.ok(agentStatusLines(selected, width, theme, 560, info, undefined, "long-branch", children).every((line) => visibleWidth(line) <= width));
});
it("labels contain no controls, Unicode clipping respects width and costs omit half-cent estimates", () => {
	for (const width of [40, 80, 140]) {
		const text = agentStatusLines(row("one", { cwd: "/work/界" }), width, theme, 560, { ...info, name: `\x1b[8m${"界".repeat(100)}\x1b[0m\n` }, undefined, "\x1b]0;title\x07main");
		assert.ok(text.every((line) => visibleWidth(line) <= width));
		assert.doesNotMatch(text.join("\n"), /\x1b\[8m|\x1b\]|title/);
		assert.match(stripVTControlCharacters(text[0]), /界/);
	}
	assert.doesNotMatch(agentStatusLines(row("one", { cost: 0.004 }), 100, theme)[0], /\$/);
	assert.equal(formatCost(undefined), "$?"); assert.equal(formatCost(0), "$0.00"); assert.equal(formatCost(1, true), "$1.00+"); assert.equal(formatCost(1), "$1.00"); assert.equal(formatCost(undefined, true), "$?");
});
