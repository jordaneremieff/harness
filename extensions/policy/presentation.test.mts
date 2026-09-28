import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderProposeCall,
	renderProposeResult,
	renderRulesCall,
	renderRulesResult,
} from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 100) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n").replace(/^\n+/, "");
const raw = (component: { render(width: number): string[] }, width = 1000) => component.render(width).join("\n");
const text = (value: string, details?: unknown) => ({ content: [{ type: "text" as const, text: value }], details });
const collapsed = { expanded: false, isError: false };
const expanded = { expanded: true, isError: false };

function assertFits(component: { render(width: number): string[] }, widths: number[] = [20, 60, 100]): void {
	for (const width of widths)
		assert.ok(
			component.render(width).every((line) => visibleWidth(line) <= width),
			`width ${width}`,
		);
}

describe("policy_rules call cards", () => {
	it("shows the view and id without extra rows for a plain inspection", () => {
		const card = renderRulesCall({ view: "rules" }, theme, collapsed);
		assert.equal(screen(card), "policy_rules · rules");
		const named = renderRulesCall({ view: "rules", id: "local.shell" }, theme, collapsed);
		assert.equal(screen(named), "policy_rules · rules · local.shell");
		assertFits(named);
	});

	it("summarizes a draft check with effect and case count", () => {
		const card = renderRulesCall(
			{ view: "check", draft: { operation: "add", id: "local.file-reader" }, effect: "steer", cases: [{ name: "a" }, { name: "b" }] },
			theme,
			collapsed,
		);
		const lines = screen(card).split("\n");
		assert.equal(lines.length, 2);
		assert.equal(lines[0], "policy_rules · check");
		assert.match(lines[1] ?? "", /draft add local\.file-reader · effect steer · 2 cases · .*[Ee]xpand/);
	});

	it("summarizes a preview request with tool, input keys, and result replay", () => {
		const card = renderRulesCall({ view: "preview", tool: "bash", input: { command: "git push" } }, theme, collapsed);
		assert.match(screen(card), /policy_rules · preview\ntool bash · 1 input key · no result replay/);
		const replay = renderRulesCall(
			{ view: "preview", tool: "bash", input: { command: "x" }, result: { isError: true } },
			theme,
			collapsed,
		);
		assert.match(screen(replay), /result replayed/);
	});

	it("marks a check draft that is still streaming", () => {
		const card = renderRulesCall({ view: "check" }, theme, collapsed);
		assert.match(screen(card), /policy_rules · check\ndraft pending · no cases/);
	});

	it("escapes terminal controls and clips long ids", () => {
		const id = `\u0007${"x".repeat(300)}`;
		const card = renderRulesCall({ view: "explain", id }, theme, collapsed);
		const rendered = screen(card, 1000);
		assert.ok(!rendered.includes("\u0007"));
		assert.match(rendered, /\\x07x{90,}…/);
		assert.ok(!rendered.includes("x".repeat(101)));
		assertFits(card);
	});

	it("shows the complete arguments when expanded", () => {
		const card = renderRulesCall({ view: "data", id: "branch-names" }, theme, expanded);
		assert.match(screen(card, 400), /"view": "data"/);
		assert.match(screen(card, 400), /"id": "branch-names"/);
	});

	it("escapes bidi and C1 controls in collapsed and expanded text", () => {
		const id = "a\u202eb\u009bc";
		const collapsedCard = renderRulesCall({ view: "explain", id }, theme, collapsed);
		assert.ok(!raw(collapsedCard).includes("\u202e"));
		assert.ok(!raw(collapsedCard).includes("\u009b"));
		assert.match(screen(collapsedCard, 1000), /a\\u\{202e\}b\\x9bc/);
		const expandedCard = renderRulesCall({ view: "explain", id }, theme, expanded);
		assert.ok(!raw(expandedCard).includes("\u202e"));
		assert.ok(!raw(expandedCard).includes("\u009b"));
		assert.match(screen(expandedCard, 1000), /\\u\{202e\}/);
	});

	it("renders safely with missing, partial, and malformed arguments", () => {
		for (const value of [undefined, {}, { view: 42 }, { id: null }, [], "rules"]) {
			const card = renderRulesCall(value, theme, collapsed);
			assertFits(card);
			assert.match(screen(card), /^policy_rules/);
		}
	});
});

describe("policy_rules result cards", () => {
	it("summarizes rule and proposal counts for the rules view", () => {
		const card = renderRulesResult(
			text("SESSION CONTEXT\nmodel provider: test", { rules: 3, pending: 1, ruleStoreDegraded: false }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { view: "rules" } },
		);
		const lines = screen(card).split("\n");
		assert.equal(lines[0], "3 rules · 1 pending proposal");
		assert.match(lines[1] ?? "", /[Ee]xpand/);
		assertFits(card);
	});

	it("keeps singular counts grammatical and flags a degraded store", () => {
		const healthy = renderRulesResult(
			text("SESSION CONTEXT", { rules: 1, pending: 0 }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: {} },
		);
		assert.match(screen(healthy), /1 rule · 0 pending proposals/);
		const degraded = renderRulesResult(
			text("SESSION CONTEXT", { rules: 1, pending: 0, ruleStoreDegraded: true }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { view: "rules" } },
		);
		assert.match(screen(degraded), /rule store degraded/);
	});

	it("leads an admitted check with its diagnostics count", () => {
		const output = JSON.stringify({
			check: true,
			admitted: true,
			diagnostics: [{ severity: "warning", message: "scope" }, { severity: "warning", message: "mode" }],
			cases: [],
		});
		const card = renderRulesResult(text(output, { rules: 0, pending: 0 }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { view: "check" },
		});
		assert.match(screen(card), /check: admitted · 2 warnings/);
	});

	it("leads a rejected check with its errors", () => {
		const output = JSON.stringify({
			check: true,
			admitted: false,
			diagnostics: [{ severity: "error", message: "Draft does not satisfy the policy_propose schema" }],
			cases: [],
		});
		const card = renderRulesResult(text(output, { rules: 0, pending: 0 }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { view: "check", draft: { operation: "add" } },
		});
		assert.match(screen(card), /check: not admitted · 1 error/);
	});

	it("leads a preview with the simulated decision and the rules that caused it", () => {
		const denied = JSON.stringify({
			decision: { denied: true, correctedInput: false, resultCorrected: undefined },
			preview: true,
			wouldCorrectInput: false,
			nonMatchingRules: 2,
			input: { matches: ["routing.cat-read"] },
			boundary: "No simulated tool executes.",
		});
		const card = renderRulesResult(text(denied, { rules: 5, pending: 0 }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { view: "preview", tool: "bash" },
		});
		assert.match(screen(card), /^preview: denied by routing\.cat-read · 2 non-matching rules/);
		assert.ok(!screen(card).includes("No simulated tool executes."));

		const allowed = JSON.stringify({ decision: { denied: false, resultCorrected: false }, preview: true, wouldCorrectInput: false, nonMatchingRules: 0, input: { matches: [] } });
		assert.match(screen(renderRulesResult(text(allowed, { rules: 1, pending: 0 }), { expanded: false, isPartial: false }, theme, { ...collapsed, args: { view: "preview" } })), /^preview: allowed/);

		const corrected = JSON.stringify({
			decision: { denied: false, resultCorrected: false },
			preview: true,
			wouldCorrectInput: true,
			nonMatchingRules: 0,
			input: { matches: ["routing.alias"], corrections: [{ id: "routing.alias", stage: "values", path: ["command"] }] },
		});
		assert.match(screen(renderRulesResult(text(corrected, { rules: 1, pending: 0 }), { expanded: false, isPartial: false }, theme, { ...collapsed, args: { view: "preview" } })), /^preview: input corrected by routing\.alias/);

		const resultCorrected = JSON.stringify({ decision: { denied: false, resultCorrected: true }, preview: true, wouldCorrectInput: false, nonMatchingRules: 0, input: { matches: [] } });
		assert.match(screen(renderRulesResult(text(resultCorrected, { rules: 1, pending: 0 }), { expanded: false, isPartial: false }, theme, { ...collapsed, args: { view: "preview" } })), /^preview: result corrected/);
	});

	it("summarizes JSON views by top-level field", () => {
		const health = renderRulesResult(
			text('{\n  "authority": { "status": "ok" },\n  "telemetry": { "status": "ready" },\n  "observations": { "incomplete": 0, "pending": 0 }\n}', { rules: 0, pending: 0 }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { view: "health" } },
		);
		assert.equal(screen(health).split("\n")[0], "authority ok · telemetry ready · observations");
		const catalog = renderRulesResult(
			text('{\n  "source": "bundled starter catalog",\n  "rules": []}', { rules: 0, pending: 0 }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { view: "catalog" } },
		);
		assert.equal(screen(catalog).split("\n")[0], "source · rules");
		const guide = renderRulesResult(text("# Policy authoring guide\n\nUse views.", {}), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { view: "authoring" },
		});
		assert.match(screen(guide), /# Policy authoring guide/);
	});

	it("leads the rules view with the selected rule and keeps a missing-rule message", () => {
		const listing =
			"SESSION CONTEXT\nmodel provider: test\ncwd: /project\nrecord count: 4 | pending proposal count: 0\n\nRULES\nlocal.shell | source=package | purpose=Bound output | state=active | effect=block | note=Use sample.\n  definition: revision=1 state=active effect=block\n\nPENDING PROPOSALS\n(none)";
		const card = renderRulesResult(text(listing, { rules: 4, pending: 0 }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { view: "rules", id: "local.shell" },
		});
		assert.equal(screen(card).split("\n")[0], "local.shell · active · block");
		const missing = renderRulesResult(text("No rule named local.gone.", { rules: 4, pending: 0 }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { view: "rules", id: "local.gone" },
		});
		assert.equal(screen(missing).split("\n")[0], "No rule named local.gone.");
	});

	it("escapes bidi and C1 controls in expanded result text", () => {
		const output = "rule \u202e body \u009b tail";
		const card = renderRulesResult(text(output, { rules: 1, pending: 0 }), { expanded: true, isPartial: false }, theme, {
			...expanded,
			args: { view: "rules" },
		});
		assert.ok(!raw(card).includes("\u202e"));
		assert.ok(!raw(card).includes("\u009b"));
		assert.match(screen(card, 1000), /\\u\{202e\}/);
	});

	it("handles malformed details and truncated check output without throwing", () => {
		const truncated = `${JSON.stringify({ check: true, admitted: true, diagnostics: [{ severity: "warning", message: "x".repeat(100) }] }).slice(0, 60)}\n[policy text truncated]`;
		const card = renderRulesResult(text(truncated, "not-a-record"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { view: "check" },
		});
		assertFits(card);
		assert.match(screen(card), /"check":true/);
	});

	it("shows the full output with a bound marker when expanded", () => {
		const long = `${"line\n".repeat(9000)}end`;
		const card = renderRulesResult(text(long, { rules: 0, pending: 0 }), { expanded: true, isPartial: false }, theme, {
			...expanded,
			args: { view: "rules" },
		});
		const rendered = screen(card, 4000);
		assert.match(rendered, /Display limit\. The full text remains in the native tool history\./);
		assert.ok(!rendered.includes("\nend"));
	});

	it("styles errors and partial results", () => {
		const error = renderRulesResult(text("unknown policy inspection view"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
			args: { view: "nope" },
		});
		assert.equal(screen(error), "policy_rules: unknown policy inspection view");
		const partial = renderRulesResult(text(""), { expanded: true, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Inspecting policy...");
	});
});

describe("policy_propose call cards", () => {
	it("names the operation, rule, authority, and authoring form", () => {
		const card = renderProposeCall(
			{
				operation: "add",
				id: "local.git-push-guard",
				purpose: "Gate pushes.",
				authority: "exact",
				reason: "Operator asked for the gate.",
				note: "Ask before push.",
				match: { command: "git", flags: ["push"] },
			},
			theme,
			collapsed,
		);
		const lines = screen(card).split("\n");
		assert.equal(lines.length, 2);
		assert.equal(lines[0], "policy_propose · add local.git-push-guard");
		assert.match(lines[1] ?? "", /^authority exact · git command match · .*[Ee]xpand .*proposal$/);
		assert.ok(!screen(card).includes("Operator asked for the gate."));
		assertFits(card);
	});

	it("names the cli authoring form and the replaced revision", () => {
		const card = renderProposeCall(
			{
				operation: "replace",
				id: "local.git-push-guard",
				authority: "steer-or-block",
				expectedRevision: "abcdef123456",
				match: { command: "git", cli: { profile: "git", subcommand: ["push"] } },
			},
			theme,
			collapsed,
		);
		assert.match(screen(card), /authority steer-or-block · git push cli match · expected revision abcdef123456/);
	});

	it("names predicate and facts-program forms", () => {
		const predicate = renderProposeCall({ operation: "add", id: "local.reader", authority: "exact", predicate: "routing.cat-read" }, theme, collapsed);
		assert.match(screen(predicate), /predicate routing\.cat-read/);
		const program = renderProposeCall(
			{ operation: "add", id: "local.reader", authority: "exact", program: { phase: "input", when: { op: "exists", path: ["input"] }, action: { kind: "deny" }, onUnavailable: "skip" } },
			theme,
			collapsed,
		);
		assert.match(screen(program), /facts\/v1 program/);
	});

	it("keeps retire and disable cards to a heading and the expansion hint", () => {
		const card = renderProposeCall({ operation: "retire", id: "local.old", reason: "Superseded." }, theme, collapsed);
		const lines = screen(card).split("\n");
		assert.equal(lines.length, 2);
		assert.equal(lines[0], "policy_propose · retire local.old");
		assert.match(lines[1] ?? "", /expand/i);
	});

	it("renders safely with missing and streaming arguments", () => {
		for (const value of [undefined, {}, { operation: 7 }, { id: "x" }, []]) {
			const card = renderProposeCall(value, theme, collapsed);
			assertFits(card);
			assert.match(screen(card), /^policy_propose/);
		}
		const pending = renderProposeCall({ operation: "replace", id: "local.x" }, theme, collapsed);
		assert.match(screen(pending), /expected revision pending/);
	});

	it("shows the complete proposal arguments when expanded", () => {
		const card = renderProposeCall({ operation: "retire", id: "local.old", reason: "Superseded." }, theme, expanded);
		assert.match(screen(card, 400), /"reason": "Superseded\."/);
	});
});

describe("policy_propose result cards", () => {
	it("states the pending proposal, rule, revision, and inertness", () => {
		const card = renderProposeResult(
			text("Pending proposal prop-9: add local.x. It is inert until operator approval.", {
				proposalId: "prop-9",
				proposalRevision: "abcdef123456",
				state: "pending",
				operation: "add",
				ruleId: "local.x",
			}),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		const lines = screen(card).split("\n");
		assert.equal(lines[0], "proposal prop-9 · pending · revision abcdef123456");
		assert.match(lines[1] ?? "", /inert until operator approval/);
		assert.match(lines[1] ?? "", /expand/i);
		assertFits(card);
	});

	it("falls back to the receipt text when details are malformed", () => {
		const card = renderProposeResult(text("Pending proposal prop-9: add local.x.", {}), { expanded: false, isPartial: false }, theme, collapsed);
		assert.match(screen(card), /Pending proposal prop-9: add local\.x\./);
	});

	it("styles errors and partial results", () => {
		const error = renderProposeResult(text("Draft does not satisfy the policy_propose schema"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.equal(screen(error), "policy_propose: Draft does not satisfy the policy_propose schema");
		const partial = renderProposeResult(text(""), { expanded: false, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Submitting proposal...");
	});

	it("shows the receipt text when expanded", () => {
		const card = renderProposeResult(
			text("Pending proposal prop-9: add local.x. It is inert until operator approval.", {
				proposalId: "prop-9",
				proposalRevision: "abcdef123456",
				state: "pending",
				operation: "add",
				ruleId: "local.x",
			}),
			{ expanded: true, isPartial: false },
			theme,
			expanded,
		);
		const rendered = screen(card, 400);
		assert.match(rendered, /inert until operator approval/);
		assert.match(rendered, /Pending proposal prop-9/);
	});
});
