import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageState } from "@earendil-works/pi-durable";
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentCacheShare, agentContextBar, agentFactsLine, formatCost } from "./agent-footer.ts";
import { row, theme } from "./dashboard-test-fixture.mts";

const info = { name: "Example model", reasoning: true, contextWindow: 1000 };
const usage = (input: number, cacheRead: number, cacheWrite: number) => ({
	input,
	output: 20,
	cacheRead,
	cacheWrite,
	totalTokens: input + cacheRead + cacheWrite + 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
it("cache share includes every model call and excludes tools", () => {
	assert.deepEqual(
		agentCacheShare({
			models: { main: usage(100, 300, 100), summary: usage(100, 400, 0) },
			tools: { nested: usage(10000, 0, 0) },
		}),
		{ percent: 70, read: true },
	);
	assert.deepEqual(agentCacheShare({ models: { main: usage(10, 0, 90) }, tools: {} }), { percent: 0, read: false });
	for (const value of [
		undefined,
		{ models: {}, tools: {} },
		{ models: { main: usage(10, 0, 0) }, tools: {} },
		{ models: { main: usage(Number.NaN, 1, 0) }, tools: {} },
	] as (UsageState | undefined)[])
		assert.equal(agentCacheShare(value), undefined);
});
it("context bar keeps ten cells, display bands, zero and overflow", () => {
	for (const [percent, expected, color] of [
		[0, "░░░░░░░░░░ 0%", "success"],
		[56, "██████░░░░ 56%", "success"],
		[60, "██████░░░░ 60%", "success"],
		[61, "██████░░░░ 61%", "warning"],
		[80, "████████░░ 80%", "warning"],
		[81, "████████░░ 81%", "error"],
		[120, "██████████ 120%", "error"],
	] as const) {
		const colors: string[] = [];
		assert.equal(
			agentContextBar(percent, {
				fg: (key, text) => {
					colors.push(key);
					return text;
				},
			}),
			expected,
		);
		assert.deepEqual(colors, [color, "dim", color]);
	}
});
it("the facts row uses the provider/model route and reasoning capability, with no placeholders", () => {
	assert.equal(
		agentFactsLine(
			row(),
			140,
			theme,
			560,
			info,
			{ models: { main: usage(10, 990, 0) }, tools: {} },
			"main",
			"/srv/example",
		),
		"test/model [high] │ ██████░░░░ 56% │ 560/1.0k │ ~$0.42 │ ● 99% hit │ /work (main)",
	);
	assert.equal(
		agentFactsLine(row(), 140, theme, undefined, { ...info, reasoning: false }),
		"test/model │ ~$0.42 │ /work",
	);
	assert.equal(agentFactsLine(row("unknown", { model: undefined, cost: Number.NaN }), 80, theme), "/work");
	assert.equal(agentFactsLine(row(), 140, theme, 0, info).includes("0/1.0k"), true);
});
it("elapsed stays absent without a placed-run start, not inferred from activity or turn duration", () => {
	const known = row("one", { modifiedAt: 12345678, durationMs: 3665000 });
	assert.equal(agentFactsLine(known, 140, theme), "test/model │ ~$0.42 │ /work");
});
it("the facts row sheds cache, tokens, folder and cost in order before truncation", () => {
	const selected = row("one", { cwd: "/srv/example/work/a-long-component/target-app" });
	const state = { models: { main: usage(10, 990, 0) }, tools: {} };
	const render = (width: number) => agentFactsLine(selected, width, theme, 560, info, state, "main", "/srv/example");
	const stable = "test/model [high] │ ██████░░░░ 56%";
	const withCost = `${stable} │ ~$0.42`;
	const folder = "~/work/a-long-component/target-app (main)";
	const full = render(140);
	assert.equal(full, `${stable} │ 560/1.0k │ ~$0.42 │ ● 99% hit │ ${folder}`);
	const noRate = render(visibleWidth(full) - 1);
	assert.equal(noRate, `${stable} │ 560/1.0k │ ~$0.42 │ ● │ ${folder}`);
	const noDot = render(visibleWidth(noRate) - 1);
	assert.equal(noDot, `${stable} │ 560/1.0k │ ~$0.42 │ ${folder}`);
	const noTokens = render(visibleWidth(noDot) - 1);
	assert.equal(noTokens, `${withCost} │ ${folder}`);
	const minimum = visibleWidth(withCost) + 3 + 16;
	const shortFolder = render(minimum);
	assert.equal(visibleWidth(shortFolder), minimum);
	assert.ok(shortFolder.startsWith(`${withCost} │ …`), shortFolder);
	assert.match(shortFolder, /target-app/);
	assert.equal(render(minimum - 1), withCost);
	assert.equal(render(visibleWidth(withCost) - 1), stable);
	assert.equal(stripVTControlCharacters(render(8)), "test/mo…");
});
it("project labels shorten from the left and keep the branch without delegate figures", () => {
	const selected = row("one", { cwd: "/srv/example/work/long/project", model: undefined, cost: Number.NaN });
	assert.equal(
		agentFactsLine(selected, 140, theme, undefined, info, undefined, "main", "/srv/example"),
		"~/work/long/project (main)",
	);
	const narrow = agentFactsLine(selected, 24, theme, undefined, info, undefined, "main", "/srv/example");
	assert.match(narrow, /….*project \(main\)/);
	for (const width of [1, 5, 20, 60, 140]) {
		const line = agentFactsLine(
			row("one", { cwd: "/srv/example/work/long/project" }),
			width,
			theme,
			560,
			info,
			undefined,
			"long-branch",
		);
		assert.ok(visibleWidth(line) <= width);
		assert.doesNotMatch(line, /agents:/u);
	}
});
it("labels contain no controls, Unicode clipping respects width and costs omit half-cent estimates", () => {
	for (const width of [40, 80, 140]) {
		const text = agentFactsLine(
			row("one", {
				cwd: "/work/界",
				model: { provider: "test", modelId: `\x1b[8m${"界".repeat(100)}\x1b[0m\n`, thinkingLevel: "high" },
			}),
			width,
			theme,
			560,
			{ ...info, name: `\x1b[8m${"界".repeat(100)}\x1b[0m\n` },
			undefined,
			"\x1b]0;title\x07main",
		);
		assert.ok(visibleWidth(text) <= width);
		assert.doesNotMatch(text, /\x1b\[8m|\x1b\]|title/);
		assert.match(stripVTControlCharacters(text), /界/);
	}
	assert.doesNotMatch(agentFactsLine(row("one", { cost: 0.004 }), 100, theme), /\$/);
	assert.equal(formatCost(undefined), "$?");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1, true), "$1.00+");
	assert.equal(formatCost(1), "$1.00");
	assert.equal(formatCost(undefined, true), "$?");
});
