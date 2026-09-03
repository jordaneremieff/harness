import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	computePolicyPanes,
	fireBreakdownLines,
	filteredRecords,
	formatPolicyList,
	formatPolicyShow,
	MAX_ACTIVITY_RECORDS,
	PolicyPanel,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
	type PolicyActivityRecord,
	type PolicyPanelActionHost,
	type PolicyPanelData,
	type PolicyView,
} from "./panel.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { RuleMatchContext, RuleRecord } from "./rule.ts";

const theme: never = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as never;

const operatorAudit = {
	at: "2026-09-03T12:00:00.000Z",
	session: "session-local",
	model: "provider/model",
	surface: "command" as const,
};
const agentAudit = { ...operatorAudit, surface: "agent-tool" as const };
const scopeContext: RuleMatchContext = {
	provider: "openai-codex",
	model: "openai-codex/gpt-5.6-sol",
	cwd: "/work/project",
};

function packageRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
	return {
		id: "routing.cat-read",
		source: { kind: "package" },
		domain: "tool-call",
		matcher: { kind: "code", key: "routing.cat-read" },
		definition: {
			revision: "111111111111",
			state: "active",
			effect: "block",
			note: "Prefer the read tool for one file.",
		},
		matcherAvailable: true,
		staleOverride: false,
		...overrides,
	};
}

function localRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
	return {
		id: "local.scan",
		source: {
			kind: "local",
			proposalId: "00000000-0000-4000-8000-000000000001",
			approvedAudit: operatorAudit,
		},
		domain: "tool-call",
		matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "scan" } },
		definition: {
			revision: "222222222222",
			state: "active",
			effect: "steer",
			note: "Bound scan output.",
			scope: { modelProviders: ["openai-codex"], cwdPrefixes: ["/work"] },
		},
		override: {
			state: "disabled",
			effect: "block",
			reason: "Temporarily noisy",
			audit: operatorAudit,
			againstDefinitionRevision: "000000000000",
		},
		matcherAvailable: true,
		staleOverride: true,
		...overrides,
	};
}

function snapshot(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
	const records = new Map<string, RuleRecord>([
		["routing.cat-read", packageRule()],
		["local.scan", localRule()],
	]);
	return {
		records,
		pending: [
			{
				kind: "proposal",
				id: "00000000-0000-4000-8000-000000000009",
				operation: "disable",
				ruleId: "routing.cat-read",
				reason: "Pause noisy guidance",
				audit: agentAudit,
			},
		],
		health: { status: "ok", path: "/agent/policy/rules.jsonl" },
		...overrides,
	};
}

function activity(overrides: Partial<PolicyActivityRecord> = {}): PolicyActivityRecord {
	return {
		at: "2026-09-03T12:00:00.000Z",
		model: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		tool: "bash",
		classes: ["routing.cat-read", "bounds.false-cap"],
		blocked: true,
		error: true,
		captured: "cat [redacted]",
		policyMode: "enforce",
		session: "session-observed",
		ruleStoreDegraded: true,
		...overrides,
	};
}

function data(overrides: Partial<PolicyPanelData> = {}): PolicyPanelData {
	return {
		snapshot: snapshot(),
		fireSummary: {
			fires: new Map([
				["routing.cat-read", 3],
				["local.scan", 2],
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
	options: { actionHost?: PolicyPanelActionHost; initialView?: PolicyView; scopeContext?: RuleMatchContext } = {},
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

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const recordLine = (record: PolicyActivityRecord) => `${JSON.stringify(record)}\n`;

describe("unified text surfaces", () => {
	it("shows provenance, matcher, effective fields, override audit, stale/availability, proposals, and health", () => {
		const text = formatPolicyList(data());
		assert.match(text, /routing\.cat-read.*source: package.*matcher: code/);
		assert.match(text, /local\.scan.*state: disabled.*effect: block/);
		assert.match(text, /override reason: Temporarily noisy/);
		assert.match(text, /override audit: command/);
		assert.match(text, /stale override: yes.*available: yes/);
		assert.match(text, /PENDING PROPOSALS/);
		assert.match(text, /registry health: degraded=false \| ok/);
	});

	it("show includes full audit, scope visibility, and catalog-collision status", () => {
		const collisionData = data({
			snapshot: snapshot({
				health: {
					status: "ok",
					path: "/agent/policy/rules.jsonl",
					catalogCollisions: ["local.scan"],
				},
			}),
		});
		const text = formatPolicyShow(collisionData, "local.scan", scopeContext) ?? "";
		assert.match(text, /registry health: degraded=false \| catalog collision:.*"local\.scan"/);
		assert.match(text, /definition revision: 222222222222/);
		assert.match(text, /scope matches this session: yes/);
		assert.match(text, /catalog collision: yes \(local record retained; installed package row skipped\)/);
		assert.match(text, /override reason: Temporarily noisy/);
		assert.match(text, /override audit:[\s\S]*session: session-local/);
		assert.match(text, /stale override: yes/);
	});

	it("show accepts a proposal id and reports degraded health in list", () => {
		assert.match(
			formatPolicyShow(data(), "00000000-0000-4000-8000-000000000009", scopeContext) ?? "",
			/operation: disable/,
		);
		const degraded = data({
			snapshot: snapshot({
				health: { status: "degraded", path: "/tmp/rules.jsonl", line: 2, message: "repair line 2", repair: "repair" },
			}),
		});
		assert.match(formatPolicyList(degraded), /degraded=true \| repair line 2/);
	});

	it("filters across source, matcher, effect, state, note, and override reason", () => {
		assert.deepEqual(
			filteredRecords(snapshot(), "package").map((record) => record.id),
			["routing.cat-read"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "declarative").map((record) => record.id),
			["local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "block").map((record) => record.id),
			["routing.cat-read", "local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "disabled").map((record) => record.id),
			["local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "bound scan output").map((record) => record.id),
			["local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "temporarily noisy").map((record) => record.id),
			["local.scan"],
		);
	});

	it("sorts fire model details and escapes terminal controls", () => {
		assert.deepEqual(fireBreakdownLines(data().fireSummary, "routing.cat-read"), [
			"  openai-codex/gpt-5.6-sol: 2",
			"  (no model): 1",
		]);
		assert.equal(terminalSafe("ok\u001b[31m\u0000"), "ok\\x1b[31m\\x00");
	});
});

describe("bounded telemetry readers", () => {
	it("counts every unified id by model and marks a byte-bounded prefix partial", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		await writeFile(
			join(dir, "2026-09-03.jsonl"),
			[
				recordLine(activity({ classes: ["routing.cat-read"], model: "p/a" })),
				recordLine(activity({ classes: ["routing.cat-read", "local.scan"], model: null })),
			].join(""),
		);
		const full = await readFireSummary(dir);
		assert.equal(full.fires.get("routing.cat-read"), 2);
		assert.equal(full.fires.get("local.scan"), 1);
		assert.equal(full.firesByModel.get("routing.cat-read")?.get(null), 1);
		assert.equal(full.partial, false);
		assert.equal((await readFireSummary(dir, 10)).partial, true);
	});

	it("reads newest matched activity, defaults old degraded telemetry false, and enforces the record bound", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		const old = { ...activity({ at: "2026-09-01T00:00:00.000Z" }) } as Record<string, unknown>;
		delete old.ruleStoreDegraded;
		await writeFile(join(dir, "2026-09-01.jsonl"), `${JSON.stringify(old)}\n`);
		await writeFile(
			join(dir, "2026-09-02.jsonl"),
			Array.from({ length: MAX_ACTIVITY_RECORDS + 2 }, (_, index) =>
				recordLine(
					activity({ at: `2026-09-02T00:${String(index % 60).padStart(2, "0")}:00.000Z`, session: `s-${index}` }),
				),
			).join(""),
		);
		const result = await readRecentActivity(dir);
		assert.equal(result.records.length, MAX_ACTIVITY_RECORDS);
		assert.equal(result.recordLimited, true);
		assert.equal(result.partial, true);
		const onlyOld = await readRecentActivity(dir, 10_000_000, MAX_ACTIVITY_RECORDS + 10);
		assert.equal(onlyOld.records.find((entry) => entry.session === "session-observed")?.ruleStoreDegraded, false);
	});

	it("returns empty healthy results for a missing telemetry directory", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "policy-panel-")), "missing");
		assert.deepEqual(await readRecentActivity(dir), {
			records: [],
			partial: false,
			byteLimited: false,
			recordLimited: false,
			bytesRead: 0,
		});
		assert.equal((await readFireSummary(dir)).partial, false);
	});
});

describe("PolicyPanel", () => {
	it("renders within row and visible-width bounds at wide and narrow sizes", () => {
		for (const [width, rows] of [
			[120, 24],
			[70, 8],
			[20, 3],
		] as const) {
			const lines = rig(data(), rows).panel.render(width);
			assert.ok(lines.length <= rows);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
		}
		assert.deepEqual(computePolicyPanes(116), computePolicyPanes(116));
	});

	it("cycles Rules, Proposals, Activity and returns stable selection state", () => {
		const { panel, calls } = rig();
		assert.match(panel.render(120).join("\n"), /Policy · Rules/);
		panel.handleInput("v");
		assert.match(panel.render(120).join("\n"), /Policy · Proposals/);
		panel.handleInput("v");
		const activityText = panel.render(120).join("\n");
		assert.match(activityText, /Policy · Activity/);
		assert.match(activityText, /rule store degraded: yes/);
		panel.handleInput("\u001b");
		assert.equal((calls.done as { view: string }).view, "activity");
	});

	it("supports filtering without exposing unmatched rows", () => {
		const { panel } = rig();
		panel.handleInput("/");
		for (const char of "local.scan") panel.handleInput(char);
		panel.handleInput("\r");
		const text = panel.render(120).join("\n");
		assert.match(text, /local\.scan/);
		assert.doesNotMatch(text, /routing\.cat-read.*package/);
	});

	it("shows exact command equivalents for reason-bearing actions because nested Pi input is unsafe", () => {
		const { panel } = rig();
		panel.handleInput("\u001b[B");
		const rendered = () => panel.render(120).join("\n").replace(/[│]/g, " ").replace(/\s+/g, " ");
		panel.handleInput("d");
		assert.match(rendered(), /Run: \/policy disable local\.scan <reason\.\.\.>/);
		panel.handleInput("e");
		assert.match(rendered(), /Run: \/policy effect local\.scan <steer\|block> <reason\.\.\.>/);
		panel.handleInput("n");
		assert.match(rendered(), /Run: \/policy enable local\.scan <reason\.\.\.>/);
		panel.handleInput("r");
		assert.match(rendered(), /Run: \/policy retire local\.scan <reason\.\.\.>/);
	});

	it("confirms panel approval and rejection before invoking the operator host", async () => {
		const actions: string[] = [];
		const approved: Array<[string, "steer" | "block" | undefined]> = [];
		const rejected: string[] = [];
		const empty = snapshot({ pending: [] });
		const host: PolicyPanelActionHost = {
			async confirm(title, message) {
				actions.push(`confirm:${title}:${message}`);
				return true;
			},
			async select() {
				throw new Error("disable and rejection do not select an effect");
			},
			async approve(proposalId, effect) {
				actions.push("approve");
				approved.push([proposalId, effect]);
				return { snapshot: empty, outcome: "approved through panel" };
			},
			async reject(proposalId) {
				actions.push("reject");
				rejected.push(proposalId);
				return { snapshot: empty, outcome: "rejected through panel" };
			},
		};
		let panel = rig(data(), 24, { actionHost: host, initialView: "proposals" }).panel;
		panel.handleInput("a");
		await settle();
		assert.match(actions[0] ?? "", /^confirm:Approve policy proposal:Approve disable proposal/);
		assert.equal(actions[1], "approve");
		assert.deepEqual(approved, [["00000000-0000-4000-8000-000000000009", undefined]]);
		assert.match(panel.render(120).join("\n"), /approved through panel/);

		actions.length = 0;
		panel = rig(data(), 24, { actionHost: host, initialView: "proposals" }).panel;
		panel.handleInput("x");
		await settle();
		assert.match(actions[0] ?? "", /^confirm:Reject policy proposal:Reject disable proposal/);
		assert.equal(actions[1], "reject");
		assert.deepEqual(rejected, ["00000000-0000-4000-8000-000000000009"]);
	});

	it("does not write when panel confirmation is declined", async () => {
		let confirmations = 0;
		let writes = 0;
		const host: PolicyPanelActionHost = {
			async confirm() {
				confirmations++;
				return false;
			},
			async select() {
				throw new Error("disable and rejection do not select an effect");
			},
			async approve() {
				writes++;
				throw new Error("approval must not run");
			},
			async reject() {
				writes++;
				throw new Error("rejection must not run");
			},
		};
		let panel = rig(data(), 24, { actionHost: host, initialView: "proposals" }).panel;
		panel.handleInput("a");
		await settle();
		panel = rig(data(), 24, { actionHost: host, initialView: "proposals" }).panel;
		panel.handleInput("x");
		await settle();
		assert.equal(confirmations, 2);
		assert.equal(writes, 0);
	});

	it("selects an add effect, confirms it, and writes the approval", async () => {
		const addSnapshot = snapshot({
			pending: [
				{
					kind: "proposal",
					id: "00000000-0000-4000-8000-000000000010",
					operation: "add",
					ruleId: "local.new",
					reason: "Add it",
					candidate: {
						domain: "tool-call",
						matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "scan" } },
						note: "Bound scan output.",
					},
					audit: agentAudit,
				},
			],
		});
		const actions: string[] = [];
		const approved: Array<[string, "steer" | "block" | undefined]> = [];
		const host: PolicyPanelActionHost = {
			async select(title, options) {
				actions.push(`select:${title}:${options.join(",")}`);
				return "block";
			},
			async confirm(_title, message) {
				actions.push(`confirm:${message}`);
				return true;
			},
			async approve(proposalId, effect) {
				actions.push("approve");
				approved.push([proposalId, effect]);
				return { snapshot: snapshot({ pending: [] }), outcome: "add approved through panel" };
			},
			async reject() {
				throw new Error("unused");
			},
		};
		const panel = rig(data({ snapshot: addSnapshot }), 24, { actionHost: host, initialView: "proposals" }).panel;
		panel.handleInput("a");
		await settle();
		assert.deepEqual(actions, [
			"select:Choose effect for local.new:steer,block",
			"confirm:Approve add proposal 00000000-0000-4000-8000-000000000010 for local.new with effect block?",
			"approve",
		]);
		assert.deepEqual(approved, [["00000000-0000-4000-8000-000000000010", "block"]]);
		assert.match(panel.render(120).join("\n"), /add approved through panel/);
	});
});
