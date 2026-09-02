import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildRuleRows,
	computePolicyPanes,
	fireBreakdownLines,
	formatPolicyList,
	formatPolicyShow,
	MAX_ACTIVITY_RECORDS,
	MAX_FIRE_SCAN_BYTES,
	PolicyPanel,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
	type BuiltinRuleInfo,
	type LocalPanelActionHost,
	type PolicyActivityRecord,
	type PolicyPanelData,
	type PolicyView,
} from "./panel.ts";
import type { LocalRule, LocalRuleSnapshot, PendingProposal, RuleAudit, RuleMatchContext } from "./local-rules.ts";
import { RULES } from "./shell-rules.ts";

const theme: never = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as never;

const builtins: BuiltinRuleInfo[] = RULES.map(({ id, note }) => ({ id, note }));
const scopeContext: RuleMatchContext = {
	provider: "openai-codex",
	model: "openai-codex/gpt-5.6-sol",
	cwd: "/work/project",
};

function activity(overrides: Partial<PolicyActivityRecord> = {}): PolicyActivityRecord {
	return {
		at: "2026-09-03T12:00:00.000Z",
		model: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		tool: "bash",
		classes: ["routing.cat-read", "bounds.false-cap"],
		blocked: true,
		error: true,
		captured: "cat [REDACTED]",
		policyMode: "enforce",
		session: "session-observed",
		...overrides,
	};
}

function data(overrides: Partial<PolicyPanelData> = {}): PolicyPanelData {
	return {
		builtins,
		fireSummary: {
			fires: new Map([
				["routing.cat-read", 3],
				["form.grep-file", 2],
				["bounds.false-cap", 5],
			]),
			firesByModel: new Map([
				[
					"routing.cat-read",
					new Map([
						["openai-codex/gpt-5.6-sol", 2],
						[null, 1],
					]),
				],
			]),
			partial: false,
		},
		local: { rules: [], discarded: [], pending: [] },
		activity: {
			records: [activity()],
			partial: false,
			byteLimited: false,
			recordLimited: false,
			bytesRead: 200,
		},
		...overrides,
	};
}

function rig(
	panelData = data(),
	rows = 24,
	options: { actionHost?: LocalPanelActionHost; initialView?: PolicyView; scopeContext?: RuleMatchContext } = {},
) {
	const calls = { renders: 0, done: undefined as unknown };
	const panel = new PolicyPanel({
		data: panelData,
		scopeContext: options.scopeContext ?? scopeContext,
		theme,
		tui: { requestRender: () => calls.renders++ },
		getMaxRows: () => rows,
		done: (result) => {
			calls.done = result;
		},
		actionHost: options.actionHost,
		initialView: options.initialView,
	});
	return { panel, calls };
}

const audit = (surface: RuleAudit["surface"] = "agent-tool"): RuleAudit => ({
	at: "2026-09-03T12:00:00.000Z",
	session: "session-local",
	model: "provider/model",
	surface,
});

function localRule(overrides: Partial<LocalRule> = {}): LocalRule {
	return {
		slug: "shell.scan",
		note: "Bound scan output.",
		match: { command: "scan" },
		state: "active",
		effect: "block",
		proposalId: "00000000-0000-4000-8000-000000000001",
		proposedAudit: audit(),
		approvedAudit: audit("command"),
		...overrides,
	};
}

function pendingProposal(): PendingProposal {
	return {
		kind: "proposal",
		id: "00000000-0000-4000-8000-000000000001",
		operation: "upsert",
		slug: "shell.scan",
		reason: "Bound scans.",
		candidate: {
			slug: "shell.scan",
			note: "Bound scan output.",
			match: { command: "scan" },
		},
		audit: audit(),
	};
}

function recordLine(record: PolicyActivityRecord): string {
	return `${JSON.stringify(record)}\n`;
}

describe("built-in policy formatting", () => {
	it("shows exactly three collapsed built-in groups and expands members in place", () => {
		const collapsed = buildRuleRows(builtins, data().fireSummary.fires, new Set());
		assert.deepEqual(
			collapsed.map((row) => row.kind === "group" && row.group),
			["routing", "form", "bounds"],
		);
		const expanded = buildRuleRows(builtins, data().fireSummary.fires, new Set(["routing"]));
		assert.ok(expanded.some((row) => row.kind === "builtin" && row.rule.id === "routing.cat-read"));
	});

	it("prints built-in groups, full detail, and per-model fire evidence", () => {
		const listed = formatPolicyList(data());
		assert.match(listed, /^BUILT-IN GROUPS/m);
		const shown = formatPolicyShow(data(), "routing.cat-read", scopeContext) ?? "";
		assert.match(shown, /id: routing\.cat-read/);
		assert.match(shown, /openai-codex\/gpt-5\.6-sol: 2/);
		assert.match(shown, /\(no model\): 1/);
		assert.equal(formatPolicyShow(data(), "agent.retired", scopeContext), undefined);
	});

	it("surfaces the fire-scan bound and keeps terminal output safe", () => {
		const partial = data({ fireSummary: { ...data().fireSummary, partial: true } });
		assert.match(formatPolicyList(partial), new RegExp(String(MAX_FIRE_SCAN_BYTES)));
		assert.equal(terminalSafe("bad\u001bvalue"), "bad\\x1bvalue");
		assert.deepEqual(fireBreakdownLines(data().fireSummary, "unknown"), ["  (none)"]);
		assert.deepEqual(computePolicyPanes(116), { listWidth: 74, detailWidth: 39 });
	});
});

describe("PolicyPanel", () => {
	it("renders the built-in controls and ignores unrelated keys", () => {
		const { panel, calls } = rig();
		const lines = panel.render(116);
		assert.ok(lines.every((line) => visibleWidth(line) <= 116));
		assert.match(lines.join("\n"), /g group/);
		assert.doesNotMatch(lines.join("\n"), /approve|reject|state|effect/);
		panel.handleInput("d");
		assert.equal(calls.done, undefined);
		panel.handleInput("\x1b");
		assert.deepEqual(calls.done, {
			view: "rules",
			filter: "",
			expandedGroups: [],
			selectedRuleKey: "group:routing",
			selectedActivityKey: "2026-09-03T12:00:00.000Z\0session-observed\0bash\0routing.cat-read,bounds.false-cap\0cat [REDACTED]",
		});
	});

	it("cycles Rules, Local, and Activity and expands the selected group", () => {
		const { panel } = rig();
		panel.handleInput("g");
		assert.match(panel.render(116).join("\n"), /routing\.cat-read/);
		panel.handleInput("v");
		assert.match(panel.render(116).join("\n"), /No local rules/);
		panel.handleInput("v");
		assert.match(panel.render(116).join("\n"), /cat \[REDACTED\]/);
	});

	it("renders pending proposals and retained rules with full local detail", () => {
		const snapshot: LocalRuleSnapshot = {
			rules: [localRule({ scope: { modelProviders: ["other-provider"] } })],
			discarded: [],
			pending: [pendingProposal()],
		};
		const { panel } = rig(data({ local: snapshot }), 24, { initialView: "local" });
		let rendered = panel.render(116).join("\n");
		assert.match(rendered, /pending · upsert · shell\.scan/);
		assert.match(rendered, /candidate\.match/);
		panel.handleInput("\x1b[B");
		rendered = panel.render(200).join("\n");
		assert.match(rendered, /shell\.scan · active · block/);
		assert.match(rendered, /scope matches this session: no \(modelProviders\)/);
		assert.match(rendered, /approved audit/);
	});

	it("runs local actions through the host and refreshes data", async () => {
		const proposal = pendingProposal();
		const calls: string[] = [];
		const refreshed: LocalRuleSnapshot = { rules: [localRule()], discarded: [], pending: [] };
		const host: LocalPanelActionHost = {
			select: async (_title, options) => {
				calls.push(`select:${options.join(",")}`);
				return "block";
			},
			confirm: async () => {
				calls.push("confirm");
				return true;
			},
			approve: async (id, effect) => {
				calls.push(`approve:${id}:${effect}`);
				return { snapshot: refreshed, outcome: "Approved and refreshed." };
			},
			reject: async () => assert.fail("reject was not selected"),
			setState: async () => assert.fail("state was not selected"),
			setEffect: async () => assert.fail("effect was not selected"),
		};
		const { panel } = rig(data({ local: { rules: [], discarded: [], pending: [proposal] } }), 24, {
			actionHost: host,
			initialView: "local",
		});
		panel.handleInput("a");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rendered = panel.render(116).join("\n");
		assert.deepEqual(calls, [
			"select:steer,block",
			"confirm",
			`approve:${proposal.id}:block`,
		]);
		assert.match(rendered, /shell\.scan · active · block/);
		assert.match(rendered, /Approved and refreshed/);
	});

	it("routes retained state and effect choices through the host", async () => {
		const calls: string[] = [];
		let current: LocalRuleSnapshot = { rules: [localRule()], discarded: [], pending: [] };
		const host: LocalPanelActionHost = {
			select: async (_title, options) => (options.includes("disabled") ? "disabled" : "steer"),
			confirm: async () => true,
			approve: async () => assert.fail("approve was not selected"),
			reject: async () => assert.fail("reject was not selected"),
			setState: async (slug, state) => {
				calls.push(`state:${slug}:${state}`);
				current = { ...current, rules: [{ ...current.rules[0], state }] };
				return { snapshot: current, outcome: "State refreshed." };
			},
			setEffect: async (slug, effect) => {
				calls.push(`effect:${slug}:${effect}`);
				current = { ...current, rules: [{ ...current.rules[0], effect }] };
				return { snapshot: current, outcome: "Effect refreshed." };
			},
		};
		const { panel } = rig(data({ local: current }), 24, { actionHost: host, initialView: "local" });
		panel.handleInput("s");
		await new Promise((resolve) => setTimeout(resolve, 0));
		panel.handleInput("e");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(calls, ["state:shell.scan:disabled", "effect:shell.scan:steer"]);
		assert.match(panel.render(116).join("\n"), /shell\.scan · disabled · steer/);
	});

	it("shows a registry error in the Local view", () => {
		const { panel } = rig(data({ registryError: "invalid line" }), 24, { initialView: "local" });
		assert.match(panel.render(116).join("\n"), /Registry unreadable: invalid line/);
	});
});

describe("bounded telemetry loading", () => {
	it("counts built-in fires and models through the daily store", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-fires-"));
		await writeFile(
			join(dir, "2026-09-03.jsonl"),
			[
				recordLine(activity({ model: "model/a", classes: ["routing.cat-read"] })),
				recordLine(activity({ model: null, classes: ["routing.cat-read", "form.grep-file"] })),
			].join(""),
		);
		const summary = await readFireSummary(dir);
		assert.equal(summary.partial, false);
		assert.equal(summary.fires.get("routing.cat-read"), 2);
		assert.equal(summary.firesByModel.get("routing.cat-read")?.get("model/a"), 1);
		assert.equal(summary.firesByModel.get("routing.cat-read")?.get(null), 1);
		assert.equal((await readFireSummary(dir, 1)).partial, true);
	});

	it("reads newest daily tails and enforces byte and record bounds", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-activity-"));
		await writeFile(
			join(dir, "2026-09-02.jsonl"),
			recordLine(activity({ at: "2026-09-02T10:00:00.000Z", session: "old" })),
		);
		await writeFile(
			join(dir, "2026-09-03.jsonl"),
			[
				recordLine(activity({ at: "2026-09-03T11:00:00.000Z", session: "middle" })),
				recordLine(activity({ at: "2026-09-03T12:00:00.000Z", session: "new" })),
			].join(""),
		);
		const loaded = await readRecentActivity(dir);
		assert.deepEqual(loaded.records.map((record) => record.session), ["new", "middle", "old"]);
		const recordLimited = await readRecentActivity(dir, 1_000_000, 1);
		assert.equal(recordLimited.recordLimited, true);
		assert.equal(recordLimited.records.length, 1);
		const byteLimited = await readRecentActivity(dir, 1, MAX_ACTIVITY_RECORDS);
		assert.equal(byteLimited.byteLimited, true);
	});
});
