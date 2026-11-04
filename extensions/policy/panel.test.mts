import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RuleSnapshot } from "./local-rules.ts";
import {
	computePolicyPanes,
	filteredRecords,
	fireBreakdownLines,
	formatPolicyList,
	formatPolicyShow,
	MAX_ACTIVITY_RECORDS,
	type PolicyActivityRecord,
	PolicyApprovalPanel,
	PolicyPanel,
	type PolicyPanelActionHost,
	type PolicyPanelData,
	type PolicyView,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
} from "./panel.ts";
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
const reviewAllRows = (width: number, rows: number) => {
	const decisions: boolean[] = [];
	const artifact = Array.from({ length: 100 }, (_, index) => `artifact-row-${index}`).join("\n");
	const panel = new PolicyApprovalPanel({
		title: "Import review",
		artifact,
		tui: { requestRender() {} },
		getMaxRows: () => rows,
		done: (approved) => decisions.push(approved),
	});
	const seen = new Set<string>();
	panel.handleInput("a");
	assert.deepEqual(decisions, []);
	for (let page = 0; page < 200; page++) {
		const rendered = panel.render(width);
		assert.ok(rendered.length <= rows);
		assert.ok(rendered.every((line) => visibleWidth(line) <= width));
		for (const line of rendered) if (line.trim().startsWith("artifact-row-")) seen.add(line.trim());
		panel.handleInput("\r");
		assert.deepEqual(decisions, []);
		panel.handleInput("a");
		if (decisions.length) break;
		panel.handleInput(" ");
	}
	assert.equal(seen.size, 100);
	assert.deepEqual(decisions, [true]);
	panel.handleInput("a");
	assert.deepEqual(decisions, [true]);
	return { seen, decisions };
};
const scopeContext: RuleMatchContext = {
	provider: "openai-codex",
	model: "openai-codex/gpt-5.6-sol",
	cwd: "/work/project",
};

function packageRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
	return {
		id: "routing.cat-read",
		source: { kind: "package" },
		matcher: { kind: "code", key: "routing.cat-read" },
		definition: {
			purpose: "Read complete file content.",
			authority: "steer-or-block",
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
		matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "scan" } },
		definition: {
			purpose: "Keep search output bounded.",
			authority: "steer-or-block",
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
		data: new Map(),
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

	it("show includes full audit and scope visibility without origin-based collision status", () => {
		const collisionData = data({
			snapshot: snapshot({
				health: {
					status: "ok",
					path: "/agent/policy/rules.jsonl",
				},
			}),
		});
		const text = formatPolicyShow(collisionData, "local.scan", scopeContext) ?? "";
		assert.match(text, /registry health: degraded=false \| ok/);
		assert.match(text, /definition revision: 222222222222/);
		assert.match(text, /scope matches this session: yes/);
		assert.doesNotMatch(text, /catalog collision/);
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

	it("retains separate original and effective evaluation evidence for one policy", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const evaluations = [
			{
				id: "local.admission",
				phase: "input",
				inputView: "original",
				applicable: true,
				truth: false,
				unavailable: false,
			},
			{
				id: "local.admission",
				phase: "input",
				inputView: "effective",
				applicable: "unknown",
				truth: "unknown",
				unavailable: true,
			},
		];
		await writeFile(join(dir, "2026-01-01.jsonl"), recordLine(activity({ policy: { evaluations } })));
		const result = await readRecentActivity(dir);
		assert.deepEqual(result.records[0].policy?.evaluations, evaluations);
	});

	it("retains bounded reason codes but rejects arbitrary text and oversized reason arrays", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const valid = ["cli.unknown-option", "shell.dynamic-word"];
		const invalid = [
			["private command text"],
			["line\nfeed"],
			["X"],
			["x".repeat(81)],
			Array(17).fill("x"),
			[null],
			[""],
			"x",
		];
		await writeFile(
			join(dir, "2026-01-01.jsonl"),
			recordLine(
				activity({
					policy: {
						evaluations: [valid, ...invalid].map((unavailableReasons) => ({ id: "sample", unavailableReasons })),
					},
				}),
			),
		);
		const result = await readRecentActivity(dir);
		assert.deepEqual(result.records[0].policy?.evaluations, [
			{ id: "sample", unavailableReasons: valid },
			...invalid.map(() => ({ id: "sample" })),
		]);
	});

	it("retains data snapshot identity and omission evidence without data payloads", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const metadata = { name: "rooms", revision: "123456abcdef", status: "ready", snapshotAt: 1 };
		await writeFile(
			join(dir, "2026-01-01.jsonl"),
			recordLine(
				activity({
					policy: {
						dataSnapshots: [{ ...metadata, rows: [{ key: "unretained-table-row", value: "private-value" }] }],
						coverage: { dataSnapshots: { total: 3, omitted: 2 } },
					},
				}),
			),
		);
		const result = await readRecentActivity(dir);
		assert.deepEqual(result.records[0].policy?.dataSnapshots, [metadata]);
		assert.deepEqual(result.records[0].policy?.recordedCoverage, { dataSnapshots: { total: 3, omitted: 2 } });
		assert.equal(JSON.stringify(result).includes("unretained-table-row"), false);
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

describe("complete policy artifact review", () => {
	it("preserves every whitespace character and grapheme across display wraps", () => {
		const artifact = `{"key":"${" ".repeat(90)}","value":"${"界e\u0301👩‍💻 ".repeat(8)}"}`;
		for (const width of [24, 40, 80]) {
			const panel = new PolicyApprovalPanel({
				title: "Review",
				artifact,
				tui: { requestRender() {} },
				getMaxRows: () => 46,
				done() {},
			});
			const rendered = panel.render(width);
			assert.equal(rendered.slice(1, -2).join(""), artifact);
			assert.ok(rendered.every((line) => visibleWidth(line) <= width));
		}
	});
	it("exposes every artifact row before final-page approval at bounded terminal sizes", () => {
		for (const [width, rows] of [
			[80, 24],
			[120, 40],
			[24, 6],
		]) {
			const { seen, decisions } = reviewAllRows(width, rows);
			assert.equal(seen.size, 100);
			assert.deepEqual(decisions, [true]);
		}
	});
	it("blocks approval on tiny screens and resets page position after width changes", () => {
		let rows = 3;
		const decisions: boolean[] = [];
		const panel = new PolicyApprovalPanel({
			title: "Import review",
			artifact: "First row\nLast row",
			tui: { requestRender() {} },
			getMaxRows: () => rows,
			done: (approved) => decisions.push(approved),
		});
		panel.render(80);
		panel.handleInput("a");
		assert.deepEqual(decisions, []);
		rows = 24;
		panel.render(10);
		panel.handleInput("a");
		assert.deepEqual(decisions, []);
		panel.render(80);
		panel.handleInput("\u001b");
		assert.deepEqual(decisions, [false]);
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

	it("reaches the operator confirm synchronously when no effect selection applies", () => {
		const actions: string[] = [];
		const host: PolicyPanelActionHost = {
			async confirm(title) {
				actions.push(`confirm:${title}`);
				return false;
			},
			async select() {
				throw new Error("exact approval and rejection do not select an effect");
			},
			async approve() {
				throw new Error("declined confirmation must not write");
			},
			async reject() {
				throw new Error("declined confirmation must not write");
			},
		};
		let panel = rig(data(), 24, { actionHost: host, initialView: "proposals" }).panel;
		panel.handleInput("a");
		assert.deepEqual(actions, ["confirm:Approve policy proposal"]);
		actions.length = 0;
		panel = rig(data(), 24, { actionHost: host, initialView: "proposals" }).panel;
		panel.handleInput("x");
		assert.deepEqual(actions, ["confirm:Reject policy proposal"]);
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
						purpose: "Keep search output bounded.",
						authority: "steer-or-block",
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
		assert.equal(actions.length, 3);
		assert.equal(actions[0], "select:Choose effect for local.new:steer,block");
		assert.match(
			actions[1],
			/^confirm:Approve add proposal 00000000-0000-4000-8000-000000000010 for local.new with effect block\?/,
		);
		assert.match(actions[1], /"language": "command-shape\/v1"/);
		assert.match(actions[1], /"note": "Bound scan output\."/);
		assert.equal(actions[2], "approve");
		assert.deepEqual(approved, [["00000000-0000-4000-8000-000000000010", "block"]]);
		assert.match(panel.render(120).join("\n"), /add approved through panel/);
	});
});

const pointer = (
	lines: string[],
	x: number,
	y: number,
	type: "click" | "wheel" = "click",
	wheelDelta?: number,
): Parameters<NonNullable<PolicyPanel["handleMouse"]>>[0] => ({
	type,
	button: type === "click" ? "left" : "none",
	x,
	y,
	screenX: x,
	screenY: y,
	width: Math.max(...lines.map((line) => visibleWidth(line))),
	height: lines.length,
	shift: false,
	alt: false,
	ctrl: false,
	...(wheelDelta === undefined ? {} : { wheelDelta }),
});

/** Click the first drawn occurrence of a label, using the columns the render actually produced. */
function clickLabel(panel: PolicyPanel, width: number, label: string, occurrence = 0): boolean {
	const lines = panel.render(width);
	let seen = 0;
	for (const [y, line] of lines.entries()) {
		let from = 0;
		for (;;) {
			const x = line.indexOf(label, from);
			if (x < 0) break;
			if (seen++ === occurrence) {
				const event = pointer(lines, x + 1, y);
				event.width = width;
				return panel.handleMouse(event)?.handled === true;
			}
			from = x + 1;
		}
	}
	throw new Error(`no label ${label}`);
}

interface ControlCall {
	action: string;
	id: string | undefined;
	snapshot: RuleSnapshot;
}

function controlHost(overrides: Partial<PolicyPanelActionHost> = {}) {
	const calls: ControlCall[] = [];
	const selections: string[][] = [];
	const host: PolicyPanelActionHost = {
		async confirm() {
			return false;
		},
		async select(_title, options) {
			selections.push(options);
			return options[0];
		},
		async approve() {
			throw new Error("unused");
		},
		async reject() {
			throw new Error("unused");
		},
		async control(action, id, shown) {
			calls.push({ action, id, snapshot: shown });
			return { snapshot: shown, outcome: `${action} done for ${id ?? "-"}` };
		},
		...overrides,
	};
	return { host, calls, selections };
}

describe("PolicyPanel navigation and actions", () => {
	it("shows Rules, Proposals, Activity, Data, and State as visible navigation", () => {
		const text = rig().panel.render(120).join("\n");
		for (const label of ["[Rules]", "Proposals", "Activity", "Data", "State", "[Actions]", "[Close]"])
			assert.ok(text.includes(label), label);
	});

	it("switches views by pointer and loads Data and State through the owner control", async () => {
		const { host, calls } = controlHost();
		const { panel } = rig(data(), 24, { actionHost: host });
		assert.equal(clickLabel(panel, 120, "Proposals"), true);
		assert.match(panel.render(120).join("\n"), /Policy · Proposals/);
		assert.equal(clickLabel(panel, 120, "Data"), true);
		await settle();
		assert.deepEqual(calls.map((call) => [call.action, call.id]), [["data", undefined]]);
		assert.match(panel.render(120).join("\n"), /data done for -/);
		assert.equal(clickLabel(panel, 120, "State"), true);
		await settle();
		assert.deepEqual(calls.map((call) => call.action), ["data", "state"]);
		assert.match(panel.render(120).join("\n"), /Policy · State/);
	});

	it("routes a keyboard action and an Actions menu choice to the owner with the displayed target", async () => {
		const { host, calls, selections } = controlHost();
		const shown = data();
		const { panel } = rig(shown, 24, { actionHost: host });
		panel.handleInput("d");
		await settle();
		assert.equal(calls[0].action, "disable");
		assert.equal(calls[0].id, "routing.cat-read");
		assert.equal(calls[0].snapshot, shown.snapshot);
		panel.handleInput("\u001b[B");
		clickLabel(panel, 120, "[Actions]");
		await settle();
		assert.deepEqual(selections[0], ["Disable", "Enable", "Effect", "Retire", "Reset", "Explain"]);
		assert.deepEqual(calls[1], { action: "disable", id: "local.scan", snapshot: shown.snapshot });
	});

	it("never offers an exact-only rule an effect choice and never calls the owner", async () => {
		const exact = packageRule({
			id: "local.exact",
			definition: { ...packageRule().definition, authority: "exact" },
		});
		const shown = data({ snapshot: snapshot({ records: new Map([["local.exact", exact]]) }) });
		const { host, calls } = controlHost();
		const { panel } = rig(shown, 24, { actionHost: host });
		panel.handleInput("e");
		await settle();
		assert.deepEqual(calls, []);
		assert.match(panel.render(120).join("\n"), /exact replacement proposal/);
	});

	it("refuses a changed revision explicitly, refreshes the review, and keeps the old content out", async () => {
		const fresh = snapshot({ records: new Map([["routing.cat-read", packageRule({ definition: { ...packageRule().definition, revision: "999999999999" } })]]), pending: [] });
		let refreshed = 0;
		const { host } = controlHost({
			async control() {
				throw new Error("Rule target revision changed; inspect the current rule");
			},
			async refresh() {
				refreshed++;
				return fresh;
			},
		});
		const { panel } = rig(data(), 24, { actionHost: host });
		panel.handleInput("d");
		await settle();
		const text = panel.render(120).join("\n");
		assert.equal(refreshed, 1);
		assert.match(text, /Action refused: Rule target revision changed/);
		assert.match(text, /Review refreshed/);
		assert.match(text, /definition revision: 999999999999/);
	});

	it("selects a row by click without acting, then opens its detail on the second click", async () => {
		const { host, calls } = controlHost();
		const { panel } = rig(data(), 24, { actionHost: host });
		const before = panel.render(120).join("\n");
		assert.match(before, /› routing\.cat-read/);
		assert.equal(clickLabel(panel, 120, "local.scan"), true);
		assert.match(panel.render(120).join("\n"), /› local\.scan/);
		assert.deepEqual(calls, []);
		assert.equal(clickLabel(panel, 120, "local.scan"), true);
		assert.match(panel.render(120).join("\n"), /id: local\.scan/);
		assert.deepEqual(calls, []);
	});

	it("ignores clicks after invalidation, a size change, or a replaced snapshot", async () => {
		const { host, calls } = controlHost();
		const { panel, calls: panelCalls } = rig(data(), 24, { actionHost: host });
		const lines = panel.render(120);
		const row = lines.findIndex((line) => line.includes("local.scan"));
		const column = lines[row].indexOf("local.scan");
		panel.invalidate();
		assert.equal(panel.handleMouse(pointer(lines, column, row)), undefined);
		panel.render(120);
		const stale = pointer(lines, column, row);
		stale.height = lines.length + 1;
		assert.equal(panel.handleMouse(stale), undefined);
		panel.render(70);
		assert.equal(panel.handleMouse(pointer(lines, column, row)), undefined);
		assert.match(panel.render(120).join("\n"), /› routing\.cat-read/);
		panel.dispose();
		assert.equal(panel.handleMouse(pointer(lines, column, row)), undefined);
		assert.deepEqual(calls, []);
		assert.equal(panelCalls.done, undefined);
	});

	it("scrolls the list under the pointer without invoking an action", () => {
		const { host, calls } = controlHost();
		const { panel } = rig(data(), 24, { actionHost: host });
		const lines = panel.render(120);
		const row = lines.findIndex((line) => line.includes("routing.cat-read"));
		assert.equal(panel.handleMouse(pointer(lines, 4, row, "wheel", 1))?.handled, true);
		assert.match(panel.render(120).join("\n"), /› local\.scan/);
		assert.deepEqual(calls, []);
	});

	it("keeps every action and Close reachable at narrow widths", async () => {
		for (const width of [60, 30]) {
			const { host, calls } = controlHost();
			const { panel, calls: panelCalls } = rig(data(), 12, { actionHost: host });
			const lines = panel.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.join("\n").includes("[Actions]"), `actions at ${width}`);
			clickLabel(panel, width, "[Actions]");
			await settle();
			assert.equal(calls[0].action, "disable");
			clickLabel(panel, width, "[Close]");
			assert.ok(panelCalls.done);
		}
		const { panel, calls: panelCalls } = rig(data(), 12);
		assert.match(panel.render(12).join("\n"), /\[Close\]/);
		clickLabel(panel, 12, "[Close]");
		assert.ok(panelCalls.done);
	});

	it("does not let a late reader result replace the view the operator moved to", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { host } = controlHost({
			async control(action, _id, shown) {
				await gate;
				return { snapshot: shown, outcome: `late ${action}` };
			},
		});
		const { panel } = rig(data(), 24, { actionHost: host });
		clickLabel(panel, 120, "Data");
		clickLabel(panel, 120, "Rules");
		release();
		await settle();
		const text = panel.render(120).join("\n");
		assert.match(text, /Policy · Rules/);
		assert.doesNotMatch(text, /late data/);
		assert.match(text, /routing\.cat-read/);
	});
});

describe("PolicyApprovalPanel reader", () => {
	const make = (actionLabel: string, rows = 10) => {
		const decisions: boolean[] = [];
		const panel = new PolicyApprovalPanel({
			title: "Review",
			artifact: Array.from({ length: 40 }, (_, index) => `row-${index}`).join("\n"),
			actionLabel,
			tui: { requestRender() {} },
			getMaxRows: () => rows,
			done: (approved) => decisions.push(approved),
		});
		return { panel, decisions };
	};
	const toEnd = (panel: PolicyApprovalPanel, width: number) => {
		for (let step = 0; step < 100 && !panel.render(width).join("\n").includes("row-39"); step++) {
			const lines = panel.render(width);
			panel.handleMouse(pointer(lines, 2, 2, "wheel", 3));
		}
	};

	it("keeps the final action unavailable until the last page and ignores a pointer press before then", () => {
		const { panel, decisions } = make("Approve steer");
		let lines = panel.render(60);
		assert.match(lines.at(-1) ?? "", /^\[Previous\] \[Next\] \[Cancel\]\s*$/);
		assert.doesNotMatch(lines.at(-1) ?? "", /Approve/);
		const press = pointer(lines, 2, lines.length - 1);
		assert.equal(panel.handleMouse(press)?.handled, true);
		panel.handleInput("a");
		assert.deepEqual(decisions, []);
		toEnd(panel, 60);
		lines = panel.render(60);
		assert.match(lines.at(-1) ?? "", /\[Cancel\] \[Approve steer\]/);
	});

	it("labels the final action for its effect and commits only from that action", () => {
		const { panel, decisions } = make("Approve as block");
		toEnd(panel, 60);
		const lines = panel.render(60);
		const row = lines.at(-1) ?? "";
		assert.equal(panel.handleMouse(pointer(lines, row.indexOf("[Next]") + 1, lines.length - 1))?.handled, true, "Next on the last page is a no-op page control");
		assert.deepEqual(decisions, []);
		assert.equal(panel.handleMouse(pointer(lines, row.indexOf("[Approve as block]") + 1, lines.length - 1)), undefined, "a page control invalidates the geometry, so the stale press is dropped");
		const again = panel.render(60);
		const final = again.at(-1) ?? "";
		assert.equal(panel.handleMouse(pointer(again, final.indexOf("[Approve as block]") + 1, again.length - 1))?.handled, true);
		assert.deepEqual(decisions, [true]);
	});

	it("never labels a rejection as approval", () => {
		const { panel } = make("Reject");
		toEnd(panel, 60);
		const text = panel.render(60).join("\n");
		assert.match(text, /\[Cancel\] \[Reject\]/);
		assert.doesNotMatch(text, /Approve/);
	});

	it("cancels by pointer or key without confirming and scrolls by wheel and page keys", () => {
		const { panel, decisions } = make("Approve exact");
		const lines = panel.render(60);
		const label = lines.at(-1) ?? "";
		panel.handleMouse(pointer(lines, label.indexOf("[Cancel]") + 1, lines.length - 1));
		assert.deepEqual(decisions, [false]);
		const second = make("Approve exact");
		second.panel.render(60);
		second.panel.handleInput("\u001b[6~");
		assert.match(second.panel.render(60).join("\n"), /row-9|row-8/);
		const start = second.panel.render(60);
		second.panel.handleMouse(pointer(start, 2, 2, "wheel", -3));
		assert.deepEqual(second.decisions, []);
	});

	it("ignores a press whose geometry no longer matches the rendered page", () => {
		const { panel, decisions } = make("Approve exact");
		toEnd(panel, 60);
		const lines = panel.render(60);
		const press = pointer(lines, 3, lines.length - 1);
		panel.invalidate();
		assert.equal(panel.handleMouse(press), undefined);
		panel.render(40);
		assert.equal(panel.handleMouse(press), undefined);
		assert.deepEqual(decisions, []);
	});
});
